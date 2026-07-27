import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

/**
 * C案: 株価帯に応じた動的閾値
 * - 株価10,000円以下: 閾値3.0%
 * - 株価10,000-30,000円: 閾値1.5%
 * - 株価30,000円以上: 閾値0.8%（現行維持）
 */
function getDynamicThreshold(price: number): number {
  if (price <= 10000) return 3.0;
  if (price <= 30000) return 1.5;
  return 0.8;
}

async function main() {
  const db = await getDb();

  // Get all 大台 entries 7/1-7/16
  const r1 = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);

  interface Entry {
    tradeDate: string;
    tradeTime: string;
    symbol: string;
    action: string;
    price: number;
    roundLevel: number;
    distPct: number;
    pnl: number;
    fixedBlock: boolean;   // 固定0.8%でブロック
    dynamicBlock: boolean; // 動的閾値でブロック
    dynamicThreshold: number;
  }

  const entries: Entry[] = [];

  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const sym = row.symbol as string;

    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (!levelMatch) continue;
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);

    // Get exit PnL
    const exitResult = await db.execute(sql`
      SELECT pnl FROM rt_trades 
      WHERE tradeDate = ${row.tradeDate} AND symbol = ${sym}
      AND action NOT IN ('buy', 'short') AND tradeTime > ${row.tradeTime}
      ORDER BY tradeTime ASC LIMIT 1
    `);
    const pnl = (exitResult as any)[0][0] ? Number((exitResult as any)[0][0].pnl) : 0;

    const dynamicThreshold = getDynamicThreshold(entryPrice);

    entries.push({
      tradeDate: row.tradeDate as string,
      tradeTime: row.tradeTime as string,
      symbol: sym,
      action: row.action as string,
      price: entryPrice,
      roundLevel,
      distPct,
      pnl,
      fixedBlock: distPct > 0.8,
      dynamicBlock: distPct > dynamicThreshold,
      dynamicThreshold,
    });
  }

  // ============================================================
  // 比較: 固定0.8% vs 動的閾値
  // ============================================================
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  C案 検証: 株価帯別動的閾値 vs 固定0.8%");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("■ 動的閾値設定:");
  console.log("  株価 ≤ 10,000円: 閾値 3.0%");
  console.log("  株価 10,001-30,000円: 閾値 1.5%");
  console.log("  株価 > 30,000円: 閾値 0.8%\n");

  // Overall comparison
  const fixedPassed = entries.filter(e => !e.fixedBlock);
  const fixedBlocked = entries.filter(e => e.fixedBlock);
  const dynamicPassed = entries.filter(e => !e.dynamicBlock);
  const dynamicBlocked = entries.filter(e => e.dynamicBlock);

  const fixedPassedPnl = fixedPassed.reduce((s, e) => s + e.pnl, 0);
  const fixedBlockedPnl = fixedBlocked.reduce((s, e) => s + e.pnl, 0);
  const dynamicPassedPnl = dynamicPassed.reduce((s, e) => s + e.pnl, 0);
  const dynamicBlockedPnl = dynamicBlocked.reduce((s, e) => s + e.pnl, 0);

  const fixedPassedWins = fixedPassed.filter(e => e.pnl > 0).length;
  const dynamicPassedWins = dynamicPassed.filter(e => e.pnl > 0).length;

  console.log("■ 全体比較（7/1-7/16 大台エントリー61件）\n");
  console.log("  ┌─────────────────┬──────────┬──────────┬──────────┬────────────┬──────────┐");
  console.log("  │ 方式            │ 通過件数 │ 通過勝率 │ 通過損益 │ 通過平均   │ ブロック │");
  console.log("  ├─────────────────┼──────────┼──────────┼──────────┼────────────┼──────────┤");
  const fWR = fixedPassed.length > 0 ? (fixedPassedWins / fixedPassed.length * 100).toFixed(0) : "0";
  const dWR = dynamicPassed.length > 0 ? (dynamicPassedWins / dynamicPassed.length * 100).toFixed(0) : "0";
  const fAvg = fixedPassed.length > 0 ? Math.round(fixedPassedPnl / fixedPassed.length) : 0;
  const dAvg = dynamicPassed.length > 0 ? Math.round(dynamicPassedPnl / dynamicPassed.length) : 0;
  console.log(`  │ 固定0.8%（現行）│ ${String(fixedPassed.length).padStart(6)}件 │ ${(fWR + "%").padStart(6)}   │ ${(fixedPassedPnl >= 0 ? "+" : "") + fixedPassedPnl.toLocaleString()}円 │ ${(fAvg >= 0 ? "+" : "") + fAvg.toLocaleString()}円/件 │ ${String(fixedBlocked.length).padStart(6)}件 │`);
  console.log(`  │ 動的閾値（C案） │ ${String(dynamicPassed.length).padStart(6)}件 │ ${(dWR + "%").padStart(6)}   │ ${(dynamicPassedPnl >= 0 ? "+" : "") + dynamicPassedPnl.toLocaleString()}円 │ ${(dAvg >= 0 ? "+" : "") + dAvg.toLocaleString()}円/件 │ ${String(dynamicBlocked.length).padStart(6)}件 │`);
  console.log(`  │ フィルターなし  │ ${String(entries.length).padStart(6)}件 │ ${((entries.filter(e => e.pnl > 0).length / entries.length * 100).toFixed(0) + "%").padStart(6)}   │ ${(entries.reduce((s, e) => s + e.pnl, 0) >= 0 ? "+" : "") + entries.reduce((s, e) => s + e.pnl, 0).toLocaleString()}円 │ ${(Math.round(entries.reduce((s, e) => s + e.pnl, 0) / entries.length) >= 0 ? "+" : "") + Math.round(entries.reduce((s, e) => s + e.pnl, 0) / entries.length).toLocaleString()}円/件 │ ${String(0).padStart(6)}件 │`);
  console.log("  └─────────────────┴──────────┴──────────┴──────────┴────────────┴──────────┘\n");

  // ============================================================
  // 株価帯別の詳細
  // ============================================================
  console.log("■ 株価帯別 詳細分析\n");

  const priceRanges = [
    { label: "≤10,000円", min: 0, max: 10000, threshold: 3.0 },
    { label: "10,001-30,000円", min: 10001, max: 30000, threshold: 1.5 },
    { label: ">30,000円", min: 30001, max: Infinity, threshold: 0.8 },
  ];

  for (const range of priceRanges) {
    const rangeEntries = entries.filter(e => e.price >= range.min && e.price <= range.max);
    if (rangeEntries.length === 0) continue;

    const fixedPass = rangeEntries.filter(e => !e.fixedBlock);
    const dynPass = rangeEntries.filter(e => !e.dynamicBlock);
    const fixedPassPnl = fixedPass.reduce((s, e) => s + e.pnl, 0);
    const dynPassPnl = dynPass.reduce((s, e) => s + e.pnl, 0);
    const allPnl = rangeEntries.reduce((s, e) => s + e.pnl, 0);

    console.log(`  【${range.label}】閾値: ${range.threshold}% (全${rangeEntries.length}件)`);
    console.log(`    固定0.8%: 通過${fixedPass.length}件 / 勝率${fixedPass.length > 0 ? (fixedPass.filter(e => e.pnl > 0).length / fixedPass.length * 100).toFixed(0) : 0}% / 損益${fixedPassPnl >= 0 ? "+" : ""}${fixedPassPnl.toLocaleString()}円`);
    console.log(`    動的${range.threshold}%: 通過${dynPass.length}件 / 勝率${dynPass.length > 0 ? (dynPass.filter(e => e.pnl > 0).length / dynPass.length * 100).toFixed(0) : 0}% / 損益${dynPassPnl >= 0 ? "+" : ""}${dynPassPnl.toLocaleString()}円`);
    console.log(`    全件通過: ${rangeEntries.length}件 / 勝率${(rangeEntries.filter(e => e.pnl > 0).length / rangeEntries.length * 100).toFixed(0)}% / 損益${allPnl >= 0 ? "+" : ""}${allPnl.toLocaleString()}円`);
    console.log("");
  }

  // ============================================================
  // 銘柄別の詳細
  // ============================================================
  console.log("■ 銘柄別 動的閾値の効果\n");
  console.log(`  ${"銘柄".padEnd(6)} ${"株価帯".padStart(8)} ${"閾値".padStart(5)} ${"全件".padStart(4)} ${"固定通過".padStart(6)} ${"動的通過".padStart(6)} ${"動的勝率".padStart(6)} ${"動的損益".padStart(12)}`);
  console.log("  " + "-".repeat(70));

  const symbolGroups = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!symbolGroups.has(e.symbol)) symbolGroups.set(e.symbol, []);
    symbolGroups.get(e.symbol)!.push(e);
  }

  const priceMap: Record<string, number> = {
    "6526": 2500, "5016": 4000, "5803": 5000, "9984": 6000,
    "6981": 7500, "6976": 15000, "6857": 30000, "6920": 45000,
    "8035": 65000, "285A": 75000
  };

  for (const [sym, symEntries] of [...symbolGroups.entries()].sort((a, b) => (priceMap[a[0]] || 0) - (priceMap[b[0]] || 0))) {
    const price = priceMap[sym] || symEntries[0].price;
    const threshold = getDynamicThreshold(price);
    const fixedPass = symEntries.filter(e => !e.fixedBlock);
    const dynPass = symEntries.filter(e => !e.dynamicBlock);
    const dynPassPnl = dynPass.reduce((s, e) => s + e.pnl, 0);
    const dynWins = dynPass.filter(e => e.pnl > 0).length;
    const dynWR = dynPass.length > 0 ? (dynWins / dynPass.length * 100).toFixed(0) : "-";
    console.log(
      `  ${sym.padEnd(6)} ${(price.toLocaleString() + "円").padStart(8)} ${(threshold + "%").padStart(5)} ${String(symEntries.length).padStart(4)} ${String(fixedPass.length).padStart(6)} ${String(dynPass.length).padStart(6)} ${(dynWR + "%").padStart(6)} ${(dynPassPnl >= 0 ? "+" : "") + dynPassPnl.toLocaleString() + "円"}`
    );
  }

  // ============================================================
  // 動的閾値で新たに通過するエントリーの詳細
  // ============================================================
  console.log("\n\n■ 動的閾値で新たに通過するエントリー（固定0.8%ではブロック）\n");
  const newlyPassed = entries.filter(e => e.fixedBlock && !e.dynamicBlock);
  console.log(`  新規通過: ${newlyPassed.length}件\n`);

  let newWins = 0, newLosses = 0, newPnl = 0;
  for (const e of newlyPassed) {
    const pnlSign = e.pnl >= 0 ? "+" : "";
    console.log(`  ${e.tradeDate} ${e.tradeTime} ${e.symbol} ${e.action} @${e.price.toLocaleString()} キリ番=${e.roundLevel} 乖離=${e.distPct.toFixed(2)}% 閾値=${e.dynamicThreshold}% → ${pnlSign}${e.pnl.toLocaleString()}円`);
    newPnl += e.pnl;
    if (e.pnl > 0) newWins++;
    else newLosses++;
  }
  console.log(`\n  新規通過サマリー: ${newlyPassed.length}件 / 勝${newWins} 負${newLosses} / 勝率${(newWins / newlyPassed.length * 100).toFixed(0)}% / 合計${newPnl >= 0 ? "+" : ""}${newPnl.toLocaleString()}円`);

  // ============================================================
  // 動的閾値でもブロックされるエントリーの詳細
  // ============================================================
  console.log("\n\n■ 動的閾値でもブロックされるエントリー\n");
  console.log(`  ブロック: ${dynamicBlocked.length}件\n`);

  let blockWins = 0, blockLosses = 0, blockPnl = 0;
  for (const e of dynamicBlocked) {
    const pnlSign = e.pnl >= 0 ? "+" : "";
    console.log(`  ${e.tradeDate} ${e.tradeTime} ${e.symbol} ${e.action} @${e.price.toLocaleString()} キリ番=${e.roundLevel} 乖離=${e.distPct.toFixed(2)}% 閾値=${e.dynamicThreshold}% → ${pnlSign}${e.pnl.toLocaleString()}円`);
    blockPnl += e.pnl;
    if (e.pnl > 0) blockWins++;
    else blockLosses++;
  }
  console.log(`\n  ブロックサマリー: ${dynamicBlocked.length}件 / 勝${blockWins} 負${blockLosses} / 勝率${dynamicBlocked.length > 0 ? (blockWins / dynamicBlocked.length * 100).toFixed(0) : 0}% / 合計${blockPnl >= 0 ? "+" : ""}${blockPnl.toLocaleString()}円`);

  // ============================================================
  // 追加検証: 閾値の微調整スイープ
  // ============================================================
  console.log("\n\n■ 動的閾値の微調整スイープ\n");
  
  const sweepConfigs = [
    { label: "A: 2.0/1.2/0.8", low: 2.0, mid: 1.2, high: 0.8 },
    { label: "B: 3.0/1.5/0.8", low: 3.0, mid: 1.5, high: 0.8 },
    { label: "C: 3.0/2.0/1.0", low: 3.0, mid: 2.0, high: 1.0 },
    { label: "D: 4.0/2.0/1.0", low: 4.0, mid: 2.0, high: 1.0 },
    { label: "E: 5.0/2.5/1.2", low: 5.0, mid: 2.5, high: 1.2 },
    { label: "F: なし/1.5/0.8", low: 999, mid: 1.5, high: 0.8 },
  ];

  console.log(`  ${"設定".padEnd(18)} ${"通過".padStart(4)} ${"勝率".padStart(5)} ${"損益".padStart(12)} ${"平均".padStart(10)} ${"ブロック損益".padStart(12)}`);
  console.log("  " + "-".repeat(65));

  for (const cfg of sweepConfigs) {
    const passed = entries.filter(e => {
      const th = e.price <= 10000 ? cfg.low : e.price <= 30000 ? cfg.mid : cfg.high;
      return e.distPct <= th;
    });
    const blocked = entries.filter(e => {
      const th = e.price <= 10000 ? cfg.low : e.price <= 30000 ? cfg.mid : cfg.high;
      return e.distPct > th;
    });
    const pPnl = passed.reduce((s, e) => s + e.pnl, 0);
    const bPnl = blocked.reduce((s, e) => s + e.pnl, 0);
    const pWins = passed.filter(e => e.pnl > 0).length;
    const pWR = passed.length > 0 ? (pWins / passed.length * 100).toFixed(0) : "0";
    const pAvg = passed.length > 0 ? Math.round(pPnl / passed.length) : 0;
    console.log(
      `  ${cfg.label.padEnd(18)} ${String(passed.length).padStart(4)} ${(pWR + "%").padStart(5)} ${(pPnl >= 0 ? "+" : "") + pPnl.toLocaleString() + "円".padStart(12)} ${(pAvg >= 0 ? "+" : "") + pAvg.toLocaleString() + "円".padStart(10)} ${(bPnl >= 0 ? "+" : "") + bPnl.toLocaleString() + "円"}`
    );
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
