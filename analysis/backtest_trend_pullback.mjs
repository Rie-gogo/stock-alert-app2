/**
 * Trend Pullback Entry (SHORT) バックテスト
 * 
 * 条件:
 * - Lower High Count >= 2（戻り高値切り下げ2回以上）
 * - Lower Low Count >= 2（安値更新2回以上）
 * - 下降トレンド継続中
 * - 現在は戻り局面（直近足がhigh更新方向）
 * - 戻り高値が前回戻り高値を超えない
 * - 戻りから陰線へ転換（前足が陽線/横ばい→今足が陰線）
 * 
 * エントリー: 陰線転換足のclose
 * TP: 1.5% (285Aは3%)
 * SL: 0.5% (285Aは1%)
 * 大引け強制決済: 15:20
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 全取引日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate ASC`
);
const days = dayRows.map(r => r.tradeDate);

// 監視銘柄リスト
const SYMBOLS = ["285A", "3436", "3778", "4568", "5016", "5803", "6526", "6723", "6758", "6857", "6920", "6976", "6981", "7011", "7203", "8035", "8306", "8316", "9107", "9984"];

// TP/SL設定
function getTPSL(symbol) {
  if (symbol === "285A") return { tp: 0.03, sl: 0.01 };
  return { tp: 0.015, sl: 0.005 };
}

// スイングポイント検出（5本足ベース）
function detectSwingPoints(candles) {
  const swings = [];
  const lookback = 2; // 前後2本で判定
  
  for (let i = lookback; i < candles.length - lookback; i++) {
    const curr = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;
    
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= curr.high || candles[i + j].high >= curr.high) {
        isSwingHigh = false;
      }
      if (candles[i - j].low <= curr.low || candles[i + j].low <= curr.low) {
        isSwingLow = false;
      }
    }
    
    if (isSwingHigh) swings.push({ type: "high", price: curr.high, index: i, time: curr.candleTime });
    if (isSwingLow) swings.push({ type: "low", price: curr.low, index: i, time: curr.candleTime });
  }
  
  return swings;
}

// Trend Pullback Entry検出
function detectTrendPullbackShort(candles, currentIdx) {
  if (currentIdx < 20) return null; // 最低20本必要
  
  // 直近の足までのスイングポイントを検出
  const slice = candles.slice(0, currentIdx + 1);
  const swings = detectSwingPoints(slice);
  
  if (swings.length < 4) return null;
  
  // 直近のスイングハイとスイングローを分離
  const highs = swings.filter(s => s.type === "high").slice(-5);
  const lows = swings.filter(s => s.type === "low").slice(-5);
  
  if (highs.length < 2 || lows.length < 2) return null;
  
  // Lower High Count (戻り高値切り下げ回数)
  let lhCount = 0;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price < highs[i - 1].price) lhCount++;
  }
  
  // Lower Low Count (安値更新回数)
  let llCount = 0;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price < lows[i - 1].price) llCount++;
  }
  
  if (lhCount < 2 || llCount < 2) return null;
  
  // 下降トレンド確認: 最新のスイングハイが前々回のスイングローより低い等
  const latestHigh = highs[highs.length - 1];
  const latestLow = lows[lows.length - 1];
  
  // 最新のスイングローの後に戻り局面があるか確認
  // 戻り局面 = スイングロー以降に価格が上昇している
  if (latestLow.index >= currentIdx - 2) return null; // ローが直近すぎる
  
  // 戻り局面の確認: latestLow以降の足でhighが上昇しているか
  let pullbackHigh = 0;
  for (let i = latestLow.index + 1; i <= currentIdx; i++) {
    if (candles[i].high > pullbackHigh) pullbackHigh = candles[i].high;
  }
  
  if (pullbackHigh <= latestLow.price) return null; // 戻りがない
  
  // 戻り高値が前回戻り高値を超えないか確認
  const prevHigh = highs[highs.length - 1]; // 直近の確定スイングハイ
  if (pullbackHigh >= prevHigh.price) return null; // 前回戻り高値を超えた → トレンド崩壊
  
  // 陰線転換: 前足が陽線/横ばい → 今足が陰線
  const currCandle = candles[currentIdx];
  const prevCandle = candles[currentIdx - 1];
  
  const isCurrBearish = currCandle.close < currCandle.open;
  const isPrevBullishOrFlat = prevCandle.close >= prevCandle.open;
  
  if (!isCurrBearish || !isPrevBullishOrFlat) return null;
  
  // 追加条件: 現在価格が直近スイングローより上にある（まだ下げ余地がある）
  if (currCandle.close <= latestLow.price) return null;
  
  return {
    lhCount,
    llCount,
    entryPrice: currCandle.close,
    entryTime: currCandle.candleTime,
    prevSwingHigh: prevHigh.price,
    pullbackHigh,
    latestLow: latestLow.price,
  };
}

// シミュレーション実行
const allTrades = [];
const NO_ENTRY_AFTER = "14:50"; // 14:50以降はエントリー禁止
const FORCE_EXIT_TIME = "15:20";

for (const day of days) {
  const [candleRows] = await conn.query(
    `SELECT symbol, candleTime, open, high, low, close, volume
     FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime ASC`,
    [day]
  );
  
  // 銘柄ごとに分類
  const bySymbol = new Map();
  for (const r of candleRows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push({
      candleTime: r.candleTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    });
  }
  
  for (const symbol of SYMBOLS) {
    const candles = bySymbol.get(symbol);
    if (!candles || candles.length < 30) continue;
    
    const { tp, sl } = getTPSL(symbol);
    let inPosition = false;
    let entryPrice = 0;
    let entryTime = "";
    let entryInfo = null;
    
    for (let i = 20; i < candles.length; i++) {
      const candle = candles[i];
      
      // ポジション管理
      if (inPosition) {
        // TP/SL判定（SHORTなので逆）
        const pnlPct = (entryPrice - candle.low) / entryPrice;
        const lossPct = (candle.high - entryPrice) / entryPrice;
        
        if (lossPct >= sl) {
          // SL
          const exitPrice = entryPrice * (1 + sl);
          const pnl = (entryPrice - exitPrice) * Math.floor(1000000 / entryPrice);
          allTrades.push({
            day, symbol, entryTime, entryPrice,
            exitTime: candle.candleTime, exitPrice,
            pnl, exitReason: "SL",
            holdBars: i - entryInfo.entryIdx,
            ...entryInfo,
          });
          inPosition = false;
          continue;
        }
        
        if (pnlPct >= tp) {
          // TP
          const exitPrice = entryPrice * (1 - tp);
          const pnl = (entryPrice - exitPrice) * Math.floor(1000000 / entryPrice);
          allTrades.push({
            day, symbol, entryTime, entryPrice,
            exitTime: candle.candleTime, exitPrice,
            pnl, exitReason: "TP",
            holdBars: i - entryInfo.entryIdx,
            ...entryInfo,
          });
          inPosition = false;
          continue;
        }
        
        // 大引け強制決済
        if (candle.candleTime >= FORCE_EXIT_TIME) {
          const exitPrice = candle.close;
          const pnl = (entryPrice - exitPrice) * Math.floor(1000000 / entryPrice);
          allTrades.push({
            day, symbol, entryTime, entryPrice,
            exitTime: candle.candleTime, exitPrice,
            pnl, exitReason: "EOD",
            holdBars: i - entryInfo.entryIdx,
            ...entryInfo,
          });
          inPosition = false;
          continue;
        }
        continue;
      }
      
      // エントリー判定（ポジションなし時のみ）
      if (candle.candleTime >= NO_ENTRY_AFTER) continue;
      if (candle.candleTime < "09:05") continue; // 寄付き直後は除外
      
      const signal = detectTrendPullbackShort(candles, i);
      if (signal) {
        inPosition = true;
        entryPrice = signal.entryPrice;
        entryTime = signal.entryTime;
        entryInfo = { ...signal, entryIdx: i };
      }
    }
    
    // 未決済ポジション（大引けで決済されなかった場合）
    if (inPosition && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const pnl = (entryPrice - lastCandle.close) * Math.floor(1000000 / entryPrice);
      allTrades.push({
        day, symbol, entryTime, entryPrice,
        exitTime: lastCandle.candleTime, exitPrice: lastCandle.close,
        pnl, exitReason: "EOD_FINAL",
        holdBars: candles.length - 1 - entryInfo.entryIdx,
        ...entryInfo,
      });
    }
  }
}

// 現行ロジックの取引を取得
const [currentTrades] = await conn.query(
  `SELECT t1.symbol, t1.tradeDate as day, t1.tradeTime as entryTime, t1.price as entryPrice,
          t2.tradeTime as exitTime, t2.price as exitPrice, t2.pnl, t2.reason as exitReason
   FROM rt_trades t1
   JOIN rt_trades t2 ON t1.symbol = t2.symbol AND t1.tradeDate = t2.tradeDate
     AND t1.side = 'short' AND t2.side = 'short'
     AND t1.action = 'short' AND t2.action = 'cover'
     AND t2.id > t1.id
   WHERE NOT EXISTS (
     SELECT 1 FROM rt_trades t3
     WHERE t3.symbol = t1.symbol AND t3.tradeDate = t1.tradeDate
       AND t3.side = 'short' AND t3.action = 'cover'
       AND t3.id > t1.id AND t3.id < t2.id
   )
   ORDER BY t1.tradeDate, t1.tradeTime`
);

// 結果集計
console.log("=".repeat(100));
console.log("【Trend Pullback Entry (SHORT) バックテスト結果】");
console.log("=".repeat(100));
console.log(`期間: ${days[0]} 〜 ${days[days.length - 1]} (${days.length}営業日)\n`);

// --- Trend Pullback ---
const tpTrades = allTrades;
const tpWins = tpTrades.filter(t => t.pnl > 0);
const tpLosses = tpTrades.filter(t => t.pnl <= 0);
const tpTotalPnl = tpTrades.reduce((s, t) => s + t.pnl, 0);
const tpGrossProfit = tpWins.reduce((s, t) => s + t.pnl, 0);
const tpGrossLoss = Math.abs(tpLosses.reduce((s, t) => s + t.pnl, 0));
const tpPF = tpGrossLoss > 0 ? tpGrossProfit / tpGrossLoss : Infinity;
const tpAvgHold = tpTrades.length > 0 ? tpTrades.reduce((s, t) => s + t.holdBars, 0) / tpTrades.length : 0;
const tpSLCount = tpTrades.filter(t => t.exitReason === "SL").length;

// 最大DD計算
let tpCumPnl = 0, tpMaxCum = 0, tpMaxDD = 0;
for (const t of tpTrades) {
  tpCumPnl += t.pnl;
  if (tpCumPnl > tpMaxCum) tpMaxCum = tpCumPnl;
  const dd = tpMaxCum - tpCumPnl;
  if (dd > tpMaxDD) tpMaxDD = dd;
}

// --- 現行ロジック ---
const currTrades = currentTrades.map(t => ({ ...t, pnl: Number(t.pnl) }));
const currWins = currTrades.filter(t => t.pnl > 0);
const currLosses = currTrades.filter(t => t.pnl <= 0);
const currTotalPnl = currTrades.reduce((s, t) => s + t.pnl, 0);
const currGrossProfit = currWins.reduce((s, t) => s + t.pnl, 0);
const currGrossLoss = Math.abs(currLosses.reduce((s, t) => s + t.pnl, 0));
const currPF = currGrossLoss > 0 ? currGrossProfit / currGrossLoss : Infinity;

let currCumPnl = 0, currMaxCum = 0, currMaxDD = 0;
for (const t of currTrades) {
  currCumPnl += t.pnl;
  if (currCumPnl > currMaxCum) currMaxCum = currCumPnl;
  const dd = currMaxCum - currCumPnl;
  if (dd > currMaxDD) currMaxDD = dd;
}
const currSLCount = currTrades.filter(t => t.exitReason && t.exitReason.includes("損切")).length;

// 初動を捉えた回数の推定
// Trend Pullback: エントリー後にTP到達 = 初動を捉えた
const tpCaughtEarly = tpTrades.filter(t => t.exitReason === "TP").length;
// 現行: TP到達
const currCaughtEarly = currTrades.filter(t => t.exitReason && t.exitReason.includes("利確")).length;

console.log("┌─────────────────────────────────────────────────────────────────┐");
console.log("│                    比較サマリー                                  │");
console.log("├─────────────────────┬──────────────────┬──────────────────────────┤");
console.log(`│ 指標                │ Trend Pullback   │ 現行ロジック(SHORT)      │`);
console.log("├─────────────────────┼──────────────────┼──────────────────────────┤");
console.log(`│ 取引回数            │ ${String(tpTrades.length).padStart(8)}件     │ ${String(currTrades.length).padStart(8)}件              │`);
console.log(`│ 勝率                │ ${((tpWins.length/Math.max(tpTrades.length,1))*100).toFixed(1).padStart(7)}%     │ ${((currWins.length/Math.max(currTrades.length,1))*100).toFixed(1).padStart(7)}%              │`);
console.log(`│ 総損益              │ ${(tpTotalPnl >= 0 ? "+" : "") + tpTotalPnl.toLocaleString().padStart(10)}円 │ ${(currTotalPnl >= 0 ? "+" : "") + currTotalPnl.toLocaleString().padStart(10)}円          │`);
console.log(`│ PF                  │ ${tpPF.toFixed(2).padStart(8)}      │ ${currPF.toFixed(2).padStart(8)}              │`);
console.log(`│ 最大DD              │ ${tpMaxDD.toLocaleString().padStart(10)}円 │ ${currMaxDD.toLocaleString().padStart(10)}円          │`);
console.log(`│ 平均保有時間(分足数)│ ${tpAvgHold.toFixed(1).padStart(8)}本     │ -                        │`);
console.log(`│ 初動捉え(TP到達)    │ ${String(tpCaughtEarly).padStart(8)}件     │ ${String(currCaughtEarly).padStart(8)}件              │`);
console.log(`│ 損切り率            │ ${((tpSLCount/Math.max(tpTrades.length,1))*100).toFixed(1).padStart(7)}%     │ ${((currSLCount/Math.max(currTrades.length,1))*100).toFixed(1).padStart(7)}%              │`);
console.log("└─────────────────────┴──────────────────┴──────────────────────────┘");

// 日別詳細
console.log("\n--- 日別損益 ---");
console.log("日付        | TP件数 | TP損益      | 全件数 | 全損益");
console.log("-".repeat(70));
for (const day of days) {
  const dayTrades = tpTrades.filter(t => t.day === day);
  if (dayTrades.length === 0) continue;
  const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
  const dayTP = dayTrades.filter(t => t.exitReason === "TP");
  const dayTPPnl = dayTP.reduce((s, t) => s + t.pnl, 0);
  console.log(`${day} | ${String(dayTP.length).padStart(4)}件 | ${(dayTPPnl >= 0 ? "+" : "") + dayTPPnl.toLocaleString().padStart(9)}円 | ${String(dayTrades.length).padStart(4)}件 | ${(dayPnl >= 0 ? "+" : "") + dayPnl.toLocaleString().padStart(9)}円`);
}

// 銘柄別
console.log("\n--- 銘柄別損益 ---");
console.log("銘柄  | 件数 | 勝率  | PnL");
console.log("-".repeat(50));
for (const sym of SYMBOLS) {
  const symTrades = tpTrades.filter(t => t.symbol === sym);
  if (symTrades.length === 0) continue;
  const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
  const symWins = symTrades.filter(t => t.pnl > 0);
  console.log(`${sym.padEnd(6)}| ${String(symTrades.length).padStart(4)}件 | ${((symWins.length/symTrades.length)*100).toFixed(0).padStart(3)}% | ${(symPnl >= 0 ? "+" : "") + symPnl.toLocaleString().padStart(9)}円`);
}

// 決済理由別
console.log("\n--- 決済理由別 ---");
const reasons = ["TP", "SL", "EOD", "EOD_FINAL"];
for (const r of reasons) {
  const rTrades = tpTrades.filter(t => t.exitReason === r);
  if (rTrades.length === 0) continue;
  const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`${r.padEnd(10)}: ${String(rTrades.length).padStart(4)}件 | ${(rPnl >= 0 ? "+" : "") + rPnl.toLocaleString().padStart(9)}円`);
}

// 村田製作所(6981)の詳細
console.log("\n--- 村田製作所(6981) 詳細 ---");
const murataTrades = tpTrades.filter(t => t.symbol === "6981");
for (const t of murataTrades) {
  console.log(`  ${t.day} ${t.entryTime} SHORT @${t.entryPrice.toFixed(0)} → ${t.exitTime} @${t.exitPrice.toFixed(0)} (${t.exitReason}) PnL:${(t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString()}円 LH:${t.lhCount} LL:${t.llCount}`);
}

await conn.end();
