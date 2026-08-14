import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;

// 銘柄別SL（LONG方向）
const SL_MAP: Record<string, number> = {
  "8035": 0.5, "6857": 0.6, "6976": 0.6, "6526": 0.9,
  "5803": 0.5, "6981": 0.4, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

const ACTIVE_SYMBOLS = new Set(["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"]);

// 現行パラメータ: CB=4, MW=5（大台超えLONG用）
const CONFIRM_BARS = 4;
const MAX_WAIT = 5;

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
  tradeDate: string;
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
  const conn = await mysql.createConnection(DATABASE_URL);

  // 8月の営業日を取得
  const [dates] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= '2026-08-01' ORDER BY tradeDate`
  ) as any[];
  const tradeDates = dates.map((d: any) => d.tradeDate);

  console.log(`=== 8月の大台超えLONG仮想シミュレーション ===`);
  console.log(`期間: ${tradeDates[0]} 〜 ${tradeDates[tradeDates.length - 1]} (${tradeDates.length}営業日)`);
  console.log(`パラメータ: CB=${CONFIRM_BARS}, MW=${MAX_WAIT}\n`);

  const allTrades: Trade[] = [];
  let totalPnl = 0;

  for (const tradeDate of tradeDates) {
    const [rows] = await conn.query(
      `SELECT symbol, candleTime, open, high, low, close, volume
       FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime`,
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

        // 大台超え検出（前足close≦キリ番 → 今足close＞キリ番）
        const roundLevels = getRoundLevels(c.close);
        let roundBreak = false;
        let roundLevel = 0;
        for (const level of roundLevels) {
          if (c.close > level && prev.close <= level) {
            roundBreak = true;
            roundLevel = level;
            break;
          }
        }
        if (!roundBreak) continue;

        const sigKey = `${symbol}-${roundLevel}`;
        if (usedSignals.has(sigKey)) continue;

        // 確認バー（CB本連続でキリ番以上を維持）
        if (i + CONFIRM_BARS >= candles.length) continue;
        let confirmed = true;
        for (let j = 1; j <= CONFIRM_BARS; j++) {
          if (candles[i + j].close < roundLevel) {
            confirmed = false;
            break;
          }
        }
        if (!confirmed) continue;

        const confirmIdx = i + CONFIRM_BARS;
        const signalPrice = candles[confirmIdx].close;
        const signalTime = candles[confirmIdx].candleTime;

        // 押し目待ち
        let entryIdx = -1;
        let entryType = "";
        let pulledBack = false;

        for (let w = 1; w <= MAX_WAIT; w++) {
          const wIdx = confirmIdx + w;
          if (wIdx >= candles.length) break;
          const wc = candles[wIdx];
          // キリ番割れでキャンセル
          if (wc.close < roundLevel) {
            break;
          }
          if (!pulledBack && wc.close < signalPrice) {
            pulledBack = true;
          }
          if (pulledBack && wc.close > signalPrice) {
            entryIdx = wIdx;
            entryType = "押し目確認後";
            break;
          }
        }
        if (entryIdx < 0) {
          const timeoutIdx = confirmIdx + MAX_WAIT + 1;
          if (timeoutIdx < candles.length && candles[timeoutIdx].close >= roundLevel) {
            entryIdx = timeoutIdx;
            entryType = "強トレンド";
          }
        }

        if (entryIdx < 0) continue;

        usedSignals.add(sigKey);
        const entryPrice = candles[entryIdx].close;
        const entryTime = candles[entryIdx].candleTime;
        const shares = Math.floor(3_000_000 / entryPrice / 100) * 100 || 100;
        const slLine = entryPrice * (1 - slPct / 100);
        const tpLine = entryPrice * (1 + TP_PCT / 100);

        let pnl = 0;
        let exitReason = "EOD";
        let exitPrice = entryPrice;
        let exitTime = "";
        const afterEntry = candles.slice(entryIdx + 1);
        for (const bar of afterEntry) {
          if (bar.low <= slLine) {
            exitPrice = slLine;
            pnl = Math.round((slLine - entryPrice) * shares);
            exitReason = "SL";
            exitTime = bar.candleTime;
            break;
          }
          if (bar.high >= tpLine) {
            exitPrice = tpLine;
            pnl = Math.round((tpLine - entryPrice) * shares);
            exitReason = "TP";
            exitTime = bar.candleTime;
            break;
          }
        }
        if (exitReason === "EOD" && afterEntry.length > 0) {
          const lastBar = afterEntry[afterEntry.length - 1];
          exitPrice = lastBar.close;
          pnl = Math.round((lastBar.close - entryPrice) * shares);
          exitTime = lastBar.candleTime;
        }

        totalPnl += pnl;
        allTrades.push({ symbol, tradeDate, signalTime, entryTime, entryPrice, exitTime, exitPrice, pnl, exitReason, entryType, shares, roundLevel });
      }
    }
  }

  await conn.end();

  // 結果表示
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl < 0).length;
  const be = allTrades.filter(t => t.pnl === 0).length;

  console.log(`=== 総合成績 ===`);
  console.log(`取引数: ${allTrades.length}件 | ${wins}勝${losses}敗${be}分 | 勝率: ${(wins / allTrades.length * 100).toFixed(1)}%`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`平均損益: ${Math.round(totalPnl / allTrades.length).toLocaleString()}円/件\n`);

  // 日別
  console.log(`=== 日別損益 ===`);
  const byDate: Record<string, { trades: number; pnl: number; wins: number; losses: number }> = {};
  for (const t of allTrades) {
    if (!byDate[t.tradeDate]) byDate[t.tradeDate] = { trades: 0, pnl: 0, wins: 0, losses: 0 };
    byDate[t.tradeDate].trades++;
    byDate[t.tradeDate].pnl += t.pnl;
    if (t.pnl > 0) byDate[t.tradeDate].wins++;
    if (t.pnl < 0) byDate[t.tradeDate].losses++;
  }
  for (const [date, d] of Object.entries(byDate).sort()) {
    console.log(`  ${date}: ${d.trades}件 ${d.wins}勝${d.losses}敗 ${d.pnl >= 0 ? "+" : ""}${d.pnl.toLocaleString()}円`);
  }

  // 全取引詳細
  console.log(`\n=== 全取引詳細 ===`);
  for (const t of allTrades) {
    console.log(`  ${t.tradeDate} ${t.symbol} シグナル:${t.signalTime} → エントリー:${t.entryTime} @${t.entryPrice.toFixed(0)}円 ×${t.shares}株 [${t.entryType}]`);
    console.log(`    → 決済:${t.exitTime} @${t.exitPrice.toFixed(0)}円 ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 (キリ番:${t.roundLevel}円)`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
