import { getRtTradesForDate } from "../server/db";

async function main() {
  const trades = await getRtTradesForDate("2026-07-02");
  
  const entries: any[] = [];
  const exits: any[] = [];
  for (const r of trades) {
    if (r.action === 'buy' || r.action === 'short') entries.push(r);
    else exits.push(r);
  }
  
  console.log("=== 本番7/2 取引詳細 ===");
  console.log("時刻           | 銘柄         | 方向  | エントリー→決済   | 損益      | 決済理由");
  console.log("-".repeat(110));
  
  // Match entries with exits by symbol order
  const paired: { entry: any; exit: any }[] = [];
  const usedExits = new Set<number>();
  
  for (const e of entries) {
    for (let i = 0; i < exits.length; i++) {
      if (usedExits.has(i)) continue;
      if (exits[i].symbol === e.symbol && exits[i].id > e.id) {
        paired.push({ entry: e, exit: exits[i] });
        usedExits.add(i);
        break;
      }
    }
  }
  
  // Sort by entry time
  paired.sort((a, b) => String(a.entry.tradeTime).localeCompare(String(b.entry.tradeTime)));
  
  for (const { entry: e, exit: x } of paired) {
    const pnl = x.pnl ? parseInt(String(x.pnl)) : 0;
    const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toLocaleString() + "円";
    console.log(
      `${String(e.tradeTime).padEnd(5)}→${String(x.tradeTime).padEnd(5)} | ` +
      `${String(e.symbolName).padEnd(10)} | ` +
      `${String(e.side).padEnd(5)} | ` +
      `@${String(e.price).padEnd(7)}→${String(x.price).padEnd(7)} | ` +
      `${pnlStr.padStart(12)} | ` +
      `${String(x.reason || "").substring(0, 40)}`
    );
  }
  
  const totalPnl = paired.reduce((s, p) => s + (p.exit.pnl ? parseInt(String(p.exit.pnl)) : 0), 0);
  console.log("-".repeat(110));
  console.log(`合計: ${paired.length}件, ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  
  process.exit(0);
}

main();
