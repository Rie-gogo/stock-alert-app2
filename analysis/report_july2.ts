import { getDb } from "../server/db";
import { rtTrades } from "../drizzle/schema";
import { eq } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const trades = await db.select().from(rtTrades).where(eq(rtTrades.tradeDate, "2026-07-02"));

  // Pair entries and exits by symbol
  const pairs: any[] = [];
  const openPositions = new Map<string, any>(); // symbol -> entry trade
  for (const t of trades) {
    if (t.action === "buy" || t.action === "short") {
      openPositions.set(t.symbol, t);
    } else if (t.action === "sell" || t.action === "cover") {
      const entry = openPositions.get(t.symbol);
      if (entry) {
        pairs.push({ entry, exit: t });
        openPositions.delete(t.symbol);
      }
    }
  }

  console.log("=== 全取引ペア ===");
  let totalPnl = 0;
  let wins = 0, losses = 0, bes = 0;
  for (const p of pairs) {
    const pnl = Number(p.exit.pnl || 0);
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    else bes++;
    const exitReason = (p.exit.reason || "").split(" ")[0];
    console.log(`${p.entry.tradeTime}->${p.exit.tradeTime} | ${p.entry.symbolName} | ${p.entry.action.toUpperCase()} | ${p.entry.price}円 -> ${p.exit.price}円 | ${pnl >= 0 ? "+" : ""}${pnl}円 | ${exitReason}`);
  }
  console.log(`\n合計: ${totalPnl}円 | ${pairs.length}件 | 勝${wins} 負${losses} BE${bes} | 勝率${((wins / pairs.length) * 100).toFixed(1)}%`);

  // By symbol
  const bySymbol = new Map<string, { count: number; pnl: number }>();
  for (const p of pairs) {
    const key = p.entry.symbolName;
    if (!bySymbol.has(key)) bySymbol.set(key, { count: 0, pnl: 0 });
    const s = bySymbol.get(key)!;
    s.count++;
    s.pnl += Number(p.exit.pnl || 0);
  }
  console.log("\n=== 銘柄別 ===");
  for (const [k, v] of Array.from(bySymbol.entries()).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.count}件 | ${v.pnl >= 0 ? "+" : ""}${v.pnl}円`);
  }

  // By signal type
  console.log("\n=== シグナル別 ===");
  const bySignal = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const p of pairs) {
    const reason = (p.entry.reason || "").split("｜")[0].split("(")[0].trim();
    let key = reason;
    if (reason.includes("大台確認")) key = "大台確認";
    else if (reason.includes("ダブルトップ")) key = "ダブルトップ";
    else if (reason.includes("三尊") || reason.includes("逆三尊")) key = "三尊/逆三尊";
    if (!bySignal.has(key)) bySignal.set(key, { count: 0, pnl: 0, wins: 0 });
    const s = bySignal.get(key)!;
    s.count++;
    s.pnl += Number(p.exit.pnl || 0);
    if (Number(p.exit.pnl || 0) > 0) s.wins++;
  }
  for (const [k, v] of Array.from(bySignal.entries()).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.count}件 | ${v.pnl >= 0 ? "+" : ""}${v.pnl}円 | 勝率${((v.wins / v.count) * 100).toFixed(0)}%`);
  }

  // By confidence
  console.log("\n=== 信頼度別 ===");
  for (const conf of ["強", "中"]) {
    const filtered = pairs.filter((p: any) => (p.entry.reason || "").includes(`信頼度：${conf}`));
    const pnl = filtered.reduce((s: number, p: any) => s + Number(p.exit.pnl || 0), 0);
    const w = filtered.filter((p: any) => Number(p.exit.pnl || 0) > 0).length;
    console.log(`  ${conf}: ${filtered.length}件 | ${pnl >= 0 ? "+" : ""}${pnl}円 | 勝率${filtered.length > 0 ? ((w / filtered.length) * 100).toFixed(1) : 0}%`);
  }

  // Exit reason breakdown
  console.log("\n=== 決済理由別 ===");
  const byExit = new Map<string, { count: number; pnl: number }>();
  for (const p of pairs) {
    let reason = "不明";
    const r = p.exit.reason || "";
    if (r.includes("利確") && !r.includes("板読み")) reason = "TP利確";
    else if (r.includes("損切り")) reason = "SL損切り";
    else if (r.includes("BE建値")) reason = "BE建値";
    else if (r.includes("板読み早期利確")) reason = "板読み早期利確";
    else if (r.includes("大引け")) reason = "大引け強制決済";
    if (!byExit.has(reason)) byExit.set(reason, { count: 0, pnl: 0 });
    const s = byExit.get(reason)!;
    s.count++;
    s.pnl += Number(p.exit.pnl || 0);
  }
  for (const [k, v] of Array.from(byExit.entries()).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.count}件 | ${v.pnl >= 0 ? "+" : ""}${v.pnl}円`);
  }

  // AM/PM breakdown
  console.log("\n=== 前場/後場別 ===");
  const amPairs = pairs.filter((p: any) => {
    const [h] = (p.entry.tradeTime || "").split(":");
    return parseInt(h) < 12;
  });
  const pmPairs = pairs.filter((p: any) => {
    const [h] = (p.entry.tradeTime || "").split(":");
    return parseInt(h) >= 12;
  });
  const amPnl = amPairs.reduce((s: number, p: any) => s + Number(p.exit.pnl || 0), 0);
  const pmPnl = pmPairs.reduce((s: number, p: any) => s + Number(p.exit.pnl || 0), 0);
  console.log(`  前場: ${amPairs.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl}円`);
  console.log(`  後場: ${pmPairs.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl}円`);

  // LONG/SHORT
  console.log("\n=== LONG/SHORT別 ===");
  const longs = pairs.filter((p: any) => p.entry.action === "buy");
  const shorts = pairs.filter((p: any) => p.entry.action === "short");
  const longPnl = longs.reduce((s: number, p: any) => s + Number(p.exit.pnl || 0), 0);
  const shortPnl = shorts.reduce((s: number, p: any) => s + Number(p.exit.pnl || 0), 0);
  console.log(`  LONG: ${longs.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl}円`);
  console.log(`  SHORT: ${shorts.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
