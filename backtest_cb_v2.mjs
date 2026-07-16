/**
 * Confirm Break v2 バックテスト
 * 
 * 0.8%乖離率でブロックされた73件に対して、
 * v2「戻り終了確認」の各パターンをリアルタイム条件で検証する。
 * 
 * v2-A: 陰線確定 + 安値再割れ
 * v2-B: 5MA再割れ + 安値再割れ  
 * v2-C: 戻り高値未更新 + 陰線 + 安値再割れ
 * v2-D: 戻り高値未更新 + 5MA + 安値再割れ
 * v2-E: 反落率0.20% + 安値再割れ
 * v2-F: 出来高減少 + 安値再割れ
 * v2-G: BPR再悪化 + 安値再割れ
 * v2-H: 厳格版（反発率0.20% + 2本未更新 + 陰線 + 5MA + 終値再割れ）
 */
import mysql from "mysql2/promise";
import fs from "fs";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ============================================================
// 定数
// ============================================================
const SL = 0.005;
const TP = 0.015;
const FORCE_EXIT_TIME = "15:25";
const LUNCH_START = "11:30";
const LUNCH_END = "12:30";
const INITIAL_CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;

// ============================================================
// 1. データ取得
// ============================================================
const [allEntries] = await conn.execute(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, amount, reason, tradeTime, side, boardSignal
  FROM rt_trades WHERE action IN ('buy','short') ORDER BY tradeDate, tradeTime
`);
const [allExits] = await conn.execute(`
  SELECT id, tradeDate, symbol, action, price, shares, pnl, reason, tradeTime, side
  FROM rt_trades WHERE action IN ('sell','cover') ORDER BY tradeDate, tradeTime
`);

// ペアリング
const exitsCopy = [...allExits];
const trades = [];
for (const entry of allEntries) {
  const exit = exitsCopy.find(
    e => e.tradeDate === entry.tradeDate && e.symbol === entry.symbol && e.side === entry.side
      && e.tradeTime >= entry.tradeTime && e.pnl !== null
  );
  if (exit) {
    trades.push({
      id: entry.id, tradeDate: entry.tradeDate, symbol: entry.symbol,
      symbolName: entry.symbolName, action: entry.action,
      entryPrice: parseFloat(entry.price), exitPrice: parseFloat(exit.price),
      shares: entry.shares, pnl: exit.pnl, reason: entry.reason,
      tradeTime: entry.tradeTime, exitTime: exit.tradeTime,
      side: entry.side, boardSignal: entry.boardSignal, exitReason: exit.reason,
    });
    exitsCopy.splice(exitsCopy.indexOf(exit), 1);
  }
}

// 大台シグナル判定
function isRoundSignal(reason) {
  return reason.includes("大台確認") || reason.includes("大台超え") || reason.includes("大台割れ");
}
function getRoundLevel(reason) {
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}
for (const t of trades) {
  t.isRound = isRoundSignal(t.reason);
  t.roundLevel = t.isRound ? getRoundLevel(t.reason) : null;
  t.divergence = t.isRound && t.roundLevel ? Math.abs(t.entryPrice - t.roundLevel) / t.roundLevel : null;
}

const blocked08 = trades.filter(t => t.isRound && t.divergence !== null && t.divergence > 0.008);
const passed08 = trades.filter(t => !t.isRound || t.divergence === null || t.divergence <= 0.008);

console.log(`総トレード: ${trades.length}件`);
console.log(`0.8%ブロック対象: ${blocked08.length}件`);
console.log(`0.8%通過: ${passed08.length}件`);

// ============================================================
// 2. 1分足データをプリロード（全ブロック取引の銘柄・日付）
// ============================================================
const candleCache = {};
const uniquePairs = [...new Set(blocked08.map(t => `${t.symbol}|${t.tradeDate}`))];
for (const pair of uniquePairs) {
  const [sym, date] = pair.split("|");
  const [rows] = await conn.query(
    `SELECT candleTime, open, high, low, close, volume, boardSnapshot
     FROM rt_candles WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime ASC`,
    [sym, date]
  );
  candleCache[pair] = rows.map(r => ({
    candleTime: r.candleTime,
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume),
    bpr: r.boardSnapshot ? (typeof r.boardSnapshot === 'string' ? JSON.parse(r.boardSnapshot) : r.boardSnapshot).buyPressureRatio || null : null,
  }));
}
await conn.end();

// ============================================================
// 3. ヘルパー関数
// ============================================================
function calcMA(candles, upToIdx, period) {
  if (upToIdx < period - 1) return null;
  let sum = 0;
  for (let i = upToIdx - period + 1; i <= upToIdx; i++) sum += candles[i].close;
  return sum / period;
}

function calcVWAP(candles, upToIdx) {
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i <= upToIdx; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumVol += candles[i].volume;
    cumPV += typical * candles[i].volume;
  }
  return cumVol > 0 ? cumPV / cumVol : candles[upToIdx].close;
}

// ============================================================
// 4. Confirm Break v2 ステートマシン
// ============================================================

/**
 * v2 State Machine for a single blocked trade
 * 
 * @param {object} params
 * @param {array} params.candles - 1分足データ
 * @param {number} params.blockIdx - ブロックされた足のインデックス
 * @param {boolean} params.isShort - SHORT方向か
 * @param {number} params.signalPrice - ブロック時のclose
 * @param {number} params.timeout - 最大待機本数
 * @param {object} params.config - v2パターン設定
 * 
 * config: {
 *   reboundPct: 反発率閾値 (0.15~0.40)
 *   reboundMode: "pct" | "candle2" | "high2" (反発確認方法)
 *   highFormation: "noUpdate2" | "noUpdate3" | "cutDown1" | "cutDown2" (戻り高値形成)
 *   endConfirm: "bearish" | "ma3" | "ma5" | "ma8" | "decline" | "none" (戻り終了確認)
 *   bearBodyPct: 陰線実体率閾値 (0 = any bearish)
 *   declinePct: 反落率閾値
 *   breakMode: "lowBreak" | "closeBreak" | "nextLowBreak" (安値再割れ方法)
 *   volumeCheck: boolean (出来高減少チェック)
 *   volumeRatio: 出来高比率閾値
 *   bprCheck: boolean (BPR再悪化チェック)
 *   bprDrop: BPR低下閾値
 * }
 */
function runCBv2(params) {
  const { candles, blockIdx, isShort, signalPrice, timeout, config } = params;
  
  // STATE 0: ブロック判定後の初期値
  let impulseLow = Infinity;  // SHORT: 下落の最安値
  let impulseHigh = -Infinity; // LONG: 上昇の最高値
  let pullbackHigh = -Infinity; // SHORT: 戻り高値
  let pullbackLow = Infinity;  // LONG: 戻り安値
  let state = 1; // 1=反発待ち, 2=戻り高値形成, 3=戻り終了確認, 4=再割れ確認
  let highNoUpdateCount = 0;
  let lowNoUpdateCount = 0;
  let prevHigh = -Infinity;
  let prevLow = Infinity;
  let reboundStartIdx = -1;
  let pullbackHighIdx = -1;
  let pullbackLowIdx = -1;
  let pullbackHighBpr = null;
  let declineVolumes = [];
  let reboundVolumes = [];
  let endConfirmDone = false;
  
  // impulseLow/Highの初期化: ブロック足のlow/high
  if (isShort) {
    impulseLow = candles[blockIdx].low;
  } else {
    impulseHigh = candles[blockIdx].high;
  }
  
  for (let i = blockIdx + 1; i < candles.length && i <= blockIdx + timeout; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    
    // 時間制約
    if (c.candleTime >= FORCE_EXIT_TIME) return { result: "TIMEOUT_EOD", entryIdx: -1 };
    if (c.candleTime >= LUNCH_START && c.candleTime < LUNCH_END) continue; // 昼休み中はスキップ
    
    if (isShort) {
      // === SHORT ===
      switch (state) {
        case 1: { // 反発待ち
          // impulseLow更新
          if (c.low < impulseLow) impulseLow = c.low;
          
          // 反発確認
          let rebounded = false;
          if (config.reboundMode === "pct") {
            const reboundPct = (c.high - impulseLow) / impulseLow;
            rebounded = reboundPct >= config.reboundPct;
          } else if (config.reboundMode === "candle2") {
            // 陽線2本連続
            rebounded = c.close > c.open && prev.close > prev.open;
          } else if (config.reboundMode === "high2") {
            // 高値2本連続更新
            rebounded = c.high > prev.high && (i >= blockIdx + 2 && prev.high > candles[i - 2].high);
          }
          
          if (rebounded) {
            state = 2;
            pullbackHigh = c.high;
            pullbackHighIdx = i;
            reboundStartIdx = i;
            highNoUpdateCount = 0;
            prevHigh = c.high;
            reboundVolumes = [c.volume];
            if (c.bpr !== null) pullbackHighBpr = c.bpr;
          }
          break;
        }
        
        case 2: { // 戻り高値形成中
          reboundVolumes.push(c.volume);
          
          if (c.high > pullbackHigh) {
            pullbackHigh = c.high;
            pullbackHighIdx = i;
            highNoUpdateCount = 0;
            if (c.bpr !== null) pullbackHighBpr = c.bpr;
          } else {
            highNoUpdateCount++;
          }
          
          // 戻り高値形成判定
          let formed = false;
          if (config.highFormation === "noUpdate2") formed = highNoUpdateCount >= 2;
          else if (config.highFormation === "noUpdate3") formed = highNoUpdateCount >= 3;
          else if (config.highFormation === "cutDown1") formed = c.high < prevHigh;
          else if (config.highFormation === "cutDown2") formed = c.high < prevHigh && (i >= 2 && candles[i-1].high < candles[i-2].high);
          
          prevHigh = c.high;
          
          if (formed) {
            state = 3;
            declineVolumes = [];
            endConfirmDone = false;
          }
          break;
        }
        
        case 3: { // 戻り終了確認
          declineVolumes.push(c.volume);
          
          // 戻り高値再更新 → state 2に戻る
          if (c.high > pullbackHigh) {
            pullbackHigh = c.high;
            pullbackHighIdx = i;
            highNoUpdateCount = 0;
            state = 2;
            reboundVolumes.push(c.volume);
            if (c.bpr !== null) pullbackHighBpr = c.bpr;
            break;
          }
          
          // 戻り終了確認条件チェック
          let confirmed = false;
          
          if (config.endConfirm === "bearish") {
            // 陰線確定
            const bodyPct = (c.open - c.close) / c.open;
            confirmed = c.close < c.open && bodyPct >= (config.bearBodyPct || 0);
          } else if (config.endConfirm === "ma3" || config.endConfirm === "ma5" || config.endConfirm === "ma8") {
            // MA再割れ（上から下へクロス）
            const period = config.endConfirm === "ma3" ? 3 : config.endConfirm === "ma5" ? 5 : 8;
            const ma = calcMA(candles, i, period);
            const maPrev = calcMA(candles, i - 1, period);
            if (ma !== null && maPrev !== null) {
              confirmed = prev.close >= maPrev && c.close < ma;
            }
          } else if (config.endConfirm === "decline") {
            // 反落率
            const declinePct = (pullbackHigh - c.close) / pullbackHigh;
            confirmed = declinePct >= (config.declinePct || 0.002);
          } else if (config.endConfirm === "none") {
            confirmed = true; // 戻り高値形成だけで十分
          }
          
          // 出来高チェック（追加条件）
          if (confirmed && config.volumeCheck) {
            const avgReboundVol = reboundVolumes.length > 0 ? reboundVolumes.reduce((s,v)=>s+v,0) / reboundVolumes.length : 1;
            // 下落中の直前5本の出来高（ブロック前）
            let preBlockVols = [];
            for (let j = Math.max(0, blockIdx - 5); j < blockIdx; j++) preBlockVols.push(candles[j].volume);
            const avgPreBlockVol = preBlockVols.length > 0 ? preBlockVols.reduce((s,v)=>s+v,0) / preBlockVols.length : 1;
            const volRatio = avgReboundVol / avgPreBlockVol;
            if (volRatio >= (config.volumeRatio || 0.80)) confirmed = false; // 戻り出来高が多い = 戻りが本物
          }
          
          // BPRチェック（追加条件）
          if (confirmed && config.bprCheck) {
            if (pullbackHighBpr !== null && c.bpr !== null) {
              const bprDrop = pullbackHighBpr - c.bpr;
              if (bprDrop < (config.bprDrop || 0.05)) confirmed = false;
            }
          }
          
          if (confirmed) {
            endConfirmDone = true;
            state = 4;
          }
          break;
        }
        
        case 4: { // 安値再割れ確認
          // 戻り高値再更新 → state 2に戻る
          if (c.high > pullbackHigh) {
            pullbackHigh = c.high;
            pullbackHighIdx = i;
            highNoUpdateCount = 0;
            state = 2;
            reboundVolumes.push(c.volume);
            if (c.bpr !== null) pullbackHighBpr = c.bpr;
            break;
          }
          
          // 安値再割れ判定
          let broke = false;
          if (config.breakMode === "lowBreak") {
            broke = c.low < impulseLow;
          } else if (config.breakMode === "closeBreak") {
            broke = c.close < impulseLow;
          } else if (config.breakMode === "nextLowBreak") {
            // 次足も安値更新（この足で判定足、次足でエントリー）
            // ここでは「前足が安値割れ」を確認
            broke = prev.low < impulseLow && c.low < prev.low;
          }
          
          if (broke) {
            // エントリー: 次足始値（未来データ不使用）
            // 現在足確定後に判定 → 次足始値でエントリー
            const entryIdx = i + 1;
            if (entryIdx < candles.length) {
              return { result: "ENTRY", entryIdx, entryPrice: candles[entryIdx].open, delay: entryIdx - blockIdx };
            } else {
              return { result: "TIMEOUT", entryIdx: -1 };
            }
          }
          break;
        }
      }
      
    } else {
      // === LONG (反転) ===
      switch (state) {
        case 1: { // 反落待ち
          if (c.high > impulseHigh) impulseHigh = c.high;
          
          let rebounded = false;
          if (config.reboundMode === "pct") {
            const reboundPct = (impulseHigh - c.low) / impulseHigh;
            rebounded = reboundPct >= config.reboundPct;
          } else if (config.reboundMode === "candle2") {
            rebounded = c.close < c.open && prev.close < prev.open;
          } else if (config.reboundMode === "high2") {
            rebounded = c.low < prev.low && (i >= blockIdx + 2 && prev.low < candles[i - 2].low);
          }
          
          if (rebounded) {
            state = 2;
            pullbackLow = c.low;
            pullbackLowIdx = i;
            reboundStartIdx = i;
            lowNoUpdateCount = 0;
            prevLow = c.low;
            reboundVolumes = [c.volume];
          }
          break;
        }
        
        case 2: { // 戻り安値形成中
          reboundVolumes.push(c.volume);
          if (c.low < pullbackLow) {
            pullbackLow = c.low;
            pullbackLowIdx = i;
            lowNoUpdateCount = 0;
          } else {
            lowNoUpdateCount++;
          }
          
          let formed = false;
          if (config.highFormation === "noUpdate2") formed = lowNoUpdateCount >= 2;
          else if (config.highFormation === "noUpdate3") formed = lowNoUpdateCount >= 3;
          else if (config.highFormation === "cutDown1") formed = c.low > prevLow;
          else if (config.highFormation === "cutDown2") formed = c.low > prevLow && (i >= 2 && candles[i-1].low > candles[i-2].low);
          
          prevLow = c.low;
          if (formed) { state = 3; declineVolumes = []; endConfirmDone = false; }
          break;
        }
        
        case 3: { // 戻り終了確認
          declineVolumes.push(c.volume);
          if (c.low < pullbackLow) {
            pullbackLow = c.low; pullbackLowIdx = i; lowNoUpdateCount = 0;
            state = 2; reboundVolumes.push(c.volume); break;
          }
          
          let confirmed = false;
          if (config.endConfirm === "bearish") {
            const bodyPct = (c.close - c.open) / c.open;
            confirmed = c.close > c.open && bodyPct >= (config.bearBodyPct || 0);
          } else if (config.endConfirm === "ma3" || config.endConfirm === "ma5" || config.endConfirm === "ma8") {
            const period = config.endConfirm === "ma3" ? 3 : config.endConfirm === "ma5" ? 5 : 8;
            const ma = calcMA(candles, i, period);
            const maPrev = calcMA(candles, i - 1, period);
            if (ma !== null && maPrev !== null) confirmed = prev.close <= maPrev && c.close > ma;
          } else if (config.endConfirm === "decline") {
            const declinePct = (c.close - pullbackLow) / pullbackLow;
            confirmed = declinePct >= (config.declinePct || 0.002);
          } else if (config.endConfirm === "none") {
            confirmed = true;
          }
          
          if (confirmed && config.volumeCheck) {
            const avgReboundVol = reboundVolumes.length > 0 ? reboundVolumes.reduce((s,v)=>s+v,0) / reboundVolumes.length : 1;
            let preBlockVols = [];
            for (let j = Math.max(0, blockIdx - 5); j < blockIdx; j++) preBlockVols.push(candles[j].volume);
            const avgPreBlockVol = preBlockVols.length > 0 ? preBlockVols.reduce((s,v)=>s+v,0) / preBlockVols.length : 1;
            if (avgReboundVol / avgPreBlockVol >= (config.volumeRatio || 0.80)) confirmed = false;
          }
          
          if (confirmed) { endConfirmDone = true; state = 4; }
          break;
        }
        
        case 4: { // 高値再突破確認
          if (c.low < pullbackLow) {
            pullbackLow = c.low; pullbackLowIdx = i; lowNoUpdateCount = 0;
            state = 2; reboundVolumes.push(c.volume); break;
          }
          
          let broke = false;
          if (config.breakMode === "lowBreak") broke = c.high > impulseHigh;
          else if (config.breakMode === "closeBreak") broke = c.close > impulseHigh;
          else if (config.breakMode === "nextLowBreak") broke = prev.high > impulseHigh && c.high > prev.high;
          
          if (broke) {
            const entryIdx = i + 1;
            if (entryIdx < candles.length) {
              return { result: "ENTRY", entryIdx, entryPrice: candles[entryIdx].open, delay: entryIdx - blockIdx };
            } else {
              return { result: "TIMEOUT", entryIdx: -1 };
            }
          }
          break;
        }
      }
    }
  }
  
  return { result: "TIMEOUT", entryIdx: -1 };
}

// ============================================================
// 5. TP/SL/EODシミュレーション
// ============================================================
function simulateExit(candles, entryIdx, entryPrice, isShort) {
  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    
    if (isShort) {
      const slPrice = entryPrice * (1 + SL);
      const tpPrice = entryPrice * (1 - TP);
      if (c.high >= slPrice) return { exitPrice: slPrice, exitTime: c.candleTime, exitReason: "SL", holdBars: i - entryIdx };
      if (c.low <= tpPrice) return { exitPrice: tpPrice, exitTime: c.candleTime, exitReason: "TP", holdBars: i - entryIdx };
    } else {
      const slPrice = entryPrice * (1 - SL);
      const tpPrice = entryPrice * (1 + TP);
      if (c.low <= slPrice) return { exitPrice: slPrice, exitTime: c.candleTime, exitReason: "SL", holdBars: i - entryIdx };
      if (c.high >= tpPrice) return { exitPrice: tpPrice, exitTime: c.candleTime, exitReason: "TP", holdBars: i - entryIdx };
    }
    
    if (c.candleTime >= "15:25") {
      return { exitPrice: c.close, exitTime: c.candleTime, exitReason: "EOD", holdBars: i - entryIdx };
    }
  }
  const last = candles[candles.length - 1];
  return { exitPrice: last.close, exitTime: last.candleTime, exitReason: "EOD", holdBars: candles.length - 1 - entryIdx };
}

// ============================================================
// 6. 全パターン定義
// ============================================================
const patterns = {
  "v2-A_bear0.10_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0.001, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-A_bear0.15_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0.0015, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-A_bear0.20_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0.002, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-A_bear0_close": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0, breakMode: "closeBreak", volumeCheck: false, bprCheck: false },
  
  "v2-B_ma3": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "ma3", breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-B_ma5": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "ma5", breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-B_ma8": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "ma8", breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  
  "v2-C_noUp2_bear_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-C_noUp3_bear_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate3", endConfirm: "bearish", bearBodyPct: 0, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-C_cutDown1_bear_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "cutDown1", endConfirm: "bearish", bearBodyPct: 0, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  
  "v2-D_noUp2_ma5_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "ma5", breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-D_noUp3_ma5_low": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate3", endConfirm: "ma5", breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-D_noUp2_ma5_close": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "ma5", breakMode: "closeBreak", volumeCheck: false, bprCheck: false },
  
  "v2-E_decline0.15": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "decline", declinePct: 0.0015, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-E_decline0.20": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "decline", declinePct: 0.002, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-E_decline0.25": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "decline", declinePct: 0.0025, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  "v2-E_decline0.30": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "decline", declinePct: 0.003, breakMode: "lowBreak", volumeCheck: false, bprCheck: false },
  
  "v2-F_vol0.50": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "none", breakMode: "lowBreak", volumeCheck: true, volumeRatio: 0.50, bprCheck: false },
  "v2-F_vol0.70": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "none", breakMode: "lowBreak", volumeCheck: true, volumeRatio: 0.70, bprCheck: false },
  "v2-F_vol0.80": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "none", breakMode: "lowBreak", volumeCheck: true, volumeRatio: 0.80, bprCheck: false },
  
  "v2-G_bpr0.03": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0, breakMode: "lowBreak", volumeCheck: false, bprCheck: true, bprDrop: 0.03 },
  "v2-G_bpr0.05": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "bearish", bearBodyPct: 0, breakMode: "lowBreak", volumeCheck: false, bprCheck: true, bprDrop: 0.05 },
  
  "v2-H_strict": { reboundPct: 0.002, reboundMode: "pct", highFormation: "noUpdate2", endConfirm: "ma5", bearBodyPct: 0, breakMode: "closeBreak", volumeCheck: false, bprCheck: false },
};

// 反発率スイープ
const reboundSweep = [0.0015, 0.002, 0.0025, 0.003, 0.004];
// タイムアウトスイープ
const timeoutSweep = [5, 10, 15, 20, 30];

// ============================================================
// 7. メイン実行
// ============================================================
const allResults = {};

// まず固定タイムアウト20本で全パターン実行
const DEFAULT_TIMEOUT = 20;

for (const [name, config] of Object.entries(patterns)) {
  const results = [];
  
  for (const blockedTrade of blocked08) {
    const { symbol, tradeDate, tradeTime, side, action } = blockedTrade;
    const candles = candleCache[`${symbol}|${tradeDate}`];
    if (!candles || candles.length < 5) {
      results.push({ ...blockedTrade, cbResult: "NO_DATA", cbPnl: null, cbDelay: null, cbHoldBars: null, cbExitReason: null, cbEntryTime: null });
      continue;
    }
    
    const blockIdx = candles.findIndex(c => c.candleTime >= tradeTime);
    if (blockIdx < 0 || candles.length - blockIdx < 3) {
      results.push({ ...blockedTrade, cbResult: "NO_DATA", cbPnl: null, cbDelay: null, cbHoldBars: null, cbExitReason: null, cbEntryTime: null });
      continue;
    }
    
    const signalPrice = candles[blockIdx].close;
    const isShort = side === "short" || action === "short";
    
    const cbResult = runCBv2({ candles, blockIdx, isShort, signalPrice, timeout: DEFAULT_TIMEOUT, config });
    
    if (cbResult.result === "ENTRY") {
      const exit = simulateExit(candles, cbResult.entryIdx, cbResult.entryPrice, isShort);
      const shares = Math.floor((INITIAL_CAPITAL * LOT_RATIO) / cbResult.entryPrice);
      const pnl = isShort
        ? Math.round((cbResult.entryPrice - exit.exitPrice) * shares)
        : Math.round((exit.exitPrice - cbResult.entryPrice) * shares);
      
      results.push({
        ...blockedTrade,
        cbResult: "ENTRY",
        cbEntryPrice: cbResult.entryPrice,
        cbEntryTime: candles[cbResult.entryIdx].candleTime,
        cbPnl: pnl,
        cbExitReason: exit.exitReason,
        cbHoldBars: exit.holdBars,
        cbDelay: cbResult.delay,
      });
    } else {
      results.push({
        ...blockedTrade,
        cbResult: cbResult.result,
        cbPnl: null, cbDelay: null, cbHoldBars: null, cbExitReason: null, cbEntryTime: null,
      });
    }
  }
  
  allResults[name] = results;
}

// ============================================================
// 8. 統計計算ヘルパー
// ============================================================
function calcFullStats(cbResults, label) {
  const entries = cbResults.filter(r => r.cbResult === "ENTRY");
  if (entries.length === 0) return { label, count: 0, pnl: 0, pf: "0.00", maxDD: 0, expectation: 0, winRate: "0.0", tp: 0, sl: 0, eod: 0, avgHold: 0, avgDelay: 0, maxConsecLoss: 0 };
  
  const pnls = entries.map(r => r.cbPnl);
  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v <= 0);
  const total = pnls.reduce((s, v) => s + v, 0);
  const grossProfit = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "0.00";
  
  let peak = 0, maxDD = 0, cum = 0;
  for (const v of pnls) { cum += v; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }
  
  let maxConsecLoss = 0, consecLoss = 0;
  for (const v of pnls) { if (v <= 0) { consecLoss++; if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss; } else consecLoss = 0; }
  
  const tp = entries.filter(r => r.cbExitReason === "TP").length;
  const sl = entries.filter(r => r.cbExitReason === "SL").length;
  const eod = entries.filter(r => r.cbExitReason === "EOD").length;
  const avgHold = Math.round(entries.reduce((s, r) => s + (r.cbHoldBars || 0), 0) / entries.length);
  const avgDelay = Math.round(entries.reduce((s, r) => s + (r.cbDelay || 0), 0) / entries.length);
  
  return {
    label, count: entries.length, pnl: total, pf, maxDD, expectation: Math.round(total / entries.length),
    winRate: (wins.length / entries.length * 100).toFixed(1), tp, sl, eod, avgHold, avgDelay, maxConsecLoss,
    avgProfit: wins.length > 0 ? Math.round(grossProfit / wins.length) : 0,
    avgLoss: losses.length > 0 ? Math.round(grossLoss / losses.length) : 0,
  };
}

// ============================================================
// 9. 出力
// ============================================================
let output = "";
function log(s) { output += s + "\n"; console.log(s); }

log("=" .repeat(80));
log("  Confirm Break v2 バックテスト結果");
log("=" .repeat(80));
log(`\n対象: ${blocked08.length}件のブロック取引`);
log(`  SHORT: ${blocked08.filter(t => t.side === "short" || t.action === "short").length}件`);
log(`  LONG: ${blocked08.filter(t => t.side !== "short" && t.action !== "short").length}件`);

// --- 全パターン比較表 ---
log("\n" + "=" .repeat(80));
log("  全パターン比較表 (タイムアウト20本)");
log("=" .repeat(80));
log("\nパターン | 成立 | 総損益 | PF | 期待値 | 勝率 | TP | SL | EOD | 平均遅延 | 最大連敗");
log("-".repeat(110));

const patternStats = {};
for (const [name, results] of Object.entries(allResults)) {
  const stats = calcFullStats(results, name);
  patternStats[name] = stats;
  log(`${name} | ${stats.count}件 | ${stats.pnl} | ${stats.pf} | ${stats.expectation} | ${stats.winRate}% | ${stats.tp} | ${stats.sl} | ${stats.eod} | ${stats.avgDelay}本 | ${stats.maxConsecLoss}`);
}

// --- 4方式比較 ---
// Baseline
const blTotal = trades.reduce((s, t) => s + t.pnl, 0);
const blWins = trades.filter(t => t.pnl > 0);
const blLosses = trades.filter(t => t.pnl <= 0);
const blPF = Math.abs(blLosses.reduce((s,t)=>s+t.pnl,0)) > 0 ? (blWins.reduce((s,t)=>s+t.pnl,0) / Math.abs(blLosses.reduce((s,t)=>s+t.pnl,0))).toFixed(2) : "∞";
let blPeak = 0, blMaxDD = 0, blCum = 0;
for (const t of trades) { blCum += t.pnl; if (blCum > blPeak) blPeak = blCum; const dd = blPeak - blCum; if (dd > blMaxDD) blMaxDD = dd; }

// 0.8%ブロック
const b08Total = passed08.reduce((s, t) => s + t.pnl, 0);
const b08Wins = passed08.filter(t => t.pnl > 0);
const b08Losses = passed08.filter(t => t.pnl <= 0);
const b08PF = Math.abs(b08Losses.reduce((s,t)=>s+t.pnl,0)) > 0 ? (b08Wins.reduce((s,t)=>s+t.pnl,0) / Math.abs(b08Losses.reduce((s,t)=>s+t.pnl,0))).toFixed(2) : "∞";
let b08Peak = 0, b08MaxDD = 0, b08Cum = 0;
for (const t of passed08) { b08Cum += t.pnl; if (b08Cum > b08Peak) b08Peak = b08Cum; const dd = b08Peak - b08Cum; if (dd > b08MaxDD) b08MaxDD = dd; }

// v1参考値
const v1Total = 507774;
const v1PF = "1.31";
const v1MaxDD = 196549;

// 最良v2を特定
const bestV2Name = Object.entries(patternStats)
  .filter(([_, s]) => s.count >= 10 && parseFloat(s.pf) >= 1.0)
  .sort((a, b) => b[1].pnl - a[1].pnl)[0]?.[0] || Object.keys(patternStats)[0];
const bestV2Stats = patternStats[bestV2Name];
const bestV2Combined = b08Total + bestV2Stats.pnl;

// 4方式比較
log("\n" + "=" .repeat(80));
log("  4方式比較");
log("=" .repeat(80));
log("\n| 指標 | Baseline | 0.8%単独 | CB v1 | CB v2最良 |");
log("|------|----------|----------|-------|-----------|");
log(`| 総損益 | ${blTotal} | ${b08Total} | ${v1Total} | ${bestV2Combined} |`);
log(`| PF | ${blPF} | ${b08PF} | ${v1PF} | - |`);
log(`| 最大DD | ${blMaxDD} | ${b08MaxDD} | ${v1MaxDD} | - |`);
log(`| 期待値 | ${Math.round(blTotal/trades.length)} | ${Math.round(b08Total/passed08.length)} | 2715 | ${bestV2Stats.expectation} (CB部分) |`);
log(`| 取引数 | ${trades.length} | ${passed08.length} | 187 | ${passed08.length + bestV2Stats.count} |`);
log(`| 最良v2パターン | - | - | - | ${bestV2Name} |`);
log(`| CB部分PF | - | - | 1.26 | ${bestV2Stats.pf} |`);
log(`| CB部分勝率 | - | - | 30.4% | ${bestV2Stats.winRate}% |`);
log(`| CB部分SL比率 | - | - | 69.6% | ${(bestV2Stats.sl / bestV2Stats.count * 100).toFixed(1)}% |`);

// --- 7/7 と 7/16 ---
log("\n" + "=" .repeat(80));
log("  7/7 と 7/16 の詳細");
log("=" .repeat(80));

const bl77 = trades.filter(t => t.tradeDate === "2026-07-07").reduce((s, t) => s + t.pnl, 0);
const bl716 = trades.filter(t => t.tradeDate === "2026-07-16").reduce((s, t) => s + t.pnl, 0);
const b08_77 = passed08.filter(t => t.tradeDate === "2026-07-07").reduce((s, t) => s + t.pnl, 0);
const b08_716 = passed08.filter(t => t.tradeDate === "2026-07-16").reduce((s, t) => s + t.pnl, 0);

log("\n日付 | Baseline | 0.8%単独 | CB v1 | 各v2パターン");
log("-".repeat(100));

for (const [name, results] of Object.entries(allResults)) {
  const cb77 = results.filter(r => r.tradeDate === "2026-07-07" && r.cbResult === "ENTRY").reduce((s, r) => s + r.cbPnl, 0);
  const cb716 = results.filter(r => r.tradeDate === "2026-07-16" && r.cbResult === "ENTRY").reduce((s, r) => s + r.cbPnl, 0);
  if (name === Object.keys(allResults)[0]) {
    log(`7/7 | ${bl77} | ${b08_77} | -36427 | ${name}: ${b08_77 + cb77}`);
    log(`7/16 | ${bl716} | ${b08_716} | -52860 | ${name}: ${b08_716 + cb716}`);
  } else {
    log(`  ${name} | 7/7: ${b08_77 + cb77} | 7/16: ${b08_716 + cb716}`);
  }
}

// --- 銘柄別分析 ---
log("\n" + "=" .repeat(80));
log("  銘柄別分析 (最良v2: " + bestV2Name + ")");
log("=" .repeat(80));

const bestResults = allResults[bestV2Name];
const symbols = [...new Set(blocked08.map(t => t.symbol))].sort();
log("\n銘柄 | CB成立 | 勝率 | 総損益 | PF | 平均遅延 | TP | SL");
log("-".repeat(90));

for (const sym of symbols) {
  const symResults = bestResults.filter(r => r.symbol === sym && r.cbResult === "ENTRY");
  if (symResults.length === 0) { log(`${sym} | 0件 | - | - | - | - | - | -`); continue; }
  const symPnls = symResults.map(r => r.cbPnl);
  const symWins = symPnls.filter(v => v > 0);
  const symTotal = symPnls.reduce((s, v) => s + v, 0);
  const symGP = symWins.reduce((s, v) => s + v, 0);
  const symGL = Math.abs(symPnls.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const symPF = symGL > 0 ? (symGP / symGL).toFixed(2) : symGP > 0 ? "∞" : "0.00";
  const avgDelay = Math.round(symResults.reduce((s, r) => s + r.cbDelay, 0) / symResults.length);
  const tp = symResults.filter(r => r.cbExitReason === "TP").length;
  const sl = symResults.filter(r => r.cbExitReason === "SL").length;
  log(`${sym} | ${symResults.length}件 | ${(symWins.length/symResults.length*100).toFixed(0)}% | ${symTotal} | ${symPF} | ${avgDelay}本 | ${tp} | ${sl}`);
}

// --- 遅延別分析 ---
log("\n" + "=" .repeat(80));
log("  遅延別分析 (最良v2: " + bestV2Name + ")");
log("=" .repeat(80));

const delayBands = [[3,3],[4,5],[6,10],[11,15],[16,20],[21,99]];
log("\n遅延帯 | 件数 | 勝率 | 総損益 | PF | 期待値 | TP | SL");
log("-".repeat(90));

for (const [lo, hi] of delayBands) {
  const band = bestResults.filter(r => r.cbResult === "ENTRY" && r.cbDelay >= lo && r.cbDelay <= hi);
  if (band.length === 0) { log(`${lo}-${hi}本 | 0件 | - | - | - | - | - | -`); continue; }
  const pnls = band.map(r => r.cbPnl);
  const wins = pnls.filter(v => v > 0);
  const total = pnls.reduce((s, v) => s + v, 0);
  const gp = wins.reduce((s, v) => s + v, 0);
  const gl = Math.abs(pnls.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const pf = gl > 0 ? (gp / gl).toFixed(2) : gp > 0 ? "∞" : "0.00";
  log(`${lo}-${hi}本 | ${band.length}件 | ${(wins.length/band.length*100).toFixed(0)}% | ${total} | ${pf} | ${Math.round(total/band.length)} | ${band.filter(r=>r.cbExitReason==="TP").length} | ${band.filter(r=>r.cbExitReason==="SL").length}`);
}

// --- 時間帯別分析 ---
log("\n" + "=" .repeat(80));
log("  時間帯別分析 (最良v2: " + bestV2Name + ")");
log("=" .repeat(80));

const timeSlots = ["09:00-09:30","09:30-10:00","10:00-10:30","10:30-11:00","11:00-11:30","12:30-13:00","13:00-13:30","13:30-14:00","14:00-14:30","14:30-15:00","15:00-15:25"];
log("\n時間帯 | 件数 | 勝率 | 総損益 | PF");
log("-".repeat(60));

for (const slot of timeSlots) {
  const [start, end] = slot.split("-");
  const slotResults = bestResults.filter(r => r.cbResult === "ENTRY" && r.cbEntryTime >= start && r.cbEntryTime < end);
  if (slotResults.length === 0) { log(`${slot} | 0件 | - | - | -`); continue; }
  const pnls = slotResults.map(r => r.cbPnl);
  const wins = pnls.filter(v => v > 0);
  const total = pnls.reduce((s, v) => s + v, 0);
  const gp = wins.reduce((s, v) => s + v, 0);
  const gl = Math.abs(pnls.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const pf = gl > 0 ? (gp / gl).toFixed(2) : gp > 0 ? "∞" : "0.00";
  log(`${slot} | ${slotResults.length}件 | ${(wins.length/slotResults.length*100).toFixed(0)}% | ${total} | ${pf}`);
}

// --- SHORT/LONG分離 ---
log("\n" + "=" .repeat(80));
log("  SHORT/LONG分離 (最良v2: " + bestV2Name + ")");
log("=" .repeat(80));

const shortResults = bestResults.filter(r => (r.side === "short" || r.action === "short") && r.cbResult === "ENTRY");
const longResults = bestResults.filter(r => r.side !== "short" && r.action !== "short" && r.cbResult === "ENTRY");

const shortStats = calcFullStats(shortResults.map(r => ({ ...r })), "SHORT");
const longStats = calcFullStats(longResults.map(r => ({ ...r })), "LONG");

log(`\nSHORT: ${shortStats.count}件 | 総損益: ${shortStats.pnl} | PF: ${shortStats.pf} | 勝率: ${shortStats.winRate}%`);
log(`LONG: ${longStats.count}件 | 総損益: ${longStats.pnl} | PF: ${longStats.pf} | 勝率: ${longStats.winRate}%`);

// --- 相場環境別 ---
log("\n" + "=" .repeat(80));
log("  相場環境別分析");
log("=" .repeat(80));

// 各日の始値と終値から環境分類
const allDates = [...new Set(trades.map(t => t.tradeDate))].sort();
const dayEnv = {};
for (const d of allDates) {
  const dayTrades = trades.filter(t => t.tradeDate === d);
  const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
  const shorts = dayTrades.filter(t => t.side === "short" || t.action === "short");
  const longs = dayTrades.filter(t => t.side !== "short" && t.action !== "short");
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  
  // 簡易分類
  if (shortPnl > 50000 && longPnl < -20000) dayEnv[d] = "終日下落";
  else if (shortPnl < -50000 && longPnl > 20000) dayEnv[d] = "終日上昇";
  else if (dayPnl < -80000) dayEnv[d] = "急落後反発";
  else if (dayPnl > 80000) dayEnv[d] = "強トレンド";
  else dayEnv[d] = "レンジ";
}

// 7/7と7/16を強制分類
dayEnv["2026-07-07"] = "終日下落";
dayEnv["2026-07-16"] = "急落後反発";

const envTypes = [...new Set(Object.values(dayEnv))];
log("\n環境 | 日数 | v1損益 | v2損益 | 差額 | 件数 | PF");
log("-".repeat(80));

for (const env of envTypes) {
  const envDates = Object.entries(dayEnv).filter(([_, e]) => e === env).map(([d]) => d);
  const v2Entries = bestResults.filter(r => envDates.includes(r.tradeDate) && r.cbResult === "ENTRY");
  const v2Pnl = v2Entries.reduce((s, r) => s + r.cbPnl, 0);
  const v2Wins = v2Entries.filter(r => r.cbPnl > 0);
  const gp = v2Wins.reduce((s, r) => s + r.cbPnl, 0);
  const gl = Math.abs(v2Entries.filter(r => r.cbPnl <= 0).reduce((s, r) => s + r.cbPnl, 0));
  const pf = gl > 0 ? (gp / gl).toFixed(2) : gp > 0 ? "∞" : "0.00";
  log(`${env} | ${envDates.length}日 | - | ${v2Pnl} | - | ${v2Entries.length}件 | ${pf}`);
}

// --- 採用基準チェック ---
log("\n" + "=" .repeat(80));
log("  採用基準チェック (最良v2: " + bestV2Name + ")");
log("=" .repeat(80));

const best77 = bestResults.filter(r => r.tradeDate === "2026-07-07" && r.cbResult === "ENTRY").reduce((s, r) => s + r.cbPnl, 0);
const best716 = bestResults.filter(r => r.tradeDate === "2026-07-16" && r.cbResult === "ENTRY").reduce((s, r) => s + r.cbPnl, 0);

log(`\n総損益 > 0.8%単独: ${bestV2Combined} > ${b08Total} → ${bestV2Combined > b08Total ? "✓" : "✗"}`);
log(`PF >= 0.8%単独: ${bestV2Stats.pf} >= ${b08PF} → ${parseFloat(bestV2Stats.pf) >= parseFloat(b08PF) ? "✓" : "✗"}`);
log(`最大DD <= 0.8%単独: 要計算`);
log(`期待値 > 0: ${bestV2Stats.expectation} → ${bestV2Stats.expectation > 0 ? "✓" : "✗"}`);
log(`CB部分PF >= 1.30: ${bestV2Stats.pf} → ${parseFloat(bestV2Stats.pf) >= 1.30 ? "✓" : "✗"}`);
log(`CB部分勝率 >= 35%: ${bestV2Stats.winRate}% → ${parseFloat(bestV2Stats.winRate) >= 35 ? "✓" : "✗"}`);
log(`CB部分SL比率 <= 60%: ${(bestV2Stats.sl/bestV2Stats.count*100).toFixed(1)}% → ${bestV2Stats.sl/bestV2Stats.count <= 0.60 ? "✓" : "✗"}`);
log(`7/16損益がCB v1より改善: ${b08_716 + best716} vs -52860 → ${(b08_716 + best716) > -52860 ? "✓" : "✗"}`);
log(`7/7損益がCB v1より改善: ${b08_77 + best77} vs -36427 → ${(b08_77 + best77) > -36427 ? "✓" : "✗"}`);

// --- 過学習チェック ---
log("\n" + "=" .repeat(80));
log("  過学習チェック");
log("=" .repeat(80));

// 最良パターンから1条件外した隣接パターン
const bestConfig = patterns[bestV2Name];
log(`\n最良パターン: ${bestV2Name}`);
log(`  設定: rebound=${bestConfig.reboundPct}, formation=${bestConfig.highFormation}, confirm=${bestConfig.endConfirm}, break=${bestConfig.breakMode}`);

// 銘柄依存チェック
const bestEntries = bestResults.filter(r => r.cbResult === "ENTRY");
const symPnls = {};
for (const r of bestEntries) {
  if (!symPnls[r.symbol]) symPnls[r.symbol] = 0;
  symPnls[r.symbol] += r.cbPnl;
}
const totalCBPnl = bestEntries.reduce((s, r) => s + r.cbPnl, 0);
const maxSymPnl = Math.max(...Object.values(symPnls));
const maxSymName = Object.entries(symPnls).find(([_, v]) => v === maxSymPnl)?.[0];
log(`\n銘柄依存: ${maxSymName}が${totalCBPnl > 0 ? (maxSymPnl/totalCBPnl*100).toFixed(1) : "N/A"}%`);
log(`  → ${totalCBPnl > 0 && maxSymPnl/totalCBPnl > 0.5 ? "⚠️ 50%超: 銘柄依存あり" : "✓ 50%以下"}`);

// 日依存チェック
const dayPnls = {};
for (const r of bestEntries) {
  if (!dayPnls[r.tradeDate]) dayPnls[r.tradeDate] = 0;
  dayPnls[r.tradeDate] += r.cbPnl;
}
const maxDayPnl = Math.max(...Object.values(dayPnls));
const maxDayName = Object.entries(dayPnls).find(([_, v]) => v === maxDayPnl)?.[0];
log(`日依存: ${maxDayName}が${totalCBPnl > 0 ? (maxDayPnl/totalCBPnl*100).toFixed(1) : "N/A"}%`);
log(`  → ${totalCBPnl > 0 && maxDayPnl/totalCBPnl > 0.5 ? "⚠️ 50%超: 日依存あり" : "✓ 50%以下"}`);

// --- 日別損益比較 ---
log("\n" + "=" .repeat(80));
log("  日別損益 (最良v2)");
log("=" .repeat(80));
log("\n日付 | BL | 0.8% | v2CB | 0.8%+v2");
log("-".repeat(70));

let combWin = 0, combLoss = 0;
for (const d of allDates) {
  const blDay = trades.filter(t => t.tradeDate === d).reduce((s, t) => s + t.pnl, 0);
  const b08Day = passed08.filter(t => t.tradeDate === d).reduce((s, t) => s + t.pnl, 0);
  const cbDay = bestResults.filter(r => r.tradeDate === d && r.cbResult === "ENTRY").reduce((s, r) => s + r.cbPnl, 0);
  const combDay = b08Day + cbDay;
  if (combDay > 0) combWin++; else if (combDay < 0) combLoss++;
  log(`${d} | ${blDay} | ${b08Day} | ${cbDay || 0} | ${combDay}`);
}
log(`\n日別勝率(0.8%+v2): ${combWin}勝${combLoss}敗 (${(combWin/(combWin+combLoss)*100).toFixed(1)}%)`);

// 保存
fs.writeFileSync("/home/ubuntu/backtest/results_cb_v2.txt", output);
log("\n完了: /home/ubuntu/backtest/results_cb_v2.txt");
