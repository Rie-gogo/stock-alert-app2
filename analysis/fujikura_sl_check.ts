/**
 * フジクラ(5803)のSL幅別損益を詳細に比較
 * 0.5% vs 0.7% vs 0.9% vs 1.0%
 */
import mysql from "mysql2/promise";

const TP_PCT = 1.5;
const MARKET_CLOSE = "15:25";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // フジクラの全トレードを取得
  const [allTrades] = await conn.execute(
    `SELECT id, tradeDate, symbol, side, action, price, shares, pnl, reason, tradeTime
     FROM rt_trades WHERE symbol = '5803' ORDER BY tradeDate, id`
  ) as any[];

  // ペアリング
  const trades: any[] = [];
  const openPositions: Map<string, any> = new Map();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}`;
    if (t.action === 'buy' || t.action === 'short') {
      openPositions.set(key, t);
    } else if (t.action === 'sell' || t.action === 'cover') {
      const entry = openPositions.get(key);
      if (entry) {
        trades.push({
          tradeDate: t.tradeDate,
          symbol: t.symbol,
          side: entry.side,
          entryPrice: Number(entry.price),
          exitPrice: Number(t.price),
          entryTime: entry.tradeTime,
          exitTime: t.tradeTime,
          pnl: Number(t.pnl),
          reason: entry.reason,
          exitReason: t.reason,
          shares: Number(entry.shares),
        });
        openPositions.delete(key);
      }
    }
  }

  console.log(`=== フジクラ(5803) SL幅別損益比較 ===`);
  console.log(`全トレード: ${trades.length}件\n`);

  const slOptions = [0.5, 0.7, 0.9, 1.0];

  // 各SL幅でシミュレート
  const results: Record<number, { total: number; wins: number; losses: number; details: string[] }> = {};
  for (const sl of slOptions) {
    results[sl] = { total: 0, wins: 0, losses: 0, details: [] };
  }

  for (const t of trades) {
    const { symbol, side, entryPrice, entryTime, shares, tradeDate } = t;

    // エントリー後のバーを取得
    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close, volume
       FROM rt_candles
       WHERE symbol = ? AND tradeDate = ? AND candleTime > ?
       ORDER BY candleTime LIMIT 300`, [symbol, tradeDate, entryTime]
    ) as any[];

    for (const sl of slOptions) {
      const result = simulateExit(candles, entryPrice, side, sl, shares);
      results[sl].total += result.pnl;
      if (result.pnl > 0) results[sl].wins++;
      else results[sl].losses++;
      results[sl].details.push(
        `${tradeDate} ${entryTime} ${side} @${entryPrice} ${shares}株 → ${result.pnl > 0 ? "+" : ""}${result.pnl}円 (${result.reason})`
      );
    }
  }

  // 比較表
  console.log("| SL幅 | 総損益 | 勝率 | 勝ち | 負け | 平均損益/件 |");
  console.log("|------|--------|------|------|------|-----------|");
  for (const sl of slOptions) {
    const r = results[sl];
    const total = r.wins + r.losses;
    const winRate = total > 0 ? (r.wins / total * 100).toFixed(1) : "0";
    const avg = total > 0 ? Math.round(r.total / total) : 0;
    console.log(`| ${sl}% | ${r.total > 0 ? "+" : ""}${r.total}円 | ${winRate}% | ${r.wins} | ${r.losses} | ${avg > 0 ? "+" : ""}${avg}円 |`);
  }

  // 個別トレード詳細（0.5% vs 0.7%の差が大きいもの）
  console.log("\n=== 個別トレード詳細（SL 0.5% vs 0.7%） ===\n");
  console.log("| 日付 | 時間 | 方向 | エントリー | 株数 | SL0.5%結果 | SL0.7%結果 | 差分 |");
  console.log("|------|------|------|-----------|------|-----------|-----------|------|");

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const { symbol, side, entryPrice, entryTime, shares, tradeDate } = t;

    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close, volume
       FROM rt_candles
       WHERE symbol = ? AND tradeDate = ? AND candleTime > ?
       ORDER BY candleTime LIMIT 300`, [symbol, tradeDate, entryTime]
    ) as any[];

    const r05 = simulateExit(candles, entryPrice, side, 0.5, shares);
    const r07 = simulateExit(candles, entryPrice, side, 0.7, shares);
    const diff = r07.pnl - r05.pnl;

    console.log(`| ${tradeDate} | ${entryTime} | ${side} | ${entryPrice} | ${shares} | ${r05.pnl > 0 ? "+" : ""}${r05.pnl}円(${r05.reason.substring(0, 6)}) | ${r07.pnl > 0 ? "+" : ""}${r07.pnl}円(${r07.reason.substring(0, 6)}) | ${diff > 0 ? "+" : ""}${diff}円 |`);
  }

  await conn.end();
  process.exit(0);
}

function simulateExit(
  candles: any[],
  entryPrice: number,
  side: string,
  slPct: number,
  shares: number
): { pnl: number; reason: string; exitTime: string } {
  const slLine = side === "long"
    ? entryPrice * (1 - slPct / 100)
    : entryPrice * (1 + slPct / 100);
  const tpLine = side === "long"
    ? entryPrice * (1 + TP_PCT / 100)
    : entryPrice * (1 - TP_PCT / 100);

  for (const c of candles) {
    const high = Number(c.high);
    const low = Number(c.low);
    const time = c.candleTime as string;

    if (time >= MARKET_CLOSE) {
      const closePrice = Number(c.close);
      const pnl = side === "long"
        ? Math.round((closePrice - entryPrice) * shares)
        : Math.round((entryPrice - closePrice) * shares);
      return { pnl, reason: "EOD決済", exitTime: time };
    }

    if (side === "long") {
      if (low <= slLine) {
        const pnl = Math.round((slLine - entryPrice) * shares);
        return { pnl, reason: `損切り(SL${slPct}%)`, exitTime: time };
      }
      if (high >= tpLine) {
        const pnl = Math.round((tpLine - entryPrice) * shares);
        return { pnl, reason: `利確(TP)`, exitTime: time };
      }
    } else {
      if (high >= slLine) {
        const pnl = Math.round((entryPrice - slLine) * shares);
        return { pnl, reason: `損切り(SL${slPct}%)`, exitTime: time };
      }
      if (low <= tpLine) {
        const pnl = Math.round((entryPrice - tpLine) * shares);
        return { pnl, reason: `利確(TP)`, exitTime: time };
      }
    }
  }

  if (candles.length > 0) {
    const lastClose = Number(candles[candles.length - 1].close);
    const pnl = side === "long"
      ? Math.round((lastClose - entryPrice) * shares)
      : Math.round((entryPrice - lastClose) * shares);
    return { pnl, reason: "EOD(末尾)", exitTime: candles[candles.length - 1].candleTime };
  }

  return { pnl: 0, reason: "データなし", exitTime: "" };
}

main().catch(e => { console.error(e); process.exit(1); });
