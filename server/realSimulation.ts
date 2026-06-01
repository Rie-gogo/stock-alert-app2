/**
 * realSimulation.ts
 * Yahoo Finance の実際の株価データを使ったシミュレーションエンジン
 * simulation.ts の架空データ生成を置き換える
 */
import { callDataApi } from "./_core/dataApi";
import type { StockSimResult, TradeRecord } from "./simulation";

// 対象銘柄のYahoo Finance ティッカーマッピング
export const REAL_TARGET_STOCKS = [
  { symbol: "6526", ticker: "6526.T", name: "ソシオネクスト" },
  { symbol: "6920", ticker: "6920.T", name: "レーザーテック" },
  { symbol: "6857", ticker: "6857.T", name: "アドバンテスト" },
  { symbol: "9107", ticker: "9107.T", name: "川崎汽船" },
  { symbol: "8306", ticker: "8306.T", name: "三菱UFJ FG" },
  { symbol: "9984", ticker: "9984.T", name: "ソフトバンクグループ" },
  { symbol: "8035", ticker: "8035.T", name: "東京エレクトロン" },
  { symbol: "7011", ticker: "7011.T", name: "三菱重工業" },
  { symbol: "4568", ticker: "4568.T", name: "第一三共" },
  { symbol: "3778", ticker: "3778.T", name: "さくらインターネット" },
];

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
 */
async function fetchRealCandles(ticker: string): Promise<RealCandle[] | null> {
  try {
    const rawData = await callDataApi("YahooFinance/get_stock_chart", {
      query: {
        symbol: ticker,
        region: "JP",
        interval: "1m",
        range: "1d",
        includeAdjustedClose: true,
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
): Promise<StockSimResult & { isRealData: boolean }> {
  const candles = await fetchRealCandles(ticker);

  // 実データ取得失敗時は架空データにフォールバック
  if (!candles) {
    console.warn(`[realSimulation] Falling back to simulated data for ${ticker}`);
    const { simulateStock } = await import("./simulation");
    const today = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    return { ...simulateStock(symbol, name, initialCapital, rsiUpper, rsiLower, stopLossPercent, dateSeed), isRealData: false };
  }

  // シミュレーション実行
  const trades: TradeRecord[] = [];
  let capital = initialCapital;
  let positionShares = 0;
  let positionPrice = 0;
  let winCount = 0;
  let lossCount = 0;

  const stopLossRatio = 1 - stopLossPercent / 100;

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    if (
      curr.rsi === null || curr.ma5 === null || curr.ma25 === null ||
      curr.bbLower === null || curr.bbUpper === null ||
      prev.ma5 === null || prev.ma25 === null
    ) continue;

    const isStrongDown = curr.ma5 < curr.ma25 && curr.close < curr.ma5;
    const isStrongUp = curr.ma5 > curr.ma25 * 1.003 && curr.close >= curr.ma5;

    // GCプロテクション（直近5本以内にGCがあれば売りシグナル抑制）
    let gcProtection = false;
    for (let j = Math.max(1, i - 4); j <= i; j++) {
      const rj = candles[j], rjp = candles[j - 1];
      if (rj.ma5 !== null && rj.ma25 !== null && rjp.ma5 !== null && rjp.ma25 !== null) {
        if (rjp.ma5 <= rjp.ma25 && rj.ma5 > rj.ma25) {
          gcProtection = true;
          break;
        }
      }
    }

    // 買いシグナル
    const isGoldenCross = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    const isRsiOversold = curr.rsi <= rsiLower;
    const isBbLower = curr.close <= curr.bbLower;
    const shouldBuy = !isStrongDown && (isGoldenCross || (isRsiOversold && isBbLower));

    if (positionShares === 0 && shouldBuy) {
      const maxSpend = capital * 0.98;
      const shares = Math.floor(maxSpend / curr.close / 100) * 100; // 100株単位
      if (shares > 0) {
        const totalAmount = shares * curr.close;
        positionShares = shares;
        positionPrice = curr.close;
        capital -= totalAmount;
        trades.push({
          time: curr.time,
          type: "buy",
          price: curr.close,
          shares,
          totalAmount,
        });
      }
    }

    // 売りシグナル
    const isDeadCross = prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25;
    const isRsiOverbought = curr.rsi >= rsiUpper;
    const isBbUpper = curr.close >= curr.bbUpper;
    const shouldSell =
      isDeadCross ||
      (isRsiOverbought && isBbUpper && !isStrongUp && !gcProtection);
    const isStopLoss = positionShares > 0 && curr.close <= positionPrice * stopLossRatio;

    if (positionShares > 0 && (shouldSell || isStopLoss)) {
      const totalAmount = positionShares * curr.close;
      const profit = totalAmount - positionShares * positionPrice;
      const profitRate = (curr.close - positionPrice) / positionPrice;
      capital += totalAmount;

      if (profit > 0) winCount++;
      else lossCount++;

      trades.push({
        time: curr.time,
        type: "sell",
        price: curr.close,
        shares: positionShares,
        totalAmount,
        profit,
        profitRate,
      });

      positionShares = 0;
      positionPrice = 0;
    }
  }

  // 残ポジションを引け値で強制決済
  if (positionShares > 0 && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const totalAmount = positionShares * lastCandle.close;
    const profit = totalAmount - positionShares * positionPrice;
    const profitRate = (lastCandle.close - positionPrice) / positionPrice;
    capital += totalAmount;
    if (profit > 0) winCount++;
    else lossCount++;
    trades.push({
      time: lastCandle.time,
      type: "sell",
      price: lastCandle.close,
      shares: positionShares,
      totalAmount,
      profit,
      profitRate,
    });
  }

  const finalBalance = capital;
  const profitAmount = finalBalance - initialCapital;
  const profitRate = profitAmount / initialCapital;
  const tradesCount = trades.filter(t => t.type === "sell").length;
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

  const stockReports = await Promise.all(
    REAL_TARGET_STOCKS.map(stock =>
      simulateStockReal(
        stock.symbol,
        stock.ticker,
        stock.name,
        3_000_000,
        rsiUpper,
        rsiLower,
        stopLossPercent
      )
    )
  );

  const totalInitialCapital = 3_000_000 * REAL_TARGET_STOCKS.length;
  const totalFinalBalance = stockReports.reduce((sum, r) => sum + r.finalBalance, 0);
  const totalProfitAmount = totalFinalBalance - totalInitialCapital;
  const totalProfitRate = totalProfitAmount / totalInitialCapital;
  const totalWinCount = stockReports.reduce((sum, r) => sum + r.winCount, 0);
  const totalLossCount = stockReports.reduce((sum, r) => sum + r.lossCount, 0);
  const totalTrades = totalWinCount + totalLossCount;
  const overallWinRate = totalTrades > 0 ? totalWinCount / totalTrades : 0;

  const realDataCount = stockReports.filter(r => r.isRealData).length;
  console.log(`[realSimulation] Completed: ${realDataCount}/${REAL_TARGET_STOCKS.length} stocks used real data`);

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
    isRealData: realDataCount > 0,
  };
}
