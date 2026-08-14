import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const CONFIRM_BARS = 4;
const TP_PCT = 1.5;

// 銘柄別SL（SHORT方向）
const SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.8, "6526": 1.0,
  "5803": 0.6, "6981": 0.9, "285A": 0.6, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

const EXCLUDED = new Set(["6920", "6758"]);
const ACTIVE_SYMBOLS = new Set(["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"]);

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function simulate(maxWait: number) {
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
      const usedSignals = new Set<string>(); // 同一キリ番の重複防止

      for (let i = 20; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];

        // 大台割れ検出: キリ番を下抜け
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

        // 確認バー: CONFIRM_BARS本がキリ番以下を維持
        if (i + CONFIRM_BARS >= candles.length) continue;
        let confirmed = true;
        for (let j = 1; j <= CONFIRM_BARS; j++) {
          if (candles[i + j].close > roundLevel) {
            confirmed = false;
            break;
          }
        }
        if (!confirmed) continue;

        const confirmIdx = i + CONFIRM_BARS;
        const signalPrice = candles[confirmIdx].close;
        const signalTime = candles[confirmIdx].candleTime;

        // 押し目待ち（maxWait本）
        let entryIdx = -1;
        let entryType = "";
        let pulledBack = false;

        // MAX_WAIT=0: 確認完了直後に即エントリー
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

          // 売り方向の押し目: 一度上がった（close > signalPrice）→ 再下落（close < signalPrice）
          if (!pulledBack && wc.close > signalPrice) {
            pulledBack = true;
          }
          if (pulledBack && wc.close < signalPrice) {
            entryIdx = wIdx;
            entryType = "押し目確認後";
            break;
          }
          // キリ番上抜けでキャンセル
          if (wc.close > roundLevel) {
            break;
          }
        }

        // タイムアウト: 押し目なし → 強トレンドエントリー
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

        // SL/TP/EOD判定
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
  return { maxWait, trades, totalPnl, wins, losses, tradeDates };
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
  console.log("=== 大台割れSHORT: 押し目待ちMAX_WAIT比較シミュレーション ===\n");

  const results = [];
  for (const mw of [0, 1, 2, 3, 5]) {
    const r = await simulate(mw);
    results.push(r);
  }

  console.log(`期間: ${results[0].tradeDates[0]} 〜 ${results[0].tradeDates[results[0].tradeDates.length - 1]}（${results[0].tradeDates.length}営業日）\n`);

  console.log("=== 総合比較 ===");
  console.log("MAX_WAIT | 取引数 | 勝敗 | 勝率 | 総損益 | PF");
  console.log("---------|--------|------|------|--------|----");
  for (const r of results) {
    const grossWin = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(r.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    const wr = r.trades.length > 0 ? (r.wins / r.trades.length * 100).toFixed(1) : "0";
    console.log(`${String(r.maxWait).padStart(8)} | ${String(r.trades.length).padStart(6)} | ${r.wins}W${r.losses}L | ${wr}% | ${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toLocaleString()}円 | ${pf}`);
  }

  // エントリータイプ別の比較
  console.log("\n=== エントリータイプ別 ===");
  for (const r of results) {
    const timeout = r.trades.filter(t => t.type === "強トレンド");
    const pullback = r.trades.filter(t => t.type === "押し目確認後");
    const toPnl = timeout.reduce((s, t) => s + t.pnl, 0);
    const pbPnl = pullback.reduce((s, t) => s + t.pnl, 0);
    const toWin = timeout.filter(t => t.pnl > 0).length;
    const pbWin = pullback.filter(t => t.pnl > 0).length;
    console.log(`MAX_WAIT=${r.maxWait}: 強トレンド ${timeout.length}件(${toWin}勝) ${toPnl >= 0 ? "+" : ""}${toPnl.toLocaleString()}円 | 押し目確認後 ${pullback.length}件(${pbWin}勝) ${pbPnl >= 0 ? "+" : ""}${pbPnl.toLocaleString()}円`);
  }

  // MAX_WAIT=2の詳細（5分短縮に最も近い）
  console.log("\n=== MAX_WAIT=0 取引詳細（上位20件） ===");
  const mw0 = results.find(r => r.maxWait === 0)!;
  for (const t of mw0.trades.slice(0, 20)) {
    console.log(`  ${t.date} ${t.symbol} sig:${t.signalTime} entry:${t.entryTime} @${t.entry.toFixed(0)} [${t.type}] → ${t.reason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }

  // MAX_WAIT=5（現行）との差分
  console.log("\n=== MAX_WAIT=5（現行）との差分 ===");
  const mw5 = results.find(r => r.maxWait === 5)!;
  for (const r of results) {
    if (r.maxWait === 5) continue;
    console.log(`MAX_WAIT=${r.maxWait} vs 5: ${(r.totalPnl - mw5.totalPnl >= 0 ? "+" : "")}${(r.totalPnl - mw5.totalPnl).toLocaleString()}円の差`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
