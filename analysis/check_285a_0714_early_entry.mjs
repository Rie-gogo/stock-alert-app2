import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get 285A candles from 13:00 to 15:00 to see the full afternoon picture
const [candles] = await conn.query(`
  SELECT candleTime, open, high, low, close, volume
  FROM rt_candles
  WHERE tradeDate = '2026-07-14' AND symbol = '285A'
    AND candleTime >= '13:00' AND candleTime <= '15:00'
  ORDER BY candleTime ASC
`);

console.log("=== 285A 7/14 13:00-15:00 1分足 ===\n");
console.log("時刻  | 始値   | 高値   | 安値   | 終値   | 出来高  | MA5    | MA25   | 備考");

// Calculate MA5 and MA25 using all candles from the day
const [allCandles] = await conn.query(`
  SELECT candleTime, open, high, low, close, volume
  FROM rt_candles
  WHERE tradeDate = '2026-07-14' AND symbol = '285A'
  ORDER BY candleTime ASC
`);

const closes = allCandles.map(c => Number(c.close));
const startIdx = allCandles.findIndex(c => c.candleTime === '13:00');

for (let i = startIdx; i < allCandles.length; i++) {
  const c = allCandles[i];
  const time = c.candleTime;
  
  // MA5
  let ma5 = null;
  if (i >= 4) {
    ma5 = closes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
  }
  
  // MA25
  let ma25 = null;
  if (i >= 24) {
    ma25 = closes.slice(i - 24, i + 1).reduce((a, b) => a + b, 0) / 25;
  }
  
  // Detect potential signals
  let note = '';
  
  // Golden cross check
  if (i >= 25 && ma5 && ma25) {
    const prevMa5 = closes.slice(i - 5, i).reduce((a, b) => a + b, 0) / 5;
    const prevMa25 = closes.slice(i - 25, i).reduce((a, b) => a + b, 0) / 25;
    if (prevMa5 <= prevMa25 && ma5 > ma25) {
      note += '★GC ';
    }
  }
  
  // VWAP check (approximate using cumulative avg)
  const cumVol = allCandles.slice(0, i + 1).reduce((s, x) => s + Number(x.volume), 0);
  const cumVolPrice = allCandles.slice(0, i + 1).reduce((s, x) => s + Number(x.close) * Number(x.volume), 0);
  const vwap = cumVolPrice / cumVol;
  
  // Price crossing above VWAP
  if (i > 0) {
    const prevClose = closes[i - 1];
    if (prevClose < vwap && Number(c.close) > vwap) {
      note += '★VWAP上抜け ';
    }
    // Bounce from VWAP
    if (Math.abs(Number(c.low) - vwap) / vwap < 0.002 && Number(c.close) > vwap) {
      note += '★VWAP反発 ';
    }
  }
  
  // 大台超え check
  const roundLevels = [63000, 64000, 65000, 66000, 67000, 68000, 69000, 70000, 71000];
  for (const level of roundLevels) {
    if (Number(c.close) > level && closes[i-1] <= level) {
      note += `★大台超え(${level}) `;
    }
  }
  
  // Dow theory - higher high
  if (i >= 5) {
    const recent5High = Math.max(...allCandles.slice(i-5, i).map(x => Number(x.high)));
    if (Number(c.high) > recent5High && Number(c.close) > closes[i-1]) {
      note += '↑高値更新 ';
    }
  }
  
  if (time >= '13:00') {
    console.log(`${time} | ${Number(c.open).toLocaleString().padStart(6)} | ${Number(c.high).toLocaleString().padStart(6)} | ${Number(c.low).toLocaleString().padStart(6)} | ${Number(c.close).toLocaleString().padStart(6)} | ${Number(c.volume).toLocaleString().padStart(7)} | ${ma5 ? Math.round(ma5).toLocaleString().padStart(6) : '  N/A '} | ${ma25 ? Math.round(ma25).toLocaleString().padStart(6) : '  N/A '} | ${note}`);
  }
}

// Check what the actual engine detected
console.log("\n\n=== エンジンが検出したシグナル（本日285A全て） ===");
const [signals] = await conn.query(`
  SELECT tradeTime, action, price, reason
  FROM rt_trades
  WHERE tradeDate = '2026-07-14' AND symbol = '285A'
  ORDER BY tradeTime ASC
`);
for (const s of signals) {
  console.log(`${s.tradeTime} | ${s.action} | @${Number(s.price).toLocaleString()} | ${s.reason}`);
}

// Key question: when did the uptrend start?
console.log("\n\n=== 上昇トレンド開始の分析 ===");
// Find the afternoon low
let pmLow = Infinity, pmLowTime = '';
for (const c of allCandles) {
  if (c.candleTime >= '13:00' && Number(c.low) < pmLow) {
    pmLow = Number(c.low);
    pmLowTime = c.candleTime;
  }
}
console.log(`午後安値: ${pmLow.toLocaleString()}円 (${pmLowTime})`);

// Find when price crossed above key levels after the low
const afterLow = allCandles.filter(c => c.candleTime > pmLowTime);
for (const level of [66000, 67000, 68000, 69000, 70000]) {
  const cross = afterLow.find(c => Number(c.close) > level);
  if (cross) {
    console.log(`${level}円突破: ${cross.candleTime}`);
  }
}

// VWAP at key times
for (const checkTime of ['13:00', '13:30', '14:00', '14:15', '14:30']) {
  const idx = allCandles.findIndex(c => c.candleTime === checkTime);
  if (idx >= 0) {
    const cumVol = allCandles.slice(0, idx + 1).reduce((s, x) => s + Number(x.volume), 0);
    const cumVolPrice = allCandles.slice(0, idx + 1).reduce((s, x) => s + Number(x.close) * Number(x.volume), 0);
    const vwap = cumVolPrice / cumVol;
    console.log(`VWAP@${checkTime}: ${Math.round(vwap).toLocaleString()}円 (終値: ${Number(allCandles[idx].close).toLocaleString()}円) → ${Number(allCandles[idx].close) > vwap ? '上' : '下'}`);
  }
}

await conn.end();
