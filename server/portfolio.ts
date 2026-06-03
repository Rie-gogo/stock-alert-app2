/**
 * portfolio.ts
 * ハイブリッド運用のポートフォリオ層。
 *
 * 各銘柄の独立シミュレーション結果（取引履歴）を時刻順に統合し、
 * 「同時保有は最大3銘柄」「同一業種は最大2銘柄」という横断ルールを適用する。
 *
 * 目的:
 *  - 人が追える数（常時最大3銘柄）に建玉を制限する
 *  - 一極集中（同じ業種ばかり保有）を構造的に防ぐ
 *  - 「本日の推奨銘柄」を、実績ベースのスコアで上位から選ぶ
 *
 * 設計方針:
 *  各銘柄の trades 配列には buy/short（建て）と sell/cover（決済）が時刻付きで入っている。
 *  これを全銘柄分まとめて時刻順に並べ、建てイベント時に「枠が空いているか」「同業種の上限に達していないか」を判定する。
 *  枠が無ければ、その建玉に対応する決済までの損益を「不採用（skipped）」として除外する。
 */
import { getSector, MAX_CONCURRENT_POSITIONS, MAX_PER_SECTOR } from "../shared/stocks";
import type { TradeRecord } from "./simulation";

export interface PortfolioConfig {
  maxConcurrent: number;
  maxPerSector: number;
  /** 動的資金配分: 枠が競合したとき、その日ここまでの成績が良い（調子の良い）銘柄を優先採用する。 */
  momentumAllocation?: boolean;
  /** デイリーストップ: 口座全体の当日確定損益がこの額(円・負値)以下になったら、その日は新規建てを全停止。0/undefinedで無効。 */
  dailyLossLimit?: number;
  /** 利益保護ストップ: 口座全体の当日確定損益がこの額(円・正値)以上になったら、その日は新規建てを全停止。0/undefinedで無効。 */
  dailyProfitTarget?: number;
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  maxConcurrent: MAX_CONCURRENT_POSITIONS,
  maxPerSector: MAX_PER_SECTOR,
  // 【検証済み最適値・2026-06-03】上昇相場5日×下落相場4日でスイープ(analysis/dailyStopSweepBoth.ts)。
  //  停止ライン-1.5万は、上昇相場の合計(112,600円)を一切犠牲にせず(停止発動は5日中1日のみ)、
  //  下落相場の最悪日を-23,506円→-2,638円へ約9割圧縮できる最良バランスだった。
  //  -1万まで厳しくすると下落相場の取り逃しが増え(DOWN合計67,674→35,801円)、-2万は-1.5万と同等。
  dailyLossLimit: 15000,  // 口座全体の当日確定損益が-15,000円に達したらその日は新規建てを全停止（暴落日の保険）。
  //  利益保護ストップは全条件でマイナス(利を伸ばすトレイリングと相性が悪く、伸びる利益を取り逃す)ため無効が最適。
  dailyProfitTarget: 0,   // 利益目標ストップは無効。
  momentumAllocation: true, // 枠競合時はその日調子の良い銘柄を優先採用。
};

/** 時刻文字列 "HH:MM" を分に変換（並び替え用） */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

interface FlatEvent {
  symbol: string;
  sector: string;
  minute: number;
  kind: "open" | "close"; // open=建て(buy/short), close=決済(sell/cover)
  profit: number; // close のときのみ意味を持つ
  seq: number; // 同一銘柄内の元の並び順（安定ソート用）
}

export interface PerStockTrades {
  symbol: string;
  trades: TradeRecord[];
}

export interface PortfolioResult {
  acceptedProfit: number; // 採用された取引の合計損益
  skippedProfit: number; // 枠不足で見送った取引の合計損益
  acceptedTrades: number; // 採用された決済回数
  skippedTrades: number; // 見送った決済回数
  acceptedWins: number;
  acceptedLosses: number;
  maxConcurrentObserved: number; // 実際に同時保有した最大数
  rejectionsByConcurrency: number;
  rejectionsBySector: number;
  dailyStopTriggered: boolean;   // デイリーストップ（損失上限/利益保護）が発動したか
  dailyStopReason: "" | "loss_limit" | "profit_target"; // 発動理由
  rejectionsByDailyStop: number; // デイリーストップで見送った建て回数
}

/**
 * 各銘柄の取引を時刻順に統合し、同時保有・業種分散の上限を適用して
 * 「実際に採用された取引」の損益を集計する。
 */
export function applyPortfolioRules(
  perStock: PerStockTrades[],
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG
): PortfolioResult {
  const events: FlatEvent[] = [];

  for (const ps of perStock) {
    const sector = getSector(ps.symbol);
    ps.trades.forEach((t, idx) => {
      const isOpen = t.type === "buy" || t.type === "short";
      const isClose = t.type === "sell" || t.type === "cover";
      if (!isOpen && !isClose) return;
      events.push({
        symbol: ps.symbol,
        sector,
        minute: timeToMinutes(t.time),
        kind: isOpen ? "open" : "close",
        profit: t.profit ?? 0,
        seq: idx,
      });
    });
  }

  // 時刻順に並べる。同時刻なら「決済 → 建て」の順にして枠を先に空ける。
  events.sort((a, b) => {
    if (a.minute !== b.minute) return a.minute - b.minute;
    if (a.kind !== b.kind) return a.kind === "close" ? -1 : 1;
    return a.seq - b.seq;
  });

  const heldSymbols = new Set<string>(); // 現在保有中の銘柄
  const sectorCount = new Map<string, number>();
  // 採用された建玉の銘柄集合（その銘柄の決済を採用すべきか判定するため）
  const acceptedOpenSymbols = new Set<string>();
  // 動的資金配分: 各銘柄のその日ここまでの確定損益（勢いスコア）
  const runningProfitBySymbol = new Map<string, number>();
  const useMomentum = config.momentumAllocation === true;

  const result: PortfolioResult = {
    acceptedProfit: 0,
    skippedProfit: 0,
    acceptedTrades: 0,
    skippedTrades: 0,
    acceptedWins: 0,
    acceptedLosses: 0,
    maxConcurrentObserved: 0,
    rejectionsByConcurrency: 0,
    rejectionsBySector: 0,
    dailyStopTriggered: false,
    dailyStopReason: "",
    rejectionsByDailyStop: 0,
  };

  // デイリーストップの設定（正の値のみ有効）
  const lossLimit = config.dailyLossLimit && config.dailyLossLimit > 0 ? config.dailyLossLimit : 0;
  const profitTarget = config.dailyProfitTarget && config.dailyProfitTarget > 0 ? config.dailyProfitTarget : 0;
  // 一旦発動したらその日は新規建てを全停止（保有中の決済はそのまま許可）
  let newEntriesHalted = false;

  // 動的資金配分が有効なら、同一時刻の建て候補を「その日ここまでの成績が良い順」に並べ替える。
  // 決済→建ての順序は維持しつつ、同分・同種別(open)内のみ勢いスコア降順で優先採用させる。
  if (useMomentum) {
    // 分ごとにグループ化し、open グループ内を runningProfit 降順に並べ替える必要があるが、
    // runningProfit は処理進行に伴い変化するため、ループ内で動的に決定する（下の selectNextOpen で対応）。
  }

  // 同一時刻の open 候補を勢いスコア順に処理するためのインデックスベース走査
  let idx = 0;
  while (idx < events.length) {
    // 同一 minute かつ同一 kind のブロックを取り出す
    const blockStart = idx;
    const blockMinute = events[idx].minute;
    const blockKind = events[idx].kind;
    let blockEnd = idx;
    while (
      blockEnd < events.length &&
      events[blockEnd].minute === blockMinute &&
      events[blockEnd].kind === blockKind
    ) {
      blockEnd++;
    }
    let block = events.slice(blockStart, blockEnd);
    // 動的配分: open ブロックは、その日ここまでの成績が良い銘柄を優先（降順）
    if (useMomentum && blockKind === "open" && block.length > 1) {
      block = block.slice().sort((a, b) => {
        const pa = runningProfitBySymbol.get(a.symbol) ?? 0;
        const pb = runningProfitBySymbol.get(b.symbol) ?? 0;
        if (pb !== pa) return pb - pa; // 成績の良い銘柄を先に
        return a.seq - b.seq; // 同点は元順で安定化
      });
    }
    for (const ev of block) {
    if (ev.kind === "open") {
      // すでにこの銘柄を保有中なら、元シミュの追加建て（通常は起きない）はスキップ
      if (heldSymbols.has(ev.symbol)) continue;

      // デイリーストップ発動中は、以降の新規建てを全て見送る
      if (newEntriesHalted) {
        result.rejectionsByDailyStop++;
        continue;
      }

      const concurrencyFull = heldSymbols.size >= config.maxConcurrent;
      const sectorFull = (sectorCount.get(ev.sector) ?? 0) >= config.maxPerSector;

      if (concurrencyFull) {
        result.rejectionsByConcurrency++;
        continue; // 枠なし → この建玉は不採用（対応する決済も自動的に不採用になる）
      }
      if (sectorFull) {
        result.rejectionsBySector++;
        continue;
      }

      // 採用：枠を確保
      heldSymbols.add(ev.symbol);
      sectorCount.set(ev.sector, (sectorCount.get(ev.sector) ?? 0) + 1);
      acceptedOpenSymbols.add(ev.symbol);
      if (heldSymbols.size > result.maxConcurrentObserved) {
        result.maxConcurrentObserved = heldSymbols.size;
      }
    } else {
      // close イベント
      if (acceptedOpenSymbols.has(ev.symbol) && heldSymbols.has(ev.symbol)) {
        // 採用された建玉の決済 → 損益を採用
        result.acceptedProfit += ev.profit;
        result.acceptedTrades++;
        if (ev.profit > 0) result.acceptedWins++;
        else result.acceptedLosses++;
        // 枠を解放
        heldSymbols.delete(ev.symbol);
        acceptedOpenSymbols.delete(ev.symbol);
        sectorCount.set(ev.sector, Math.max(0, (sectorCount.get(ev.sector) ?? 1) - 1));

        // デイリーストップ判定（確定損益が更新されるのは決済時のみ）
        if (!newEntriesHalted) {
          if (lossLimit > 0 && result.acceptedProfit <= -lossLimit) {
            newEntriesHalted = true;
            result.dailyStopTriggered = true;
            result.dailyStopReason = "loss_limit";
          } else if (profitTarget > 0 && result.acceptedProfit >= profitTarget) {
            newEntriesHalted = true;
            result.dailyStopTriggered = true;
            result.dailyStopReason = "profit_target";
          }
        }
        // 勢いスコア更新（採用された確定損益を銘柄別に加算）
        runningProfitBySymbol.set(ev.symbol, (runningProfitBySymbol.get(ev.symbol) ?? 0) + ev.profit);
      } else {
        // 不採用だった建玉の決済 → 見送り損益として集計
        result.skippedProfit += ev.profit;
        result.skippedTrades++;
        // 見送りでも勢いスコアには反映（その銘柄の実力を評価するため）
        runningProfitBySymbol.set(ev.symbol, (runningProfitBySymbol.get(ev.symbol) ?? 0) + ev.profit);
      }
    }
    } // end for (const ev of block)
    idx = blockEnd;
  }

  return result;
}

/**
 * 「本日の推奨銘柄」を実績スコア順に選ぶ。
 * スコア = 当日損益（円）を主指標とし、勝ち越し銘柄を優先する。
 * （翌日以降は過去レポートの集計値を渡すことで「調子スコア」に拡張可能）
 */
export interface SymbolScoreInput {
  symbol: string;
  name: string;
  profit: number;
  winCount: number;
  lossCount: number;
}

export interface RankedSymbol extends SymbolScoreInput {
  sector: string;
  score: number;
  rank: number;
}

/**
 * 推奨銘柄ランキングを返す。業種分散の上限を考慮して上位を選別する。
 * topN: 推奨として返す件数（既定3）
 */
export function rankRecommendedSymbols(
  inputs: SymbolScoreInput[],
  topN = 3,
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG
): RankedSymbol[] {
  // スコア = 損益。勝率も軽く加味（同点時の優先用）。
  const scored = inputs.map((s) => {
    const trades = s.winCount + s.lossCount;
    const winRate = trades > 0 ? s.winCount / trades : 0;
    const score = s.profit + winRate * 1000; // 損益主体、勝率は微小な上乗せ
    return { ...s, sector: getSector(s.symbol), score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 業種分散の上限を守りつつ上位から選ぶ
  const picked: RankedSymbol[] = [];
  const sectorCount = new Map<string, number>();
  for (const s of scored) {
    if (picked.length >= topN) break;
    if (s.score <= 0) continue; // 損益マイナスの銘柄は推奨しない
    const cnt = sectorCount.get(s.sector) ?? 0;
    if (cnt >= config.maxPerSector) continue;
    sectorCount.set(s.sector, cnt + 1);
    picked.push({ ...s, rank: picked.length + 1 });
  }

  return picked;
}

// ============================================================
// 事前推奨（明日の推奨銘柄）— 過去レポートの調子スコアから算出
// ============================================================

/** 過去実績の集計値（db.getSymbolPerformanceHistory の戻り値と対応） */
export interface SymbolHistoryInput {
  symbol: string;
  name: string;
  appearances: number; // 集計対象に登場した営業日数
  totalProfit: number; // 直近N営業日の累計損益（円）
  totalWin: number;
  totalLoss: number;
  avgWinRate: number; // 平均勝率（0〜1）
}

export interface PreTradeRecommendation extends RankedSymbol {
  avgDailyProfit: number; // 1営業日あたり平均損益（円）
  avgWinRate: number; // 平均勝率（0〜1）
  appearances: number;
  lotMultiplier: number; // 【動的資金配分】推奨ロット倍率（0.5〜1.5）。調子の良い銘柄ほど大きい。
  reason: string; // 推奨理由（人間向け説明）
}

/**
 * 過去レポートの「調子スコア」から、明日の推奨銘柄トップNを事前算出する。
 *
 * スコア設計（後知恵を避け、事前に分かる指標のみ使用）:
 *   score = 1営業日あたり平均損益(円) + 平均勝率 * 5000
 *   → 直近で安定して稼げており勝率も高い銘柄を上位に。
 *
 * 業種分散の上限（同業種は最大 maxPerSector）を守って選別する。
 * これにより半導体など特定セクターへの一極集中を防ぐ。
 */
export function recommendForNextDay(
  history: SymbolHistoryInput[],
  topN = 3,
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG
): PreTradeRecommendation[] {
  const scored = history.map((h) => {
    const avgDailyProfit = h.appearances > 0 ? h.totalProfit / h.appearances : 0;
    const score = avgDailyProfit + h.avgWinRate * 5000;
    return {
      symbol: h.symbol,
      name: h.name,
      sector: getSector(h.symbol),
      avgDailyProfit,
      avgWinRate: h.avgWinRate,
      appearances: h.appearances,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked: PreTradeRecommendation[] = [];
  const sectorCount = new Map<string, number>();

  for (const s of scored) {
    if (picked.length >= topN) break;
    // 事前推奨は「直近で負け越している銘柄」を除外（平均損益マイナスは推奨しない）
    if (s.avgDailyProfit <= 0) continue;
    const cnt = sectorCount.get(s.sector) ?? 0;
    if (cnt >= config.maxPerSector) continue;
    sectorCount.set(s.sector, cnt + 1);

    // 調子スコアからロット倍率を算出（同じ履歴入力を再構成して computeLotMultiplier に渡す）
    const histForLot: SymbolHistoryInput = {
      symbol: s.symbol, name: s.name, appearances: s.appearances,
      totalProfit: s.avgDailyProfit * s.appearances, totalWin: 0, totalLoss: 0, avgWinRate: s.avgWinRate,
    };
    const lotMultiplier = computeLotMultiplier(histForLot);
    const lotLabel = lotMultiplier > 1.05 ? `ロット厚め(${lotMultiplier.toFixed(2)}倍)` : lotMultiplier < 0.95 ? `ロット控えめ(${lotMultiplier.toFixed(2)}倍)` : `ロット標準`;

    const reason =
      `直近${s.appearances}営業日で1日平均 ${Math.round(s.avgDailyProfit).toLocaleString()}円・` +
      `勝率${(s.avgWinRate * 100).toFixed(0)}%。${s.sector}セクター。${lotLabel}。`;

    picked.push({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      profit: s.avgDailyProfit,
      winCount: 0,
      lossCount: 0,
      avgDailyProfit: s.avgDailyProfit,
      avgWinRate: s.avgWinRate,
      appearances: s.appearances,
      lotMultiplier,
      score: s.score,
      rank: picked.length + 1,
      reason,
    });
  }

  return picked;
}

/**
 * 【動的資金配分】銘柄の過去実績(調子スコア)から、翌日のロット倍率(0.5〜1.5)を算出する。
 *
 * 設計（後知恵を避け、事前に分かる指標のみ使用）:
 *   - 1営業日あたり平均損益(円)を主指標とし、勝率で微調整する。
 *   - 平均損益が +20,000円/日 以上の好調銘柄 → 上限 1.5倍（資金を厚く）。
 *   - 平均損益が 0円付近 → 1.0倍（標準）。
 *   - 平均損益がマイナス（不調）→ 下限 0.5倍（資金を薄く。ただし完全には外さず監視継続）。
 *   - 登場日数が少ない(<2日)銘柄は実績が不安定なので1.0倍に固定（過剰反応を防ぐ）。
 *
 * simulateStockReal(..., lotMultiplier) に渡して使う。
 */
export function computeLotMultiplier(history: SymbolHistoryInput): number {
  if (history.appearances < 2) return 1.0; // 実績が薄い銘柄は標準ロット
  const avgDailyProfit = history.totalProfit / history.appearances;

  // 平均損益を ±20,000円/日 を ±0.5 の振れ幅に線形マッピング
  const PROFIT_FULL_SCALE = 20000; // この損益で倍率が最大/最小に張り付く
  const profitComponent = Math.max(-0.5, Math.min(0.5, (avgDailyProfit / PROFIT_FULL_SCALE) * 0.5));

  // 勝率は微調整（0.5を基準に ±0.1 程度）
  const winComponent = Math.max(-0.1, Math.min(0.1, (history.avgWinRate - 0.5) * 0.4));

  const multiplier = 1.0 + profitComponent + winComponent;
  return Math.max(0.5, Math.min(1.5, multiplier));
}
