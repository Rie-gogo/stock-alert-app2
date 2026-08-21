import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { getHigherTfTrend } from "../server/vwap";
import { boardReadingScore } from "../server/realtimeSimEngine";

type Side = "LONG" | "SHORT";
type Board = { signal?: string; buyPressureRatio?: number } | null;
type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number; board: Board };
type Candidate = { date: string; time: string; index: number; side: Side; strategy: string; entry: number; candles: Candle[]; filterNotes: string[] };
type Trade = Candidate & { exitTime: string; exitReason: string; pnl: number };

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;
const DATE_FROM = "2026-08-17";
const DATE_TO = "2026-08-21";

function parseBoard(value: unknown): Board {
  if (!value) return null;
  if (typeof value === "object") return value as Board;
  try { return JSON.parse(String(value)) as Board; } catch { return null; }
}
function shares(price: number) { return Math.max(100, Math.floor(Math.floor(CAPITAL * LOT_RATIO / price) / 100) * 100); }
function sma(cs: Candle[], i: number, period: number) { return i - period + 1 < 0 ? null : cs.slice(i - period + 1, i + 1).reduce((sum, c) => sum + c.close, 0) / period; }
function volumeRatio(cs: Candle[], i: number) { if (i < 20) return 0; const avg = cs.slice(i - 20, i).reduce((sum, c) => sum + c.volume, 0) / 20; return avg > 0 ? cs[i].volume / avg : 0; }
function isWindow(time: string) { return (time >= "09:45" && time <= "11:27") || (time >= "12:50" && time <= "14:20"); }
function htf(cs: Candle[], index: number) {
  return getHigherTfTrend(cs.map(c => ({ ...c, dayKey: "day", time: c.candleTime })) as any, index, 3);
}
function boardAllows(side: Side, board: Board, time: string) {
  if (side === "LONG" && board?.signal === "sell_pressure") return false;
  if (side === "SHORT" && board?.signal === "buy_pressure") return false;
  const score = boardReadingScore("285A", side === "LONG" ? "long" : "short", board as any);
  if (side === "LONG" && score < 1) return false;
  if (side === "SHORT" && board?.signal === "neutral" && score < 1) return false;
  if (side === "SHORT" && time >= "13:00" && typeof board?.buyPressureRatio === "number" && board.buyPressureRatio >= 0.65) return false;
  return true;
}
function exit(candidate: Candidate): Trade {
  const sl = candidate.side === "LONG" ? 0.6 : 0.8;
  const tp = candidate.side === "LONG" ? 0.8 : 1.2;
  const qty = shares(candidate.entry);
  const stop = candidate.side === "LONG" ? candidate.entry * (1 - sl / 100) : candidate.entry * (1 + sl / 100);
  const target = candidate.side === "LONG" ? candidate.entry * (1 + tp / 100) : candidate.entry * (1 - tp / 100);
  const finalTime = candidate.time <= "11:27" ? "11:27" : "14:20";
  for (let i = candidate.index + 1; i < candidate.candles.length; i++) {
    const next = candidate.candles[i];
    if ((candidate.side === "LONG" && next.low <= stop) || (candidate.side === "SHORT" && next.high >= stop)) return { ...candidate, exitTime: next.candleTime, exitReason: "SL", pnl: (candidate.side === "LONG" ? stop - candidate.entry : candidate.entry - stop) * qty };
    if ((candidate.side === "LONG" && next.high >= target) || (candidate.side === "SHORT" && next.low <= target)) return { ...candidate, exitTime: next.candleTime, exitReason: "TP", pnl: (candidate.side === "LONG" ? target - candidate.entry : candidate.entry - target) * qty };
    if (next.candleTime >= finalTime) return { ...candidate, exitTime: next.candleTime, exitReason: "時間決済", pnl: (candidate.side === "LONG" ? next.close - candidate.entry : candidate.entry - next.close) * qty };
  }
  const last = candidate.candles.at(-1)!;
  return { ...candidate, exitTime: last.candleTime, exitReason: "時間決済", pnl: (candidate.side === "LONG" ? last.close - candidate.entry : candidate.entry - last.close) * qty };
}

function candidatesForDay(date: string, cs: Candle[]) {
  const candidates: Candidate[] = [];
  const dayOpen = cs[0].open;
  let dayHigh = 0;
  let reversalLongFired = false;
  let reversalShortFired = false;
  let trendLongFired = false;
  let trendShortFired = false;

  for (let i = 20; i < cs.length; i++) {
    const c = cs[i];
    dayHigh = Math.max(dayHigh, c.high);
    if (!isWindow(c.candleTime)) continue;
    const ma = sma(cs, i, 8); const ma1 = sma(cs, i - 1, 8); const ma2 = sma(cs, i - 2, 8);
    if (ma === null || ma1 === null || ma2 === null) continue;
    const slope = ((ma - ma2) / ma2) * 100;
    const openGain = ((c.close - dayOpen) / dayOpen) * 100;
    const high20 = Math.max(...cs.slice(i - 20, i).map(x => x.high));
    const high10 = Math.max(...cs.slice(i - 10, i).map(x => x.high));
    const low10 = Math.min(...cs.slice(i - 10, i).map(x => x.low));
    const drop = ((dayHigh - c.close) / dayHigh) * 100;
    const board = c.board;
    const trend = htf(cs, i);

    const add = (side: Side, strategy: string) => candidates.push({ date, time: c.candleTime, index: i, side, strategy, entry: c.close, candles: cs, filterNotes: [`HTF=${trend}`, `板=${board?.signal ?? "なし"}`, `BPR=${board?.buyPressureRatio?.toFixed(3) ?? "なし"}`] });

    if (!reversalLongFired && c.candleTime <= "11:27" && drop >= 2.5 && ma > ma1 && slope >= 0.02 && c.high > high10 && board?.signal !== "sell_pressure") {
      reversalLongFired = true; add("LONG", "反転LONG");
    }
    if (!reversalShortFired && c.candleTime <= "11:27" && openGain >= 3.0 && drop >= 1.5 && ma < ma1 && c.low < low10) {
      reversalShortFired = true; add("SHORT", "反転SHORT");
    }
    if (!trendLongFired && c.candleTime >= "10:15" && slope >= 0.02 && openGain >= 0 && c.high > high20 && c.close > c.open && volumeRatio(cs, i) >= 1.2 && trend !== "down" && boardAllows("LONG", board, c.candleTime)) {
      trendLongFired = true; add("LONG", "順張りLONG");
    }
    if (!trendShortFired && c.candleTime >= "10:15" && slope <= -0.02 && openGain <= -1.0 && c.low < low10 && c.close < c.open && volumeRatio(cs, i) >= 1.0 && trend !== "up" && boardAllows("SHORT", board, c.candleTime)) {
      trendShortFired = true; add("SHORT", "順張りSHORT");
    }
  }
  return candidates;
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続を取得できません");
  const rows = await db.execute(sql`
    SELECT tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
    FROM rt_candles
    WHERE symbol = '285A' AND tradeDate BETWEEN ${DATE_FROM} AND ${DATE_TO}
    ORDER BY tradeDate, candleTime
  `);
  const grouped = new Map<string, Candle[]>();
  for (const row of rows[0] as any[]) {
    const list = grouped.get(String(row.tradeDate)) ?? [];
    list.push({ candleTime: String(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), board: parseBoard(row.boardSnapshot) });
    grouped.set(String(row.tradeDate), list);
  }
  const allTrades: Trade[] = [];
  for (const [date, candles] of grouped) {
    const candidates = candidatesForDay(date, candles).map(exit).sort((a, b) => a.time.localeCompare(b.time));
    let active: Trade | null = null;
    for (const trade of candidates) {
      if (active && trade.time <= active.exitTime) continue;
      allTrades.push(trade);
      active = trade;
    }
  }
  const wins = allTrades.filter(trade => trade.pnl > 0).length;
  const pnl = allTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  console.log(`=== 現行285A統合仕様: ${DATE_FROM}〜${DATE_TO} ===`);
  console.log(`取引${allTrades.length}件 / ${wins}勝${allTrades.length - wins}敗 / 勝率${allTrades.length ? (wins / allTrades.length * 100).toFixed(1) : "0.0"}% / 損益${pnl >= 0 ? "+" : ""}${Math.round(pnl).toLocaleString()}円`);
  for (const trade of allTrades) {
    console.log(`${trade.date} ${trade.time} ${trade.strategy} ${trade.side} @${trade.entry.toFixed(0)} → ${trade.exitTime} ${trade.exitReason} ${trade.pnl >= 0 ? "+" : ""}${Math.round(trade.pnl).toLocaleString()}円 [${trade.filterNotes.join(" / ")}]`);
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
