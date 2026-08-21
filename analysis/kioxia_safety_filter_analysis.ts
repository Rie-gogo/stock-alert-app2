import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

type CandleRow = {
  tradeDate: string;
  candleTime: string;
  close: string | number;
  boardSnapshot: unknown;
};

type TradeRow = {
  tradeDate: string;
  tradeTime: string;
  action: string;
  side: string;
  pnl: number | null;
  boardSignal: string | null;
  reason: string;
};

type BlockRow = {
  trade_date: string;
  candle_time: string;
  side: string;
  signal_reason: string;
  board_score: number;
  context: string | null;
};

function parseBoard(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続を取得できません");

  const [candlesRaw, tradesRaw, blocksRaw] = await Promise.all([
    db.execute(sql`
      SELECT tradeDate, candleTime, close, boardSnapshot
      FROM rt_candles
      WHERE symbol = '285A'
      ORDER BY tradeDate DESC, candleTime DESC
      LIMIT 20000
    `),
    db.execute(sql`
      SELECT tradeDate, tradeTime, action, side, pnl, boardSignal, reason
      FROM rt_trades
      WHERE symbol = '285A'
      ORDER BY tradeDate, tradeTime
    `),
    db.execute(sql`
      SELECT trade_date, candle_time, side, signal_reason, board_score, context
      FROM rt_score0_blocks
      WHERE symbol = '285A'
      ORDER BY trade_date, candle_time
    `),
  ]);

  const candles = (candlesRaw[0] as CandleRow[]).reverse();
  const trades = tradesRaw[0] as TradeRow[];
  const blocks = blocksRaw[0] as BlockRow[];
  const snapshots = candles.map(candle => parseBoard(candle.boardSnapshot));
  const complete = snapshots.filter((board): board is Record<string, unknown> => board !== null);
  const days = [...new Set(candles.map(candle => candle.tradeDate))];

  const bySignal = new Map<string, number>();
  const bprValues: number[] = [];
  let after13 = 0;
  let after13WithBoard = 0;
  let after13BprBlock = 0;

  for (let index = 0; index < complete.length; index++) {
    const signal = String(complete[index].signal ?? "unknown");
    bySignal.set(signal, (bySignal.get(signal) ?? 0) + 1);
    const bpr = number(complete[index].buyPressureRatio);
    if (bpr !== null) bprValues.push(bpr);
  }

  for (const candle of candles) {
    if (candle.candleTime < "13:00") continue;
    after13++;
    const board = parseBoard(candle.boardSnapshot);
    if (!board) continue;
    after13WithBoard++;
    const bpr = number(board.buyPressureRatio);
    if (bpr !== null && bpr >= 0.65) after13BprBlock++;
  }

  const entryTrades = trades.filter(trade => trade.action === "buy" || trade.action === "short");
  const boardBySide = new Map<string, { entries: number; win: number; loss: number }>();
  for (const entry of entryTrades) {
    const key = `${entry.side}:${entry.boardSignal ?? "none"}`;
    const current = boardBySide.get(key) ?? { entries: 0, win: 0, loss: 0 };
    current.entries++;
    boardBySide.set(key, current);
  }

  const exitsByDaySide = new Map<string, number>();
  for (const trade of trades) {
    if (trade.pnl === null) continue;
    exitsByDaySide.set(`${trade.tradeDate}:${trade.side}`, trade.pnl);
  }
  for (const entry of entryTrades) {
    const key = `${entry.side}:${entry.boardSignal ?? "none"}`;
    const result = boardBySide.get(key)!;
    const pnl = exitsByDaySide.get(`${entry.tradeDate}:${entry.side}`) ?? 0;
    if (pnl > 0) result.win++;
    else if (pnl < 0) result.loss++;
  }

  const blocksBySide = new Map<string, BlockRow[]>();
  for (const block of blocks) {
    const list = blocksBySide.get(block.side) ?? [];
    list.push(block);
    blocksBySide.set(block.side, list);
  }

  console.log("=== 285A 板履歴の保存状況 ===");
  console.log(`対象日数: ${days.length}日 / 1分足: ${candles.length}本`);
  console.log(`板スナップショットあり: ${complete.length}本 (${(complete.length / Math.max(candles.length, 1) * 100).toFixed(1)}%)`);
  console.log(`板シグナル内訳: ${[...bySignal.entries()].map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`BPR平均: ${(bprValues.reduce((sum, value) => sum + value, 0) / Math.max(bprValues.length, 1)).toFixed(3)}`);
  console.log(`13時以降: ${after13}本 / 板あり${after13WithBoard}本 / BPR>=0.65: ${after13BprBlock}本 (${(after13BprBlock / Math.max(after13WithBoard, 1) * 100).toFixed(1)}%)`);

  console.log("\n=== 実エントリーの板シグナル別成績（285A） ===");
  for (const [key, value] of [...boardBySide.entries()].sort()) {
    const resolved = value.win + value.loss;
    console.log(`${key}: ${value.entries}件 / 決済済み${resolved}件 (${value.win}勝${value.loss}敗)`);
  }

  console.log("\n=== スコア0ブロック履歴（285A） ===");
  console.log(`総数: ${blocks.length}件`);
  for (const [side, sideBlocks] of blocksBySide.entries()) {
    const contexts = new Map<string, number>();
    for (const block of sideBlocks) {
      const context = block.context ?? "なし";
      contexts.set(context, (contexts.get(context) ?? 0) + 1);
    }
    console.log(`${side}: ${sideBlocks.length}件 / ${[...contexts.entries()].map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }

  console.log("\n=== 結論用の制約 ===");
  console.log("板スコアと3分足HTFのブロックは、エントリー候補自体をDBに完全保存していないため、過去40日の厳密なアブレーション損益は算出できない。");
  console.log("一方、rt_candles.boardSnapshotとrt_score0_blocksは保存済みであり、今後の順張り候補については実運用中にフィルター別の通過・ブロック記録を追加すれば厳密検証が可能。");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
