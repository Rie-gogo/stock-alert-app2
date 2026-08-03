import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const today = '2026-07-31';
  
  // Daily Summary
  const [summaryRows] = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${today}
  `);
  const summary = (summaryRows as any[])[0] || {};
  
  // All trades (without exitType)
  const [trades] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = ${today}
    ORDER BY tradeTime ASC, id ASC
  `);
  
  const tradeArr = trades as any[];
  const entries = tradeArr.filter((t: any) => t.action === 'buy' || t.action === 'short');
  const exits = tradeArr.filter((t: any) => t.action === 'sell' || t.action === 'cover');
  
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const symbolPnl: Record<string, { pnl: number; count: number; wins: number }> = {};
  const signalPnl: Record<string, { pnl: number; count: number; wins: number }> = {};
  const tradeDetails: any[] = [];
  
  const usedEntryIds = new Set<number>();
  for (const exit of exits) {
    const pnl = Number(exit.pnl) || 0;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else losses++;
    
    if (!symbolPnl[exit.symbol]) symbolPnl[exit.symbol] = { pnl: 0, count: 0, wins: 0 };
    symbolPnl[exit.symbol].pnl += pnl;
    symbolPnl[exit.symbol].count++;
    if (pnl > 0) symbolPnl[exit.symbol].wins++;
    
    const entry = entries.find((e: any) => !usedEntryIds.has(e.id) && e.symbol === exit.symbol && e.tradeTime <= exit.tradeTime);
    let signalName = '不明';
    if (entry) {
      usedEntryIds.add(entry.id);
      const reason = entry.reason || '';
      if (reason.includes('大台確認')) signalName = '大台確認';
      else if (reason.includes('VWAPクロス')) signalName = 'VWAPクロス';
      else if (reason.includes('逆三尊')) signalName = '逆三尊';
      else if (reason.includes('三尊天井')) signalName = '三尊天井';
      else if (reason.includes('ブレイクアウト')) signalName = 'ブレイクアウト';
      else if (reason.includes('buy_pressure')) signalName = 'buy_pressure';
      else if (reason.includes('sell_pressure')) signalName = 'sell_pressure';
      else signalName = reason.substring(0, 20);
      
      tradeDetails.push({
        entryTime: entry.tradeTime,
        exitTime: exit.tradeTime,
        symbol: entry.symbol,
        action: entry.action,
        entryPrice: parseFloat(entry.price),
        exitPrice: parseFloat(exit.price),
        shares: entry.shares,
        pnl,
        signal: signalName,
        reason: entry.reason?.substring(0, 60),
        exitReason: exit.reason?.substring(0, 40)
      });
    }
    
    if (!signalPnl[signalName]) signalPnl[signalName] = { pnl: 0, count: 0, wins: 0 };
    signalPnl[signalName].pnl += pnl;
    signalPnl[signalName].count++;
    if (pnl > 0) signalPnl[signalName].wins++;
  }
  
  // Output
  console.log(JSON.stringify({
    date: today,
    summary: { totalPnl: Number(summary.totalPnl) || totalPnl, candlesReceived: Number(summary.candlesReceived) || 0 },
    trades: { total: exits.length, wins, losses, winRate: exits.length > 0 ? (wins / exits.length * 100).toFixed(1) : '0' },
    totalPnl,
    tradeDetails,
    symbolPnl,
    signalPnl
  }, null, 2));
  
  // Weekly context
  const [weekRows] = await db.execute(sql`
    SELECT tradeDate, totalPnl, trades, wins, losses, candlesReceived
    FROM rt_daily_summaries
    WHERE tradeDate >= '2026-07-24'
    ORDER BY tradeDate ASC
  `);
  console.log("\n=== WEEKLY ===");
  console.log(JSON.stringify(weekRows, null, 2));
  
  process.exit(0);
}
main().catch(console.error);
