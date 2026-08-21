import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

type TradeRow = {
  id: number;
  tradeDate: string;
  tradeTime: string;
  action: string;
  side: string;
  price: number | string;
  shares: number | string;
  pnl: number | string | null;
  reason: string | null;
  boardSignal: string | null;
};

type Pair = {
  date: string;
  entryTime: string;
  exitTime: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryReason: string;
  exitReason: string;
  boardSignal: string;
};

function signalName(reason: string, side: string) {
  if (reason.includes("順張りLONG")) return "順張りLONG";
  if (reason.includes("順張りSHORT")) return "順張りSHORT";
  if (reason.includes("反転LONG")) return "反転LONG";
  if (reason.includes("反転SHORT")) return "反転SHORT";
  if (reason.includes("安値更新即")) return "安値更新即SHORT";
  if (reason.includes("出来高急増")) return "即vol SHORT";
  if (reason.includes("4本連続")) return "即4a SHORT";
  if (reason.includes("大台確認") && reason.includes("大台割れ")) return "大台割れCB SHORT";
  if (reason.includes("大台確認") && reason.includes("大台超え")) return "大台超えLONG";
  if (reason.includes("逆三尊")) return "逆三尊LONG";
  if (reason.includes("三尊")) return "三尊SHORT";
  if (reason.includes("ダウ理論")) return side === "long" ? "ダウ理論LONG" : "ダウ理論SHORT";
  if (reason.includes("VWAP")) return "VWAP SHORT";
  if (reason.includes("静かな上昇")) return "静かな上昇バイパスLONG";
  if (reason.includes("出来高ブレイク")) return "出来高ブレイクLONG";
  if (reason.includes("過熱反転")) return "過熱反転SHORT";
  return reason.slice(0, 36) || "不明";
}

function statLine(rows: Pair[]) {
  const wins = rows.filter((row) => row.pnl > 0).length;
  const pnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  return `${rows.length}件 ${wins}勝${rows.length - wins}敗 勝率${rows.length ? (wins / rows.length * 100).toFixed(1) : "0.0"}% ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`;
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB接続に失敗しました");

  const tradeResult = await db.execute(sql`
    SELECT id, tradeDate, tradeTime, action, side, price, shares, pnl, reason, boardSignal
    FROM rt_trades
    WHERE symbol = '8035'
    ORDER BY id ASC
  `);
  const rows = (tradeResult as any)[0] as TradeRow[];
  const openEntries: TradeRow[] = [];
  const pairs: Pair[] = [];

  for (const row of rows) {
    if (row.action === "buy" || row.action === "short") {
      openEntries.push(row);
      continue;
    }
    if (row.action !== "sell" && row.action !== "cover") continue;
    const index = openEntries.findIndex((entry) =>
      entry.tradeDate === row.tradeDate &&
      entry.side === row.side &&
      ((entry.action === "buy" && row.action === "sell") ||
        (entry.action === "short" && row.action === "cover")),
    );
    if (index < 0) continue;
    const entry = openEntries.splice(index, 1)[0];
    pairs.push({
      date: entry.tradeDate,
      entryTime: entry.tradeTime,
      exitTime: row.tradeTime,
      side: entry.side,
      entryPrice: Number(entry.price),
      exitPrice: Number(row.price),
      pnl: Number(row.pnl ?? 0),
      entryReason: entry.reason ?? "",
      exitReason: row.reason ?? "",
      boardSignal: entry.boardSignal ?? "unknown",
    });
  }

  console.log("=".repeat(90));
  console.log(`東京エレクトロン(8035) 本番取引分析: 生レコード${rows.length}件 / ペア${pairs.length}件`);
  console.log("=".repeat(90));
  console.log(`全体: ${statLine(pairs)}`);

  console.log("\n--- 全取引明細 ---");
  for (const pair of pairs) {
    const signal = signalName(pair.entryReason, pair.side);
    const mark = pair.pnl > 0 ? "✓" : "✗";
    console.log(`${mark} ${pair.date} ${pair.entryTime}→${pair.exitTime} ${pair.side.toUpperCase()} @${pair.entryPrice}→${pair.exitPrice} ${pair.pnl >= 0 ? "+" : ""}${pair.pnl.toLocaleString()}円 [${signal}] board:${pair.boardSignal}`);
    console.log(`    entry: ${pair.entryReason.slice(0, 120)}`);
    console.log(`    exit:  ${pair.exitReason.slice(0, 100)}`);
  }

  const groups: Record<string, Pair[]> = {};
  const add = (key: string, pair: Pair) => (groups[key] ??= []).push(pair);
  for (const pair of pairs) {
    add(`方向:${pair.side}`, pair);
    add(`シグナル:${signalName(pair.entryReason, pair.side)}`, pair);
    add(`時間帯:${pair.entryTime.slice(0, 2)}時`, pair);
    add(`板:${pair.boardSignal}`, pair);
    const exit = pair.exitReason.includes("利確") ? "利確" : pair.exitReason.includes("損切") ? "損切り" : pair.exitReason.includes("前場") ? "前場強制決済" : pair.exitReason.includes("大引け") ? "大引け決済" : pair.exitReason.slice(0, 24);
    add(`決済:${exit}`, pair);
  }
  for (const prefix of ["方向:", "シグナル:", "時間帯:", "板:", "決済:"]) {
    console.log(`\n--- ${prefix.slice(0, -1)}別 ---`);
    Object.entries(groups)
      .filter(([key]) => key.startsWith(prefix))
      .sort(([, a], [, b]) => b.reduce((sum, row) => sum + row.pnl, 0) - a.reduce((sum, row) => sum + row.pnl, 0))
      .forEach(([key, group]) => console.log(`  ${key.slice(prefix.length)}: ${statLine(group)}`));
  }

  const blockResult = await db.execute(sql`
    SELECT trade_date, candle_time, side, signal_reason, entry_price, board_score, confidence, context
    FROM rt_score0_blocks
    WHERE symbol = '8035'
    ORDER BY trade_date, candle_time
  `);
  const blocks = (blockResult as any)[0] as any[];
  console.log(`\n--- スコア0ブロック: ${blocks.length}件 ---`);
  for (const block of blocks) {
    console.log(`  ${block.trade_date} ${block.candle_time} ${block.side} @${block.entry_price} score:${block.board_score} conf:${block.confidence} ${String(block.signal_reason).slice(0, 100)}`);
  }

  const candleResult = await db.execute(sql`
    SELECT *
    FROM rt_candles
    WHERE symbol = '8035'
    ORDER BY tradeDate, candleTime
  `);
  const candles = (candleResult as any)[0] as any[];
  const byDate: Record<string, any[]> = {};
  for (const candle of candles) (byDate[candle.tradeDate] ??= []).push(candle);
  console.log(`\n--- 1分足データ: ${candles.length}本 / ${Object.keys(byDate).length}営業日 ---`);
  for (const [date, list] of Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b))) {
    const open = Number(list[0].open);
    const close = Number(list[list.length - 1].close);
    const high = Math.max(...list.map((c) => Number(c.high)));
    const low = Math.min(...list.map((c) => Number(c.low)));
    console.log(`  ${date}: ${open}→${close} (${((close / open - 1) * 100).toFixed(2)}%) H${high} L${low} ${list.length}本`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
