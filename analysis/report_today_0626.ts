/**
 * 6/26 リアルタイムシミュレーション日次レポート集計スクリプト
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { eq, desc } from "drizzle-orm";
import * as schema from "../drizzle/schema";

async function main() {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const db = drizzle(connection, { schema, mode: "default" });

  const tradeDate = "2026-06-26";

  // 全取引を取得
  const trades = await db
    .select()
    .from(schema.rtTrades)
    .where(eq(schema.rtTrades.tradeDate, tradeDate))
    .orderBy(schema.rtTrades.id);

  console.log(`\n===== ${tradeDate} リアルタイムシミュレーション結果 =====\n`);
  console.log(`総取引件数: ${trades.length}件`);

  // エントリーと決済を分離
  const entries = trades.filter(t => t.action === "buy" || t.action === "short");
  const exits = trades.filter(t => t.action === "sell" || t.action === "cover");

  console.log(`エントリー: ${entries.length}件`);
  console.log(`決済: ${exits.length}件`);

  // 損益集計
  const totalPnl = exits.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const wins = exits.filter(t => (t.pnl ?? 0) > 0);
  const losses = exits.filter(t => (t.pnl ?? 0) < 0);
  const even = exits.filter(t => (t.pnl ?? 0) === 0);

  console.log(`\n--- 損益サマリー ---`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`勝ち: ${wins.length}件 / 負け: ${losses.length}件 / 引分: ${even.length}件`);
  console.log(`勝率: ${exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : "-"}%`);

  if (wins.length > 0) {
    const avgWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length;
    console.log(`平均利益: +${Math.round(avgWin).toLocaleString()}円`);
  }
  if (losses.length > 0) {
    const avgLoss = losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length;
    console.log(`平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
  }

  // 銘柄別損益
  console.log(`\n--- 銘柄別損益 ---`);
  const symbolPnl: Record<string, { pnl: number; wins: number; losses: number; trades: number; symbolName: string }> = {};
  for (const t of exits) {
    if (!symbolPnl[t.symbol]) {
      symbolPnl[t.symbol] = { pnl: 0, wins: 0, losses: 0, trades: 0, symbolName: t.symbolName };
    }
    symbolPnl[t.symbol].pnl += (t.pnl ?? 0);
    symbolPnl[t.symbol].trades++;
    if ((t.pnl ?? 0) > 0) symbolPnl[t.symbol].wins++;
    else symbolPnl[t.symbol].losses++;
  }

  const sortedSymbols = Object.entries(symbolPnl).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sym, data] of sortedSymbols) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    console.log(`  ${sym} ${data.symbolName}: ${pnlStr}円 (${data.wins}勝${data.losses}敗)`);
  }

  // シグナル別（理由別）成績
  console.log(`\n--- シグナル別成績 ---`);
  // エントリー理由から信頼度を抽出
  const signalPerf: Record<string, { pnl: number; wins: number; losses: number; count: number }> = {};

  // エントリーと対応する決済をペアリング
  // 同一銘柄のエントリー→決済の順序でペアリング
  const entryMap: Record<string, typeof entries> = {};
  for (const e of entries) {
    if (!entryMap[e.symbol]) entryMap[e.symbol] = [];
    entryMap[e.symbol].push(e);
  }

  const exitMap: Record<string, typeof exits> = {};
  for (const e of exits) {
    if (!exitMap[e.symbol]) exitMap[e.symbol] = [];
    exitMap[e.symbol].push(e);
  }

  // ペアリング
  for (const symbol of Object.keys(exitMap)) {
    const symEntries = entryMap[symbol] ?? [];
    const symExits = exitMap[symbol] ?? [];
    for (let i = 0; i < symExits.length; i++) {
      const exit = symExits[i];
      const entry = symEntries[i]; // 順番でペアリング
      if (!entry) continue;

      // エントリー理由からシグナルタイプを抽出
      const reason = entry.reason;
      let signalType = "不明";
      if (reason.includes("VWAP")) signalType = "VWAPクロス";
      else if (reason.includes("大台確認") || reason.includes("大台割れ") || reason.includes("大台超え")) signalType = "大台確認";
      else if (reason.includes("ダウ理論")) signalType = "ダウ理論";
      else if (reason.includes("VWAP反発") || reason.includes("VWAP反落")) signalType = "VWAP反発/反落";
      else if (reason.includes("MAクロス")) signalType = "MAクロス";
      else if (reason.includes("逆三尊")) signalType = "逆三尊";
      else if (reason.includes("三尊")) signalType = "三尊";
      else if (reason.includes("ダブルボトム")) signalType = "ダブルボトム";
      else if (reason.includes("ダブルトップ")) signalType = "ダブルトップ";
      else signalType = reason.split("|")[0].split("(")[0].trim().slice(0, 20);

      if (!signalPerf[signalType]) signalPerf[signalType] = { pnl: 0, wins: 0, losses: 0, count: 0 };
      signalPerf[signalType].pnl += (exit.pnl ?? 0);
      signalPerf[signalType].count++;
      if ((exit.pnl ?? 0) > 0) signalPerf[signalType].wins++;
      else signalPerf[signalType].losses++;
    }
  }

  const sortedSignals = Object.entries(signalPerf).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sig, data] of sortedSignals) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(0) : "-";
    console.log(`  ${sig}: ${pnlStr}円 (${data.count}件, 勝率${wr}%)`);
  }

  // 決済理由別
  console.log(`\n--- 決済理由別 ---`);
  const exitReasonPerf: Record<string, { pnl: number; count: number }> = {};
  for (const t of exits) {
    let exitType = "不明";
    if (t.reason.includes("損切り") || t.reason.includes("損切")) exitType = "損切り";
    else if (t.reason.includes("利確") || t.reason.includes("利確ライン")) exitType = "利確";
    else if (t.reason.includes("大引け強制決済")) exitType = "大引け強制決済";
    else if (t.reason.includes("反転シグナル")) exitType = "反転シグナル決済";
    else exitType = t.reason.slice(0, 20);

    if (!exitReasonPerf[exitType]) exitReasonPerf[exitType] = { pnl: 0, count: 0 };
    exitReasonPerf[exitType].pnl += (t.pnl ?? 0);
    exitReasonPerf[exitType].count++;
  }

  for (const [reason, data] of Object.entries(exitReasonPerf).sort((a, b) => b[1].count - a[1].count)) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    console.log(`  ${reason}: ${data.count}件, ${pnlStr}円`);
  }

  // 信頼度別
  console.log(`\n--- 信頼度別成績 ---`);
  const confPerf: Record<string, { pnl: number; wins: number; losses: number; count: number }> = {};
  for (const symbol of Object.keys(exitMap)) {
    const symEntries = entryMap[symbol] ?? [];
    const symExits = exitMap[symbol] ?? [];
    for (let i = 0; i < symExits.length; i++) {
      const exit = symExits[i];
      const entry = symEntries[i];
      if (!entry) continue;

      let conf = "なし";
      const confMatch = entry.reason.match(/\[信頼度[：:]\s*(強|中|弱)\]/);
      if (confMatch) conf = confMatch[1];

      if (!confPerf[conf]) confPerf[conf] = { pnl: 0, wins: 0, losses: 0, count: 0 };
      confPerf[conf].pnl += (exit.pnl ?? 0);
      confPerf[conf].count++;
      if ((exit.pnl ?? 0) > 0) confPerf[conf].wins++;
      else confPerf[conf].losses++;
    }
  }

  for (const [conf, data] of Object.entries(confPerf).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(0) : "-";
    console.log(`  信頼度「${conf}」: ${pnlStr}円 (${data.count}件, 勝率${wr}%)`);
  }

  // 全取引詳細
  console.log(`\n--- 全取引詳細 ---`);
  console.log("時刻\t銘柄\tアクション\t価格\t株数\t損益\t理由");
  for (const t of trades) {
    const pnlStr = t.pnl !== null ? (t.pnl >= 0 ? `+${t.pnl.toLocaleString()}` : t.pnl.toLocaleString()) : "-";
    console.log(`${t.tradeTime}\t${t.symbol}\t${t.action}\t${Number(t.price).toLocaleString()}\t${t.shares}\t${pnlStr}\t${t.reason.slice(0, 60)}`);
  }

  // 時間帯別
  console.log(`\n--- 時間帯別成績 ---`);
  const hourPerf: Record<string, { pnl: number; count: number }> = {};
  for (const symbol of Object.keys(exitMap)) {
    const symEntries = entryMap[symbol] ?? [];
    const symExits = exitMap[symbol] ?? [];
    for (let i = 0; i < symExits.length; i++) {
      const entry = symEntries[i];
      if (!entry) continue;
      const exit = symExits[i];
      const hour = entry.tradeTime.split(":")[0] + "時台";
      if (!hourPerf[hour]) hourPerf[hour] = { pnl: 0, count: 0 };
      hourPerf[hour].pnl += (exit.pnl ?? 0);
      hourPerf[hour].count++;
    }
  }
  for (const [hour, data] of Object.entries(hourPerf).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pnlStr = data.pnl >= 0 ? `+${data.pnl.toLocaleString()}` : data.pnl.toLocaleString();
    console.log(`  ${hour}: ${data.count}件, ${pnlStr}円`);
  }

  await connection.end();
}

main().catch(console.error);
