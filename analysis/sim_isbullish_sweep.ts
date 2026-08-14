import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;

// 銘柄別SL（SHORT方向）
const SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.8, "6526": 1.0,
  "5803": 0.6, "6981": 0.9, "285A": 0.6, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

const ACTIVE_SYMBOLS = new Set(Object.keys(SL_MAP));
const IS_BULLISH_MA_PERIOD = 20;

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// isBullish判定（MA20傾き方式）
function calcIsBullishMA(buffer: Candle[], threshold: number): boolean {
  if (buffer.length < IS_BULLISH_MA_PERIOD + 1) {
    // フォールバック: 始値比
    const openPrice = buffer[0].open;
    const ratio = (buffer[buffer.length - 1].close - openPrice) / openPrice * 100;
    return ratio >= 0.2;
  }
  const currentSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).map(c => c.close);
  const currentMA = currentSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
  const prevSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD - 1, buffer.length - 1).map(c => c.close);
  const prevMA = prevSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
  const slope = (currentMA - prevMA) / prevMA * 100;
  return slope > threshold;
}

// isBullish判定（旧方式: 始値比）
function calcIsBullishOld(buffer: Candle[], threshold: number): boolean {
  const openPrice = buffer[0].open;
  const ratio = (buffer[buffer.length - 1].close - openPrice) / openPrice * 100;
  return ratio >= threshold;
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
  for (let l = base - step * 3; l <= base + step * 3; l += step) {
    if (l > 0) levels.push(l);
  }
  return levels;
}

interface SimResult {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  blocked: number;
  blockPct: number;
}

async function simulate(conn: mysql.Connection, tradeDates: string[], mode: string, threshold: number): Promise<SimResult> {
  let trades = 0, wins = 0, losses = 0, pnl = 0, blocked = 0, totalSignals = 0;

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
      const usedLevels = new Set<number>();

      for (let i = 20; i < candles.length - 10; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        if (c.candleTime < "09:05" || c.candleTime > "14:30") continue;

        // 大台割れ検出
        const roundLevels = getRoundLevels(prev.close);
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
        if (usedLevels.has(roundLevel)) continue;

        totalSignals++;

        // isBullish判定
        const buffer = candles.slice(0, i + 1);
        let isBullish: boolean;
        if (mode === "ma_slope") {
          isBullish = calcIsBullishMA(buffer, threshold);
        } else if (mode === "old_ratio") {
          isBullish = calcIsBullishOld(buffer, threshold);
        } else {
          isBullish = false; // 無効化
        }

        if (isBullish) {
          blocked++;
          continue;
        }

        usedLevels.add(roundLevel);

        // SHORTエントリー（簡易: 即エントリー）
        const entryPrice = c.close;
        const shares = Math.floor(3_000_000 / entryPrice / 100) * 100 || 100;
        const slLine = entryPrice * (1 + slPct / 100);
        const tpLine = entryPrice * (1 - TP_PCT / 100);

        let tradePnl = 0;
        const afterEntry = candles.slice(i + 1);
        for (const bar of afterEntry) {
          if (bar.high >= slLine) {
            tradePnl = Math.round((entryPrice - slLine) * shares);
            break;
          }
          if (bar.low <= tpLine) {
            tradePnl = Math.round((entryPrice - tpLine) * shares);
            break;
          }
        }
        if (tradePnl === 0 && afterEntry.length > 0) {
          const last = afterEntry[afterEntry.length - 1];
          tradePnl = Math.round((entryPrice - last.close) * shares);
        }

        trades++;
        pnl += tradePnl;
        if (tradePnl > 0) wins++;
        else if (tradePnl < 0) losses++;
      }
    }
  }

  const blockPct = totalSignals > 0 ? (blocked / totalSignals * 100) : 0;
  return { label: `${mode}(${threshold})`, trades, wins, losses, pnl, blocked, blockPct };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  const [dates] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= '2026-07-01' ORDER BY tradeDate`
  ) as any[];
  const tradeDates = dates.map((d: any) => d.tradeDate);

  console.log(`=== isBullish判定方式別 大台割れSHORT成績比較 ===`);
  console.log(`期間: ${tradeDates[0]} 〜 ${tradeDates[tradeDates.length - 1]} (${tradeDates.length}営業日)\n`);

  const configs = [
    { mode: "disabled", threshold: 0, label: "isBullish無効（全SHORT許可）" },
    { mode: "old_ratio", threshold: 0.2, label: "旧方式（始値比+0.2%）" },
    { mode: "old_ratio", threshold: 0.5, label: "旧方式（始値比+0.5%）" },
    { mode: "ma_slope", threshold: -0.03, label: "現行（MA20傾き > -0.03%）" },
    { mode: "ma_slope", threshold: 0.0, label: "MA20傾き > 0%（横ばい以上で禁止）" },
    { mode: "ma_slope", threshold: 0.01, label: "MA20傾き > 0.01%" },
    { mode: "ma_slope", threshold: 0.02, label: "MA20傾き > 0.02%" },
    { mode: "ma_slope", threshold: 0.05, label: "MA20傾き > 0.05%" },
  ];

  const results: SimResult[] = [];
  for (const cfg of configs) {
    process.stderr.write(`  計算中: ${cfg.label}...\n`);
    const r = await simulate(conn, tradeDates, cfg.mode, cfg.threshold);
    r.label = cfg.label;
    results.push(r);
  }

  console.log(`| 方式 | 取引数 | 勝敗 | 勝率 | 総損益 | PF | ブロック数 | ブロック率 |`);
  console.log(`|------|--------|------|------|--------|-----|----------|----------|`);
  for (const r of results) {
    const winRate = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : "0";
    const grossWin = r.pnl > 0 ? r.pnl : 0;
    const grossLoss = r.pnl < 0 ? Math.abs(r.pnl) : 0;
    console.log(`| ${r.label} | ${r.trades} | ${r.wins}勝${r.losses}敗 | ${winRate}% | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | - | ${r.blocked} | ${r.blockPct.toFixed(1)}% |`);
  }

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
