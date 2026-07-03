import { getDb } from "../server/db";

async function main() {
  const db = await getDb();
  
  // Get all 7/2 trades
  const [trades] = await db.execute(
    `SELECT * FROM rt_trades WHERE tradeDate = '2026-07-02' ORDER BY tradeTime, id`
  ) as any;
  
  console.log("=== 7/2 リアルタイムシミュレーション 日次レポート ===\n");
  
  // Pair entries with exits
  interface TradePair {
    symbol: string; symbolName: string; side: string;
    entryTime: string; entryPrice: number; entryReason: string; entryBoardSignal: string;
    exitTime: string; exitPrice: number; exitReason: string;
    shares: number; pnl: number;
  }
  
  const openPositions: Map<string, any> = new Map();
  const completedTrades: TradePair[] = [];
  
  for (const t of trades) {
    const key = t.symbol + "_" + t.side;
    if (t.action === "short" || t.action === "buy") {
      // Entry
      if (!openPositions.has(key)) {
        openPositions.set(key, {
          symbol: t.symbol, symbolName: t.symbolName, side: t.side,
          entryTime: t.tradeTime, entryPrice: Number(t.price),
          entryReason: t.reason, entryBoardSignal: t.boardSignal,
          shares: t.shares,
        });
      }
    } else if (t.action === "cover" || t.action === "sell") {
      // Exit
      const entry = openPositions.get(key);
      if (entry) {
        completedTrades.push({
          ...entry,
          exitTime: t.tradeTime,
          exitPrice: Number(t.price),
          exitReason: t.reason,
          pnl: Number(t.pnl) || 0,
        });
        openPositions.delete(key);
      }
    }
  }
  
  // Summary
  const totalPnl = completedTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = completedTrades.filter(t => t.pnl > 0);
  const losses = completedTrades.filter(t => t.pnl < 0);
  const bes = completedTrades.filter(t => t.pnl === 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  
  console.log("--- 全体サマリー ---");
  console.log(`取引件数: ${completedTrades.length}件`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`勝ち: ${wins.length}件 / 負け: ${losses.length}件 / BE: ${bes.length}件`);
  console.log(`勝率: ${((wins.length / completedTrades.length) * 100).toFixed(1)}%`);
  console.log(`PF: ${pf.toFixed(2)}`);
  console.log(`利益合計: +${grossProfit.toLocaleString()}円`);
  console.log(`損失合計: -${grossLoss.toLocaleString()}円`);
  console.log("");
  
  // By symbol
  console.log("--- 銘柄別損益 ---");
  const bySymbol: Record<string, { count: number; pnl: number; wins: number; name: string }> = {};
  for (const t of completedTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, pnl: 0, wins: 0, name: t.symbolName };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].pnl += t.pnl;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
  }
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${data.name.padEnd(12)} | ${data.count}件 | 勝${data.wins} | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円`);
  }
  console.log("");
  
  // By exit reason type
  console.log("--- 決済理由別 ---");
  const byExit: Record<string, { count: number; pnl: number }> = {};
  for (const t of completedTrades) {
    let reason = "その他";
    if (t.exitReason.includes("損切り")) reason = "SL(損切り)";
    else if (t.exitReason.includes("利確")) reason = "TP(利確)";
    else if (t.exitReason.includes("BE") || t.exitReason.includes("建値")) reason = "BE(建値)";
    else if (t.exitReason.includes("板読み")) reason = "BOARD_EXIT";
    else if (t.exitReason.includes("反転") || t.exitReason.includes("REVERSAL")) reason = "REVERSAL";
    else if (t.exitReason.includes("大引け") || t.exitReason.includes("EOD")) reason = "EOD";
    if (!byExit[reason]) byExit[reason] = { count: 0, pnl: 0 };
    byExit[reason].count++;
    byExit[reason].pnl += t.pnl;
  }
  for (const [reason, data] of Object.entries(byExit).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(15)} | ${data.count}件 | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円`);
  }
  console.log("");
  
  // By signal type
  console.log("--- シグナル別成績 ---");
  const bySignal: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of completedTrades) {
    let sigType = t.entryReason.split("｜")[0].trim();
    if (sigType.length > 50) sigType = sigType.substring(0, 50);
    if (!bySignal[sigType]) bySignal[sigType] = { count: 0, pnl: 0, wins: 0 };
    bySignal[sigType].count++;
    bySignal[sigType].pnl += t.pnl;
    if (t.pnl > 0) bySignal[sigType].wins++;
  }
  for (const [sig, data] of Object.entries(bySignal).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wr = ((data.wins / data.count) * 100).toFixed(0);
    console.log(`  ${sig.padEnd(55)} | ${data.count}件 | 勝率${wr}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円`);
  }
  console.log("");
  
  // Trade details
  console.log("--- 取引詳細 ---");
  for (const t of completedTrades) {
    const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString() + "円";
    let exitType = "OTHER";
    if (t.exitReason.includes("損切り")) exitType = "SL";
    else if (t.exitReason.includes("利確")) exitType = "TP";
    else if (t.exitReason.includes("BE") || t.exitReason.includes("建値")) exitType = "BE";
    else if (t.exitReason.includes("板読み")) exitType = "BOARD";
    else if (t.exitReason.includes("大引け")) exitType = "EOD";
    console.log(`  ${t.entryTime} -> ${t.exitTime} | ${t.symbolName.padEnd(10)} | ${t.side.padEnd(5)} | @${t.entryPrice} -> ${t.exitPrice} | ${pnlStr.padStart(12)} | ${exitType} | ${t.entryBoardSignal}`);
  }
  
  // Daily summary from DB
  console.log("\n--- DB日次サマリー (rt_daily_summaries) ---");
  const [summary] = await db.execute(
    `SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-02'`
  ) as any;
  if (summary.length > 0) {
    const s = summary[0];
    console.log(`  初期資金: ${Number(s.initialCapital).toLocaleString()}円`);
    console.log(`  総損益: ${Number(s.totalPnl) >= 0 ? "+" : ""}${Number(s.totalPnl).toLocaleString()}円`);
    console.log(`  取引数: ${s.tradesCount}件`);
    console.log(`  勝ち: ${s.winCount}件 / 負け: ${s.lossCount}件`);
    console.log(`  受信ローソク数: ${s.candlesReceived}`);
  }
  
  // Also show 7/3 if available
  console.log("\n--- 参考: 7/3 (本日) の状況 ---");
  const [summary3] = await db.execute(
    `SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-03'`
  ) as any;
  if (summary3.length > 0) {
    const s = summary3[0];
    console.log(`  総損益: ${Number(s.totalPnl) >= 0 ? "+" : ""}${Number(s.totalPnl).toLocaleString()}円`);
    console.log(`  取引数: ${s.tradesCount}件 (勝${s.winCount}/負${s.lossCount})`);
    console.log(`  受信ローソク数: ${s.candlesReceived}`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
