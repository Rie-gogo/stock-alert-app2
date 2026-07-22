import mysql from 'mysql2/promise';
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all entries
const [allEntries] = await conn.execute(`
  SELECT id, tradeDate, symbol, price, reason, side, tradeTime
  FROM rt_trades WHERE action IN ('buy','short') ORDER BY tradeDate, tradeTime
`);
const [allExits] = await conn.execute(`
  SELECT id, tradeDate, symbol, action, price, shares, pnl, reason, tradeTime, side
  FROM rt_trades WHERE action IN ('sell','cover') ORDER BY tradeDate, tradeTime
`);

// Pair trades
const exitsCopy = [...allExits];
const trades = [];
for (const entry of allEntries) {
  const exit = exitsCopy.find(
    e => e.tradeDate === entry.tradeDate && e.symbol === entry.symbol && e.side === entry.side
      && e.tradeTime >= entry.tradeTime && e.pnl !== null
  );
  if (exit) {
    trades.push({
      tradeDate: entry.tradeDate, symbol: entry.symbol,
      entryPrice: parseFloat(entry.price), pnl: exit.pnl,
      reason: entry.reason, side: entry.side, tradeTime: entry.tradeTime,
    });
    exitsCopy.splice(exitsCopy.indexOf(exit), 1);
  }
}

// Classify
function isRoundSignal(reason) {
  return reason.includes("大台確認") || reason.includes("大台超え") || reason.includes("大台割れ");
}
function getRoundLevel(reason) {
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}

let roundShortBlocked = [];
let roundShortPassed = [];
let longTrades = [];
let nonRoundTrades = [];

for (const t of trades) {
  t.isRound = isRoundSignal(t.reason);
  t.roundLevel = t.isRound ? getRoundLevel(t.reason) : null;
  t.divergence = t.isRound && t.roundLevel ? Math.abs(t.entryPrice - t.roundLevel) / t.roundLevel : null;
  
  if (!t.isRound) {
    nonRoundTrades.push(t);
  } else if (t.side === "long") {
    longTrades.push(t);
  } else if (t.divergence !== null && t.divergence > 0.008) {
    roundShortBlocked.push(t);
  } else {
    roundShortPassed.push(t);
  }
}

console.log("=== Trade Classification ===");
console.log(`Total trades: ${trades.length}`);
console.log(`Non-round trades: ${nonRoundTrades.length} (SHORT: ${nonRoundTrades.filter(t=>t.side==='short').length})`);
console.log(`Round LONG: ${longTrades.length}`);
console.log(`Round SHORT passed (<=0.8%): ${roundShortPassed.length}`);
console.log(`Round SHORT blocked (>0.8%): ${roundShortBlocked.length}`);
console.log();

// Original backtest Case 1 = passed08.filter(side==='short')
// passed08 = trades where (!isRound || divergence===null || divergence<=0.008)
// So passed08 includes: nonRoundTrades + longTrades(where div<=0.8 or not round) + roundShortPassed
// case1Trades = passed08.filter(side==='short') = nonRoundShort + roundShortPassed
const case1Trades = [...nonRoundTrades.filter(t=>t.side==='short'), ...roundShortPassed];
const case1Pnl = case1Trades.reduce((s,t) => s + t.pnl, 0);
console.log(`=== Original Backtest Case 1 (case1Trades = passed08 SHORT) ===`);
console.log(`Count: ${case1Trades.length}, PnL: ${case1Pnl}`);
console.log(`This should match: 72件, 201,955円`);
console.log();

// Now check: what does the daily_pnl_comparison.mjs compute?
// It loads all entries, pairs them, then:
// passed08 = trades where (!isRound || divergence===null || divergence<=0.008)
// Then filters to side==='short'
// Should be identical...

// Check if there are 7/17 trades in the original backtest
const july17 = trades.filter(t => t.tradeDate === '2026-07-17');
console.log(`=== 7/17 trades ===`);
console.log(`Count: ${july17.length}`);
for (const t of july17) {
  console.log(`  ${t.symbol} ${t.side} ${t.reason} pnl=${t.pnl}`);
}
console.log();

// The original backtest was run BEFORE 7/17 data existed
// So the original 201,955 was 6/17-7/16 only
// But daily_pnl_comparison includes 7/17!
// Let's check without 7/17
const case1TradesNoJuly17 = case1Trades.filter(t => t.tradeDate !== '2026-07-17');
const case1PnlNoJuly17 = case1TradesNoJuly17.reduce((s,t) => s + t.pnl, 0);
console.log(`=== Case 1 WITHOUT 7/17 ===`);
console.log(`Count: ${case1TradesNoJuly17.length}, PnL: ${case1PnlNoJuly17}`);
console.log();

// Now check the daily_pnl_comparison result
// It reported Case1 SHORT = -59,809 (with 7/17)
// Without 7/17 it should be: -59,809 - 96,405 = -156,214
console.log(`=== Discrepancy Analysis ===`);
console.log(`Original backtest Case 1: 201,955 (72 trades)`);
console.log(`My calculation Case 1 (no 7/17): ${case1PnlNoJuly17} (${case1TradesNoJuly17.length} trades)`);
console.log(`Difference: ${case1PnlNoJuly17 - 201955}`);
console.log();

// Check if the issue is that the original backtest RESIMULATES exits
// while daily_pnl uses actual DB pnl
console.log("=== Checking if original backtest resimulates exits ===");
// The original backtest uses exit.pnl from DB directly (line 55: pnl: exit.pnl)
// So it should be the same...

// Let's check date range
const dates = [...new Set(trades.map(t=>t.tradeDate))].sort();
console.log(`Date range: ${dates[0]} to ${dates[dates.length-1]}`);
console.log(`Total dates: ${dates.length}`);

// Check if there are duplicate trades
const dupes = [];
for (let i = 0; i < trades.length - 1; i++) {
  for (let j = i+1; j < trades.length; j++) {
    if (trades[i].tradeDate === trades[j].tradeDate && 
        trades[i].symbol === trades[j].symbol && 
        trades[i].side === trades[j].side &&
        trades[i].tradeTime === trades[j].tradeTime) {
      dupes.push(trades[i]);
    }
  }
}
console.log(`Duplicate trades: ${dupes.length}`);

await conn.end();
