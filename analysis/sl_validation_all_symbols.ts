/**
 * 全銘柄のSL幅別損益を詳細に比較検証
 * 各銘柄について 0.5%, 0.7%, 0.9%, 1.0%, 1.2%, 1.5% を網羅的にテスト
 * 
 * 実際のrt_tradesのエントリーポイントを使い、rt_candlesのバーデータから
 * 各SL幅での決済結果をシミュレートする
 */
import mysql from "mysql2/promise";

const TP_PCT = 1.5;
const MARKET_CLOSE = "15:25";
const SL_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5];

// 現在の実装値
const CURRENT_SL: Record<string, number> = {
  "8035": 0.7,
  "6857": 0.9,
  "6976": 1.0,
  "6526": 0.9,
  "5803": 0.5,
  "6981": 0.9,
  "285A": 1.5,
  "6920": 1.0,
  "6758": 0.5,
  "8316": 0.5,
};

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // 全トレードを取得
  const [allTrades] = await conn.execute(
    `SELECT id, tradeDate, symbol, side, action, price, shares, pnl, reason, tradeTime
     FROM rt_trades ORDER BY tradeDate, id`
  ) as any[];

  // ペアリング
  const pairedTrades: any[] = [];
  const openPositions: Map<string, any> = new Map();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}`;
    if (t.action === 'buy' || t.action === 'short') {
      openPositions.set(key, t);
    } else if (t.action === 'sell' || t.action === 'cover') {
      const entry = openPositions.get(key);
      if (entry) {
        pairedTrades.push({
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

  // 銘柄ごとにグループ化
  const bySymbol: Map<string, any[]> = new Map();
  for (const t of pairedTrades) {
    const arr = bySymbol.get(t.symbol) || [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  // アクティブ10銘柄のみ
  const activeSymbols = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6920", "6758", "8316"];

  console.log("=== 銘柄別SL幅 妥当性検証 ===\n");
  console.log(`全トレード: ${pairedTrades.length}件`);
  console.log(`対象: アクティブ10銘柄\n`);

  // 全体サマリー用
  const summaryData: any[] = [];

  for (const symbol of activeSymbols) {
    const trades = bySymbol.get(symbol) || [];
    if (trades.length === 0) continue;

    console.log(`\n--- ${symbol} (${trades.length}件) 現在SL: ${CURRENT_SL[symbol]}% ---`);

    const slResults: Record<number, { total: number; wins: number; losses: number; maxLoss: number; avgWin: number; avgLoss: number; tp: number; sl: number; eod: number }> = {};
    for (const sl of SL_OPTIONS) {
      slResults[sl] = { total: 0, wins: 0, losses: 0, maxLoss: 0, avgWin: 0, avgLoss: 0, tp: 0, sl: 0, eod: 0 };
    }

    for (const t of trades) {
      const { symbol: sym, side, entryPrice, entryTime, shares, tradeDate } = t;

      const [candles] = await conn.execute(
        `SELECT candleTime, open, high, low, close
         FROM rt_candles
         WHERE symbol = ? AND tradeDate = ? AND candleTime > ?
         ORDER BY candleTime LIMIT 400`, [sym, tradeDate, entryTime]
      ) as any[];

      for (const sl of SL_OPTIONS) {
        const result = simulateExit(candles, entryPrice, side, sl, shares);
        slResults[sl].total += result.pnl;
        if (result.pnl > 0) {
          slResults[sl].wins++;
          slResults[sl].avgWin += result.pnl;
        } else {
          slResults[sl].losses++;
          slResults[sl].avgLoss += result.pnl;
          if (result.pnl < slResults[sl].maxLoss) slResults[sl].maxLoss = result.pnl;
        }
        if (result.reason.includes("利確")) slResults[sl].tp++;
        else if (result.reason.includes("損切")) slResults[sl].sl++;
        else slResults[sl].eod++;
      }
    }

    // 表示
    console.log("| SL% | 総損益 | 勝率 | PF | 平均利益 | 平均損失 | 最大損失 | TP | SL | EOD |");
    console.log("|-----|--------|------|-----|---------|---------|---------|----|----|-----|");

    let bestSl = 0.5;
    let bestPnl = -Infinity;

    for (const sl of SL_OPTIONS) {
      const r = slResults[sl];
      const total = r.wins + r.losses;
      const winRate = total > 0 ? (r.wins / total * 100).toFixed(1) : "0";
      const avgW = r.wins > 0 ? Math.round(r.avgWin / r.wins) : 0;
      const avgL = r.losses > 0 ? Math.round(r.avgLoss / r.losses) : 0;
      const pf = Math.abs(r.avgLoss) > 0 ? (r.avgWin / Math.abs(r.avgLoss)).toFixed(2) : "∞";
      const marker = sl === CURRENT_SL[symbol] ? " ★現在" : (r.total === bestPnl ? "" : "");

      if (r.total > bestPnl) {
        bestPnl = r.total;
        bestSl = sl;
      }

      console.log(`| ${sl}%${sl === CURRENT_SL[symbol] ? "★" : ""} | ${r.total > 0 ? "+" : ""}${r.total}円 | ${winRate}% | ${pf} | ${avgW > 0 ? "+" : ""}${avgW}円 | ${avgL}円 | ${r.maxLoss}円 | ${r.tp} | ${r.sl} | ${r.eod} |`);
    }

    const currentPnl = slResults[CURRENT_SL[symbol]].total;
    const bestPnlFinal = slResults[bestSl].total;
    const diff = bestPnlFinal - currentPnl;

    summaryData.push({
      symbol,
      trades: trades.length,
      currentSl: CURRENT_SL[symbol],
      currentPnl,
      bestSl,
      bestPnl: bestPnlFinal,
      diff,
    });

    console.log(`\n  最適SL: ${bestSl}% (${bestPnlFinal > 0 ? "+" : ""}${bestPnlFinal}円)`);
    console.log(`  現在SL: ${CURRENT_SL[symbol]}% (${currentPnl > 0 ? "+" : ""}${currentPnl}円)`);
    console.log(`  差分: ${diff > 0 ? "+" : ""}${diff}円 ${Math.abs(diff) < 10000 ? "(誤差レベル)" : diff > 0 ? "(現在が非最適)" : "(現在が最適付近)"}`);
  }

  // 全体サマリー
  console.log("\n\n=== 全体サマリー ===\n");
  console.log("| 銘柄 | 件数 | 現在SL | 現在損益 | 最適SL | 最適損益 | 差分 | 判定 |");
  console.log("|------|------|--------|---------|--------|---------|------|------|");

  let totalCurrentPnl = 0;
  let totalBestPnl = 0;

  for (const s of summaryData) {
    totalCurrentPnl += s.currentPnl;
    totalBestPnl += s.bestPnl;
    const judgment = Math.abs(s.diff) < 10000 ? "✅妥当" :
                     s.diff > 0 ? "⚠️要検討" : "✅最適";
    console.log(`| ${s.symbol} | ${s.trades}件 | ${s.currentSl}% | ${s.currentPnl > 0 ? "+" : ""}${s.currentPnl}円 | ${s.bestSl}% | ${s.bestPnl > 0 ? "+" : ""}${s.bestPnl}円 | ${s.diff > 0 ? "+" : ""}${s.diff}円 | ${judgment} |`);
  }

  console.log(`| **合計** | - | - | ${totalCurrentPnl > 0 ? "+" : ""}${totalCurrentPnl}円 | - | ${totalBestPnl > 0 ? "+" : ""}${totalBestPnl}円 | ${(totalBestPnl - totalCurrentPnl) > 0 ? "+" : ""}${totalBestPnl - totalCurrentPnl}円 | - |`);

  // 0.5%一律との比較
  console.log("\n\n=== 一律0.5% vs 現在の銘柄別SL ===\n");
  let uniform05Total = 0;
  for (const s of summaryData) {
    // 0.5%の結果を再取得するため、上のループで保存していないので再計算が必要
    // ただしsummaryDataには含まれていないので、slResultsにアクセスできない
    // → 別途計算
  }

  // 一律0.5%の合計を計算
  const uniform05Results: Record<string, number> = {};
  for (const symbol of activeSymbols) {
    const trades = bySymbol.get(symbol) || [];
    let total05 = 0;
    for (const t of trades) {
      const { side, entryPrice, entryTime, shares, tradeDate } = t;
      const [candles] = await conn.execute(
        `SELECT candleTime, open, high, low, close
         FROM rt_candles
         WHERE symbol = ? AND tradeDate = ? AND candleTime > ?
         ORDER BY candleTime LIMIT 400`, [symbol, tradeDate, entryTime]
      ) as any[];
      const result = simulateExit(candles, entryPrice, side, 0.5, shares);
      total05 += result.pnl;
    }
    uniform05Results[symbol] = total05;
    uniform05Total += total05;
  }

  console.log("| 銘柄 | 一律0.5%損益 | 銘柄別SL損益 | 差分 |");
  console.log("|------|-------------|-------------|------|");
  for (const symbol of activeSymbols) {
    const u05 = uniform05Results[symbol] || 0;
    const current = summaryData.find(s => s.symbol === symbol)?.currentPnl || 0;
    const diff = current - u05;
    console.log(`| ${symbol} | ${u05 > 0 ? "+" : ""}${u05}円 | ${current > 0 ? "+" : ""}${current}円 | ${diff > 0 ? "+" : ""}${diff}円 |`);
  }
  console.log(`| **合計** | ${uniform05Total > 0 ? "+" : ""}${uniform05Total}円 | ${totalCurrentPnl > 0 ? "+" : ""}${totalCurrentPnl}円 | ${(totalCurrentPnl - uniform05Total) > 0 ? "+" : ""}${totalCurrentPnl - uniform05Total}円 |`);

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
