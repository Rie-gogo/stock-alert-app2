import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const today = "2026-07-24";

  // 1. Get all trades for today
  const r1 = await db.execute(sql`
    SELECT id, tradeDate, tradeTime, symbol, symbolName, action, price, shares, amount, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = ${today}
    ORDER BY tradeTime
  `);
  const trades = (r1 as any)[0];
  console.log(`=== ${today} リアルタイムシミュレーション結果 ===`);
  console.log(`\n■ 全取引一覧 (${trades.length}件)`);
  for (const t of trades) {
    const pnlStr = t.pnl !== null ? `P&L: ${Number(t.pnl).toLocaleString()}円` : "";
    console.log(`  ${t.tradeTime} ${t.symbol}(${t.symbolName}) ${t.action} @${Number(t.price).toLocaleString()} ${t.shares}株 ${pnlStr}`);
    console.log(`    理由: ${(t.reason || "").substring(0, 120)}`);
  }

  // 2. Calculate summary stats
  const exits = trades.filter((t: any) => t.pnl !== null);
  const totalPnl = exits.reduce((sum: number, t: any) => sum + Number(t.pnl), 0);
  const wins = exits.filter((t: any) => Number(t.pnl) > 0);
  const losses = exits.filter((t: any) => Number(t.pnl) < 0);
  const winRate = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : "N/A";
  
  console.log(`\n■ サマリー`);
  console.log(`  取引回数: ${exits.length}回 (エントリー${trades.filter((t: any) => t.action === 'buy' || t.action === 'short').length}件, 決済${exits.length}件)`);
  console.log(`  勝率: ${winRate}% (${wins.length}勝${losses.length}敗)`);
  console.log(`  総損益: ${totalPnl.toLocaleString()}円`);
  if (wins.length > 0) {
    const avgWin = wins.reduce((s: number, t: any) => s + Number(t.pnl), 0) / wins.length;
    console.log(`  平均利益: +${avgWin.toLocaleString()}円`);
  }
  if (losses.length > 0) {
    const avgLoss = losses.reduce((s: number, t: any) => s + Number(t.pnl), 0) / losses.length;
    console.log(`  平均損失: ${avgLoss.toLocaleString()}円`);
  }

  // 3. By symbol
  console.log(`\n■ 銘柄別損益`);
  const bySymbol: Record<string, { name: string; pnl: number; count: number; wins: number }> = {};
  for (const t of exits) {
    const key = t.symbol;
    if (!bySymbol[key]) bySymbol[key] = { name: t.symbolName, pnl: 0, count: 0, wins: 0 };
    bySymbol[key].pnl += Number(t.pnl);
    bySymbol[key].count++;
    if (Number(t.pnl) > 0) bySymbol[key].wins++;
  }
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}(${data.name}): ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円 (${data.wins}勝${data.count - data.wins}敗)`);
  }

  // 4. By signal type
  console.log(`\n■ シグナル別成績`);
  const bySignal: Record<string, { pnl: number; count: number; wins: number }> = {};
  for (const t of exits) {
    const reason = (t.reason || "") as string;
    let sigType = "不明";
    if (reason.includes("大台超え")) sigType = "大台超え";
    else if (reason.includes("大台割れ")) sigType = "大台割れ";
    else if (reason.includes("VWAPクロス下抜け")) sigType = "VWAPクロス下抜け";
    else if (reason.includes("VWAP反発")) sigType = "VWAP反発";
    else if (reason.includes("ダウ理論")) sigType = "ダウ理論";
    else if (reason.includes("三尊")) sigType = "三尊";
    else if (reason.includes("逆三尊")) sigType = "逆三尊";
    else if (reason.includes("ゴールデンクロス")) sigType = "ゴールデンクロス";
    else if (reason.includes("デッドクロス")) sigType = "デッドクロス";
    else if (reason.includes("押し目確認")) sigType = "押し目確認";
    if (!bySignal[sigType]) bySignal[sigType] = { pnl: 0, count: 0, wins: 0 };
    bySignal[sigType].pnl += Number(t.pnl);
    bySignal[sigType].count++;
    if (Number(t.pnl) > 0) bySignal[sigType].wins++;
  }
  for (const [sig, data] of Object.entries(bySignal).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sig}: ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${(data.wins/data.count*100).toFixed(0)}%)`);
  }

  // 5. Check for open positions
  const entries = trades.filter((t: any) => t.action === 'buy' || t.action === 'short');
  const closedSymbols = exits.map((t: any) => `${t.symbol}_${t.side}`);
  const openPositions = entries.filter((t: any) => {
    const key = `${t.symbol}_${t.side}`;
    // Simple check: if entry count > exit count for this symbol+side
    const entryCount = entries.filter((e: any) => e.symbol === t.symbol && e.side === t.side).length;
    const exitCount = exits.filter((e: any) => e.symbol === t.symbol && e.side === t.side).length;
    return entryCount > exitCount;
  });
  
  // 6. Get daily summary if exists
  const r2 = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${today}
  `);
  const summaries = (r2 as any)[0];
  if (summaries.length > 0) {
    console.log(`\n■ 日次サマリー (rt_daily_summaries)`);
    for (const s of summaries) {
      console.log(`  ${JSON.stringify(s)}`);
    }
  }

  // 7. Check signal history (blocked signals) from production logs
  console.log(`\n■ 特記事項`);
  const slCount = exits.filter((t: any) => (t.reason || "").includes("損切り")).length;
  const tpCount = exits.filter((t: any) => (t.reason || "").includes("利確")).length;
  const eodCount = exits.filter((t: any) => (t.reason || "").includes("大引け")).length;
  if (slCount > 0) console.log(`  損切り: ${slCount}件`);
  if (tpCount > 0) console.log(`  利確: ${tpCount}件`);
  if (eodCount > 0) console.log(`  大引け決済: ${eodCount}件`);
  
  // Check consecutive losses
  let maxConsecLoss = 0, currentConsec = 0;
  for (const t of exits) {
    if (Number(t.pnl) < 0) { currentConsec++; maxConsecLoss = Math.max(maxConsecLoss, currentConsec); }
    else { currentConsec = 0; }
  }
  if (maxConsecLoss >= 2) console.log(`  最大連敗: ${maxConsecLoss}連敗`);

  // 8. Also get recent days for context
  console.log(`\n■ 直近5営業日の推移`);
  const r3 = await db.execute(sql`
    SELECT tradeDate, 
           COUNT(*) as totalTrades,
           SUM(CASE WHEN pnl IS NOT NULL AND pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl IS NOT NULL AND pnl < 0 THEN 1 ELSE 0 END) as losses,
           SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as totalPnl
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-17'
    GROUP BY tradeDate
    ORDER BY tradeDate
  `);
  for (const row of (r3 as any)[0]) {
    const pnl = Number(row.totalPnl);
    console.log(`  ${row.tradeDate}: ${row.totalTrades}件 (${row.wins}勝${row.losses}敗) ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
