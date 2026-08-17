import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;

const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.5, short: 0.8 },
  "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 },
  "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 },
  "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 },
  "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 },
  "8316": { long: 0.5, short: 0.5 },
};

const ACTIVE_SYMBOLS = new Set(Object.keys(SL_MAP));
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_SLOPE_THRESHOLD = 0; // MA20傾き > 0%

interface Candle {
  candleTime: string;
  open: number; high: number; low: number; close: number; volume: number;
}

interface Trade {
  symbol: string; direction: "LONG" | "SHORT"; signalType: string;
  signalTime: string; entryTime: string; entryPrice: number;
  exitTime: string; exitPrice: number; pnl: number; exitReason: string;
  shares: number; isBullish: boolean; boardSim: string;
}

function getRoundLevels(price: number): number[] {
  let step: number;
  if (price < 1000) step = 100;
  else if (price < 3000) step = 200;
  else if (price < 5000) step = 500;
  else if (price < 10000) step = 500;
  else if (price < 30000) step = 1000;
  else if (price < 50000) step = 1000;
  else step = 5000;
  const levels: number[] = [];
  const base = Math.floor(price / step) * step;
  for (let l = base - step * 2; l <= base + step * 2; l += step) {
    if (l > 0) levels.push(l);
  }
  return levels;
}

function calcMA(candles: Candle[], period: number, endIdx: number): number {
  if (endIdx < period - 1) return 0;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += candles[i].close;
  return sum / period;
}

function calcIsBullish(candles: Candle[], idx: number): boolean {
  if (idx < IS_BULLISH_MA_PERIOD + 1) return false;
  const currentMA = calcMA(candles, IS_BULLISH_MA_PERIOD, idx);
  const prevMA = calcMA(candles, IS_BULLISH_MA_PERIOD, idx - 1);
  const slope = (currentMA - prevMA) / prevMA * 100;
  return slope > IS_BULLISH_SLOPE_THRESHOLD;
}

// 簡易板読み判定: 直近5本の値動きから推定
function simBoardSignal(candles: Candle[], idx: number): string {
  if (idx < 5) return "neutral";
  let upBars = 0, downBars = 0;
  for (let i = idx - 4; i <= idx; i++) {
    if (candles[i].close > candles[i].open) upBars++;
    else if (candles[i].close < candles[i].open) downBars++;
  }
  // 直近5本中4本以上が陽線 → buy_pressure相当
  if (upBars >= 4) return "buy_pressure";
  // 直近5本中4本以上が陰線 → sell_pressure相当
  if (downBars >= 4) return "sell_pressure";
  return "neutral";
}

function simulateTrade(candles: Candle[], entryIdx: number, direction: "LONG" | "SHORT", slPct: number): { exitIdx: number; exitPrice: number; pnl: number; exitReason: string; shares: number } {
  const entryPrice = candles[entryIdx].close;
  const shares = Math.floor(3_000_000 / entryPrice / 100) * 100 || 100;
  let slLine: number, tpLine: number;
  if (direction === "LONG") {
    slLine = entryPrice * (1 - slPct / 100);
    tpLine = entryPrice * (1 + TP_PCT / 100);
  } else {
    slLine = entryPrice * (1 + slPct / 100);
    tpLine = entryPrice * (1 - TP_PCT / 100);
  }
  for (let j = entryIdx + 1; j < candles.length; j++) {
    const bar = candles[j];
    if (direction === "LONG") {
      if (bar.low <= slLine) return { exitIdx: j, exitPrice: slLine, pnl: Math.round((slLine - entryPrice) * shares), exitReason: "SL", shares };
      if (bar.high >= tpLine) return { exitIdx: j, exitPrice: tpLine, pnl: Math.round((tpLine - entryPrice) * shares), exitReason: "TP", shares };
    } else {
      if (bar.high >= slLine) return { exitIdx: j, exitPrice: slLine, pnl: Math.round((entryPrice - slLine) * shares), exitReason: "SL", shares };
      if (bar.low <= tpLine) return { exitIdx: j, exitPrice: tpLine, pnl: Math.round((entryPrice - tpLine) * shares), exitReason: "TP", shares };
    }
  }
  const lastBar = candles[candles.length - 1];
  const pnl = direction === "LONG"
    ? Math.round((lastBar.close - entryPrice) * shares)
    : Math.round((entryPrice - lastBar.close) * shares);
  return { exitIdx: candles.length - 1, exitPrice: lastBar.close, pnl, exitReason: "EOD", shares };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume
     FROM rt_candles WHERE tradeDate >= '2026-07-14' ORDER BY symbol, tradeDate, candleTime`
  ) as any[];

  // 日別・銘柄別に整理
  const byDaySymbol: Record<string, Record<string, Candle[]>> = {};
  for (const r of rows) {
    if (!ACTIVE_SYMBOLS.has(r.symbol)) continue;
    const day = r.tradeDate;
    if (!byDaySymbol[day]) byDaySymbol[day] = {};
    if (!byDaySymbol[day][r.symbol]) byDaySymbol[day][r.symbol] = [];
    byDaySymbol[day][r.symbol].push({
      candleTime: r.candleTime, open: parseFloat(r.open), high: parseFloat(r.high),
      low: parseFloat(r.low), close: parseFloat(r.close), volume: parseInt(r.volume) || 0,
    });
  }
  await conn.end();

  // 3パターン比較
  // A: 現行（スコア0ブロック = neutral時もブロック）
  // B: neutral時LONG許可 + isBullish条件 + buy_pressureブロック
  // C: B + buy_pressureブロックなし（参考）

  const results: Record<string, { trades: Trade[]; blocked: number }> = {
    A: { trades: [], blocked: 0 },
    B: { trades: [], blocked: 0 },
  };

  for (const [day, symbols] of Object.entries(byDaySymbol)) {
    for (const [symbol, candles] of Object.entries(symbols)) {
      if (candles.length < 30) continue;
      const slMap = SL_MAP[symbol];
      const usedA = new Set<string>();
      const usedB = new Set<string>();

      for (let i = 25; i < candles.length - 10; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        if (c.candleTime < "09:05" || c.candleTime > "14:30") continue;

        // ダウ理論LONG: 直近20本の高値更新
        let isHighBreak = false;
        if (i >= 20) {
          let prevHigh = 0;
          for (let k = i - 20; k < i; k++) prevHigh = Math.max(prevHigh, candles[k].high);
          if (c.high > prevHigh && prev.high <= prevHigh) isHighBreak = true;
        }

        if (isHighBreak) {
          const sigKey = `${symbol}-dow-${Math.floor(i/10)}`;
          const entryIdx = i + 1;
          if (entryIdx >= candles.length - 5) continue;

          const isBullish = calcIsBullish(candles, entryIdx);
          const board = simBoardSignal(candles, entryIdx);

          // パターンA: 現行（スコア0相当 = 全ブロック）
          if (!usedA.has(sigKey)) {
            usedA.add(sigKey);
            results.A.blocked++;
          }

          // パターンB: isBullish + neutral許可 + buy_pressureブロック
          if (!usedB.has(sigKey)) {
            usedB.add(sigKey);
            if (!isBullish) {
              results.B.blocked++;
            } else if (board === "buy_pressure") {
              results.B.blocked++;
            } else {
              // neutral or sell_pressure + isBullish → LONG許可
              const result = simulateTrade(candles, entryIdx, "LONG", slMap.long);
              results.B.trades.push({
                symbol, direction: "LONG", signalType: "ダウ理論",
                signalTime: c.candleTime, entryTime: candles[entryIdx].candleTime,
                entryPrice: candles[entryIdx].close, exitTime: candles[result.exitIdx].candleTime,
                exitPrice: result.exitPrice, pnl: result.pnl, exitReason: result.exitReason,
                shares: result.shares, isBullish, boardSim: board
              });
            }
          }
        }

        // 逆三尊LONG（簡易: 直近安値が2回切り上がり + 高値更新）
        if (i >= 30) {
          const ma5 = calcMA(candles, 5, i);
          const ma25 = calcMA(candles, 25, i);
          const ma5prev = calcMA(candles, 5, i - 1);
          const ma25prev = calcMA(candles, 25, i - 1);
          // GC検出
          if (ma5prev <= ma25prev && ma5 > ma25) {
            const sigKey = `${symbol}-gc-${i}`;
            const entryIdx = i + 1;
            if (entryIdx >= candles.length - 5) continue;
            const isBullish = calcIsBullish(candles, entryIdx);
            const board = simBoardSignal(candles, entryIdx);

            if (!usedA.has(sigKey)) {
              usedA.add(sigKey);
              results.A.blocked++;
            }
            if (!usedB.has(sigKey)) {
              usedB.add(sigKey);
              if (!isBullish) {
                results.B.blocked++;
              } else if (board === "buy_pressure") {
                results.B.blocked++;
              } else {
                const result = simulateTrade(candles, entryIdx, "LONG", slMap.long);
                results.B.trades.push({
                  symbol, direction: "LONG", signalType: "GC",
                  signalTime: c.candleTime, entryTime: candles[entryIdx].candleTime,
                  entryPrice: candles[entryIdx].close, exitTime: candles[result.exitIdx].candleTime,
                  exitPrice: result.exitPrice, pnl: result.pnl, exitReason: result.exitReason,
                  shares: result.shares, isBullish, boardSim: board
                });
              }
            }
          }
        }
      }
    }
  }

  // 結果表示
  console.log("=== LONGエントリー条件比較シミュレーション ===");
  console.log(`期間: 7/14〜8/17\n`);

  console.log("--- パターンA: 現行（スコア0でLONG全ブロック）---");
  console.log(`  ブロック数: ${results.A.blocked}件`);
  console.log(`  エントリー: 0件（全てブロック）\n`);

  const bTrades = results.B.trades;
  const bWins = bTrades.filter(t => t.pnl > 0).length;
  const bLosses = bTrades.filter(t => t.pnl < 0).length;
  const bTotal = bTrades.reduce((s, t) => s + t.pnl, 0);
  console.log("--- パターンB: isBullish + neutral許可 + buy_pressureブロック ---");
  console.log(`  ブロック数: ${results.B.blocked}件`);
  console.log(`  エントリー: ${bTrades.length}件 | ${bWins}勝${bLosses}敗 | 総損益: ${bTotal >= 0 ? "+" : ""}${bTotal.toLocaleString()}円`);
  console.log(`  勝率: ${(bWins / bTrades.length * 100).toFixed(1)}%`);
  console.log(`  平均利益: ${bWins > 0 ? "+" + Math.round(bTrades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/bWins).toLocaleString() : 0}円`);
  console.log(`  平均損失: ${bLosses > 0 ? Math.round(bTrades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0)/bLosses).toLocaleString() : 0}円\n`);

  // シグナル別
  const bySignal: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of bTrades) {
    if (!bySignal[t.signalType]) bySignal[t.signalType] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) bySignal[t.signalType].wins++;
    else bySignal[t.signalType].losses++;
    bySignal[t.signalType].pnl += t.pnl;
  }
  console.log("  シグナル別:");
  for (const [sig, s] of Object.entries(bySignal)) {
    console.log(`    ${sig}: ${s.wins}勝${s.losses}敗 ${s.pnl >= 0 ? "+" : ""}${s.pnl.toLocaleString()}円`);
  }

  // 銘柄別
  console.log("\n  銘柄別:");
  const bySymbol: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of bTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
    else bySymbol[t.symbol].losses++;
    bySymbol[t.symbol].pnl += t.pnl;
  }
  for (const [sym, s] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`    ${sym}: ${s.wins}勝${s.losses}敗 ${s.pnl >= 0 ? "+" : ""}${s.pnl.toLocaleString()}円`);
  }

  // 日別
  console.log("\n  日別損益:");
  const byDay: Record<string, number> = {};
  for (const t of bTrades) {
    const day = t.entryTime.substring(0, 10) || "unknown";
    // entryTimeはcandleTimeなので日付がない。tradeDate使う
    // 代わりにsymbolとentryTimeでグループ化
  }
  // 日別は取得できないのでスキップ

  // 個別取引（上位10件）
  console.log("\n  上位利確取引:");
  const sorted = [...bTrades].sort((a, b) => b.pnl - a.pnl);
  for (const t of sorted.slice(0, 5)) {
    console.log(`    ${t.symbol} [${t.signalType}] ${t.entryTime} @${t.entryPrice.toFixed(0)}円 → ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 (board:${t.boardSim})`);
  }
  console.log("\n  下位損切り取引:");
  for (const t of sorted.slice(-5)) {
    console.log(`    ${t.symbol} [${t.signalType}] ${t.entryTime} @${t.entryPrice.toFixed(0)}円 → ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 (board:${t.boardSim})`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
