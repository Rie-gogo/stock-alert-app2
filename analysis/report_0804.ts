import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const today = "2026-08-04";

  console.log(`=== 8/4（月）日次レポート ===`);

  // 1. Check candles
  const [candles] = await conn.execute(
    "SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = ?",
    [today]
  );
  const candleCount = (candles as any)[0].cnt;
  console.log(`\n【データ受信状況】`);
  console.log(`受信バー数: ${candleCount}`);

  if (candleCount > 0) {
    const [bySymbol] = await conn.execute(
      `SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as first_bar, MAX(candleTime) as last_bar 
       FROM rt_candles WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol`,
      [today]
    );
    console.log(`銘柄別受信:`);
    for (const r of bySymbol as any[]) {
      console.log(`  ${r.symbol}: ${r.cnt}本 (${r.first_bar}〜${r.last_bar})`);
    }
  } else {
    console.log("  *** 本日のデータ受信なし ***");
  }

  // 2. Check trades (columns: tradeDate, symbol, symbolName, action, price, shares, amount, pnl, reason, tradeTime, side, boardSignal)
  const [trades] = await conn.execute(
    `SELECT * FROM rt_trades WHERE tradeDate = ? ORDER BY tradeTime`,
    [today]
  );
  const tradeRows = trades as any[];
  console.log(`\n【取引結果】`);
  console.log(`取引件数: ${tradeRows.length}件`);

  if (tradeRows.length > 0) {
    const wins = tradeRows.filter(t => Number(t.pnl) > 0).length;
    const losses = tradeRows.filter(t => Number(t.pnl) < 0).length;
    const even = tradeRows.filter(t => Number(t.pnl) === 0).length;
    const totalPnl = tradeRows.reduce((s, t) => s + Number(t.pnl), 0);
    const winRate = tradeRows.length > 0 ? (wins / tradeRows.length * 100).toFixed(1) : "0";

    console.log(`勝ち: ${wins}件 / 負け: ${losses}件 / 引分: ${even}件`);
    console.log(`勝率: ${winRate}%`);
    console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);

    // By symbol
    console.log(`\n【銘柄別損益】`);
    const bySymbolMap: Record<string, { pnl: number; count: number; wins: number; name: string }> = {};
    for (const t of tradeRows) {
      const sym = t.symbol;
      if (!bySymbolMap[sym]) bySymbolMap[sym] = { pnl: 0, count: 0, wins: 0, name: t.symbolName || sym };
      bySymbolMap[sym].pnl += Number(t.pnl);
      bySymbolMap[sym].count++;
      if (Number(t.pnl) > 0) bySymbolMap[sym].wins++;
    }
    for (const [sym, data] of Object.entries(bySymbolMap).sort((a, b) => b[1].pnl - a[1].pnl)) {
      console.log(`  ${sym} ${data.name}: ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${(data.wins/data.count*100).toFixed(0)}%)`);
    }

    // By signal type (boardSignal column)
    console.log(`\n【シグナル別成績】`);
    const bySignalMap: Record<string, { pnl: number; count: number; wins: number }> = {};
    for (const t of tradeRows) {
      const sig = t.boardSignal || t.reason || "unknown";
      if (!bySignalMap[sig]) bySignalMap[sig] = { pnl: 0, count: 0, wins: 0 };
      bySignalMap[sig].pnl += Number(t.pnl);
      bySignalMap[sig].count++;
      if (Number(t.pnl) > 0) bySignalMap[sig].wins++;
    }
    for (const [sig, data] of Object.entries(bySignalMap).sort((a, b) => b[1].pnl - a[1].pnl)) {
      console.log(`  ${sig}: ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${(data.wins/data.count*100).toFixed(0)}%)`);
    }

    // Individual trades
    console.log(`\n【個別取引一覧】`);
    for (const t of tradeRows) {
      const pnl = Number(t.pnl);
      console.log(`  ${t.tradeTime} ${t.symbol} ${t.side} ${t.action} ${t.boardSignal || ""} → ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 (${t.reason})`);
    }
  } else {
    console.log("  取引なし（データ未受信のため）");
  }

  // 3. Check daily summaries
  const [summaries] = await conn.execute(
    "SELECT * FROM rt_daily_summaries WHERE tradeDate = ?",
    [today]
  );
  const sumRows = summaries as any[];
  if (sumRows.length > 0) {
    console.log(`\n【日次サマリー（DB記録）】`);
    const s = sumRows[0];
    console.log(`  初期資本: ${Number(s.initialCapital).toLocaleString()}円`);
    console.log(`  総損益: ${Number(s.totalPnl).toLocaleString()}円`);
    console.log(`  取引数: ${s.tradesCount}件 (勝${s.winCount}/負${s.lossCount})`);
    console.log(`  受信バー数: ${s.candlesReceived}`);
    console.log(`  レポート送信: ${s.reportSent ? "済" : "未"}`);
  }

  // 4. Latest dates for context
  console.log(`\n【直近の取引日（参考）】`);
  const [latestTrades] = await conn.execute(
    `SELECT tradeDate, COUNT(*) as cnt, SUM(pnl) as totalPnl FROM rt_trades GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 5`
  );
  for (const r of latestTrades as any[]) {
    const pnl = Number(r.totalPnl);
    console.log(`  ${r.tradeDate}: ${r.cnt}件 ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }

  await conn.end();
}
main();
