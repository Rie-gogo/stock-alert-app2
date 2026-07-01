import { getDb } from "../server/db";
import { rtTrades, rtCandles } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

// B2パターン対象10銘柄
const TARGET_SYMBOLS = [
  "6920", // レーザーテック
  "8035", // 東京エレクトロン
  "6857", // アドバンテスト
  "6976", // 太陽誘電
  "6526", // ソシオネクスト
  "9984", // ソフトバンクG
  "8316", // 三井住友FG
  "7011", // 三菱重工
  "5803", // フジクラ
  "6981", // 村田製作所
];

interface BoardSnapshot {
  bpr?: number;
  buyPressureRatio?: number;
}

async function main() {
  const db = await getDb();
  const today = "2026-07-01";
  
  const trades = await db.select().from(rtTrades).where(eq(rtTrades.tradeDate, today));
  const sorted = [...trades].sort((a, b) => (a.tradeTime || "").localeCompare(b.tradeTime || ""));
  
  // Pair entries and exits
  interface Pair {
    entry: typeof trades[0];
    exit: typeof trades[0];
    pnl: number;
    side: string;
  }
  
  const allPairs: Pair[] = [];
  const openPositions = new Map<string, typeof trades[0]>();
  
  for (const t of sorted) {
    const isEntry = t.pnl === null && (t.action === "buy" || t.action === "short");
    if (isEntry) {
      openPositions.set(t.symbol, t);
    } else if (t.pnl !== null || t.action === "cover") {
      const entry = openPositions.get(t.symbol);
      if (entry) {
        allPairs.push({
          entry,
          exit: t,
          pnl: Number(t.pnl || 0),
          side: entry.action === "short" ? "SHORT" : "LONG"
        });
        openPositions.delete(t.symbol);
      }
    }
  }
  
  // Filter to target 10 symbols only
  const pairs = allPairs.filter(p => TARGET_SYMBOLS.includes(p.entry.symbol));
  const excludedPairs = allPairs.filter(p => !TARGET_SYMBOLS.includes(p.entry.symbol));
  
  console.log("=== 銘柄フィルター適用 ===");
  console.log(`全取引: ${allPairs.length}件`);
  console.log(`対象10銘柄: ${pairs.length}件`);
  console.log(`除外: ${excludedPairs.length}件`);
  if (excludedPairs.length > 0) {
    console.log("除外された取引:");
    for (const p of excludedPairs) {
      console.log(`  ${p.entry.tradeTime} | ${p.entry.symbol} ${p.entry.symbolName} | ${p.side} | ${p.pnl >= 0 ? "+" : ""}${p.pnl.toLocaleString()}円`);
    }
  }
  
  // Print filtered trade pairs
  console.log("\n=== 本日(7/1) 対象10銘柄の全取引ペア ===");
  console.log("時刻        | 方向  | 銘柄              | 価格            | 決済 | 損益        | シグナル");
  console.log("-".repeat(120));
  
  for (const p of pairs) {
    const exitReason = (p.exit.reason || "").includes("利確") ? "TP" :
                       (p.exit.reason || "").includes("損切り") ? "SL" :
                       (p.exit.reason || "").includes("BE") ? "BE" :
                       (p.exit.reason || "").includes("大引け") ? "EOD" : "OTH";
    const entryReason = (p.entry.reason || "").split("｜")[0].substring(0, 50);
    console.log(`${p.entry.tradeTime}-${p.exit.tradeTime} | ${p.side.padEnd(5)} | ${p.entry.symbol} ${(p.entry.symbolName || "").padEnd(14)} | ${Number(p.entry.price).toFixed(0)}→${Number(p.exit.price).toFixed(0)} | ${exitReason.padEnd(3)} | ${(p.pnl >= 0 ? "+" : "") + p.pnl.toLocaleString() + "円"} | ${entryReason}`);
  }
  
  // Summary for filtered trades
  console.log("\n=== サマリー（10銘柄のみ） ===");
  const wins = pairs.filter(p => p.pnl > 0);
  const losses = pairs.filter(p => p.pnl < 0);
  const bes = pairs.filter(p => p.pnl === 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  const grossProfit = wins.reduce((s, p) => s + p.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnl, 0));
  
  console.log(`完了取引: ${pairs.length}件`);
  console.log(`勝ち: ${wins.length}件 (+${grossProfit.toLocaleString()}円)`);
  console.log(`負け: ${losses.length}件 (-${grossLoss.toLocaleString()}円)`);
  console.log(`引分(BE): ${bes.length}件`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`勝率: ${pairs.length > 0 ? (wins.length / pairs.length * 100).toFixed(1) : 0}%`);
  console.log(`PF: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞"}`);
  if (wins.length > 0) console.log(`平均利益: +${Math.round(grossProfit / wins.length).toLocaleString()}円`);
  if (losses.length > 0) console.log(`平均損失: -${Math.round(grossLoss / losses.length).toLocaleString()}円`);
  
  // LONG/SHORT
  console.log("\n=== LONG/SHORT別 ===");
  const longs = pairs.filter(p => p.side === "LONG");
  const shorts = pairs.filter(p => p.side === "SHORT");
  console.log(`LONG:  ${longs.length}件, 勝${longs.filter(p => p.pnl > 0).length}/負${longs.filter(p => p.pnl < 0).length}/引分${longs.filter(p => p.pnl === 0).length}, 損益: ${longs.reduce((s, p) => s + p.pnl, 0) >= 0 ? "+" : ""}${longs.reduce((s, p) => s + p.pnl, 0).toLocaleString()}円`);
  console.log(`SHORT: ${shorts.length}件, 勝${shorts.filter(p => p.pnl > 0).length}/負${shorts.filter(p => p.pnl < 0).length}/引分${shorts.filter(p => p.pnl === 0).length}, 損益: ${shorts.reduce((s, p) => s + p.pnl, 0) >= 0 ? "+" : ""}${shorts.reduce((s, p) => s + p.pnl, 0).toLocaleString()}円`);
  
  // By symbol
  console.log("\n=== 銘柄別 ===");
  const symMap = new Map<string, Pair[]>();
  for (const p of pairs) {
    const key = `${p.entry.symbol} ${p.entry.symbolName}`;
    if (!symMap.has(key)) symMap.set(key, []);
    symMap.get(key)!.push(p);
  }
  for (const [sym, symPairs] of [...symMap.entries()].sort((a, b) => b[1].reduce((s, p) => s + p.pnl, 0) - a[1].reduce((s, p) => s + p.pnl, 0))) {
    const pnl = symPairs.reduce((s, p) => s + p.pnl, 0);
    console.log(`  ${sym.padEnd(22)}: ${symPairs.length}件, 損益: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }
  
  // Session
  console.log("\n=== 前場/後場別 ===");
  const amPairs = pairs.filter(p => parseInt((p.entry.tradeTime || "09:00").split(":")[0]) < 12);
  const pmPairs = pairs.filter(p => parseInt((p.entry.tradeTime || "09:00").split(":")[0]) >= 12);
  console.log(`前場: ${amPairs.length}件, 損益: ${amPairs.reduce((s, p) => s + p.pnl, 0) >= 0 ? "+" : ""}${amPairs.reduce((s, p) => s + p.pnl, 0).toLocaleString()}円`);
  console.log(`後場: ${pmPairs.length}件, 損益: ${pmPairs.reduce((s, p) => s + p.pnl, 0) >= 0 ? "+" : ""}${pmPairs.reduce((s, p) => s + p.pnl, 0).toLocaleString()}円`);
  
  // ===== Pattern C simulation =====
  console.log("\n\n========================================");
  console.log("=== パターンC（後場全SHORT BPR>=0.65ブロック）シミュレーション ===");
  console.log("========================================\n");
  
  // Get BPR for each PM SHORT entry
  const pmShorts = pairs.filter(p => {
    const h = parseInt((p.entry.tradeTime || "09:00").split(":")[0]);
    return p.side === "SHORT" && h >= 13;
  });
  
  console.log("後場SHORTエントリーのBPR確認:");
  console.log("-".repeat(100));
  
  const blockedPairs: Pair[] = [];
  const allowedPmShorts: Pair[] = [];
  
  for (const p of pmShorts) {
    const candles = await db.select().from(rtCandles).where(
      and(
        eq(rtCandles.symbol, p.entry.symbol),
        eq(rtCandles.tradeDate, today)
      )
    );
    
    const entryTime = p.entry.tradeTime || "13:00";
    const relevantCandles = candles
      .filter(c => (c.candleTime || "") <= entryTime)
      .sort((a, b) => (b.candleTime || "").localeCompare(a.candleTime || ""));
    
    const nearestCandle = relevantCandles[0];
    const bs = nearestCandle?.boardSnapshot as BoardSnapshot | null;
    const bpr = bs?.bpr ?? bs?.buyPressureRatio ?? null;
    
    const blocked = bpr !== null && bpr >= 0.65;
    
    const exitReason = (p.exit.reason || "").includes("利確") ? "TP" :
                       (p.exit.reason || "").includes("損切り") ? "SL" :
                       (p.exit.reason || "").includes("BE") ? "BE" :
                       (p.exit.reason || "").includes("大引け") ? "EOD" : "OTH";
    
    console.log(`${p.entry.tradeTime} | ${p.entry.symbol} ${(p.entry.symbolName || "").padEnd(14)} | BPR: ${bpr !== null ? bpr.toFixed(3) : "N/A"} | ${blocked ? "★ブロック" : "  許可"} | ${exitReason} | ${p.pnl >= 0 ? "+" : ""}${p.pnl.toLocaleString()}円`);
    
    if (blocked) {
      blockedPairs.push(p);
    } else {
      allowedPmShorts.push(p);
    }
  }
  
  // Calculate Pattern C results
  const patternCPairs = pairs.filter(p => !blockedPairs.includes(p));
  const patternCTotal = patternCPairs.reduce((s, p) => s + p.pnl, 0);
  const blockedTotal = blockedPairs.reduce((s, p) => s + p.pnl, 0);
  
  const pcWins = patternCPairs.filter(p => p.pnl > 0);
  const pcLosses = patternCPairs.filter(p => p.pnl < 0);
  const pcGrossProfit = pcWins.reduce((s, p) => s + p.pnl, 0);
  const pcGrossLoss = Math.abs(pcLosses.reduce((s, p) => s + p.pnl, 0));
  
  console.log("\n=== 比較結果 ===");
  console.log("\n【現行（10銘柄フィルター後）】");
  console.log(`  取引数: ${pairs.length}件`);
  console.log(`  勝/負/引分: ${wins.length}/${losses.length}/${bes.length}`);
  console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`  PF: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞"}`);
  
  console.log("\n【パターンC適用（後場全SHORT BPR>=0.65ブロック）】");
  console.log(`  取引数: ${patternCPairs.length}件`);
  console.log(`  勝/負/引分: ${pcWins.length}/${pcLosses.length}/${patternCPairs.filter(p => p.pnl === 0).length}`);
  console.log(`  総損益: ${patternCTotal >= 0 ? "+" : ""}${patternCTotal.toLocaleString()}円`);
  console.log(`  PF: ${pcGrossLoss > 0 ? (pcGrossProfit / pcGrossLoss).toFixed(2) : "∞"}`);
  
  console.log("\n【ブロックされた取引】");
  console.log(`  件数: ${blockedPairs.length}件`);
  console.log(`  損益合計: ${blockedTotal >= 0 ? "+" : ""}${blockedTotal.toLocaleString()}円`);
  if (blockedPairs.length > 0) {
    for (const p of blockedPairs) {
      const exitReason = (p.exit.reason || "").includes("利確") ? "TP" :
                         (p.exit.reason || "").includes("損切り") ? "SL" :
                         (p.exit.reason || "").includes("BE") ? "BE" :
                         (p.exit.reason || "").includes("大引け") ? "EOD" : "OTH";
      console.log(`    ${p.entry.tradeTime} | ${p.entry.symbol} ${p.entry.symbolName} | ${exitReason} | ${p.pnl >= 0 ? "+" : ""}${p.pnl.toLocaleString()}円`);
    }
  }
  
  console.log("\n【差分】");
  const diff = patternCTotal - totalPnl;
  console.log(`  パターンC - 現行 = ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円`);
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
