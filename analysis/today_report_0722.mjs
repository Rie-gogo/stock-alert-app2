import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);
const TODAY = "2026-07-22";

// 1. 当日の取引データ
const [trades] = await conn.execute(
  "SELECT * FROM rt_trades WHERE tradeDate = ? ORDER BY tradeTime",
  [TODAY]
);
console.log(`=== ${TODAY} リアルタイムシミュレーション結果 ===\n`);
console.log(`取引レコード数: ${trades.length}`);

if (trades.length === 0) {
  // データがない場合、最新の日付を確認
  const [latest] = await conn.execute("SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate DESC LIMIT 5");
  console.log("\n最新の取引日:");
  for (const r of latest) console.log(`  ${r.tradeDate}`);
  
  // ローソク足データがあるか確認
  const [candles] = await conn.execute(
    "SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = ?", [TODAY]
  );
  console.log(`\n${TODAY}のローソク足データ: ${candles[0].cnt}本`);
  
  // daily summaryを確認
  const [summary] = await conn.execute(
    "SELECT * FROM rt_daily_summaries WHERE tradeDate = ?", [TODAY]
  );
  console.log(`\n${TODAY}のデイリーサマリー: ${summary.length}件`);
  if (summary.length > 0) {
    for (const s of summary) {
      console.log(JSON.stringify(s, null, 2));
    }
  }
} else {
  // エントリーと決済をペアリング
  const entries = trades.filter(t => t.action === 'buy' || t.action === 'short');
  const exits = trades.filter(t => t.action === 'sell' || t.action === 'cover');
  
  console.log(`エントリー: ${entries.length}件 / 決済: ${exits.length}件\n`);
  
  // ペアリング
  const paired = [];
  const usedExits = new Set();
  for (const entry of entries) {
    const exit = exits.find((e, idx) => 
      !usedExits.has(idx) && e.symbol === entry.symbol && e.tradeTime > entry.tradeTime
    );
    if (exit) {
      const exitIdx = exits.indexOf(exit);
      usedExits.add(exitIdx);
      paired.push({
        symbol: entry.symbol,
        symbolName: entry.symbolName,
        side: entry.side,
        entryTime: entry.tradeTime,
        entryPrice: Number(entry.price),
        exitTime: exit.tradeTime,
        exitPrice: Number(exit.price),
        pnl: Number(exit.pnl),
        reason: exit.reason,
        shares: Number(entry.shares),
      });
    }
  }
  
  // 全取引表示
  console.log("--- 取引一覧 ---");
  console.log("| # | 時刻 | 銘柄 | 方向 | エントリー | 決済 | 損益 | 理由 |");
  console.log("|---|------|------|------|----------:|-----:|-----:|------|");
  let totalPnl = 0;
  let wins = 0;
  for (let i = 0; i < paired.length; i++) {
    const t = paired[i];
    totalPnl += t.pnl;
    if (t.pnl > 0) wins++;
    const pnlStr = t.pnl >= 0 ? `+${t.pnl.toLocaleString()}` : t.pnl.toLocaleString();
    console.log(`| ${i+1} | ${t.entryTime}→${t.exitTime} | ${t.symbol} ${t.symbolName} | ${t.side} | ${t.entryPrice.toLocaleString()} | ${t.exitPrice.toLocaleString()} | ${pnlStr} | ${t.reason?.substring(0, 30)} |`);
  }
  
  console.log(`\n--- サマリー ---`);
  console.log(`取引数: ${paired.length}件`);
  console.log(`勝敗: ${wins}勝 ${paired.length - wins}敗 (勝率: ${(wins/paired.length*100).toFixed(1)}%)`);
  console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  
  // 銘柄別
  console.log(`\n--- 銘柄別損益 ---`);
  const bySymbol = {};
  for (const t of paired) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { name: t.symbolName, pnl: 0, count: 0, wins: 0 };
    bySymbol[t.symbol].pnl += t.pnl;
    bySymbol[t.symbol].count++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
  }
  console.log("| 銘柄 | 件数 | 勝率 | 損益 |");
  console.log("|------|-----:|-----:|-----:|");
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    console.log(`| ${sym} ${data.name} | ${data.count} | ${(data.wins/data.count*100).toFixed(0)}% | ${pnlStr} |`);
  }
  
  // シグナル別
  console.log(`\n--- 決済理由別 ---`);
  const byReason = {};
  for (const t of paired) {
    const reason = t.pnl > 0 ? "TP/プラス決済" : "SL/マイナス決済";
    if (!byReason[reason]) byReason[reason] = { pnl: 0, count: 0 };
    byReason[reason].pnl += t.pnl;
    byReason[reason].count++;
  }
  for (const [reason, data] of Object.entries(byReason)) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    console.log(`  ${reason}: ${data.count}件 / ${pnlStr}円`);
  }
}

// ローソク足の受信状況
const [candleStats] = await conn.execute(
  "SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as first_t, MAX(candleTime) as last_t FROM rt_candles WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol",
  [TODAY]
);
console.log(`\n--- ローソク足受信状況 ---`);
console.log(`銘柄数: ${candleStats.length}`);
if (candleStats.length > 0) {
  let totalCandles = 0;
  for (const c of candleStats) {
    totalCandles += Number(c.cnt);
  }
  console.log(`総ローソク足数: ${totalCandles}本`);
  console.log(`時間帯: ${candleStats[0]?.first_t} 〜 ${candleStats[0]?.last_t}`);
}

await conn.end();
