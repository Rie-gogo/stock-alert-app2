/**
 * CB v2 SHORT 日次シミュレーション
 * 
 * 凍結仕様（2026-07-16固定）:
 * - 対象: 大台確認SHORTシグナル かつ 大台乖離率 > 0.8%（ブロックされたケース）
 * - ステート1: 反発確認（impulseLowから0.2%以上反発）
 * - ステート2: 戻り高値形成（2本連続で高値未更新）
 * - ステート3: 戻り終了確認（終値で5MAを上→下再クロス）
 * - ステート4: 再ブレイク確認（終値 < impulseLow）
 * - エントリー: 条件成立後の次足始値
 * - SL: +0.5%, TP: -1.5%, タイムアウト: 20本（通算）
 * - 方向: SHORTのみ
 */

// ============================================================
// 型定義
// ============================================================

interface CandleData {
  candleTime: string;  // HH:MM
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CBv2Candidate {
  symbol: string;
  blockTime: string;      // ブロック発生時刻 HH:MM
  blockPrice: number;     // ブロック時の価格（close）
  roundLevel: number;     // キリ番価格
  distancePct: number;    // 乖離率%
  impulseLow: number;     // ブロック時点の安値（反発の基準）
}

interface CBv2Trade {
  symbol: string;
  blockTime: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: "TP" | "SL" | "EOD" | "TIMEOUT";
  holdBars: number;
  delayBars: number;      // ブロックからエントリーまでの足数
  roundLevel: number;
  distancePct: number;
}

interface CBv2DailyResult {
  tradeDate: string;
  candidates: number;       // CB候補数（0.8%ブロックされたSHORTの数）
  entries: number;          // CB成立数（エントリーした数）
  timeouts: number;         // タイムアウト数
  wins: number;
  losses: number;
  totalPnl: number;
  pf: number;              // Profit Factor
  trades: CBv2Trade[];
  // Case V2-B: 11:30まで
  caseB: {
    candidates: number;
    entries: number;
    timeouts: number;
    wins: number;
    losses: number;
    totalPnl: number;
    pf: number;
  };
}

// ============================================================
// 定数
// ============================================================

const CB_V2_REBOUND_PCT = 0.2;       // 反発確認: 0.2%
const CB_V2_TIMEOUT_BARS = 20;       // タイムアウト: 20本（通算）
const CB_V2_SL_PCT = 0.5;            // SL: +0.5%
const CB_V2_TP_PCT = 1.5;            // TP: -1.5%
const CB_V2_ROUND_THRESHOLD = 0.8;   // 大台乖離率閾値
const CB_V2_CASE_B_CUTOFF = "11:30"; // Case V2-B: 11:30まで
const POSITION_SIZE = 3_000_000;     // 1ポジション300万円

// ============================================================
// ヘルパー関数
// ============================================================

/**
 * 5本移動平均を計算
 */
function calcMA5(candles: CandleData[], currentIdx: number): number | null {
  if (currentIdx < 4) return null;
  let sum = 0;
  for (let i = currentIdx - 4; i <= currentIdx; i++) {
    sum += candles[i].close;
  }
  return sum / 5;
}

/**
 * 大台乖離率を計算（SHORT: キリ番が上、価格が下）
 */
function calcDistancePct(price: number, roundLevel: number): number {
  return Math.abs(price - roundLevel) / roundLevel * 100;
}

/**
 * 大台確認SHORTのブロック候補を1分足データから検出する。
 * 
 * 検出ロジック:
 * - キリ番（1000円刻み）を下にブレイクし、5本以上維持した後に
 *   0.8%以上乖離した状態でブロックされたケースを検出する。
 * 
 * 簡易実装: signalHistoryから取得する方式と、1分足から再計算する方式の
 * 両方に対応。signalHistoryが利用可能な場合はそちらを優先する。
 */
function detectCBv2Candidates(
  candles: CandleData[],
  signalBlocks: Array<{ time: string; symbol: string; price: number; reason: string }>
): CBv2Candidate[] {
  const candidates: CBv2Candidate[] = [];

  for (const block of signalBlocks) {
    // reasonからキリ番を抽出: "大台乖離率フィルター: 乖離X.XX%>0.8% → SHORTブロック (キリ番XXXXX円, ...)"
    const roundMatch = block.reason.match(/キリ番(\d+)円/);
    if (!roundMatch) continue;
    const roundLevel = parseInt(roundMatch[1]);

    // 乖離率を抽出
    const distMatch = block.reason.match(/乖離([\d.]+)%/);
    const distancePct = distMatch ? parseFloat(distMatch[1]) : calcDistancePct(block.price, roundLevel);

    // ブロック時点の安値（impulseLow）を特定: ブロック時刻の足の安値
    const blockCandleIdx = candles.findIndex(c => c.candleTime === block.time);
    if (blockCandleIdx < 0) continue;

    // impulseLow: ブロック時点までの直近安値（ブロック足含む直近5本の最安値）
    let impulseLow = candles[blockCandleIdx].low;
    for (let i = Math.max(0, blockCandleIdx - 4); i <= blockCandleIdx; i++) {
      if (candles[i].low < impulseLow) impulseLow = candles[i].low;
    }

    candidates.push({
      symbol: block.symbol,
      blockTime: block.time,
      blockPrice: block.price,
      roundLevel,
      distancePct,
      impulseLow,
    });
  }

  return candidates;
}

/**
 * CB v2 SHORTステートマシンを1つの候補に対して実行する
 */
function runCBv2StateMachine(
  candles: CandleData[],
  candidate: CBv2Candidate
): CBv2Trade | null {
  const startIdx = candles.findIndex(c => c.candleTime === candidate.blockTime);
  if (startIdx < 0 || startIdx >= candles.length - 1) return null;

  // ステートマシン変数
  let state: 1 | 2 | 3 | 4 = 1;
  let barsElapsed = 0;
  let prevHigh = -Infinity;
  let consecutiveNoNewHigh = 0;
  let prevMA5AbovePrice = false; // 前足で5MA > close だったか（上→下クロス検出用）

  // ステート1開始: ブロック足の次の足から
  for (let i = startIdx + 1; i < candles.length; i++) {
    barsElapsed++;
    const candle = candles[i];

    // タイムアウト判定（通算20本）
    if (barsElapsed > CB_V2_TIMEOUT_BARS) {
      return null; // タイムアウト → 不成立
    }

    // 15:25以降はエントリーしない
    if (candle.candleTime >= "15:25") {
      return null;
    }

    switch (state) {
      case 1: {
        // 反発確認: impulseLowから0.2%以上反発
        const reboundPct = (candle.close - candidate.impulseLow) / candidate.impulseLow * 100;
        if (reboundPct >= CB_V2_REBOUND_PCT) {
          state = 2;
          prevHigh = candle.high;
          consecutiveNoNewHigh = 0;
        }
        break;
      }

      case 2: {
        // 戻り高値形成: 2本連続で高値を更新できない
        if (candle.high >= prevHigh) {
          prevHigh = candle.high;
          consecutiveNoNewHigh = 0;
        } else {
          consecutiveNoNewHigh++;
          if (consecutiveNoNewHigh >= 2) {
            state = 3;
            // 5MAクロス検出の初期化
            const ma5 = calcMA5(candles, i);
            prevMA5AbovePrice = ma5 !== null && ma5 > candle.close;
          }
        }
        break;
      }

      case 3: {
        // 戻り終了確認: 終値で5MAを上から下へ再クロス
        const ma5 = calcMA5(candles, i);
        if (ma5 !== null) {
          const currentMA5AbovePrice = ma5 > candle.close;
          // 前足: 5MA <= close（価格が5MAの上）→ 今足: 5MA > close（価格が5MAの下）
          if (!prevMA5AbovePrice && currentMA5AbovePrice) {
            // 5MAを上から下へクロス（価格が5MAを下抜け）
            state = 4;
          }
          prevMA5AbovePrice = currentMA5AbovePrice;
        }
        break;
      }

      case 4: {
        // 再ブレイク確認: 終値 < impulseLow
        if (candle.close < candidate.impulseLow) {
          // 成立! → 次足始値でエントリー
          const entryIdx = i + 1;
          if (entryIdx >= candles.length) return null;

          const entryPrice = candles[entryIdx].open;
          const shares = Math.floor(POSITION_SIZE / entryPrice);
          if (shares <= 0) return null;

          // 決済シミュレーション
          const slPrice = entryPrice * (1 + CB_V2_SL_PCT / 100);
          const tpPrice = entryPrice * (1 - CB_V2_TP_PCT / 100);

          for (let j = entryIdx; j < candles.length; j++) {
            const exitCandle = candles[j];

            // SL判定（高値がSL以上）
            if (exitCandle.high >= slPrice) {
              const pnl = (entryPrice - slPrice) * shares;
              return {
                symbol: candidate.symbol,
                blockTime: candidate.blockTime,
                entryTime: candles[entryIdx].candleTime,
                entryPrice,
                exitTime: exitCandle.candleTime,
                exitPrice: slPrice,
                pnl: Math.round(pnl),
                exitReason: "SL",
                holdBars: j - entryIdx,
                delayBars: entryIdx - startIdx,
                roundLevel: candidate.roundLevel,
                distancePct: candidate.distancePct,
              };
            }

            // TP判定（安値がTP以下）
            if (exitCandle.low <= tpPrice) {
              const pnl = (entryPrice - tpPrice) * shares;
              return {
                symbol: candidate.symbol,
                blockTime: candidate.blockTime,
                entryTime: candles[entryIdx].candleTime,
                entryPrice,
                exitTime: exitCandle.candleTime,
                exitPrice: tpPrice,
                pnl: Math.round(pnl),
                exitReason: "TP",
                holdBars: j - entryIdx,
                delayBars: entryIdx - startIdx,
                roundLevel: candidate.roundLevel,
                distancePct: candidate.distancePct,
              };
            }

            // 大引け決済（15:25）
            if (exitCandle.candleTime >= "15:25") {
              const pnl = (entryPrice - exitCandle.close) * shares;
              return {
                symbol: candidate.symbol,
                blockTime: candidate.blockTime,
                entryTime: candles[entryIdx].candleTime,
                entryPrice,
                exitTime: exitCandle.candleTime,
                exitPrice: exitCandle.close,
                pnl: Math.round(pnl),
                exitReason: "EOD",
                holdBars: j - entryIdx,
                delayBars: entryIdx - startIdx,
                roundLevel: candidate.roundLevel,
                distancePct: candidate.distancePct,
              };
            }
          }

          // データ末尾に到達（EOD扱い）
          const lastCandle = candles[candles.length - 1];
          const pnl = (entryPrice - lastCandle.close) * shares;
          return {
            symbol: candidate.symbol,
            blockTime: candidate.blockTime,
            entryTime: candles[entryIdx].candleTime,
            entryPrice,
            exitTime: lastCandle.candleTime,
            exitPrice: lastCandle.close,
            pnl: Math.round(pnl),
            exitReason: "EOD",
            holdBars: candles.length - 1 - entryIdx,
            delayBars: entryIdx - startIdx,
            roundLevel: candidate.roundLevel,
            distancePct: candidate.distancePct,
          };
        }
        break;
      }
    }
  }

  return null; // タイムアウトまたはデータ不足
}

// ============================================================
// メインエクスポート関数
// ============================================================

/**
 * 当日のCB v2 SHORTシミュレーションを実行する
 * 
 * @param tradeDate 対象日 (YYYY-MM-DD)
 * @param allCandles 当日の全銘柄1分足データ（symbol, candleTime順）
 * @param signalBlocks 当日のround_distance_block SHORTイベント（signalHistoryから）
 * @returns CBv2DailyResult
 */
export function runCBv2DailySimulation(
  tradeDate: string,
  allCandles: Array<{ symbol: string; candleTime: string; open: string; high: string; low: string; close: string; volume: number }>,
  signalBlocks: Array<{ time: string; symbol: string; price: number; reason: string }>
): CBv2DailyResult {
  // SHORTブロックのみフィルター
  const shortBlocks = signalBlocks.filter(b => b.reason.includes("SHORTブロック"));

  // 銘柄ごとに1分足を整理
  const candlesBySymbol = new Map<string, CandleData[]>();
  for (const row of allCandles) {
    if (!candlesBySymbol.has(row.symbol)) {
      candlesBySymbol.set(row.symbol, []);
    }
    candlesBySymbol.get(row.symbol)!.push({
      candleTime: row.candleTime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    });
  }

  // 銘柄ごとにCB v2候補を検出してステートマシンを実行
  const allTrades: CBv2Trade[] = [];
  let totalCandidates = 0;
  let totalTimeouts = 0;
  let caseBCandidates = 0;
  let caseBTimeouts = 0;
  const caseBTrades: CBv2Trade[] = [];

  for (const [symbol, candles] of Array.from(candlesBySymbol.entries())) {
    const symbolBlocks = shortBlocks.filter(b => b.symbol === symbol);
    if (symbolBlocks.length === 0) continue;

    const candidates = detectCBv2Candidates(candles, symbolBlocks);
    totalCandidates += candidates.length;

    // Case V2-B: 11:30まで
    const caseBCandidatesForSymbol = candidates.filter(c => c.blockTime <= CB_V2_CASE_B_CUTOFF);
    caseBCandidates += caseBCandidatesForSymbol.length;

    for (const candidate of candidates) {
      const trade = runCBv2StateMachine(candles, candidate);
      if (trade) {
        allTrades.push(trade);
        // Case V2-B
        if (candidate.blockTime <= CB_V2_CASE_B_CUTOFF) {
          caseBTrades.push(trade);
        }
      } else {
        totalTimeouts++;
        if (candidate.blockTime <= CB_V2_CASE_B_CUTOFF) {
          caseBTimeouts++;
        }
      }
    }
  }

  // 集計
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl <= 0).length;
  const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Case V2-B集計
  const caseBWins = caseBTrades.filter(t => t.pnl > 0).length;
  const caseBLosses = caseBTrades.filter(t => t.pnl <= 0).length;
  const caseBTotalPnl = caseBTrades.reduce((sum, t) => sum + t.pnl, 0);
  const caseBGrossProfit = caseBTrades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const caseBGrossLoss = Math.abs(caseBTrades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
  const caseBPf = caseBGrossLoss > 0 ? caseBGrossProfit / caseBGrossLoss : caseBGrossProfit > 0 ? Infinity : 0;

  return {
    tradeDate,
    candidates: totalCandidates,
    entries: allTrades.length,
    timeouts: totalTimeouts,
    wins,
    losses,
    totalPnl,
    pf,
    trades: allTrades,
    caseB: {
      candidates: caseBCandidates,
      entries: caseBTrades.length,
      timeouts: caseBTimeouts,
      wins: caseBWins,
      losses: caseBLosses,
      totalPnl: caseBTotalPnl,
      pf: caseBPf,
    },
  };
}

/**
 * 日次レポート用のフォーマット済み文字列を生成する
 */
export function formatCBv2Report(result: CBv2DailyResult): string {
  if (result.candidates === 0) {
    return `\n【CB v2 SHORTシミュレーション】\n  候補なし（0.8%ブロックSHORTが0件）\n`;
  }

  const winRate = result.entries > 0 ? (result.wins / result.entries * 100).toFixed(1) : "0.0";
  const avgPnl = result.entries > 0 ? Math.round(result.totalPnl / result.entries) : 0;
  const pnlSign = result.totalPnl >= 0 ? "+" : "";

  let report = `\n【CB v2 SHORTシミュレーション（凍結仕様）】\n`;
  report += `  ■ Case V2-A（終日・全銘柄）\n`;
  report += `  候補数: ${result.candidates}件 → 成立: ${result.entries}件 / タイムアウト: ${result.timeouts}件\n`;
  report += `  損益: ${pnlSign}${result.totalPnl.toLocaleString()}円 | PF: ${result.pf === Infinity ? "∞" : result.pf.toFixed(2)} | 勝率: ${winRate}%\n`;
  report += `  勝: ${result.wins} / 負: ${result.losses} | 期待値: ${pnlSign}${avgPnl.toLocaleString()}円/取引\n`;

  // Case V2-B
  const caseBWinRate = result.caseB.entries > 0 ? (result.caseB.wins / result.caseB.entries * 100).toFixed(1) : "0.0";
  const caseBPnlSign = result.caseB.totalPnl >= 0 ? "+" : "";
  report += `\n  ■ Case V2-B（11:30まで・全銘柄）\n`;
  report += `  候補数: ${result.caseB.candidates}件 → 成立: ${result.caseB.entries}件 / タイムアウト: ${result.caseB.timeouts}件\n`;
  report += `  損益: ${caseBPnlSign}${result.caseB.totalPnl.toLocaleString()}円 | PF: ${result.caseB.pf === Infinity ? "∞" : result.caseB.pf.toFixed(2)} | 勝率: ${caseBWinRate}%\n`;

  // 取引詳細
  if (result.trades.length > 0) {
    report += `\n  ■ 取引詳細\n`;
    for (const t of result.trades) {
      const tPnlSign = t.pnl >= 0 ? "+" : "";
      report += `  [${t.blockTime}→${t.entryTime}→${t.exitTime}] ${t.symbol} ` +
        `@${t.entryPrice.toLocaleString()}→${t.exitPrice.toLocaleString()} ` +
        `${tPnlSign}${t.pnl.toLocaleString()}円 (${t.exitReason}, ${t.holdBars}本, 遅延${t.delayBars}本)\n`;
    }
  }

  return report;
}

// ============================================================
// drop_0.6 バイパス分岐型シミュレーション
// ============================================================

interface BypassTrade {
  symbol: string;
  blockTime: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: "TP" | "SL" | "EOD";
  holdBars: number;
  type: "bypass" | "cb_v2";
}

export interface BranchDailyResult {
  tradeDate: string;
  totalCandidates: number;     // 0.8%ブロックSHORT総数
  bypassCandidates: number;    // drop_0.6成立数
  cbCandidates: number;        // CB v2に回った数
  bypassEntries: number;       // バイパスエントリー数
  cbEntries: number;           // CB v2エントリー数
  bypassPnl: number;
  cbPnl: number;
  totalPnl: number;
  bypassWins: number;
  bypassLosses: number;
  cbWins: number;
  cbLosses: number;
  pf: number;
  trades: BypassTrade[];
}

const DROP_0_6_THRESHOLD = -0.006; // 直近3本で0.6%以上下落

/**
 * 直近3本の下落率を計算: 3本前の始値から現在足終値までの変化率
 */
function calcDropRate3(candles: CandleData[], idx: number): number | null {
  if (idx < 2) return null;
  const open3ago = candles[idx - 2].open;
  if (open3ago <= 0) return null;
  return (candles[idx].close - open3ago) / open3ago;
}

/**
 * drop_0.6バイパス分岐型シミュレーション
 * 
 * ロジック:
 * - 0.8%ブロックされたSHORTに対して
 * - 直近3本で0.6%以上下落 → 即時エントリー（次足始値）
 * - それ以外 → CB v2ステートマシン
 */
export function runBranchDailySimulation(
  tradeDate: string,
  allCandles: Array<{ symbol: string; candleTime: string; open: string; high: string; low: string; close: string; volume: number }>,
  signalBlocks: Array<{ time: string; symbol: string; price: number; reason: string }>
): BranchDailyResult {
  // SHORTブロックのみ
  const shortBlocks = signalBlocks.filter(b => b.reason.includes("SHORTブロック"));

  // 銘柄ごとに1分足を整理
  const candlesBySymbol = new Map<string, CandleData[]>();
  for (const row of allCandles) {
    if (!candlesBySymbol.has(row.symbol)) {
      candlesBySymbol.set(row.symbol, []);
    }
    candlesBySymbol.get(row.symbol)!.push({
      candleTime: row.candleTime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    });
  }

  const allTrades: BypassTrade[] = [];
  let totalCandidates = 0;
  let bypassCandidates = 0;
  let cbCandidates = 0;
  let bypassEntries = 0;
  let cbEntries = 0;

  for (const [symbol, candles] of Array.from(candlesBySymbol.entries())) {
    const symbolBlocks = shortBlocks.filter(b => b.symbol === symbol);
    if (symbolBlocks.length === 0) continue;

    const candidates = detectCBv2Candidates(candles, symbolBlocks);
    totalCandidates += candidates.length;

    for (const candidate of candidates) {
      const blockIdx = candles.findIndex(c => c.candleTime === candidate.blockTime);
      if (blockIdx < 0) continue;

      // drop_0.6判定: ブロック時点の足で直近3本下落率を計算
      const dropRate = calcDropRate3(candles, blockIdx);
      const isCrash = dropRate !== null && dropRate <= DROP_0_6_THRESHOLD;

      if (isCrash) {
        // バイパス: 次足始値で即時エントリー
        bypassCandidates++;
        const entryIdx = blockIdx + 1;
        if (entryIdx >= candles.length) continue;
        if (candles[entryIdx].candleTime >= "15:25") continue;

        const entryPrice = candles[entryIdx].open;
        const shares = Math.floor(POSITION_SIZE / entryPrice);
        if (shares <= 0) continue;

        const slPrice = entryPrice * (1 + CB_V2_SL_PCT / 100);
        const tpPrice = entryPrice * (1 - CB_V2_TP_PCT / 100);
        let traded = false;

        for (let j = entryIdx; j < candles.length; j++) {
          const c = candles[j];
          if (c.high >= slPrice) {
            allTrades.push({
              symbol, blockTime: candidate.blockTime,
              entryTime: candles[entryIdx].candleTime, entryPrice,
              exitTime: c.candleTime, exitPrice: slPrice,
              pnl: Math.round((entryPrice - slPrice) * shares),
              exitReason: "SL", holdBars: j - entryIdx, type: "bypass",
            });
            bypassEntries++;
            traded = true;
            break;
          }
          if (c.low <= tpPrice) {
            allTrades.push({
              symbol, blockTime: candidate.blockTime,
              entryTime: candles[entryIdx].candleTime, entryPrice,
              exitTime: c.candleTime, exitPrice: tpPrice,
              pnl: Math.round((entryPrice - tpPrice) * shares),
              exitReason: "TP", holdBars: j - entryIdx, type: "bypass",
            });
            bypassEntries++;
            traded = true;
            break;
          }
          if (c.candleTime >= "15:25") {
            allTrades.push({
              symbol, blockTime: candidate.blockTime,
              entryTime: candles[entryIdx].candleTime, entryPrice,
              exitTime: c.candleTime, exitPrice: c.close,
              pnl: Math.round((entryPrice - c.close) * shares),
              exitReason: "EOD", holdBars: j - entryIdx, type: "bypass",
            });
            bypassEntries++;
            traded = true;
            break;
          }
        }
        if (!traded) {
          // データ末尾
          const last = candles[candles.length - 1];
          allTrades.push({
            symbol, blockTime: candidate.blockTime,
            entryTime: candles[entryIdx].candleTime, entryPrice,
            exitTime: last.candleTime, exitPrice: last.close,
            pnl: Math.round((entryPrice - last.close) * shares),
            exitReason: "EOD", holdBars: candles.length - 1 - entryIdx, type: "bypass",
          });
          bypassEntries++;
        }
      } else {
        // CB v2 ステートマシン
        cbCandidates++;
        const trade = runCBv2StateMachine(candles, candidate);
        if (trade) {
          allTrades.push({
            symbol: trade.symbol,
            blockTime: trade.blockTime,
            entryTime: trade.entryTime,
            entryPrice: trade.entryPrice,
            exitTime: trade.exitTime,
            exitPrice: trade.exitPrice,
            pnl: trade.pnl,
            exitReason: trade.exitReason === "TIMEOUT" ? "EOD" : trade.exitReason,
            holdBars: trade.holdBars,
            type: "cb_v2",
          });
          cbEntries++;
        }
      }
    }
  }

  // 集計
  const bypassTrades = allTrades.filter(t => t.type === "bypass");
  const cbTrades = allTrades.filter(t => t.type === "cb_v2");
  const bypassPnl = bypassTrades.reduce((s, t) => s + t.pnl, 0);
  const cbPnl = cbTrades.reduce((s, t) => s + t.pnl, 0);
  const totalPnl = bypassPnl + cbPnl;
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    tradeDate,
    totalCandidates,
    bypassCandidates,
    cbCandidates,
    bypassEntries,
    cbEntries,
    bypassPnl,
    cbPnl,
    totalPnl,
    bypassWins: bypassTrades.filter(t => t.pnl > 0).length,
    bypassLosses: bypassTrades.filter(t => t.pnl <= 0).length,
    cbWins: cbTrades.filter(t => t.pnl > 0).length,
    cbLosses: cbTrades.filter(t => t.pnl <= 0).length,
    pf,
    trades: allTrades,
  };
}

/**
 * 分岐型シミュレーション結果のフォーマット済み文字列を生成
 */
export function formatBranchReport(result: BranchDailyResult): string {
  if (result.totalCandidates === 0) {
    return `\n【分岐型シミュレーション（drop_0.6バイパス + CB v2）】\n  候補なし\n`;
  }

  const totalEntries = result.bypassEntries + result.cbEntries;
  const totalWins = result.bypassWins + result.cbWins;
  const totalLosses = result.bypassLosses + result.cbLosses;
  const winRate = totalEntries > 0 ? (totalWins / totalEntries * 100).toFixed(1) : "0.0";
  const pnlSign = result.totalPnl >= 0 ? "+" : "";

  let report = `\n【分岐型シミュレーション（drop_0.6バイパス + CB v2）】\n`;
  report += `  候補数: ${result.totalCandidates}件\n`;
  report += `  ├ 急落バイパス(drop≧0.6%): ${result.bypassCandidates}件 → エントリー: ${result.bypassEntries}件\n`;
  report += `  └ CB v2: ${result.cbCandidates}件 → エントリー: ${result.cbEntries}件\n`;
  report += `  合計損益: ${pnlSign}${result.totalPnl.toLocaleString()}円 | PF: ${result.pf === Infinity ? "∞" : result.pf.toFixed(2)} | 勝率: ${winRate}%\n`;

  // バイパス部分
  if (result.bypassEntries > 0) {
    const bpWinRate = (result.bypassWins / result.bypassEntries * 100).toFixed(1);
    const bpSign = result.bypassPnl >= 0 ? "+" : "";
    report += `  ■ バイパス部分: ${bpSign}${result.bypassPnl.toLocaleString()}円 (${result.bypassWins}勝${result.bypassLosses}敗, 勝率${bpWinRate}%)\n`;
  }

  // CB v2部分
  if (result.cbEntries > 0) {
    const cbWinRate = (result.cbWins / result.cbEntries * 100).toFixed(1);
    const cbSign = result.cbPnl >= 0 ? "+" : "";
    report += `  ■ CB v2部分: ${cbSign}${result.cbPnl.toLocaleString()}円 (${result.cbWins}勝${result.cbLosses}敗, 勝率${cbWinRate}%)\n`;
  }

  // 取引詳細
  if (result.trades.length > 0) {
    report += `  ■ 取引詳細\n`;
    for (const t of result.trades) {
      const tSign = t.pnl >= 0 ? "+" : "";
      const typeLabel = t.type === "bypass" ? "[BP]" : "[CB]";
      report += `  ${typeLabel} [${t.blockTime}→${t.entryTime}→${t.exitTime}] ${t.symbol} ` +
        `@${t.entryPrice.toLocaleString()}→${t.exitPrice.toLocaleString()} ` +
        `${tSign}${t.pnl.toLocaleString()}円 (${t.exitReason}, ${t.holdBars}本)\n`;
    }
  }

  return report;
}

// テスト用エクスポート
export { detectCBv2Candidates, runCBv2StateMachine, calcMA5, calcDistancePct, calcDropRate3 };
export type { CBv2Candidate, CBv2Trade, CBv2DailyResult, CandleData, BypassTrade };
