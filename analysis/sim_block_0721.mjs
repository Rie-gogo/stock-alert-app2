/**
 * 7/21 ブロックされたSHORT (285A 11:09 @56000 大台=56500 乖離=0.88%) に対する
 * CB v2 / drop_0.6バイパス シミュレーション
 */
import mysql from "mysql2/promise";

const POSITION_SIZE = 3_000_000;
const SL_PCT = 0.005;
const TP_PCT = 0.015;
const FORCE_EXIT_TIME = "15:25";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 285Aの7/21 1分足データ取得
const [rows] = await conn.execute(`
  SELECT candleTime, open, high, low, close, volume 
  FROM rt_candles 
  WHERE symbol = '285A' AND tradeDate = '2026-07-21'
  ORDER BY candleTime
`);
const candles = rows.map(r => ({
  time: r.candleTime, open: Number(r.open), high: Number(r.high), 
  low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
}));

console.log(`285A 7/21: ${candles.length}本のローソク足`);

// ブロック時点を特定
const blockTime = "11:09";
const blockIdx = candles.findIndex(c => c.time >= blockTime);
console.log(`\nブロック時点: ${blockTime} (idx=${blockIdx})`);
console.log(`ブロック足: O=${candles[blockIdx].open} H=${candles[blockIdx].high} L=${candles[blockIdx].low} C=${candles[blockIdx].close}`);

// drop_0.6判定: 直近3本前の始値から現在足終値の下落率
const open3ago = candles[blockIdx - 2].open;
const dropRate = (candles[blockIdx].close - open3ago) / open3ago;
console.log(`\n=== drop_0.6判定 ===`);
console.log(`3本前始値: ${open3ago}`);
console.log(`現在足終値: ${candles[blockIdx].close}`);
console.log(`下落率: ${(dropRate * 100).toFixed(3)}%`);
console.log(`判定: ${dropRate <= -0.006 ? 'バイパス（0.6%以上下落）' : 'CB v2（下落不足）'}`);

// 周辺のローソク足を表示
console.log(`\n=== ブロック前後のローソク足 ===`);
for (let i = Math.max(0, blockIdx - 5); i <= Math.min(candles.length - 1, blockIdx + 5); i++) {
  const c = candles[i];
  const marker = i === blockIdx ? ' ★ブロック' : '';
  console.log(`  ${c.time} O=${c.open} H=${c.high} L=${c.low} C=${c.close}${marker}`);
}

// CB v2 シミュレーション
function simCBv2() {
  const REBOUND_PCT = 0.002;
  const TIMEOUT = 20;
  
  let state = 1;
  let impulseLow = candles[blockIdx].low;
  let swingHigh = candles[blockIdx].high;
  let consecutiveNoNewHigh = 0;
  let prevAboveMA5 = false;
  
  console.log(`\n=== CB v2 シミュレーション ===`);
  console.log(`初期impulseLow: ${impulseLow}`);
  
  for (let i = blockIdx + 1; i < candles.length && (i - blockIdx) <= TIMEOUT; i++) {
    const c = candles[i];
    
    if (state === 1) {
      if (c.low < impulseLow) impulseLow = c.low;
      const rebound = (c.high - impulseLow) / impulseLow;
      if (rebound >= REBOUND_PCT) {
        console.log(`  State1→2: ${c.time} rebound=${(rebound*100).toFixed(3)}% impulseLow=${impulseLow}`);
        state = 2; swingHigh = c.high; consecutiveNoNewHigh = 0;
      }
    } else if (state === 2) {
      if (c.high > swingHigh) { swingHigh = c.high; consecutiveNoNewHigh = 0; }
      else { consecutiveNoNewHigh++; }
      if (consecutiveNoNewHigh >= 2) {
        console.log(`  State2→3: ${c.time} swingHigh=${swingHigh} (2本連続未更新)`);
        state = 3;
        const start = Math.max(0, i - 4);
        const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / (i - start + 1);
        prevAboveMA5 = c.close > ma5;
      }
    } else if (state === 3) {
      const start = Math.max(0, i - 4);
      const ma5 = candles.slice(start, i + 1).reduce((s, x) => s + x.close, 0) / (i - start + 1);
      const currentAbove = c.close > ma5;
      if (prevAboveMA5 && !currentAbove) {
        console.log(`  State3→4: ${c.time} MA5下クロス (close=${c.close} < ma5=${ma5.toFixed(0)})`);
        state = 4;
      }
      prevAboveMA5 = currentAbove;
    } else if (state === 4) {
      if (c.close < impulseLow) {
        console.log(`  State4→Entry: ${c.time} close=${c.close} < impulseLow=${impulseLow}`);
        if (i + 1 >= candles.length) { console.log("  エントリー不可（足なし）"); return null; }
        const entryPrice = candles[i + 1].open;
        const shares = Math.floor(POSITION_SIZE / entryPrice);
        const slPrice = entryPrice * (1 + SL_PCT);
        const tpPrice = entryPrice * (1 - TP_PCT);
        console.log(`  エントリー: ${candles[i+1].time} @${entryPrice} (${shares}株) SL=${slPrice.toFixed(0)} TP=${tpPrice.toFixed(0)}`);
        
        for (let j = i + 1; j < candles.length; j++) {
          const cc = candles[j];
          if (cc.high >= slPrice) {
            const pnl = Math.round((entryPrice - slPrice) * shares);
            console.log(`  → SL: ${cc.time} high=${cc.high} >= ${slPrice.toFixed(0)} PnL=${pnl}円`);
            return { pnl, exitReason: "SL" };
          }
          if (cc.low <= tpPrice) {
            const pnl = Math.round((entryPrice - tpPrice) * shares);
            console.log(`  → TP: ${cc.time} low=${cc.low} <= ${tpPrice.toFixed(0)} PnL=${pnl}円`);
            return { pnl, exitReason: "TP" };
          }
          if (cc.time >= FORCE_EXIT_TIME) {
            const pnl = Math.round((entryPrice - cc.close) * shares);
            console.log(`  → EOD: ${cc.time} close=${cc.close} PnL=${pnl}円`);
            return { pnl, exitReason: "EOD" };
          }
        }
        return null;
      }
    }
  }
  console.log(`  タイムアウト（${TIMEOUT}本以内にエントリー条件未成立）`);
  return null;
}

// バイパスシミュレーション
function simBypass() {
  if (blockIdx + 1 >= candles.length) return null;
  const entryPrice = candles[blockIdx + 1].open;
  const shares = Math.floor(POSITION_SIZE / entryPrice);
  const slPrice = entryPrice * (1 + SL_PCT);
  const tpPrice = entryPrice * (1 - TP_PCT);
  
  console.log(`\n=== バイパスシミュレーション ===`);
  console.log(`エントリー: ${candles[blockIdx+1].time} @${entryPrice} (${shares}株) SL=${slPrice.toFixed(0)} TP=${tpPrice.toFixed(0)}`);
  
  for (let j = blockIdx + 1; j < candles.length; j++) {
    const cc = candles[j];
    if (cc.high >= slPrice) {
      const pnl = Math.round((entryPrice - slPrice) * shares);
      console.log(`  → SL: ${cc.time} high=${cc.high} >= ${slPrice.toFixed(0)} PnL=${pnl}円`);
      return { pnl, exitReason: "SL" };
    }
    if (cc.low <= tpPrice) {
      const pnl = Math.round((entryPrice - tpPrice) * shares);
      console.log(`  → TP: ${cc.time} low=${cc.low} <= ${tpPrice.toFixed(0)} PnL=${pnl}円`);
      return { pnl, exitReason: "TP" };
    }
    if (cc.time >= FORCE_EXIT_TIME) {
      const pnl = Math.round((entryPrice - cc.close) * shares);
      console.log(`  → EOD: ${cc.time} close=${cc.close} PnL=${pnl}円`);
      return { pnl, exitReason: "EOD" };
    }
  }
  return null;
}

// 実行
if (dropRate <= -0.006) {
  console.log("\n【分岐: バイパスエントリー】");
  const result = simBypass();
  if (result) {
    console.log(`\n結果: ${result.exitReason} ${result.pnl}円`);
  } else {
    console.log("\n結果: エントリー不可");
  }
} else {
  console.log("\n【分岐: CB v2】");
  const result = simCBv2();
  if (result) {
    console.log(`\n結果: ${result.exitReason} ${result.pnl}円`);
  } else {
    console.log("\n結果: エントリー条件未成立（取引なし）");
  }
}

// 注意: 285Aは取引除外銘柄かどうか確認
console.log("\n=== 注意 ===");
console.log("285A（キオクシア）はアクティブ取引銘柄です（除外対象ではない）");
console.log("ただし、実際のエンジンではシグナル発生条件（信頼度判定等）が追加されるため、");
console.log("この簡易検出と実際のブロック数は異なる可能性があります。");

await conn.end();
