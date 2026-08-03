/**
 * 銘柄別SL幅 徹底検証スクリプト
 * 
 * 検証観点:
 * 1. 銘柄×SL幅の全組み合わせ（基本検証の再確認）
 * 2. LONG/SHORT別の最適SL
 * 3. シグナル種別ごとの最適SL
 * 4. 前場/後場別の最適SL
 * 5. 勝ちトレードのMFE分布（TPとの関係）
 * 6. 負けトレードのMAE分布（SLの妥当性）
 * 7. 直近2週間 vs 全期間の比較（レジーム変化の確認）
 */
import mysql from "mysql2/promise";

const TP_PCT = 1.5;
const MARKET_CLOSE = "15:25";
const SL_OPTIONS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5];

const CURRENT_SL: Record<string, number> = {
  "8035": 0.7,
  "6857": 0.6,
  "6976": 0.5,
  "6526": 0.9,
  "5803": 0.5,
  "6981": 0.9,
  "285A": 0.8,
  "6920": 0.9,
  "6758": 0.5,
  "8316": 0.5,
};

const SYMBOL_NAMES: Record<string, string> = {
  "8035": "東京エレクトロン",
  "6857": "アドバンテスト",
  "6976": "太陽誘電",
  "6526": "ソシオネクスト",
  "5803": "フジクラ",
  "6981": "村田製作所",
  "285A": "キオクシアHD",
  "6920": "レーザーテック",
  "6758": "ソニーG",
  "8316": "三井住友FG",
};

interface Trade {
  tradeDate: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  pnl: number;
  reason: string;
  exitReason: string;
  shares: number;
}

function simulateExit(
  candles: any[],
  entryPrice: number,
  side: string,
  slPct: number,
  tpPct: number,
  shares: number
): { pnl: number; reason: string; exitTime: string; mfe: number; mae: number } {
  const slLine = side === "long"
    ? entryPrice * (1 - slPct / 100)
    : entryPrice * (1 + slPct / 100);
  const tpLine = side === "long"
    ? entryPrice * (1 + tpPct / 100)
    : entryPrice * (1 - tpPct / 100);

  let mfe = 0; // max favorable excursion (%)
  let mae = 0; // max adverse excursion (%)

  for (const c of candles) {
    const high = Number(c.high);
    const low = Number(c.low);
    const time = c.candleTime as string;

    // MFE/MAE計算
    if (side === "long") {
      const favorable = (high - entryPrice) / entryPrice * 100;
      const adverse = (entryPrice - low) / entryPrice * 100;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    } else {
      const favorable = (entryPrice - low) / entryPrice * 100;
      const adverse = (high - entryPrice) / entryPrice * 100;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    }

    if (time >= MARKET_CLOSE) {
      const closePrice = Number(c.close);
      const pnl = side === "long"
        ? Math.round((closePrice - entryPrice) * shares)
        : Math.round((entryPrice - closePrice) * shares);
      return { pnl, reason: "EOD", exitTime: time, mfe, mae };
    }

    if (side === "long") {
      if (low <= slLine) {
        const pnl = Math.round((slLine - entryPrice) * shares);
        return { pnl, reason: "SL", exitTime: time, mfe, mae };
      }
      if (high >= tpLine) {
        const pnl = Math.round((tpLine - entryPrice) * shares);
        return { pnl, reason: "TP", exitTime: time, mfe, mae };
      }
    } else {
      if (high >= slLine) {
        const pnl = Math.round((entryPrice - slLine) * shares);
        return { pnl, reason: "SL", exitTime: time, mfe, mae };
      }
      if (low <= tpLine) {
        const pnl = Math.round((entryPrice - tpLine) * shares);
        return { pnl, reason: "TP", exitTime: time, mfe, mae };
      }
    }
  }

  if (candles.length > 0) {
    const lastClose = Number(candles[candles.length - 1].close);
    const pnl = side === "long"
      ? Math.round((lastClose - entryPrice) * shares)
      : Math.round((entryPrice - lastClose) * shares);
    return { pnl, reason: "EOD", exitTime: candles[candles.length - 1].candleTime, mfe, mae };
  }

  return { pnl: 0, reason: "NoData", exitTime: "", mfe: 0, mae: 0 };
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // 全トレードを取得
  const [allTrades] = await conn.execute(
    `SELECT id, tradeDate, symbol, side, action, price, shares, pnl, reason, tradeTime
     FROM rt_trades ORDER BY tradeDate, id`
  ) as any[];

  // ペアリング
  const pairedTrades: Trade[] = [];
  const openPositions: Map<string, any> = new Map();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === 'buy' || t.action === 'short') {
      openPositions.set(key, t);
    } else if (t.action === 'sell' || t.action === 'cover') {
      const entryKey = t.action === 'sell'
        ? `${t.tradeDate}_${t.symbol}_long`
        : `${t.tradeDate}_${t.symbol}_short`;
      const entry = openPositions.get(entryKey);
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
          reason: entry.reason || "",
          exitReason: t.reason || "",
          shares: Number(entry.shares),
        });
        openPositions.delete(entryKey);
      }
    }
  }

  const activeSymbols = Object.keys(CURRENT_SL);

  // アクティブ銘柄のトレードのみ
  const activeTrades = pairedTrades.filter(t => activeSymbols.includes(t.symbol));

  console.log(`=== 銘柄別SL幅 徹底検証 ===`);
  console.log(`全ペアトレード: ${pairedTrades.length}件`);
  console.log(`アクティブ銘柄トレード: ${activeTrades.length}件`);
  console.log(`期間: ${activeTrades[0]?.tradeDate} 〜 ${activeTrades[activeTrades.length-1]?.tradeDate}\n`);

  // ============================================================
  // 1. 銘柄×SL幅 基本検証（再確認）
  // ============================================================
  console.log("\n========================================");
  console.log("【1】銘柄×SL幅 基本検証");
  console.log("========================================\n");

  const symbolResults: Record<string, Record<number, { pnl: number; wins: number; total: number; tp: number; sl: number; eod: number }>> = {};

  for (const symbol of activeSymbols) {
    symbolResults[symbol] = {};
    const trades = activeTrades.filter(t => t.symbol === symbol);
    if (trades.length === 0) continue;

    for (const sl of SL_OPTIONS) {
      let pnl = 0, wins = 0, tp = 0, slCount = 0, eod = 0;
      for (const t of trades) {
        const [candles] = await conn.execute(
          `SELECT candleTime, open, high, low, close FROM rt_candles
           WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
          [t.symbol, t.tradeDate, t.entryTime]
        ) as any[];
        const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
        pnl += result.pnl;
        if (result.pnl > 0) wins++;
        if (result.reason === "TP") tp++;
        else if (result.reason === "SL") slCount++;
        else eod++;
      }
      symbolResults[symbol][sl] = { pnl, wins, total: trades.length, tp, sl: slCount, eod };
    }
  }

  // 表示
  console.log("| 銘柄 | 件数 | 現在SL | 現在損益 | 最適SL | 最適損益 | 差分 |");
  console.log("|------|------|--------|---------|--------|---------|------|");
  for (const symbol of activeSymbols) {
    const results = symbolResults[symbol];
    if (!results || Object.keys(results).length === 0) continue;
    const currentPnl = results[CURRENT_SL[symbol]]?.pnl || 0;
    let bestSl = CURRENT_SL[symbol];
    let bestPnl = currentPnl;
    for (const sl of SL_OPTIONS) {
      if (results[sl] && results[sl].pnl > bestPnl) {
        bestPnl = results[sl].pnl;
        bestSl = sl;
      }
    }
    const trades = activeTrades.filter(t => t.symbol === symbol);
    const diff = bestPnl - currentPnl;
    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${trades.length}件 | ${CURRENT_SL[symbol]}% | ${currentPnl > 0 ? "+" : ""}${currentPnl}円 | ${bestSl}% | ${bestPnl > 0 ? "+" : ""}${bestPnl}円 | ${diff > 0 ? "+" : ""}${diff}円 |`);
  }

  // ============================================================
  // 2. LONG/SHORT別の最適SL
  // ============================================================
  console.log("\n\n========================================");
  console.log("【2】LONG/SHORT別 最適SL");
  console.log("========================================\n");

  for (const symbol of activeSymbols) {
    const trades = activeTrades.filter(t => t.symbol === symbol);
    const longTrades = trades.filter(t => t.side === "long");
    const shortTrades = trades.filter(t => t.side === "short");

    if (trades.length < 3) continue;

    console.log(`\n--- ${symbol} ${SYMBOL_NAMES[symbol]} (LONG:${longTrades.length}件 / SHORT:${shortTrades.length}件) ---`);

    for (const [label, subset] of [["LONG", longTrades], ["SHORT", shortTrades]] as const) {
      if (subset.length === 0) continue;
      let bestSl = 0.5;
      let bestPnl = -Infinity;
      const slPnls: Record<number, number> = {};

      for (const sl of SL_OPTIONS) {
        let pnl = 0;
        for (const t of subset) {
          const [candles] = await conn.execute(
            `SELECT candleTime, open, high, low, close FROM rt_candles
             WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
            [t.symbol, t.tradeDate, t.entryTime]
          ) as any[];
          const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
          pnl += result.pnl;
        }
        slPnls[sl] = pnl;
        if (pnl > bestPnl) { bestPnl = pnl; bestSl = sl; }
      }

      const currentPnl = slPnls[CURRENT_SL[symbol]] || 0;
      console.log(`  ${label}: 現在SL=${CURRENT_SL[symbol]}%(${currentPnl > 0 ? "+" : ""}${currentPnl}円) → 最適SL=${bestSl}%(${bestPnl > 0 ? "+" : ""}${bestPnl}円) 差=${bestPnl - currentPnl > 0 ? "+" : ""}${bestPnl - currentPnl}円`);
    }
  }

  // ============================================================
  // 3. シグナル種別ごとの最適SL
  // ============================================================
  console.log("\n\n========================================");
  console.log("【3】シグナル種別ごとの最適SL");
  console.log("========================================\n");

  // シグナル種別を分類
  const signalCategories: Record<string, Trade[]> = {};
  for (const t of activeTrades) {
    let category = "その他";
    const r = t.reason.toLowerCase();
    if (r.includes("大台") || r.includes("ラウンド") || r.includes("round")) category = "大台確認";
    else if (r.includes("ゴールデン") || r.includes("gc") || r.includes("デッド") || r.includes("dc")) category = "GC/DC";
    else if (r.includes("ダブルトップ") || r.includes("ダブルボトム")) category = "ダブルトップ/ボトム";
    else if (r.includes("三尊") || r.includes("逆三尊") || r.includes("ヘッドアンドショルダー")) category = "三尊/逆三尊";
    else if (r.includes("vwap") || r.includes("クロス")) category = "VWAPクロス";
    else if (r.includes("ダウ")) category = "ダウ理論";

    if (!signalCategories[category]) signalCategories[category] = [];
    signalCategories[category].push(t);
  }

  console.log("| シグナル種別 | 件数 | 現在SL平均損益 | 最適SL | 最適損益 |");
  console.log("|------------|------|-------------|--------|---------|");

  for (const [category, trades] of Object.entries(signalCategories).sort((a, b) => b[1].length - a[1].length)) {
    let bestSl = 0.5;
    let bestPnl = -Infinity;
    const slPnls: Record<number, number> = {};

    for (const sl of SL_OPTIONS) {
      let pnl = 0;
      for (const t of trades) {
        const [candles] = await conn.execute(
          `SELECT candleTime, open, high, low, close FROM rt_candles
           WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
          [t.symbol, t.tradeDate, t.entryTime]
        ) as any[];
        const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
        pnl += result.pnl;
      }
      slPnls[sl] = pnl;
      if (pnl > bestPnl) { bestPnl = pnl; bestSl = sl; }
    }

    // 現在のSLでの平均損益（各トレードの銘柄別SLを使用）
    let currentPnl = 0;
    for (const t of trades) {
      const sl = CURRENT_SL[t.symbol] || 0.5;
      const [candles] = await conn.execute(
        `SELECT candleTime, open, high, low, close FROM rt_candles
         WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
        [t.symbol, t.tradeDate, t.entryTime]
      ) as any[];
      const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
      currentPnl += result.pnl;
    }

    console.log(`| ${category} | ${trades.length}件 | ${currentPnl > 0 ? "+" : ""}${currentPnl}円 | ${bestSl}% | ${bestPnl > 0 ? "+" : ""}${bestPnl}円 |`);
  }

  // ============================================================
  // 4. 前場/後場別の最適SL
  // ============================================================
  console.log("\n\n========================================");
  console.log("【4】前場/後場別 最適SL");
  console.log("========================================\n");

  for (const symbol of activeSymbols) {
    const trades = activeTrades.filter(t => t.symbol === symbol);
    if (trades.length < 5) continue;

    const amTrades = trades.filter(t => t.entryTime < "12:00");
    const pmTrades = trades.filter(t => t.entryTime >= "12:00");

    if (amTrades.length === 0 && pmTrades.length === 0) continue;

    console.log(`\n--- ${symbol} ${SYMBOL_NAMES[symbol]} (前場:${amTrades.length}件 / 後場:${pmTrades.length}件) ---`);

    for (const [label, subset] of [["前場", amTrades], ["後場", pmTrades]] as const) {
      if (subset.length === 0) continue;
      let bestSl = 0.5;
      let bestPnl = -Infinity;
      const slPnls: Record<number, number> = {};

      for (const sl of SL_OPTIONS) {
        let pnl = 0;
        for (const t of subset) {
          const [candles] = await conn.execute(
            `SELECT candleTime, open, high, low, close FROM rt_candles
             WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
            [t.symbol, t.tradeDate, t.entryTime]
          ) as any[];
          const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
          pnl += result.pnl;
        }
        slPnls[sl] = pnl;
        if (pnl > bestPnl) { bestPnl = pnl; bestSl = sl; }
      }

      const currentPnl = slPnls[CURRENT_SL[symbol]] || 0;
      console.log(`  ${label}: 現在SL=${CURRENT_SL[symbol]}%(${currentPnl > 0 ? "+" : ""}${currentPnl}円) → 最適SL=${bestSl}%(${bestPnl > 0 ? "+" : ""}${bestPnl}円) 差=${bestPnl - currentPnl > 0 ? "+" : ""}${bestPnl - currentPnl}円`);
    }
  }

  // ============================================================
  // 5. MAE分布（負けトレードの逆行幅）
  // ============================================================
  console.log("\n\n========================================");
  console.log("【5】MAE分布（負けトレードの逆行パターン）");
  console.log("========================================\n");

  for (const symbol of activeSymbols) {
    const trades = activeTrades.filter(t => t.symbol === symbol);
    if (trades.length < 3) continue;

    const maeValues: number[] = [];
    const mfeValues: number[] = [];
    const winMfeValues: number[] = [];
    const lossMaeValues: number[] = [];

    for (const t of trades) {
      const [candles] = await conn.execute(
        `SELECT candleTime, open, high, low, close FROM rt_candles
         WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
        [t.symbol, t.tradeDate, t.entryTime]
      ) as any[];
      const result = simulateExit(candles, t.entryPrice, t.side, 99, 99, t.shares); // 大きなSL/TPでMAE/MFEを計測
      maeValues.push(result.mae);
      mfeValues.push(result.mfe);
      if (result.pnl > 0) winMfeValues.push(result.mfe);
      else lossMaeValues.push(result.mae);
    }

    maeValues.sort((a, b) => a - b);
    lossMaeValues.sort((a, b) => a - b);

    const p25 = maeValues[Math.floor(maeValues.length * 0.25)] || 0;
    const p50 = maeValues[Math.floor(maeValues.length * 0.50)] || 0;
    const p75 = maeValues[Math.floor(maeValues.length * 0.75)] || 0;
    const p90 = maeValues[Math.floor(maeValues.length * 0.90)] || 0;

    const lossP50 = lossMaeValues.length > 0 ? lossMaeValues[Math.floor(lossMaeValues.length * 0.50)] : 0;
    const lossP75 = lossMaeValues.length > 0 ? lossMaeValues[Math.floor(lossMaeValues.length * 0.75)] : 0;

    console.log(`${symbol} ${SYMBOL_NAMES[symbol]} (${trades.length}件, 現在SL=${CURRENT_SL[symbol]}%)`);
    console.log(`  全MAE: 25%=${p25.toFixed(2)}% 50%=${p50.toFixed(2)}% 75%=${p75.toFixed(2)}% 90%=${p90.toFixed(2)}%`);
    console.log(`  負けMAE(${lossMaeValues.length}件): 50%=${lossP50.toFixed(2)}% 75%=${lossP75.toFixed(2)}%`);
    console.log(`  → SL=${CURRENT_SL[symbol]}%は全MAEの${(maeValues.filter(v => v <= CURRENT_SL[symbol]).length / maeValues.length * 100).toFixed(0)}%タイルに位置`);
    console.log("");
  }

  // ============================================================
  // 6. 直近2週間 vs 全期間
  // ============================================================
  console.log("\n========================================");
  console.log("【6】直近2週間 vs 全期間 比較");
  console.log("========================================\n");

  // 直近2週間の日付を特定
  const allDates = [...new Set(activeTrades.map(t => t.tradeDate))].sort();
  const recentDates = allDates.slice(-10); // 直近10営業日
  const recentStart = recentDates[0];

  console.log(`全期間: ${allDates[0]} 〜 ${allDates[allDates.length-1]} (${allDates.length}日)`);
  console.log(`直近2週間: ${recentStart} 〜 ${allDates[allDates.length-1]} (${recentDates.length}日)\n`);

  console.log("| 銘柄 | 全期間最適SL | 全期間損益 | 直近最適SL | 直近損益 | 現在SL | 一致? |");
  console.log("|------|-----------|---------|----------|---------|--------|------|");

  for (const symbol of activeSymbols) {
    const allSymTrades = activeTrades.filter(t => t.symbol === symbol);
    const recentSymTrades = activeTrades.filter(t => t.symbol === symbol && t.tradeDate >= recentStart);

    if (allSymTrades.length < 3) continue;

    // 全期間の最適SL
    let allBestSl = 0.5, allBestPnl = -Infinity;
    for (const sl of SL_OPTIONS) {
      let pnl = 0;
      for (const t of allSymTrades) {
        const [candles] = await conn.execute(
          `SELECT candleTime, open, high, low, close FROM rt_candles
           WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
          [t.symbol, t.tradeDate, t.entryTime]
        ) as any[];
        const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
        pnl += result.pnl;
      }
      if (pnl > allBestPnl) { allBestPnl = pnl; allBestSl = sl; }
    }

    // 直近の最適SL
    let recentBestSl = 0.5, recentBestPnl = -Infinity;
    if (recentSymTrades.length > 0) {
      for (const sl of SL_OPTIONS) {
        let pnl = 0;
        for (const t of recentSymTrades) {
          const [candles] = await conn.execute(
            `SELECT candleTime, open, high, low, close FROM rt_candles
             WHERE symbol = ? AND tradeDate = ? AND candleTime > ? ORDER BY candleTime LIMIT 400`,
            [t.symbol, t.tradeDate, t.entryTime]
          ) as any[];
          const result = simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares);
          pnl += result.pnl;
        }
        if (pnl > recentBestPnl) { recentBestPnl = pnl; recentBestSl = sl; }
      }
    }

    const match = allBestSl === recentBestSl ? "✅" :
                  Math.abs(allBestSl - recentBestSl) <= 0.2 ? "△" : "❌";

    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${allBestSl}% | ${allBestPnl > 0 ? "+" : ""}${allBestPnl}円 | ${recentBestSl}%(${recentSymTrades.length}件) | ${recentBestPnl > 0 ? "+" : ""}${recentBestPnl}円 | ${CURRENT_SL[symbol]}% | ${match} |`);
  }

  // ============================================================
  // 7. 最終判定
  // ============================================================
  console.log("\n\n========================================");
  console.log("【7】最終判定: 現在のSL設定の妥当性");
  console.log("========================================\n");

  let totalCurrentPnl = 0;
  let totalBestPnl = 0;

  console.log("| 銘柄 | 現在SL | 全期間最適 | 現在損益 | 最適損益 | 差分 | 判定 |");
  console.log("|------|--------|----------|---------|---------|------|------|");

  for (const symbol of activeSymbols) {
    const results = symbolResults[symbol];
    if (!results) continue;
    const currentPnl = results[CURRENT_SL[symbol]]?.pnl || 0;
    let bestSl = CURRENT_SL[symbol];
    let bestPnl = currentPnl;
    for (const sl of SL_OPTIONS) {
      if (results[sl] && results[sl].pnl > bestPnl) {
        bestPnl = results[sl].pnl;
        bestSl = sl;
      }
    }
    totalCurrentPnl += currentPnl;
    totalBestPnl += bestPnl;
    const diff = bestPnl - currentPnl;
    const judgment = diff === 0 ? "✅最適" :
                     diff < 20000 ? "✅妥当" :
                     diff < 50000 ? "△要検討" : "❌非最適";
    console.log(`| ${symbol} | ${CURRENT_SL[symbol]}% | ${bestSl}% | ${currentPnl > 0 ? "+" : ""}${currentPnl}円 | ${bestPnl > 0 ? "+" : ""}${bestPnl}円 | ${diff > 0 ? "+" : ""}${diff}円 | ${judgment} |`);
  }

  console.log(`| **合計** | - | - | ${totalCurrentPnl > 0 ? "+" : ""}${totalCurrentPnl}円 | ${totalBestPnl > 0 ? "+" : ""}${totalBestPnl}円 | ${(totalBestPnl - totalCurrentPnl) > 0 ? "+" : ""}${totalBestPnl - totalCurrentPnl}円 | - |`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
