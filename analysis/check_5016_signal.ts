import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger } from "../server/routers/stockData";

const data: any[] = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260625.json", "utf8"));
const rows5016 = data.filter(r => r.symbol === "5016").sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

const buffer: any[] = [];

for (const row of rows5016) {
  const c = {
    time: `${row.tradeDate}T${row.candleTime}:00`,
    dayKey: row.tradeDate,
    timestamp: new Date(`${row.tradeDate}T${row.candleTime}:00+09:00`).getTime(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null
  };
  buffer.push(c);

  const closes = buffer.map(x => x.close);
  const li = buffer.length - 1;
  const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25);
  const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
  buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li];
  buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li];
  buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

  // 10:25〜10:35のシグナルを全て表示
  if (buffer.length >= 30 && row.candleTime >= "10:25" && row.candleTime <= "10:35") {
    const ws = detectSignals(buffer);
    const latest = ws[ws.length - 1];
    if (latest.signal) {
      console.log(`${row.candleTime} | type: ${latest.signal.type} | reason: ${latest.signal.reason}`);
    }
  }
}
