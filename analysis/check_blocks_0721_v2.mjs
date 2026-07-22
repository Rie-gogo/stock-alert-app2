/**
 * 7/21のブロックケースを1分足データから再計算する
 * signalHistoryはメモリ上のみなので、1分足データから大台シグナル発生→0.8%ブロック判定を再現する
 */
import mysql from "mysql2/promise";

const ROUND_DISTANCE_BLOCK_THRESHOLD = 0.008;
const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A'];

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 7/21の全1分足データ取得（アクティブ銘柄のみ）
const [allCandles] = await conn.execute(`
  SELECT symbol, candleTime, open, high, low, close, volume 
  FROM rt_candles 
  WHERE tradeDate = '2026-07-21' AND symbol IN ('8035','6857','6976','6526','5803','6981','285A')
  ORDER BY symbol, candleTime
`);

// 銘柄別に整理
const candlesBySymbol = {};
for (const c of allCandles) {
  if (!candlesBySymbol[c.symbol]) candlesBySymbol[c.symbol] = [];
  candlesBySymbol[c.symbol].push({
    ...c, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
  });
}

// 大台レベルを計算する関数（元のrealtimeSimEngineと同一ロジック）
function getRoundLevels(price) {
  const levels = [];
  // 価格帯に応じた大台
  if (price >= 100000) {
    const base = Math.floor(price / 10000) * 10000;
    levels.push(base, base + 10000, base - 10000);
    const base5k = Math.floor(price / 5000) * 5000;
    levels.push(base5k, base5k + 5000);
  } else if (price >= 10000) {
    const base = Math.floor(price / 1000) * 1000;
    levels.push(base, base + 1000, base - 1000);
    const base500 = Math.floor(price / 500) * 500;
    levels.push(base500, base500 + 500);
  } else if (price >= 1000) {
    const base = Math.floor(price / 500) * 500;
    levels.push(base, base + 500, base - 500);
    const base100 = Math.floor(price / 100) * 100;
    levels.push(base100, base100 + 100);
  } else {
    const base = Math.floor(price / 100) * 100;
    levels.push(base, base + 100, base - 100);
  }
  return [...new Set(levels)];
}

function calculateRoundDistancePct(price) {
  const levels = getRoundLevels(price);
  let minDist = Infinity;
  for (const level of levels) {
    const dist = Math.abs(price - level) / level;
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

// 大台シグナル検出のシンプルな再現
// 実際のエンジンは5本維持等の条件があるが、ここでは大台を下回った/上回った瞬間を検出
function detectRoundSignals(candles, symbol) {
  const signals = [];
  
  for (let i = 5; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i-1];
    
    // SHORT: 大台割れ（前足が大台以上、現足が大台以下）
    const roundLevels = getRoundLevels(c.close);
    for (const level of roundLevels) {
      // 大台割れ: 前足closeが大台以上で、現足closeが大台未満
      if (prev.close >= level && c.close < level) {
        // 5本維持チェック（簡易版: 直近5本のcloseが全て大台以上）
        const last5 = candles.slice(i-5, i);
        const maintained = last5.every(x => x.close >= level);
        if (maintained) {
          const divergence = Math.abs(c.close - level) / level;
          signals.push({
            symbol, time: c.candleTime, type: 'SHORT',
            price: c.close, level, divergence,
            blocked: divergence > ROUND_DISTANCE_BLOCK_THRESHOLD,
            divergencePct: (divergence * 100).toFixed(2)
          });
        }
      }
      // LONG: 大台超え（前足closeが大台未満、現足closeが大台以上）
      if (prev.close < level && c.close >= level) {
        const last5 = candles.slice(i-5, i);
        const maintained = last5.every(x => x.close < level);
        if (maintained) {
          const divergence = Math.abs(c.close - level) / level;
          signals.push({
            symbol, time: c.candleTime, type: 'LONG',
            price: c.close, level, divergence,
            blocked: divergence > ROUND_DISTANCE_BLOCK_THRESHOLD,
            divergencePct: (divergence * 100).toFixed(2)
          });
        }
      }
    }
  }
  return signals;
}

console.log("=== 7/21 大台シグナル検出（全アクティブ銘柄） ===\n");

let totalSignals = 0;
let blockedShort = [];
let blockedLong = [];
let passedSignals = [];

for (const sym of ACTIVE_SYMBOLS) {
  const candles = candlesBySymbol[sym];
  if (!candles || candles.length === 0) continue;
  
  const signals = detectRoundSignals(candles, sym);
  if (signals.length > 0) {
    console.log(`${sym}: ${signals.length}件のシグナル検出`);
    for (const s of signals) {
      const status = s.blocked ? '★ブロック' : '通過';
      console.log(`  ${s.time} ${s.type} @${s.price} 大台=${s.level} 乖離=${s.divergencePct}% [${status}]`);
      totalSignals++;
      if (s.blocked && s.type === 'SHORT') blockedShort.push(s);
      if (s.blocked && s.type === 'LONG') blockedLong.push(s);
      if (!s.blocked) passedSignals.push(s);
    }
  }
}

console.log(`\n=== サマリー ===`);
console.log(`総シグナル数: ${totalSignals}`);
console.log(`通過: ${passedSignals.length}件`);
console.log(`ブロックSHORT: ${blockedShort.length}件 ← CB v2/バイパスの対象`);
console.log(`ブロックLONG: ${blockedLong.length}件`);

if (blockedShort.length > 0) {
  console.log(`\n=== ブロックされたSHORT（CB v2/バイパス対象） ===`);
  for (const s of blockedShort) {
    console.log(`  ${s.symbol} ${s.time} @${s.price} 大台=${s.level} 乖離=${s.divergencePct}%`);
  }
}

await conn.end();
