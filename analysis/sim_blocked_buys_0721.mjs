/**
 * 7/21にブロックされたBUYシグナルを仮にエントリーしていた場合のシミュレーション
 * 
 * 本番ログから確認されたBUYシグナル（板読みスコア不足でブロック）:
 * - 大台超え系: 6857@28800, 285A@57700, 8035@65600, 6981@7900, 8035@66000, 8035@66200, 8035@66300
 * - ダウ理論系: 6857, 8035, 6981, 5803, 6526 (多数)
 * 
 * また、大台確認完了→押し目待ち中にタイムアウトしたもの:
 * - 285A 大台超え(60400円) → 0.8%ブロック(乖離1.72%)
 * - 6976 大台超え(11600円) → 結果不明
 */
import mysql from "mysql2/promise";

const POSITION_SIZE = 3_000_000;
const SL_PCT = 0.005;  // 0.5% SL
const TP_PCT = 0.015;  // 1.5% TP
const FORCE_EXIT_TIME = "15:25";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 全アクティブ銘柄の1分足データ取得
const SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A'];
const candlesBySymbol = {};

for (const sym of SYMBOLS) {
  const [rows] = await conn.execute(`
    SELECT candleTime, open, high, low, close, volume 
    FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-21' ORDER BY candleTime
  `, [sym]);
  candlesBySymbol[sym] = rows.map(r => ({
    time: r.candleTime, open: Number(r.open), high: Number(r.high),
    low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
  }));
}

// シミュレーション関数（LONG）
function simLong(symbol, entryTime) {
  const candles = candlesBySymbol[symbol];
  if (!candles) return null;
  
  const entryIdx = candles.findIndex(c => c.time >= entryTime);
  if (entryIdx < 0 || entryIdx + 1 >= candles.length) return null;
  
  // 次の足の始値でエントリー
  const entryCandle = candles[entryIdx + 1];
  const entryPrice = entryCandle.open;
  const shares = Math.floor(POSITION_SIZE / entryPrice);
  const slPrice = entryPrice * (1 - SL_PCT);
  const tpPrice = entryPrice * (1 + TP_PCT);
  
  for (let j = entryIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    // SL check (low hits SL)
    if (c.low <= slPrice) {
      const pnl = Math.round((slPrice - entryPrice) * shares);
      return { entryPrice, exitPrice: slPrice, pnl, exitReason: "SL", exitTime: c.time, shares };
    }
    // TP check (high hits TP)
    if (c.high >= tpPrice) {
      const pnl = Math.round((tpPrice - entryPrice) * shares);
      return { entryPrice, exitPrice: tpPrice, pnl, exitReason: "TP", exitTime: c.time, shares };
    }
    // Force exit
    if (c.time >= FORCE_EXIT_TIME) {
      const pnl = Math.round((c.close - entryPrice) * shares);
      return { entryPrice, exitPrice: c.close, pnl, exitReason: "EOD", exitTime: c.time, shares };
    }
  }
  return null;
}

// ログから確認されたブロックされたBUYシグナル一覧
// 重複を除き、最初の発生時刻でシミュレーション
const blockedSignals = [
  // 午前（10:41-10:49 JST）
  { symbol: "6857", time: "10:41", reason: "大台超え (28900円突破)｜信頼度：中", score: -2 },
  { symbol: "8035", time: "10:41", reason: "大台超え (65600円突破)｜信頼度：中", score: -4 },
  { symbol: "285A", time: "10:49", reason: "大台超え (57700円突破)｜信頼度：中", score: -2 },
  { symbol: "6857", time: "10:49", reason: "大台超え (28800円突破)｜信頼度：中", score: -2 },
  // 午後（14:39-15:05 JST）
  { symbol: "6857", time: "14:39", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -2 },
  { symbol: "8035", time: "14:39", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -2 },
  { symbol: "6981", time: "14:39", reason: "大台超え (7900円突破)｜信頼度：中", score: -2 },
  { symbol: "6981", time: "14:42", reason: "ダウ理論: 直近高値更新｜信頼度：中", score: 0 },
  { symbol: "8035", time: "14:42", reason: "大台超え (66000円突破)｜信頼度：強", score: -2 },
  { symbol: "8035", time: "14:44", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -4 },
  { symbol: "5803", time: "14:45", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -4 },
  { symbol: "6857", time: "14:47", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -2 },
  { symbol: "8035", time: "14:47", reason: "ダウ理論: 直近高値更新｜信頼度：中", score: -2 },
  { symbol: "6981", time: "14:49", reason: "ダウ理論: 直近高値更新｜信頼度：中", score: -2 },
  { symbol: "5803", time: "14:49", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -2 },
  { symbol: "6857", time: "14:50", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -3 },
  { symbol: "8035", time: "14:50", reason: "ダウ理論: 直近高値更新｜信頼度：中", score: -2 },
  { symbol: "6981", time: "14:50", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: 0 },
  { symbol: "8035", time: "14:55", reason: "ダウ理論: 直近高値更新｜信頼度：中", score: 0 },
  { symbol: "5803", time: "14:55", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -2 },
  { symbol: "6526", time: "14:58", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: -4 },
  { symbol: "6526", time: "15:01", reason: "ダウ理論: 直近高値更新｜信頼度：強", score: 0 },
  { symbol: "8035", time: "15:01", reason: "大台超え (66200円突破)｜信頼度：中", score: -4 },
  { symbol: "8035", time: "15:05", reason: "大台超え (66300円突破)｜信頼度：中", score: 0 },
];

// 同一銘柄の重複シグナルを除外（ポジション保有中は新規エントリーしない）
// 最初のシグナルのみシミュレーション、決済後に次のシグナルを処理
console.log("=== ブロックされたBUYシグナル 仮想エントリーシミュレーション ===\n");
console.log("条件: LONG / ポジションサイズ300万円 / SL=0.5% / TP=1.5% / 15:25強制決済\n");

const results = [];
const activePositions = new Set(); // 同時に同じ銘柄は持たない

for (const sig of blockedSignals) {
  // 同一銘柄で既にポジション保有中（前のシグナルが未決済）の場合はスキップ
  // ただし簡易的に、全シグナルを独立にシミュレーション
  const result = simLong(sig.symbol, sig.time);
  if (result) {
    results.push({ ...sig, ...result });
  }
}

// 結果表示
let totalPnl = 0;
let wins = 0;
let losses = 0;

console.log("| # | 時刻 | 銘柄 | スコア | エントリー | 決済 | 損益 | 結果 | 決済時刻 | シグナル |");
console.log("|---|------|------|------:|----------:|-----:|-----:|------|---------|---------|");

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  totalPnl += r.pnl;
  if (r.pnl > 0) wins++; else losses++;
  const pnlStr = r.pnl >= 0 ? `+${r.pnl.toLocaleString()}` : r.pnl.toLocaleString();
  console.log(`| ${i+1} | ${r.time} | ${r.symbol} | ${r.score} | ${r.entryPrice} | ${r.exitPrice.toFixed(0)} | ${pnlStr} | ${r.exitReason} | ${r.exitTime} | ${r.reason.substring(0, 30)} |`);
}

console.log(`\n=== サマリー ===`);
console.log(`総シグナル数: ${results.length}件`);
console.log(`勝ち: ${wins}件 / 負け: ${losses}件 (勝率: ${(wins/results.length*100).toFixed(1)}%)`);
console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);

// 重複除外版（同一銘柄は1ポジションのみ）
console.log(`\n\n=== 重複除外版（同一銘柄は決済後のみ次のエントリー可能） ===\n`);
const positionEnd = {}; // symbol -> exitTime
let dedupResults = [];

for (const sig of blockedSignals) {
  // 前のポジションが決済済みか確認
  if (positionEnd[sig.symbol] && sig.time < positionEnd[sig.symbol]) {
    continue; // まだ保有中
  }
  const result = simLong(sig.symbol, sig.time);
  if (result) {
    positionEnd[sig.symbol] = result.exitTime;
    dedupResults.push({ ...sig, ...result });
  }
}

let dedupPnl = 0;
let dedupWins = 0;
let dedupLosses = 0;

console.log("| # | 時刻 | 銘柄 | スコア | エントリー | 決済 | 損益 | 結果 | 決済時刻 |");
console.log("|---|------|------|------:|----------:|-----:|-----:|------|---------|");

for (let i = 0; i < dedupResults.length; i++) {
  const r = dedupResults[i];
  dedupPnl += r.pnl;
  if (r.pnl > 0) dedupWins++; else dedupLosses++;
  const pnlStr = r.pnl >= 0 ? `+${r.pnl.toLocaleString()}` : r.pnl.toLocaleString();
  console.log(`| ${i+1} | ${r.time} | ${r.symbol} | ${r.score} | ${r.entryPrice} | ${r.exitPrice.toFixed(0)} | ${pnlStr} | ${r.exitReason} | ${r.exitTime} |`);
}

console.log(`\n重複除外サマリー:`);
console.log(`取引数: ${dedupResults.length}件`);
console.log(`勝ち: ${dedupWins}件 / 負け: ${dedupLosses}件 (勝率: ${(dedupWins/dedupResults.length*100).toFixed(1)}%)`);
console.log(`総損益: ${dedupPnl >= 0 ? '+' : ''}${dedupPnl.toLocaleString()}円`);

await conn.end();
