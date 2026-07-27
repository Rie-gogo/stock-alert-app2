import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const today = "2026-07-27";

  // Check if today is a weekday (Sunday=0, Saturday=6)
  const dayOfWeek = new Date(today).getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log(`\n⚠️ ${today} は${dayOfWeek === 0 ? "日" : "土"}曜日です。東証は休場のため取引データはありません。\n`);
    // Check if there's any data anyway
    const check = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM rt_trades WHERE tradeDate = ${today}
    `);
    const cnt = (check as any)[0][0].cnt;
    if (cnt > 0) {
      console.log(`  ※ ただしDBに${cnt}件のレコードがあります。以下に表示します。\n`);
    } else {
      // Show the most recent trading day instead
      const lastDay = await db.execute(sql`
        SELECT tradeDate, COUNT(*) as cnt FROM rt_trades 
        WHERE tradeDate <= ${today}
        GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 1
      `);
      const lastRow = (lastDay as any)[0][0];
      if (lastRow) {
        console.log(`  直近の取引日: ${lastRow.tradeDate}（${lastRow.cnt}件）`);
        console.log(`  直近の取引日のレポートを表示します。\n`);
        await reportDay(db, lastRow.tradeDate);
      }
      process.exit(0);
      return;
    }
  }

  await reportDay(db, today);
  process.exit(0);
}

async function reportDay(db: any, targetDate: string) {
  // Get all trades for the target date
  const result = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, pnl, reason, shares
    FROM rt_trades 
    WHERE tradeDate = ${targetDate}
    ORDER BY tradeTime
  `);
  const rows = (result as any)[0];

  if (rows.length === 0) {
    console.log(`  ${targetDate} の取引データはありません。`);
    return;
  }

  // Separate entries and exits
  const entries = rows.filter((r: any) => r.action === "buy" || r.action === "short");
  const exits = rows.filter((r: any) => r.action !== "buy" && r.action !== "short");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  リアルタイムシミュレーション日次レポート: ${targetDate}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Summary
  const totalPnl = exits.reduce((sum: number, r: any) => sum + Number(r.pnl), 0);
  const wins = exits.filter((r: any) => Number(r.pnl) > 0).length;
  const losses = exits.filter((r: any) => Number(r.pnl) <= 0).length;
  const winRate = exits.length > 0 ? (wins / exits.length * 100).toFixed(0) : "0";

  console.log("■ サマリー\n");
  console.log(`  取引回数: ${exits.length}件（エントリー${entries.length}件）`);
  console.log(`  勝敗: ${wins}勝${losses}敗（勝率${winRate}%）`);
  console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  if (exits.length > 0) {
    console.log(`  平均損益: ${Math.round(totalPnl / exits.length) >= 0 ? "+" : ""}${Math.round(totalPnl / exits.length).toLocaleString()}円/件`);
  }

  // Trade details
  console.log("\n■ 取引詳細\n");
  console.log(`  ${"時刻".padEnd(14)} ${"銘柄".padEnd(6)} ${"方向".padEnd(6)} ${"価格".padStart(8)} ${"損益".padStart(12)} ${"理由"}`);
  console.log("  " + "─".repeat(80));

  // Pair entries with exits
  for (const entry of entries) {
    const matchingExit = exits.find((ex: any) => 
      ex.symbol === entry.symbol && ex.tradeTime > entry.tradeTime
    );
    
    const direction = entry.action === "buy" ? "LONG" : "SHORT";
    const entryTime = (entry.tradeTime as string).slice(0, 5);
    
    if (matchingExit) {
      const exitTime = (matchingExit.tradeTime as string).slice(0, 5);
      const pnl = Number(matchingExit.pnl);
      const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toLocaleString() + "円";
      const result = pnl > 0 ? "✓" : "✗";
      
      // Extract exit reason
      let exitReason = "";
      const reason = matchingExit.reason as string;
      if (reason.includes("損切り")) exitReason = "損切り";
      else if (reason.includes("利確")) exitReason = "利確";
      else if (reason.includes("強制")) exitReason = "強制決済";
      else if (reason.includes("タイムアウト")) exitReason = "タイムアウト";
      else exitReason = reason.slice(0, 20);

      console.log(`  ${result} ${entryTime}→${exitTime} ${(entry.symbol as string).padEnd(6)} ${direction.padEnd(6)} ${Number(entry.price).toLocaleString().padStart(8)} ${pnlStr.padStart(12)} ${exitReason}`);
    } else {
      console.log(`  ○ ${entryTime}→保有中 ${(entry.symbol as string).padEnd(6)} ${direction.padEnd(6)} ${Number(entry.price).toLocaleString().padStart(8)} ${"(未決済)".padStart(12)}`);
    }
  }

  // Symbol breakdown
  console.log("\n■ 銘柄別損益\n");
  const symbolMap = new Map<string, { wins: number; losses: number; pnl: number }>();
  for (const exit of exits) {
    const sym = exit.symbol as string;
    if (!symbolMap.has(sym)) symbolMap.set(sym, { wins: 0, losses: 0, pnl: 0 });
    const s = symbolMap.get(sym)!;
    const pnl = Number(exit.pnl);
    s.pnl += pnl;
    if (pnl > 0) s.wins++;
    else s.losses++;
  }

  console.log(`  ${"銘柄".padEnd(8)} ${"勝敗".padStart(8)} ${"損益".padStart(12)}`);
  console.log("  " + "─".repeat(35));
  for (const [sym, data] of [...symbolMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym.padEnd(8)} ${(data.wins + "勝" + data.losses + "敗").padStart(8)} ${((data.pnl >= 0 ? "+" : "") + data.pnl.toLocaleString() + "円").padStart(12)}`);
  }

  // Signal type breakdown
  console.log("\n■ シグナル別成績\n");
  const signalMap = new Map<string, { wins: number; losses: number; pnl: number }>();
  for (const entry of entries) {
    const reason = entry.reason as string;
    let signalType = "その他";
    if (reason.includes("大台超え")) signalType = "大台超え(LONG)";
    else if (reason.includes("大台割れ")) signalType = "大台割れ(SHORT)";
    else if (reason.includes("VWAP反発")) signalType = "VWAP反発";
    else if (reason.includes("VWAP割れ")) signalType = "VWAP割れ";
    else if (reason.includes("ダウ理論")) signalType = "ダウ理論";
    else if (reason.includes("三尊")) signalType = "三尊";
    else if (reason.includes("ブレイクアウト")) signalType = "ブレイクアウト";
    else if (reason.includes("押し目")) signalType = "押し目買い";
    else if (reason.includes("戻り売り")) signalType = "戻り売り";

    if (!signalMap.has(signalType)) signalMap.set(signalType, { wins: 0, losses: 0, pnl: 0 });

    // Find matching exit
    const matchingExit = exits.find((ex: any) => 
      ex.symbol === entry.symbol && ex.tradeTime > entry.tradeTime
    );
    if (matchingExit) {
      const pnl = Number(matchingExit.pnl);
      const s = signalMap.get(signalType)!;
      s.pnl += pnl;
      if (pnl > 0) s.wins++;
      else s.losses++;
    }
  }

  console.log(`  ${"シグナル".padEnd(18)} ${"勝敗".padStart(8)} ${"損益".padStart(12)}`);
  console.log("  " + "─".repeat(42));
  for (const [sig, data] of [...signalMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sig.padEnd(18)} ${(data.wins + "勝" + data.losses + "敗").padStart(8)} ${((data.pnl >= 0 ? "+" : "") + data.pnl.toLocaleString() + "円").padStart(12)}`);
  }

  // Exit reason breakdown
  console.log("\n■ 決済理由別\n");
  const exitReasonMap = new Map<string, { count: number; pnl: number }>();
  for (const exit of exits) {
    const reason = exit.reason as string;
    let exitType = "その他";
    if (reason.includes("損切り")) exitType = "損切り";
    else if (reason.includes("利確")) exitType = "利確";
    else if (reason.includes("強制")) exitType = "強制決済";
    else if (reason.includes("タイムアウト")) exitType = "タイムアウト";
    else if (reason.includes("板読み")) exitType = "板読み早期利確";

    if (!exitReasonMap.has(exitType)) exitReasonMap.set(exitType, { count: 0, pnl: 0 });
    const e = exitReasonMap.get(exitType)!;
    e.count++;
    e.pnl += Number(exit.pnl);
  }

  console.log(`  ${"理由".padEnd(16)} ${"件数".padStart(5)} ${"損益".padStart(12)}`);
  console.log("  " + "─".repeat(35));
  for (const [reason, data] of [...exitReasonMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason.padEnd(16)} ${(data.count + "件").padStart(5)} ${((data.pnl >= 0 ? "+" : "") + data.pnl.toLocaleString() + "円").padStart(12)}`);
  }

  // Check daily summary table
  const summary = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${targetDate}
  `);
  const summaryRows = (summary as any)[0];
  if (summaryRows.length > 0) {
    console.log("\n■ デイリーサマリー（DB記録）\n");
    const s = summaryRows[0];
    console.log(`  資本: ${Number(s.capital).toLocaleString()}円`);
    console.log(`  日次損益: ${Number(s.dailyPnl) >= 0 ? "+" : ""}${Number(s.dailyPnl).toLocaleString()}円`);
    console.log(`  取引数: ${s.tradeCount}件`);
    console.log(`  勝率: ${s.winRate}%`);
  }

  // Special notes
  console.log("\n■ 特記事項\n");
  const stopLossCount = exits.filter((r: any) => (r.reason as string).includes("損切り")).length;
  if (stopLossCount >= 3) {
    console.log(`  ⚠️ 損切り多発: ${stopLossCount}件`);
  }
  if (exits.length === 0) {
    console.log(`  ⚠️ 取引なし（シグナル未検出またはフィルターで全ブロック）`);
  }
  if (wins === 0 && exits.length > 0) {
    console.log(`  ⚠️ 全敗（${exits.length}件全て損失）`);
  }
  if (totalPnl > 50000) {
    console.log(`  ★ 大勝日: +${totalPnl.toLocaleString()}円`);
  }
  if (totalPnl < -50000) {
    console.log(`  ⚠️ 大敗日: ${totalPnl.toLocaleString()}円`);
  }
  if (entries.length <= 2 && exits.length <= 2) {
    console.log(`  ⚠️ 取引数極少（${entries.length}件のみ）: フィルター過剰ブロックの可能性`);
  }

  // Check candle count
  const candleCount = await db.execute(sql`
    SELECT COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols,
           MIN(tradeTime) as firstTime, MAX(tradeTime) as lastTime
    FROM rt_candles WHERE tradeDate = ${targetDate}
  `);
  const cc = (candleCount as any)[0][0];
  if (cc.cnt > 0) {
    console.log(`\n■ データ受信状況\n`);
    console.log(`  ローソク足: ${Number(cc.cnt).toLocaleString()}本（${cc.symbols}銘柄）`);
    console.log(`  受信時間: ${(cc.firstTime as string).slice(0, 5)} ～ ${(cc.lastTime as string).slice(0, 5)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
