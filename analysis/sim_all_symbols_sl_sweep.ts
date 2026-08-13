/**
 * 全10銘柄のLONG/SHORT別SL幅スイープ
 * rt_tradesの実エントリーを固定し、rt_candlesで各SL幅の結果を比較する。
 */
import mysql from "mysql2/promise";

const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];
const NAMES: Record<string, string> = {
  "8035": "東京エレクトロン", "6857": "アドバンテスト", "6976": "太陽誘電",
  "6526": "ソシオネクスト", "5803": "フジクラ", "6981": "村田製作所",
  "285A": "キオクシア", "6146": "ディスコ", "6594": "ニデック",
  "8316": "三井住友FG",
};
const TP_PCT = 1.5;
const SL_VALUES = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const CURRENT_SL: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

interface Entry { tradeDate: string; tradeTime: string; side: string; price: string; shares: string; }
interface Candle { candleTime: string; high: string; low: string; close: string; }

function simulate(entry: Entry, candles: Candle[], sl: number) {
  const ep = Number(entry.price);
  const shares = Number(entry.shares);
  const isLong = entry.side === "long";
  const slPrice = isLong ? ep * (1 - sl / 100) : ep * (1 + sl / 100);
  const tpPrice = isLong ? ep * (1 + TP_PCT / 100) : ep * (1 - TP_PCT / 100);
  const startIdx = candles.findIndex(c => c.candleTime > entry.tradeTime);
  const after = startIdx >= 0 ? candles.slice(startIdx) : [];
  for (const c of after) {
    const h = Number(c.high), l = Number(c.low);
    if ((isLong && l <= slPrice) || (!isLong && h >= slPrice)) {
      return { result: "SL" as const, pnl: -ep * sl / 100 * shares };
    }
    if ((isLong && h >= tpPrice) || (!isLong && l <= tpPrice)) {
      return { result: "TP" as const, pnl: ep * TP_PCT / 100 * shares };
    }
  }
  const eodClose = candles.length ? Number(candles[candles.length - 1].close) : ep;
  return { result: "EOD" as const, pnl: (isLong ? eodClose - ep : ep - eodClose) * shares };
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  console.log("=== 10銘柄 LONG/SHORT別 最適SL幅候補一覧 ===\n");
  console.log("銘柄 | 名前 | 方向 | 件数 | 現行SL | 最適SL | 現行損益 | 最適損益 | 改善額 | 最適PF");
  console.log("-".repeat(110));

  const recommendations: Array<{
    symbol: string; side: string; count: number;
    currentSl: number; bestSl: number;
    currentPnl: number; bestPnl: number; bestPf: string;
  }> = [];

  for (const symbol of SYMBOLS) {
    const [trades] = await conn.query(
      "SELECT tradeDate, tradeTime, side, price, shares FROM rt_trades WHERE symbol=? AND action IN ('buy','short') ORDER BY tradeDate, tradeTime",
      [symbol]
    ) as any[];

    if (trades.length === 0) continue;

    const cache = new Map<string, Candle[]>();
    for (const entry of trades) {
      if (!cache.has(entry.tradeDate)) {
        const [candles] = await conn.query(
          "SELECT candleTime, high, low, close FROM rt_candles WHERE tradeDate=? AND symbol=? ORDER BY candleTime",
          [entry.tradeDate, symbol]
        ) as any[];
        cache.set(entry.tradeDate, candles);
      }
    }

    for (const side of ["long", "short"]) {
      const sideTrades = trades.filter((t: Entry) => t.side === side);
      if (sideTrades.length === 0) continue;

      let bestSl = CURRENT_SL[symbol];
      let bestPnl = -Infinity;
      let bestPf = "0.00";
      let currentPnl = 0;

      for (const sl of SL_VALUES) {
        let totalPnl = 0;
        let grossWin = 0, grossLoss = 0;
        for (const entry of sideTrades) {
          const candles = cache.get(entry.tradeDate) as Candle[];
          const r = simulate(entry, candles, sl);
          totalPnl += r.pnl;
          if (r.pnl > 0) grossWin += r.pnl;
          else grossLoss += Math.abs(r.pnl);
        }
        const pf = grossLoss ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? "Inf" : "0.00");
        if (totalPnl > bestPnl) {
          bestPnl = totalPnl;
          bestSl = sl;
          bestPf = pf;
        }
        if (sl === CURRENT_SL[symbol]) {
          currentPnl = totalPnl;
        }
      }

      const improvement = bestPnl - currentPnl;
      recommendations.push({
        symbol, side, count: sideTrades.length,
        currentSl: CURRENT_SL[symbol], bestSl,
        currentPnl, bestPnl, bestPf,
      });

      const marker = bestSl !== CURRENT_SL[symbol] ? " *" : "";
      console.log(
        `${symbol} | ${NAMES[symbol].padEnd(10)} | ${side.toUpperCase().padEnd(5)} | ${String(sideTrades.length).padStart(3)} | ${CURRENT_SL[symbol].toFixed(1)}% | ${bestSl.toFixed(1)}%${marker} | ${(currentPnl >= 0 ? "+" : "") + Math.round(currentPnl).toLocaleString().padStart(9)} | ${(bestPnl >= 0 ? "+" : "") + Math.round(bestPnl).toLocaleString().padStart(9)} | ${(improvement >= 0 ? "+" : "") + Math.round(improvement).toLocaleString().padStart(8)} | ${bestPf.padStart(5)}`
      );
    }
  }

  // サマリー
  console.log("\n=== 推奨変更候補（現行と異なるもの） ===");
  console.log("銘柄 | 名前 | 方向 | 件数 | 現行→推奨 | 改善額 | PF");
  console.log("-".repeat(75));
  const changes = recommendations.filter(r => r.bestSl !== r.currentSl);
  for (const r of changes) {
    const imp = r.bestPnl - r.currentPnl;
    console.log(
      `${r.symbol} | ${NAMES[r.symbol].padEnd(10)} | ${r.side.toUpperCase().padEnd(5)} | ${String(r.count).padStart(3)} | ${r.currentSl.toFixed(1)}%→${r.bestSl.toFixed(1)}% | ${(imp >= 0 ? "+" : "") + Math.round(imp).toLocaleString().padStart(8)} | ${r.bestPf}`
    );
  }
  if (changes.length === 0) console.log("（変更候補なし）");

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
