import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

type Candle = { tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number };
type Candidate = { date: string; time: string; side: "long" | "short"; price: number; exitTime: string; exitPrice: number; pnlPerShare: number; outcome: string };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (a: number, b: number) => (a / b - 1) * 100;

function cleanCandles(raw: Candle[]) {
  const byDate = new Map<string, Candle[]>();
  for (const candle of raw) (byDate.get(candle.tradeDate) ?? byDate.set(candle.tradeDate, []).get(candle.tradeDate)!).push(candle);
  const cleaned = new Map<string, Candle[]>();
  for (const [date, list] of byDate) {
    const valid: Candle[] = [];
    for (const candle of list) {
      const prev = valid.at(-1);
      if (prev && (candle.low < prev.close * 0.5 || candle.high > prev.close * 1.5)) continue;
      valid.push(candle);
    }
    cleaned.set(date, valid);
  }
  return cleaned;
}

function resolveExit(day: Candle[], index: number, side: "long" | "short", slPct: number, tpPct: number, forceTime: string): Omit<Candidate, "date" | "time" | "side" | "price"> {
  const entry = day[index].close;
  const sl = side === "long" ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const tp = side === "long" ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  for (let i = index + 1; i < day.length; i++) {
    const c = day[i];
    if (c.candleTime > forceTime) break;
    const hitSl = side === "long" ? c.low <= sl : c.high >= sl;
    const hitTp = side === "long" ? c.high >= tp : c.low <= tp;
    if (hitSl) return { exitTime: c.candleTime, exitPrice: sl, pnlPerShare: side === "long" ? sl - entry : entry - sl, outcome: "SL" };
    if (hitTp) return { exitTime: c.candleTime, exitPrice: tp, pnlPerShare: side === "long" ? tp - entry : entry - tp, outcome: "TP" };
  }
  const forced = [...day].reverse().find((c) => c.candleTime <= forceTime) ?? day.at(-1)!;
  return { exitTime: forced.candleTime, exitPrice: forced.close, pnlPerShare: side === "long" ? forced.close - entry : entry - forced.close, outcome: "時間決済" };
}

function maSlope(day: Candle[], index: number) {
  if (index < 9) return Number.NaN;
  return pct(mean(day.slice(index - 7, index + 1).map((x) => x.close)), mean(day.slice(index - 9, index - 1).map((x) => x.close)));
}

function evaluateShort(day: Candle[], risePct: number, peakDropPct: number, lowLookback: number, slopeMax: number) {
  const open = day[0].open;
  let dayHigh = -Infinity;
  for (let i = 0; i < day.length; i++) {
    const c = day[i]; dayHigh = Math.max(dayHigh, c.high);
    if (c.candleTime < "09:45" || c.candleTime > "11:27" || i < Math.max(20, lowLookback + 1)) continue;
    const prior = day.slice(i - lowLookback, i);
    const isSignal = pct(dayHigh, open) >= risePct && pct(dayHigh, c.close) >= peakDropPct &&
      maSlope(day, i) <= slopeMax && c.close < Math.min(...prior.map((x) => x.low)) && c.close < c.open;
    if (isSignal) {
      const exit = resolveExit(day, i, "short", 0.8, 1.5, "11:27");
      return { date: c.tradeDate, time: c.candleTime, side: "short" as const, price: c.close, ...exit };
    }
  }
  return null;
}

function evaluateLong(day: Candle[], drawdownPct: number, highLookback: number, slopeMin: number) {
  let dayHigh = -Infinity;
  for (let i = 0; i < day.length; i++) {
    const c = day[i]; dayHigh = Math.max(dayHigh, c.high);
    if (c.candleTime < "12:30" || c.candleTime > "14:20" || i < Math.max(20, highLookback + 1)) continue;
    const prior = day.slice(i - highLookback, i);
    const priorHigh = Math.max(...prior.map((x) => x.high));
    const wasPulledBack = day.slice(0, i).some((x) => pct(dayHigh, x.close) >= drawdownPct);
    const isSignal = wasPulledBack && pct(dayHigh, c.close) <= -0.01 && maSlope(day, i) >= slopeMin && c.close > priorHigh && c.close > c.open;
    if (isSignal) {
      const exit = resolveExit(day, i, "long", 0.8, 0.5, "15:25");
      return { date: c.tradeDate, time: c.candleTime, side: "long" as const, price: c.close, ...exit };
    }
  }
  return null;
}

function evaluatePeakReversalShort(day: Candle[], risePct: number, peakDropPct: number, bodyMin: number, volumeMin: number) {
  const open = day[0].open;
  let dayHigh = -Infinity;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; dayHigh = Math.max(dayHigh, c.high);
    if (c.candleTime < "09:45" || c.candleTime > "11:27") continue;
    const volRatio = c.volume / mean(day.slice(i - 20, i).map((x) => x.volume));
    const redBody = -pct(c.close, c.open);
    const recentPeak = Math.max(...day.slice(Math.max(0, i - 2), i + 1).map((x) => x.high));
    const signal = pct(dayHigh, open) >= risePct && pct(dayHigh, c.close) >= peakDropPct &&
      redBody >= bodyMin && volRatio >= volumeMin && recentPeak === dayHigh;
    if (signal) {
      const exit = resolveExit(day, i, "short", 0.8, 1.5, "11:27");
      return { date: c.tradeDate, time: c.candleTime, side: "short" as const, price: c.close, ...exit };
    }
  }
  return null;
}

function evaluatePullbackReboundLong(day: Candle[], drawdownPct: number, reboundPct: number, slopeMin: number) {
  let dayHigh = -Infinity;
  let pullbackLow = Infinity;
  let pulledBack = false;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; dayHigh = Math.max(dayHigh, c.high);
    if (pct(dayHigh, c.close) >= drawdownPct) {
      pulledBack = true;
      pullbackLow = Math.min(pullbackLow, c.low);
    }
    if (c.candleTime < "12:30" || c.candleTime > "14:20" || !pulledBack) continue;
    const rebound = pct(c.close, pullbackLow);
    const signal = rebound >= reboundPct && maSlope(day, i) >= slopeMin && c.close > c.open;
    if (signal) {
      const exit = resolveExit(day, i, "long", 0.8, 0.5, "15:25");
      return { date: c.tradeDate, time: c.candleTime, side: "long" as const, price: c.close, ...exit };
    }
  }
  return null;
}

function evaluateAfternoonRecoveryLong(day: Candle[], dayDrawdownPct: number, pmDropPct: number, reboundPct: number, slopeMin: number) {
  let dayHigh = -Infinity;
  let pmHigh = -Infinity;
  let pmLow = Infinity;
  let pmLowIndex = -1;
  let pmPulledBack = false;
  for (let i = 20; i < day.length; i++) {
    const c = day[i];
    dayHigh = Math.max(dayHigh, c.high);
    if (c.candleTime < "12:30") continue;
    pmHigh = Math.max(pmHigh, c.high);
    if (c.low < pmLow) {
      pmLow = c.low;
      pmLowIndex = i;
    }
    if (pct(pmHigh, c.close) >= pmDropPct) pmPulledBack = true;
    if (c.candleTime > "14:20" || !pmPulledBack || i - pmLowIndex < 2) continue;
    const signal = pct(dayHigh, c.close) >= dayDrawdownPct && pct(c.close, pmLow) >= reboundPct &&
      maSlope(day, i) >= slopeMin && c.close > c.open;
    if (signal) {
      const exit = resolveExit(day, i, "long", 0.8, 0.5, "15:25");
      return { date: c.tradeDate, time: c.candleTime, side: "long" as const, price: c.close, ...exit };
    }
  }
  return null;
}

function summary(items: Candidate[]) {
  const wins = items.filter((x) => x.pnlPerShare > 0).length;
  const pnl = items.reduce((s, x) => s + x.pnlPerShare * 100, 0);
  const grossWin = items.filter((x) => x.pnlPerShare > 0).reduce((s, x) => s + x.pnlPerShare * 100, 0);
  const grossLoss = -items.filter((x) => x.pnlPerShare < 0).reduce((s, x) => s + x.pnlPerShare * 100, 0);
  return { count: items.length, wins, rate: items.length ? wins / items.length * 100 : 0, pnl, pf: grossLoss ? grossWin / grossLoss : Infinity };
}

async function main() {
  const db = await getDb(); if (!db) throw new Error("DB接続に失敗しました");
  const result = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate, candleTime`);
  const raw = ((result as any)[0] as any[]).map((x) => ({ ...x, open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close), volume: Number(x.volume) })) as Candle[];
  const all = cleanCandles(raw);
  const dates = [...all.keys()].sort().slice(-40);
  const days = dates.map((d) => all.get(d)!).filter((d) => d.length >= 50);

  const shortRows: any[] = [];
  for (const rise of [2.0, 2.5, 3.0, 3.5]) for (const drop of [0.4, 0.6, 0.8, 1.0]) for (const lb of [3, 5]) for (const slope of [0, -0.02, -0.05]) {
    const trades = days.map((d) => evaluateShort(d, rise, drop, lb, slope)).filter(Boolean) as Candidate[];
    const s = summary(trades); const ideal = trades.find((x) => x.date === "2026-08-19" && x.time >= "10:05" && x.time <= "10:15");
    if (ideal) shortRows.push({ rise, drop, lb, slope, ...s, ideal: ideal.time, trades });
  }
  const longRows: any[] = [];
  for (const dd of [1.0, 1.3, 1.5, 2.0]) for (const lb of [3, 5, 10]) for (const slope of [0, 0.02, 0.05]) {
    const trades = days.map((d) => evaluateLong(d, dd, lb, slope)).filter(Boolean) as Candidate[];
    const s = summary(trades); const ideal = trades.find((x) => x.date === "2026-08-19" && x.time >= "12:40" && x.time <= "13:05");
    if (ideal) longRows.push({ dd, lb, slope, ...s, ideal: ideal.time, trades });
  }
  const rank = (a: any, b: any) => b.pnl - a.pnl || b.rate - a.rate;
  console.log(`8035品質調整済み直近40営業日: ${dates[0]}〜${dates.at(-1)} (${days.length}日)`);
  console.log("\n--- 8/19理想SHORT(10:05〜10:15)を捉える候補: 損益上位10 ---");
  shortRows.sort(rank).slice(0, 10).forEach((r) => console.log(`rise${r.rise}% drop${r.drop}% low${r.lb} slope<=${r.slope}%: ${r.count}件 ${r.wins}勝${r.count-r.wins}敗 勝率${r.rate.toFixed(1)}% ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}円 PF${r.pf.toFixed(2)} 8/19=${r.ideal}`));
  console.log("\n--- 8/19理想LONG(12:40〜13:05)を捉える候補: 損益上位10 ---");
  longRows.sort(rank).slice(0, 10).forEach((r) => console.log(`dd${r.dd}% high${r.lb} slope>=${r.slope}%: ${r.count}件 ${r.wins}勝${r.count-r.wins}敗 勝率${r.rate.toFixed(1)}% ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}円 PF${r.pf.toFixed(2)} 8/19=${r.ideal}`));
  console.log("\n--- 最上位候補の取引明細 ---");
  for (const [label, row] of [["SHORT", shortRows.sort(rank)[0]], ["LONG", longRows.sort(rank)[0]]] as const) {
    if (!row) continue;
    console.log(`${label}:`);
    row.trades.forEach((t: Candidate) => console.log(`  ${t.date} ${t.time} ${t.side} @${t.price.toFixed(0)}→${t.exitTime} @${t.exitPrice.toFixed(0)} ${t.outcome} ${t.pnlPerShare >= 0 ? "+" : ""}${(t.pnlPerShare * 100).toFixed(0)}円`));
  }
  const peakRows: any[] = [];
  for (const rise of [2.0, 2.5, 3.0]) for (const drop of [0.3, 0.4, 0.5, 0.6]) for (const body of [0.1, 0.2, 0.3]) for (const vol of [1.0, 1.5, 2.0, 5.0]) {
    const trades = days.map((d) => evaluatePeakReversalShort(d, rise, drop, body, vol)).filter(Boolean) as Candidate[];
    const s = summary(trades); const ideal = trades.find((x) => x.date === "2026-08-19" && x.time >= "10:05" && x.time <= "10:15");
    if (ideal) peakRows.push({ rise, drop, body, vol, ...s, ideal: ideal.time, trades });
  }
  const reboundRows: any[] = [];
  for (const dd of [1.0, 1.3, 1.5, 2.0]) for (const rebound of [0.1, 0.2, 0.3, 0.5]) for (const slope of [-0.02, 0, 0.02]) {
    const trades = days.map((d) => evaluatePullbackReboundLong(d, dd, rebound, slope)).filter(Boolean) as Candidate[];
    const s = summary(trades); const ideal = trades.find((x) => x.date === "2026-08-19" && x.time >= "12:40" && x.time <= "13:05");
    if (ideal) reboundRows.push({ dd, rebound, slope, ...s, ideal: ideal.time, trades });
  }
  const afternoonRows: any[] = [];
  for (const dayDd of [1.0, 1.3, 1.5, 2.0]) for (const pmDrop of [0.3, 0.4, 0.5, 0.6]) for (const rebound of [0.1, 0.2, 0.3]) for (const slope of [-0.02, 0, 0.02]) {
    const trades = days.map((d) => evaluateAfternoonRecoveryLong(d, dayDd, pmDrop, rebound, slope)).filter(Boolean) as Candidate[];
    const s = summary(trades); const ideal = trades.find((x) => x.date === "2026-08-19" && x.time >= "12:40" && x.time <= "13:05");
    if (ideal) afternoonRows.push({ dayDd, pmDrop, rebound, slope, ...s, ideal: ideal.time, trades });
  }
  const august19 = days.find((day) => day[0].tradeDate === "2026-08-19");
  if (august19) console.log(`\n--- 8/19 後場押し目反発LONG例 ---\ndayDd1.3% pmDrop0.3% rebound0.2% slope>=0% => ${(() => { const t = evaluateAfternoonRecoveryLong(august19, 1.3, 0.3, 0.2, 0); return t ? `${t.time} @${t.price}` : "未発火"; })()}`);
  console.log("\n--- 高値反転SHORT（8/19 10:05〜10:15を捉える）損益上位10 ---");
  peakRows.sort(rank).slice(0, 10).forEach((r) => console.log(`rise${r.rise}% drop${r.drop}% body${r.body}% vol${r.vol}x: ${r.count}件 ${r.wins}勝${r.count-r.wins}敗 勝率${r.rate.toFixed(1)}% ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}円 PF${r.pf.toFixed(2)} 8/19=${r.ideal}`));
  console.log("\n--- 押し目反発LONG（8/19 12:40〜13:05を捉える）損益上位10 ---");
  reboundRows.sort(rank).slice(0, 10).forEach((r) => console.log(`dd${r.dd}% rebound${r.rebound}% slope>=${r.slope}%: ${r.count}件 ${r.wins}勝${r.count-r.wins}敗 勝率${r.rate.toFixed(1)}% ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}円 PF${r.pf.toFixed(2)} 8/19=${r.ideal}`));
  console.log("\n--- 後場局所押し目反発LONG（8/19 12:40〜13:05を捉える）損益上位10 ---");
  afternoonRows.sort(rank).slice(0, 10).forEach((r) => console.log(`dayDd${r.dayDd}% pmDrop${r.pmDrop}% rebound${r.rebound}% slope>=${r.slope}%: ${r.count}件 ${r.wins}勝${r.count-r.wins}敗 勝率${r.rate.toFixed(1)}% ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}円 PF${r.pf.toFixed(2)} 8/19=${r.ideal}`));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
