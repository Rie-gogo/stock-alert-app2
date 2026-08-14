import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;

// 銘柄別SL（SHORT方向）
const SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.8, "6526": 1.0,
  "5803": 0.6, "6981": 0.9, "285A": 0.6, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

const ACTIVE_SYMBOLS = new Set(["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"]);

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  entryType: string;
  shares: number;
  roundLevel: number;
}

async function simulate(confirmBars: number, maxWait: number, tradeDate: string) {
  const conn = await mysql.createConnection(DATABASE_URL);

  const [rows] = await conn.query(
    `SELECT symbol, candleTime, open, high, low, close, volume
     FROM rt_candles
     WHERE tradeDate = ?
     ORDER BY symbol, candleTime`,
    [tradeDate]
  ) as any[];

  const bySymbol: Record<string, Candle[]> = {};
  for (const r of rows) {
    if (!ACTIVE_SYMBOLS.has(r.symbol)) continue;
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push({
      candleTime: r.candleTime,
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseInt(r.volume) || 0,
    });
  }

  const trades: Trade[] = [];
  let totalPnl = 0;

  for (const [symbol, candles] of Object.entries(bySymbol)) {
    const slPct = SL_MAP[symbol] ?? 0.5;
    const usedSignals = new Set<string>();

    for (let i = 20; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];

      // 大台割れ検出
      const roundLevels = getRoundLevels(c.close);
      let roundBreak = false;
      let roundLevel = 0;
      for (const level of roundLevels) {
        if (c.close < level && prev.close >= level) {
          roundBreak = true;
          roundLevel = level;
          break;
        }
      }
      if (!roundBreak) continue;

      const sigKey = `${symbol}-${roundLevel}`;
      if (usedSignals.has(sigKey)) continue;

      // 確認バー
      if (i + confirmBars >= candles.length) continue;
      let confirmed = true;
      for (let j = 1; j <= confirmBars; j++) {
        if (candles[i + j].close > roundLevel) {
          confirmed = false;
          break;
        }
      }
      if (!confirmed) continue;

      const confirmIdx = i + confirmBars;
      const signalPrice = candles[confirmIdx].close;
      const signalTime = candles[confirmIdx].candleTime;

      // 押し目待ち
      let entryIdx = -1;
      let entryType = "";
      let pulledBack = false;

      if (maxWait === 0) {
        const nextIdx = confirmIdx + 1;
        if (nextIdx < candles.length && candles[nextIdx].close <= roundLevel) {
          entryIdx = nextIdx;
          entryType = "即エントリー";
        }
      } else {
        for (let w = 1; w <= maxWait; w++) {
          const wIdx = confirmIdx + w;
          if (wIdx >= candles.length) break;
          const wc = candles[wIdx];
          if (!pulledBack && wc.close > signalPrice) {
            pulledBack = true;
          }
          if (pulledBack && wc.close < signalPrice) {
            entryIdx = wIdx;
            entryType = "押し目確認後";
            break;
          }
          if (wc.close > roundLevel) {
            break;
          }
        }
        if (entryIdx < 0) {
          const timeoutIdx = confirmIdx + maxWait + 1;
          if (timeoutIdx < candles.length && candles[timeoutIdx].close <= roundLevel) {
            entryIdx = timeoutIdx;
            entryType = "強トレンド";
          }
        }
      }

      if (entryIdx < 0) continue;

      usedSignals.add(sigKey);
      const entryPrice = candles[entryIdx].close;
      const entryTime = candles[entryIdx].candleTime;
      const shares = Math.floor(3_000_000 / entryPrice / 100) * 100 || 100;
      const slLine = entryPrice * (1 + slPct / 100);
      const tpLine = entryPrice * (1 - TP_PCT / 100);

      let pnl = 0;
      let exitReason = "EOD";
      let exitPrice = entryPrice;
      let exitTime = "";
      const afterEntry = candles.slice(entryIdx + 1);
      for (const bar of afterEntry) {
        if (bar.high >= slLine) {
          exitPrice = slLine;
          pnl = Math.round((entryPrice - slLine) * shares);
          exitReason = "SL";
          exitTime = bar.candleTime;
          break;
        }
        if (bar.low <= tpLine) {
          exitPrice = tpLine;
          pnl = Math.round((entryPrice - tpLine) * shares);
          exitReason = "TP";
          exitTime = bar.candleTime;
          break;
        }
      }
      if (exitReason === "EOD" && afterEntry.length > 0) {
        const lastBar = afterEntry[afterEntry.length - 1];
        exitPrice = lastBar.close;
        pnl = Math.round((entryPrice - lastBar.close) * shares);
        exitTime = lastBar.candleTime;
      }

      totalPnl += pnl;
      trades.push({ symbol, signalTime, entryTime, entryPrice, exitTime, exitPrice, pnl, exitReason, entryType, shares, roundLevel });
    }
  }

  await conn.end();
  return { confirmBars, maxWait, trades, totalPnl };
}

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  let step: number;
  if (price < 1000) step = 100;
  else if (price < 3000) step = 200;
  else if (price < 5000) step = 500;
  else if (price < 10000) step = 500;
  else if (price < 30000) step = 1000;
  else if (price < 50000) step = 1000;
  else step = 5000;

  const base = Math.floor(price / step) * step;
  for (let l = base - step * 3; l <= base + step * 3; l += step) {
    if (l > 0) levels.push(l);
  }
  return levels;
}

async function main() {
  const tradeDate = "2026-08-14";
  console.log(`=== 本日(${tradeDate})の大台割れSHORT: A案(CB=2,MW=1) vs 現行(CB=4,MW=5) ===\n`);

  const [resultA, resultCurrent] = await Promise.all([
    simulate(2, 1, tradeDate),
    simulate(4, 5, tradeDate),
  ]);

  // 現行の詳細
  console.log("=== 現行（CB=4, MW=5）===");
  console.log(`取引数: ${resultCurrent.trades.length}件 | 総損益: ${resultCurrent.totalPnl >= 0 ? "+" : ""}${resultCurrent.totalPnl.toLocaleString()}円\n`);
  for (const t of resultCurrent.trades) {
    console.log(`  ${t.symbol} シグナル:${t.signalTime} → エントリー:${t.entryTime} @${t.entryPrice.toFixed(0)}円 ×${t.shares}株 [${t.entryType}]`);
    console.log(`    → 決済:${t.exitTime} @${t.exitPrice.toFixed(0)}円 ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 (キリ番:${t.roundLevel}円)`);
  }

  // A案の詳細
  console.log(`\n=== A案（CB=2, MW=1）===`);
  console.log(`取引数: ${resultA.trades.length}件 | 総損益: ${resultA.totalPnl >= 0 ? "+" : ""}${resultA.totalPnl.toLocaleString()}円\n`);
  for (const t of resultA.trades) {
    console.log(`  ${t.symbol} シグナル:${t.signalTime} → エントリー:${t.entryTime} @${t.entryPrice.toFixed(0)}円 ×${t.shares}株 [${t.entryType}]`);
    console.log(`    → 決済:${t.exitTime} @${t.exitPrice.toFixed(0)}円 ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 (キリ番:${t.roundLevel}円)`);
  }

  // 比較
  const diff = resultA.totalPnl - resultCurrent.totalPnl;
  console.log(`\n=== 比較 ===`);
  console.log(`現行: ${resultCurrent.trades.length}件 ${resultCurrent.totalPnl >= 0 ? "+" : ""}${resultCurrent.totalPnl.toLocaleString()}円`);
  console.log(`A案:  ${resultA.trades.length}件 ${resultA.totalPnl >= 0 ? "+" : ""}${resultA.totalPnl.toLocaleString()}円`);
  console.log(`差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円 (A案が${diff >= 0 ? "有利" : "不利"})`);

  // 本番実績との比較
  console.log(`\n=== 本番実績との比較 ===`);
  console.log(`本番: 2件 +9,976円 (8035: +27,000円, 6976: -17,024円)`);
  console.log(`  8035: 大台割れ(59800円) 押し目確認後 @59,460円 → 板読み早期利確 @59,190円 +27,000円`);
  console.log(`  6976: 大台割れ(11000円) 強トレンド @10,640円 → SL @10,725円 -17,024円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
