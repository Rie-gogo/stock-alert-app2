import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all trades with AM/PM split
const [exits] = await conn.query(`
  SELECT tradeDate, symbol, action, pnl, tradeTime
  FROM rt_trades
  WHERE pnl IS NOT NULL
  ORDER BY tradeDate, tradeTime
`);

let amWins = 0, amLosses = 0, amPnl = 0;
let pmWins = 0, pmLosses = 0, pmPnl = 0;
let pm13Wins = 0, pm13Losses = 0, pm13Pnl = 0;
let pm14Wins = 0, pm14Losses = 0, pm14Pnl = 0;

for (const t of exits) {
  const pnl = Number(t.pnl);
  const isWin = pnl > 0;
  
  if (t.tradeTime < '12:30') {
    amPnl += pnl;
    if (isWin) amWins++; else amLosses++;
  } else {
    pmPnl += pnl;
    if (isWin) pmWins++; else pmLosses++;
    
    if (t.tradeTime < '14:00') {
      pm13Pnl += pnl;
      if (isWin) pm13Wins++; else pm13Losses++;
    } else {
      pm14Pnl += pnl;
      if (isWin) pm14Wins++; else pm14Losses++;
    }
  }
}

console.log("=== 全期間 午前 vs 午後 成績比較 ===\n");
console.log(`午前(〜11:30): ${amWins + amLosses}件, 勝率${(amWins/(amWins+amLosses)*100).toFixed(1)}% (${amWins}勝${amLosses}敗), PnL=${amPnl >= 0 ? '+' : ''}${amPnl.toLocaleString()}円`);
console.log(`午後(13:00〜): ${pmWins + pmLosses}件, 勝率${(pmWins/(pmWins+pmLosses)*100).toFixed(1)}% (${pmWins}勝${pmLosses}敗), PnL=${pmPnl >= 0 ? '+' : ''}${pmPnl.toLocaleString()}円`);
console.log(`  13時台: ${pm13Wins + pm13Losses}件, 勝率${pm13Wins+pm13Losses > 0 ? (pm13Wins/(pm13Wins+pm13Losses)*100).toFixed(1) : 0}% (${pm13Wins}勝${pm13Losses}敗), PnL=${pm13Pnl >= 0 ? '+' : ''}${pm13Pnl.toLocaleString()}円`);
console.log(`  14時台〜: ${pm14Wins + pm14Losses}件, 勝率${pm14Wins+pm14Losses > 0 ? (pm14Wins/(pm14Wins+pm14Losses)*100).toFixed(1) : 0}% (${pm14Wins}勝${pm14Losses}敗), PnL=${pm14Pnl >= 0 ? '+' : ''}${pm14Pnl.toLocaleString()}円`);

// Per-day AM vs PM
console.log("\n=== 日別 午前/午後 比較 ===");
const dates = [...new Set(exits.map(t => t.tradeDate))].sort();
for (const d of dates) {
  const dayExits = exits.filter(t => t.tradeDate === d);
  const am = dayExits.filter(t => t.tradeTime < '12:30');
  const pm = dayExits.filter(t => t.tradeTime >= '12:30');
  const amP = am.reduce((s, t) => s + Number(t.pnl), 0);
  const pmP = pm.reduce((s, t) => s + Number(t.pnl), 0);
  const amW = am.filter(t => Number(t.pnl) > 0).length;
  const pmW = pm.filter(t => Number(t.pnl) > 0).length;
  console.log(`  ${d}: 午前${amW}勝${am.length-amW}敗(${amP >= 0 ? '+' : ''}${amP.toLocaleString()}円) | 午後${pmW}勝${pm.length-pmW}敗(${pmP >= 0 ? '+' : ''}${pmP.toLocaleString()}円)`);
}

// Check: on days with large AM drops, how did PM perform?
console.log("\n=== 午前大幅下落日の午後成績 ===");
// 7/13 had 6976 -11.5%, 285A -7%, 6981 -5% in the morning
// These are the days where PM shorts tend to fail

await conn.end();
