/**
 * sl_daily_comparison.ts
 * 現在SL0.5% vs 銘柄別推奨SLの日別比較 + リスクリワード比分析
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sl_daily_comparison.ts
 */
import mysql from "mysql2/promise";
import { TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } from "../shared/stocks";

const PROPOSED_SL: Record<string, number> = {
  "8316": 0.5,
  "8035": 0.7,
  "6857": 0.9,
  "6526": 0.9,
  "6981": 0.9,
  "6976": 1.0,
  "6920": 1.0,
  "5803": 0.7,  // フジクラは0.7に修正
  "285A": 1.5,
  "6758": 0.5,  // ソニーGは据置
};

const CURRENT_SL = 0.5;
const TP_PCT = 1.5;

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
  interface TradePair {
    symbol: string;
    symbolName: string;
    tradeDate: string;
    side: string;
    entryTime: string;
    entryPrice: number;
    exitPrice: number;
    actualPnl: number;
    exitReason: string;
  }
  const pairs: TradePair[] = [];
  const pendingEntries = new Map<string, any>();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === "buy" || t.action === "short") {
      pendingEntries.set(key, t);
    } else {
      const entry = pendingEntries.get(key);
      if (entry) {
        pairs.push({
          symbol: entry.symbol,
          symbolName: entry.symbolName,
          tradeDate: entry.tradeDate,
          side: entry.side,
          entryTime: entry.tradeTime,
          entryPrice: parseFloat(entry.price),
          exitPrice: parseFloat(t.price),
          actualPnl: Number(t.pnl),
          exitReason: (t.reason || ""),
        });
        pendingEntries.delete(key);
      }
    }
  }

  // 各トレードのSL別シミュレーション
  interface SimResult {
    symbol: string;
    tradeDate: string;
    side: string;
    entryPrice: number;
    shares: number;
    currentSlPnl: number;
    currentSlResult: string;
    proposedSlPnl: number;
    proposedSlResult: string;
    actualPnl: number;
  }

  const results: SimResult[] = [];

  for (const pair of pairs) {
    const shares = pair.actualPnl !== 0 ? Math.abs(pair.actualPnl) / Math.abs(pair.exitPrice - pair.entryPrice) : 0;
    if (shares === 0) continue;

    // キャンドルデータ取得
    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close
       FROM rt_candles 
       WHERE symbol = ? AND tradeDate = ?
       ORDER BY candleTime`,
      [pair.symbol, pair.tradeDate]
    ) as any[];

    if (candles.length === 0) continue;

    const entryIdx = candles.findIndex((c: any) => c.candleTime >= pair.entryTime);
    if (entryIdx < 0) continue;
    const afterEntry = candles.slice(entryIdx);
    const eodCandle = candles[candles.length - 1];

    function simulateWithSL(slPct: number): { pnl: number; result: string } {
      for (const c of afterEntry) {
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        
        if (pair.side === "long") {
          const slPrice = pair.entryPrice * (1 - slPct / 100);
          if (low <= slPrice) return { pnl: -pair.entryPrice * slPct / 100 * shares, result: "SL" };
          const tpPrice = pair.entryPrice * (1 + TP_PCT / 100);
          if (high >= tpPrice) return { pnl: pair.entryPrice * TP_PCT / 100 * shares, result: "TP" };
        } else {
          const slPrice = pair.entryPrice * (1 + slPct / 100);
          if (high >= slPrice) return { pnl: -pair.entryPrice * slPct / 100 * shares, result: "SL" };
          const tpPrice = pair.entryPrice * (1 - TP_PCT / 100);
          if (low <= tpPrice) return { pnl: pair.entryPrice * TP_PCT / 100 * shares, result: "TP" };
        }
      }
      const eodClose = parseFloat(eodCandle.close);
      const eodPnl = pair.side === "long"
        ? (eodClose - pair.entryPrice) * shares
        : (pair.entryPrice - eodClose) * shares;
      return { pnl: eodPnl, result: "EOD" };
    }

    const currentResult = simulateWithSL(CURRENT_SL);
    const proposedSL = PROPOSED_SL[pair.symbol] || CURRENT_SL;
    const proposedResult = simulateWithSL(proposedSL);

    results.push({
      symbol: pair.symbol,
      tradeDate: pair.tradeDate,
      side: pair.side,
      entryPrice: pair.entryPrice,
      shares,
      currentSlPnl: currentResult.pnl,
      currentSlResult: currentResult.result,
      proposedSlPnl: proposedResult.pnl,
      proposedSlResult: proposedResult.result,
      actualPnl: pair.actualPnl,
    });
  }

  // ============================================================
  // ① リスクリワード比分析
  // ============================================================
  console.log("=".repeat(100));
  console.log("① リスクリワード比 分析");
  console.log("=".repeat(100));

  // 現在SL
  const curWins = results.filter(r => r.currentSlPnl > 0);
  const curLosses = results.filter(r => r.currentSlPnl <= 0);
  const curAvgWin = curWins.length > 0 ? curWins.reduce((s, r) => s + r.currentSlPnl, 0) / curWins.length : 0;
  const curAvgLoss = curLosses.length > 0 ? Math.abs(curLosses.reduce((s, r) => s + r.currentSlPnl, 0) / curLosses.length) : 1;
  const curRR = curAvgWin / curAvgLoss;
  const curWinRate = curWins.length / results.length;
  const curExpectancy = curAvgWin * curWinRate - curAvgLoss * (1 - curWinRate);

  // 提案SL
  const proWins = results.filter(r => r.proposedSlPnl > 0);
  const proLosses = results.filter(r => r.proposedSlPnl <= 0);
  const proAvgWin = proWins.length > 0 ? proWins.reduce((s, r) => s + r.proposedSlPnl, 0) / proWins.length : 0;
  const proAvgLoss = proLosses.length > 0 ? Math.abs(proLosses.reduce((s, r) => s + r.proposedSlPnl, 0) / proLosses.length) : 1;
  const proRR = proAvgWin / proAvgLoss;
  const proWinRate = proWins.length / results.length;
  const proExpectancy = proAvgWin * proWinRate - proAvgLoss * (1 - proWinRate);

  console.log("\n--- 全体リスクリワード比較 ---\n");
  console.log("指標".padEnd(20) + "現在SL0.5%".padStart(15) + "銘柄別推奨SL".padStart(15) + "変化".padStart(12));
  console.log("-".repeat(65));
  console.log("勝率".padEnd(20) + `${(curWinRate * 100).toFixed(1)}%`.padStart(15) + `${(proWinRate * 100).toFixed(1)}%`.padStart(15) + `${((proWinRate - curWinRate) * 100).toFixed(1)}pt`.padStart(12));
  console.log("平均利益".padEnd(20) + `+${Math.round(curAvgWin).toLocaleString()}円`.padStart(15) + `+${Math.round(proAvgWin).toLocaleString()}円`.padStart(15) + `${Math.round(proAvgWin - curAvgWin).toLocaleString()}円`.padStart(12));
  console.log("平均損失".padEnd(20) + `-${Math.round(curAvgLoss).toLocaleString()}円`.padStart(15) + `-${Math.round(proAvgLoss).toLocaleString()}円`.padStart(15) + `${Math.round(proAvgLoss - curAvgLoss).toLocaleString()}円`.padStart(12));
  console.log("RR比".padEnd(20) + `${curRR.toFixed(2)}`.padStart(15) + `${proRR.toFixed(2)}`.padStart(15) + `${(proRR - curRR).toFixed(2)}`.padStart(12));
  console.log("期待値/トレード".padEnd(20) + `${curExpectancy >= 0 ? '+' : ''}${Math.round(curExpectancy).toLocaleString()}円`.padStart(15) + `${proExpectancy >= 0 ? '+' : ''}${Math.round(proExpectancy).toLocaleString()}円`.padStart(15) + `${Math.round(proExpectancy - curExpectancy).toLocaleString()}円`.padStart(12));
  console.log("PF".padEnd(20) + `${(curWins.reduce((s, r) => s + r.currentSlPnl, 0) / Math.abs(curLosses.reduce((s, r) => s + r.currentSlPnl, 0))).toFixed(2)}`.padStart(15) + `${(proWins.reduce((s, r) => s + r.proposedSlPnl, 0) / Math.abs(proLosses.reduce((s, r) => s + r.proposedSlPnl, 0))).toFixed(2)}`.padStart(15));

  // 銘柄別RR比
  console.log("\n\n--- 銘柄別リスクリワード比 ---\n");
  console.log(
    "銘柄".padEnd(6) + "SL".padStart(5) +
    "現RR".padStart(7) + "提RR".padStart(7) +
    "現勝率".padStart(8) + "提勝率".padStart(8) +
    "現平均利益".padStart(12) + "現平均損失".padStart(12) +
    "提平均利益".padStart(12) + "提平均損失".padStart(12) +
    "現期待値".padStart(10) + "提期待値".padStart(10)
  );
  console.log("-".repeat(120));

  for (const sym of activeSymbols) {
    const symResults = results.filter(r => r.symbol === sym);
    if (symResults.length < 2) continue;
    
    const sCurWins = symResults.filter(r => r.currentSlPnl > 0);
    const sCurLosses = symResults.filter(r => r.currentSlPnl <= 0);
    const sProWins = symResults.filter(r => r.proposedSlPnl > 0);
    const sProLosses = symResults.filter(r => r.proposedSlPnl <= 0);
    
    const sCurAvgWin = sCurWins.length > 0 ? sCurWins.reduce((s, r) => s + r.currentSlPnl, 0) / sCurWins.length : 0;
    const sCurAvgLoss = sCurLosses.length > 0 ? Math.abs(sCurLosses.reduce((s, r) => s + r.currentSlPnl, 0) / sCurLosses.length) : 1;
    const sProAvgWin = sProWins.length > 0 ? sProWins.reduce((s, r) => s + r.proposedSlPnl, 0) / sProWins.length : 0;
    const sProAvgLoss = sProLosses.length > 0 ? Math.abs(sProLosses.reduce((s, r) => s + r.proposedSlPnl, 0) / sProLosses.length) : 1;
    
    const sCurRR = sCurAvgWin / sCurAvgLoss;
    const sProRR = sProAvgWin / sProAvgLoss;
    const sCurWinRate = sCurWins.length / symResults.length;
    const sProWinRate = sProWins.length / symResults.length;
    const sCurExp = sCurAvgWin * sCurWinRate - sCurAvgLoss * (1 - sCurWinRate);
    const sProExp = sProAvgWin * sProWinRate - sProAvgLoss * (1 - sProWinRate);

    console.log(
      sym.padEnd(6) + `${PROPOSED_SL[sym] || 0.5}%`.padStart(5) +
      `${sCurRR.toFixed(2)}`.padStart(7) + `${sProRR.toFixed(2)}`.padStart(7) +
      `${(sCurWinRate * 100).toFixed(0)}%`.padStart(8) + `${(sProWinRate * 100).toFixed(0)}%`.padStart(8) +
      `+${Math.round(sCurAvgWin).toLocaleString()}`.padStart(12) + `-${Math.round(sCurAvgLoss).toLocaleString()}`.padStart(12) +
      `+${Math.round(sProAvgWin).toLocaleString()}`.padStart(12) + `-${Math.round(sProAvgLoss).toLocaleString()}`.padStart(12) +
      `${sCurExp >= 0 ? '+' : ''}${Math.round(sCurExp).toLocaleString()}`.padStart(10) + `${sProExp >= 0 ? '+' : ''}${Math.round(sProExp).toLocaleString()}`.padStart(10)
    );
  }

  // ============================================================
  // ② 日別比較
  // ============================================================
  console.log("\n\n" + "=".repeat(100));
  console.log("② 日別損益比較");
  console.log("=".repeat(100));

  // 日別集計
  const dates = [...new Set(results.map(r => r.tradeDate))].sort();
  
  console.log("\n" +
    "日付".padEnd(12) + "曜日".padEnd(4) +
    "件数".padStart(5) +
    "現在損益".padStart(12) + "提案損益".padStart(12) + "差分".padStart(12) +
    "現在勝敗".padStart(10) + "提案勝敗".padStart(10) +
    "実績損益".padStart(12)
  );
  console.log("-".repeat(100));

  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  let cumCurrent = 0, cumProposed = 0, cumActual = 0;
  let currentWinDays = 0, proposedWinDays = 0;

  for (const date of dates) {
    const dayResults = results.filter(r => r.tradeDate === date);
    const dayOfWeek = dayNames[new Date(date).getDay()];
    const dayCurPnl = dayResults.reduce((s, r) => s + r.currentSlPnl, 0);
    const dayProPnl = dayResults.reduce((s, r) => s + r.proposedSlPnl, 0);
    const dayActPnl = dayResults.reduce((s, r) => s + r.actualPnl, 0);
    const diff = dayProPnl - dayCurPnl;
    const curW = dayResults.filter(r => r.currentSlPnl > 0).length;
    const curL = dayResults.length - curW;
    const proW = dayResults.filter(r => r.proposedSlPnl > 0).length;
    const proL = dayResults.length - proW;

    cumCurrent += dayCurPnl;
    cumProposed += dayProPnl;
    cumActual += dayActPnl;
    if (dayCurPnl > 0) currentWinDays++;
    if (dayProPnl > 0) proposedWinDays++;

    console.log(
      date.padEnd(12) + dayOfWeek.padEnd(4) +
      `${dayResults.length}`.padStart(5) +
      `${dayCurPnl >= 0 ? '+' : ''}${Math.round(dayCurPnl).toLocaleString()}`.padStart(12) +
      `${dayProPnl >= 0 ? '+' : ''}${Math.round(dayProPnl).toLocaleString()}`.padStart(12) +
      `${diff >= 0 ? '+' : ''}${Math.round(diff).toLocaleString()}`.padStart(12) +
      `${curW}勝${curL}敗`.padStart(10) +
      `${proW}勝${proL}敗`.padStart(10) +
      `${dayActPnl >= 0 ? '+' : ''}${Math.round(dayActPnl).toLocaleString()}`.padStart(12)
    );
  }

  console.log("-".repeat(100));
  console.log(
    "累計".padEnd(12) + "".padEnd(4) +
    `${results.length}`.padStart(5) +
    `${cumCurrent >= 0 ? '+' : ''}${Math.round(cumCurrent).toLocaleString()}`.padStart(12) +
    `${cumProposed >= 0 ? '+' : ''}${Math.round(cumProposed).toLocaleString()}`.padStart(12) +
    `${cumProposed - cumCurrent >= 0 ? '+' : ''}${Math.round(cumProposed - cumCurrent).toLocaleString()}`.padStart(12) +
    "".padStart(10) + "".padStart(10) +
    `${cumActual >= 0 ? '+' : ''}${Math.round(cumActual).toLocaleString()}`.padStart(12)
  );

  console.log(`\n  日別勝率: 現在 ${currentWinDays}/${dates.length}日 (${(currentWinDays / dates.length * 100).toFixed(0)}%) | 提案 ${proposedWinDays}/${dates.length}日 (${(proposedWinDays / dates.length * 100).toFixed(0)}%)`);

  // 最大ドローダウン計算
  let curMaxDD = 0, proMaxDD = 0;
  let curPeak = 0, proPeak = 0;
  let curCum = 0, proCum = 0;
  for (const date of dates) {
    const dayResults = results.filter(r => r.tradeDate === date);
    curCum += dayResults.reduce((s, r) => s + r.currentSlPnl, 0);
    proCum += dayResults.reduce((s, r) => s + r.proposedSlPnl, 0);
    if (curCum > curPeak) curPeak = curCum;
    if (proCum > proPeak) proPeak = proCum;
    const curDD = curPeak - curCum;
    const proDD = proPeak - proCum;
    if (curDD > curMaxDD) curMaxDD = curDD;
    if (proDD > proMaxDD) proMaxDD = proDD;
  }
  console.log(`  最大DD: 現在 -${Math.round(curMaxDD).toLocaleString()}円 | 提案 -${Math.round(proMaxDD).toLocaleString()}円`);

  // 連敗分析
  let curMaxConsecLoss = 0, proMaxConsecLoss = 0;
  let curConsec = 0, proConsec = 0;
  for (const date of dates) {
    const dayResults = results.filter(r => r.tradeDate === date);
    const dayCurPnl = dayResults.reduce((s, r) => s + r.currentSlPnl, 0);
    const dayProPnl = dayResults.reduce((s, r) => s + r.proposedSlPnl, 0);
    if (dayCurPnl <= 0) { curConsec++; if (curConsec > curMaxConsecLoss) curMaxConsecLoss = curConsec; }
    else curConsec = 0;
    if (dayProPnl <= 0) { proConsec++; if (proConsec > proMaxConsecLoss) proMaxConsecLoss = proConsec; }
    else proConsec = 0;
  }
  console.log(`  最大連敗日数: 現在 ${curMaxConsecLoss}日 | 提案 ${proMaxConsecLoss}日`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
