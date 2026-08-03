/**
 * sl_comparison_sim.ts
 * 現在の一律SL0.5% vs 銘柄別推奨SL幅のシミュレーション比較
 * 
 * rt_candles + rt_tradesの実データを使用し、各トレードのMAE/MFEから
 * 異なるSL設定での損益を再計算する
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sl_comparison_sim.ts
 */
import mysql from "mysql2/promise";
import { TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } from "../shared/stocks";

// 提案SL幅
const PROPOSED_SL: Record<string, number> = {
  "8316": 0.5,   // 三井住友FG: 据置
  "8035": 0.7,   // 東京エレクトロン
  "6857": 0.9,   // アドバンテスト
  "6526": 0.9,   // ソシオネクスト
  "6981": 0.9,   // 村田製作所
  "6976": 1.0,   // 太陽誘電
  "6920": 1.0,   // レーザーテック
  "5803": 0.9,   // フジクラ
  "285A": 1.5,   // キオクシアHD
  "6758": 0.7,   // ソニーG
};

const CURRENT_SL = 0.5;  // 現在の一律SL
const TP_PCT = 1.5;      // 利確幅（全銘柄共通）

interface TradeResult {
  symbol: string;
  symbolName: string;
  tradeDate: string;
  side: string;
  entryTime: string;
  entryPrice: number;
  shares: number;
  mfe: number;       // %
  mae: number;       // %
  actualPnl: number;
  actualExitReason: string;
  // Simulated results
  currentSlPnl: number;
  currentSlResult: string;
  proposedSlPnl: number;
  proposedSlResult: string;
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  const activeSymbols = TARGET_STOCKS
    .filter(s => !TRADE_EXCLUDED_SYMBOLS.has(s.symbol))
    .map(s => s.symbol);

  // 全rt_tradesを取得
  const [allTrades] = await conn.execute(
    `SELECT symbol, symbolName, tradeDate, tradeTime, action, side, price, pnl, reason, shares
     FROM rt_trades 
     WHERE symbol IN (${activeSymbols.map(() => "?").join(",")})
     ORDER BY tradeDate, tradeTime`,
    activeSymbols
  ) as any[];

  // ペアリング
  const pairs: any[] = [];
  const pendingEntries = new Map<string, any>();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === "buy" || t.action === "short") {
      pendingEntries.set(key, t);
    } else {
      const entry = pendingEntries.get(key);
      if (entry) {
        pairs.push({ entry, exit: t });
        pendingEntries.delete(key);
      }
    }
  }

  // 各トレードのMAE/MFEを計算し、SL別の結果をシミュレート
  const results: TradeResult[] = [];

  for (const { entry, exit } of pairs) {
    const entryPrice = parseFloat(entry.price);
    const exitPrice = parseFloat(exit.price);
    const pnl = Number(exit.pnl);
    const side = entry.side;
    const shares = Math.abs(pnl) / Math.abs(exitPrice - entryPrice) || 0;
    const exitReason = (exit.reason || "").includes("利確") ? "TP"
      : (exit.reason || "").includes("損切") ? "SL"
      : (exit.reason || "").includes("大引け") ? "EOD" : "OTHER";

    // キャンドルデータ取得
    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close
       FROM rt_candles 
       WHERE symbol = ? AND tradeDate = ?
       ORDER BY candleTime`,
      [entry.symbol, entry.tradeDate]
    ) as any[];

    if (candles.length === 0) continue;

    const entryIdx = candles.findIndex((c: any) => c.candleTime >= entry.tradeTime);
    if (entryIdx < 0) continue;
    const afterEntry = candles.slice(entryIdx);
    const eodCandle = candles[candles.length - 1];

    // MAE/MFE計算（バーごとに順番に確認し、SL/TPヒットをシミュレート）
    let mfe = 0, mae = 0;
    
    // SL/TPシミュレーション関数
    function simulateWithSL(slPct: number): { pnl: number; result: string } {
      for (const c of afterEntry) {
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        
        if (side === "long") {
          // SLチェック（安値がSLラインを割る）
          const slPrice = entryPrice * (1 - slPct / 100);
          if (low <= slPrice) {
            return { pnl: -entryPrice * slPct / 100 * shares, result: "SL" };
          }
          // TPチェック（高値がTPラインを超える）
          const tpPrice = entryPrice * (1 + TP_PCT / 100);
          if (high >= tpPrice) {
            return { pnl: entryPrice * TP_PCT / 100 * shares, result: "TP" };
          }
        } else {
          // SHORT
          const slPrice = entryPrice * (1 + slPct / 100);
          if (high >= slPrice) {
            return { pnl: -entryPrice * slPct / 100 * shares, result: "SL" };
          }
          const tpPrice = entryPrice * (1 - TP_PCT / 100);
          if (low <= tpPrice) {
            return { pnl: entryPrice * TP_PCT / 100 * shares, result: "TP" };
          }
        }
      }
      // EOD決済
      const eodClose = parseFloat(eodCandle.close);
      const eodPnl = side === "long"
        ? (eodClose - entryPrice) * shares
        : (entryPrice - eodClose) * shares;
      return { pnl: eodPnl, result: "EOD" };
    }

    // MAE/MFE（全体）
    for (const c of afterEntry) {
      const high = parseFloat(c.high);
      const low = parseFloat(c.low);
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
    }

    const currentResult = simulateWithSL(CURRENT_SL);
    const proposedSL = PROPOSED_SL[entry.symbol] || CURRENT_SL;
    const proposedResult = simulateWithSL(proposedSL);

    results.push({
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      tradeDate: entry.tradeDate,
      side,
      entryTime: entry.tradeTime,
      entryPrice,
      shares,
      mfe, mae,
      actualPnl: pnl,
      actualExitReason: exitReason,
      currentSlPnl: currentResult.pnl,
      currentSlResult: currentResult.result,
      proposedSlPnl: proposedResult.pnl,
      proposedSlResult: proposedResult.result,
    });
  }

  console.log(`シミュレーション完了: ${results.length}件\n`);

  // ============================================================
  // 全体比較
  // ============================================================
  console.log("=".repeat(100));
  console.log("全体比較: 現在SL0.5% vs 銘柄別推奨SL");
  console.log("=".repeat(100));

  const totalCurrent = results.reduce((s, t) => s + t.currentSlPnl, 0);
  const totalProposed = results.reduce((s, t) => s + t.proposedSlPnl, 0);
  const totalActual = results.reduce((s, t) => s + t.actualPnl, 0);

  const currentWins = results.filter(t => t.currentSlPnl > 0).length;
  const proposedWins = results.filter(t => t.proposedSlPnl > 0).length;
  const currentTP = results.filter(t => t.currentSlResult === "TP").length;
  const proposedTP = results.filter(t => t.proposedSlResult === "TP").length;
  const currentSL = results.filter(t => t.currentSlResult === "SL").length;
  const proposedSL2 = results.filter(t => t.proposedSlResult === "SL").length;

  console.log(`\n  実績（rt_trades）:   ${totalActual >= 0 ? '+' : ''}${Math.round(totalActual).toLocaleString()}円`);
  console.log(`  現在SL0.5%シム:     ${totalCurrent >= 0 ? '+' : ''}${Math.round(totalCurrent).toLocaleString()}円 (${currentWins}勝${results.length - currentWins}敗, TP:${currentTP} SL:${currentSL})`);
  console.log(`  銘柄別推奨SLシム:   ${totalProposed >= 0 ? '+' : ''}${Math.round(totalProposed).toLocaleString()}円 (${proposedWins}勝${results.length - proposedWins}敗, TP:${proposedTP} SL:${proposedSL2})`);
  console.log(`  差分:               ${totalProposed - totalCurrent >= 0 ? '+' : ''}${Math.round(totalProposed - totalCurrent).toLocaleString()}円`);

  // ============================================================
  // 銘柄別比較
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("銘柄別比較");
  console.log("=".repeat(100));

  console.log("\n" + 
    "銘柄".padEnd(6) + "名前".padEnd(12) + "件数".padStart(5) +
    "現SL".padStart(6) + "提案SL".padStart(7) +
    "現在損益".padStart(12) + "提案損益".padStart(12) + "差分".padStart(12) +
    "現在勝率".padStart(9) + "提案勝率".padStart(9) +
    "現TP".padStart(5) + "現SL".padStart(5) + "提TP".padStart(5) + "提SL".padStart(5)
  );
  console.log("-".repeat(120));

  for (const sym of activeSymbols) {
    const symTrades = results.filter(r => r.symbol === sym);
    if (symTrades.length === 0) continue;
    const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name || sym;
    
    const curPnl = symTrades.reduce((s, t) => s + t.currentSlPnl, 0);
    const proPnl = symTrades.reduce((s, t) => s + t.proposedSlPnl, 0);
    const diff = proPnl - curPnl;
    const curWins = symTrades.filter(t => t.currentSlPnl > 0).length;
    const proWins = symTrades.filter(t => t.proposedSlPnl > 0).length;
    const curTPCount = symTrades.filter(t => t.currentSlResult === "TP").length;
    const curSLCount = symTrades.filter(t => t.currentSlResult === "SL").length;
    const proTPCount = symTrades.filter(t => t.proposedSlResult === "TP").length;
    const proSLCount = symTrades.filter(t => t.proposedSlResult === "SL").length;

    console.log(
      sym.padEnd(6) + name.substring(0, 6).padEnd(12) + `${symTrades.length}`.padStart(5) +
      `${CURRENT_SL}%`.padStart(6) + `${PROPOSED_SL[sym] || CURRENT_SL}%`.padStart(7) +
      `${curPnl >= 0 ? '+' : ''}${Math.round(curPnl).toLocaleString()}`.padStart(12) +
      `${proPnl >= 0 ? '+' : ''}${Math.round(proPnl).toLocaleString()}`.padStart(12) +
      `${diff >= 0 ? '+' : ''}${Math.round(diff).toLocaleString()}`.padStart(12) +
      `${(curWins / symTrades.length * 100).toFixed(0)}%`.padStart(9) +
      `${(proWins / symTrades.length * 100).toFixed(0)}%`.padStart(9) +
      `${curTPCount}`.padStart(5) + `${curSLCount}`.padStart(5) +
      `${proTPCount}`.padStart(5) + `${proSLCount}`.padStart(5)
    );
  }

  // ============================================================
  // 銘柄別 詳細（結果が変わったトレード）
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("結果が変わったトレード一覧（銘柄別）");
  console.log("=".repeat(100));

  for (const sym of activeSymbols) {
    const symTrades = results.filter(r => r.symbol === sym);
    const changed = symTrades.filter(t => t.currentSlResult !== t.proposedSlResult);
    if (changed.length === 0) continue;
    
    const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name || sym;
    const proposedSLVal = PROPOSED_SL[sym] || CURRENT_SL;
    console.log(`\n  ${sym} ${name} (SL: ${CURRENT_SL}% → ${proposedSLVal}%) - ${changed.length}件変化`);
    
    for (const t of changed.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))) {
      const curStr = `${t.currentSlResult}(${t.currentSlPnl >= 0 ? '+' : ''}${Math.round(t.currentSlPnl).toLocaleString()})`;
      const proStr = `${t.proposedSlResult}(${t.proposedSlPnl >= 0 ? '+' : ''}${Math.round(t.proposedSlPnl).toLocaleString()})`;
      const improvement = t.proposedSlPnl - t.currentSlPnl;
      console.log(`    ${t.tradeDate} ${t.entryTime} ${t.side.toUpperCase()} @${t.entryPrice} | MAE-${t.mae.toFixed(2)}% MFE+${t.mfe.toFixed(2)}% | 現在:${curStr} → 提案:${proStr} | ${improvement >= 0 ? '+' : ''}${Math.round(improvement).toLocaleString()}`);
    }
  }

  // ============================================================
  // リスク分析: SL拡大による最大損失増加
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("リスク分析: SL拡大による1トレードあたり最大損失");
  console.log("=".repeat(100));

  for (const sym of activeSymbols) {
    const symTrades = results.filter(r => r.symbol === sym);
    if (symTrades.length === 0) continue;
    const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name || sym;
    const proposedSLVal = PROPOSED_SL[sym] || CURRENT_SL;
    
    // 代表的なshares数
    const avgShares = symTrades.reduce((s, t) => s + t.shares, 0) / symTrades.length;
    const avgPrice = symTrades.reduce((s, t) => s + t.entryPrice, 0) / symTrades.length;
    const currentMaxLoss = avgPrice * CURRENT_SL / 100 * avgShares;
    const proposedMaxLoss = avgPrice * proposedSLVal / 100 * avgShares;

    console.log(`  ${sym} ${name}: SL${CURRENT_SL}%→${proposedSLVal}% | 最大損失 ${Math.round(currentMaxLoss).toLocaleString()}円→${Math.round(proposedMaxLoss).toLocaleString()}円 (${((proposedMaxLoss / currentMaxLoss - 1) * 100).toFixed(0)}%増)`);
  }

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
