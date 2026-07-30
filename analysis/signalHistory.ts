import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  const activeReceived = ['8035', '6857', '5803', '6981', '6920', '6758', '8316'];
  const activeMissing = ['285A', '6526', '6976'];
  
  console.log("=== 過去20営業日のシグナル発生状況 ===\n");

  // Signal count by date for active received symbols
  const sigByDate = await db.execute(sql`
    SELECT tradeDate, symbol, direction_3peak, exit_reason_3peak, virtualPnl
    FROM rt_3peak_signals 
    WHERE tradeDate >= '2026-07-01'
    ORDER BY tradeDate, signalTime
  `);
  const sigRows = (sigByDate as any)[0] || [];
  
  // Group by date
  const byDate: Record<string, any[]> = {};
  for (const s of sigRows) {
    if (!byDate[s.tradeDate]) byDate[s.tradeDate] = [];
    byDate[s.tradeDate].push(s);
  }
  
  // Summary by date
  const dates = Object.keys(byDate).sort();
  console.log("日付       | 全シグナル | アクティブ受信7銘柄 | 未受信3銘柄 | 勝率");
  console.log("-----------|-----------|-------------------|------------|-----");
  
  for (const d of dates) {
    const all = byDate[d];
    const fromReceived = all.filter((s: any) => activeReceived.includes(s.symbol));
    const fromMissing = all.filter((s: any) => activeMissing.includes(s.symbol));
    const wins = all.filter((s: any) => Number(s.virtualPnl) > 0).length;
    const winRate = all.length > 0 ? ((wins / all.length) * 100).toFixed(0) : '-';
    console.log(`${d} | ${String(all.length).padStart(9)} | ${String(fromReceived.length).padStart(17)} | ${String(fromMissing.length).padStart(10)} | ${winRate}%`);
  }
  
  console.log("\n\n=== 銘柄別シグナル発生頻度（7月） ===\n");
  
  // By symbol
  const bySymbol: Record<string, { count: number, wins: number, totalPnl: number, dates: string[] }> = {};
  for (const s of sigRows) {
    if (!bySymbol[s.symbol]) bySymbol[s.symbol] = { count: 0, wins: 0, totalPnl: 0, dates: [] };
    bySymbol[s.symbol].count++;
    if (Number(s.virtualPnl) > 0) bySymbol[s.symbol].wins++;
    bySymbol[s.symbol].totalPnl += Number(s.virtualPnl) || 0;
    if (!bySymbol[s.symbol].dates.includes(s.tradeDate)) bySymbol[s.symbol].dates.push(s.tradeDate);
  }
  
  console.log("銘柄   | シグナル数 | 発生日数 | 勝率  | 累計PnL    | 状態");
  console.log("-------|-----------|---------|-------|-----------|------");
  
  const allSymbols = [...activeReceived, ...activeMissing];
  for (const sym of allSymbols) {
    const data = bySymbol[sym];
    if (data) {
      const winRate = ((data.wins / data.count) * 100).toFixed(0);
      const status = activeReceived.includes(sym) ? '✅受信' : '❌未受信';
      console.log(`${sym.padEnd(6)} | ${String(data.count).padStart(9)} | ${String(data.dates.length).padStart(7)} | ${winRate.padStart(4)}% | ${String(data.totalPnl).padStart(9)} | ${status}`);
    } else {
      const status = activeReceived.includes(sym) ? '✅受信' : '❌未受信';
      console.log(`${sym.padEnd(6)} |         0 |       0 |    -% |         0 | ${status}`);
    }
  }
  
  console.log("\n\n=== 直近5営業日のシグナル詳細（受信済み7銘柄） ===\n");
  
  const recentDates = dates.slice(-5);
  for (const d of recentDates) {
    const daySignals = byDate[d].filter((s: any) => activeReceived.includes(s.symbol));
    if (daySignals.length > 0) {
      console.log(`[${d}] ${daySignals.length}件:`);
      for (const s of daySignals) {
        console.log(`  ${s.symbol} ${s.direction_3peak} | PnL=${s.virtualPnl} | ${s.exit_reason_3peak}`);
      }
    } else {
      console.log(`[${d}] 0件（受信済み7銘柄からシグナルなし）`);
    }
  }
  
  // Check how often there are 0-signal days
  console.log("\n\n=== シグナル0件の日（7月） ===\n");
  
  // Get all trading dates from candles
  const tradingDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE tradeDate >= '2026-07-01'
    ORDER BY tradeDate
  `);
  const allDates = ((tradingDates as any)[0] || []).map((r: any) => r.tradeDate);
  
  const zeroDays = allDates.filter((d: string) => !byDate[d] || byDate[d].length === 0);
  console.log(`全営業日数: ${allDates.length}日`);
  console.log(`シグナル0件の日: ${zeroDays.length}日`);
  if (zeroDays.length > 0) {
    console.log(`日付: ${zeroDays.join(', ')}`);
  }
  
  // Average signals per day
  const totalSignals = sigRows.length;
  const daysWithSignals = dates.length;
  console.log(`\nシグナル発生日数: ${daysWithSignals}日`);
  console.log(`平均シグナル数/日: ${(totalSignals / Math.max(daysWithSignals, 1)).toFixed(1)}件`);
  console.log(`全営業日平均: ${(totalSignals / Math.max(allDates.length, 1)).toFixed(1)}件/日`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
