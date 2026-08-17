import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;

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
const IS_BULLISH_SLOPE_THRESHOLD = 0; // 新閾値

// 大台割れSHORT: CB=2, MW=1
const ROUND_SHORT_CONFIRM_BARS = 2;
const ROUND_SHORT_MAX_WAIT = 1;
// 大台超えLONG: CB=4, MW=5（停止中だが参考）
const ROUND_LONG_CONFIRM_BARS = 4;
const ROUND_LONG_MAX_WAIT = 5;

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
  blocked?: string;
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

function calcIsBullish(buffer: Candle[]): boolean {
  if (buffer.length < IS_BULLISH_MA_PERIOD + 1) {
    const openPrice = buffer[0].open;
    const ratio = (buffer[buffer.length - 1].close - openPrice) / openPrice * 100;
    return ratio >= 0.2;
  }
  const currentSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).map(c => c.close);
  const currentMA = currentSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
  const prevSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD - 1, buffer.length - 1).map(c => c.close);
  const prevMA = prevSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
  const slope = (currentMA - prevMA) / prevMA * 100;
  return slope > IS_BULLISH_SLOPE_THRESHOLD;
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const tradeDate = "2026-08-14";

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

  console.log(`=== 本日(${tradeDate})の現行ロジックシミュレーション ===`);
  console.log(`設定: isBullish閾値=0%, 大台割れSHORT CB=2/MW=1, 方向別SL\n`);

  const trades: Trade[] = [];
  const blocked: Trade[] = [];

  for (const [symbol, candles] of Object.entries(bySymbol)) {
    const slMap = SL_MAP[symbol];
    const usedLevels = new Set<string>();
    let hasPosition = false;

    for (let i = 20; i < candles.length - 5; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      if (c.candleTime < "09:05" || c.candleTime > "14:30") continue;
      if (hasPosition) continue;

      // 大台割れ検出（SHORT）
      const roundLevels = getRoundLevels(prev.close);
      for (const level of roundLevels) {
        if (c.close < level && prev.close >= level) {
          const sigKey = `${symbol}-short-${level}`;
          if (usedLevels.has(sigKey)) continue;

          // 確認バー（CB=2）
          if (i + ROUND_SHORT_CONFIRM_BARS >= candles.length) continue;
          let confirmed = true;
          for (let j = 1; j <= ROUND_SHORT_CONFIRM_BARS; j++) {
            if (candles[i + j].close > level) { confirmed = false; break; }
          }
          if (!confirmed) continue;

          const confirmIdx = i + ROUND_SHORT_CONFIRM_BARS;
          // 押し目待ち（MW=1）→ ほぼタイムアウト
          const entryIdx = confirmIdx + ROUND_SHORT_MAX_WAIT + 1;
          if (entryIdx >= candles.length) continue;
          if (candles[entryIdx].close > level) continue; // キリ番上抜けでキャンセル

          const entryCandle = candles[entryIdx];

          // isBullish判定
          const buffer = candles.slice(0, entryIdx + 1);
          const isBullish = calcIsBullish(buffer);
          if (isBullish) {
            blocked.push({
              symbol, direction: "SHORT", signalType: "大台割れ",
              signalTime: c.candleTime, entryTime: entryCandle.candleTime,
              entryPrice: entryCandle.close, exitTime: "", exitPrice: 0,
              pnl: 0, exitReason: "", shares: 0, blocked: "isBullish"
            });
            usedLevels.add(sigKey);
            continue;
          }

          usedLevels.add(sigKey);
          const entryPrice = entryCandle.close;
          const shares = Math.floor(3_000_000 / entryPrice / 100) * 100 || 100;
          const slPct = slMap.short;
          const slLine = entryPrice * (1 + slPct / 100);
          const tpLine = entryPrice * (1 - TP_PCT / 100);

          let pnl = 0, exitReason = "EOD", exitPrice = entryPrice, exitTime = "";
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
            const last = afterEntry[afterEntry.length - 1];
            exitPrice = last.close;
            pnl = Math.round((entryPrice - last.close) * shares);
            exitTime = last.candleTime;
          }

          trades.push({
            symbol, direction: "SHORT", signalType: "大台割れ",
            signalTime: c.candleTime, entryTime: entryCandle.candleTime,
            entryPrice, exitTime, exitPrice, pnl, exitReason, shares
          });
          hasPosition = true;
          break;
        }
      }

      // 大台超え検出（LONGは停止、buy_pressure逆張りSHORTは板情報がないため省略）
      for (const level of roundLevels) {
        if (c.close > level && prev.close <= level) {
          const sigKey = `${symbol}-long-${level}`;
          if (usedLevels.has(sigKey)) continue;
          usedLevels.add(sigKey);
          blocked.push({
            symbol, direction: "LONG", signalType: "大台超え(停止中)",
            signalTime: c.candleTime, entryTime: c.candleTime,
            entryPrice: c.close, exitTime: "", exitPrice: 0,
            pnl: 0, exitReason: "", shares: 0, blocked: "大台LONG停止"
          });
        }
      }
    }
  }

  await conn.end();

  // 結果表示
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  console.log(`=== エントリーした取引 ===`);
  console.log(`取引数: ${trades.length}件 | ${wins}勝${losses}敗 | 総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円\n`);

  for (const t of trades) {
    console.log(`  ${t.symbol} ${t.direction} [${t.signalType}]`);
    console.log(`    シグナル:${t.signalTime} → エントリー:${t.entryTime} @${t.entryPrice.toFixed(0)}円 ×${t.shares}株`);
    console.log(`    → 決済:${t.exitTime} @${t.exitPrice.toFixed(0)}円 ${t.exitReason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }

  console.log(`\n=== isBullishでブロックされたSHORT ===`);
  const isBullishBlocked = blocked.filter(b => b.blocked === "isBullish");
  console.log(`ブロック数: ${isBullishBlocked.length}件`);
  for (const b of isBullishBlocked) {
    console.log(`  ${b.symbol} ${b.direction} シグナル:${b.signalTime} エントリー予定:${b.entryTime} @${b.entryPrice.toFixed(0)}円`);
  }

  console.log(`\n=== 大台超えLONG停止によるブロック ===`);
  const longBlocked = blocked.filter(b => b.blocked === "大台LONG停止");
  console.log(`ブロック数: ${longBlocked.length}件`);
  for (const b of longBlocked) {
    console.log(`  ${b.symbol} シグナル:${b.signalTime} @${b.entryPrice.toFixed(0)}円`);
  }

  // 本番実績との比較
  console.log(`\n=== 本番実績との比較 ===`);
  console.log(`本番: 2件 1勝1敗 +9,976円`);
  console.log(`シミュレーション: ${trades.length}件 ${wins}勝${losses}敗 ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
