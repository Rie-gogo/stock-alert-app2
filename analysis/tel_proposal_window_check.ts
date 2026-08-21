import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

type C = { tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number };
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const pct = (a: number, b: number) => (a / b - 1) * 100;
const slope = (d: C[], i: number) => pct(mean(d.slice(i - 7, i + 1).map(c => c.close)), mean(d.slice(i - 9, i - 1).map(c => c.close)));

type Hit = { time: string; signal: string; price: number };
function proposedHits(day: C[]): Hit[] {
  const hits: Hit[] = [];
  const open = day[0].open;
  let dayHigh = -Infinity;
  for (let i = 20; i < day.length; i++) {
    const c = day[i]; dayHigh = Math.max(dayHigh, c.high);
    if (c.candleTime >= "10:00" && c.candleTime <= "11:27") {
      const prior20 = day.slice(i - 20, i), prior5 = day.slice(i - 5, i);
      const vol = c.volume / mean(prior20.map(x => x.volume));
      const gain = pct(c.close, open), drop = -gain;
      if (gain >= 1.5 && gain <= 2.5 && slope(day, i) >= 0.02 && c.close > Math.max(...prior20.map(x => x.high)) && c.close > c.open && vol >= 1.0) hits.push({ time: c.candleTime, signal: "順張りLONG", price: c.close });
      if (drop >= 0.5 && drop <= 4.0 && slope(day, i) <= -0.02 && c.close < Math.min(...prior5.map(x => x.low)) && c.close < c.open && vol >= 1.2) hits.push({ time: c.candleTime, signal: "下落継続SHORT", price: c.close });
      const body = -pct(c.close, c.open);
      if (pct(dayHigh, open) >= 2.5 && pct(dayHigh, c.close) >= 0.4 && body >= 0.1 && vol >= 1.0 && Math.max(...day.slice(Math.max(0, i - 2), i + 1).map(x => x.high)) === dayHigh) hits.push({ time: c.candleTime, signal: "高値反転SHORT", price: c.close });
    }
  }
  return hits;
}
async function main() {
  const db = await getDb(); if (!db) throw new Error("DB接続に失敗しました");
  const rows = ((await db.execute(sql`SELECT tradeDate,candleTime,open,high,low,close,volume FROM rt_candles WHERE symbol='8035' AND tradeDate IN ('2026-08-19','2026-08-20','2026-08-21') ORDER BY tradeDate,candleTime`)) as any)[0] as any[];
  const map = new Map<string, C[]>();
  for (const r of rows) { const c = { ...r, open:Number(r.open), high:Number(r.high), low:Number(r.low), close:Number(r.close), volume:Number(r.volume) }; (map.get(c.tradeDate) ?? map.set(c.tradeDate, []).get(c.tradeDate)!).push(c); }
  const checks = [
    ["2026-08-19", "09:30", "09:40", "LONG・東京エレクトロン"],
    ["2026-08-20", "10:05", "10:15", "SHORT・東京エレクトロン"],
    ["2026-08-20", "12:40", "13:05", "LONG・東京エレクトロン"],
    ["2026-08-21", "10:07", "10:38", "LONG・東京エレクトロン"],
  ] as const;
  for (const [date, start, end, label] of checks) {
    const day = map.get(date)!; const hits = proposedHits(day); const inWindow = hits.filter(x => x.time >= start && x.time <= end);
    console.log(`${date} ${label} ${start}〜${end}: ${inWindow.length ? inWindow.map(x => `${x.time} ${x.signal} @${x.price}`).join(" / ") : "発火なし"}`);
    console.log(`  当日の提案3方式全候補: ${hits.length ? hits.map(x => `${x.time} ${x.signal}`).join(" / ") : "なし"}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
