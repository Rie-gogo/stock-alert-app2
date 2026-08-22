import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

type Board = { signal?: "buy_pressure" | "sell_pressure" | "neutral"; buyPressureRatio?: number };
type Candle = { tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: unknown };
type Trade = { tradeDate: string; candleTime: string; action: string; price: number; shares: number; pnl: number | null; reason: string };
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => { const sorted = [...xs].sort((a,b) => a-b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
const pct = (value: number, base: number) => (value / base - 1) * 100;
const board = (c: Candle): Board | null => typeof c.boardSnapshot === "string" ? JSON.parse(c.boardSnapshot) : c.boardSnapshot as Board | null;
const timeBand = (time: string) => time < "09:30" ? "09:00–09:29" : time < "10:30" ? "09:30–10:29" : time <= "11:27" ? "10:30–11:27" : time < "13:30" ? "12:30–13:29" : "13:30–15:30";

function cleanDays(candles: Candle[]) {
  const map = new Map<string, Candle[]>();
  for (const c of candles) {
    const day = map.get(c.tradeDate) ?? [];
    const prev = day.at(-1);
    if (!prev || !(c.low < prev.close * .5 || c.high > prev.close * 1.5)) day.push(c);
    map.set(c.tradeDate, day);
  }
  return [...map.values()].filter(day => day.length > 100).slice(-40);
}

function directionalStats(observations: Array<{ signal: string; bpr: number; ret5: number }>) {
  const signalRows = ["buy_pressure", "neutral", "sell_pressure"].map(signal => {
    const rows = observations.filter(x => x.signal === signal);
    return `${signal}: ${rows.length}本 / 5分後平均${mean(rows.map(x => x.ret5)).toFixed(3)}% / 上昇率${(rows.filter(x => x.ret5 > 0).length / Math.max(rows.length, 1) * 100).toFixed(1)}%`;
  });
  const bprRows = [[0, .8, "<0.8"], [.8, 1.2, "0.8–1.2"], [1.2, 1.5, "1.2–1.5"], [1.5, Infinity, "≥1.5"]].map(([min, max, label]) => {
    const rows = observations.filter(x => x.bpr >= Number(min) && x.bpr < Number(max));
    return `BPR${label}: ${rows.length}本 / 5分後平均${mean(rows.map(x => x.ret5)).toFixed(3)}% / 上昇率${(rows.filter(x => x.ret5 > 0).length / Math.max(rows.length, 1) * 100).toFixed(1)}%`;
  });
  return [...signalRows, ...bprRows];
}

async function main() {
  const db = await getDb(); if (!db) throw new Error("DB接続に失敗しました");
  const [candleResult, tradeResult, blockResult] = await Promise.all([
    db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume, boardSnapshot FROM rt_candles WHERE symbol='5803' ORDER BY tradeDate, candleTime`),
    db.execute(sql`SELECT tradeDate, tradeTime, action, price, shares, pnl, reason FROM rt_trades WHERE symbol='5803' ORDER BY tradeDate, tradeTime, id`),
    db.execute(sql`SELECT trade_date, candle_time, side, signal_reason, entry_price, board_score, confidence, context FROM rt_score0_blocks WHERE symbol='5803' ORDER BY trade_date, candle_time`),
  ]);
  const candles = (candleResult as unknown as [Array<Record<string, unknown>>])[0].map(r => ({
    tradeDate: String(r.tradeDate), candleTime: String(r.candleTime), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume), boardSnapshot: r.boardSnapshot,
  })) as Candle[];
  const trades = (tradeResult as unknown as [Array<Record<string, unknown>>])[0].map(r => ({ tradeDate:String(r.tradeDate), candleTime:String(r.tradeTime), action:String(r.action), price:Number(r.price), shares:Number(r.shares), pnl:r.pnl === null ? null : Number(r.pnl), reason:String(r.reason) })) as Trade[];
  const blocks = (blockResult as unknown as [Array<Record<string, unknown>>])[0];
  const days = cleanDays(candles);
  const daily = days.map(day => {
    const first = day[0], last = day.at(-1)!;
    const morning = day.filter(c => c.candleTime <= "11:27"), afternoon = day.filter(c => c.candleTime >= "12:30");
    const amMove = pct(morning.at(-1)!.close, first.open), pmMove = afternoon.length ? pct(afternoon.at(-1)!.close, afternoon[0].open) : 0;
    const high = day.reduce((a,c) => c.high > a.high ? c : a), low = day.reduce((a,c) => c.low < a.low ? c : a);
    return { date:first.tradeDate, range:pct(high.high, low.low), day:pct(last.close, first.open), am:amMove, pm:pmMove, highTime:high.candleTime, lowTime:low.candleTime, reversal:(amMove * pmMove < 0) };
  });
  const observations: Array<{ signal:string; bpr:number; ret5:number }> = [];
  for (const day of days) for (let i = 0; i + 5 < day.length; i++) {
    const b = board(day[i]); if (!b?.signal || b.buyPressureRatio === undefined) continue;
    observations.push({ signal:b.signal, bpr:b.buyPressureRatio, ret5:pct(day[i + 5].close, day[i].close) });
  }
  const highBands = new Map<string, number>(), lowBands = new Map<string, number>();
  for (const d of daily) { highBands.set(timeBand(d.highTime), (highBands.get(timeBand(d.highTime)) ?? 0) + 1); lowBands.set(timeBand(d.lowTime), (lowBands.get(timeBand(d.lowTime)) ?? 0) + 1); }
  console.log(`フジクラ（5803）: ${days[0][0].tradeDate}〜${days.at(-1)![0].tradeDate}、${days.length}営業日、KABUステーション保存1分足のみ`);
  console.log(`日中値幅: 平均${mean(daily.map(x=>x.range)).toFixed(2)}%、中央値${median(daily.map(x=>x.range)).toFixed(2)}% | 日中騰落: 上昇${daily.filter(x=>x.day>0).length}日/下落${daily.filter(x=>x.day<0).length}日`);
  console.log(`前場: 上昇${daily.filter(x=>x.am>0).length}日/下落${daily.filter(x=>x.am<0).length}日、平均${mean(daily.map(x=>x.am)).toFixed(2)}% | 後場: 上昇${daily.filter(x=>x.pm>0).length}日/下落${daily.filter(x=>x.pm<0).length}日、平均${mean(daily.map(x=>x.pm)).toFixed(2)}% | 前後場反転${daily.filter(x=>x.reversal).length}日`);
  console.log(`日中高値の時刻帯: ${[...highBands].map(([k,v])=>`${k}:${v}日`).join(" / ")}`);
  console.log(`日中安値の時刻帯: ${[...lowBands].map(([k,v])=>`${k}:${v}日`).join(" / ")}`);
  console.log("--- 板状態別の5分後リターン（分析用途。シグナルには未来情報を使用しない） ---");
  directionalStats(observations).forEach(x => console.log(x));
  console.log("--- 既存rt_trades（全50行。決済行のpnlで勝敗判定） ---");
  for (const trade of trades) console.log(`${trade.tradeDate} ${trade.candleTime} ${trade.action} ${trade.price} x${trade.shares} pnl=${trade.pnl ?? "-"} ${trade.reason}`);
  const exits = trades.filter(t => t.pnl !== null), wins = exits.filter(t => t.pnl! > 0);
  console.log(`既存決済: ${exits.length}件、${wins.length}勝${exits.length-wins.length}敗、勝率${(wins.length / Math.max(exits.length, 1) * 100).toFixed(1)}%、損益${exits.reduce((sum,t)=>sum+(t.pnl??0),0).toFixed(0)}円`);
  console.log(`--- score0ブロック: ${blocks.length}件 ---`);
  for (const x of blocks) console.log(`${x.trade_date} ${x.candle_time} ${x.side} score=${x.board_score} ${x.confidence} ${x.signal_reason} ${x.context ?? ""}`);
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
