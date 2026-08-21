import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number };
type Side = 'LONG' | 'SHORT';
type Candidate = { date: string; time: string; index: number; side: Side; strategy: string; entry: number; candles: Candle[] };
type Trade = Candidate & { exitTime: string; exitReason: string; pnl: number };
const CAPITAL = 3_000_000; const LOT_RATIO = 0.9;
const SAFE_CB = [{ date: '2026-07-07', time: '09:43', entry: 75660 }, { date: '2026-07-07', time: '10:13', entry: 74570 }, { date: '2026-07-13', time: '09:49', entry: 73240 }, { date: '2026-08-07', time: '10:15', entry: 45770 }];

function shares(price: number) { return Math.max(100, Math.floor(Math.floor(CAPITAL * LOT_RATIO / price) / 100) * 100); }
function sma(cs: Candle[], i: number, p: number) { return i - p + 1 < 0 ? null : cs.slice(i - p + 1, i + 1).reduce((s, c) => s + c.close, 0) / p; }
function vol(cs: Candle[], i: number) { if (i < 20) return 0; const a = cs.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20; return a ? cs[i].volume / a : 0; }
function entryWindow(t: string) { return (t >= '09:45' && t <= '11:27') || (t >= '12:50' && t <= '14:20'); }
function exit(c: Candidate): Trade {
  const sl = c.side === 'LONG' ? 0.6 : 0.8; const tp = c.side === 'LONG' ? 0.8 : 1.2; const amount = shares(c.entry);
  const stop = c.side === 'LONG' ? c.entry * (1 - sl / 100) : c.entry * (1 + sl / 100);
  const target = c.side === 'LONG' ? c.entry * (1 + tp / 100) : c.entry * (1 - tp / 100);
  const end = c.time <= '11:27' ? '11:27' : '14:20';
  for (let i = c.index + 1; i < c.candles.length; i++) {
    const x = c.candles[i];
    if ((c.side === 'LONG' && x.low <= stop) || (c.side === 'SHORT' && x.high >= stop)) return { ...c, exitTime: x.candleTime, exitReason: 'SL', pnl: (c.side === 'LONG' ? stop - c.entry : c.entry - stop) * amount };
    if ((c.side === 'LONG' && x.high >= target) || (c.side === 'SHORT' && x.low <= target)) return { ...c, exitTime: x.candleTime, exitReason: 'TP', pnl: (c.side === 'LONG' ? target - c.entry : c.entry - target) * amount };
    if (x.candleTime >= end) return { ...c, exitTime: x.candleTime, exitReason: '時間決済', pnl: (c.side === 'LONG' ? x.close - c.entry : c.entry - x.close) * amount };
  }
  const last = c.candles.at(-1)!; return { ...c, exitTime: last.candleTime, exitReason: '時間決済', pnl: (c.side === 'LONG' ? last.close - c.entry : c.entry - last.close) * amount };
}
function baseCandidates(date: string, cs: Candle[]) {
  const candidates: Candidate[] = []; let high = 0; let longDone = false; let shortDone = false; const open = cs[0].open;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]; high = Math.max(high, c.high); if (c.candleTime < '09:45' || c.candleTime > '11:27' || i < 10) continue;
    const ma = sma(cs, i, 8); const ma1 = sma(cs, i - 1, 8); const ma2 = sma(cs, i - 2, 8); const high10 = Math.max(...cs.slice(i - 10, i).map(x => x.high)); const low10 = Math.min(...cs.slice(i - 10, i).map(x => x.low)); const drop = (high - c.close) / high * 100;
    if (!longDone && ma !== null && ma2 !== null && drop >= 2.5 && (ma - ma2) / ma2 * 100 >= 0.02 && c.high > high10) { candidates.push({ date, time: c.candleTime, index: i, side: 'LONG', strategy: '反転LONG', entry: c.close, candles: cs }); longDone = true; }
    if (!shortDone && ma !== null && ma1 !== null && (high - open) / open * 100 >= 3.0 && drop >= 1.5 && ma < ma1 && c.low < low10) { candidates.push({ date, time: c.candleTime, index: i, side: 'SHORT', strategy: '反転SHORT', entry: c.close, candles: cs }); shortDone = true; }
  }
  return candidates;
}
function trendCandidates(date: string, cs: Candle[]) {
  let longDone = false; let shortDone = false; const candidates: Candidate[] = []; const dayOpen = cs[0].open;
  for (let i = 20; i < cs.length; i++) {
    const c = cs[i]; if (!entryWindow(c.candleTime) || c.candleTime < '10:15') continue;
    const ma = sma(cs, i, 8); const ma1 = sma(cs, i - 1, 8); const ma2 = sma(cs, i - 2, 8); if (ma === null || ma1 === null || ma2 === null) continue; const slope = (ma - ma2) / ma2 * 100;
    const high20 = Math.max(...cs.slice(i - 20, i).map(x => x.high)); const low10 = Math.min(...cs.slice(i - 10, i).map(x => x.low));
    const openGain = (c.close - dayOpen) / dayOpen * 100;
    if (!longDone && slope >= 0.02 && c.high > high20 && c.close > c.open && openGain >= 0 && vol(cs, i) >= 1.2) { candidates.push({ date, time: c.candleTime, index: i, side: 'LONG', strategy: '順張りLONG', entry: c.close, candles: cs }); longDone = true; }
    if (!shortDone && slope <= -0.02 && ma <= ma1 && c.low < low10 && c.close < c.open && openGain <= -1.0 && vol(cs, i) >= 1.0) { candidates.push({ date, time: c.candleTime, index: i, side: 'SHORT', strategy: '順張りSHORT', entry: c.close, candles: cs }); shortDone = true; }
  }
  return candidates;
}
function summary(label: string, trades: Trade[]) { const wins = trades.filter(t => t.pnl > 0).length; const pnl = trades.reduce((s, t) => s + t.pnl, 0); const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0); const gl = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0)); console.log(`${label}: ${trades.length}件 ${wins}勝${trades.length - wins}敗 勝率${trades.length ? (wins / trades.length * 100).toFixed(1) : '0'}% 損益${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円 PF${gl ? (gp / gl).toFixed(2) : '∞'}`); }

async function main() {
  const db = await getDb(); const drows = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='285A' ORDER BY tradeDate`); const dates = ((drows as any)[0] as Array<{ tradeDate: string }>).map(x => x.tradeDate);
  const candidates: Candidate[] = []; const base: Candidate[] = []; const trend: Candidate[] = [];
  for (const date of dates) { const rows = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol='285A' AND tradeDate=${date} ORDER BY candleTime`); const cs = ((rows as any)[0] as any[]).map(r => ({ candleTime: String(r.candleTime), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) })) as Candle[]; const b = baseCandidates(date, cs); const t = trendCandidates(date, cs); base.push(...b); trend.push(...t); candidates.push(...b, ...t); }
  for (const cb of SAFE_CB) { const rows = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol='285A' AND tradeDate=${cb.date} ORDER BY candleTime`); const cs = ((rows as any)[0] as any[]).map(r => ({ candleTime: String(r.candleTime), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) })) as Candle[]; const index = cs.findIndex(c => c.candleTime === cb.time); if (index >= 0) { const x = { date: cb.date, time: cb.time, index, side: 'SHORT' as Side, strategy: '安全CB SHORT', entry: cb.entry, candles: cs }; base.push(x); candidates.push(x); } }
  const accepted: Trade[] = [];
  for (const date of dates) { let active: Trade | null = null; for (const t of candidates.filter(c => c.date === date).map(exit).sort((a, b) => a.time.localeCompare(b.time))) { if (active && t.time <= active.exitTime) continue; accepted.push(t); active = t; } }
  summary('現行反転＋安全CB', base.map(exit)); summary('順張り候補単独', trend.map(exit)); summary('統合（時刻順・1ポジション）', accepted);
  const splitDate = dates[Math.floor(dates.length / 2) - 1];
  summary(`統合・前半（〜${splitDate}）`, accepted.filter(trade => trade.date <= splitDate));
  summary(`統合・後半（${dates[Math.floor(dates.length / 2)]}〜）`, accepted.filter(trade => trade.date > splitDate));
  console.log('=== 8/17候補と採用結果 ==='); candidates.filter(c => c.date === '2026-08-17').map(exit).sort((a, b) => a.time.localeCompare(b.time)).forEach(t => console.log(`${t.time} ${t.strategy} ${t.side} @${t.entry} → ${t.exitTime} ${t.exitReason} ${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl).toLocaleString()}円 ${accepted.some(a => a.date === t.date && a.time === t.time && a.strategy === t.strategy) ? '採用' : '競合除外'}`));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
