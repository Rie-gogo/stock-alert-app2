import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // 1. Daily summary
  const [summaryRows] = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-29'
  `);
  const summary = (summaryRows as any[])[0];

  // 2. All trades today
  const [tradeRows] = await db.execute(sql`
    SELECT * FROM rt_trades WHERE tradeDate = '2026-07-29' ORDER BY tradeTime ASC
  `);
  const trades = tradeRows as any[];

  // 3. Candle count
  const [candleRows] = await db.execute(sql`
    SELECT COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols FROM rt_candles WHERE tradeDate = '2026-07-29'
  `);
  const candleInfo = (candleRows as any[])[0];

  console.log("=== 2026-07-29 リアルタイムシミュレーション日次レポート ===\n");

  // Summary
  if (summary) {
    console.log("【デイリーサマリー】");
    console.log(`  初期資本: ${Number(summary.initialCapital).toLocaleString()}円`);
    console.log(`  総損益: ${Number(summary.totalPnl).toLocaleString()}円`);
    console.log(`  取引数: ${summary.tradeCount}件`);
    console.log(`  勝率: ${summary.winRate}%`);
    console.log(`  受信足数: ${summary.candleCount}本`);
    console.log(`  更新時刻: ${summary.updatedAt}`);
  } else {
    console.log("【デイリーサマリー】データなし");
  }

  console.log(`\n【受信データ】 ${candleInfo.cnt}本 / ${candleInfo.symbols}銘柄`);

  // Trade details
  console.log(`\n【取引詳細】 ${trades.length}件`);
  if (trades.length === 0) {
    console.log("  取引なし");
  }

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const bySymbol: Record<string, { pnl: number; wins: number; losses: number }> = {};
  const bySignal: Record<string, { pnl: number; count: number; wins: number }> = {};

  for (const t of trades) {
    const pnl = Number(t.pnl) || 0;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else losses++;

    // By symbol
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, wins: 0, losses: 0 };
    bySymbol[t.symbol].pnl += pnl;
    if (pnl > 0) bySymbol[t.symbol].wins++;
    else bySymbol[t.symbol].losses++;

    // Extract signal type from reason
    const reason = t.reason || "";
    let signalType = "不明";
    if (reason.includes("大台超え")) signalType = "大台超え(LONG)";
    else if (reason.includes("大台割れ")) signalType = "大台割れ(SHORT)";
    else if (reason.includes("ダウ理論")) signalType = "ダウ理論";
    else if (reason.includes("VWAP反発")) signalType = "VWAP反発";
    else if (reason.includes("ダブルトップ")) signalType = "ダブルトップ";
    else if (reason.includes("ダブルボトム")) signalType = "ダブルボトム";
    else if (reason.includes("三尊")) signalType = "三尊";
    else if (reason.includes("逆三尊")) signalType = "逆三尊";
    else if (reason.includes("BB")) signalType = "BB反発";

    if (!bySignal[signalType]) bySignal[signalType] = { pnl: 0, count: 0, wins: 0 };
    bySignal[signalType].pnl += pnl;
    bySignal[signalType].count++;
    if (pnl > 0) bySignal[signalType].wins++;

    // Print trade detail
    const direction = t.action === "buy" ? "LONG" : "SHORT";
    const exitReason = t.exitReason || "不明";
    console.log(`  ${t.tradeTime} | ${t.symbol} ${direction} | ${Number(t.price).toLocaleString()}円 → ${Number(t.exitPrice).toLocaleString()}円 | ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 | ${exitReason}`);
    console.log(`    理由: ${reason}`);
  }

  // Summary stats
  console.log(`\n【集計】`);
  console.log(`  取引数: ${trades.length}件`);
  console.log(`  勝敗: ${wins}勝${losses}敗`);
  console.log(`  勝率: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0}%`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);

  // By symbol
  console.log(`\n【銘柄別損益】`);
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.wins}勝${data.losses}敗)`);
  }

  // By signal
  console.log(`\n【シグナル別成績】`);
  for (const [sig, data] of Object.entries(bySignal).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sig}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${((data.wins / data.count) * 100).toFixed(0)}%)`);
  }

  // Check for issues
  console.log(`\n【特記事項】`);
  const stopLossTrades = trades.filter((t: any) => (t.exitReason || "").includes("損切"));
  if (stopLossTrades.length >= 3) {
    console.log(`  ⚠️ 損切り多発: ${stopLossTrades.length}件`);
  }
  
  // Check consecutive losses
  let maxConsecLoss = 0;
  let currentConsec = 0;
  for (const t of trades) {
    if (Number(t.pnl) < 0) { currentConsec++; maxConsecLoss = Math.max(maxConsecLoss, currentConsec); }
    else currentConsec = 0;
  }
  if (maxConsecLoss >= 3) {
    console.log(`  ⚠️ 最大連敗: ${maxConsecLoss}連敗`);
  }

  // Missing symbols
  const activeSymbols = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6920', '6758', '8316'];
  const [symbolRows] = await db.execute(sql`
    SELECT DISTINCT symbol FROM rt_candles WHERE tradeDate = '2026-07-29'
  `);
  const receivedSymbols = new Set((symbolRows as any[]).map(r => r.symbol));
  const missingActive = activeSymbols.filter(s => !receivedSymbols.has(s));
  if (missingActive.length > 0) {
    console.log(`  ⚠️ データ未受信のアクティブ銘柄: ${missingActive.join(', ')}`);
  }

  process.exit(0);
}
main();
