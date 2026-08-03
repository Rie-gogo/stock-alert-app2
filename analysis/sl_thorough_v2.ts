/**
 * 銘柄別SL幅 徹底検証スクリプト v2（高速版）
 * 一括でデータ取得し、メモリ上でシミュレーション
 */
import mysql from "mysql2/promise";

const TP_PCT = 1.5;
const MARKET_CLOSE = "15:25";
const SL_OPTIONS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5];

const CURRENT_SL: Record<string, number> = {
  "8035": 0.7, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6920": 0.9,
  "6758": 0.5, "8316": 0.5,
};

const SYMBOL_NAMES: Record<string, string> = {
  "8035": "東京エレクトロン", "6857": "アドバンテスト", "6976": "太陽誘電",
  "6526": "ソシオネクスト", "5803": "フジクラ", "6981": "村田製作所",
  "285A": "キオクシアHD", "6920": "レーザーテック", "6758": "ソニーG", "8316": "三井住友FG",
};

interface Trade {
  tradeDate: string; symbol: string; side: string;
  entryPrice: number; entryTime: string; shares: number;
  reason: string; pnl: number;
}

interface Candle {
  candleTime: string; open: number; high: number; low: number; close: number;
}

function simulateExit(
  candles: Candle[], entryPrice: number, side: string,
  slPct: number, tpPct: number, shares: number
): { pnl: number; reason: string; mfe: number; mae: number } {
  const slLine = side === "long"
    ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100);
  const tpLine = side === "long"
    ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);
  let mfe = 0, mae = 0;

  for (const c of candles) {
    if (side === "long") {
      const fav = (c.high - entryPrice) / entryPrice * 100;
      const adv = (entryPrice - c.low) / entryPrice * 100;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    } else {
      const fav = (entryPrice - c.low) / entryPrice * 100;
      const adv = (c.high - entryPrice) / entryPrice * 100;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    }

    if (c.candleTime >= MARKET_CLOSE) {
      const pnl = side === "long"
        ? Math.round((c.close - entryPrice) * shares)
        : Math.round((entryPrice - c.close) * shares);
      return { pnl, reason: "EOD", mfe, mae };
    }

    if (side === "long") {
      if (c.low <= slLine) return { pnl: Math.round((slLine - entryPrice) * shares), reason: "SL", mfe, mae };
      if (c.high >= tpLine) return { pnl: Math.round((tpLine - entryPrice) * shares), reason: "TP", mfe, mae };
    } else {
      if (c.high >= slLine) return { pnl: Math.round((entryPrice - slLine) * shares), reason: "SL", mfe, mae };
      if (c.low <= tpLine) return { pnl: Math.round((entryPrice - tpLine) * shares), reason: "TP", mfe, mae };
    }
  }

  if (candles.length > 0) {
    const last = candles[candles.length - 1];
    const pnl = side === "long"
      ? Math.round((last.close - entryPrice) * shares)
      : Math.round((entryPrice - last.close) * shares);
    return { pnl, reason: "EOD", mfe, mae };
  }
  return { pnl: 0, reason: "NoData", mfe: 0, mae: 0 };
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // 全トレードを一括取得
  const [allTrades] = await conn.execute(
    `SELECT id, tradeDate, symbol, side, action, price, shares, pnl, reason, tradeTime
     FROM rt_trades ORDER BY tradeDate, id`
  ) as any[];

  // ペアリング
  const pairedTrades: Trade[] = [];
  const openPos: Map<string, any> = new Map();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === 'buy' || t.action === 'short') {
      openPos.set(key, t);
    } else if (t.action === 'sell' || t.action === 'cover') {
      const entryKey = t.action === 'sell'
        ? `${t.tradeDate}_${t.symbol}_long`
        : `${t.tradeDate}_${t.symbol}_short`;
      const entry = openPos.get(entryKey);
      if (entry) {
        pairedTrades.push({
          tradeDate: t.tradeDate, symbol: t.symbol, side: entry.side,
          entryPrice: Number(entry.price), entryTime: entry.tradeTime,
          shares: Number(entry.shares), reason: entry.reason || "", pnl: Number(t.pnl),
        });
        openPos.delete(entryKey);
      }
    }
  }

  const activeSymbols = Object.keys(CURRENT_SL);
  const activeTrades = pairedTrades.filter(t => activeSymbols.includes(t.symbol));

  console.log(`=== 銘柄別SL幅 徹底検証 v2 ===`);
  console.log(`アクティブ銘柄トレード: ${activeTrades.length}件`);
  console.log(`期間: ${activeTrades[0]?.tradeDate} 〜 ${activeTrades[activeTrades.length-1]?.tradeDate}\n`);

  // 全rt_candlesを一括取得（日付・銘柄ごと）
  const candleCache: Map<string, Candle[]> = new Map();
  const uniqueDateSymbols = [...new Set(activeTrades.map(t => `${t.tradeDate}|${t.symbol}`))];

  console.log(`キャンドルデータ取得中... (${uniqueDateSymbols.length}日×銘柄)`);
  for (const ds of uniqueDateSymbols) {
    const [date, symbol] = ds.split("|");
    const [rows] = await conn.execute(
      `SELECT candleTime, open, high, low, close FROM rt_candles
       WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime`,
      [symbol, date]
    ) as any[];
    candleCache.set(ds, rows.map((r: any) => ({
      candleTime: r.candleTime, open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close),
    })));
  }
  console.log("データ取得完了\n");

  function getCandlesAfter(symbol: string, date: string, time: string): Candle[] {
    const all = candleCache.get(`${date}|${symbol}`) || [];
    return all.filter(c => c.candleTime > time);
  }

  // ============================================================
  // 1. 銘柄×SL幅 基本検証
  // ============================================================
  console.log("========================================");
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
        const candles = getCandlesAfter(t.symbol, t.tradeDate, t.entryTime);
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

  // 全SLオプション横並び表示
  console.log("銘柄別 × SL幅別 損益一覧:\n");
  const header = "| 銘柄 | 件数 | " + SL_OPTIONS.map(s => `${s}%`).join(" | ") + " | 現在SL |";
  const sep = "|------|------|" + SL_OPTIONS.map(() => "------").join("|") + "|--------|";
  console.log(header);
  console.log(sep);

  for (const symbol of activeSymbols) {
    const results = symbolResults[symbol];
    if (!results || Object.keys(results).length === 0) continue;
    const trades = activeTrades.filter(t => t.symbol === symbol);
    const cells = SL_OPTIONS.map(sl => {
      const r = results[sl];
      const isCurrent = sl === CURRENT_SL[symbol];
      const isBest = r && r.pnl === Math.max(...SL_OPTIONS.map(s => results[s]?.pnl || -Infinity));
      const prefix = isBest ? "**" : "";
      const suffix = isBest ? "**" : "";
      const mark = isCurrent ? "←" : "";
      return `${prefix}${r?.pnl > 0 ? "+" : ""}${r?.pnl || 0}${suffix}${mark}`;
    });
    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${trades.length} | ${cells.join(" | ")} | ${CURRENT_SL[symbol]}% |`);
  }

  // サマリー
  console.log("\n\n| 銘柄 | 件数 | 現在SL | 現在損益 | 最適SL | 最適損益 | 差分 | 判定 |");
  console.log("|------|------|--------|---------|--------|---------|------|------|");
  let totalCurrent = 0, totalBest = 0;

  for (const symbol of activeSymbols) {
    const results = symbolResults[symbol];
    if (!results) continue;
    const trades = activeTrades.filter(t => t.symbol === symbol);
    const currentPnl = results[CURRENT_SL[symbol]]?.pnl || 0;
    let bestSl = CURRENT_SL[symbol], bestPnl = currentPnl;
    for (const sl of SL_OPTIONS) {
      if (results[sl] && results[sl].pnl > bestPnl) { bestPnl = results[sl].pnl; bestSl = sl; }
    }
    totalCurrent += currentPnl;
    totalBest += bestPnl;
    const diff = bestPnl - currentPnl;
    const judgment = diff === 0 ? "✅最適" : diff < 20000 ? "✅妥当" : diff < 50000 ? "△要検討" : "❌非最適";
    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${trades.length} | ${CURRENT_SL[symbol]}% | ${currentPnl > 0 ? "+" : ""}${currentPnl}円 | ${bestSl}% | ${bestPnl > 0 ? "+" : ""}${bestPnl}円 | ${diff > 0 ? "+" : ""}${diff}円 | ${judgment} |`);
  }
  console.log(`| **合計** | ${activeTrades.length} | - | ${totalCurrent > 0 ? "+" : ""}${totalCurrent}円 | - | ${totalBest > 0 ? "+" : ""}${totalBest}円 | +${totalBest - totalCurrent}円 | - |`);

  // ============================================================
  // 2. LONG/SHORT別の最適SL
  // ============================================================
  console.log("\n\n========================================");
  console.log("【2】LONG/SHORT別 最適SL");
  console.log("========================================\n");

  console.log("| 銘柄 | LONG件数 | LONG現在 | LONG最適SL | LONG最適損益 | SHORT件数 | SHORT現在 | SHORT最適SL | SHORT最適損益 |");
  console.log("|------|---------|---------|-----------|------------|----------|----------|-----------|------------|");

  for (const symbol of activeSymbols) {
    const trades = activeTrades.filter(t => t.symbol === symbol);
    if (trades.length < 3) continue;
    const longTrades = trades.filter(t => t.side === "long");
    const shortTrades = trades.filter(t => t.side === "short");

    let longBestSl = CURRENT_SL[symbol], longBestPnl = -Infinity, longCurrentPnl = 0;
    let shortBestSl = CURRENT_SL[symbol], shortBestPnl = -Infinity, shortCurrentPnl = 0;

    for (const sl of SL_OPTIONS) {
      let lPnl = 0, sPnl = 0;
      for (const t of longTrades) {
        const candles = getCandlesAfter(t.symbol, t.tradeDate, t.entryTime);
        lPnl += simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
      }
      for (const t of shortTrades) {
        const candles = getCandlesAfter(t.symbol, t.tradeDate, t.entryTime);
        sPnl += simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
      }
      if (sl === CURRENT_SL[symbol]) { longCurrentPnl = lPnl; shortCurrentPnl = sPnl; }
      if (lPnl > longBestPnl) { longBestPnl = lPnl; longBestSl = sl; }
      if (sPnl > shortBestPnl) { shortBestPnl = sPnl; shortBestSl = sl; }
    }

    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${longTrades.length} | ${longCurrentPnl > 0 ? "+" : ""}${longCurrentPnl}円 | ${longBestSl}% | ${longBestPnl > 0 ? "+" : ""}${longBestPnl}円 | ${shortTrades.length} | ${shortCurrentPnl > 0 ? "+" : ""}${shortCurrentPnl}円 | ${shortBestSl}% | ${shortBestPnl > 0 ? "+" : ""}${shortBestPnl}円 |`);
  }

  // ============================================================
  // 3. シグナル種別ごとの最適SL
  // ============================================================
  console.log("\n\n========================================");
  console.log("【3】シグナル種別ごとの最適SL");
  console.log("========================================\n");

  const signalCategories: Record<string, Trade[]> = {};
  for (const t of activeTrades) {
    let category = "その他";
    const r = t.reason.toLowerCase();
    if (r.includes("大台") || r.includes("ラウンド") || r.includes("round")) category = "大台確認";
    else if (r.includes("ゴールデン") || r.includes("gc")) category = "ゴールデンクロス";
    else if (r.includes("デッド") || r.includes("dc")) category = "デッドクロス";
    else if (r.includes("ダブルトップ") || r.includes("ダブルボトム")) category = "ダブルトップ/ボトム";
    else if (r.includes("三尊") || r.includes("逆三尊")) category = "三尊/逆三尊";
    else if (r.includes("vwap") || r.includes("クロス")) category = "VWAPクロス";
    else if (r.includes("ダウ")) category = "ダウ理論";
    if (!signalCategories[category]) signalCategories[category] = [];
    signalCategories[category].push(t);
  }

  console.log("| シグナル種別 | 件数 | 現在SL損益 | 最適SL | 最適損益 | 差分 |");
  console.log("|------------|------|----------|--------|---------|------|");

  for (const [category, trades] of Object.entries(signalCategories).sort((a, b) => b[1].length - a[1].length)) {
    let bestSl = 0.5, bestPnl = -Infinity;
    let currentPnl = 0;

    // 現在の銘柄別SLでの損益
    for (const t of trades) {
      const candles = getCandlesAfter(t.symbol, t.tradeDate, t.entryTime);
      currentPnl += simulateExit(candles, t.entryPrice, t.side, CURRENT_SL[t.symbol] || 0.5, TP_PCT, t.shares).pnl;
    }

    // 全トレードに一律SLを適用した場合の最適
    for (const sl of SL_OPTIONS) {
      let pnl = 0;
      for (const t of trades) {
        const candles = getCandlesAfter(t.symbol, t.tradeDate, t.entryTime);
        pnl += simulateExit(candles, t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
      }
      if (pnl > bestPnl) { bestPnl = pnl; bestSl = sl; }
    }

    console.log(`| ${category} | ${trades.length}件 | ${currentPnl > 0 ? "+" : ""}${currentPnl}円 | ${bestSl}% | ${bestPnl > 0 ? "+" : ""}${bestPnl}円 | ${(bestPnl - currentPnl) > 0 ? "+" : ""}${bestPnl - currentPnl}円 |`);
  }

  // ============================================================
  // 4. 前場/後場別の最適SL
  // ============================================================
  console.log("\n\n========================================");
  console.log("【4】前場/後場別 最適SL");
  console.log("========================================\n");

  console.log("| 銘柄 | 前場件数 | 前場現在 | 前場最適SL | 前場最適損益 | 後場件数 | 後場現在 | 後場最適SL | 後場最適損益 |");
  console.log("|------|---------|---------|-----------|------------|---------|---------|-----------|------------|");

  for (const symbol of activeSymbols) {
    const trades = activeTrades.filter(t => t.symbol === symbol);
    if (trades.length < 5) continue;
    const amTrades = trades.filter(t => t.entryTime < "12:00");
    const pmTrades = trades.filter(t => t.entryTime >= "12:00");

    let amBest = CURRENT_SL[symbol], amBestPnl = -Infinity, amCurrent = 0;
    let pmBest = CURRENT_SL[symbol], pmBestPnl = -Infinity, pmCurrent = 0;

    for (const sl of SL_OPTIONS) {
      let amPnl = 0, pmPnl = 0;
      for (const t of amTrades) {
        amPnl += simulateExit(getCandlesAfter(t.symbol, t.tradeDate, t.entryTime), t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
      }
      for (const t of pmTrades) {
        pmPnl += simulateExit(getCandlesAfter(t.symbol, t.tradeDate, t.entryTime), t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
      }
      if (sl === CURRENT_SL[symbol]) { amCurrent = amPnl; pmCurrent = pmPnl; }
      if (amPnl > amBestPnl) { amBestPnl = amPnl; amBest = sl; }
      if (pmPnl > pmBestPnl) { pmBestPnl = pmPnl; pmBest = sl; }
    }

    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${amTrades.length} | ${amCurrent > 0 ? "+" : ""}${amCurrent}円 | ${amBest}% | ${amBestPnl > 0 ? "+" : ""}${amBestPnl}円 | ${pmTrades.length} | ${pmCurrent > 0 ? "+" : ""}${pmCurrent}円 | ${pmBest}% | ${pmBestPnl > 0 ? "+" : ""}${pmBestPnl}円 |`);
  }

  // ============================================================
  // 5. MAE分布
  // ============================================================
  console.log("\n\n========================================");
  console.log("【5】MAE/MFE分布（SL無制限で計測）");
  console.log("========================================\n");

  for (const symbol of activeSymbols) {
    const trades = activeTrades.filter(t => t.symbol === symbol);
    if (trades.length < 3) continue;

    const allMae: number[] = [];
    const winMae: number[] = [];
    const lossMae: number[] = [];

    for (const t of trades) {
      const candles = getCandlesAfter(t.symbol, t.tradeDate, t.entryTime);
      // SL/TP=99%で制限なし計測
      const result = simulateExit(candles, t.entryPrice, t.side, 99, 99, t.shares);
      allMae.push(result.mae);
      if (result.pnl > 0) winMae.push(result.mae);
      else lossMae.push(result.mae);
    }

    allMae.sort((a, b) => a - b);
    winMae.sort((a, b) => a - b);
    lossMae.sort((a, b) => a - b);

    const pct = (arr: number[], p: number) => arr.length > 0 ? arr[Math.floor(arr.length * p)] : 0;
    const slPosition = allMae.filter(v => v <= CURRENT_SL[symbol]).length / allMae.length * 100;
    const winSlPosition = winMae.length > 0 ? winMae.filter(v => v <= CURRENT_SL[symbol]).length / winMae.length * 100 : 0;

    console.log(`${symbol} ${SYMBOL_NAMES[symbol]} (${trades.length}件, 現在SL=${CURRENT_SL[symbol]}%)`);
    console.log(`  全MAE:  25%=${pct(allMae, 0.25).toFixed(2)}% 50%=${pct(allMae, 0.5).toFixed(2)}% 75%=${pct(allMae, 0.75).toFixed(2)}% 90%=${pct(allMae, 0.9).toFixed(2)}%`);
    console.log(`  勝ちMAE(${winMae.length}件): 50%=${pct(winMae, 0.5).toFixed(2)}% 75%=${pct(winMae, 0.75).toFixed(2)}%`);
    console.log(`  負けMAE(${lossMae.length}件): 50%=${pct(lossMae, 0.5).toFixed(2)}% 75%=${pct(lossMae, 0.75).toFixed(2)}%`);
    console.log(`  SL=${CURRENT_SL[symbol]}%の位置: 全体${slPosition.toFixed(0)}%タイル / 勝ちトレード${winSlPosition.toFixed(0)}%タイル`);
    console.log(`  → 勝ちの${winSlPosition.toFixed(0)}%がSLに引っかかる可能性あり`);
    console.log("");
  }

  // ============================================================
  // 6. 直近2週間 vs 全期間
  // ============================================================
  console.log("\n========================================");
  console.log("【6】直近2週間 vs 全期間 比較");
  console.log("========================================\n");

  const allDates = [...new Set(activeTrades.map(t => t.tradeDate))].sort();
  const recentDates = allDates.slice(-10);
  const recentStart = recentDates[0];

  console.log(`全期間: ${allDates[0]} 〜 ${allDates[allDates.length-1]} (${allDates.length}日)`);
  console.log(`直近2週間: ${recentStart} 〜 ${allDates[allDates.length-1]} (${recentDates.length}日)\n`);

  console.log("| 銘柄 | 全期間最適SL | 全期間損益 | 直近件数 | 直近最適SL | 直近損益 | 現在SL | 安定性 |");
  console.log("|------|-----------|---------|---------|----------|---------|--------|--------|");

  for (const symbol of activeSymbols) {
    const allSymTrades = activeTrades.filter(t => t.symbol === symbol);
    const recentSymTrades = activeTrades.filter(t => t.symbol === symbol && t.tradeDate >= recentStart);
    if (allSymTrades.length < 3) continue;

    let allBestSl = 0.5, allBestPnl = -Infinity;
    for (const sl of SL_OPTIONS) {
      let pnl = 0;
      for (const t of allSymTrades) {
        pnl += simulateExit(getCandlesAfter(t.symbol, t.tradeDate, t.entryTime), t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
      }
      if (pnl > allBestPnl) { allBestPnl = pnl; allBestSl = sl; }
    }

    let recentBestSl = 0.5, recentBestPnl = -Infinity;
    if (recentSymTrades.length > 0) {
      for (const sl of SL_OPTIONS) {
        let pnl = 0;
        for (const t of recentSymTrades) {
          pnl += simulateExit(getCandlesAfter(t.symbol, t.tradeDate, t.entryTime), t.entryPrice, t.side, sl, TP_PCT, t.shares).pnl;
        }
        if (pnl > recentBestPnl) { recentBestPnl = pnl; recentBestSl = sl; }
      }
    }

    const stability = allBestSl === recentBestSl ? "✅安定" :
                      Math.abs(allBestSl - recentBestSl) <= 0.2 ? "△やや不安定" : "❌不安定";

    console.log(`| ${symbol} ${SYMBOL_NAMES[symbol]} | ${allBestSl}% | ${allBestPnl > 0 ? "+" : ""}${allBestPnl}円 | ${recentSymTrades.length}件 | ${recentBestSl}% | ${recentBestPnl > 0 ? "+" : ""}${recentBestPnl}円 | ${CURRENT_SL[symbol]}% | ${stability} |`);
  }

  // ============================================================
  // 7. 最終総合判定
  // ============================================================
  console.log("\n\n========================================");
  console.log("【7】最終総合判定");
  console.log("========================================\n");

  console.log("現在の設定:");
  for (const symbol of activeSymbols) {
    console.log(`  ${symbol} ${SYMBOL_NAMES[symbol]}: SL=${CURRENT_SL[symbol]}%`);
  }
  console.log(`\n合計損益（現在設定）: ${totalCurrent > 0 ? "+" : ""}${totalCurrent}円`);
  console.log(`合計損益（各銘柄最適）: ${totalBest > 0 ? "+" : ""}${totalBest}円`);
  console.log(`改善余地: +${totalBest - totalCurrent}円`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
