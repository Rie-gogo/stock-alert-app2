/**
 * 急落時Confirm Breakバイパス分岐ロジック バックテスト
 * 
 * 検証対象:
 * - 0.8%ブロックされたSHORTケースに対して
 * - 急落判定成立 → 即時エントリー（バイパス）
 * - 急落判定不成立 → Confirm Break v2（v2-D_noUp2_ma5_close = v2-H_strict）
 * 
 * 期間: 2026-06-17 ～ 2026-07-16
 * 方向: SHORTのみ
 */
import mysql from "mysql2/promise";
import fs from "fs";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ============================================================
// 定数
// ============================================================
const SL_PCT = 0.005;       // 0.5%
const TP_PCT = 0.015;       // 1.5%
const POSITION_SIZE = 3_000_000;
const CB_TIMEOUT = 20;      // CB v2タイムアウト: 20本
const FORCE_EXIT_TIME = "15:25";
const REBOUND_PCT = 0.002;  // 反発確認: 0.2%

// ============================================================
// 1. データ取得
// ============================================================
console.log("データ取得中...");

// rt_tradesからエントリー・決済ペアを取得
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

// 0.8%ブロック対象のSHORTのみ
const blocked08Short = trades.filter(t => 
  t.isRound && t.divergence !== null && t.divergence > 0.008 && t.side === "short"
);
const passed08 = trades.filter(t => !t.isRound || t.divergence === null || t.divergence <= 0.008);

console.log(`総トレード: ${trades.length}件`);
console.log(`0.8%ブロック対象SHORT: ${blocked08Short.length}件`);
console.log(`0.8%通過: ${passed08.length}件`);

// ============================================================
// 2. 1分足データ + boardSnapshotをプリロード
// ============================================================
console.log("1分足データ読み込み中...");
const candleCache = {};
const uniquePairs = [...new Set(blocked08Short.map(t => `${t.symbol}|${t.tradeDate}`))];
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
    boardSnapshot: r.boardSnapshot ? (typeof r.boardSnapshot === 'string' ? JSON.parse(r.boardSnapshot) : r.boardSnapshot) : null,
  }));
}
await conn.end();
console.log(`キャッシュ: ${Object.keys(candleCache).length}ペア`);

// ============================================================
// 3. ヘルパー関数
// ============================================================

function calcMA(candles, upToIdx, period) {
  if (upToIdx < period - 1) return null;
  let sum = 0;
  for (let i = upToIdx - period + 1; i <= upToIdx; i++) sum += candles[i].close;
  return sum / period;
}

function calcATR7(candles, upToIdx) {
  if (upToIdx < 7) return null;
  let sum = 0;
  for (let i = upToIdx - 6; i <= upToIdx; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
    sum += tr;
  }
  return sum / 7;
}

function calcAvgVolume20(candles, upToIdx) {
  if (upToIdx < 20) return null;
  let sum = 0;
  for (let i = upToIdx - 19; i <= upToIdx; i++) {
    sum += candles[i].volume;
  }
  return sum / 20;
}

/**
 * boardReadingScore計算（簡易版 - DB保存データから再計算）
 * SHORT方向に有利なスコアを返す（正の値 = SHORT有利）
 */
function calcBoardReadingScoreShort(snapshot) {
  if (!snapshot) return 0;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;

  // 要素A: アグレッシブ注文検出 (±2)
  if (snapshot.marketOrderRatio >= 0.08) {
    if (bpr < 1.0) score += 2;
    else if (bpr > 1.0) score -= 2;
  }

  // 要素B: 厚い板のアノマリー (±1)
  if (snapshot.largeBuyWall) score += 1;
  if (snapshot.largeSellWall) score -= 1;

  // 要素D: 相場モード判定 (+1/-2) - 簡易版
  // trap/quiet判定はBPR履歴が必要なので、cancelDetectedのみ使用
  if (snapshot.askCancelDetected || snapshot.bidCancelDetected) {
    score -= 2; // trap
  } else if (snapshot.marketOrderRatio >= 0.05) {
    score += 1; // active
  }

  // 要素E: 板圧力の強さ (±1)
  if (bpr <= 0.65) score += 1;
  else if (bpr >= 1.4) score -= 1;

  // 要素F: 歩み値方向推定 (±2) - largeTradeDirection使用
  if (snapshot.largeTradeDirection === "sell") score += 2;
  else if (snapshot.largeTradeDirection === "buy") score -= 2;

  // 要素G: アイスバーグ検出 (±1)
  if (snapshot.icebergAskDetected) score += 1;  // sell iceberg = SHORT有利
  if (snapshot.icebergBidDetected) score -= 1;

  // 要素H: 10秒集約アイスバーグ強化 (±2)
  if ((snapshot.icebergAskCount ?? 0) >= 2) score += 2;
  if ((snapshot.icebergBidCount ?? 0) >= 2) score -= 2;

  // 要素I: 大口約定方向 (±1)
  if (snapshot.largeTradeDirection === "sell") score += 1;
  else if (snapshot.largeTradeDirection === "buy") score -= 1;

  return score;
}

/**
 * 急落判定指標を計算
 */
function calcCrashIndicators(candles, idx) {
  if (idx < 20) return null; // 最低20本必要

  // A. 直近3本下落率: 3本前の始値から現在足終値までの下落率
  const open3ago = candles[idx - 2].open; // 3本前の始値
  const dropRate3 = (candles[idx].close - open3ago) / open3ago;

  // B. ATR倍率: 直近3本の下落幅 ÷ ATR7
  const drop3abs = Math.abs(candles[idx].close - open3ago);
  const atr7 = calcATR7(candles, idx);
  const atrRatio = atr7 ? drop3abs / atr7 : 0;

  // C. 連続陰線数: 直近3本のうち陰線の本数
  let bearCount = 0;
  for (let i = idx - 2; i <= idx; i++) {
    if (candles[i].close < candles[i].open) bearCount++;
  }

  // D. 出来高倍率: 現在足出来高 ÷ 直近20本平均出来高
  const avgVol20 = calcAvgVolume20(candles, idx);
  const volRatio = avgVol20 ? candles[idx].volume / avgVol20 : 0;

  // E. 板読みスコア
  const boardScore = calcBoardReadingScoreShort(candles[idx].boardSnapshot);

  return { dropRate3, atrRatio, bearCount, volRatio, boardScore, drop3abs };
}

/**
 * 急落判定: 各条件をチェック
 */
function checkCrashCondition(indicators, conditionName) {
  if (!indicators) return false;
  const { dropRate3, atrRatio, bearCount, volRatio, boardScore, drop3abs } = indicators;

  // 検証1: 単独条件
  switch (conditionName) {
    case "drop_0.4": return dropRate3 <= -0.004;
    case "drop_0.6": return dropRate3 <= -0.006;
    case "drop_0.8": return dropRate3 <= -0.008;
    case "drop_1.0": return dropRate3 <= -0.010;
    case "drop_1.2": return dropRate3 <= -0.012;
    case "atr_1.0": return atrRatio >= 1.0;
    case "atr_1.25": return atrRatio >= 1.25;
    case "atr_1.5": return atrRatio >= 1.5;
    case "atr_1.75": return atrRatio >= 1.75;
    case "atr_2.0": return atrRatio >= 2.0;
    case "bear_2of3": return bearCount >= 2;
    case "bear_3of3": return bearCount >= 3;
    case "vol_1.3": return volRatio >= 1.3;
    case "vol_1.5": return volRatio >= 1.5;
    case "vol_1.8": return volRatio >= 1.8;
    case "vol_2.0": return volRatio >= 2.0;
    case "vol_2.5": return volRatio >= 2.5;
    case "board_2": return boardScore >= 2;
    case "board_3": return boardScore >= 3;
    case "board_4": return boardScore >= 4;
    case "board_5": return boardScore >= 5;

    // 検証2: AND条件
    case "caseA": return dropRate3 <= -0.006 && atrRatio >= 1.25;
    case "caseB": return dropRate3 <= -0.008 && atrRatio >= 1.5;
    case "caseC": return dropRate3 <= -0.010 && atrRatio >= 1.5;
    case "caseD": return dropRate3 <= -0.008 && bearCount >= 2;
    case "caseE": return dropRate3 <= -0.008 && volRatio >= 1.5;
    case "caseF": return atrRatio >= 1.5 && volRatio >= 1.5;
    case "caseG": return dropRate3 <= -0.008 && boardScore >= 3;
    case "caseH": return dropRate3 <= -0.008 && atrRatio >= 1.5 && volRatio >= 1.5;
    case "caseI": return dropRate3 <= -0.008 && atrRatio >= 1.5 && bearCount >= 2;
    case "caseJ": return dropRate3 <= -0.008 && atrRatio >= 1.5 && boardScore >= 3;

    // 検証3: スコア方式
    case "score_2":
    case "score_3":
    case "score_4":
    case "score_5":
    case "score_6": {
      let crashScore = 0;
      if (dropRate3 <= -0.008) crashScore += 2;
      if (atrRatio >= 1.5) crashScore += 2;
      if (bearCount >= 3) crashScore += 1;
      if (volRatio >= 1.8) crashScore += 1;
      if (boardScore >= 4) crashScore += 1;
      const threshold = parseInt(conditionName.split("_")[1]);
      return crashScore >= threshold;
    }
    default: return false;
  }
}

/**
 * CB v2 ステートマシン (v2-D_noUp2_ma5_close = v2-H_strict)
 * SHORTのみ
 */
function runCBv2(candles, startIdx) {
  let state = 1;
  let barsElapsed = 0;
  let prevHigh = -Infinity;
  let consecutiveNoNewHigh = 0;
  let prevMA5AbovePrice = false;
  const impulseLow = Math.min(...candles.slice(Math.max(0, startIdx - 4), startIdx + 1).map(c => c.low));

  for (let i = startIdx + 1; i < candles.length; i++) {
    barsElapsed++;
    const c = candles[i];

    if (barsElapsed > CB_TIMEOUT) return null;
    if (c.candleTime >= FORCE_EXIT_TIME) return null;

    switch (state) {
      case 1: {
        const reboundPct = (c.close - impulseLow) / impulseLow;
        if (reboundPct >= REBOUND_PCT) {
          state = 2;
          prevHigh = c.high;
          consecutiveNoNewHigh = 0;
        }
        break;
      }
      case 2: {
        if (c.high >= prevHigh) {
          prevHigh = c.high;
          consecutiveNoNewHigh = 0;
        } else {
          consecutiveNoNewHigh++;
          if (consecutiveNoNewHigh >= 2) {
            state = 3;
            const ma5 = calcMA(candles, i, 5);
            prevMA5AbovePrice = ma5 !== null && ma5 > c.close;
          }
        }
        break;
      }
      case 3: {
        const ma5 = calcMA(candles, i, 5);
        if (ma5 !== null) {
          const currentAbove = ma5 > c.close;
          if (!prevMA5AbovePrice && currentAbove) {
            state = 4;
          }
          prevMA5AbovePrice = currentAbove;
        }
        break;
      }
      case 4: {
        if (c.close < impulseLow) {
          // 成立 → 次足始値でエントリー
          return { entryIdx: i + 1, delayBars: i + 1 - startIdx, impulseLow };
        }
        break;
      }
    }
  }
  return null;
}

/**
 * エントリー後の決済シミュレーション
 */
function simulateExit(candles, entryIdx, entryPrice, slippage = 0) {
  const adjustedEntry = entryPrice * (1 + slippage); // SHORT: スリッページで不利方向
  const shares = Math.floor(POSITION_SIZE / adjustedEntry);
  if (shares <= 0) return null;

  const slPrice = adjustedEntry * (1 + SL_PCT);
  const tpPrice = adjustedEntry * (1 - TP_PCT);

  let maxFavorable = 0;  // 最大有利行程（%）
  let maxAdverse = 0;    // 最大逆行幅（%）

  for (let j = entryIdx; j < candles.length; j++) {
    const c = candles[j];

    // 最大有利行程・逆行幅の更新
    const favorablePct = (adjustedEntry - c.low) / adjustedEntry;
    const adversePct = (c.high - adjustedEntry) / adjustedEntry;
    if (favorablePct > maxFavorable) maxFavorable = favorablePct;
    if (adversePct > maxAdverse) maxAdverse = adversePct;

    // SL判定
    if (c.high >= slPrice) {
      const exitPrice = slPrice * (1 + slippage);
      const pnl = (adjustedEntry - exitPrice) * shares;
      return { exitTime: c.candleTime, exitPrice: slPrice, pnl: Math.round(pnl), exitReason: "SL", holdBars: j - entryIdx, maxFavorable, maxAdverse, shares };
    }
    // TP判定
    if (c.low <= tpPrice) {
      const exitPrice = tpPrice * (1 - slippage);
      const pnl = (adjustedEntry - exitPrice) * shares;
      return { exitTime: c.candleTime, exitPrice: tpPrice, pnl: Math.round(pnl), exitReason: "TP", holdBars: j - entryIdx, maxFavorable, maxAdverse, shares };
    }
    // 大引け決済
    if (c.candleTime >= FORCE_EXIT_TIME) {
      const exitPrice = c.close * (1 - slippage);
      const pnl = (adjustedEntry - exitPrice) * shares;
      return { exitTime: c.candleTime, exitPrice: c.close, pnl: Math.round(pnl), exitReason: "EOD", holdBars: j - entryIdx, maxFavorable, maxAdverse, shares };
    }
  }
  return null;
}

/**
 * 底値SHORT判定
 * エントリー後10本以内に:
 * - 最大順行幅 < 0.2% かつ 最大逆行幅 >= 0.3%
 */
function isBottomShort(candles, entryIdx, entryPrice) {
  let maxFav = 0, maxAdv = 0;
  const endIdx = Math.min(entryIdx + 10, candles.length);
  for (let j = entryIdx; j < endIdx; j++) {
    const fav = (entryPrice - candles[j].low) / entryPrice;
    const adv = (candles[j].high - entryPrice) / entryPrice;
    if (fav > maxFav) maxFav = fav;
    if (adv > maxAdv) maxAdv = adv;
  }
  return maxFav < 0.002 && maxAdv >= 0.003;
}

/**
 * エントリー時点が直近20本の安値圏下位10%以内か
 */
function isInLow10Pct(candles, entryIdx, entryPrice) {
  const start = Math.max(0, entryIdx - 20);
  const prices = [];
  for (let i = start; i < entryIdx; i++) {
    prices.push(candles[i].low);
  }
  if (prices.length < 5) return false;
  prices.sort((a, b) => a - b);
  const threshold10pct = prices[Math.floor(prices.length * 0.1)];
  return entryPrice <= threshold10pct;
}

// ============================================================
// 4. 全ケース検証
// ============================================================
console.log("\n検証開始...");

// 全条件名リスト
const allConditions = [
  // 検証1: 単独条件
  "drop_0.4", "drop_0.6", "drop_0.8", "drop_1.0", "drop_1.2",
  "atr_1.0", "atr_1.25", "atr_1.5", "atr_1.75", "atr_2.0",
  "bear_2of3", "bear_3of3",
  "vol_1.3", "vol_1.5", "vol_1.8", "vol_2.0", "vol_2.5",
  "board_2", "board_3", "board_4", "board_5",
  // 検証2: AND条件
  "caseA", "caseB", "caseC", "caseD", "caseE", "caseF", "caseG", "caseH", "caseI", "caseJ",
  // 検証3: スコア方式
  "score_2", "score_3", "score_4", "score_5", "score_6",
];

// 各ブロック取引に対して、急落指標を事前計算
const blockedWithIndicators = blocked08Short.map(t => {
  const key = `${t.symbol}|${t.tradeDate}`;
  const candles = candleCache[key];
  if (!candles) return { ...t, indicators: null, candleIdx: -1, candles: null };

  // ブロック時点の足を特定
  const idx = candles.findIndex(c => c.candleTime === t.tradeTime);
  if (idx < 0) return { ...t, indicators: null, candleIdx: -1, candles: null };

  const indicators = calcCrashIndicators(candles, idx);
  return { ...t, indicators, candleIdx: idx, candles };
});

// ============================================================
// Case 0: Baseline（0.8%フィルターなし）
// ============================================================
const baselinePnl = trades.filter(t => t.isRound && t.side === "short").reduce((s, t) => s + t.pnl, 0) + passed08.filter(t => t.side === "short").reduce((s, t) => s + t.pnl, 0);
// 簡易: 全SHORTの合計
const allShortTrades = trades.filter(t => t.side === "short");
const case0Pnl = allShortTrades.reduce((s, t) => s + t.pnl, 0);

// Case 1: 0.8%フィルター単独
const case1Trades = passed08.filter(t => t.side === "short");
const case1Pnl = case1Trades.reduce((s, t) => s + t.pnl, 0);

// ============================================================
// 各条件について検証
// ============================================================
const results = {};

for (const condName of allConditions) {
  const bypassTrades = [];
  const cbTrades = [];
  const bypassedSymbols = new Set();

  for (const bt of blockedWithIndicators) {
    if (!bt.candles || bt.candleIdx < 0) continue;

    const isCrash = bt.indicators ? checkCrashCondition(bt.indicators, condName) : false;

    if (isCrash) {
      // 急落バイパス: 次足始値でエントリー
      const entryIdx = bt.candleIdx + 1;
      if (entryIdx >= bt.candles.length) continue;
      const entryPrice = bt.candles[entryIdx].open;
      const result = simulateExit(bt.candles, entryIdx, entryPrice, 0);
      if (result) {
        const bottom = isBottomShort(bt.candles, entryIdx, entryPrice);
        const inLow10 = isInLow10Pct(bt.candles, entryIdx, entryPrice);
        bypassTrades.push({
          ...result, symbol: bt.symbol, tradeDate: bt.tradeDate,
          entryTime: bt.candles[entryIdx].candleTime, entryPrice,
          delayBars: 1, type: "bypass", isBottomShort: bottom, isInLow10Pct: inLow10,
          blockTime: bt.tradeTime,
        });
        bypassedSymbols.add(`${bt.tradeDate}_${bt.symbol}`);
      }
    } else {
      // Confirm Break v2
      const cbResult = runCBv2(bt.candles, bt.candleIdx);
      if (cbResult && cbResult.entryIdx < bt.candles.length) {
        const entryPrice = bt.candles[cbResult.entryIdx].open;
        const result = simulateExit(bt.candles, cbResult.entryIdx, entryPrice, 0);
        if (result) {
          const bottom = isBottomShort(bt.candles, cbResult.entryIdx, entryPrice);
          const inLow10 = isInLow10Pct(bt.candles, cbResult.entryIdx, entryPrice);
          cbTrades.push({
            ...result, symbol: bt.symbol, tradeDate: bt.tradeDate,
            entryTime: bt.candles[cbResult.entryIdx].candleTime, entryPrice,
            delayBars: cbResult.delayBars, type: "cb_v2", isBottomShort: bottom, isInLow10Pct: inLow10,
            blockTime: bt.tradeTime,
          });
        }
      }
    }
  }

  // 戦略全体 = passed08(SHORT) + bypass + cb
  const allStratTrades = [
    ...case1Trades.map(t => ({ ...t, type: "passed" })),
    ...bypassTrades,
    ...cbTrades,
  ];

  results[condName] = { bypassTrades, cbTrades, allStratTrades };
}

// ============================================================
// Case 2: CB v2単独（急落バイパスなし）
// ============================================================
const cbOnlyTrades = [];
for (const bt of blockedWithIndicators) {
  if (!bt.candles || bt.candleIdx < 0) continue;
  const cbResult = runCBv2(bt.candles, bt.candleIdx);
  if (cbResult && cbResult.entryIdx < bt.candles.length) {
    const entryPrice = bt.candles[cbResult.entryIdx].open;
    const result = simulateExit(bt.candles, cbResult.entryIdx, entryPrice, 0);
    if (result) {
      const bottom = isBottomShort(bt.candles, cbResult.entryIdx, entryPrice);
      const inLow10 = isInLow10Pct(bt.candles, cbResult.entryIdx, entryPrice);
      cbOnlyTrades.push({
        ...result, symbol: bt.symbol, tradeDate: bt.tradeDate,
        entryTime: bt.candles[cbResult.entryIdx].candleTime, entryPrice,
        delayBars: cbResult.delayBars, type: "cb_v2", isBottomShort: bottom, isInLow10Pct: inLow10,
        blockTime: bt.tradeTime,
      });
    }
  }
}
const case2AllTrades = [...case1Trades.map(t => ({ ...t, type: "passed" })), ...cbOnlyTrades];

// ============================================================
// 5. 集計関数
// ============================================================
function calcStats(tradesToCalc, label = "") {
  const wins = tradesToCalc.filter(t => t.pnl > 0);
  const losses = tradesToCalc.filter(t => t.pnl <= 0);
  const totalPnl = tradesToCalc.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = tradesToCalc.length > 0 ? wins.length / tradesToCalc.length : 0;
  const expectancy = tradesToCalc.length > 0 ? totalPnl / tradesToCalc.length : 0;

  // 最大DD
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const t of tradesToCalc.sort((a, b) => `${a.tradeDate}_${a.entryTime || a.tradeTime}`.localeCompare(`${b.tradeDate}_${b.entryTime || b.tradeTime}`))) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // 最大連敗
  let maxConsecLoss = 0, consecLoss = 0;
  for (const t of tradesToCalc) {
    if (t.pnl <= 0) { consecLoss++; if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss; }
    else consecLoss = 0;
  }

  return {
    count: tradesToCalc.length, wins: wins.length, losses: losses.length,
    totalPnl, pf: Math.round(pf * 100) / 100, winRate: Math.round(winRate * 1000) / 10,
    expectancy: Math.round(expectancy), maxDD, maxConsecLoss,
    tpCount: tradesToCalc.filter(t => t.exitReason === "TP").length,
    slCount: tradesToCalc.filter(t => t.exitReason === "SL").length,
    eodCount: tradesToCalc.filter(t => t.exitReason === "EOD").length,
    avgHoldBars: tradesToCalc.length > 0 ? Math.round(tradesToCalc.reduce((s, t) => s + (t.holdBars || 0), 0) / tradesToCalc.length) : 0,
    avgDelayBars: tradesToCalc.length > 0 ? Math.round(tradesToCalc.reduce((s, t) => s + (t.delayBars || 0), 0) / tradesToCalc.length) : 0,
    bottomShortCount: tradesToCalc.filter(t => t.isBottomShort).length,
    inLow10PctCount: tradesToCalc.filter(t => t.isInLow10Pct).length,
    avgMaxFavorable: tradesToCalc.length > 0 ? Math.round(tradesToCalc.reduce((s, t) => s + (t.maxFavorable || 0), 0) / tradesToCalc.length * 10000) / 100 : 0,
    avgMaxAdverse: tradesToCalc.length > 0 ? Math.round(tradesToCalc.reduce((s, t) => s + (t.maxAdverse || 0), 0) / tradesToCalc.length * 10000) / 100 : 0,
  };
}

function calcStatsWithSlippage(tradesToCalc, slippageBypass, slippageCB) {
  // 再計算: スリッページ込み
  const adjustedTrades = tradesToCalc.map(t => {
    if (t.type === "passed") return t;
    const slip = t.type === "bypass" ? slippageBypass : slippageCB;
    if (slip === 0) return t;
    // 往復スリッページ
    const adjustedPnl = t.pnl - (t.shares || Math.floor(POSITION_SIZE / t.entryPrice)) * t.entryPrice * slip * 2;
    return { ...t, pnl: Math.round(adjustedPnl) };
  });
  return calcStats(adjustedTrades);
}

// ============================================================
// 6. レポート生成
// ============================================================
console.log("\nレポート生成中...");

let report = "";
report += "=" .repeat(80) + "\n";
report += "  急落時Confirm Breakバイパス分岐ロジック バックテスト結果\n";
report += "=" .repeat(80) + "\n\n";
report += `期間: 2026-06-17 ～ 2026-07-16\n`;
report += `対象: SHORTのみ\n`;
report += `0.8%ブロック対象SHORT: ${blocked08Short.length}件\n\n`;

// Case 0, 1, 2
const case0Stats = calcStats(allShortTrades);
const case1Stats = calcStats(case1Trades);
const case2Stats = calcStats(case2AllTrades);
const cbOnlyStats = calcStats(cbOnlyTrades);

report += "=" .repeat(80) + "\n";
report += "  比較対象 (Case 0, 1, 2)\n";
report += "=" .repeat(80) + "\n\n";
report += `Case 0 (Baseline): 総損益=${case0Stats.totalPnl} PF=${case0Stats.pf} 期待値=${case0Stats.expectancy} 勝率=${case0Stats.winRate}% 件数=${case0Stats.count} maxDD=${case0Stats.maxDD} 連敗=${case0Stats.maxConsecLoss}\n`;
report += `Case 1 (0.8%単独): 総損益=${case1Stats.totalPnl} PF=${case1Stats.pf} 期待値=${case1Stats.expectancy} 勝率=${case1Stats.winRate}% 件数=${case1Stats.count} maxDD=${case1Stats.maxDD} 連敗=${case1Stats.maxConsecLoss}\n`;
report += `Case 2 (0.8%+CB v2): 総損益=${case2Stats.totalPnl} PF=${case2Stats.pf} 期待値=${case2Stats.expectancy} 勝率=${case2Stats.winRate}% 件数=${case2Stats.count} maxDD=${case2Stats.maxDD} 連敗=${case2Stats.maxConsecLoss}\n`;
report += `  CB v2部分: 件数=${cbOnlyStats.count} 総損益=${cbOnlyStats.totalPnl} PF=${cbOnlyStats.pf} 勝率=${cbOnlyStats.winRate}% 平均遅延=${cbOnlyStats.avgDelayBars}本 底値SHORT=${cbOnlyStats.bottomShortCount}件\n\n`;

// ============================================================
// 全ケースランキング
// ============================================================
report += "=" .repeat(80) + "\n";
report += "  全ケース結果一覧\n";
report += "=" .repeat(80) + "\n\n";
report += "条件名 | 全体損益 | 全体PF | 全体勝率 | 件数 | maxDD | バイパス件数 | バイパス損益 | バイパスPF | バイパス勝率 | バイパスSL率 | CB件数 | CB損益 | CB PF | 底値SHORT | 平均遅延\n";
report += "-".repeat(200) + "\n";

const ranking = [];
for (const condName of allConditions) {
  const { bypassTrades, cbTrades, allStratTrades } = results[condName];
  const allStats = calcStats(allStratTrades);
  const bpStats = calcStats(bypassTrades);
  const cbStats = calcStats(cbTrades);

  ranking.push({ condName, allStats, bpStats, cbStats, bypassTrades, cbTrades });

  const slRate = bpStats.count > 0 ? Math.round(bpStats.slCount / bpStats.count * 100) : 0;
  const bottomRate = bpStats.count > 0 ? Math.round(bpStats.bottomShortCount / bpStats.count * 100) : 0;
  report += `${condName.padEnd(12)} | ${String(allStats.totalPnl).padStart(8)} | ${String(allStats.pf).padStart(5)} | ${String(allStats.winRate).padStart(5)}% | ${String(allStats.count).padStart(4)} | ${String(allStats.maxDD).padStart(7)} | ${String(bpStats.count).padStart(4)} | ${String(bpStats.totalPnl).padStart(8)} | ${String(bpStats.pf).padStart(5)} | ${String(bpStats.winRate).padStart(5)}% | ${String(slRate).padStart(3)}% | ${String(cbStats.count).padStart(3)} | ${String(cbStats.totalPnl).padStart(8)} | ${String(cbStats.pf).padStart(5)} | ${String(bpStats.bottomShortCount).padStart(2)}/${String(bpStats.count).padStart(2)} | ${String(bpStats.avgDelayBars).padStart(2)}本\n`;
}

// ソート（全体損益降順）
ranking.sort((a, b) => b.allStats.totalPnl - a.allStats.totalPnl);
report += "\n";
report += "=" .repeat(80) + "\n";
report += "  ランキング（全体損益降順）\n";
report += "=" .repeat(80) + "\n\n";
for (let i = 0; i < ranking.length; i++) {
  const r = ranking[i];
  report += `${i+1}. ${r.condName}: 全体損益=${r.allStats.totalPnl} PF=${r.allStats.pf} バイパス${r.bpStats.count}件(PF=${r.bpStats.pf}) CB${r.cbStats.count}件(PF=${r.cbStats.pf})\n`;
}

// ============================================================
// 最良ケースの詳細
// ============================================================
const best = ranking[0];
report += "\n" + "=" .repeat(80) + "\n";
report += `  最良ケース詳細: ${best.condName}\n`;
report += "=" .repeat(80) + "\n\n";

// 急落バイパス部分詳細
report += "--- 急落バイパス部分 ---\n";
const bpStats = best.bpStats;
report += `成立件数: ${bpStats.count}\n`;
report += `総損益: ${bpStats.totalPnl}\n`;
report += `PF: ${bpStats.pf}\n`;
report += `期待値: ${bpStats.expectancy}\n`;
report += `勝率: ${bpStats.winRate}%\n`;
report += `TP: ${bpStats.tpCount}件 SL: ${bpStats.slCount}件 EOD: ${bpStats.eodCount}件\n`;
report += `SL率: ${bpStats.count > 0 ? Math.round(bpStats.slCount / bpStats.count * 100) : 0}%\n`;
report += `平均保有時間: ${bpStats.avgHoldBars}本\n`;
report += `平均エントリー遅延: ${bpStats.avgDelayBars}本\n`;
report += `平均最大有利行程: ${bpStats.avgMaxFavorable}%\n`;
report += `平均最大逆行幅: ${bpStats.avgMaxAdverse}%\n`;
report += `底値SHORT: ${bpStats.bottomShortCount}件 (${bpStats.count > 0 ? Math.round(bpStats.bottomShortCount / bpStats.count * 100) : 0}%)\n`;
report += `安値圏10%以内: ${bpStats.inLow10PctCount}件\n\n`;

// CB部分詳細
report += "--- Confirm Break v2部分 ---\n";
const cbStatsB = best.cbStats;
report += `成立件数: ${cbStatsB.count}\n`;
report += `総損益: ${cbStatsB.totalPnl}\n`;
report += `PF: ${cbStatsB.pf}\n`;
report += `期待値: ${cbStatsB.expectancy}\n`;
report += `勝率: ${cbStatsB.winRate}%\n`;
report += `SL率: ${cbStatsB.count > 0 ? Math.round(cbStatsB.slCount / cbStatsB.count * 100) : 0}%\n`;
report += `平均遅延: ${cbStatsB.avgDelayBars}本\n`;
report += `底値SHORT: ${cbStatsB.bottomShortCount}件\n\n`;

// 取引一覧
report += "--- 急落バイパス取引一覧 ---\n";
for (const t of best.bypassTrades) {
  report += `  ${t.tradeDate} ${t.symbol} block=${t.blockTime} entry=${t.entryTime} @${t.entryPrice} exit=${t.exitTime} @${t.exitPrice} ${t.exitReason} pnl=${t.pnl} hold=${t.holdBars}本 bottom=${t.isBottomShort}\n`;
}
report += "\n";

// ============================================================
// 底値SHORT分析
// ============================================================
report += "=" .repeat(80) + "\n";
report += "  底値SHORT分析\n";
report += "=" .repeat(80) + "\n\n";
report += `CB v2単独: 底値SHORT ${cbOnlyStats.bottomShortCount}/${cbOnlyStats.count}件 (${cbOnlyStats.count > 0 ? Math.round(cbOnlyStats.bottomShortCount / cbOnlyStats.count * 100) : 0}%)\n`;
report += `最良ケース(${best.condName}):\n`;
report += `  バイパス部分: 底値SHORT ${bpStats.bottomShortCount}/${bpStats.count}件 (${bpStats.count > 0 ? Math.round(bpStats.bottomShortCount / bpStats.count * 100) : 0}%)\n`;
report += `  CB部分: 底値SHORT ${cbStatsB.bottomShortCount}/${cbStatsB.count}件 (${cbStatsB.count > 0 ? Math.round(cbStatsB.bottomShortCount / cbStatsB.count * 100) : 0}%)\n\n`;

// 取り逃がし分析
const missedTrades = blocked08Short.filter(t => t.pnl > 0); // ブロックされたが利益方向に進んだ
report += `取り逃がし分析:\n`;
report += `  0.8%ブロック後TP方向に進んだ件数: ${missedTrades.length}件\n`;
report += `  急落バイパスで救済: ${best.bypassTrades.filter(t => t.pnl > 0).length}件\n`;
report += `  急落バイパスで底値SHORT: ${bpStats.bottomShortCount}件\n`;
report += `  CB v2で底値SHORT: ${cbStatsB.bottomShortCount}件\n\n`;

// ============================================================
// 時間帯別分析
// ============================================================
report += "=" .repeat(80) + "\n";
report += "  時間帯別分析 (最良ケース: " + best.condName + ")\n";
report += "=" .repeat(80) + "\n\n";

const timeSlots = [
  ["09:30", "10:00"], ["10:00", "10:30"], ["10:30", "11:00"], ["11:00", "11:30"],
  ["13:00", "13:30"], ["13:30", "14:00"], ["14:00", "14:30"], ["14:30", "15:00"], ["15:00", "15:25"],
];

report += "時間帯 | バイパス件数 | バイパス損益 | バイパスPF | CB件数 | CB損益 | CB PF\n";
report += "-".repeat(100) + "\n";
for (const [start, end] of timeSlots) {
  const bpInSlot = best.bypassTrades.filter(t => t.blockTime >= start && t.blockTime < end);
  const cbInSlot = best.cbTrades.filter(t => t.blockTime >= start && t.blockTime < end);
  const bpSlotStats = calcStats(bpInSlot);
  const cbSlotStats = calcStats(cbInSlot);
  report += `${start}-${end} | ${bpSlotStats.count} | ${bpSlotStats.totalPnl} | ${bpSlotStats.pf} | ${cbSlotStats.count} | ${cbSlotStats.totalPnl} | ${cbSlotStats.pf}\n`;
}

// 11:30まで vs 13:30以降
const bpAM = best.bypassTrades.filter(t => t.blockTime < "11:30");
const bpPM = best.bypassTrades.filter(t => t.blockTime >= "13:30");
const cbAM = best.cbTrades.filter(t => t.blockTime < "11:30");
const cbPM = best.cbTrades.filter(t => t.blockTime >= "13:30");
report += `\n11:30まで: バイパス${bpAM.length}件(損益=${calcStats(bpAM).totalPnl}) CB${cbAM.length}件(損益=${calcStats(cbAM).totalPnl})\n`;
report += `13:30以降: バイパス${bpPM.length}件(損益=${calcStats(bpPM).totalPnl}) CB${cbPM.length}件(損益=${calcStats(cbPM).totalPnl})\n\n`;

// ============================================================
// 銘柄別分析
// ============================================================
report += "=" .repeat(80) + "\n";
report += "  銘柄別分析 (最良ケース: " + best.condName + ")\n";
report += "=" .repeat(80) + "\n\n";

const allBestTrades = [...best.bypassTrades, ...best.cbTrades];
const symbolMap = {};
for (const t of allBestTrades) {
  if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { bypass: [], cb: [] };
  if (t.type === "bypass") symbolMap[t.symbol].bypass.push(t);
  else symbolMap[t.symbol].cb.push(t);
}

report += "銘柄 | 件数 | 総損益 | PF | 勝率 | 底値SHORT率 | バイパス件数 | CB件数\n";
report += "-".repeat(100) + "\n";
let totalProfit = 0, totalLoss = 0;
const symbolResults = [];
for (const [sym, data] of Object.entries(symbolMap)) {
  const all = [...data.bypass, ...data.cb];
  const stats = calcStats(all);
  const bottomRate = all.length > 0 ? Math.round(all.filter(t => t.isBottomShort).length / all.length * 100) : 0;
  symbolResults.push({ sym, stats, bypass: data.bypass.length, cb: data.cb.length, bottomRate });
  if (stats.totalPnl > 0) totalProfit += stats.totalPnl;
  else totalLoss += Math.abs(stats.totalPnl);
  report += `${sym.padEnd(6)} | ${String(stats.count).padStart(3)} | ${String(stats.totalPnl).padStart(8)} | ${String(stats.pf).padStart(5)} | ${String(stats.winRate).padStart(5)}% | ${String(bottomRate).padStart(3)}% | ${String(data.bypass.length).padStart(3)} | ${String(data.cb.length).padStart(3)}\n`;
}

// 依存率
const maxProfitSym = symbolResults.filter(s => s.stats.totalPnl > 0).sort((a, b) => b.stats.totalPnl - a.stats.totalPnl)[0];
const maxLossSym = symbolResults.filter(s => s.stats.totalPnl < 0).sort((a, b) => a.stats.totalPnl - b.stats.totalPnl)[0];
report += `\n1銘柄利益依存率: ${maxProfitSym ? maxProfitSym.sym + " " + Math.round(maxProfitSym.stats.totalPnl / totalProfit * 100) + "%" : "N/A"}\n`;
report += `1銘柄損失依存率: ${maxLossSym ? maxLossSym.sym + " " + Math.round(Math.abs(maxLossSym.stats.totalPnl) / totalLoss * 100) + "%" : "N/A"}\n`;

// 6920除外
const no6920Bypass = best.bypassTrades.filter(t => t.symbol !== "6920");
const no6920CB = best.cbTrades.filter(t => t.symbol !== "6920");
const no6920All = [...case1Trades.filter(t => t.symbol !== "6920").map(t => ({ ...t, type: "passed" })), ...no6920Bypass, ...no6920CB];
const no6920Stats = calcStats(no6920All);
report += `\n6920除外: 全体損益=${no6920Stats.totalPnl} PF=${no6920Stats.pf} 件数=${no6920Stats.count}\n`;
report += `6920込み: 全体損益=${best.allStats.totalPnl} PF=${best.allStats.pf} 件数=${best.allStats.count}\n`;
report += `差額: ${no6920Stats.totalPnl - best.allStats.totalPnl}\n\n`;

// 特定銘柄
for (const sym of ["6976", "6981", "285A"]) {
  const data = symbolMap[sym];
  if (data) {
    const all = [...data.bypass, ...data.cb];
    const stats = calcStats(all);
    report += `${sym}: 件数=${stats.count} 損益=${stats.totalPnl} PF=${stats.pf} 勝率=${stats.winRate}% バイパス=${data.bypass.length} CB=${data.cb.length}\n`;
  } else {
    report += `${sym}: 該当なし\n`;
  }
}

// ============================================================
// スリッページ検証
// ============================================================
report += "\n" + "=" .repeat(80) + "\n";
report += "  スリッページ検証 (最良ケース: " + best.condName + ")\n";
report += "=" .repeat(80) + "\n\n";

const slippageCases = [
  { label: "片道0.05%（全体）", bpSlip: 0.0005, cbSlip: 0.0005 },
  { label: "急落バイパスのみ片道0.10%", bpSlip: 0.001, cbSlip: 0.0005 },
  { label: "急落バイパスのみ片道0.15%", bpSlip: 0.0015, cbSlip: 0.0005 },
];

for (const sc of slippageCases) {
  const adjTrades = [...case1Trades.map(t => ({ ...t, type: "passed" })), ...best.bypassTrades, ...best.cbTrades];
  const adjStats = calcStatsWithSlippage(adjTrades, sc.bpSlip, sc.cbSlip);
  report += `${sc.label}: 総損益=${adjStats.totalPnl} PF=${adjStats.pf}\n`;
}

// ============================================================
// 採用判定
// ============================================================
report += "\n" + "=" .repeat(80) + "\n";
report += "  採用判定\n";
report += "=" .repeat(80) + "\n\n";

const adoptionCandidates = [];
for (const r of ranking) {
  const { condName, allStats, bpStats: bp, cbStats: cb } = r;
  const bottomRate = bp.count > 0 ? bp.bottomShortCount / bp.count : 0;

  // 1銘柄利益依存率チェック
  const symPnls = {};
  for (const t of [...r.bypassTrades, ...r.cbTrades]) {
    symPnls[t.symbol] = (symPnls[t.symbol] || 0) + t.pnl;
  }
  const maxSymProfit = Math.max(...Object.values(symPnls).filter(v => v > 0), 0);
  const totalProfitAll = Object.values(symPnls).filter(v => v > 0).reduce((s, v) => s + v, 0);
  const profitDep = totalProfitAll > 0 ? maxSymProfit / totalProfitAll : 0;

  // スリッページ込み
  const adjTrades = [...case1Trades.map(t => ({ ...t, type: "passed" })), ...r.bypassTrades, ...r.cbTrades];
  const adjStats = calcStatsWithSlippage(adjTrades, 0.0005, 0.0005);

  const checks = {
    totalPnlOk: allStats.totalPnl >= case1Stats.totalPnl,
    pfOk: allStats.pf >= case1Stats.pf,
    ddOk: allStats.maxDD <= case1Stats.maxDD,
    bpPfOk: bp.pf >= 1.30,
    bpExpOk: bp.expectancy > 0,
    bpCountOk: bp.count >= 10,
    bottomOk: bottomRate <= 0.20,
    depOk: profitDep <= 0.50,
    slipOk: adjStats.pf >= case1Stats.pf,
    delayOk: bp.avgDelayBars < cbOnlyStats.avgDelayBars,
    bottomImproveOk: bp.bottomShortCount <= cbOnlyStats.bottomShortCount,
  };

  const rejectChecks = {
    bpPfBad: bp.pf < 1.0,
    bpExpBad: bp.expectancy <= 0,
    ddBad: allStats.maxDD > case1Stats.maxDD,
    bottomBad: bottomRate > 0.30,
    depBad: profitDep > 0.50,
    slipBad: adjStats.totalPnl <= 0,
    countBad: bp.count < 5,
  };

  const allPass = Object.values(checks).every(v => v);
  const anyReject = Object.values(rejectChecks).some(v => v);

  let verdict = "不採用";
  if (allPass && !anyReject) verdict = "採用候補";
  else if (!anyReject && bp.count >= 5) verdict = "条件付き候補";

  if (verdict !== "不採用") {
    adoptionCandidates.push({ condName, verdict, allStats, bpStats: bp, checks });
  }

  report += `${condName}: ${verdict}`;
  if (verdict === "不採用") {
    const reasons = [];
    if (rejectChecks.bpPfBad) reasons.push("バイパスPF<1.0");
    if (rejectChecks.bpExpBad) reasons.push("バイパス期待値<=0");
    if (rejectChecks.ddBad) reasons.push("DD悪化");
    if (rejectChecks.bottomBad) reasons.push("底値SHORT>30%");
    if (rejectChecks.depBad) reasons.push("1銘柄依存>50%");
    if (rejectChecks.countBad) reasons.push("件数不足");
    if (!checks.totalPnlOk) reasons.push("全体損益<0.8%単独");
    if (!checks.pfOk) reasons.push("全体PF<0.8%単独");
    report += ` (${reasons.join(", ")})`;
  }
  report += "\n";
}

// ============================================================
// 過学習リスク
// ============================================================
report += "\n" + "=" .repeat(80) + "\n";
report += "  過学習リスク評価\n";
report += "=" .repeat(80) + "\n\n";
report += `検証期間: 22営業日\n`;
report += `ブロック対象SHORT: ${blocked08Short.length}件\n`;
report += `最良ケース: ${best.condName}\n`;
report += `  バイパス成立: ${best.bpStats.count}件 (${blocked08Short.length}件中)\n`;
report += `  CB成立: ${best.cbStats.count}件\n`;
report += `  サンプル数の十分性: ${best.bpStats.count >= 15 ? "十分" : best.bpStats.count >= 10 ? "最低限" : "不十分"}\n`;

// 前半/後半分割
const midDate = "2026-07-01";
const bpFirst = best.bypassTrades.filter(t => t.tradeDate < midDate);
const bpSecond = best.bypassTrades.filter(t => t.tradeDate >= midDate);
report += `  前半(6/17-6/30): ${bpFirst.length}件 損益=${calcStats(bpFirst).totalPnl}\n`;
report += `  後半(7/1-7/16): ${bpSecond.length}件 損益=${calcStats(bpSecond).totalPnl}\n`;
report += `  期間安定性: ${bpFirst.length > 0 && bpSecond.length > 0 && calcStats(bpFirst).totalPnl > 0 && calcStats(bpSecond).totalPnl > 0 ? "両期間プラス" : "片方マイナス → 注意"}\n\n`;

// ============================================================
// 結論
// ============================================================
report += "=" .repeat(80) + "\n";
report += "  結論\n";
report += "=" .repeat(80) + "\n\n";

if (adoptionCandidates.length > 0) {
  report += `採用候補: ${adoptionCandidates.length}件\n`;
  for (const c of adoptionCandidates) {
    report += `  ${c.condName}: 全体損益=${c.allStats.totalPnl} PF=${c.allStats.pf} バイパスPF=${c.bpStats.pf}\n`;
  }
  report += `\n推奨: ${adoptionCandidates[0].condName}\n`;
} else {
  report += `採用候補: なし\n`;
  report += `全条件が採用基準を満たしませんでした。\n`;
  report += `CB v2単独での運用を継続することを推奨します。\n`;
}

// ファイル出力
fs.writeFileSync("/home/ubuntu/stock-alert-app/backtest_crash_bypass_results.txt", report);
console.log("\n結果を backtest_crash_bypass_results.txt に出力しました。");
console.log("\n--- サマリー ---");
console.log(`Case 1 (0.8%単独): 損益=${case1Stats.totalPnl} PF=${case1Stats.pf}`);
console.log(`Case 2 (0.8%+CB v2): 損益=${case2Stats.totalPnl} PF=${case2Stats.pf}`);
console.log(`最良分岐型: ${best.condName} 損益=${best.allStats.totalPnl} PF=${best.allStats.pf}`);
console.log(`  バイパス: ${best.bpStats.count}件 PF=${best.bpStats.pf}`);
console.log(`  CB v2: ${best.cbStats.count}件 PF=${best.cbStats.pf}`);
if (adoptionCandidates.length > 0) {
  console.log(`\n採用候補: ${adoptionCandidates.map(c => c.condName).join(", ")}`);
} else {
  console.log(`\n採用候補: なし`);
}
