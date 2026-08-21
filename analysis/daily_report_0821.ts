import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const today = "2026-08-21";

  const r = await db.execute(sql`
    SELECT id, tradeTime, symbol, symbolName, action, side, price, pnl, reason, boardSignal
    FROM rt_trades WHERE tradeDate = ${today} ORDER BY id ASC
  `);
  const rows = (r as any)[0] as any[];

  interface Trade {
    sym: string; name: string; entryTime: string; exitTime: string; side: string;
    entryPrice: number; exitPrice: number; pnl: number;
    entryReason: string; exitReason: string; entryBoard: string;
  }
  const trades: Trade[] = [];
  const entries: any[] = [];

  for (const row of rows) {
    if (row.action === "buy" || row.action === "short") {
      entries.push(row);
    } else {
      const idx = entries.findIndex(
        (e: any) => e.symbol === row.symbol && e.side === row.side
      );
      if (idx >= 0) {
        const e = entries[idx];
        entries.splice(idx, 1);
        trades.push({
          sym: e.symbol, name: e.symbolName,
          entryTime: e.tradeTime, exitTime: row.tradeTime,
          side: e.side, entryPrice: Number(e.price), exitPrice: Number(row.price),
          pnl: Number(row.pnl), entryReason: e.reason, exitReason: row.reason,
          entryBoard: e.boardSignal,
        });
      }
    }
  }

  let totalPnl = 0;
  let wins = 0;
  for (const t of trades) {
    totalPnl += t.pnl;
    if (t.pnl > 0) wins++;
  }

  console.log(`=== ${today}(木) 全取引 (${trades.length}件) ===`);
  for (const t of trades) {
    const mark = t.pnl > 0 ? "✓" : "✗";
    const sig = classifySignal(t.entryReason, t.side);
    const exitKey = classifyExit(t.exitReason);
    console.log(
      `${mark} ${t.entryTime}→${t.exitTime} ${t.name}(${t.sym}) ${t.side} @${t.entryPrice}→${t.exitPrice} ${t.pnl > 0 ? "+" : ""}${t.pnl}円 [${sig}] exit:${exitKey} board:${t.entryBoard}`
    );
  }

  console.log(
    `\n合計: ${trades.length}件 ${wins}勝${trades.length - wins}敗 勝率${(
      (wins / trades.length) *
      100
    ).toFixed(1)}% ${totalPnl > 0 ? "+" : ""}${totalPnl}円`
  );

  // 銘柄別
  console.log("\n--- 銘柄別 ---");
  const bySym: Record<string, { cnt: number; wins: number; pnl: number; name: string }> = {};
  for (const t of trades) {
    const key = t.sym;
    if (bySym[key] === undefined) bySym[key] = { cnt: 0, wins: 0, pnl: 0, name: t.name };
    bySym[key].cnt++;
    if (t.pnl > 0) bySym[key].wins++;
    bySym[key].pnl += t.pnl;
  }
  for (const [k, v] of Object.entries(bySym).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${v.name}(${k}): ${v.cnt}件 ${v.wins}勝${v.cnt - v.wins}敗 ${v.pnl > 0 ? "+" : ""}${v.pnl}円`);
  }

  // シグナル別
  console.log("\n--- シグナル別 ---");
  const bySig: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    const sig = classifySignal(t.entryReason, t.side);
    if (bySig[sig] === undefined) bySig[sig] = { cnt: 0, wins: 0, pnl: 0 };
    bySig[sig].cnt++;
    if (t.pnl > 0) bySig[sig].wins++;
    bySig[sig].pnl += t.pnl;
  }
  for (const [k, v] of Object.entries(bySig).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt - v.wins}敗 ${v.pnl > 0 ? "+" : ""}${v.pnl}円`);
  }

  // 方向別
  console.log("\n--- 方向別 ---");
  const bySide: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    if (bySide[t.side] === undefined) bySide[t.side] = { cnt: 0, wins: 0, pnl: 0 };
    bySide[t.side].cnt++;
    if (t.pnl > 0) bySide[t.side].wins++;
    bySide[t.side].pnl += t.pnl;
  }
  for (const [k, v] of Object.entries(bySide)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt - v.wins}敗 ${v.pnl > 0 ? "+" : ""}${v.pnl}円`);
  }

  // 決済理由別
  console.log("\n--- 決済理由別 ---");
  const byExit: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    const exitKey = classifyExit(t.exitReason);
    if (byExit[exitKey] === undefined) byExit[exitKey] = { cnt: 0, wins: 0, pnl: 0 };
    byExit[exitKey].cnt++;
    if (t.pnl > 0) byExit[exitKey].wins++;
    byExit[exitKey].pnl += t.pnl;
  }
  for (const [k, v] of Object.entries(byExit).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt - v.wins}敗 ${v.pnl > 0 ? "+" : ""}${v.pnl}円`);
  }

  // 板読みシグナル別
  console.log("\n--- 板読みシグナル別 ---");
  const byBoard: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    const b = t.entryBoard || "unknown";
    if (byBoard[b] === undefined) byBoard[b] = { cnt: 0, wins: 0, pnl: 0 };
    byBoard[b].cnt++;
    if (t.pnl > 0) byBoard[b].wins++;
    byBoard[b].pnl += t.pnl;
  }
  for (const [k, v] of Object.entries(byBoard).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt - v.wins}敗 ${v.pnl > 0 ? "+" : ""}${v.pnl}円`);
  }

  // ブロックされたシグナル
  const r2 = await db.execute(sql`
    SELECT trade_date, candle_time, symbol, side, signal_reason, entry_price, board_score, confidence
    FROM rt_score0_blocks WHERE trade_date = ${today} ORDER BY candle_time
  `);
  const blocks = (r2 as any)[0] as any[];
  console.log(`\n=== スコア0ブロック (${blocks.length}件) ===`);
  for (const b of blocks) {
    console.log(`  ${b.candle_time} ${b.symbol} ${b.side} @${b.entry_price} score:${b.board_score} conf:${b.confidence} [${String(b.signal_reason).substring(0, 60)}]`);
  }

  process.exit(0);
}

function classifySignal(reason: string, side: string): string {
  if (reason.includes("安値更新即")) return "安値更新即SHORT";
  if (reason.includes("即エントリー") && reason.includes("出来高")) return "即vol SHORT";
  if (reason.includes("即エントリー") && reason.includes("4本")) return "即4a SHORT";
  if (reason.includes("過熱反転")) return "過熱反転SHORT";
  if (reason.includes("大台確認") && reason.includes("大台割れ")) return "大台割れCB SHORT";
  if (reason.includes("大台確認") && reason.includes("大台超え")) return "大台超えLONG";
  if (reason.includes("三尊") && reason.indexOf("逆三尊") === -1) return "三尊SHORT";
  if (reason.includes("逆三尊")) return "逆三尊LONG";
  if (reason.includes("ダウ理論") && side === "short") return "ダウ理論SHORT";
  if (reason.includes("ダウ理論") && side === "long") return "ダウ理論LONG(押し目)";
  if (reason.includes("VWAP")) return "VWAP SHORT";
  if (reason.includes("静かな上昇") || reason.includes("バイパスLONG")) return "バイパスLONG";
  if (reason.includes("ダブルボトム")) return "バイパスLONG";
  if (reason.includes("出来高ブレイク")) return "出来高ブレイクLONG";
  return reason.substring(0, 25);
}

function classifyExit(reason: string): string {
  if (reason.includes("利確")) return "利確";
  if (reason.includes("損切り")) return "損切り";
  if (reason.includes("前場強制") || reason.includes("前場決済")) return "前場強制決済";
  if (reason.includes("大引け")) return "大引け決済";
  if (reason.includes("板読み早期利確")) return "板読み早期利確";
  return reason.substring(0, 15);
}

main();
