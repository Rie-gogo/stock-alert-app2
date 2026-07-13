import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get the 7/13 09:49 entry
const [entry] = await conn.query(`
  SELECT * FROM rt_trades WHERE symbol = '285A' AND tradeDate = '2026-07-13' AND tradeTime = '09:49' AND action = 'short'
`);
const entryPrice = Number(entry[0].price);
const shares = Number(entry[0].shares);
console.log(`=== 7/13 285A 09:49 SHORT エントリー詳細 ===`);
console.log(`エントリー価格: ${entryPrice}円 x ${shares}株`);

// Get the actual exit
const [exit] = await conn.query(`
  SELECT * FROM rt_trades WHERE symbol = '285A' AND tradeDate = '2026-07-13' AND tradeTime > '09:49' AND action = 'cover' ORDER BY tradeTime ASC LIMIT 1
`);
console.log(`実際の決済: ${exit[0].tradeTime} @${exit[0].price} PnL=${exit[0].pnl}円`);
console.log(`決済理由: ${exit[0].reason}\n`);

// Extract stop loss from reason
let stopLossPrice = null;
if (exit[0].reason && exit[0].reason.includes('利確ライン:')) {
  const match = exit[0].reason.match(/利確ライン:(\d+)/);
  if (match) console.log(`利確ライン: ${match[1]}円`);
}

// Get the actual stop loss line - check the entry reason or engine logic
// For SHORT, stop loss = entryPrice * (1 + stopLossRatio)
// Need to find what the stop loss ratio is
const stopLossRatio = 0.005; // typical 0.5% for this engine
const slPrice = Math.round(entryPrice * (1 + stopLossRatio) * 100) / 100;
console.log(`推定損切りライン (0.5%): ${slPrice}円`);

// Calculate TP levels
const tpLevels = [0.015, 0.02, 0.025, 0.03];
for (const tp of tpLevels) {
  const tpPrice = Math.round(entryPrice * (1 - tp));
  console.log(`利確ライン ${(tp*100).toFixed(1)}%: ${tpPrice}円 (エントリーから-${Math.round(entryPrice * tp)}円)`);
}

// Get candles after entry
const [candles] = await conn.query(`
  SELECT candleTime, open, high, low, close, volume FROM rt_candles
  WHERE symbol = '285A' AND tradeDate = '2026-07-13' AND candleTime >= '09:49' AND candleTime <= '10:10'
  ORDER BY candleTime ASC
`);

console.log(`\n=== 1分足推移 (09:49〜10:10) ===`);
console.log(`時刻  | 始値   | 高値   | 安値   | 終値   | 出来高 | エントリー比`);
console.log(`------|--------|--------|--------|--------|--------|--------`);

for (const c of candles) {
  const high = Number(c.high);
  const low = Number(c.low);
  const close = Number(c.close);
  const highPct = ((high - entryPrice) / entryPrice * 100).toFixed(2);
  const lowPct = ((low - entryPrice) / entryPrice * 100).toFixed(2);
  const closePct = ((close - entryPrice) / entryPrice * 100).toFixed(2);
  console.log(`${c.candleTime} | ${Number(c.open)} | ${high} | ${low} | ${close} | ${c.volume} | H${highPct}% L${lowPct}%`);
}

// Simulate each TP level with proper stop loss check
console.log(`\n=== 各利確ラインでのシミュレーション ===`);

// Get all candles until end of day
const [allCandles] = await conn.query(`
  SELECT candleTime, open, high, low, close FROM rt_candles
  WHERE symbol = '285A' AND tradeDate = '2026-07-13' AND candleTime > '09:49' AND candleTime <= '15:30'
  ORDER BY candleTime ASC
`);

// Find the actual stop loss price used by the engine
// From the exit data, the actual exit was at 利確ライン - so we need to check what SL was
// Let's look at the entry to find the SL
const [slCheck] = await conn.query(`
  SELECT * FROM rt_trades WHERE symbol = '285A' AND tradeDate = '2026-07-13' AND action = 'cover' AND reason LIKE '%損切り%'
`);
if (slCheck.length > 0) {
  console.log(`\n同日の損切り事例: ${slCheck[0].tradeTime} @${slCheck[0].price} 理由:${slCheck[0].reason}`);
  const slMatch = slCheck[0].reason.match(/損切りライン:(\d+)/);
  if (slMatch) {
    const slVal = Number(slMatch[1]);
    const slEntry = await conn.query(`SELECT price FROM rt_trades WHERE symbol = '285A' AND tradeDate = '2026-07-13' AND action = 'short' AND tradeTime < '${slCheck[0].tradeTime}' ORDER BY tradeTime DESC LIMIT 1`);
    if (slEntry[0].length > 0) {
      const entP = Number(slEntry[0][0].price);
      const slRatio = (slVal - entP) / entP;
      console.log(`  エントリー${entP} → 損切り${slVal} = ${(slRatio*100).toFixed(3)}%`);
    }
  }
}

// For the 09:49 entry, check what SL was actually set
// The exit reason says 利確ライン:72141 → this was a TP exit
// We need to figure out the SL that was set
// From the 13:10 entry: entry@67200, SL@67536 → (67536-67200)/67200 = 0.5%
// So SL for SHORT = entry * 1.005
const actualSL = Math.ceil(entryPrice * 1.005);
console.log(`\n09:49エントリーの損切りライン (0.5%): ${actualSL}円`);

console.log(`\n--- シミュレーション結果 ---`);
for (const tp of tpLevels) {
  const tpPrice = entryPrice * (1 - tp);
  let hit = null;
  
  for (const c of allCandles) {
    const high = Number(c.high);
    const low = Number(c.low);
    
    // SHORT: SL hit if high >= SL price
    if (high >= actualSL) {
      hit = { time: c.candleTime, type: '損切り', price: actualSL, pnl: (entryPrice - actualSL) * shares };
      break;
    }
    // SHORT: TP hit if low <= TP price
    if (low <= tpPrice) {
      hit = { time: c.candleTime, type: `利確(${(tp*100).toFixed(1)}%)`, price: tpPrice, pnl: (entryPrice - tpPrice) * shares };
      break;
    }
  }
  
  if (hit) {
    console.log(`  ${(tp*100).toFixed(1)}%利確: ${hit.time} ${hit.type} @${Math.round(hit.price)} PnL=${hit.pnl >= 0 ? '+' : ''}${Math.round(hit.pnl).toLocaleString()}円`);
  } else {
    console.log(`  ${(tp*100).toFixed(1)}%利確: 到達せず（大引け決済）`);
  }
}

// Also check: did the price go above entry (potential SL zone) before hitting TP?
console.log(`\n--- 反発チェック: エントリー後に高値がSLに接近した足 ---`);
for (const c of allCandles.slice(0, 30)) {
  const high = Number(c.high);
  if (high > entryPrice) {
    const abovePct = ((high - entryPrice) / entryPrice * 100).toFixed(3);
    console.log(`  ${c.candleTime}: 高値${high} (エントリー比+${abovePct}%) ${high >= actualSL ? '→ ★損切りヒット!' : ''}`);
  }
}

await conn.end();
