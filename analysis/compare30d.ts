import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

/**
 * 30日間比較シミュレーション
 * 
 * 方法:
 * - 「現行」: rt_tradesの実績データをそのまま使用
 * - 「0.8%フィルターなし」: 
 *   - 7/17以降: rt_tradesの実績 + signalHistoryのround_distance_blockを仮エントリーとして追加
 *   - 7/1-7/16: rt_tradesの実績データ（この期間はフィルター導入前なので同じ）
 * 
 * ただし、7/17以降のブロックされたエントリーのPnLは不明（実際にはエントリーしていないため）。
 * そこで、7/1-7/16の実績データを使って「0.8%フィルターがあった場合」と「なかった場合」を比較する。
 * 
 * 正確な比較のため:
 * - 7/1-7/16: 全エントリーが0.8%フィルターなしで実行された実績
 * - 7/1-7/16に0.8%フィルターを適用した場合: ブロック対象を除外した仮想結果
 * - 7/17-7/24: 0.8%フィルターありの実績
 * 
 * → 同一期間で「フィルターあり仮想」vs「フィルターなし実績」を比較
 */

async function main() {
  const db = await getDb();

  // ============================================================
  // 全期間のrt_tradesを取得
  // ============================================================
  const allTrades = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, pnl, reason, shares
    FROM rt_trades 
    WHERE tradeDate >= '2026-06-17' AND tradeDate <= '2026-07-24'
    ORDER BY tradeDate, tradeTime
  `);
  const rows = (allTrades as any)[0];

  // ============================================================
  // 日別集計用の構造体
  // ============================================================
  interface DayResult {
    date: string;
    entries: number;
    exits: number;
    wins: number;
    losses: number;
    totalPnl: number;
  }

  // ============================================================
  // 「フィルターなし」= 実績そのまま（7/1-7/16はフィルター前、7/17以降もそのまま）
  // ============================================================
  const noFilterDaily = new Map<string, DayResult>();
  // 「フィルターあり」= 7/1-7/16の大台エントリーで0.8%超過分を除外
  const withFilterDaily = new Map<string, DayResult>();

  // まず全取引を日別に整理
  interface TradeRow {
    tradeDate: string;
    tradeTime: string;
    symbol: string;
    action: string;
    price: number;
    pnl: number;
    reason: string;
    shares: number;
  }

  const tradesByDate = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const date = row.tradeDate as string;
    if (!tradesByDate.has(date)) tradesByDate.set(date, []);
    tradesByDate.get(date)!.push({
      tradeDate: date,
      tradeTime: row.tradeTime as string,
      symbol: row.symbol as string,
      action: row.action as string,
      price: Number(row.price),
      pnl: Number(row.pnl) || 0,
      reason: row.reason as string,
      shares: Number(row.shares) || 0,
    });
  }

  // ============================================================
  // 7/1-7/16の大台エントリーを特定し、0.8%フィルターで分類
  // ============================================================
  // エントリーとその対応するイグジットをペアにする
  interface TradePair {
    entry: TradeRow;
    exit: TradeRow | null;
    isRoundLevel: boolean;
    distPct: number;
    wouldBeBlocked: boolean;
  }

  const allPairs: TradePair[] = [];

  for (const [date, trades] of tradesByDate) {
    // エントリーを見つけて、対応するイグジットを探す
    const entries = trades.filter(t => t.action === "buy" || t.action === "short");
    const exits = trades.filter(t => t.action !== "buy" && t.action !== "short");

    for (const entry of entries) {
      // 同じ銘柄の次のイグジットを探す
      const matchingExit = exits.find(ex => 
        ex.symbol === entry.symbol && ex.tradeTime > entry.tradeTime
      );

      // 大台エントリーかどうか判定
      const isRoundLevel = entry.reason.includes("大台超え") || 
                           entry.reason.includes("大台割れ") || 
                           entry.reason.includes("大台確認");
      
      let distPct = 0;
      if (isRoundLevel) {
        const levelMatch = entry.reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
        if (levelMatch) {
          const roundLevel = parseFloat(levelMatch[1]);
          distPct = calculateRoundDistancePct(entry.price, roundLevel);
        }
      }

      const wouldBeBlocked = isRoundLevel && distPct > 0.8;

      allPairs.push({
        entry,
        exit: matchingExit || null,
        isRoundLevel,
        distPct,
        wouldBeBlocked,
      });
    }
  }

  // ============================================================
  // 2つのシナリオで日別集計
  // ============================================================
  // シナリオA: フィルターなし（全エントリーを実行 = 実績そのまま）
  // シナリオB: フィルターあり（0.8%超過の大台エントリーを除外）

  for (const [date, trades] of tradesByDate) {
    // フィルターなし: 全イグジットのPnLを合算
    const exits = trades.filter(t => t.action !== "buy" && t.action !== "short");
    const entries = trades.filter(t => t.action === "buy" || t.action === "short");
    
    const noFilter: DayResult = {
      date,
      entries: entries.length,
      exits: exits.length,
      wins: exits.filter(e => Number(e.pnl) > 0).length,
      losses: exits.filter(e => Number(e.pnl) <= 0).length,
      totalPnl: exits.reduce((sum, e) => sum + Number(e.pnl), 0),
    };
    noFilterDaily.set(date, noFilter);

    // フィルターあり: 0.8%超過の大台エントリーに対応するイグジットを除外
    const blockedSymbolTimes = new Set<string>();
    for (const pair of allPairs) {
      if (pair.entry.tradeDate === date && pair.wouldBeBlocked) {
        blockedSymbolTimes.add(`${pair.entry.symbol}_${pair.entry.tradeTime}`);
      }
    }

    // ブロックされたエントリーに対応するイグジットを特定
    const blockedExitKeys = new Set<string>();
    for (const pair of allPairs) {
      if (pair.entry.tradeDate === date && pair.wouldBeBlocked && pair.exit) {
        blockedExitKeys.add(`${pair.exit.symbol}_${pair.exit.tradeTime}`);
      }
    }

    const filteredExits = exits.filter(e => !blockedExitKeys.has(`${e.symbol}_${e.tradeTime}`));
    
    const withFilter: DayResult = {
      date,
      entries: entries.length - blockedSymbolTimes.size,
      exits: filteredExits.length,
      wins: filteredExits.filter(e => Number(e.pnl) > 0).length,
      losses: filteredExits.filter(e => Number(e.pnl) <= 0).length,
      totalPnl: filteredExits.reduce((sum, e) => sum + Number(e.pnl), 0),
    };
    withFilterDaily.set(date, withFilter);
  }

  // ============================================================
  // レポート出力
  // ============================================================
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  30日間シミュレーション比較: 現行（0.8%フィルターあり） vs フィルターなし");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");
  console.log("  ※ 同一のrt_candles/rt_tradesデータに対して、0.8%フィルターの有無のみを変更\n");

  const sortedDates = [...tradesByDate.keys()].sort();

  let cumNoFilter = 0;
  let cumWithFilter = 0;

  console.log(`  ${"日付".padEnd(12)} │ ${"フィルターなし".padEnd(28)} │ ${"フィルターあり（現行）".padEnd(28)} │ ${"差分"}`);
  console.log(`  ${"".padEnd(12)} │ ${"取引".padStart(4)} ${"勝率".padStart(5)} ${"損益".padStart(12)} ${"累計".padStart(12)} │ ${"取引".padStart(4)} ${"勝率".padStart(5)} ${"損益".padStart(12)} ${"累計".padStart(12)} │`);
  console.log("  " + "─".repeat(100));

  let totalNoFilter = { trades: 0, wins: 0, pnl: 0 };
  let totalWithFilter = { trades: 0, wins: 0, pnl: 0 };

  for (const date of sortedDates) {
    const nf = noFilterDaily.get(date)!;
    const wf = withFilterDaily.get(date)!;
    if (nf.exits === 0 && wf.exits === 0) continue;

    cumNoFilter += nf.totalPnl;
    cumWithFilter += wf.totalPnl;
    totalNoFilter.trades += nf.exits;
    totalNoFilter.wins += nf.wins;
    totalNoFilter.pnl += nf.totalPnl;
    totalWithFilter.trades += wf.exits;
    totalWithFilter.wins += wf.wins;
    totalWithFilter.pnl += wf.totalPnl;

    const nfWR = nf.exits > 0 ? (nf.wins / nf.exits * 100).toFixed(0) + "%" : "  -";
    const wfWR = wf.exits > 0 ? (wf.wins / wf.exits * 100).toFixed(0) + "%" : "  -";
    const nfPnl = (nf.totalPnl >= 0 ? "+" : "") + nf.totalPnl.toLocaleString();
    const wfPnl = (wf.totalPnl >= 0 ? "+" : "") + wf.totalPnl.toLocaleString();
    const nfCum = (cumNoFilter >= 0 ? "+" : "") + cumNoFilter.toLocaleString();
    const wfCum = (cumWithFilter >= 0 ? "+" : "") + cumWithFilter.toLocaleString();
    const diff = wf.totalPnl - nf.totalPnl;
    const diffStr = diff === 0 ? "  =" : (diff > 0 ? "+" : "") + diff.toLocaleString();

    // Mark the filter deployment date
    const marker = date === "2026-07-16" ? " ◀導入" : "";

    console.log(
      `  ${date}${marker.padEnd(6)} │ ${String(nf.exits).padStart(4)} ${nfWR.padStart(5)} ${nfPnl.padStart(12)} ${nfCum.padStart(12)} │ ${String(wf.exits).padStart(4)} ${wfWR.padStart(5)} ${wfPnl.padStart(12)} ${wfCum.padStart(12)} │ ${diffStr}`
    );
  }

  console.log("  " + "─".repeat(100));

  // Summary
  const nfOverallWR = totalNoFilter.trades > 0 ? (totalNoFilter.wins / totalNoFilter.trades * 100).toFixed(1) : "0";
  const wfOverallWR = totalWithFilter.trades > 0 ? (totalWithFilter.wins / totalWithFilter.trades * 100).toFixed(1) : "0";

  console.log("\n■ 30日間サマリー比較\n");
  console.log(`  ${"指標".padEnd(20)} ${"フィルターなし".padStart(16)} ${"フィルターあり".padStart(16)} ${"差分".padStart(12)}`);
  console.log("  " + "─".repeat(65));
  console.log(`  ${"総取引数".padEnd(20)} ${(totalNoFilter.trades + "件").padStart(16)} ${(totalWithFilter.trades + "件").padStart(16)} ${((totalWithFilter.trades - totalNoFilter.trades) + "件").padStart(12)}`);
  console.log(`  ${"勝率".padEnd(20)} ${(nfOverallWR + "%").padStart(16)} ${(wfOverallWR + "%").padStart(16)} ${((parseFloat(wfOverallWR) - parseFloat(nfOverallWR)).toFixed(1) + "pt").padStart(12)}`);
  console.log(`  ${"合計損益".padEnd(20)} ${((totalNoFilter.pnl >= 0 ? "+" : "") + totalNoFilter.pnl.toLocaleString() + "円").padStart(16)} ${((totalWithFilter.pnl >= 0 ? "+" : "") + totalWithFilter.pnl.toLocaleString() + "円").padStart(16)} ${(((totalWithFilter.pnl - totalNoFilter.pnl) >= 0 ? "+" : "") + (totalWithFilter.pnl - totalNoFilter.pnl).toLocaleString() + "円").padStart(12)}`);
  const nfAvg = totalNoFilter.trades > 0 ? Math.round(totalNoFilter.pnl / totalNoFilter.trades) : 0;
  const wfAvg = totalWithFilter.trades > 0 ? Math.round(totalWithFilter.pnl / totalWithFilter.trades) : 0;
  console.log(`  ${"1件平均損益".padEnd(20)} ${((nfAvg >= 0 ? "+" : "") + nfAvg.toLocaleString() + "円").padStart(16)} ${((wfAvg >= 0 ? "+" : "") + wfAvg.toLocaleString() + "円").padStart(16)} ${(((wfAvg - nfAvg) >= 0 ? "+" : "") + (wfAvg - nfAvg).toLocaleString() + "円").padStart(12)}`);
  const nfDailyAvg = Math.round(totalNoFilter.pnl / sortedDates.filter(d => (noFilterDaily.get(d)?.exits || 0) > 0).length);
  const wfDailyAvg = Math.round(totalWithFilter.pnl / sortedDates.filter(d => (withFilterDaily.get(d)?.exits || 0) > 0).length);
  console.log(`  ${"1日平均損益".padEnd(20)} ${((nfDailyAvg >= 0 ? "+" : "") + nfDailyAvg.toLocaleString() + "円").padStart(16)} ${((wfDailyAvg >= 0 ? "+" : "") + wfDailyAvg.toLocaleString() + "円").padStart(16)} ${(((wfDailyAvg - nfDailyAvg) >= 0 ? "+" : "") + (wfDailyAvg - nfDailyAvg).toLocaleString() + "円").padStart(12)}`);

  // Period breakdown
  console.log("\n■ 期間別比較\n");
  
  const periods = [
    { label: "6/17-7/16（導入前期間）", start: "2026-06-17", end: "2026-07-16" },
    { label: "7/17-7/24（導入後期間）", start: "2026-07-17", end: "2026-07-24" },
  ];

  for (const period of periods) {
    const periodDates = sortedDates.filter(d => d >= period.start && d <= period.end);
    let pNF = { trades: 0, wins: 0, pnl: 0 };
    let pWF = { trades: 0, wins: 0, pnl: 0 };
    for (const d of periodDates) {
      const nf = noFilterDaily.get(d)!;
      const wf = withFilterDaily.get(d)!;
      pNF.trades += nf.exits; pNF.wins += nf.wins; pNF.pnl += nf.totalPnl;
      pWF.trades += wf.exits; pWF.wins += wf.wins; pWF.pnl += wf.totalPnl;
    }
    const nfWR = pNF.trades > 0 ? (pNF.wins / pNF.trades * 100).toFixed(1) : "0";
    const wfWR = pWF.trades > 0 ? (pWF.wins / pWF.trades * 100).toFixed(1) : "0";
    console.log(`  ${period.label}`);
    console.log(`    フィルターなし: ${pNF.trades}件, 勝率${nfWR}%, ${pNF.pnl >= 0 ? "+" : ""}${pNF.pnl.toLocaleString()}円`);
    console.log(`    フィルターあり: ${pWF.trades}件, 勝率${wfWR}%, ${pWF.pnl >= 0 ? "+" : ""}${pWF.pnl.toLocaleString()}円`);
    console.log(`    差分: ${pWF.pnl - pNF.pnl >= 0 ? "+" : ""}${(pWF.pnl - pNF.pnl).toLocaleString()}円（${pWF.trades - pNF.trades}件減）`);
    console.log("");
  }

  // Blocked trades analysis
  console.log("■ 0.8%フィルターでブロックされた取引の損益\n");
  const blockedPairs = allPairs.filter(p => p.wouldBeBlocked && p.exit);
  const blockedWins = blockedPairs.filter(p => p.exit!.pnl > 0).length;
  const blockedPnl = blockedPairs.reduce((sum, p) => sum + (p.exit?.pnl || 0), 0);
  console.log(`  ブロック対象: ${blockedPairs.length}件`);
  console.log(`  勝率: ${blockedPairs.length > 0 ? (blockedWins / blockedPairs.length * 100).toFixed(0) : 0}%`);
  console.log(`  合計損益: ${blockedPnl >= 0 ? "+" : ""}${blockedPnl.toLocaleString()}円`);
  console.log(`  1件平均: ${blockedPairs.length > 0 ? ((blockedPnl / blockedPairs.length) >= 0 ? "+" : "") + Math.round(blockedPnl / blockedPairs.length).toLocaleString() : 0}円`);
  console.log(`\n  → フィルターにより${blockedPnl < 0 ? "損失" + Math.abs(blockedPnl).toLocaleString() + "円を回避" : "利益" + blockedPnl.toLocaleString() + "円を逃した"}`);

  // PF comparison
  console.log("\n■ プロフィットファクター比較\n");
  const nfGrossProfit = rows.filter((r: any) => r.action !== "buy" && r.action !== "short" && Number(r.pnl) > 0).reduce((s: number, r: any) => s + Number(r.pnl), 0);
  const nfGrossLoss = Math.abs(rows.filter((r: any) => r.action !== "buy" && r.action !== "short" && Number(r.pnl) < 0).reduce((s: number, r: any) => s + Number(r.pnl), 0));
  
  // For "with filter", exclude blocked exits
  const blockedExitSet = new Set(blockedPairs.map(p => p.exit ? `${p.exit.tradeDate}_${p.exit.symbol}_${p.exit.tradeTime}` : ""));
  const wfRows = rows.filter((r: any) => {
    if (r.action === "buy" || r.action === "short") return false;
    return !blockedExitSet.has(`${r.tradeDate}_${r.symbol}_${r.tradeTime}`);
  });
  const wfGrossProfit = wfRows.filter((r: any) => Number(r.pnl) > 0).reduce((s: number, r: any) => s + Number(r.pnl), 0);
  const wfGrossLoss = Math.abs(wfRows.filter((r: any) => Number(r.pnl) < 0).reduce((s: number, r: any) => s + Number(r.pnl), 0));

  console.log(`  フィルターなし: PF = ${nfGrossLoss > 0 ? (nfGrossProfit / nfGrossLoss).toFixed(2) : "∞"} (利益${nfGrossProfit.toLocaleString()} / 損失${nfGrossLoss.toLocaleString()})`);
  console.log(`  フィルターあり: PF = ${wfGrossLoss > 0 ? (wfGrossProfit / wfGrossLoss).toFixed(2) : "∞"} (利益${wfGrossProfit.toLocaleString()} / 損失${wfGrossLoss.toLocaleString()})`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
