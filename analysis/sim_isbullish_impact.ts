import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_SLOPE_THRESHOLD = -0.03;
const IS_BULLISH_FALLBACK_THRESHOLD = 0.2;

const ACTIVE_SYMBOLS = new Set(["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"]);

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  // 8月の営業日
  const [dates] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= '2026-08-01' ORDER BY tradeDate`
  ) as any[];
  const tradeDates = dates.map((d: any) => d.tradeDate);

  console.log(`=== isBullish判定（MA20傾き方式）のSHORTブロック影響調査 ===`);
  console.log(`閾値: slope > ${IS_BULLISH_SLOPE_THRESHOLD}% → isBullish=true → SHORT禁止`);
  console.log(`期間: ${tradeDates[0]} 〜 ${tradeDates[tradeDates.length - 1]}\n`);

  let totalCandles = 0;
  let bullishCandles = 0;
  const dailyStats: { date: string; total: number; bullish: number; pct: number }[] = [];
  const symbolStats: Record<string, { total: number; bullish: number }> = {};

  // 時間帯別
  const hourlyStats: Record<string, { total: number; bullish: number }> = {};

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

    let dayTotal = 0;
    let dayBullish = 0;

    for (const [symbol, candles] of Object.entries(bySymbol)) {
      if (!symbolStats[symbol]) symbolStats[symbol] = { total: 0, bullish: 0 };

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        // 9:00〜15:00のみ（エントリー可能時間帯）
        if (c.candleTime < "09:00" || c.candleTime > "15:00") continue;

        const buffer = candles.slice(0, i + 1);
        let isBullish = false;

        if (buffer.length < 2) {
          isBullish = false;
        } else if (buffer.length < IS_BULLISH_MA_PERIOD + 1) {
          const openPrice = buffer[0].open;
          const priceChangeRatio = (c.close - openPrice) / openPrice * 100;
          isBullish = priceChangeRatio >= IS_BULLISH_FALLBACK_THRESHOLD;
        } else {
          const currentSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).map(x => x.close);
          const currentMA = currentSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
          const prevSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD - 1, buffer.length - 1).map(x => x.close);
          const prevMA = prevSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
          const slope = (currentMA - prevMA) / prevMA * 100;
          isBullish = slope > IS_BULLISH_SLOPE_THRESHOLD;
        }

        dayTotal++;
        totalCandles++;
        symbolStats[symbol].total++;

        const hour = c.candleTime.substring(0, 2) + ":00";
        if (!hourlyStats[hour]) hourlyStats[hour] = { total: 0, bullish: 0 };
        hourlyStats[hour].total++;

        if (isBullish) {
          dayBullish++;
          bullishCandles++;
          symbolStats[symbol].bullish++;
          hourlyStats[hour].bullish++;
        }
      }
    }

    const pct = dayTotal > 0 ? (dayBullish / dayTotal * 100) : 0;
    dailyStats.push({ date: tradeDate, total: dayTotal, bullish: dayBullish, pct });
  }

  // 日別
  console.log(`=== 日別: isBullish=true（SHORT禁止）の割合 ===`);
  for (const d of dailyStats) {
    console.log(`  ${d.date}: ${d.bullish}/${d.total} = ${d.pct.toFixed(1)}% の時間帯でSHORT禁止`);
  }

  console.log(`\n  全体: ${bullishCandles}/${totalCandles} = ${(bullishCandles / totalCandles * 100).toFixed(1)}%\n`);

  // 銘柄別
  console.log(`=== 銘柄別: isBullish=true の割合 ===`);
  for (const [sym, s] of Object.entries(symbolStats).sort((a, b) => b[1].bullish / b[1].total - a[1].bullish / a[1].total)) {
    const pct = s.total > 0 ? (s.bullish / s.total * 100) : 0;
    console.log(`  ${sym}: ${pct.toFixed(1)}%`);
  }

  // 時間帯別
  console.log(`\n=== 時間帯別: isBullish=true の割合 ===`);
  for (const [hour, s] of Object.entries(hourlyStats).sort()) {
    const pct = s.total > 0 ? (s.bullish / s.total * 100) : 0;
    console.log(`  ${hour}: ${pct.toFixed(1)}%`);
  }

  // 旧方式（始値比+0.2%）との比較
  console.log(`\n=== 旧方式（始値比+0.2%）との比較 ===`);
  let oldBullish = 0;
  for (const tradeDate of tradeDates) {
    const [rows] = await conn.query(
      `SELECT symbol, candleTime, open, close
       FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime`,
      [tradeDate]
    ) as any[];

    const bySymbol2: Record<string, { open: number; candles: { candleTime: string; close: number }[] }> = {};
    for (const r of rows) {
      if (!ACTIVE_SYMBOLS.has(r.symbol)) continue;
      if (!bySymbol2[r.symbol]) bySymbol2[r.symbol] = { open: parseFloat(r.open), candles: [] };
      bySymbol2[r.symbol].candles.push({ candleTime: r.candleTime, close: parseFloat(r.close) });
    }

    for (const [, data] of Object.entries(bySymbol2)) {
      for (const c of data.candles) {
        if (c.candleTime < "09:00" || c.candleTime > "15:00") continue;
        const ratio = (c.close - data.open) / data.open * 100;
        if (ratio >= 0.2) oldBullish++;
      }
    }
  }

  console.log(`  旧方式（始値比+0.2%）: ${oldBullish}/${totalCandles} = ${(oldBullish / totalCandles * 100).toFixed(1)}%`);
  console.log(`  新方式（MA20傾き>${IS_BULLISH_SLOPE_THRESHOLD}%）: ${bullishCandles}/${totalCandles} = ${(bullishCandles / totalCandles * 100).toFixed(1)}%`);
  console.log(`  差分: 新方式は旧方式より ${((bullishCandles - oldBullish) / totalCandles * 100).toFixed(1)}pt 多くSHORTをブロック`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
