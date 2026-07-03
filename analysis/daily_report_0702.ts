import { getDb } from "../server/db";
import { getStockName } from "../shared/stocks";

async function main() {
  const db = await getDb();
  
  // Check column names
  const [cols] = await db.execute(`SHOW COLUMNS FROM rt_trades`) as any;
  console.log("=== rt_trades columns ===");
  for (const c of cols) {
    console.log(`  ${c.Field} (${c.Type})`);
  }
  
  // Get today's trades
  const [trades] = await db.execute(
    `SELECT * FROM rt_trades WHERE tradeDate = '2026-07-02' ORDER BY tradeTime`
  ) as any;
  
  console.log("\n=== 7/2 リアルタイムシミュレーション結果 ===");
  console.log(`取引件数: ${trades.length}`);
  
  if (trades.length === 0) {
    // Try with tradeDate
    const [trades2] = await db.execute(
      `SELECT * FROM rt_trades WHERE tradeDate = '2026-07-02'`
    ) as any;
    if (trades2.length > 0) {
      console.log("(tradeDate column found, using that)");
    } else {
      // Try to find any recent trades
      const [recent] = await db.execute(
        `SELECT * FROM rt_trades ORDER BY id DESC LIMIT 5`
      ) as any;
      console.log("\n最新5件:");
      for (const r of recent) {
        console.log(JSON.stringify(r));
      }
    }
    process.exit(0);
  }
  
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let bes = 0;
  const bySymbol: Record<string, { count: number; pnl: number; wins: number }> = {};
  const bySignal: Record<string, { count: number; pnl: number; wins: number }> = {};
  const byExitReason: Record<string, { count: number; pnl: number }> = {};
  
  for (const t of trades) {
    const pnl = Number(t.pnl);
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    else bes++;
    
    const sym = t.symbol;
    if (!bySymbol[sym]) bySymbol[sym] = { count: 0, pnl: 0, wins: 0 };
    bySymbol[sym].count++;
    bySymbol[sym].pnl += pnl;
    if (pnl > 0) bySymbol[sym].wins++;
    
    const signal = (t.reason || "").substring(0, 40);
    if (!bySignal[signal]) bySignal[signal] = { count: 0, pnl: 0, wins: 0 };
    bySignal[signal].count++;
    bySignal[signal].pnl += pnl;
    if (pnl > 0) bySignal[signal].wins++;
    
    const exitR = t.action || "unknown";
    if (!byExitReason[exitR]) byExitReason[exitR] = { count: 0, pnl: 0 };
    byExitReason[exitR].count++;
    byExitReason[exitR].pnl += pnl;
  }
  
  console.log("\n--- 全体サマリー ---");
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`勝ち: ${wins}件 / 負け: ${losses}件 / BE: ${bes}件`);
  console.log(`勝率: ${((wins / trades.length) * 100).toFixed(1)}%`);
  const grossProfit = trades.filter((t: any) => Number(t.pnl) > 0).reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const grossLoss = Math.abs(trades.filter((t: any) => Number(t.pnl) < 0).reduce((s: number, t: any) => s + Number(t.pnl), 0));
  console.log(`PF: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "Inf"}`);
  console.log("");
  
  console.log("--- 銘柄別損益 ---");
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${getStockName(sym).padEnd(12)} | ${data.count}件 | 勝${data.wins} | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円`);
  }
  console.log("");
  
  console.log("--- 決済理由別 ---");
  for (const [reason, data] of Object.entries(byExitReason).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(15)} | ${data.count}件 | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円`);
  }
  console.log("");
  
  console.log("--- シグナル別成績 ---");
  for (const [signal, data] of Object.entries(bySignal).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wr = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(0) : "0";
    console.log(`  ${signal.padEnd(42)} | ${data.count}件 | 勝率${wr}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円`);
  }
  console.log("");
  
  console.log("--- 取引詳細 ---");
  for (const t of trades) {
    const pnl = Number(t.pnl);
    const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toLocaleString() + "円";
    const entryTime = t.tradeTime || "";
    const exitTime = "";
    const entryPrice = t.price || "";
    const exitPrice = "";
    const exitReason = t.action || "";
    const signalReason = t.reason || "";
    console.log(
      `  ${entryTime}→${exitTime} | ${getStockName(t.symbol).padEnd(10)} | ${t.side.padEnd(5)} | @${entryPrice}→${exitPrice} | ${pnlStr.padStart(12)} | ${exitReason} | ${signalReason.substring(0, 45)}`
    );
  }
  
  // Get daily summary
  console.log("\n=== rt_daily_summaries ===");
  try {
    const [summaries] = await db.execute(
      `SELECT * FROM rt_daily_summaries WHERE trade_date = '2026-07-02'`
    ) as any;
    if (summaries.length > 0) {
      for (const s of summaries) {
        console.log(JSON.stringify(s, null, 2));
      }
    } else {
      console.log("(レコードなし)");
    }
  } catch (e: any) {
    console.log("Error:", e.message);
    // Try alternate column name
    try {
      const [summaries2] = await db.execute(
        `SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-02'`
      ) as any;
      if (summaries2.length > 0) {
        for (const s of summaries2) {
          console.log(JSON.stringify(s, null, 2));
        }
      }
    } catch {}
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
