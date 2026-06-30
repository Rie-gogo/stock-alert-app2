/**
 * BUYシグナル取り逃し原因調査スクリプト
 * 実施内容1〜4を一括で実行
 * 
 * 対象日: 2026-06-30
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import { evaluateConfirmation } from "../server/signalConfirmation";
import { getStockName } from "../shared/stocks";

// ============================================================
// 設定
// ============================================================
const TARGET_DATE = "2026-06-30";
const ANALYSIS_SYMBOLS = ["6976", "5803", "6920", "6526", "9984", "6857", "6981"];
const SYMBOL_NAMES: Record<string, string> = {
  "6976": "太陽誘電",
  "5803": "フジクラ",
  "6920": "レーザーテック",
  "6526": "ソシオネクスト",
  "9984": "ソフトバンクG",
  "6857": "アドバンテスト",
  "6981": "村田製作所",
};

// エンジンパラメータ（本番と同じ）
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const BE_TRIGGER_PERCENT = 0.5;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:15";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
const BOARD_SCORE_THRESHOLD = 1;
const ATR_FILTER_THRESHOLD = 0.002;
const ATR_FILTER_PERIOD = 14;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;

// ============================================================
// 型定義
// ============================================================
interface BlockedBuySignal {
  timestamp: string;
  symbol: string;
  symbolName: string;
  signalType: string;
  confidence: string;
  price: number;
  boardSignal: string;
  boardScore: number;
  bpr: number;
  regime: string;
  ma5: number | null;
  ma25: number | null;
  vwap: number | null;
  volumeRatio: number;
  blockedReason: string;
  blockedFilterName: string;
}

interface GhostTrade {
  timestamp: string;
  symbol: string;
  symbolName: string;
  signalType: string;
  confidence: string;
  blockedReason: string;
  virtualEntryPrice: number;
  virtualExitPrice: number;
  virtualExitReason: string;
  virtualExitTime: string;
  virtualPnL: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  wouldHitTP: boolean;
  wouldHitSL: boolean;
  wouldTriggerBE: boolean;
}

// ============================================================
// ユーティリティ
// ============================================================
function boardReadingScoreSimple(boardSnapshot: any, side: "long" | "short"): number {
  if (!boardSnapshot) return 0;
  let score = 0;
  const bpr = boardSnapshot.buyPressureRatio ?? 0.5;
  const signal = boardSnapshot.signal ?? "neutral";
  const mor = boardSnapshot.marketOrderRatio ?? 0;
  
  // Element A: BPR
  if (side === "long") {
    if (bpr >= 0.6) score += 1;
    else if (bpr <= 0.4) score -= 1;
  } else {
    if (bpr <= 0.4) score += 1;
    else if (bpr >= 0.6) score -= 1;
  }
  
  // Element B: Board signal
  if (side === "long" && signal === "buy_pressure") score += 1;
  if (side === "long" && signal === "sell_pressure") score -= 1;
  if (side === "short" && signal === "sell_pressure") score += 1;
  if (side === "short" && signal === "buy_pressure") score -= 1;
  
  // Element C: Market order ratio
  if (mor >= 0.15) score += 1;
  
  return score;
}

// ============================================================
// メイン処理
// ============================================================
async function main() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`BUYシグナル取り逃し原因調査: ${TARGET_DATE}`);
  console.log(`${"=".repeat(80)}\n`);

  // 全シンボルのデータ取得
  const db = await getDb();
  const allCandles = await db.select().from(rtCandles)
    .where(and(
      eq(rtCandles.tradeDate, TARGET_DATE),
      inArray(rtCandles.symbol, ANALYSIS_SYMBOLS)
    ));

  console.log(`取得データ: ${allCandles.length}本 (${ANALYSIS_SYMBOLS.length}銘柄)`);

  // 銘柄別に整理
  const candlesBySymbol = new Map<string, any[]>();
  for (const c of allCandles) {
    const arr = candlesBySymbol.get(c.symbol) || [];
    arr.push(c);
    candlesBySymbol.set(c.symbol, arr);
  }
  for (const [sym, arr] of candlesBySymbol) {
    arr.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));
  }

  // 板データ取得（boardSnapshotはrtCandlesのJSONカラムに格納されている）
  const boardsBySymbol = new Map<string, Map<string, any>>();
  for (const c of allCandles) {
    const bs = (c as any).boardSnapshot;
    if (bs) {
      const map = boardsBySymbol.get(c.symbol) || new Map();
      map.set(c.candleTime, typeof bs === 'string' ? JSON.parse(bs) : bs);
      boardsBySymbol.set(c.symbol, map);
    }
  }

  // ============================================================
  // 実施1 & 2: BUYシグナル検出 + ブロック理由分析 + Ghost Trade
  // ============================================================
  const allBlockedBuys: BlockedBuySignal[] = [];
  const allGhostTrades: GhostTrade[] = [];
  const allBlockedSells: BlockedBuySignal[] = [];
  let totalBuySignals = 0;
  let totalBuyStrong = 0;
  let totalBuyMedium = 0;
  let totalBuyEntries = 0;
  let totalSellSignals = 0;
  let totalSellStrong = 0;
  let totalSellEntries = 0;

  const blockReasonCounts: Record<string, number> = {};
  const sellBlockReasonCounts: Record<string, number> = {};

  // 銘柄別集計
  const symbolStats: Record<string, {
    buyGenerated: number;
    buyStrong: number;
    buyEntries: number;
    buyBlocked: number;
    blockReasons: Record<string, number>;
    ghostTrades: GhostTrade[];
    sellPressureUpCount: number;
    sellPressureLongProfit: number;
  }> = {};

  for (const symbol of ANALYSIS_SYMBOLS) {
    const candles = candlesBySymbol.get(symbol) || [];
    const boards = boardsBySymbol.get(symbol) || new Map();
    
    symbolStats[symbol] = {
      buyGenerated: 0,
      buyStrong: 0,
      buyEntries: 0,
      buyBlocked: 0,
      blockReasons: {},
      ghostTrades: [],
      sellPressureUpCount: 0,
      sellPressureLongProfit: 0,
    };

    if (candles.length < 30) continue;

    // インジケーター計算
    const closes = candles.map((c: any) => Number(c.close));
    const highs = candles.map((c: any) => Number(c.high));
    const lows = candles.map((c: any) => Number(c.low));
    const volumes = candles.map((c: any) => Number(c.volume));
    const bb = calcBollinger(closes, 20, 2);
    const vwapCandles = candles.map((c: any) => ({
      open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: Number(c.volume),
    }));
    const vwapArr = calcVWAP(vwapCandles);
    const atrArr = calcATR(highs, lows, closes, ATR_FILTER_PERIOD);

    // バッファ構築（detectSignals用）
    const buffer = candles.map((c: any, i: number) => ({
      symbol: c.symbol,
      tradeDate: c.tradeDate,
      candleTime: c.candleTime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
      bbUpper: bb.upper[i] ?? null,
      bbLower: bb.lower[i] ?? null,
      bbMiddle: bb.middle[i] ?? null,
      vwap: vwapArr[i] ?? null,
    }));

    // detectSignals実行
    const withSignals = detectSignals(buffer);
    
    // 既存ポジション追跡（シミュレーション用）
    let hasPosition = false;
    let positionSide: "long" | "short" | null = null;
    
    // 各足でBUYシグナルを分析
    for (let i = 30; i < withSignals.length; i++) {
      const c = withSignals[i];
      const candleTime = c.candleTime;
      const sig = c.signal;
      if (!sig) continue;

      const boardData = boards.get(candleTime);
      const boardSignal = boardData?.signal ?? "no_data";
      const bpr = boardData?.buyPressureRatio ?? 0.5;
      const mor = boardData?.marketOrderRatio ?? 0;

      // 地合い判定
      const openPrice = buffer[0]?.open ?? c.close;
      const priceChangeRatio = (c.close - openPrice) / openPrice * 100;
      const regime = priceChangeRatio >= 0.2 ? "BULLISH" : priceChangeRatio <= -0.2 ? "BEARISH" : "NEUTRAL";

      // ATR計算
      const atrVal = atrArr[i] ?? null;
      const atrRatio = atrVal && c.close > 0 ? atrVal / c.close : null;

      // 出来高比率
      const avgVol10 = i >= 10 ? volumes.slice(i - 10, i).reduce((a: number, b: number) => a + b, 0) / 10 : volumes[i];
      const volumeRatio = avgVol10 > 0 ? volumes[i] / avgVol10 : 1;

      if (sig.type === "buy") {
        totalBuySignals++;
        symbolStats[symbol].buyGenerated++;
        
        if (sig.confidence === "strong") {
          totalBuyStrong++;
          symbolStats[symbol].buyStrong++;
        } else {
          totalBuyMedium++;
        }

        // フィルター判定（本番ロジックを再現）
        let blockedReason = "";
        let blockedFilterName = "";

        // 1. 時間帯フィルター
        if (candleTime < NO_ENTRY_BEFORE) {
          blockedReason = "time_filter";
          blockedFilterName = "09:30以前エントリー禁止";
        } else if (candleTime >= NO_ENTRY_AFTER) {
          blockedReason = "time_filter";
          blockedFilterName = "15:15以降エントリー禁止";
        } else if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) {
          blockedReason = "time_filter";
          blockedFilterName = "11:00-11:30エントリー禁止";
        } else if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) {
          blockedReason = "time_filter";
          blockedFilterName = "12:30-13:00エントリー禁止";
        }
        // 2. 既にポジションあり
        else if (hasPosition) {
          blockedReason = "already_position";
          blockedFilterName = "既にポジション保有中";
        }
        // 3. VWAPクロス上抜け無効化
        else if (sig.reason.includes("VWAPクロス上抜け")) {
          blockedReason = "vwap_up_disabled";
          blockedFilterName = "VWAPクロス上抜けシグナル無効化";
        }
        // 4. sell_pressure時LONG禁止
        else if (boardSignal === "sell_pressure") {
          blockedReason = "sell_pressure_block";
          blockedFilterName = "sell_pressure時LONG禁止";
        }
        // 5. 板読みスコア不足
        else if (boardReadingScoreSimple(boardData, "long") < BOARD_SCORE_THRESHOLD) {
          blockedReason = "board_score_low";
          blockedFilterName = `板読みスコア不足(${boardReadingScoreSimple(boardData, "long")}<${BOARD_SCORE_THRESHOLD})`;
        }
        // 6. ダウ理論 → ステートマシン待機
        else if (sig.reason.startsWith("ダウ理論: 直近高値更新")) {
          // 5分足フィルター
          const htfOk = checkHTFTrend(buffer, i);
          if (!htfOk) {
            blockedReason = "htf_filter";
            blockedFilterName = "5分足上位足フィルター(上昇トレンドなし)";
          } else {
            // 押し目深さフィルター
            if (i >= PULLBACK_DEPTH_LOOKBACK) {
              const window = buffer.slice(i - PULLBACK_DEPTH_LOOKBACK, i);
              const swH = Math.max(...window.map((w: any) => w.high));
              const swL = Math.min(...window.map((w: any) => w.low));
              if (swH > swL) {
                const depth = (swH - c.close) / (swH - swL);
                if (depth < PULLBACK_DEPTH_MIN || depth > PULLBACK_DEPTH_MAX) {
                  blockedReason = "pullback_depth_filter";
                  blockedFilterName = `押し目深さフィルター(${(depth*100).toFixed(1)}%)`;
                } else {
                  blockedReason = "state_machine_waiting";
                  blockedFilterName = "ダウ理論→押し目確認待機";
                }
              } else {
                blockedReason = "state_machine_waiting";
                blockedFilterName = "ダウ理論→押し目確認待機";
              }
            } else {
              blockedReason = "state_machine_waiting";
              blockedFilterName = "ダウ理論→押し目確認待機";
            }
          }
        }
        // 7. 大台超え → ステートマシン待機
        else if (sig.reason.startsWith("大台超え")) {
          blockedReason = "state_machine_waiting";
          blockedFilterName = "大台超え確認待機";
        }
        // 8. medium品質ブロック
        else if (sig.confidence === "medium") {
          blockedReason = "medium_quality_block";
          blockedFilterName = "medium品質直接エントリー禁止";
        }
        // 9. ATRフィルター
        else if (atrRatio !== null && atrRatio < ATR_FILTER_THRESHOLD) {
          blockedReason = "atr_filter";
          blockedFilterName = `ATRフィルター(${(atrRatio*100).toFixed(4)}%<${(ATR_FILTER_THRESHOLD*100).toFixed(2)}%)`;
        }
        // 10. 証拠金制限（ここでは簡易的にスキップ）
        else {
          // エントリー通過
          blockedReason = "";
          blockedFilterName = "";
          totalBuyEntries++;
          symbolStats[symbol].buyEntries++;
          hasPosition = true;
          positionSide = "long";
        }

        if (blockedReason) {
          symbolStats[symbol].buyBlocked++;
          blockReasonCounts[blockedReason] = (blockReasonCounts[blockedReason] || 0) + 1;
          symbolStats[symbol].blockReasons[blockedReason] = (symbolStats[symbol].blockReasons[blockedReason] || 0) + 1;

          const blocked: BlockedBuySignal = {
            timestamp: candleTime,
            symbol,
            symbolName: SYMBOL_NAMES[symbol] || symbol,
            signalType: sig.reason.substring(0, 60),
            confidence: sig.confidence || "unknown",
            price: c.close,
            boardSignal,
            boardScore: boardReadingScoreSimple(boardData, "long"),
            bpr,
            regime,
            ma5: c.ma5 ?? null,
            ma25: c.ma25 ?? null,
            vwap: vwapArr[i] ?? null,
            volumeRatio,
            blockedReason,
            blockedFilterName,
          };
          allBlockedBuys.push(blocked);

          // Ghost Trade: strong シグナルで特定のブロック理由のみ
          if (sig.confidence === "strong" && 
              ["sell_pressure_block", "board_score_low", "state_machine_waiting", "htf_filter", "pullback_depth_filter"].includes(blockedReason)) {
            const ghost = simulateGhostTrade(c, candles, i, sig, blockedReason);
            if (ghost) {
              allGhostTrades.push(ghost);
              symbolStats[symbol].ghostTrades.push(ghost);
            }
          }

          // sell_pressure中に上昇した回数カウント
          if (blockedReason === "sell_pressure_block") {
            // 次の10本で上昇したか確認
            const futureCandles = candles.slice(i, Math.min(i + 10, candles.length));
            if (futureCandles.length >= 5) {
              const maxHigh = Math.max(...futureCandles.map((fc: any) => Number(fc.high)));
              if ((maxHigh - c.close) / c.close >= 0.005) { // +0.5%以上上昇
                symbolStats[symbol].sellPressureUpCount++;
              }
              // Ghost tradeで利益になったか
              const ghostSP = simulateGhostTrade(c, candles, i, sig, blockedReason);
              if (ghostSP && ghostSP.virtualPnL > 0) {
                symbolStats[symbol].sellPressureLongProfit++;
              }
            }
          }
        }
      }

      // SELLシグナル集計
      if (sig.type === "sell") {
        totalSellSignals++;
        if (sig.confidence === "strong") totalSellStrong++;
        
        let sellBlocked = "";
        if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) {
          sellBlocked = "time_filter";
        } else if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) {
          sellBlocked = "time_filter";
        } else if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) {
          sellBlocked = "time_filter";
        } else if (hasPosition) {
          sellBlocked = "already_position";
        } else if (boardSignal === "buy_pressure") {
          sellBlocked = "buy_pressure_block";
        } else if (boardReadingScoreSimple(boardData, "short") < BOARD_SCORE_THRESHOLD) {
          sellBlocked = "board_score_low";
        } else if (sig.confidence === "medium" && !sig.reason.startsWith("ダウ理論")) {
          sellBlocked = "medium_quality_block";
        } else {
          totalSellEntries++;
        }
        if (sellBlocked) {
          sellBlockReasonCounts[sellBlocked] = (sellBlockReasonCounts[sellBlocked] || 0) + 1;
        }
      }
    }
  }

  // ============================================================
  // 実施1: 日次集計出力
  // ============================================================
  console.log(`\n${"─".repeat(60)}`);
  console.log(`【実施1】日次集計: ${TARGET_DATE}`);
  console.log(`${"─".repeat(60)}`);
  console.log(`\n■ BUYシグナル:`);
  console.log(`  生成数: ${totalBuySignals}`);
  console.log(`  strong: ${totalBuyStrong}`);
  console.log(`  medium: ${totalBuyMedium}`);
  console.log(`  実エントリー数: ${totalBuyEntries}`);
  console.log(`  ブロック数: ${totalBuySignals - totalBuyEntries}`);
  console.log(`  フィルター通過率: ${totalBuySignals > 0 ? ((totalBuyEntries / totalBuySignals) * 100).toFixed(1) : 0}%`);
  console.log(`\n■ BUYブロック理由別件数:`);
  const sortedReasons = Object.entries(blockReasonCounts).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${reason}: ${count}件 (${((count / (totalBuySignals - totalBuyEntries)) * 100).toFixed(1)}%)`);
  }
  console.log(`\n■ SELLシグナル:`);
  console.log(`  生成数: ${totalSellSignals}`);
  console.log(`  strong: ${totalSellStrong}`);
  console.log(`  実エントリー数: ${totalSellEntries}`);
  console.log(`  ブロック理由別:`);
  for (const [reason, count] of Object.entries(sellBlockReasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count}件`);
  }

  // ============================================================
  // 実施2: Ghost Trade結果
  // ============================================================
  console.log(`\n${"─".repeat(60)}`);
  console.log(`【実施2】Ghost Trade仮想BUY検証`);
  console.log(`${"─".repeat(60)}`);
  console.log(`\n仮想取引数: ${allGhostTrades.length}件`);
  
  if (allGhostTrades.length > 0) {
    const totalPnL = allGhostTrades.reduce((s, g) => s + g.virtualPnL, 0);
    const wins = allGhostTrades.filter(g => g.virtualPnL > 0);
    const losses = allGhostTrades.filter(g => g.virtualPnL < 0);
    const beExits = allGhostTrades.filter(g => g.virtualPnL === 0);
    
    console.log(`  勝率: ${((wins.length / allGhostTrades.length) * 100).toFixed(1)}% (${wins.length}/${allGhostTrades.length})`);
    console.log(`  総損益: ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(0)}円`);
    console.log(`  勝ち: ${wins.length}件 (平均+${wins.length > 0 ? (wins.reduce((s, g) => s + g.virtualPnL, 0) / wins.length).toFixed(0) : 0}円)`);
    console.log(`  負け: ${losses.length}件 (平均${losses.length > 0 ? (losses.reduce((s, g) => s + g.virtualPnL, 0) / losses.length).toFixed(0) : 0}円)`);
    console.log(`  BE決済: ${beExits.length}件`);
    console.log(`  TP到達: ${allGhostTrades.filter(g => g.wouldHitTP).length}件`);
    console.log(`  SL到達: ${allGhostTrades.filter(g => g.wouldHitSL).length}件`);
    console.log(`  BE発動: ${allGhostTrades.filter(g => g.wouldTriggerBE).length}件`);
    
    console.log(`\n■ ブロック理由別Ghost Trade損益:`);
    const byReason = new Map<string, GhostTrade[]>();
    for (const g of allGhostTrades) {
      const arr = byReason.get(g.blockedReason) || [];
      arr.push(g);
      byReason.set(g.blockedReason, arr);
    }
    for (const [reason, trades] of byReason) {
      const pnl = trades.reduce((s, g) => s + g.virtualPnL, 0);
      const winRate = trades.filter(g => g.virtualPnL > 0).length / trades.length;
      console.log(`  ${reason}: ${trades.length}件, 損益=${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円, 勝率=${(winRate*100).toFixed(0)}%`);
    }

    console.log(`\n■ Ghost Trade詳細 (上位10件 by PnL):`);
    const sorted = [...allGhostTrades].sort((a, b) => b.virtualPnL - a.virtualPnL);
    for (const g of sorted.slice(0, 10)) {
      console.log(`  ${g.timestamp} ${g.symbolName}(${g.symbol}) ${g.signalType.substring(0, 30)}`);
      console.log(`    ブロック: ${g.blockedReason} | Entry:${g.virtualEntryPrice} → Exit:${g.virtualExitPrice}(${g.virtualExitReason})`);
      console.log(`    PnL: ${g.virtualPnL >= 0 ? "+" : ""}${g.virtualPnL.toFixed(0)}円 | MFE:+${g.maxFavorableExcursion.toFixed(2)}% | MAE:${g.maxAdverseExcursion.toFixed(2)}%`);
    }
    console.log(`\n■ 最も損失が大きかった仮想BUY:`);
    for (const g of sorted.slice(-3)) {
      console.log(`  ${g.timestamp} ${g.symbolName}(${g.symbol}) ${g.signalType.substring(0, 30)}`);
      console.log(`    PnL: ${g.virtualPnL.toFixed(0)}円 | ブロック: ${g.blockedReason}`);
    }
  }

  // ============================================================
  // 実施3: 銘柄別分析
  // ============================================================
  console.log(`\n${"─".repeat(60)}`);
  console.log(`【実施3】銘柄別分析`);
  console.log(`${"─".repeat(60)}`);
  
  for (const symbol of ANALYSIS_SYMBOLS) {
    const stats = symbolStats[symbol];
    const name = SYMBOL_NAMES[symbol] || symbol;
    console.log(`\n■ ${name} (${symbol}):`);
    console.log(`  BUY生成数: ${stats.buyGenerated}`);
    console.log(`  BUY strong: ${stats.buyStrong}`);
    console.log(`  BUY実エントリー: ${stats.buyEntries}`);
    console.log(`  BUYブロック: ${stats.buyBlocked}`);
    
    // ブロック理由TOP3
    const topReasons = Object.entries(stats.blockReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`  ブロック理由TOP3: ${topReasons.map(([r, c]) => `${r}(${c}件)`).join(", ")}`);
    
    // Ghost Trade
    if (stats.ghostTrades.length > 0) {
      const ghostPnL = stats.ghostTrades.reduce((s, g) => s + g.virtualPnL, 0);
      const bestGhost = stats.ghostTrades.reduce((best, g) => g.virtualPnL > best.virtualPnL ? g : best);
      const worstGhost = stats.ghostTrades.reduce((worst, g) => g.virtualPnL < worst.virtualPnL ? g : worst);
      console.log(`  Ghost Trade総損益: ${ghostPnL >= 0 ? "+" : ""}${ghostPnL.toFixed(0)}円 (${stats.ghostTrades.length}件)`);
      console.log(`  最大利益Ghost: ${bestGhost.timestamp} +${bestGhost.virtualPnL.toFixed(0)}円 (${bestGhost.signalType.substring(0, 30)})`);
      console.log(`  最大損失Ghost: ${worstGhost.timestamp} ${worstGhost.virtualPnL.toFixed(0)}円 (${worstGhost.signalType.substring(0, 30)})`);
    } else {
      console.log(`  Ghost Trade: なし`);
    }
    
    console.log(`  sell_pressure中に上昇した回数: ${stats.sellPressureUpCount}`);
    console.log(`  sell_pressure中LONG許可で利益: ${stats.sellPressureLongProfit}件`);
  }

  // ============================================================
  // 実施4: sell_pressure時LONGブロック妥当性検証
  // ============================================================
  console.log(`\n${"─".repeat(60)}`);
  console.log(`【実施4】sell_pressure時LONGブロック妥当性検証`);
  console.log(`${"─".repeat(60)}`);
  
  // A: 現行（全ブロック）
  const sellPressureBlocked = allBlockedBuys.filter(b => b.blockedReason === "sell_pressure_block");
  const sellPressureGhosts = allGhostTrades.filter(g => g.blockedReason === "sell_pressure_block");
  
  console.log(`\n■ パターンA（現行: sell_pressure時BUY全ブロック）:`);
  console.log(`  ブロック数: ${sellPressureBlocked.length}件`);
  console.log(`  うちstrong: ${sellPressureBlocked.filter(b => b.confidence === "strong").length}件`);
  
  // B: 条件付き許可
  console.log(`\n■ パターンB（条件付き許可）:`);
  console.log(`  条件: close>VWAP, 直近3本陽線優勢, 累積+1.2%, BPR+0.05改善, volumeRatio>=1.5, strongのみ`);
  
  const conditionalAllowed: GhostTrade[] = [];
  for (const blocked of sellPressureBlocked) {
    if (blocked.confidence !== "strong") continue;
    
        const candles = candlesBySymbol.get(blocked.symbol) || [];
    const idx = candles.findIndex((c: any) => c.candleTime === blocked.timestamp);
    if (idx < 3) continue;
    const c = candles[idx];
    // Compute VWAP for this symbol
    const symVwapCandles = candles.map((cc: any) => ({
      open: Number(cc.open), high: Number(cc.high), low: Number(cc.low),
      close: Number(cc.close), volume: Number(cc.volume),
    }));
    const symVwapArr = calcVWAP(symVwapCandles);
    const vwap = symVwapArr[idx] ?? null;
    
    // 条件チェック
    const closeAboveVwap = vwap !== null && Number(c.close) > vwap;
    
    // 直近3本で陽線優勢
    const recent3 = candles.slice(idx - 2, idx + 1);
    const bullishBars = recent3.filter((r: any) => Number(r.close) > Number(r.open)).length;
    const bullishDominant = bullishBars >= 2;
    
    // 累積上昇率
    const cumReturn = idx >= 3 ? (Number(c.close) - Number(candles[idx - 3].close)) / Number(candles[idx - 3].close) * 100 : 0;
    const cumReturnOk = cumReturn >= 1.2;
    
    // BPR改善
    const boards = boardsBySymbol.get(blocked.symbol) || new Map();
    const currentBoard = boards.get(blocked.timestamp);
    const prevBoard = idx >= 3 ? boards.get(candles[idx - 3].candleTime) : null;
    const bprImproved = currentBoard && prevBoard ? 
      (currentBoard.buyPressureRatio - prevBoard.buyPressureRatio) >= 0.05 : false;
    
    // 出来高比率
    const volRatioOk = blocked.volumeRatio >= 1.5;
    
    const allConditions = closeAboveVwap && bullishDominant && cumReturnOk && bprImproved && volRatioOk;
    
    if (allConditions) {
      // Ghost trade for this conditional entry
      const ghost = simulateGhostTrade(
        { close: Number(c.close), candleTime: c.candleTime, symbol: blocked.symbol },
        candles, idx, { reason: blocked.signalType, confidence: "strong" }, "sell_pressure_conditional"
      );
      if (ghost) conditionalAllowed.push(ghost);
    }
  }
  
  console.log(`  条件通過数: ${conditionalAllowed.length}件`);
  if (conditionalAllowed.length > 0) {
    const totalPnL = conditionalAllowed.reduce((s, g) => s + g.virtualPnL, 0);
    const wins = conditionalAllowed.filter(g => g.virtualPnL > 0);
    console.log(`  総損益: ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(0)}円`);
    console.log(`  勝率: ${((wins.length / conditionalAllowed.length) * 100).toFixed(1)}%`);
    for (const g of conditionalAllowed) {
      console.log(`    ${g.timestamp} ${g.symbolName} PnL:${g.virtualPnL >= 0 ? "+" : ""}${g.virtualPnL.toFixed(0)}円 (${g.virtualExitReason})`);
    }
  }

  // 比較
  console.log(`\n■ A/B比較:`);
  const aPnL = sellPressureGhosts.reduce((s, g) => s + g.virtualPnL, 0);
  const bPnL = conditionalAllowed.reduce((s, g) => s + g.virtualPnL, 0);
  console.log(`  A(全ブロック): Ghost損益=${aPnL >= 0 ? "+" : ""}${aPnL.toFixed(0)}円 (${sellPressureGhosts.length}件) ← これが取り逃した利益`);
  console.log(`  B(条件付き許可): 損益=${bPnL >= 0 ? "+" : ""}${bPnL.toFixed(0)}円 (${conditionalAllowed.length}件)`);
  console.log(`  差分: ${bPnL - aPnL >= 0 ? "+" : ""}${(bPnL - aPnL).toFixed(0)}円`);

  // ============================================================
  // 実施5: 結論
  // ============================================================
  console.log(`\n${"─".repeat(60)}`);
  console.log(`【実施5】結論`);
  console.log(`${"─".repeat(60)}`);
  
  const topBlocker = sortedReasons[0];
  console.log(`\n1. BUYが入れなかった最大原因: ${topBlocker ? `${topBlocker[0]} (${topBlocker[1]}件, ${((topBlocker[1] / (totalBuySignals - totalBuyEntries)) * 100).toFixed(1)}%)` : "不明"}`);
  
  const spBlockCount = blockReasonCounts["sell_pressure_block"] || 0;
  const spGhostProfit = sellPressureGhosts.filter(g => g.virtualPnL > 0).length;
  console.log(`\n2. sell_pressure_block過剰度: ${spBlockCount}件ブロック, うちGhost利益=${spGhostProfit}件 → ${spGhostProfit > spBlockCount * 0.4 ? "過剰（緩和推奨）" : "適切"}`);
  
  const bsBlockCount = blockReasonCounts["board_score_low"] || 0;
  const bsGhosts = allGhostTrades.filter(g => g.blockedReason === "board_score_low");
  const bsGhostProfit = bsGhosts.filter(g => g.virtualPnL > 0).length;
  console.log(`\n3. board_score_low過剰度: ${bsBlockCount}件ブロック, うちGhost利益=${bsGhostProfit}件 → ${bsGhostProfit > bsBlockCount * 0.3 ? "過剰（緩和推奨）" : "適切"}`);
  
  const smBlockCount = blockReasonCounts["state_machine_waiting"] || 0;
  const smGhosts = allGhostTrades.filter(g => g.blockedReason === "state_machine_waiting");
  const smGhostProfit = smGhosts.filter(g => g.virtualPnL > 0).length;
  console.log(`\n4. state_machine_waiting: ${smBlockCount}件待機, うちGhost利益=${smGhostProfit}件 → ${smGhostProfit > 0 ? "チャンス逃し" : "問題なし"}`);
  
  console.log(`\n5. 上昇をシステムが取れなかった理由:`);
  console.log(`   BUYシグナル${totalBuySignals}件中、実エントリー${totalBuyEntries}件（通過率${totalBuySignals > 0 ? ((totalBuyEntries / totalBuySignals) * 100).toFixed(1) : 0}%）`);
  console.log(`   SELLシグナル${totalSellSignals}件中、実エントリー${totalSellEntries}件（通過率${totalSellSignals > 0 ? ((totalSellEntries / totalSellSignals) * 100).toFixed(1) : 0}%）`);
  console.log(`   BUY/SELL通過率比: ${totalBuySignals > 0 && totalSellSignals > 0 ? ((totalBuyEntries / totalBuySignals) / (totalSellEntries / totalSellSignals)).toFixed(2) : "N/A"}x`);

  process.exit(0);
}

// ============================================================
// Ghost Trade シミュレーション
// ============================================================
function simulateGhostTrade(
  signalCandle: any,
  allCandles: any[],
  signalIdx: number,
  sig: any,
  blockedReason: string,
): GhostTrade | null {
  const entryPrice = Number(signalCandle.close);
  const symbol = signalCandle.symbol || allCandles[signalIdx]?.symbol;
  const shares = Math.floor(3_000_000 * 0.9 / entryPrice);
  
  const slPrice = entryPrice * (1 - STOP_LOSS_PERCENT / 100);
  const tpPrice = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
  const bePrice = entryPrice * (1 + BE_TRIGGER_PERCENT / 100);
  
  let exitPrice = entryPrice;
  let exitReason = "market_close";
  let exitTime = "15:30";
  let maxHigh = entryPrice;
  let maxLow = entryPrice;
  let beTriggered = false;
  let hitTP = false;
  let hitSL = false;
  
  // エントリー後の足を追跡
  for (let j = signalIdx + 1; j < allCandles.length; j++) {
    const fc = allCandles[j];
    const high = Number(fc.high);
    const low = Number(fc.low);
    const close = Number(fc.close);
    
    if (high > maxHigh) maxHigh = high;
    if (low < maxLow) maxLow = low;
    
    // BE trigger
    if (!beTriggered && high >= bePrice) {
      beTriggered = true;
    }
    
    // TP check
    if (high >= tpPrice) {
      exitPrice = tpPrice;
      exitReason = "take_profit";
      exitTime = fc.candleTime;
      hitTP = true;
      break;
    }
    
    // SL check (BE or normal)
    if (beTriggered) {
      if (low <= entryPrice) {
        exitPrice = entryPrice;
        exitReason = "be_exit";
        exitTime = fc.candleTime;
        break;
      }
    } else {
      if (low <= slPrice) {
        exitPrice = slPrice;
        exitReason = "stop_loss";
        exitTime = fc.candleTime;
        hitSL = true;
        break;
      }
    }
    
    // Market close
    if (fc.candleTime >= "15:30") {
      exitPrice = close;
      exitReason = "market_close";
      exitTime = fc.candleTime;
      break;
    }
  }
  
  const pnl = (exitPrice - entryPrice) * shares;
  const mfe = ((maxHigh - entryPrice) / entryPrice) * 100;
  const mae = ((maxLow - entryPrice) / entryPrice) * 100;
  
  return {
    timestamp: signalCandle.candleTime,
    symbol,
    symbolName: SYMBOL_NAMES[symbol] || getStockName(symbol),
    signalType: sig.reason?.substring(0, 60) || "unknown",
    confidence: sig.confidence || "unknown",
    blockedReason,
    virtualEntryPrice: entryPrice,
    virtualExitPrice: exitPrice,
    virtualExitReason: exitReason,
    virtualExitTime: exitTime,
    virtualPnL: pnl,
    maxFavorableExcursion: mfe,
    maxAdverseExcursion: mae,
    wouldHitTP: hitTP,
    wouldHitSL: hitSL,
    wouldTriggerBE: beTriggered,
  };
}

// 5分足トレンド判定（簡易版）
function checkHTFTrend(buffer: any[], currentIdx: number): boolean {
  if (currentIdx < 25) return false;
  // 5分足のMA5 > MA25を簡易チェック
  // 直近25本の5分足を構築
  const step = 5;
  const bars5m: number[] = [];
  for (let i = Math.max(0, currentIdx - 24); i <= currentIdx; i += step) {
    const slice = buffer.slice(i, Math.min(i + step, currentIdx + 1));
    if (slice.length > 0) {
      bars5m.push(slice[slice.length - 1].close);
    }
  }
  if (bars5m.length < 5) return false;
  const ma5 = bars5m.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma25len = Math.min(bars5m.length, 5); // 5分足のMA5
  const recent = bars5m.slice(-ma25len);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return bars5m[bars5m.length - 1] > avg;
}

main().catch(console.error);
