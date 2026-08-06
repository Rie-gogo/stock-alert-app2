import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * 直近10日間のシミュレーション: 現在の設定 vs 実際の結果
 */

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8,
  "6857": 0.6,
  "6976": 0.5,
  "6526": 0.9,
  "5803": 0.5,
  "6981": 0.9,
  "285A": 0.8,
  "6920": 0.9,
  "6758": 0.5,
  "8316": 0.5,
};

const DEFAULT_SL = 0.5;
const TP_PERCENT = 1.5;

interface SimResult {
  date: string;
  entryTime: string;
  symbol: string;
  name: string;
  side: string;
  entryPrice: number;
  shares: number;
  oldSl: number;
  newSl: number;
  oldPnl: number;
  newPnl: number;
  diff: number;
  newExitReason: string;
  newExitTime: string;
}

async function main() {
  const db = await getDb();
  
  // Get last 10 trade dates
  const datesRes = await db.execute(sql.raw('SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate DESC LIMIT 10'));
  const dates = ((datesRes as any)[0] || []).map((d: any) => d.tradeDate).reverse();
  
  console.log(`直近10取引日: ${dates.join(', ')}`);
  
  let grandOldTotal = 0;
  let grandNewTotal = 0;
  const allResults: SimResult[] = [];
  const dailySummary: { date: string; oldTotal: number; newTotal: number; diff: number; trades: number; oldWins: number; newWins: number }[] = [];
  
  for (const date of dates) {
    // Get all candles for this date
    const candlesRes = await db.execute(sql.raw(
      `SELECT symbol, candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = '${date}' ORDER BY candleTime, symbol`
    ));
    const allCandles = (candlesRes as any)[0] || [];
    
    // Get original trades
    const origTradesRes = await db.execute(sql.raw(
      `SELECT * FROM rt_trades WHERE tradeDate = '${date}' ORDER BY tradeTime`
    ));
    const origTrades = (origTradesRes as any)[0] || [];
    
    let dayOldTotal = 0;
    let dayNewTotal = 0;
    let dayOldWins = 0;
    let dayNewWins = 0;
    let dayTradeCount = 0;
    
    for (let i = 0; i < origTrades.length; i++) {
      const t = origTrades[i];
      if (t.action !== 'buy' && t.action !== 'short') continue;
      
      const symbol = t.symbol;
      const entryPrice = Number(t.price);
      const shares = Number(t.shares);
      const side = t.side as 'long' | 'short';
      const entryTime = t.tradeTime;
      const newSlPct = SYMBOL_SL_MAP[symbol] ?? DEFAULT_SL;
      const oldSlPct = 0.5; // All trades before 8/3 used 0.5%
      
      // Calculate new SL and TP lines
      let slLine: number, tpLine: number;
      if (side === 'long') {
        slLine = entryPrice * (1 - newSlPct / 100);
        tpLine = entryPrice * (1 + TP_PERCENT / 100);
      } else {
        slLine = entryPrice * (1 + newSlPct / 100);
        tpLine = entryPrice * (1 - TP_PERCENT / 100);
      }
      
      // Find candles after entry to determine exit
      const postEntryCandles = allCandles.filter((c: any) => 
        c.symbol === symbol && c.candleTime > entryTime
      );
      
      let exitPrice: number | null = null;
      let exitReason = '';
      let exitTime = '';
      
      for (const c of postEntryCandles) {
        if (side === 'long') {
          if (Number(c.low) <= slLine) {
            exitPrice = slLine;
            exitReason = `損切り(SL:${newSlPct}%)`;
            exitTime = c.candleTime;
            break;
          }
          if (Number(c.high) >= tpLine) {
            exitPrice = tpLine;
            exitReason = `利確(TP:${TP_PERCENT}%)`;
            exitTime = c.candleTime;
            break;
          }
        } else {
          if (Number(c.high) >= slLine) {
            exitPrice = slLine;
            exitReason = `損切り(SL:${newSlPct}%)`;
            exitTime = c.candleTime;
            break;
          }
          if (Number(c.low) <= tpLine) {
            exitPrice = tpLine;
            exitReason = `利確(TP:${TP_PERCENT}%)`;
            exitTime = c.candleTime;
            break;
          }
        }
        if (c.candleTime >= '15:25') {
          exitPrice = Number(c.close);
          exitReason = `大引け決済`;
          exitTime = c.candleTime;
          break;
        }
      }
      
      if (exitPrice === null) {
        const lastCandle = allCandles.filter((c: any) => c.symbol === symbol).pop();
        if (lastCandle) {
          exitPrice = Number(lastCandle.close);
          exitReason = '大引け決済(最終足)';
          exitTime = lastCandle.candleTime;
        } else {
          exitPrice = entryPrice;
          exitReason = 'データなし';
          exitTime = '15:30';
        }
      }
      
      let newPnl: number;
      if (side === 'long') {
        newPnl = Math.round((exitPrice - entryPrice) * shares);
      } else {
        newPnl = Math.round((entryPrice - exitPrice) * shares);
      }
      
      // Find original exit PnL
      const origExit = origTrades.find((ot: any) => 
        ot.symbol === symbol && 
        (ot.action === 'sell' || ot.action === 'cover') &&
        ot.tradeTime >= entryTime &&
        origTrades.indexOf(ot) > i
      );
      const oldPnl = origExit ? Number(origExit.pnl) : 0;
      
      dayOldTotal += oldPnl;
      dayNewTotal += newPnl;
      if (oldPnl > 0) dayOldWins++;
      if (newPnl > 0) dayNewWins++;
      dayTradeCount++;
      
      allResults.push({
        date, entryTime, symbol, name: t.symbolName, side,
        entryPrice, shares, oldSl: oldSlPct, newSl: newSlPct,
        oldPnl, newPnl, diff: newPnl - oldPnl,
        newExitReason: exitReason, newExitTime: exitTime
      });
    }
    
    grandOldTotal += dayOldTotal;
    grandNewTotal += dayNewTotal;
    dailySummary.push({
      date, oldTotal: dayOldTotal, newTotal: dayNewTotal,
      diff: dayNewTotal - dayOldTotal, trades: dayTradeCount,
      oldWins: dayOldWins, newWins: dayNewWins
    });
  }
  
  // Print daily summary
  console.log('\n' + '='.repeat(80));
  console.log('  直近10日間 日別サマリー');
  console.log('='.repeat(80));
  console.log('日付       | 件数 | 旧PnL      | 新PnL      | 差分       | 旧勝率  | 新勝率');
  console.log('-'.repeat(80));
  for (const d of dailySummary) {
    const oldWr = d.trades > 0 ? ((d.oldWins / d.trades) * 100).toFixed(0) + '%' : '-';
    const newWr = d.trades > 0 ? ((d.newWins / d.trades) * 100).toFixed(0) + '%' : '-';
    const diffStr = d.diff >= 0 ? `+${d.diff.toLocaleString()}` : d.diff.toLocaleString();
    console.log(
      `${d.date} | ${String(d.trades).padStart(4)} | ${String(d.oldTotal.toLocaleString()).padStart(10)}円 | ${String(d.newTotal.toLocaleString()).padStart(10)}円 | ${String(diffStr).padStart(10)}円 | ${oldWr.padStart(5)} | ${newWr.padStart(5)}`
    );
  }
  console.log('-'.repeat(80));
  const totalDiff = grandNewTotal - grandOldTotal;
  const totalDiffStr = totalDiff >= 0 ? `+${totalDiff.toLocaleString()}` : totalDiff.toLocaleString();
  const totalTrades = dailySummary.reduce((s, d) => s + d.trades, 0);
  const totalOldWins = dailySummary.reduce((s, d) => s + d.oldWins, 0);
  const totalNewWins = dailySummary.reduce((s, d) => s + d.newWins, 0);
  console.log(
    `合計       | ${String(totalTrades).padStart(4)} | ${String(grandOldTotal.toLocaleString()).padStart(10)}円 | ${String(grandNewTotal.toLocaleString()).padStart(10)}円 | ${String(totalDiffStr).padStart(10)}円 | ${((totalOldWins/totalTrades)*100).toFixed(0)}%`.padStart(5) + `   | ${((totalNewWins/totalTrades)*100).toFixed(0)}%`
  );
  
  // Print by symbol summary
  console.log('\n' + '='.repeat(80));
  console.log('  銘柄別サマリー');
  console.log('='.repeat(80));
  const bySymbol: Record<string, { name: string; count: number; oldPnl: number; newPnl: number; oldSl: number; newSl: number; oldWins: number; newWins: number }> = {};
  for (const r of allResults) {
    if (!bySymbol[r.symbol]) {
      bySymbol[r.symbol] = { name: r.name, count: 0, oldPnl: 0, newPnl: 0, oldSl: r.oldSl, newSl: r.newSl, oldWins: 0, newWins: 0 };
    }
    bySymbol[r.symbol].count++;
    bySymbol[r.symbol].oldPnl += r.oldPnl;
    bySymbol[r.symbol].newPnl += r.newPnl;
    if (r.oldPnl > 0) bySymbol[r.symbol].oldWins++;
    if (r.newPnl > 0) bySymbol[r.symbol].newWins++;
  }
  
  console.log('銘柄    | 名前           | 件数 | 旧SL | 新SL | 旧PnL      | 新PnL      | 差分       | 旧勝率 | 新勝率');
  console.log('-'.repeat(100));
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => (b[1].newPnl - b[1].oldPnl) - (a[1].newPnl - a[1].oldPnl))) {
    const diff = data.newPnl - data.oldPnl;
    const diffStr = diff >= 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
    const oldWr = ((data.oldWins / data.count) * 100).toFixed(0) + '%';
    const newWr = ((data.newWins / data.count) * 100).toFixed(0) + '%';
    console.log(
      `${sym.padEnd(7)} | ${data.name.padEnd(14)} | ${String(data.count).padStart(4)} | ${(data.oldSl + '%').padStart(4)} | ${(data.newSl + '%').padStart(4)} | ${String(data.oldPnl.toLocaleString()).padStart(10)}円 | ${String(data.newPnl.toLocaleString()).padStart(10)}円 | ${String(diffStr).padStart(10)}円 | ${oldWr.padStart(4)} | ${newWr.padStart(4)}`
    );
  }
  
  // Print significant individual trade differences
  console.log('\n' + '='.repeat(80));
  console.log('  差分が大きいトレード TOP10');
  console.log('='.repeat(80));
  const sorted = [...allResults].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10);
  for (const r of sorted) {
    const diffStr = r.diff >= 0 ? `+${r.diff.toLocaleString()}` : r.diff.toLocaleString();
    console.log(`  ${r.date} ${r.entryTime} | ${r.symbol} ${r.name} | ${r.side} @${r.entryPrice.toLocaleString()} x${r.shares} | SL:${r.oldSl}%→${r.newSl}% | 旧:${r.oldPnl.toLocaleString()}円 → 新:${r.newPnl.toLocaleString()}円 (${diffStr}円) | ${r.newExitReason}`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
