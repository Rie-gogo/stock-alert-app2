import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// The 4 winning trades (excluding 7/13 09:49 which we already checked)
const trades = [
  { date: '2026-07-07', time: '09:43', side: 'short' },
  { date: '2026-07-07', time: '10:13', side: 'short' },
  { date: '2026-07-10', time: '13:41', side: 'short' },
];

for (const t of trades) {
  const [entry] = await conn.query(`
    SELECT tradeTime, price, shares FROM rt_trades 
    WHERE symbol = '285A' AND tradeDate = ? AND tradeTime = ? AND action = ?
  `, [t.date, t.time, t.side]);
  
  if (!entry[0]) { console.log(`\n❌ ${t.date} ${t.time} エントリーなし`); continue; }
  
  const entryPrice = Number(entry[0].price);
  const shares = Number(entry[0].shares);
  const slPrice = Math.ceil(entryPrice * 1.005); // 0.5% stop loss for SHORT
  
  // TP levels
  const tp15 = entryPrice * (1 - 0.015);
  const tp20 = entryPrice * (1 - 0.02);
  const tp25 = entryPrice * (1 - 0.025);
  const tp30 = entryPrice * (1 - 0.03);
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${t.date} ${t.time} SHORT @${entryPrice}円 x ${shares}株`);
  console.log(`  損切りライン: ${slPrice}円 (+0.5%)`);
  console.log(`  利確1.5%: ${Math.round(tp15)}円 | 2.0%: ${Math.round(tp20)}円 | 2.5%: ${Math.round(tp25)}円 | 3.0%: ${Math.round(tp30)}円`);
  
  // Get candles after entry
  const [candles] = await conn.query(`
    SELECT candleTime, open, high, low, close FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = ? AND candleTime > ? AND candleTime <= '15:30'
    ORDER BY candleTime ASC
  `, [t.date, t.time]);
  
  // Track max adverse excursion (highest high after entry = worst drawdown for SHORT)
  let maxHigh = 0;
  let maxHighTime = '';
  let tp15Time = null, tp20Time = null, tp25Time = null, tp30Time = null;
  let slHit = false;
  let slHitTime = '';
  
  // Track drawdown at each TP level
  let maxHighBefore15 = 0, maxHighBefore20 = 0, maxHighBefore25 = 0, maxHighBefore30 = 0;
  
  for (const c of candles) {
    const high = Number(c.high);
    const low = Number(c.low);
    
    // Track max high (worst for SHORT)
    if (high > maxHigh) {
      maxHigh = high;
      maxHighTime = c.candleTime;
    }
    
    // Check SL hit
    if (!slHit && high >= slPrice) {
      slHit = true;
      slHitTime = c.candleTime;
    }
    
    // Track max high before each TP
    if (!tp15Time && high > maxHighBefore15) maxHighBefore15 = high;
    if (!tp20Time && high > maxHighBefore20) maxHighBefore20 = high;
    if (!tp25Time && high > maxHighBefore25) maxHighBefore25 = high;
    if (!tp30Time && high > maxHighBefore30) maxHighBefore30 = high;
    
    // Check TP hits
    if (!tp15Time && low <= tp15) tp15Time = c.candleTime;
    if (!tp20Time && low <= tp20) tp20Time = c.candleTime;
    if (!tp25Time && low <= tp25) tp25Time = c.candleTime;
    if (!tp30Time && low <= tp30) tp30Time = c.candleTime;
  }
  
  // Results
  console.log(`\n  --- 利確到達 ---`);
  console.log(`  1.5%: ${tp15Time || '未到達'}`);
  console.log(`  2.0%: ${tp20Time || '未到達'}`);
  console.log(`  2.5%: ${tp25Time || '未到達'}`);
  console.log(`  3.0%: ${tp30Time || '未到達'}`);
  
  console.log(`\n  --- 最大反発（SLリスク） ---`);
  console.log(`  全体最大高値: ${maxHigh}円 (${maxHighTime}) → エントリー比+${((maxHigh - entryPrice) / entryPrice * 100).toFixed(3)}% ${maxHigh >= slPrice ? '★SLヒット!' : `(SLまで残り${slPrice - maxHigh}円)`}`);
  
  if (slHit) {
    console.log(`  ★★★ SLヒット時刻: ${slHitTime} ★★★`);
  }
  
  // Drawdown before each TP
  console.log(`\n  --- 各利確ライン到達前の最大反発 ---`);
  const drawdown15 = ((maxHighBefore15 - entryPrice) / entryPrice * 100).toFixed(3);
  const drawdown20 = ((maxHighBefore20 - entryPrice) / entryPrice * 100).toFixed(3);
  const drawdown25 = ((maxHighBefore25 - entryPrice) / entryPrice * 100).toFixed(3);
  const drawdown30 = ((maxHighBefore30 - entryPrice) / entryPrice * 100).toFixed(3);
  const slPct = 0.5;
  
  console.log(`  1.5%利確前: 最大+${drawdown15}% (SL+${slPct}%まで残り${(slPct - Number(drawdown15)).toFixed(3)}%) ${Number(drawdown15) >= slPct ? '→ ★SL先にヒット!' : '→ OK'}`);
  console.log(`  2.0%利確前: 最大+${drawdown20}% (SL+${slPct}%まで残り${(slPct - Number(drawdown20)).toFixed(3)}%) ${Number(drawdown20) >= slPct ? '→ ★SL先にヒット!' : '→ OK'}`);
  console.log(`  2.5%利確前: 最大+${drawdown25}% (SL+${slPct}%まで残り${(slPct - Number(drawdown25)).toFixed(3)}%) ${Number(drawdown25) >= slPct ? '→ ★SL先にヒット!' : '→ OK'}`);
  console.log(`  3.0%利確前: 最大+${drawdown30}% (SL+${slPct}%まで残り${(slPct - Number(drawdown30)).toFixed(3)}%) ${Number(drawdown30) >= slPct ? '→ ★SL先にヒット!' : '→ OK'}`);
  
  // Show candles around the max high point (the reversal)
  const maxHighIdx = candles.findIndex(c => c.candleTime === maxHighTime);
  if (maxHighIdx >= 0) {
    const start = Math.max(0, maxHighIdx - 2);
    const end = Math.min(candles.length, maxHighIdx + 3);
    console.log(`\n  --- 最大反発前後の値動き ---`);
    for (let i = start; i < end; i++) {
      const c = candles[i];
      const marker = c.candleTime === maxHighTime ? ' ← MAX' : '';
      console.log(`  ${c.candleTime}: H=${Number(c.high)} L=${Number(c.low)} C=${Number(c.close)}${marker}`);
    }
  }
}

await conn.end();
