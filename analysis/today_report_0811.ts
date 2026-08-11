import mysql from "mysql2/promise";

const SYMBOL_NAMES: Record<string, string> = {
  "8035": "東京エレクトロン",
  "6857": "アドバンテスト",
  "6976": "太陽誘電",
  "6526": "ソシオネクスト",
  "5803": "フジクラ",
  "6981": "村田製作所",
  "285A": "キオクシアHD",
  "6146": "ディスコ",
  "6594": "ニデック",
  "8316": "三井住友FG",
};

async function main() {
  const db = await mysql.createConnection(process.env.DATABASE_URL as string);

  const today = new Date()
    .toLocaleDateString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, "-");

  console.log(`=== 本日（${today} 火曜日）の取引レポート ===\n`);

  const [trades] = (await db.query(
    `SELECT symbol, symbolName, action, price, shares, amount, pnl, reason, tradeTime, side
     FROM rt_trades
     WHERE tradeDate = ?
     ORDER BY tradeTime`,
    [today]
  )) as [any[], any];

  if (!trades || trades.length === 0) {
    console.log("本日の取引はありません。");
    await db.end();
    return;
  }

  // エントリーと決済をペアにして取引を再構成
  // action: entry/exit, side: LONG/SHORT
  const entries = trades.filter((t: any) => t.action === "entry" || t.action === "BUY" || t.action === "SELL_SHORT");
  const exits = trades.filter((t: any) => t.action === "exit" || t.action === "SELL" || t.action === "BUY_COVER" || t.action === "close");

  // pnlが設定されているレコードを取引として集計
  const completedTrades = trades.filter((t: any) => t.pnl !== null && t.pnl !== undefined);

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;

  if (completedTrades.length > 0) {
    totalPnl = completedTrades.reduce((s: number, t: any) => s + Number(t.pnl || 0), 0);
    wins = completedTrades.filter((t: any) => Number(t.pnl || 0) > 0).length;
    losses = completedTrades.filter((t: any) => Number(t.pnl || 0) <= 0).length;
  } else {
    // pnlがない場合は全レコードで集計
    totalPnl = trades.reduce((s: number, t: any) => s + Number(t.pnl || 0), 0);
    wins = trades.filter((t: any) => Number(t.pnl || 0) > 0).length;
    losses = trades.filter((t: any) => Number(t.pnl || 0) <= 0).length;
  }

  const targetTrades = completedTrades.length > 0 ? completedTrades : trades;
  const winRate = targetTrades.length > 0 ? (wins / targetTrades.length * 100).toFixed(1) : "0.0";
  const winTrades = targetTrades.filter((t: any) => Number(t.pnl || 0) > 0);
  const lossTrades = targetTrades.filter((t: any) => Number(t.pnl || 0) <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s: number, t: any) => s + Number(t.pnl), 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s: number, t: any) => s + Number(t.pnl), 0) / lossTrades.length : 0;

  console.log("【総合成績】");
  console.log(`全レコード数: ${trades.length}件（エントリー: ${entries.length}件 / 決済: ${exits.length}件）`);
  console.log(`損益集計対象: ${targetTrades.length}件（勝ち${wins} / 負け${losses}）`);
  console.log(`勝率: ${winRate}%`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円`);
  if (winTrades.length > 0) console.log(`平均勝ち: +${Math.round(avgWin).toLocaleString()}円`);
  if (lossTrades.length > 0) console.log(`平均負け: ${Math.round(avgLoss).toLocaleString()}円`);
  console.log();

  // 銘柄別集計
  console.log("【銘柄別成績】");
  const bySymbol: Record<string, any[]> = {};
  for (const t of targetTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  const symbolRows = Object.entries(bySymbol).map(([sym, ts]) => {
    const pnl = ts.reduce((s, t) => s + Number(t.pnl || 0), 0);
    const w = ts.filter((t) => Number(t.pnl || 0) > 0).length;
    return { sym, name: SYMBOL_NAMES[sym] || sym, count: ts.length, wins: w, pnl };
  }).sort((a, b) => b.pnl - a.pnl);

  for (const r of symbolRows) {
    const wr = r.count > 0 ? (r.wins / r.count * 100).toFixed(0) : "0";
    const pnlStr = r.pnl >= 0 ? `+${Math.round(r.pnl).toLocaleString()}` : Math.round(r.pnl).toLocaleString();
    console.log(`  ${r.sym} ${r.name}: ${r.count}件 勝率${wr}% ${pnlStr}円`);
  }
  console.log();

  // 決済理由別集計
  console.log("【決済理由別】");
  const byReason: Record<string, any[]> = {};
  for (const t of targetTrades) {
    const reason = t.reason || "unknown";
    if (!byReason[reason]) byReason[reason] = [];
    byReason[reason].push(t);
  }
  for (const [reason, ts] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
    const pnl = ts.reduce((s, t) => s + Number(t.pnl || 0), 0);
    const pnlStr = pnl >= 0 ? `+${Math.round(pnl).toLocaleString()}` : Math.round(pnl).toLocaleString();
    console.log(`  ${reason}: ${ts.length}件 ${pnlStr}円`);
  }
  console.log();

  // 個別取引一覧
  console.log("【個別取引一覧】");
  for (const t of trades) {
    const name = SYMBOL_NAMES[t.symbol] || t.symbol;
    const pnlStr = t.pnl !== null ? ((Number(t.pnl) >= 0 ? "+" : "") + Math.round(Number(t.pnl)).toLocaleString() + "円") : "";
    const timeStr = t.tradeTime ? String(t.tradeTime).slice(11, 16) : "?";
    console.log(
      `  ${t.symbol}(${name}) ${t.side || ""} ${t.action || ""} @${t.price} ×${t.shares}株 ${timeStr} ${pnlStr} [${t.reason || ""}]`
    );
  }

  await db.end();
}

main().catch(console.error);
