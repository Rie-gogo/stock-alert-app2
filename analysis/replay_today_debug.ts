/**
 * replay_today_debug.ts
 * デバッグ用: シグナル検出のみ確認（フィルターなし）
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/replay_today_debug.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";

const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const MIN_CANDLES_FOR_SIGNAL = 30;

interface RtCandleRow {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

const dataPath = "/tmp/rt_candles_20260625.json";
const candles: RtCandleRow[] = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// 銘柄ごとにグループ化
const bySymbol = new Map<string, RtCandleRow[]>();
for (const c of candles) {
  if (!ALLOWED_SYMBOLS.has(c.symbol)) continue;
  if (c.candleTime >= "11:30" && c.candleTime < "12:30") continue;
  if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
  bySymbol.get(c.symbol)!.push(c);
}

console.log(`銘柄数: ${bySymbol.size}`);
let totalSignals = 0;

for (const [symbol, rows] of bySymbol.entries()) {
  const sorted = rows.sort((a, b) => a.candleTime < b.candleTime ? -1 : 1);
  const buffer: CandleWithSignal[] = [];
  let signalCount = 0;

  for (const row of sorted) {
    buffer.push({
      time: `${row.tradeDate}T${row.candleTime}:00`,
      dayKey: row.tradeDate,
      timestamp: new Date(`${row.tradeDate}T${row.candleTime}:00+09:00`).getTime(),
      open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
      ma5: null, ma25: null, rsi: null,
      bbUpper: null, bbMiddle: null, bbLower: null,
    });

    const closes = buffer.map(c => c.close);
    const ma5S = calcMA(closes, 5);
    const ma25S = calcMA(closes, 25);
    const rsiS = calcRSI(closes, 14);
    const bbS = calcBollinger(closes, 20);
    const li = buffer.length - 1;
    buffer[li].ma5 = ma5S[li];
    buffer[li].ma25 = ma25S[li];
    buffer[li].rsi = rsiS[li];
    buffer[li].bbUpper = bbS.upper[li];
    buffer[li].bbMiddle = bbS.middle[li];
    buffer[li].bbLower = bbS.lower[li];

    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    const withSignals = detectSignals(buffer);
    const latest = withSignals[withSignals.length - 1];
    buffer[buffer.length - 1] = latest;

    if (latest.signal && row.candleTime >= "09:30" && row.candleTime < "15:15") {
      signalCount++;
      totalSignals++;
      if (signalCount <= 5) {
        const stockName = TARGET_STOCKS.find(s => s.symbol === symbol)?.name ?? symbol;
        console.log(`  ${symbol} ${stockName} ${row.candleTime} ${latest.signal.type} [${latest.signal.reason.slice(0, 60)}]`);
      }
    }
  }

  if (signalCount > 0) {
    const stockName = TARGET_STOCKS.find(s => s.symbol === symbol)?.name ?? symbol;
    console.log(`${symbol} ${stockName}: ${signalCount}シグナル (${sorted.length}本)`);
  }
}

console.log(`\n合計シグナル数: ${totalSignals}`);
