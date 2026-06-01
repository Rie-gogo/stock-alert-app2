/**
 * stockData.ts
 * Yahoo Finance APIから実際の株価データを取得し、
 * テクニカル指標（MA5/MA25/RSI/BB）を計算してシグナル付きで返す
 */
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { callDataApi } from "../_core/dataApi";
import { TRPCError } from "@trpc/server";

// ---- テクニカル指標計算 ----

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result[i] = Math.round((slice.reduce((a, b) => a + b, 0) / period) * 10) / 10;
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
      result[i] = Math.round((100 - 100 / (1 + rs)) * 10) / 10;
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
  stdDev = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const middle: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    middle[i] = Math.round(avg * 10) / 10;
    upper[i] = Math.round((avg + stdDev * std) * 10) / 10;
    lower[i] = Math.round((avg - stdDev * std) * 10) / 10;
  }
  return { upper, middle, lower };
}

// ---- シグナル検出（アプリと同じロジック） ----
interface CandleWithSignal {
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
  bbMiddle: number | null;
  bbLower: number | null;
  signal?: { type: "buy" | "sell" | "warn"; reason: string };
}

function detectSignals(candles: CandleWithSignal[], rsiUpper = 70, rsiLower = 30): CandleWithSignal[] {
  const result = candles.map(c => ({ ...c }));

  for (let i = 1; i < result.length; i++) {
    const c = result[i];
    const prev = result[i - 1];

    const c5 = c.ma5, c25 = c.ma25, p5 = prev.ma5, p25 = prev.ma25;
    const cRsi = c.rsi, cBbu = c.bbUpper, cBbl = c.bbLower;

    if (c5 === null || c25 === null || p5 === null || p25 === null ||
        cRsi === null || cBbu === null || cBbl === null) continue;

    const isStrongDown = c5 < c25 && c.close < c5;
    const isStrongUp = c5 > c25 && c.close >= c5;

    // GCプロテクション（直近5本以内にGCがあれば売りシグナル抑制）
    let gcProtection = false;
    for (let j = Math.max(1, i - 4); j <= i; j++) {
      const rj = result[j], rjp = result[j - 1];
      if (rj.ma5 !== null && rj.ma25 !== null && rjp.ma5 !== null && rjp.ma25 !== null) {
        if (rjp.ma5 <= rjp.ma25 && rj.ma5 > rj.ma25) {
          gcProtection = true;
          break;
        }
      }
    }

    // 買いシグナル
    if (!isStrongDown) {
      if (p5 <= p25 && c5 > c25) {
        c.signal = { type: "buy", reason: `ゴールデンクロス (MA5:${c5} > MA25:${c25})` };
      } else if (cRsi <= rsiLower && c.close <= cBbl) {
        c.signal = { type: "buy", reason: `RSI売られすぎ(${cRsi}%) + BB下限タッチ` };
      }
    }

    // 売りシグナル
    if (p5 >= p25 && c5 < c25) {
      c.signal = { type: "sell", reason: `デッドクロス (MA5:${c5} < MA25:${c25})` };
    } else if (cRsi >= rsiUpper && c.close >= cBbu && !isStrongUp && !gcProtection) {
      c.signal = { type: "sell", reason: `RSI買われすぎ(${cRsi}%) + BB上限タッチ` };
    }
  }

  return result;
}

// ---- tRPCルーター ----
export const stockDataRouter = router({
  /**
   * 実際の株価データを取得（Yahoo Finance経由）
   * symbol: "9984.T" など
   * range: "1d" | "5d" | "1mo"
   * interval: "1m" | "5m" | "15m" | "1d"
   */
  getStockChart: publicProcedure
    .input(
      z.object({
        symbol: z.string().default("9984.T"),
        range: z.enum(["1d", "5d", "1mo"]).default("1d"),
        interval: z.enum(["1m", "5m", "15m", "1d"]).default("1m"),
        rsiUpper: z.number().min(50).max(90).default(70),
        rsiLower: z.number().min(10).max(50).default(30),
      })
    )
    .query(async ({ input }) => {
      let rawData: unknown;
      try {
        rawData = await callDataApi("YahooFinance/get_stock_chart", {
          query: {
            symbol: input.symbol,
            region: "JP",
            interval: input.interval,
            range: input.range,
            includeAdjustedClose: true,
          },
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Yahoo Finance APIの取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const data = rawData as {
        chart?: {
          result?: Array<{
            meta: {
              symbol: string;
              longName?: string;
              regularMarketPrice: number;
              previousClose?: number;
              regularMarketDayHigh?: number;
              regularMarketDayLow?: number;
              regularMarketVolume?: number;
              currency: string;
              exchangeName: string;
            };
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
          error?: { code: string; description: string };
        };
      };

      if (!data?.chart?.result?.[0]) {
        const errMsg = data?.chart?.error?.description ?? "データが見つかりません";
        throw new TRPCError({ code: "NOT_FOUND", message: errMsg });
      }

      const result = data.chart.result[0];
      const meta = result.meta;
      const timestamps = result.timestamp ?? [];
      const quotes = result.indicators.quote[0];

      // ローソク足データを構築（UTC→JST変換）
      const rawCandles: CandleWithSignal[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = quotes.open[i];
        const h = quotes.high[i];
        const l = quotes.low[i];
        const c = quotes.close[i];
        const v = quotes.volume[i];

        if (o === null || c === null) continue;

        // UTC timestamp → JST time string
        const d = new Date(timestamps[i] * 1000);
        const jstHour = (d.getUTCHours() + 9) % 24;
        const timeStr = `${String(jstHour).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

        rawCandles.push({
          time: timeStr,
          timestamp: timestamps[i] * 1000,
          open: Math.round((o ?? 0) * 10) / 10,
          high: Math.round((h ?? o ?? 0) * 10) / 10,
          low: Math.round((l ?? o ?? 0) * 10) / 10,
          close: Math.round((c ?? 0) * 10) / 10,
          volume: Math.round(v ?? 0),
          ma5: null,
          ma25: null,
          rsi: null,
          bbUpper: null,
          bbMiddle: null,
          bbLower: null,
        });
      }

      if (rawCandles.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "有効なローソク足データがありません" });
      }

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
        c.bbMiddle = bb.middle[i];
        c.bbLower = bb.lower[i];
      });

      // シグナル検出
      const candlesWithSignals = detectSignals(rawCandles, input.rsiUpper, input.rsiLower);

      // シグナルのみ抽出（サマリー用）
      const signals = candlesWithSignals
        .filter(c => c.signal)
        .map(c => ({
          time: c.time,
          timestamp: c.timestamp,
          type: c.signal!.type,
          reason: c.signal!.reason,
          price: c.close,
          rsi: c.rsi,
          ma5: c.ma5,
          ma25: c.ma25,
        }));

      // 前日比計算
      const lastClose = candlesWithSignals[candlesWithSignals.length - 1].close;
      const prevClose = meta.previousClose ?? lastClose;
      const priceChange = Math.round((lastClose - prevClose) * 10) / 10;
      const priceChangePercent = Math.round((priceChange / prevClose) * 1000) / 10;

      return {
        symbol: meta.symbol,
        name: meta.longName ?? meta.symbol,
        currency: meta.currency,
        exchange: meta.exchangeName,
        currentPrice: meta.regularMarketPrice,
        previousClose: prevClose,
        priceChange,
        priceChangePercent,
        dayHigh: meta.regularMarketDayHigh ?? 0,
        dayLow: meta.regularMarketDayLow ?? 0,
        volume: meta.regularMarketVolume ?? 0,
        candles: candlesWithSignals,
        signals,
        candleCount: candlesWithSignals.length,
      };
    }),

  /**
   * 銘柄検索（日本株）
   */
  searchSymbol: publicProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      // よく使われる日本株のリスト（検索補助用）
      const popularStocks = [
        { symbol: "9984.T", name: "ソフトバンクグループ" },
        { symbol: "7203.T", name: "トヨタ自動車" },
        { symbol: "6758.T", name: "ソニーグループ" },
        { symbol: "6861.T", name: "キーエンス" },
        { symbol: "9432.T", name: "NTT" },
        { symbol: "8306.T", name: "三菱UFJフィナンシャル" },
        { symbol: "6367.T", name: "ダイキン工業" },
        { symbol: "4063.T", name: "信越化学工業" },
        { symbol: "6954.T", name: "ファナック" },
        { symbol: "7974.T", name: "任天堂" },
        { symbol: "4519.T", name: "中外製薬" },
        { symbol: "9983.T", name: "ファーストリテイリング" },
        { symbol: "6098.T", name: "リクルートホールディングス" },
        { symbol: "7267.T", name: "本田技研工業" },
        { symbol: "8035.T", name: "東京エレクトロン" },
      ];

      const q = input.query.toLowerCase();
      return popularStocks.filter(
        s => s.name.includes(input.query) || s.symbol.toLowerCase().includes(q)
      );
    }),
});
