import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) { console.error('DB connection failed'); process.exit(1); }
  const today = "2026-07-28";

  // 1. Daily summary
  const [summaryRows] = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${today}
  `);
  console.log("=== Daily Summary ===");
  console.log(JSON.stringify(summaryRows, null, 2));

  // 2. All trades for today
  const [tradeRows] = await db.execute(sql`
    SELECT * FROM rt_trades WHERE tradeDate = ${today} ORDER BY tradeTime ASC
  `);
  const trades = tradeRows as any[];
  console.log(`\n=== Trades (${trades.length}件) ===`);

  if (trades.length === 0) {
    console.log("本日の取引はありません");
    
    // Check candle count
    const [candleCount] = await db.execute(sql`
      SELECT COUNT(*) as cnt, MIN(candleTime) as first_time, MAX(candleTime) as last_time
      FROM rt_candles WHERE tradeDate = ${today}
    `);
    console.log("\n=== Candle Data ===");
    console.log(JSON.stringify(candleCount, null, 2));
    
    process.exit(0);
    return;
  }

  // Categorize trades
  const entries = trades.filter((t: any) => t.action === "buy" || t.action === "short");
  const exits = trades.filter((t: any) => t.action !== "buy" && t.action !== "short");

  // Calculate PnL per completed trade
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const symbolPnl: Record<string, { pnl: number; wins: number; losses: number; trades: number }> = {};
  const signalPnl: Record<string, { pnl: number; wins: number; losses: number; trades: number }> = {};

  for (const trade of trades) {
    if (trade.pnl !== null && trade.pnl !== undefined) {
      const pnl = Number(trade.pnl);
      if (pnl !== 0 || trade.action === "stop_loss" || trade.action === "take_profit" || trade.action === "forced_close") {
        totalPnl += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;

        // Symbol PnL
        const sym = trade.symbol;
        if (!symbolPnl[sym]) symbolPnl[sym] = { pnl: 0, wins: 0, losses: 0, trades: 0 };
        symbolPnl[sym].pnl += pnl;
        symbolPnl[sym].trades++;
        if (pnl > 0) symbolPnl[sym].wins++;
        else if (pnl < 0) symbolPnl[sym].losses++;
      }
    }
  }

  // Extract signal types from entry reasons
  for (const entry of entries) {
    const reason = entry.reason || "";
    let signalType = "その他";
    if (reason.includes("大台超え")) signalType = "大台超え(LONG)";
    else if (reason.includes("大台割れ")) signalType = "大台割れ(SHORT)";
    else if (reason.includes("VWAP反発")) signalType = "VWAP反発";
    else if (reason.includes("ダウ理論")) signalType = "ダウ理論";
    else if (reason.includes("三尊")) signalType = "三尊";
    else if (reason.includes("ボリンジャー")) signalType = "ボリンジャー";
    else if (reason.includes("RSI")) signalType = "RSI";

    // Find corresponding exit
    const exit = exits.find((e: any) => e.symbol === entry.symbol && e.tradeTime > entry.tradeTime);
    const pnl = exit ? Number(exit.pnl || 0) : 0;

    if (!signalPnl[signalType]) signalPnl[signalType] = { pnl: 0, wins: 0, losses: 0, trades: 0 };
    signalPnl[signalType].pnl += pnl;
    signalPnl[signalType].trades++;
    if (pnl > 0) signalPnl[signalType].wins++;
    else if (pnl < 0) signalPnl[signalType].losses++;
  }

  // Print results
  console.log(`\n取引件数: ${entries.length}件`);
  console.log(`勝敗: ${wins}勝${losses}敗`);
  console.log(`勝率: ${entries.length > 0 ? ((wins / entries.length) * 100).toFixed(1) : 0}%`);
  console.log(`総損益: ${totalPnl.toLocaleString()}円`);

  console.log("\n=== 取引詳細 ===");
  for (const entry of entries) {
    const exit = exits.find((e: any) => e.symbol === entry.symbol && e.tradeTime > entry.tradeTime);
    const pnl = exit ? Number(exit.pnl || 0) : 0;
    const exitAction = exit ? exit.action : "未決済";
    const exitTime = exit ? exit.tradeTime : "-";
    const direction = entry.action === "buy" ? "LONG" : "SHORT";
    console.log(`  ${entry.tradeTime} → ${exitTime} | ${entry.symbol} ${direction} | 入:${Number(entry.price).toLocaleString()}円 → 出:${exit ? Number(exit.price).toLocaleString() : '-'}円 | ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 | ${exitAction} | ${(entry.reason || '').substring(0, 60)}`);
  }

  console.log("\n=== 銘柄別損益 ===");
  for (const [sym, data] of Object.entries(symbolPnl).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.wins}勝${data.losses}敗)`);
  }

  console.log("\n=== シグナル別成績 ===");
  for (const [sig, data] of Object.entries(signalPnl).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sig}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.trades}件, ${data.wins}勝${data.losses}敗, 勝率${data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : 0}%)`);
  }

  // Check for stop loss patterns
  const stopLosses = exits.filter((e: any) => e.action === "stop_loss");
  if (stopLosses.length >= 3) {
    console.log(`\n⚠️ 損切り多発: ${stopLosses.length}件`);
    for (const sl of stopLosses) {
      console.log(`  ${sl.tradeTime} ${sl.symbol} ${Number(sl.pnl).toLocaleString()}円`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
