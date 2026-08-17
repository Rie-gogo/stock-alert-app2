import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const TARGET_DATE = process.argv[2] || "2026-08-03";

// 銘柄別方向別SL
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
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const ROUND_SHORT_CB = 2;
const ROUND_SHORT_MW = 1;

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
  direction: "LONG" | "SHORT";
  signalType: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  shares: number;
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
  if (idx < IS_BULLISH_MA_PERIOD + 1) {
    const openPrice = candles[0].open;
    const ratio = (candles[idx].close - openPrice) / openPrice * 100;
    return ratio >= 0.2;
  }
  const currentMA = calcMA(candles, IS_BULLISH_MA_PERIOD, idx);
  const prevMA = calcMA(candles, IS_BULLISH_MA_PERIOD, idx - 1);
  const slope = (currentMA - prevMA) / prevMA * 100;
  return slope > IS_BULLISH_SLOPE_THRESHOLD;
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
      if (bar.low <= slLine) {
        const pnl = Math.round((slLine - entryPrice) * shares);
        return { exitIdx: j, exitPrice: slLine, pnl, exitReason: "SL", shares };
      }
      if (bar.high >= tpLine) {
        const pnl = Math.round((tpLine - entryPrice) * shares);
        return { exitIdx: j, exitPrice: tpLine, pnl, exitReason: "TP", shares };
      }
    } else {
      if (bar.high >= slLine) {
        const pnl = Math.round((entryPrice - slLine) * shares);
        return { exitIdx: j, exitPrice: slLine, pnl, exitReason: "SL", shares };
      }
      if (bar.low <= tpLine) {
        const pnl = Math.round((entryPrice - tpLine) * shares);
        return { exitIdx: j, exitPrice: tpLine, pnl, exitReason: "TP", shares };
      }
    }
  }
  // EOD
  const lastBar = candles[candles.length - 1];
  const pnl = direction === "LONG"
    ? Math.round((lastBar.close - entryPrice) * shares)
    : Math.round((entryPrice - lastBar.close) * shares);
  return { exitIdx: candles.length - 1, exitPrice: lastBar.close, pnl, exitReason: "EOD", shares };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  const [rows] = await conn.query(
    `SELECT symbol, candleTime, open, high, low, close, volume
     FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime`,
    [TARGET_DATE]
  ) as any[];

  const bySymbol: Record<string, Candle[]> = {};
  for (const r of rows) {
    if (!ACTIVE_SYMBOLS.has(r.symbol)) continue;
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push({
      candleTime: r.candleTime,
      open: parseFloat(r.open), high: parseFloat(r.high),
      low: parseFloat(r.low), close: parseFloat(r.close),
      volume: parseInt(r.volume) || 0,
    });
  }

  console.log(`=== ${TARGET_DATE} 現行ロジック全体シミュレーション ===`);
  console.log(`設定: isBullish閾値=0%, 大台割れSHORT CB=${ROUND_SHORT_CB}/MW=${ROUND_SHORT_MW}, 方向別SL`);
  console.log(`注意: 板読みスコア・信頼度判定・同一銘柄制限は省略\n`);

  const allTrades: Trade[] = [];
  const allBlocked: { symbol: string; direction: string; signalType: string; signalTime: string; reason: string }[] = [];

  for (const [symbol, candles] of Object.entries(bySymbol)) {
    const slMap = SL_MAP[symbol];
    const usedSignals = new Set<string>();

    for (let i = 25; i < candles.length - 10; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      if (c.candleTime < "09:05" || c.candleTime > "14:30") continue;

      // === 大台割れSHORT ===
      const roundLevels = getRoundLevels(prev.close);
      for (const level of roundLevels) {
        if (c.close < level && prev.close >= level) {
          const sigKey = `${symbol}-roundShort-${level}`;
          if (usedSignals.has(sigKey)) continue;
          usedSignals.add(sigKey);

          // 確認バー
          if (i + ROUND_SHORT_CB >= candles.length) continue;
          let confirmed = true;
          for (let j = 1; j <= ROUND_SHORT_CB; j++) {
            if (candles[i + j].close > level) { confirmed = false; break; }
          }
          if (!confirmed) continue;

          const entryIdx = i + ROUND_SHORT_CB + ROUND_SHORT_MW + 1;
          if (entryIdx >= candles.length - 5) continue;
          if (candles[entryIdx].close > level) continue;

          // isBullish判定
          if (calcIsBullish(candles, entryIdx)) {
            allBlocked.push({ symbol, direction: "SHORT", signalType: "大台割れ", signalTime: c.candleTime, reason: "isBullish" });
            continue;
          }

          const result = simulateTrade(candles, entryIdx, "SHORT", slMap.short);
          allTrades.push({
            symbol, direction: "SHORT", signalType: "大台割れ",
            signalTime: c.candleTime, entryTime: candles[entryIdx].candleTime,
            entryPrice: candles[entryIdx].close, exitTime: candles[result.exitIdx].candleTime,
            exitPrice: result.exitPrice, pnl: result.pnl, exitReason: result.exitReason, shares: result.shares
          });
        }
      }

      // === 大台超えLONG → 停止（ブロック記録のみ） ===
      for (const level of roundLevels) {
        if (c.close > level && prev.close <= level) {
          const sigKey = `${symbol}-roundLong-${level}`;
          if (usedSignals.has(sigKey)) continue;
          usedSignals.add(sigKey);
          allBlocked.push({ symbol, direction: "LONG", signalType: "大台超え(停止)", signalTime: c.candleTime, reason: "大台LONG停止" });
        }
      }

      // === ゴールデンクロス（MA5 > MA25） ===
      if (i >= 25) {
        const ma5 = calcMA(candles, 5, i);
        const ma5prev = calcMA(candles, 5, i - 1);
        const ma25 = calcMA(candles, 25, i);
        const ma25prev = calcMA(candles, 25, i - 1);
        if (ma5prev <= ma25prev && ma5 > ma25) {
          const sigKey = `${symbol}-gc-${i}`;
          if (!usedSignals.has(sigKey)) {
            usedSignals.add(sigKey);
            const entryIdx = i + 1;
            if (entryIdx < candles.length - 5) {
              const result = simulateTrade(candles, entryIdx, "LONG", slMap.long);
              allTrades.push({
                symbol, direction: "LONG", signalType: "GC",
                signalTime: c.candleTime, entryTime: candles[entryIdx].candleTime,
                entryPrice: candles[entryIdx].close, exitTime: candles[result.exitIdx].candleTime,
                exitPrice: result.exitPrice, pnl: result.pnl, exitReason: result.exitReason, shares: result.shares
              });
            }
          }
        }
        // === デッドクロス（MA5 < MA25） ===
        if (ma5prev >= ma25prev && ma5 < ma25) {
          const sigKey = `${symbol}-dc-${i}`;
          if (!usedSignals.has(sigKey)) {
            usedSignals.add(sigKey);
            const entryIdx = i + 1;
            if (entryIdx < candles.length - 5) {
              if (calcIsBullish(candles, entryIdx)) {
                allBlocked.push({ symbol, direction: "SHORT", signalType: "DC", signalTime: c.candleTime, reason: "isBullish" });
              } else {
                const result = simulateTrade(candles, entryIdx, "SHORT", slMap.short);
                allTrades.push({
                  symbol, direction: "SHORT", signalType: "DC",
                  signalTime: c.candleTime, entryTime: candles[entryIdx].candleTime,
                  entryPrice: candles[entryIdx].close, exitTime: candles[result.exitIdx].candleTime,
                  exitPrice: result.exitPrice, pnl: result.pnl, exitReason: result.exitReason, shares: result.shares
                });
              }
            }
          }
        }
      }
    }
  }

  await conn.end();

  // ソート
  allTrades.sort((a, b) => a.entryTime.localeCompare(b.entryTime));

  // 結果表示
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl < 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);

  console.log(`=== エントリーした取引 ===`);
  console.log(`取引数: ${allTrades.length}件 | ${wins}勝${losses}敗 | 総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円\n`);

  // 方向別
  const longs = allTrades.filter(t => t.direction === "LONG");
  const shorts = allTrades.filter(t => t.direction === "SHORT");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  console.log(`  LONG: ${longs.length}件 ${longs.filter(t=>t.pnl>0).length}勝${longs.filter(t=>t.pnl<0).length}敗 ${longPnl>=0?"+":""}${longPnl.toLocaleString()}円`);
  console.log(`  SHORT: ${shorts.length}件 ${shorts.filter(t=>t.pnl>0).length}勝${shorts.filter(t=>t.pnl<0).length}敗 ${shortPnl>=0?"+":""}${shortPnl.toLocaleString()}円\n`);

  for (const t of allTrades) {
    const mark = t.pnl > 0 ? "✓" : "✗";
    console.log(`  ${mark} ${t.symbol} ${t.direction} [${t.signalType}] ${t.entryTime} @${t.entryPrice.toFixed(0)}円 ×${t.shares}株 → ${t.exitTime} ${t.exitReason} ${t.pnl>=0?"+":""}${t.pnl.toLocaleString()}円`);
  }

  console.log(`\n=== ブロックされたシグナル ===`);
  for (const b of allBlocked) {
    console.log(`  ${b.symbol} ${b.direction} [${b.signalType}] ${b.signalTime} → ${b.reason}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
