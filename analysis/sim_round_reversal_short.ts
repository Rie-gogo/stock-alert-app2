import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const CONFIRM_BARS = 4;
const TP_PCT = 1.5;

// 銘柄別SL（方向別）
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

// 取引除外銘柄
const EXCLUDED = new Set(["6920", "6758"]);

interface Candle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  // 30日間のデータ取得
  const [dates] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= DATE_SUB(CURDATE(), INTERVAL 45 DAY) ORDER BY tradeDate`
  ) as any[];
  const tradeDates = dates.map((d: any) => d.tradeDate).slice(-30);

  console.log("=== 大台超えLONG停止 + buy_pressure逆張りSHORT復活 シミュレーション ===");
  console.log(`期間: ${tradeDates[0]} 〜 ${tradeDates[tradeDates.length - 1]}（${tradeDates.length}営業日）`);
  console.log(`条件: 大台超えシグナル発生 → ${CONFIRM_BARS}本確認 → buy_pressureならSHORTエントリー、それ以外はブロック`);
  console.log("");

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const trades: Array<{ date: string; symbol: string; time: string; entry: number; exit: number; pnl: number; reason: string }> = [];

  for (const tradeDate of tradeDates) {
    // 全銘柄の1分足を取得
    const [rows] = await conn.query(
      `SELECT symbol, candleTime, open, high, low, close, volume, boardSnapshot
       FROM rt_candles
       WHERE tradeDate = ? AND symbol NOT IN ('6920', '6758')
       ORDER BY symbol, candleTime`,
      [tradeDate]
    ) as any[];

    // 銘柄ごとにグループ化
    const bySymbol: Record<string, Candle[]> = {};
    for (const r of rows) {
      if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
      let board = null;
      if (r.boardSnapshot) {
        try { board = JSON.parse(r.boardSnapshot); } catch {}
      }
      bySymbol[r.symbol].push({
        candleTime: r.candleTime,
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: parseInt(r.volume) || 0,
        boardSnapshot: board,
      });
    }

    // 各銘柄で大台超えシグナルを検出
    for (const [symbol, candles] of Object.entries(bySymbol)) {
      if (EXCLUDED.has(symbol)) continue;
      const slPct = SL_MAP[symbol]?.short ?? 0.5;

      for (let i = 20; i < candles.length; i++) {
        const c = candles[i];
        // 大台超え検出: キリ番（1000円単位 or 500円単位）を上抜け
        const roundLevels = getRoundLevels(c.close);
        let roundBreak = false;
        let roundLevel = 0;
        for (const level of roundLevels) {
          if (c.close > level && candles[i - 1].close <= level) {
            roundBreak = true;
            roundLevel = level;
            break;
          }
        }
        if (!roundBreak) continue;

        // CONFIRM_BARS確認: 次の4本が全てroundLevel以上
        if (i + CONFIRM_BARS >= candles.length) continue;
        let confirmed = true;
        for (let j = 1; j <= CONFIRM_BARS; j++) {
          if (candles[i + j].close < roundLevel) {
            confirmed = false;
            break;
          }
        }
        if (!confirmed) continue;

        // 確認完了時点の足
        const confirmBar = candles[i + CONFIRM_BARS];

        // buy_pressure判定
        const hasBuyPressure = confirmBar.boardSnapshot && confirmBar.boardSnapshot.signal === "buy_pressure";
        if (!hasBuyPressure) continue; // buy_pressureでなければスキップ（LONGもブロック）

        // 逆張りSHORTエントリー
        const entryPrice = confirmBar.close;
        const entryTime = confirmBar.candleTime;
        const shares = Math.floor(3_000_000 / entryPrice / 100) * 100 || 100;
        const slLine = entryPrice * (1 + slPct / 100);
        const tpLine = entryPrice * (1 - TP_PCT / 100);

        // SL/TP/EOD判定
        let pnl = 0;
        let exitReason = "EOD";
        const afterEntry = candles.slice(i + CONFIRM_BARS + 1);
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
        trades.push({ date: tradeDate, symbol, time: entryTime, entry: entryPrice, exit: 0, pnl, reason: exitReason });
      }
    }
  }

  console.log("=== 取引一覧 ===");
  for (const t of trades) {
    console.log(`  ${t.date} ${t.time} ${t.symbol} SHORT @${t.entry.toFixed(0)} → ${t.reason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }
  console.log("");
  console.log("=== 総合結果 ===");
  console.log(`取引数: ${trades.length}件 | ${wins}勝${losses}敗 | 勝率: ${trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  if (trades.length > 0) {
    const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    console.log(`PF: ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞"}`);
  }

  await conn.end();
  process.exit(0);
}

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  // 株価に応じたキリ番間隔
  let step = 1000;
  if (price < 5000) step = 500;
  else if (price < 10000) step = 1000;
  else if (price < 50000) step = 5000;
  else step = 10000;

  const base = Math.floor(price / step) * step;
  for (let l = base - step * 2; l <= base + step * 2; l += step) {
    if (l > 0) levels.push(l);
  }
  return levels;
}

main().catch(e => { console.error(e); process.exit(1); });
