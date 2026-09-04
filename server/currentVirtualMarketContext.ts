import { getRtCandles } from "./db";
import { analyzeOrderBook, type KabuOrderBook } from "./kabuStation";
import type { RtCandle1Min } from "./realtimeSimEngine";
import {
  calcBollinger,
  calcMA,
  calcRSI,
  detectSignals,
  type CandleWithSignal,
} from "./routers/stockData";

export type CurrentRawSignal = {
  type: "buy" | "sell" | "warn";
  reason: string;
} | null;

export type CurrentBoardExitSignal =
  | "neutral"
  | "buy_pressure"
  | "sell_pressure"
  | "large_buy_wall"
  | "large_sell_wall"
  | "market_surge";

function toSignalCandles(input: RtCandle1Min, priorRows: Awaited<ReturnType<typeof getRtCandles>>): CandleWithSignal[] {
  // 再試行時に後続足・訂正足を混ぜない。現在時刻より前の保存足と、当該source eventのpayloadだけを使う。
  const rows: CandleWithSignal[] = priorRows
    .filter(row => row.candleTime < input.candleTime)
    .map(row => ({
      time: `${row.tradeDate}T${row.candleTime}:00`,
      dayKey: row.tradeDate,
      timestamp: new Date(`${row.tradeDate}T${row.candleTime}:00+09:00`).getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume ?? 0,
      ma5: null,
      ma25: null,
      rsi: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
    }));
  rows.push({
    time: `${input.tradeDate}T${input.candleTime}:00`,
    dayKey: input.tradeDate,
    timestamp: new Date(`${input.tradeDate}T${input.candleTime}:00+09:00`).getTime(),
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume,
    ma5: null,
    ma25: null,
    rsi: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  });

  const closes = rows.map(row => row.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20);
  rows.forEach((row, index) => {
    row.ma5 = ma5[index];
    row.ma25 = ma25[index];
    row.rsi = rsi[index];
    row.bbUpper = bb.upper[index];
    row.bbMiddle = bb.middle[index];
    row.bbLower = bb.lower[index];
  });
  return rows;
}

/** 現行engineの当日バッファ復元と同じ計算を、監査専用に保存足から再現する。 */
export async function deriveCurrentRawSignalForEvent(candle: RtCandle1Min): Promise<CurrentRawSignal> {
  const priorRows = await getRtCandles(candle.symbol, candle.tradeDate);
  const latest = detectSignals(toSignalCandles(candle, priorRows)).at(-1)?.signal;
  if (!latest) return null;
  return { type: latest.type, reason: latest.reason };
}

/** relayが当該足と同時送信したboardだけから、現行と同じ優先順で板signalを再構成する。 */
export function deriveCurrentBoardExitSignal(
  symbol: string,
  board: Omit<KabuOrderBook, "symbol" | "receivedAt"> | null,
): CurrentBoardExitSignal {
  if (!board) return "neutral";
  const signals = analyzeOrderBook({ ...board, symbol, receivedAt: 0 });
  if (signals.some(signal => signal.type === "board_buy_pressure")) return "buy_pressure";
  if (signals.some(signal => signal.type === "board_sell_pressure")) return "sell_pressure";
  if (signals.some(signal => signal.type === "large_bid_wall")) return "large_buy_wall";
  if (signals.some(signal => signal.type === "large_ask_wall")) return "large_sell_wall";
  if (signals.some(signal => signal.type === "market_order_surge")) return "market_surge";
  return "neutral";
}
