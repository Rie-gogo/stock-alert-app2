// Simulate what excluded symbols would have done 7/16-7/23
// Using the same engine logic (大台割れ/超え, ダウ理論) on their candle data
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const excluded = [
  { symbol: '6920', name: 'レーザーテック', sector: '半導体' },
  { symbol: '9984', name: 'ソフトバンクG', sector: '通信・投資' },
  { symbol: '8316', name: '三井住友FG', sector: '銀行' },
  { symbol: '7011', name: '三菱重工業', sector: '機械' },
  { symbol: '9107', name: '川崎汽船', sector: '海運' },
  { symbol: '8306', name: '三菱UFJ FG', sector: '銀行' },
  { symbol: '4568', name: '第一三共', sector: '医薬' },
  { symbol: '5016', name: 'JX金属', sector: '非鉄' },
  { symbol: '6758', name: 'ソニーG', sector: '電機' },
  { symbol: '7203', name: 'トヨタ自動車', sector: '自動車' },
  { symbol: '6723', name: 'ルネサス', sector: '半導体' },
];

// Simple round number detection
function getRoundNumbers(price) {
  const rounds = [];
  if (price >= 10000) {
    // 100円刻み
    const r = Math.round(price / 100) * 100;
    rounds.push(r - 100, r, r + 100);
  } else if (price >= 1000) {
    // 50円刻み
    const r = Math.round(price / 50) * 50;
    rounds.push(r - 50, r, r + 50);
  } else {
    // 10円刻み
    const r = Math.round(price / 10) * 10;
    rounds.push(r - 10, r, r + 10);
  }
  return rounds;
}

// Simple simulation: detect 大台割れ (price crosses below round number) and SHORT
// Detect 大台超え (price crosses above round number) and LONG
const tradeDates = ['2026-07-16', '2026-07-17', '2026-07-21', '2026-07-22', '2026-07-23'];
const results = {};

for (const { symbol, name, sector } of excluded) {
  results[symbol] = { name, sector, trades: [], totalPnl: 0, wins: 0, losses: 0 };
  
  for (const date of tradeDates) {
    const [candles] = await conn.execute(
      'SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = ? AND symbol = ? ORDER BY candleTime',
      [date, symbol]
    );
    if (candles.length < 10) continue;
    
    // Track round number crossings
    let inPosition = false;
    let positionSide = null;
    let entryPrice = 0;
    let entryTime = '';
    let slPrice = 0;
    let tpPrice = 0;
    
    for (let i = 5; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const price = Number(c.close);
      const prevClose = Number(prev.close);
      
      if (inPosition) {
        // Check SL/TP
        const high = Number(c.high);
        const low = Number(c.low);
        
        if (positionSide === 'short') {
          if (high >= slPrice) {
            const pnl = Math.round((entryPrice - slPrice) * (3000000 / entryPrice));
            results[symbol].trades.push({ date, time: entryTime + '→' + c.candleTime, side: 'SHORT', entry: entryPrice, exit: slPrice, pnl, reason: 'SL' });
            results[symbol].totalPnl += pnl;
            if (pnl > 0) results[symbol].wins++; else results[symbol].losses++;
            inPosition = false;
          } else if (low <= tpPrice) {
            const pnl = Math.round((entryPrice - tpPrice) * (3000000 / entryPrice));
            results[symbol].trades.push({ date, time: entryTime + '→' + c.candleTime, side: 'SHORT', entry: entryPrice, exit: tpPrice, pnl, reason: 'TP' });
            results[symbol].totalPnl += pnl;
            if (pnl > 0) results[symbol].wins++; else results[symbol].losses++;
            inPosition = false;
          } else if (c.candleTime >= '15:25') {
            const exitPrice = price;
            const pnl = Math.round((entryPrice - exitPrice) * (3000000 / entryPrice));
            results[symbol].trades.push({ date, time: entryTime + '→' + c.candleTime, side: 'SHORT', entry: entryPrice, exit: exitPrice, pnl, reason: 'EOD' });
            results[symbol].totalPnl += pnl;
            if (pnl > 0) results[symbol].wins++; else results[symbol].losses++;
            inPosition = false;
          }
        } else { // long
          if (low <= slPrice) {
            const pnl = Math.round((slPrice - entryPrice) * (3000000 / entryPrice));
            results[symbol].trades.push({ date, time: entryTime + '→' + c.candleTime, side: 'LONG', entry: entryPrice, exit: slPrice, pnl, reason: 'SL' });
            results[symbol].totalPnl += pnl;
            if (pnl > 0) results[symbol].wins++; else results[symbol].losses++;
            inPosition = false;
          } else if (high >= tpPrice) {
            const pnl = Math.round((tpPrice - entryPrice) * (3000000 / entryPrice));
            results[symbol].trades.push({ date, time: entryTime + '→' + c.candleTime, side: 'LONG', entry: entryPrice, exit: tpPrice, pnl, reason: 'TP' });
            results[symbol].totalPnl += pnl;
            if (pnl > 0) results[symbol].wins++; else results[symbol].losses++;
            inPosition = false;
          } else if (c.candleTime >= '15:25') {
            const exitPrice = price;
            const pnl = Math.round((exitPrice - entryPrice) * (3000000 / entryPrice));
            results[symbol].trades.push({ date, time: entryTime + '→' + c.candleTime, side: 'LONG', entry: entryPrice, exit: exitPrice, pnl, reason: 'EOD' });
            results[symbol].totalPnl += pnl;
            if (pnl > 0) results[symbol].wins++; else results[symbol].losses++;
            inPosition = false;
          }
        }
        continue;
      }
      
      // Only enter after 09:15 and before 14:30
      if (c.candleTime < '09:15' || c.candleTime > '14:30') continue;
      
      // Detect round number crossing (simple version)
      const rounds = getRoundNumbers(price);
      for (const round of rounds) {
        // SHORT: price crossed below round (prev was above, now below)
        if (prevClose > round && price < round) {
          const dist = Math.abs(price - round) / round;
          if (dist < 0.008) { // within 0.8%
            entryPrice = price;
            entryTime = c.candleTime;
            slPrice = entryPrice * 1.005;
            tpPrice = entryPrice * 0.985;
            positionSide = 'short';
            inPosition = true;
            break;
          }
        }
        // LONG: price crossed above round (prev was below, now above)
        if (prevClose < round && price > round) {
          const dist = Math.abs(price - round) / round;
          if (dist < 0.008) {
            entryPrice = price;
            entryTime = c.candleTime;
            slPrice = entryPrice * 0.995;
            tpPrice = entryPrice * 1.015;
            positionSide = 'long';
            inPosition = true;
            break;
          }
        }
      }
    }
  }
}

// Output results
console.log('=== 除外銘柄 仮想シミュレーション (7/16-7/23) ===\n');
console.log('銘柄 | セクター | 件数 | 勝率 | 損益');
console.log('-----|---------|------|------|------');

const sorted = Object.entries(results).sort((a, b) => b[1].totalPnl - a[1].totalPnl);
let grandTotal = 0, grandTrades = 0, grandWins = 0;

for (const [sym, r] of sorted) {
  const total = r.wins + r.losses;
  grandTotal += r.totalPnl;
  grandTrades += total;
  grandWins += r.wins;
  const wr = total > 0 ? Math.round(r.wins / total * 100) : 0;
  console.log(`${sym} ${r.name} | ${r.sector} | ${total}件 | ${wr}% | ${r.totalPnl.toLocaleString()}円`);
}

console.log(`\n合計: ${grandTrades}件 | 勝率${Math.round(grandWins/grandTrades*100)}% | ${grandTotal.toLocaleString()}円`);

// Show top trades
console.log('\n=== 注目取引 (利益上位) ===');
const allTrades = sorted.flatMap(([sym, r]) => r.trades.map(t => ({ ...t, symbol: sym, name: r.name })));
allTrades.sort((a, b) => b.pnl - a.pnl);
for (const t of allTrades.slice(0, 10)) {
  console.log(`${t.date} ${t.time} ${t.symbol} ${t.name} ${t.side} @${t.entry}→${Math.round(t.exit)} ${t.pnl > 0 ? '+' : ''}${t.pnl.toLocaleString()}円 (${t.reason})`);
}

console.log('\n=== 損失上位 ===');
for (const t of allTrades.slice(-5).reverse()) {
  console.log(`${t.date} ${t.time} ${t.symbol} ${t.name} ${t.side} @${t.entry}→${Math.round(t.exit)} ${t.pnl > 0 ? '+' : ''}${t.pnl.toLocaleString()}円 (${t.reason})`);
}

await conn.end();
