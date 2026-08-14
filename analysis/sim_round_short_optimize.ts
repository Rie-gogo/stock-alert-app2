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

async function simulate(confirmBars: number, maxWait: number) {
  const conn = await mysql.createConnection(DATABASE_URL);

  const [dates] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= DATE_SUB(CURDATE(), INTERVAL 45 DAY) ORDER BY tradeDate`
  ) as any[];
  const tradeDates = dates.map((d: any) => d.tradeDate).slice(-30);

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const trades: Array<{ date: string; symbol: string; signalTime: string; entryTime: string; entry: number; pnl: number; reason: string; type: string }> = [];

  for (const tradeDate of tradeDates) {
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

    for (const [symbol, candles] of Object.entries(bySymbol)) {
      const slPct = SL_MAP[symbol] ?? 0.5;
      const usedSignals = new Set<string>();

      for (let i = 20; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];

        // 大台割れ検出
        const roundLevels = getRoundLevels(c.close, symbol);
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

        // 確認バー: confirmBars本がキリ番以下を維持
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
          // 即エントリー
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

          // タイムアウト
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
        const afterEntry = candles.slice(entryIdx + 1);
        for (const bar of afterEntry) {
          if (bar.high >= slLine) {
            pnl = Math.round((entryPrice - slLine) * shares);
            exitReason = "SL";
            break;
          }
          if (bar.low <= tpLine) {
            pnl = Math.round((entryPrice - tpLine) * shares);
            exitReason = "TP";
            break;
          }
        }
        if (exitReason === "EOD" && afterEntry.length > 0) {
          const lastBar = afterEntry[afterEntry.length - 1];
          pnl = Math.round((entryPrice - lastBar.close) * shares);
        }

        totalPnl += pnl;
        if (pnl > 0) wins++;
        else losses++;
        trades.push({ date: tradeDate, symbol, signalTime, entryTime, entry: entryPrice, pnl, reason: exitReason, type: entryType });
      }
    }
  }

  await conn.end();
  return { confirmBars, maxWait, trades, totalPnl, wins, losses, tradeDates };
}

function getRoundLevels(price: number, symbol: string): number[] {
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
  console.log("=== 大台割れSHORT: CONFIRM_BARS × MAX_WAIT 最適化シミュレーション ===\n");

  // A(CONFIRM_BARS): 1,2,3,4,5  ×  B(MAX_WAIT): 0,1,2,3,5
  const confirmBarsList = [1, 2, 3, 4, 5];
  const maxWaitList = [0, 1, 2, 3, 5];

  const results: Array<Awaited<ReturnType<typeof simulate>>> = [];

  for (const cb of confirmBarsList) {
    for (const mw of maxWaitList) {
      const r = await simulate(cb, mw);
      results.push(r);
      process.stdout.write(`.`);
    }
  }
  console.log("\n");

  const period = results[0].tradeDates;
  console.log(`期間: ${period[0]} 〜 ${period[period.length - 1]}（${period.length}営業日）`);
  console.log(`現行: CONFIRM_BARS=4, MAX_WAIT=5\n`);

  // マトリクス表示: 損益
  console.log("=== 総損益マトリクス（円） ===");
  console.log(`${"CONFIRM\\MAX_WAIT".padEnd(18)}| ${maxWaitList.map(m => `MW=${m}`.padStart(12)).join(" | ")}`);
  console.log("-".repeat(18 + (14 * maxWaitList.length)));
  for (const cb of confirmBarsList) {
    const row = maxWaitList.map(mw => {
      const r = results.find(x => x.confirmBars === cb && x.maxWait === mw)!;
      const val = r.totalPnl >= 0 ? `+${r.totalPnl.toLocaleString()}` : r.totalPnl.toLocaleString();
      return val.padStart(12);
    });
    console.log(`CB=${cb}`.padEnd(18) + `| ${row.join(" | ")}`);
  }

  // マトリクス表示: PF
  console.log("\n=== PFマトリクス ===");
  console.log(`${"CONFIRM\\MAX_WAIT".padEnd(18)}| ${maxWaitList.map(m => `MW=${m}`.padStart(8)).join(" | ")}`);
  console.log("-".repeat(18 + (10 * maxWaitList.length)));
  for (const cb of confirmBarsList) {
    const row = maxWaitList.map(mw => {
      const r = results.find(x => x.confirmBars === cb && x.maxWait === mw)!;
      const grossWin = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const grossLoss = Math.abs(r.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
      const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
      return pf.padStart(8);
    });
    console.log(`CB=${cb}`.padEnd(18) + `| ${row.join(" | ")}`);
  }

  // マトリクス表示: 勝率
  console.log("\n=== 勝率マトリクス（%） ===");
  console.log(`${"CONFIRM\\MAX_WAIT".padEnd(18)}| ${maxWaitList.map(m => `MW=${m}`.padStart(8)).join(" | ")}`);
  console.log("-".repeat(18 + (10 * maxWaitList.length)));
  for (const cb of confirmBarsList) {
    const row = maxWaitList.map(mw => {
      const r = results.find(x => x.confirmBars === cb && x.maxWait === mw)!;
      const wr = r.trades.length > 0 ? (r.wins / r.trades.length * 100).toFixed(1) : "0.0";
      return wr.padStart(8);
    });
    console.log(`CB=${cb}`.padEnd(18) + `| ${row.join(" | ")}`);
  }

  // マトリクス表示: 取引数
  console.log("\n=== 取引数マトリクス ===");
  console.log(`${"CONFIRM\\MAX_WAIT".padEnd(18)}| ${maxWaitList.map(m => `MW=${m}`.padStart(8)).join(" | ")}`);
  console.log("-".repeat(18 + (10 * maxWaitList.length)));
  for (const cb of confirmBarsList) {
    const row = maxWaitList.map(mw => {
      const r = results.find(x => x.confirmBars === cb && x.maxWait === mw)!;
      return String(r.trades.length).padStart(8);
    });
    console.log(`CB=${cb}`.padEnd(18) + `| ${row.join(" | ")}`);
  }

  // シグナル発生からエントリーまでの所要時間
  console.log("\n=== シグナル発生からエントリーまでの所要時間（分） ===");
  console.log(`${"CONFIRM\\MAX_WAIT".padEnd(18)}| ${maxWaitList.map(m => `MW=${m}`.padStart(8)).join(" | ")}`);
  console.log("-".repeat(18 + (10 * maxWaitList.length)));
  for (const cb of confirmBarsList) {
    const row = maxWaitList.map(mw => {
      // 最短: CB + 1（即エントリー）、最長: CB + MW + 1（タイムアウト）
      const min = cb + 1;
      const max = cb + mw + 1;
      return `${min}-${max}`.padStart(8);
    });
    console.log(`CB=${cb}`.padEnd(18) + `| ${row.join(" | ")}`);
  }

  // TOP10ランキング
  console.log("\n=== TOP10（損益順） ===");
  const sorted = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
  console.log("順位 | CB | MW | 取引数 | 勝率 | PF | 総損益 | 所要時間(分)");
  console.log("-----|----|----|--------|------|-----|--------|------------");
  for (let i = 0; i < 10 && i < sorted.length; i++) {
    const r = sorted[i];
    const grossWin = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(r.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    const wr = r.trades.length > 0 ? (r.wins / r.trades.length * 100).toFixed(1) : "0.0";
    const timeMin = r.confirmBars + 1;
    const timeMax = r.confirmBars + r.maxWait + 1;
    const marker = (r.confirmBars === 4 && r.maxWait === 5) ? " ★現行" : "";
    console.log(`${String(i + 1).padStart(4)} | ${String(r.confirmBars).padStart(2)} | ${String(r.maxWait).padStart(2)} | ${String(r.trades.length).padStart(6)} | ${wr}% | ${pf.padStart(5)} | ${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toLocaleString()}円 | ${timeMin}-${timeMax}分${marker}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
