/**
 * mae_mfe_by_symbol.ts
 * 全rt_tradesのMAE/MFE分析 + 銘柄別最適SL幅算出
 * 
 * - 方向正解トレード（EODまで保有で利益）のMAE分布を銘柄別に分析
 * - 「方向は合っていたのにSLで狩られた」ケースを特定
 * - 各銘柄の最適SL幅を提案
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/mae_mfe_by_symbol.ts
 */
import mysql from "mysql2/promise";
import { TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } from "../shared/stocks";

interface TradeWithContext {
  symbol: string;
  symbolName: string;
  tradeDate: string;
  side: "long" | "short";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  // Computed
  mfe: number;        // Maximum Favorable Excursion (%)
  mae: number;        // Maximum Adverse Excursion (%)
  mfeTime: string;
  maeTime: string;
  eodPnlPct: number;  // EODまで保有した場合の損益(%)
  directionCorrect: boolean;
  slHit: boolean;     // SL0.5%で狩られたか
  exitReason: string;
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // アクティブ銘柄のみ
  const activeSymbols = TARGET_STOCKS
    .filter(s => !TRADE_EXCLUDED_SYMBOLS.has(s.symbol))
    .map(s => s.symbol);
  console.log(`対象銘柄: ${activeSymbols.join(", ")}`);

  // 全rt_tradesを取得（エントリーと決済をペアリング）
  const [allTrades] = await conn.execute(
    `SELECT symbol, symbolName, tradeDate, tradeTime, action, side, price, pnl, reason
     FROM rt_trades 
     WHERE symbol IN (${activeSymbols.map(() => "?").join(",")})
     ORDER BY tradeDate, tradeTime`,
    activeSymbols
  ) as any[];

  // エントリーと決済をペアリング
  const pairs: { entry: any; exit: any }[] = [];
  const pendingEntries = new Map<string, any>();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === "buy" || t.action === "short") {
      pendingEntries.set(key, t);
    } else if (t.action === "sell" || t.action === "cover") {
      const entry = pendingEntries.get(key);
      if (entry) {
        pairs.push({ entry, exit: t });
        pendingEntries.delete(key);
      }
    }
  }
  console.log(`ペアリング完了: ${pairs.length}件`);

  // 各トレードのMAE/MFEを計算
  const results: TradeWithContext[] = [];
  
  for (const { entry, exit } of pairs) {
    // その日のキャンドルデータを取得
    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close, volume
       FROM rt_candles 
       WHERE symbol = ? AND tradeDate = ?
       ORDER BY candleTime`,
      [entry.symbol, entry.tradeDate]
    ) as any[];

    if (candles.length === 0) continue;

    const entryPrice = parseFloat(entry.price);
    const exitPrice = parseFloat(exit.price);
    const pnl = Number(exit.pnl);
    const side = entry.side as "long" | "short";

    // エントリー以降のキャンドルを取得
    const entryIdx = candles.findIndex((c: any) => c.candleTime >= entry.tradeTime);
    if (entryIdx < 0) continue;
    const afterEntry = candles.slice(entryIdx);
    const eodCandle = candles[candles.length - 1];

    // MAE/MFE計算
    let mfe = 0, mae = 0, mfeTime = "", maeTime = "";
    for (const c of afterEntry) {
      const high = parseFloat(c.high);
      const low = parseFloat(c.low);
      if (side === "long") {
        const favorable = (high - entryPrice) / entryPrice * 100;
        const adverse = (entryPrice - low) / entryPrice * 100;
        if (favorable > mfe) { mfe = favorable; mfeTime = c.candleTime; }
        if (adverse > mae) { mae = adverse; maeTime = c.candleTime; }
      } else {
        const favorable = (entryPrice - low) / entryPrice * 100;
        const adverse = (high - entryPrice) / entryPrice * 100;
        if (favorable > mfe) { mfe = favorable; mfeTime = c.candleTime; }
        if (adverse > mae) { mae = adverse; maeTime = c.candleTime; }
      }
    }

    // EODまで保有した場合の損益
    const eodClose = parseFloat(eodCandle.close);
    const eodPnlPct = side === "long"
      ? (eodClose - entryPrice) / entryPrice * 100
      : (entryPrice - eodClose) / entryPrice * 100;

    const directionCorrect = eodPnlPct > 0;
    const exitReason = (exit.reason || "").includes("利確") ? "TP" 
      : (exit.reason || "").includes("損切") ? "SL"
      : (exit.reason || "").includes("大引け") ? "EOD" : "OTHER";
    const slHit = exitReason === "SL";

    results.push({
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      tradeDate: entry.tradeDate,
      side,
      entryTime: entry.tradeTime,
      exitTime: exit.tradeTime,
      entryPrice,
      exitPrice,
      pnl,
      reason: entry.reason,
      mfe, mae, mfeTime, maeTime,
      eodPnlPct,
      directionCorrect,
      slHit,
      exitReason,
    });
  }

  console.log(`MAE/MFE計算完了: ${results.length}件`);

  // ============================================================
  // 銘柄別分析
  // ============================================================
  console.log("\n" + "=".repeat(100));
  console.log("銘柄別 MAE/MFE 分析");
  console.log("=".repeat(100));

  const symbolStats = new Map<string, {
    total: number;
    wins: number;
    dirCorrect: number;
    dirCorrectButSL: number;
    avgMAE: number;
    avgMFE: number;
    maeList: number[];
    mfeList: number[];
    dirCorrectMAE: number[];
    totalPnl: number;
    lostPnlBySL: number;  // 方向正解なのにSLで失った額
  }>();

  for (const sym of activeSymbols) {
    const symTrades = results.filter(r => r.symbol === sym);
    if (symTrades.length === 0) continue;

    const dirCorrectTrades = symTrades.filter(r => r.directionCorrect);
    const dirCorrectButSL = dirCorrectTrades.filter(r => r.slHit);
    const lostPnlBySL = dirCorrectButSL.reduce((sum, t) => sum + t.pnl, 0);

    symbolStats.set(sym, {
      total: symTrades.length,
      wins: symTrades.filter(r => r.pnl > 0).length,
      dirCorrect: dirCorrectTrades.length,
      dirCorrectButSL: dirCorrectButSL.length,
      avgMAE: symTrades.reduce((s, t) => s + t.mae, 0) / symTrades.length,
      avgMFE: symTrades.reduce((s, t) => s + t.mfe, 0) / symTrades.length,
      maeList: symTrades.map(t => t.mae).sort((a, b) => a - b),
      mfeList: symTrades.map(t => t.mfe).sort((a, b) => a - b),
      dirCorrectMAE: dirCorrectTrades.map(t => t.mae).sort((a, b) => a - b),
      totalPnl: symTrades.reduce((s, t) => s + t.pnl, 0),
      lostPnlBySL: lostPnlBySL,
    });
  }

  // テーブル出力
  console.log("\n--- 銘柄別サマリー ---");
  console.log(
    "銘柄".padEnd(8) + "名前".padEnd(14) + "件数".padStart(5) + "勝率".padStart(7) +
    "方向正解".padStart(9) + "正解SL狩".padStart(10) + "平均MAE".padStart(9) + "平均MFE".padStart(9) +
    "MAE中央値".padStart(10) + "MAE75%".padStart(9) + "MAE90%".padStart(9) + "損失額(正解SL)".padStart(14)
  );
  console.log("-".repeat(120));

  for (const [sym, stats] of [...symbolStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name || sym;
    const p50 = stats.maeList[Math.floor(stats.maeList.length * 0.5)] || 0;
    const p75 = stats.maeList[Math.floor(stats.maeList.length * 0.75)] || 0;
    const p90 = stats.maeList[Math.floor(stats.maeList.length * 0.9)] || 0;
    console.log(
      sym.padEnd(8) + name.substring(0, 7).padEnd(14) +
      `${stats.total}`.padStart(5) +
      `${(stats.wins / stats.total * 100).toFixed(0)}%`.padStart(7) +
      `${stats.dirCorrect}/${stats.total}`.padStart(9) +
      `${stats.dirCorrectButSL}`.padStart(10) +
      `${stats.avgMAE.toFixed(2)}%`.padStart(9) +
      `${stats.avgMFE.toFixed(2)}%`.padStart(9) +
      `${p50.toFixed(2)}%`.padStart(10) +
      `${p75.toFixed(2)}%`.padStart(9) +
      `${p90.toFixed(2)}%`.padStart(9) +
      `${Math.round(stats.lostPnlBySL).toLocaleString()}`.padStart(14)
    );
  }

  // ============================================================
  // 方向正解トレードのMAE分布（銘柄別）
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("方向正解トレードのMAE分布（銘柄別） - 最適SL幅の根拠");
  console.log("=".repeat(100));

  for (const [sym, stats] of [...symbolStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    if (stats.dirCorrectMAE.length === 0) continue;
    const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name || sym;
    const maes = stats.dirCorrectMAE;
    const p50 = maes[Math.floor(maes.length * 0.5)] || 0;
    const p75 = maes[Math.floor(maes.length * 0.75)] || 0;
    const p90 = maes[Math.floor(maes.length * 0.9)] || 0;
    const max = maes[maes.length - 1] || 0;

    // SL幅ごとの生存率
    const slLevels = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2];
    const survivalRates = slLevels.map(sl => {
      const survived = maes.filter(m => m < sl).length;
      return (survived / maes.length * 100).toFixed(0);
    });

    console.log(`\n  ${sym} ${name} (方向正解${maes.length}件)`);
    console.log(`    MAE分布: 中央値${p50.toFixed(2)}% | 75%=${p75.toFixed(2)}% | 90%=${p90.toFixed(2)}% | 最大${max.toFixed(2)}%`);
    console.log(`    SL生存率: ${slLevels.map((sl, i) => `${sl}%→${survivalRates[i]}%`).join(" | ")}`);
    
    // 推奨SL: 方向正解トレードの75%以上が生存するSL幅
    const recommendedSL = slLevels.find((sl, i) => parseInt(survivalRates[i]) >= 75) || 1.0;
    console.log(`    → 推奨SL: ${recommendedSL}% (方向正解の75%以上が生存)`);
  }

  // ============================================================
  // 全体の最適SL幅シミュレーション
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("SL幅別 損益シミュレーション（全銘柄）");
  console.log("=".repeat(100));

  const slLevels = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const tpPct = 1.5;

  for (const sl of slLevels) {
    let totalPnl = 0;
    let wins = 0, losses = 0;
    for (const t of results) {
      // SLヒット判定
      if (t.mae >= sl) {
        // SLで損切り
        const slLoss = t.side === "long"
          ? -t.entryPrice * sl / 100 * (t.pnl / (t.exitPrice - t.entryPrice) || 1) // shares approximation
          : -t.entryPrice * sl / 100 * (t.pnl / (t.entryPrice - t.exitPrice) || 1);
        // 簡易計算: 元のpnlからshares推定
        const actualSlPct = t.exitReason === "SL" ? 0.5 : 0; // 実際のSL幅
        const shares = t.exitReason === "SL" 
          ? Math.abs(t.pnl) / (t.entryPrice * 0.005)
          : t.exitReason === "TP"
          ? t.pnl / (t.entryPrice * 0.015)
          : Math.abs(t.pnl) / Math.abs(t.exitPrice - t.entryPrice);
        
        // MFEがTP以上ならTP、そうでなければSL
        if (t.mfe >= tpPct) {
          const profit = t.entryPrice * tpPct / 100 * shares;
          totalPnl += profit;
          wins++;
        } else {
          const loss = -t.entryPrice * sl / 100 * shares;
          totalPnl += loss;
          losses++;
        }
      } else {
        // SLに到達しない
        if (t.mfe >= tpPct) {
          const shares = t.exitReason === "TP"
            ? t.pnl / (t.entryPrice * 0.015)
            : Math.abs(t.pnl) / Math.max(Math.abs(t.exitPrice - t.entryPrice), 1);
          const profit = t.entryPrice * tpPct / 100 * shares;
          totalPnl += profit;
          wins++;
        } else {
          // EOD決済（実際の損益に近似）
          totalPnl += t.pnl;
          if (t.pnl > 0) wins++; else losses++;
        }
      }
    }
    const winRate = wins / (wins + losses) * 100;
    console.log(`  SL=${sl.toFixed(1)}%: 総損益${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円 | ${wins}勝${losses}敗 (${winRate.toFixed(1)}%)`);
  }

  // ============================================================
  // 「方向正解なのにSLで狩られた」全トレード一覧
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("方向正解なのにSL(0.5%)で狩られた全トレード");
  console.log("=".repeat(100));
  const slHunted = results.filter(r => r.directionCorrect && r.slHit);
  console.log(`合計: ${slHunted.length}件 / 損失合計: ${Math.round(slHunted.reduce((s, t) => s + t.pnl, 0)).toLocaleString()}円`);
  console.log(`(EODまで保有していれば: +${Math.round(slHunted.reduce((s, t) => s + t.eodPnlPct * t.entryPrice * Math.abs(t.pnl) / (t.entryPrice * 0.005) / 100, 0)).toLocaleString()}円相当)`);
  console.log("");
  for (const t of slHunted.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))) {
    console.log(`  ${t.tradeDate} ${t.entryTime} ${t.symbol} ${t.symbolName} ${t.side.toUpperCase()} @${t.entryPrice} | MAE-${t.mae.toFixed(2)}% MFE+${t.mfe.toFixed(2)}% EOD${t.eodPnlPct >= 0 ? '+' : ''}${t.eodPnlPct.toFixed(2)}% | pnl=${t.pnl.toLocaleString()}`);
  }

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
