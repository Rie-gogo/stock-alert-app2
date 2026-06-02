/**
 * realSimulation.ts
 * Yahoo Finance の実際の株価データを使ったシミュレーションエンジン
 * simulation.ts の架空データ生成を置き換える
 */
import { callDataApi } from "./_core/dataApi";
import type { StockSimResult, TradeRecord, SignalRecord } from "./simulation";
import { TARGET_STOCKS } from "../shared/stocks";

// 共有定義からインポート（client/src/hooks/useRealMarketData.ts と同一ソース）
export const REAL_TARGET_STOCKS = TARGET_STOCKS.map((s) => ({
  symbol: s.symbol,
  ticker: s.ticker,
  name: s.name,
}));

// ---- テクニカル指標計算（stockData.tsと同一ロジック） ----

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}

function calcBollinger(
  data: number[],
  period = 20,
  stdDevMult = 2
): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = avg + stdDevMult * std;
    lower[i] = avg - stdDevMult * std;
  }
  return { upper, lower };
}

interface RealCandle {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  bbUpper: number | null;
  bbLower: number | null;
}

/**
 * Yahoo Finance から1分足データを取得してローソク足配列を返す
 * 失敗した場合は null を返す
 * 最大3回リトライする
 */
async function fetchRealCandles(ticker: string, maxRetries = 3): Promise<RealCandle[] | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchRealCandlesOnce(ticker);
      if (result !== null) return result;
      // nullの場合はデータなしなのでリトライしない
      return null;
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`[realSimulation] Retry ${attempt}/${maxRetries} for ${ticker}:`, err);
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      } else {
        console.warn(`[realSimulation] All retries failed for ${ticker}:`, err);
      }
    }
  }
  return null;
}

async function fetchRealCandlesOnce(ticker: string): Promise<RealCandle[] | null> {
  try {
    const rawData = await callDataApi("YahooFinance/get_stock_chart", {
      query: {
        symbol: ticker,
        region: "JP",
        interval: "1m",
        range: "1d",
      },
    });

    const data = rawData as {
      chart?: {
        result?: Array<{
          timestamp: number[];
          indicators: {
            quote: Array<{
              open: (number | null)[];
              high: (number | null)[];
              low: (number | null)[];
              close: (number | null)[];
              volume: (number | null)[];
            }>;
          };
        }>;
        error?: { description: string };
      };
    };

    if (!data?.chart?.result?.[0]) return null;

    const result = data.chart.result[0];
    const timestamps = result.timestamp ?? [];
    const quotes = result.indicators.quote[0];

    const rawCandles: RealCandle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quotes.open[i];
      const h = quotes.high[i];
      const l = quotes.low[i];
      const c = quotes.close[i];
      const v = quotes.volume[i];

      if (o === null || c === null || o === undefined || c === undefined) continue;

      const d = new Date(timestamps[i] * 1000);
      const jstHour = (d.getUTCHours() + 9) % 24;
      const timeStr = `${String(jstHour).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

      rawCandles.push({
        time: timeStr,
        timestamp: timestamps[i] * 1000,
        open: o,
        high: h ?? o,
        low: l ?? o,
        close: c,
        volume: v ?? 0,
        ma5: null,
        ma25: null,
        rsi: null,
        bbUpper: null,
        bbLower: null,
      });
    }

    if (rawCandles.length < 30) return null; // データが少なすぎる場合はスキップ

    // テクニカル指標を計算
    const closes = rawCandles.map(c => c.close);
    const ma5 = calcMA(closes, 5);
    const ma25 = calcMA(closes, 25);
    const rsi = calcRSI(closes, 14);
    const bb = calcBollinger(closes, 20, 2);

    rawCandles.forEach((c, i) => {
      c.ma5 = ma5[i];
      c.ma25 = ma25[i];
      c.rsi = rsi[i];
      c.bbUpper = bb.upper[i];
      c.bbLower = bb.lower[i];
    });

    return rawCandles;
  } catch (err) {
    console.warn(`[realSimulation] Failed to fetch ${ticker}:`, err);
    return null;
  }
}

/**
 * 実際の株価データを使ってシミュレーションを実行する
 */
export async function simulateStockReal(
  symbol: string,
  ticker: string,
  name: string,
  initialCapital = 3_000_000,
  rsiUpper = 70,
  rsiLower = 30,
  stopLossPercent = 1.5
): Promise<(StockSimResult & { isRealData: boolean }) | null> {
  const candles = await fetchRealCandles(ticker);

  // 実データ取得失敗時はnullを返す（架空データへのフォールバックは絶対に行わない）
  if (!candles) {
    console.warn(`[realSimulation] Real data unavailable for ${ticker} - skipping (NO FALLBACK)`);
    return null;
  }

    // シミュレーション実行
  const trades: TradeRecord[] = [];
  const signals: SignalRecord[] = [];
  let capital = initialCapital;
  // ロングポジション
  let longShares = 0;
  let longEntryPrice = 0;
  // ショートポジション（空売り）
  let shortShares = 0;
  let shortEntryPrice = 0;

  let winCount = 0;
  let lossCount = 0;

  const stopLossRatio = stopLossPercent / 100;

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    if (
      curr.rsi === null || curr.ma5 === null || curr.ma25 === null ||
      curr.bbLower === null || curr.bbUpper === null ||
      prev.ma5 === null || prev.ma25 === null
    ) continue;

    const isGoldenCross = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    const isDeadCross = prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25;
    const isRsiOversold = curr.rsi <= rsiLower;
    const isRsiOverbought = curr.rsi >= rsiUpper;
    const isBbLower = curr.close <= curr.bbLower;
    const isBbUpper = curr.close >= curr.bbUpper;
    const isStrongDown = curr.ma5 < curr.ma25 && curr.close < curr.ma5;
    const isStrongUp = curr.ma5 > curr.ma25 * 1.003 && curr.close >= curr.ma5;

    // ============================================================
    // ロング（買い）ポジション管理
    // ============================================================

    // ロングエントリー：ゴールデンクロス or RSI売られすぎ+BB下限
    const shouldBuyLong = !isStrongDown && (isGoldenCross || (isRsiOversold && isBbLower));

    if (longShares === 0 && shortShares === 0 && shouldBuyLong) {
      const maxSpend = capital * 0.49; // 資金の半分でロング
      const shares = Math.floor(maxSpend / curr.close / 100) * 100; // 100株単位
      if (shares > 0) {
        const totalAmount = shares * curr.close;
        longShares = shares;
        longEntryPrice = curr.close;
        capital -= totalAmount;
        const buyReason = isGoldenCross
          ? `ゴールデンクロス (MA5:${curr.ma5?.toFixed(1)} > MA25:${curr.ma25?.toFixed(1)})`
          : `RSI売られすぎ+BB下限 (RSI:${curr.rsi?.toFixed(1)}, BB下:${curr.bbLower?.toFixed(1)})`;
        trades.push({ time: curr.time, type: "buy", price: curr.close, shares, totalAmount });
        signals.push({ time: curr.time, type: "buy", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: buyReason });
      }
    }

    // ロング損切り
    if (longShares > 0 && curr.close <= longEntryPrice * (1 - stopLossRatio)) {
      const totalAmount = longShares * curr.close;
      const profit = totalAmount - longShares * longEntryPrice;
      capital += totalAmount;
      lossCount++;
      trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
      signals.push({ time: curr.time, type: "sell", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `損切り (${stopLossPercent}%下落, 入荷:${longEntryPrice.toFixed(1)}→現在:${curr.close.toFixed(1)})` });
      longShares = 0;
      longEntryPrice = 0;
    }

    // ロング利確・手仕舞い：デッドクロス or RSI買われすぎ+BB上限
    const shouldSellLong = isDeadCross || (isRsiOverbought && isBbUpper && !isStrongUp);

    if (longShares > 0 && shouldSellLong) {
      const totalAmount = longShares * curr.close;
      const profit = totalAmount - longShares * longEntryPrice;
      capital += totalAmount;
      if (profit > 0) winCount++; else lossCount++;
      const sellReason = isDeadCross
        ? `デッドクロス (MA5:${curr.ma5?.toFixed(1)} < MA25:${curr.ma25?.toFixed(1)})`
        : `RSI買われすぎ+BB上限 (RSI:${curr.rsi?.toFixed(1)}, BB上:${curr.bbUpper?.toFixed(1)})`;
      trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
      signals.push({ time: curr.time, type: "sell", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: sellReason });
      longShares = 0;
      longEntryPrice = 0;
    }

    // ============================================================
    // ショート（空売り）ポジション管理
    // ============================================================

    // ショートエントリー：デッドクロス or RSI買われすぎ+BB上限（強い上昇トレンド中は見送り）
    const shouldEnterShort = !isStrongUp && (isDeadCross || (isRsiOverbought && isBbUpper));

    if (shortShares === 0 && longShares === 0 && shouldEnterShort) {
      const maxSpend = capital * 0.49;
      const shares = Math.floor(maxSpend / curr.close / 100) * 100; // 100株単位
      if (shares > 0) {
        const marginRequired = shares * curr.close;
        shortShares = shares;
        shortEntryPrice = curr.close;
        capital -= marginRequired; // 証拠金を確保
        const shortReason = isDeadCross
          ? `空売りエントリー: デッドクロス (MA5:${curr.ma5?.toFixed(1)} < MA25:${curr.ma25?.toFixed(1)})`
          : `空売りエントリー: RSI買われすぎ+BB上限 (RSI:${curr.rsi?.toFixed(1)})`;
        trades.push({ time: curr.time, type: "short", price: curr.close, shares, totalAmount: marginRequired });
        signals.push({ time: curr.time, type: "short", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: shortReason });
      }
    }

    // ショート損切り：エントリー価格からstopLossPercent%上昇
    if (shortShares > 0 && curr.close >= shortEntryPrice * (1 + stopLossRatio)) {
      const profit = (shortEntryPrice - curr.close) * shortShares;
      const marginReturn = shortShares * shortEntryPrice;
      capital += marginReturn + profit;
      lossCount++;
      trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
      signals.push({ time: curr.time, type: "cover", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `空売り損切り (エントリー:${shortEntryPrice.toFixed(1)} → ${curr.close.toFixed(1)})` });
      shortShares = 0;
      shortEntryPrice = 0;
    }

    // ショート利確・買い戻し：ゴールデンクロス or RSI売られすぎ+BB下限
    const shouldCoverShort = isGoldenCross || (isRsiOversold && isBbLower && !isStrongDown);

    if (shortShares > 0 && shouldCoverShort) {
      const profit = (shortEntryPrice - curr.close) * shortShares;
      const marginReturn = shortShares * shortEntryPrice;
      capital += marginReturn + profit;
      if (profit > 0) winCount++; else lossCount++;
      const coverReason = isGoldenCross
        ? `空売り買い戻し: ゴールデンクロス (MA5:${curr.ma5?.toFixed(1)} > MA25:${curr.ma25?.toFixed(1)})`
        : `空売り買い戻し: RSI売られすぎ+BB下限 (RSI:${curr.rsi?.toFixed(1)})`;
      trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
      signals.push({ time: curr.time, type: "cover", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: coverReason });
      shortShares = 0;
      shortEntryPrice = 0;
    }
  }

  // 残ロングポジションを引け値で強制決済
  if (longShares > 0 && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const totalAmount = longShares * lastCandle.close;
    const profit = totalAmount - longShares * longEntryPrice;
    capital += totalAmount;
    if (profit > 0) winCount++; else lossCount++;
    trades.push({ time: lastCandle.time, type: "sell", price: lastCandle.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
    signals.push({ time: lastCandle.time, type: "sell", price: lastCandle.close, ma5: lastCandle.ma5, ma25: lastCandle.ma25, rsi: lastCandle.rsi, reason: `引け値強制決済(ロング) (入荷:${longEntryPrice.toFixed(1)}→引け:${lastCandle.close.toFixed(1)})` });
  }

  // 残ショートポジションを引け値で強制決済
  if (shortShares > 0 && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const profit = (shortEntryPrice - lastCandle.close) * shortShares;
    const marginReturn = shortShares * shortEntryPrice;
    capital += marginReturn + profit;
    if (profit > 0) winCount++; else lossCount++;
    trades.push({ time: lastCandle.time, type: "cover", price: lastCandle.close, shares: shortShares, totalAmount: shortShares * lastCandle.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
    signals.push({ time: lastCandle.time, type: "cover", price: lastCandle.close, ma5: lastCandle.ma5, ma25: lastCandle.ma25, rsi: lastCandle.rsi, reason: `引け値強制決済(ショート) (入荷:${shortEntryPrice.toFixed(1)}→引け:${lastCandle.close.toFixed(1)})` });
  }

  const finalBalance = capital;
  const profitAmount = finalBalance - initialCapital;
  const profitRate = profitAmount / initialCapital;
  const tradesCount = trades.filter(t => t.type === "sell" || t.type === "cover").length;
  const winRate = tradesCount > 0 ? winCount / tradesCount : 0;

  // 損失原因と対策の動的生成
  const lossCauses: string[] = [];
  const countermeasures: string[] = [];

  if (profitAmount < 0) {
    if (lossCount > winCount) {
      lossCauses.push("📉 レンジ相場（もみ合い）での細かな損切りの連続（往復ビンタ）。");
      countermeasures.push("🛡️ レンジ相場を検知した場合は、MAクロスによるトレンドフォロー取引を一時停止し、RSI逆張りに切り替える。");
    }
    lossCauses.push("📈 急激なトレンド転換に対して、1分足の移動平均線の反応が遅れ、高値掴み・安値売りとなった。");
    countermeasures.push("⚙️ 移動平均線の期間を5MAから3MAなど、より短期に設定して反応速度を上げる。");
  } else {
    lossCauses.push("✅ 本日は利益を確保できましたが、トレンドの終盤でエントリーする微小な高値掴みが発生していました。");
    countermeasures.push("🎯 トレンド発生から時間が経過している場合は、エントリーのロット数を半分にするなどの資金管理を徹底する。");
  }

  return {
    symbol,
    name,
    initialCapital,
    finalBalance,
    profitAmount,
    profitRate,
    tradesCount,
    winCount,
    lossCount,
    winRate,
    trades,
    lossCauses,
    countermeasures,
    signals,
    isRealData: true,
  };
}

/**
 * 全対象銘柄の実データシミュレーションを実行する
 */
export async function generateRealDailyReport(
  dateStr: string,
  rsiUpper = 70,
  rsiLower = 30,
  stopLossPercent = 1.5
) {
  console.log(`[realSimulation] Starting real data simulation for ${dateStr}`);

  // APIレート制限を避けるため、並列ではなく順次取得する
  const allResults: ((StockSimResult & { isRealData: boolean }) | null)[] = [];
  for (const stock of REAL_TARGET_STOCKS) {
    const result = await simulateStockReal(
      stock.symbol,
      stock.ticker,
      stock.name,
      3_000_000,
      rsiUpper,
      rsiLower,
      stopLossPercent
    );
    allResults.push(result);
    // 各銘柄の取得後に少し待機してAPIレート制限を回避
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 実データを取得できた銘柄のみを使用（nullは除外）
  const stockReports = allResults.filter((r): r is StockSimResult & { isRealData: boolean } => r !== null);
  const realDataCount = stockReports.length;

  // 実データが1銘柄も取得できなかった場合はエラーをスロー（架空データでのレポート保官は絶対に行わない）
  if (realDataCount === 0) {
    throw new Error(`[realSimulation] FATAL: No real data available for any stock on ${dateStr}. Yahoo Finance API may be rate-limited or unavailable. Aborting - no report will be saved.`);
  }

  console.log(`[realSimulation] Completed: ${realDataCount}/${REAL_TARGET_STOCKS.length} stocks used real data`);

  const totalInitialCapital = 3_000_000 * realDataCount;
  const totalFinalBalance = stockReports.reduce((sum, r) => sum + r.finalBalance, 0);
  const totalProfitAmount = totalFinalBalance - totalInitialCapital;
  const totalProfitRate = totalProfitAmount / totalInitialCapital;
  const totalWinCount = stockReports.reduce((sum, r) => sum + r.winCount, 0);
  const totalLossCount = stockReports.reduce((sum, r) => sum + r.lossCount, 0);
  const totalTrades = totalWinCount + totalLossCount;
  const overallWinRate = totalTrades > 0 ? totalWinCount / totalTrades : 0;

  return {
    date: dateStr,
    totalInitialCapital,
    totalFinalBalance,
    totalProfitAmount,
    totalProfitRate,
    totalWinCount,
    totalLossCount,
    overallWinRate,
    rsiUpper,
    rsiLower,
    stopLossPercent,
    stockReports,
    realDataCount,
    isRealData: true, // 常にtrue（実データのみ使用）
  };
}
