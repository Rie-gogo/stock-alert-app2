/**
 * realtimeSimEngine.ts
 *
 * リアルタイム取引シミュレーションエンジン
 *
 * 動作フロー:
 * 1. Windows中継スクリプトから1分足OHLCVを受信
 * 2. 受信した足をメモリ上の蓄積バッファに追加
 * 3. detectSignals()でシグナルを判定
 * 4. 買い/売りシグナルが出たら架空取引をDBに記録
 * 5. 大引け（15:30）後に全ポジションを強制決済
 *
 * 板情報（kabu STATION APIの板データ）はオプションの補助条件として使用:
 * - 買い板圧力が強い場合: 買いシグナルの確度を高める
 * - 売り板圧力が強い場合: 売りシグナルの確度を高める
 * - 大口壁がある場合: 逆方向シグナルを抑制
 */

import { insertRtCandle, insertRtTrade, upsertRtDailySummary, getRtTradesForDate, getRtCandlesAllForDate, getRtOpenPositionsFromDb, insertScore0Block } from "./db";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "./routers/stockData";
import { getOrderBook, analyzeOrderBook, calcExtendedBoardFields, getAggregatedBoardStats, clearBoardRingBuffer } from "./kabuStation";
import { getHigherTfTrend } from "./vwap";
import { calcATR } from "./intradayRegime";
import { getStockName, TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS, ACTIVE_ENTRY_SYMBOLS } from "../shared/stocks";
import {
  evaluateConfirmation,
  trailingAvgVolume,
  priceMomentum,
  type SignalConfidence,
} from "./signalConfirmation";

import type { BoardSnapshot } from "../drizzle/schema";
import { processThreePeakCandle, resetThreePeakState, forceCloseThreePeakPosition } from "./threePeakDetector";

// TARGET_STOCKSに含まれる銘柄のみ処理対象（除外銘柄はスキップ）
const ALLOWED_SYMBOLS: Set<string> = new Set(TARGET_STOCKS.map(s => s.symbol));

// ============================================================
// 定数
// ============================================================

/** 元金（円）: 5銘柄 × 300万円 */
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;

/** ロット計算: 元金の何%を1トレードに使うか */
const LOT_RATIO = 0.9;

/** 損切り率（%）: エントリー価格から何%下落で損切り（6/11良い結果: -0.7%/高安値トリガー） */
const STOP_LOSS_PERCENT = 0.5; // デフォルトSL（銘柄別設定がない場合のフォールバック）

/** 利確率（%）: エントリー価格から何%上昇で利確 */
const TAKE_PROFIT_PERCENT_SHORT = 1.5;
const TAKE_PROFIT_PERCENT_LONG = 0.5; // 2026-08-19: 1.5%→0.5%に変更。10営業日シミュレーションでTP0.5%が最適（勝率57.1%,+416,952円,PF1.29）。静かな上昇バイパスLONGは0.5%で十分到達する。結果が悪ければ1.5%に戻す。

/**
 * 銘柄別SL幅設定（2026-08-03 MAE分析に基づく）
 * USE_PER_SYMBOL_SL = false にすると全銘柄一律 STOP_LOSS_PERCENT(0.5%) に戻る
 */
const USE_PER_SYMBOL_SL = true;

/** 銘柄別SL（%）: MAE中央値〜75%タイルを基に設定 */
const SYMBOL_SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.8, short: 0.8 },   // 東京エレクトロン: 両方0.8%が最適
  "6857": { long: 0.6, short: 0.6 },   // アドバンテスト: 両方0.6%が最適
  "6976": { long: 0.6, short: 0.8 },   // 太陽誘電: LONG 0.6%(19件,PF1.34), SHORT 0.8%(19件,PF1.97)
  "6526": { long: 0.9, short: 1.0 },   // ソシオネクスト: SHORT 1.0%(13件,PF2.47,+101k改善)
  "5803": { long: 0.5, short: 0.6 },   // フジクラ: SHORT 0.6%(19件,PF2.07,+25k改善)
  "6981": { long: 0.4, short: 0.9 },   // 村田製作所: LONG 0.4%(7件,PF5.02,+35k改善)
  "285A": { long: 0.8, short: 0.6 },   // キオクシア: SHORT 0.6%(9件,PF8.86,+26k改善)
  "6920": { long: 0.9, short: 0.9 },   // レーザーテック: 両方0.9%
  "6146": { long: 0.8, short: 0.8 },   // ディスコ: 両方0.8%（データ少）
  "6594": { long: 0.5, short: 0.5 },   // ニデック: 両方0.5%（データ少）
  "8316": { long: 0.5, short: 0.5 },   // 三井住友FG: 両方0.5%
};

/**
 * 銘柄別パラメータ設定（SYMBOL_CONFIG）
 * 
 * 各銘柄のくせに合わせた個別パラメータを設定可能。
 * 未設定の項目はグローバルデフォルト値が使用される。
 * 
 * 将来的に銘柄ごとのロジック分岐もここで管理する。
 */
export interface SymbolConfig {
  // SL/TP設定
  sl: { long: number; short: number };
  tp?: { long: number; short: number };
  // isBullish設定
  maPeriod?: number;          // IS_BULLISH_MA_PERIOD のオーバーライド
  slopeThreshold?: number;    // IS_BULLISH_SLOPE_THRESHOLD のオーバーライド
  // 高値下落フィルター
  dropFromHighMax?: number;   // SHORT_DROP_FROM_HIGH_MAX のオーバーライド
  dropLookback?: number;      // SHORT_DROP_LOOKBACK のオーバーライド
  // エントリー方式の有効/無効
  enableFastEntryVol?: boolean;    // 即vol（出来高1.5倍）
  enableFastEntry4a?: boolean;     // 即4a（前足近接）
  enableLowBreakFast?: boolean;    // 安値更新即
  enableVolBreakLong?: boolean;    // 出来高ブレイクLONG
  enableQuietRiseBypass?: boolean; // 静かな上昇バイパス
  enablePullbackLong?: boolean;    // 押し目確認LONG
  // 反転LONG設定（大台超えLONG廃止の代替）
  enableReversalLong?: boolean;           // 反転LONGを有効にするか
  reversalLongDropPct?: number;           // 当日高値からの下落閾値（%）
  reversalLongAmOnly?: boolean;           // 前場のみに限定するか
  reversalLongStartTime?: string;         // 開始時間（例: "09:45"）
  reversalLongMinSlope?: number;          // MA傾き最小閾値（%）
  disableRoundUpLong?: boolean;           // 大台超えLONGを無効にするか
  // 安全CB SHORT設定（大幅下落の追撃と底値反発後の大台割れを回避）
  enableSafeCbShort?: boolean;
  safeCbMaxDropFromOpenPct?: number;      // 始値からの最大下落率（負数、例:-8.0）
  safeCbMaxReboundFromDayLowPct?: number; // 当日安値から許容する最大反発率（%）
  // 反転SHORT設定（上昇後の明確な反落を狙う）
  enableReversalShort?: boolean;
  reversalShortMinRisePct?: number;       // 始値からの最低上昇率（%）
  reversalShortDropPct?: number;          // 当日高値からの最低下落率（%）
  reversalShortStartTime?: string;
  reversalShortEndTime?: string;
  reversalShortSlPct?: number;
  reversalShortTpPct?: number;
  // 順張りLONG設定（上昇継続日を捉える）
  enableTrendLong?: boolean;
  trendLongStartTime?: string;
  trendLongEndTime?: string;
  trendLongMinOpenGainPct?: number;
  trendLongMaxOpenGainPct?: number;
  trendLongHighLookback?: number;
  trendLongMinVolumeRatio?: number;
  trendLongSlPct?: number;
  trendLongTpPct?: number;
  trendBoardBprMax?: number;
  // 順張りSHORT設定（下落継続日を捉える）
  enableTrendShort?: boolean;
  trendShortStartTime?: string;
  trendShortEndTime?: string;
  trendShortMinOpenGainPct?: number;
  trendShortMaxOpenGainPct?: number;
  trendShortLowLookback?: number;
  trendShortMinVolumeRatio?: number;
  trendShortSlPct?: number;
  trendShortTpPct?: number;
  // 後場安値更新SHORT設定（フジクラ候補C）
  enableAfternoonLowBreakShort?: boolean;
  afternoonLowBreakShortStartTime?: string;
  afternoonLowBreakShortEndTime?: string;
  afternoonLowBreakShortLowLookback?: number;
  afternoonLowBreakShortMaxOpenGainPct?: number;
  afternoonLowBreakShortMaxMaSlopePct?: number;
  afternoonLowBreakShortMinVolumeRatio?: number;
  afternoonLowBreakShortBprMax?: number;
  afternoonLowBreakShortSlPct?: number;
  afternoonLowBreakShortTpPct?: number;
  afternoonLowBreakShortShockRangePct?: number;
  afternoonLowBreakShortShockVolumeRatio?: number;
  // 構造ブレイクLONG設定（フジクラ: 安値反転後の高値更新）
  enableLowReversalBreakLong?: boolean;
  lowReversalBreakLongStartTime?: string;
  lowReversalBreakLongEndTime?: string;
  lowReversalBreakLongLowLookback?: number;
  lowReversalBreakLongHighLookback?: number;
  lowReversalBreakLongMinVolumeRatio?: number;
  lowReversalBreakLongBprMax?: number;
  lowReversalBreakLongBprFloor?: number;
  lowReversalBreakLongMaxDayLowDropPct?: number;
  lowReversalBreakLongMinReboundPct?: number;
  lowReversalBreakLongSlPct?: number;
  lowReversalBreakLongTpPct?: number;
  // 構造失速SHORT設定（フジクラ: 上昇後の安値更新）
  enableHighFadeBreakShort?: boolean;
  highFadeBreakShortStartTime?: string;
  highFadeBreakShortEndTime?: string;
  highFadeBreakShortMinOpenGainPct?: number;
  highFadeBreakShortLowLookback?: number;
  highFadeBreakShortMinVolumeRatio?: number;
  highFadeBreakShortBprMax?: number;
  highFadeBreakShortMaSlopeFloor?: number;
  highFadeBreakShortSlPct?: number;
  highFadeBreakShortTpPct?: number;
  // 寄り付きブレイクSHORT設定（村田製作所: 始値からの下落初動）
  enableOpeningBreakShort?: boolean;
  openingBreakShortStartTime?: string;
  openingBreakShortEndTime?: string;
  openingBreakShortMaxOpenGainPct?: number;
  openingBreakShortLowLookback?: number;
  openingBreakShortMinVolumeRatio?: number;
  openingBreakShortBprMax?: number;
  openingBreakShortSlPct?: number;
  openingBreakShortTpPct?: number;
  openingBreakShortShockRangePct?: number;
  openingBreakShortShockVolumeRatio?: number;
  // 太陽誘電: 朝初動SHORT・前場偏り後の後場反転設定
  enableTaiyoMorningInitialShort?: boolean;
  taiyoMorningInitialShortStartTime?: string;
  taiyoMorningInitialShortEndTime?: string;
  taiyoMorningInitialShortRangeBars?: number;
  taiyoMorningInitialShortMinVolumeRatio?: number;
  taiyoMorningInitialShortSlPct?: number;
  taiyoMorningInitialShortTpPct?: number;
  enableTaiyoAfternoonReversalLong?: boolean;
  enableTaiyoAfternoonReversalShort?: boolean;
  taiyoAfternoonReversalStartTime?: string;
  taiyoAfternoonReversalEndTime?: string;
  taiyoAfternoonMinMorningMovePct?: number;
  taiyoAfternoonMinReversalPct?: number;
  taiyoAfternoonHighLowLookback?: number;
  taiyoAfternoonLongMinVolumeRatio?: number;
  taiyoAfternoonShortMinVolumeRatio?: number;
  taiyoAfternoonSlPct?: number;
  taiyoAfternoonTpPct?: number;
  // 高値反転SHORT設定（急騰後の初動反落を狙う）
  enablePeakReversalShort?: boolean;
  peakReversalShortStartTime?: string;
  peakReversalShortEndTime?: string;
  peakReversalShortMinRisePct?: number;
  peakReversalShortDropPct?: number;
  peakReversalShortMinBodyPct?: number;
  peakReversalShortMinVolumeRatio?: number;
  peakReversalShortSlPct?: number;
  peakReversalShortTpPct?: number;
  // 東京エレクトロン: 最大保有時間。TP・SL・既存決済がなければ、経過後の次足始値で決済
  telMaxHoldingMinutes?: number;
  // アドバンテスト: 高値形成後の失速SHORT（確認足の実体不足を停止）
  enableAdvantestHighFadeShort?: boolean;
  advantestHighFadeShortStartTime?: string;
  advantestHighFadeShortEndTime?: string;
  advantestHighFadeShortMinOpenGainPct?: number;
  advantestHighFadeShortDropPct?: number;
  advantestHighFadeShortLowLookback?: number;
  advantestHighFadeShortMinVolumeRatio?: number;
  advantestHighFadeShortMaxMaSlopePct?: number;
  advantestHighFadeShortMinPriorBearBodyPct?: number;
  advantestHighFadeShortSlPct?: number;
  advantestHighFadeShortTpPct?: number;
  // アドバンテスト: 確認型20本高値更新LONGと損切り後の反対方向再評価
  enableAdvantestConfirmedBreakLong?: boolean;
  advantestConfirmedBreakLongStartTime?: string;
  advantestConfirmedBreakLongEndTime?: string;
  advantestConfirmedBreakLongHighLookback?: number;
  advantestConfirmedBreakLongMinPriorBodyPct?: number;
  advantestConfirmedBreakLongMinMaSlopePct?: number;
  advantestConfirmedBreakLongMinVolumeRatio?: number;
  advantestConfirmedBreakLongMaxRecentRangePct?: number;
  advantestConfirmedBreakLongSlPct?: number;
  advantestConfirmedBreakLongTpPct?: number;
  enableAdvantestPostStopReentry?: boolean;
  advantestPostStopShortMaxFiveBarChangePct?: number;
  // ディスコ: 確認型10本高値更新LONGと寄り付き10本安値更新SHORT
  enableDiscoConfirmedBreakLong?: boolean;
  discoConfirmedBreakLongStartTime?: string;
  discoConfirmedBreakLongEndTime?: string;
  discoConfirmedBreakLongHighLookback?: number;
  discoConfirmedBreakLongMinMaSlopePct?: number;
  discoConfirmedBreakLongMinVolumeRatio?: number;
  discoConfirmedBreakLongSlPct?: number;
  discoConfirmedBreakLongTpPct?: number;
  enableDiscoOpeningBreakShort?: boolean;
  discoOpeningBreakShortStartTime?: string;
  discoOpeningBreakShortEndTime?: string;
  discoOpeningBreakShortMaxOpenGainPct?: number;
  discoOpeningBreakShortLowLookback?: number;
  discoOpeningBreakShortMaxMaSlopePct?: number;
  discoOpeningBreakShortMinVolumeRatio?: number;
  discoOpeningBreakShortSlPct?: number;
  discoOpeningBreakShortTpPct?: number;
  /** 個別最適化完了銘柄では、下段の汎用ダウ理論・大台・押し目等の入口を使わない */
  exclusiveEntryRoutes?: boolean;
  // 静かな上昇バイパスのパラメータ
  quietRiseMaDev?: number;    // MA乖離閾値
  quietRiseBody?: number;     // 実体閾値
  quietRiseBearBars?: number; // 陰線本数閾値
  // メモ（くせの記録）
  notes?: string;
}

/** 銘柄別パラメータ設定マップ */
export const SYMBOL_CONFIG: Record<string, Partial<SymbolConfig>> = {
  "285A": {
    sl: { long: 0.8, short: 0.6 },
    tp: { long: 0.8, short: 1.5 },  // 反転LONG用TP 0.8%（SHORTは全体デフォルト1.5%）
    enableReversalLong: true,         // 反転LONGを有効化
    reversalLongDropPct: 2.5,         // 当日高値から2.5%以上下落で反転LONG発火条件
    reversalLongAmOnly: true,         // 前場のみ（09:30〜11:27）
    reversalLongStartTime: "09:45",   // 09:45以降に限定（09:30-09:44は勝率低い）
    reversalLongMinSlope: 0.02,       // MA8傾き>=0.02%（反転の勢いが弱すぎる場合を除外）
    disableRoundUpLong: true,         // 大台超えLONGを無効化（全敗のため）
    enableSafeCbShort: true,
    safeCbMaxDropFromOpenPct: -8.0,       // 始値比-8%以下は下落末端の追撃としてCB SHORTを停止
    safeCbMaxReboundFromDayLowPct: 1.0,   // 当日安値から1%以上戻した後のCB SHORTを停止
    enableReversalShort: true,
    reversalShortMinRisePct: 3.0,         // 始値から3%以上上昇した日だけ反転を狙う
    reversalShortDropPct: 1.5,            // 当日高値から1.5%以上の反落を確認
    reversalShortStartTime: "09:45",
    reversalShortEndTime: "11:27", // 後場は12:50再開後の遅延発火で成績悪化するため前場限定
    reversalShortSlPct: 0.8,
    reversalShortTpPct: 1.2,
    enableTrendLong: true,
    trendLongStartTime: "10:15",
    trendLongEndTime: "14:20",
    trendLongMinOpenGainPct: 0.0,
    trendLongHighLookback: 20,
    trendLongMinVolumeRatio: 1.2,
    trendLongSlPct: 0.6,
    trendLongTpPct: 0.8,
    enableTrendShort: true,
    trendShortStartTime: "10:15",
    trendShortEndTime: "14:20",
    trendShortMaxOpenGainPct: -1.0,
    trendShortLowLookback: 10,
    trendShortMinVolumeRatio: 1.0,
    trendShortSlPct: 0.8,
    trendShortTpPct: 1.2,
    exclusiveEntryRoutes: true,
    notes: "キオクシア: 反転LONG（高値落2.5%/SL0.6%/TP0.8%/前場09:45〜/MA8傾き>=0.02%）＋安全CB SHORT＋反転SHORT（始値+3%→高値から1.5%反落、SL0.8%/TP1.2%、前場09:45〜11:27）＋順張りLONG（10:15〜、始値以上・20本高値更新・出来高1.2倍）＋順張りSHORT（10:15〜、始値比-1%以下・10本安値更新）。",
  },
  "8035": {
    sl: { long: 0.7, short: 0.6 },
    tp: { long: 1.0, short: 1.8 },
    enableTrendLong: true,
    trendLongStartTime: "10:00",
    trendLongEndTime: "11:27",
    trendLongMinOpenGainPct: 1.5,
    trendLongMaxOpenGainPct: 2.5,
    trendLongHighLookback: 20,
    trendLongMinVolumeRatio: 1.0,
    trendLongSlPct: 0.7,
    trendLongTpPct: 1.0,
    trendBoardBprMax: 1.6,
    enableTrendShort: true,
    trendShortStartTime: "10:00",
    trendShortEndTime: "11:00",
    trendShortMinOpenGainPct: -4.0,
    trendShortMaxOpenGainPct: -0.5,
    trendShortLowLookback: 5,
    trendShortMinVolumeRatio: 1.2,
    trendShortSlPct: 0.6,
    trendShortTpPct: 1.8,
    enablePeakReversalShort: true,
    peakReversalShortStartTime: "09:45",
    peakReversalShortEndTime: "11:27",
    peakReversalShortMinRisePct: 2.5,
    peakReversalShortDropPct: 0.4,
    peakReversalShortMinBodyPct: 0.1,
    peakReversalShortMinVolumeRatio: 1.0,
    peakReversalShortSlPct: 0.6,
    peakReversalShortTpPct: 1.8,
    telMaxHoldingMinutes: 22,
    exclusiveEntryRoutes: true,
    notes: "東京エレクトロン: 上昇幅上限付き順張りLONG（始値+1.5〜+2.5%、20本高値更新）＋下落継続SHORT（始値-0.5〜-4.0%、5本安値更新）＋高値反転SHORT（始値+2.5%後、高値から0.4%反落）。LONG SL0.7%/TP1.0%、SHORT SL0.6%/TP1.8%。TP・SL・既存決済がなければ22分確定後の次足始値で決済。",
  },
  "6857": {
    sl: { long: 1.0, short: 1.0 },
    tp: { long: 0.5, short: 1.2 },
    enableFastEntryVol: false,
    enableFastEntry4a: false,
    enableLowBreakFast: false,
    enableTrendLong: false,
    enableTrendShort: false,
    enableAdvantestHighFadeShort: true,
    advantestHighFadeShortStartTime: "09:45",
    advantestHighFadeShortEndTime: "11:15",
    advantestHighFadeShortMinOpenGainPct: 1.0,
    advantestHighFadeShortDropPct: 0.8,
    advantestHighFadeShortLowLookback: 5,
    advantestHighFadeShortMinVolumeRatio: 1.2,
    advantestHighFadeShortMaxMaSlopePct: -0.05,
    advantestHighFadeShortMinPriorBearBodyPct: 0.05,
    advantestHighFadeShortSlPct: 1.0,
    advantestHighFadeShortTpPct: 1.2,
    enableAdvantestConfirmedBreakLong: true,
    advantestConfirmedBreakLongStartTime: "10:00",
    advantestConfirmedBreakLongEndTime: "11:15",
    advantestConfirmedBreakLongHighLookback: 20,
    advantestConfirmedBreakLongMinPriorBodyPct: 0.10,
    advantestConfirmedBreakLongMinMaSlopePct: 0.03,
    advantestConfirmedBreakLongMinVolumeRatio: 1.0,
    advantestConfirmedBreakLongMaxRecentRangePct: 1.5,
    advantestConfirmedBreakLongSlPct: 0.5,
    advantestConfirmedBreakLongTpPct: 1.0,
    enableAdvantestPostStopReentry: true,
    advantestPostStopShortMaxFiveBarChangePct: -0.3,
    exclusiveEntryRoutes: true,
    notes: "アドバンテスト: 確認型20本高値更新LONG（前足陽線実体0.10%・MA8傾き>=0.03%・VWAP上、SL0.5%/TP1.0%）＋高値失速SHORT（始値比+1%以上の高値形成後、高値から0.8%以上反落、5本安値更新、陰線、MA8の2本傾き<=-0.05%、出来高1.2倍以上、前足陰線実体0.05%未満は停止、SL1.0%/TP1.2%）。初回損切り後のみ反対方向を一度再評価し、再評価LONGは5本値幅<=1.5%、再評価SHORTはVWAP下かつ5本変化率<=-0.3%を追加確認する。",
  },
  "6976": {
    sl: { long: 1.0, short: 1.0 },
    tp: { long: 1.5, short: 1.5 },
    enableFastEntryVol: false,
    enableFastEntry4a: false,
    enableLowBreakFast: false,
    enableTrendLong: false,
    enableTrendShort: false,
    enableTaiyoMorningInitialShort: true,
    taiyoMorningInitialShortStartTime: "09:30",
    taiyoMorningInitialShortEndTime: "11:20",
    taiyoMorningInitialShortRangeBars: 5,
    taiyoMorningInitialShortMinVolumeRatio: 2.2,
    taiyoMorningInitialShortSlPct: 1.0,
    taiyoMorningInitialShortTpPct: 1.5,
    enableTaiyoAfternoonReversalLong: true,
    enableTaiyoAfternoonReversalShort: true,
    taiyoAfternoonReversalStartTime: "12:50",
    taiyoAfternoonReversalEndTime: "14:20",
    taiyoAfternoonMinMorningMovePct: 3.0,
    taiyoAfternoonMinReversalPct: 1.0,
    taiyoAfternoonHighLowLookback: 5,
    taiyoAfternoonLongMinVolumeRatio: 1.0,
    taiyoAfternoonShortMinVolumeRatio: 1.2,
    taiyoAfternoonSlPct: 1.0,
    taiyoAfternoonTpPct: 1.2,
    exclusiveEntryRoutes: true,
    notes: "太陽誘電: 朝初動SHORT（最初の5分安値下抜け・出来高2.2倍・1本確認、SL1.0%/TP1.5%）＋前場始値比±3%後の後場反転LONG/SHORT（出来高1.0倍/1.2倍・1本確認、SL1.0%/TP1.2%）。朝1回、後場はLONG/SHORT合計1回。",
  },
  "6526": { sl: { long: 0.9, short: 1.0 } },
  "5803": {
    sl: { long: 0.5, short: 0.6 },
    enableAfternoonLowBreakShort: true,
    afternoonLowBreakShortStartTime: "13:30",
    afternoonLowBreakShortEndTime: "14:00",
    afternoonLowBreakShortLowLookback: 5,
    afternoonLowBreakShortMaxOpenGainPct: -1.0,
    afternoonLowBreakShortMaxMaSlopePct: -0.1,
    afternoonLowBreakShortMinVolumeRatio: 1.0,
    afternoonLowBreakShortBprMax: 1.0,
    afternoonLowBreakShortSlPct: 0.6,
    afternoonLowBreakShortTpPct: 1.5,
    afternoonLowBreakShortShockRangePct: 0.75,
    afternoonLowBreakShortShockVolumeRatio: 3.0,
    enableLowReversalBreakLong: true,
    lowReversalBreakLongStartTime: "09:45",
    lowReversalBreakLongEndTime: "14:30",
    lowReversalBreakLongLowLookback: 20,
    lowReversalBreakLongHighLookback: 5,
    lowReversalBreakLongMinVolumeRatio: 1.0,
    lowReversalBreakLongBprMax: 0.8,
    lowReversalBreakLongBprFloor: 0.25,
    lowReversalBreakLongSlPct: 0.5,
    lowReversalBreakLongTpPct: 0.5,
    enableHighFadeBreakShort: true,
    highFadeBreakShortStartTime: "09:45",
    highFadeBreakShortEndTime: "14:30",
    highFadeBreakShortMinOpenGainPct: 1.0,
    highFadeBreakShortLowLookback: 5,
    highFadeBreakShortMinVolumeRatio: 0.5,
    highFadeBreakShortBprMax: 0.8,
    highFadeBreakShortMaSlopeFloor: -0.20,
    highFadeBreakShortSlPct: 0.6,
    highFadeBreakShortTpPct: 1.5,
    exclusiveEntryRoutes: true,
    notes: "フジクラ: 候補C（後場安値更新SHORT）に加え、安値反転ブレイクLONGと高値失速ブレイクSHORTを追加。LONGはBPR<=0.25を極端な売り圧力として停止、SHORTはMA8傾き<=-0.20%を急落末端として停止。候補Cのショック足停止は維持。",
  },
  "6981": {
    sl: { long: 1.0, short: 0.6 },
    tp: { long: 1.5, short: 1.5 },
    enableFastEntryVol: false,
    enableFastEntry4a: false,
    enableLowBreakFast: false,
    enableLowReversalBreakLong: true,
    lowReversalBreakLongStartTime: "09:45",
    lowReversalBreakLongEndTime: "14:20",
    lowReversalBreakLongLowLookback: 20,
    lowReversalBreakLongHighLookback: 5,
    lowReversalBreakLongMinVolumeRatio: 0.8,
    lowReversalBreakLongBprMax: 1.0,
    lowReversalBreakLongBprFloor: 0,
    lowReversalBreakLongMaxDayLowDropPct: -2.0,
    lowReversalBreakLongMinReboundPct: 1.0,
    lowReversalBreakLongSlPct: 1.0,
    lowReversalBreakLongTpPct: 1.5,
    enableOpeningBreakShort: true,
    openingBreakShortStartTime: "09:45",
    openingBreakShortEndTime: "10:45",
    openingBreakShortMaxOpenGainPct: -1.5,
    openingBreakShortLowLookback: 20,
    openingBreakShortMinVolumeRatio: 1.0,
    openingBreakShortBprMax: 0.8,
    openingBreakShortSlPct: 0.6,
    openingBreakShortTpPct: 1.5,
    openingBreakShortShockRangePct: 1.0,
    openingBreakShortShockVolumeRatio: 2.0,
    exclusiveEntryRoutes: true,
    notes: "村田製作所: 安値反転ブレイクLONG（当日安値が始値比-2%後、安値から1%反発・5本高値更新・1本確認、SL1.0%/TP1.5%）＋寄り付きブレイクSHORT（始値比-1.5%・20本安値更新・1本確認、SL0.6%/TP1.5%）。SHORTは値幅1.0%かつ出来高2.0倍以上のショック足を停止。各日1方向1回のみ。",
  },
  "6920": { sl: { long: 0.9, short: 0.9 } },
  "6146": {
    sl: { long: 0.5, short: 0.5 },
    tp: { long: 1.8, short: 2.0 },
    enableDiscoConfirmedBreakLong: true,
    discoConfirmedBreakLongStartTime: "09:30",
    discoConfirmedBreakLongEndTime: "14:30",
    discoConfirmedBreakLongHighLookback: 10,
    discoConfirmedBreakLongMinMaSlopePct: 0.02,
    discoConfirmedBreakLongMinVolumeRatio: 1.2,
    discoConfirmedBreakLongSlPct: 0.5,
    discoConfirmedBreakLongTpPct: 1.8,
    enableDiscoOpeningBreakShort: true,
    discoOpeningBreakShortStartTime: "09:30",
    discoOpeningBreakShortEndTime: "10:45",
    discoOpeningBreakShortMaxOpenGainPct: -1.0,
    discoOpeningBreakShortLowLookback: 10,
    discoOpeningBreakShortMaxMaSlopePct: 0,
    discoOpeningBreakShortMinVolumeRatio: 0.8,
    discoOpeningBreakShortSlPct: 0.5,
    discoOpeningBreakShortTpPct: 2.0,
    exclusiveEntryRoutes: true,
    notes: "ディスコ: 確認型10本高値更新LONG（VWAP上・MA8傾き>=0.02%・出来高1.2倍以上、SL0.5%/TP1.8%）＋寄り付き10本安値更新SHORT（09:30〜10:45・始値比-1.0%以下・MA8傾き<=0%・出来高0.8倍以上、SL0.5%/TP2.0%）。各方向1日1回、同時保有なし、決済後は反対方向を再評価可能。時間上限なし。",
  },
  "6594": { sl: { long: 0.5, short: 0.5 } },
  "8316": { sl: { long: 0.5, short: 0.5 } },
};

/** 銘柄別パラメータ取得ヘルパー */
export function getSymbolConfig(symbol: string): Partial<SymbolConfig> {
  return SYMBOL_CONFIG[symbol] ?? {};
}

/** 銘柄別TP/SLオーバーライド（レガシー互換、USE_PER_SYMBOL_SL=true時はSYMBOL_SL_MAPが優先） */
const SYMBOL_TP_SL_OVERRIDE: Record<string, { tp: number; sl: number }> = {
  // 現在は空（SYMBOL_SL_MAPで管理）
};

/** isBullish方式: 動的MA傾き判定（MA8の1分あたり傾きが閾値以上なら上昇相場と判定しSHORT禁止） */
const IS_BULLISH_MA_PERIOD = 8; // 2026-08-18: 20→8に変更。38営業日シミュレーションで+4,803,927円(PF1.35) vs MA20+3,663,370円(PF1.29)。デイトレ1分足で8分間が「直近の勢い」判定に最適。結果が悪ければ20に戻す。
/** isBullish傾き閾値: MA8の1分あたり変化率がこの値(%)を超えたら上昇中と判定 */
const IS_BULLISH_SLOPE_THRESHOLD = 0; // 2026-08-14: -0.03→0に変更（横ばい以上で禁止→上向きのみ禁止）。28日間シミュレーションで最適（+1,040,556円, 勝率43.4%）。結果が悪ければ-0.03に戻す。
/** isBullishフォールバック閾値: バッファ不足時に使う始値比(%) */
const IS_BULLISH_FALLBACK_THRESHOLD = 0.2;

/** 後場BPRフィルター: 13:00以降のSHORTでBPR>=この値ならエントリーブロック */
const PM_BPR_BLOCK_THRESHOLD = 0.65;
/** 後場BPRフィルターの開始時刻 */
const PM_BPR_FILTER_START = "13:00";

/** 午後高値圏フィルター: 13:00以降のLONGで始値比+この%以上ならエントリーブロック */
const PM_HIGHZONE_THRESHOLD = 0.04;

/** 証拠金（元金）: 現物300万円 */
const MARGIN_CAPITAL = 3_000_000;

/** 信用倍率: 3.3倍 */
const MARGIN_MULTIPLIER = 3.3;

/** 最大使用率: 証拠金 × 信用倍率 × この割合を超えたらエントリー停止 */
const MARGIN_USAGE_LIMIT = 0.9; // 90% → 990万 × 90% = 891万円

/** 最大投資可能額 = 300万 × 3.3倍 × 90% = 8,910,000円 */
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;

/** 大引け強制決済の時刻 (HH:MM) */
const MARKET_CLOSE_TIME = "15:25";
/** 前場強制決済の時刻 (HH:MM) — 昼休み前にポジションを全て決済 */
const AM_SESSION_CLOSE_TIME = "11:27";

/** 午後エントリー禁止の時刻 (HH:MM) - この時刻以降は新規エントリーしない */
const NO_ENTRY_AFTER = "15:05";
/** 改善④: 09:30以前はエントリー禁止（寄り付きダマシ排除） */
const NO_ENTRY_BEFORE = "09:30";
/** 改良策5: 昼休み前（11:00-11:30）エントリー禁止 */
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
/** 後場序盤（12:30-12:50）エントリー禁止 */
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "12:50";

// ★VWAP急落フィルター: 撤廃（+D構成: 6/26版回帰）
// アブレーションテストで-19.6%のマイナス影響が確認されたため撤廃

/** ウォームアップに必要な最低足数（MA25計算のため） */
const MIN_CANDLES_FOR_SIGNAL = 30;

// ============================================================
// 型定義
// ============================================================

export interface RtCandle1Min {
  symbol: string;
  tradeDate: string;   // YYYY-MM-DD
  candleTime: string;  // HH:MM
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
  boardSignal?: string;
  confidence?: SignalConfidence;
  slPctOverride?: number;
  tpPctOverride?: number;
  // BEストップ撤廃済み（+D構成）
}

// ============================================================
// メモリ上の状態管理（プロセス再起動でリセット）
// ============================================================

/** 銘柄ごとの蓄積1分足バッファ（当日分のみ） */
const candleBuffers = new Map<string, CandleWithSignal[]>();

/** 銘柄ごとのオープンポジション（1銘柄1ポジションまで） */
const openPositions = new Map<string, OpenPosition>();

/**
 * ダウ理論（上昇）押し目確認ステートマシン
 * 高値更新シグナル受信後、一度押し（下落）が入り直近安値を割らずに再上昇した足でエントリーする。
 */
interface PullbackState {
  recentSwingLow: number;  // 損切りライン（この安値を割ったらキャンセル）
  signalPrice: number;     // シグナル発生時の価格
  waitCount: number;       // 待機足数カウンター
  pulledBack: boolean;     // 一度押しが入ったか
  reason: string;          // エントリー理由
  boardSignal?: string;    // 板情報シグナル
}

/** 銘柄ごとの押し目確認待ちステート（ダウ理論上昇のみ） */
const pullbackStates = new Map<string, PullbackState>();

/** 押し目確認の最大待機足数 */
const PULLBACK_MAX_WAIT = 5;

/**
 * 大台超え/割れ 確認バーステートマシン
 * 大台シグナル発生後、N本連続してキリ番の上/下を維持したらエントリーする。
 */
interface RoundLevelPendingState {
  direction: "buy" | "sell";  // エントリー方向
  level: number;              // キリ番価格
  confirmCount: number;       // 維持確認本数カウンター
  reason: string;             // エントリー理由
  boardSignal?: string;       // 板情報シグナル
}

/** 改善⑤: 大台確認後の押し目待ちステート */
interface RoundPullbackState {
  direction: "buy" | "sell";  // エントリー方向
  level: number;              // キリ番価格
  signalPrice: number;        // 確認完了時の価格
  waitCount: number;          // 待機足数カウンター
  pulledBack: boolean;        // 一度押しが入ったか
  reason: string;             // エントリー理由
}

/** 銘柄ごとの大台確認待ちステート */
const roundLevelPendingStates = new Map<string, RoundLevelPendingState>();

/** 銘柄ごとの大台確認後押し目待ちステート */
const roundPullbackStates = new Map<string, RoundPullbackState>();

/** 大台確認に必要な維持本数（4本 = 4分間維持）2026-07-30: 5→4に変更（全期間スイープで4本が最適と判明） */
const ROUND_LEVEL_CONFIRM_BARS = 4;

/** 大台確認後の押し目待ち最大足数 */
const ROUND_PULLBACK_MAX_WAIT = 5;

/** ★大台割れSHORT専用パラメータ（A案: 2026-08-14 シミュレーション最適化）
 *  30日間シミュレーション: CB=2,MW=1が損益+1,663,539円(PF1.71)で最適
 *  現行CB=4,MW=5は+868,270円(PF1.37) → +795,269円の改善
 *  大台超えLONG（逆張りSHORT用）はCB=4,MW=5を維持 */
const ROUND_SHORT_CONFIRM_BARS = 2;
const ROUND_SHORT_PULLBACK_MAX_WAIT = 1;

// ★大台乖離率フィルター: 撤廃済み（2026-07-28 再シミュレーションにより逆効果と判明）
// const ROUND_DISTANCE_BLOCK_THRESHOLD_PCT = 0.8;

/** ★v6: 板読みスコア閾値（この値以上でエントリー許可） */
const BOARD_SCORE_THRESHOLD = 1;

/** ★ATRフィルター: 直近N本のATR率がこの値以下ならエントリーしない */
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012; // 0.12%

/** ★押し目深さフィルター: 撤廃（2026-08-20）
 * 旧: DEPTH_MIN=0.30, DEPTH_MAX=0.70 → 30営業日で0件エントリー（過剰ブロック）
 * 新: フィルターなし → 130件 勝率63.8% PF1.50 +493,330円
 * 押し目確認ステートマシン自体は維持（一度下がって再上昇でエントリー）
 */
const PULLBACK_DEPTH_MIN = 0.0;  // 撤廃: 全ての深さを許可
const PULLBACK_DEPTH_MAX = 1.0;  // 撤廃: 全ての深さを許可
const PULLBACK_DEPTH_LOOKBACK = 20; // 直近20本のスイング高値/安値を参照（深さフィルター撤廃のため実質不使用）

/** ★v6: 板読み早期利確の最低利益率（%） */
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;

/** ★3分足HTFフィルター: 全シグナルに適用（逆方向のみブロック、neutral通過） */
const HTF_TIMEFRAME_MINUTES = 3;

// ============================================================
// ★v5.5応急フィルター: 出来高取得不可時のエントリー制限
// ============================================================
/** 出来高=0の足が連続する場合に「出来高取得不可」と判定する閾値（直近N本中の出来高=0の割合） */
const VOLUME_UNAVAILABLE_RATIO = 0.9; // 90%以上がvolume=0なら「出来高取得不可」
/** 出来高取得不可時: 損切り後の再エントリー禁止期間（分） */
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;
/** 出来高取得不可時: 12時台（昼休み明け）のエントリー禁止 */
const NO_ENTRY_LUNCH_START = "12:00";
const NO_ENTRY_LUNCH_END = "12:59";

// B2方式: 撤廃（+D構成: isBullish方式に回帰）
// アブレーションテストで-7.1%のマイナス影響が確認されたため撤廃

/** 当日の日付（日付が変わったらバッファをリセット） */
let currentTradeDate = "";

/** 当日の受信足数カウンター */
const candleCounters = new Map<string, number>();

/** 起動時バッファ復元が完了したか（複数回実行を防ぐ） */
let bufferRestored = false;

/** 最後に1分足を受信した時刻（ISO文字列、接続監視用） */
let lastCandleReceivedAt: string | null = null;

/** 銘柄ごとの確定損益（当日分） */
const symbolPnlMap = new Map<string, number>();

/** ★v5.5応急: 銘柄ごとの最終損切り時刻（HH:MM形式） */
const lastStopLossTime = new Map<string, string>();

/** ★反転LONG: 銘柄ごとの当日高値追跡（反転LONGの発火条件判定用） */
const dayHighTracker = new Map<string, number>();
/** ★反転SHORT: 当日安値と当日高値の更新位置を追跡 */
const dayLowTracker = new Map<string, number>();
const dayHighIndexTracker = new Map<string, number>();
/** ★反転LONG: 銘柄ごとの反転LONGエントリー済みフラグ（1日1回のみ） */
const reversalLongFired = new Set<string>();
/** ★反転SHORT: 銘柄ごとの反転SHORTエントリー済みフラグ（1日1回のみ） */
const reversalShortFired = new Set<string>();
/** ★順張り: 銘柄ごとの順張りLONG/SHORTエントリー済みフラグ（各方向1日1回のみ） */
const trendLongFired = new Set<string>();
const trendShortFired = new Set<string>();
/** ★後場安値更新SHORT: 銘柄ごとの候補Cエントリー済みフラグ（1日1回のみ） */
const afternoonLowBreakShortFired = new Set<string>();
/** ★5803構造ブレイク: 各方向1日1回のみのエントリー済みフラグ */
const lowReversalBreakLongFired = new Set<string>();
const highFadeBreakShortFired = new Set<string>();
/** ★5803構造ブレイク: 初動後の1本確認待ち状態 */
interface StructureBreakPendingState {
  triggerClose: number;
  triggerTime: string;
}
const lowReversalBreakLongPending = new Map<string, StructureBreakPendingState>();
const highFadeBreakShortPending = new Map<string, StructureBreakPendingState>();
/** ★6981寄り付きブレイクSHORT: 1日1方向1回と1本確認待ち状態 */
const openingBreakShortFired = new Set<string>();
const openingBreakShortPending = new Map<string, StructureBreakPendingState>();
/** ★6976: 朝初動SHORTは朝1回、後場反転はLONG/SHORT合計1回に制限する。 */
const taiyoMorningInitialShortFired = new Set<string>();
const taiyoAfternoonReversalFired = new Set<string>();
const taiyoMorningInitialShortPending = new Map<string, StructureBreakPendingState>();
const taiyoAfternoonReversalLongPending = new Map<string, StructureBreakPendingState>();
const taiyoAfternoonReversalShortPending = new Map<string, StructureBreakPendingState>();
/** ★高値反転SHORT: 銘柄ごとの急騰後反落エントリー済みフラグ（1日1回のみ） */
const peakReversalShortFired = new Set<string>();
/** ★6857高値失速SHORT: 1日1回のみのエントリー済みフラグ */
const advantestHighFadeShortFired = new Set<string>();
/** ★6857確認型LONG: 初回1回のみ。損切り後だけ反対側への再評価を許可する。 */
const advantestConfirmedBreakLongFired = new Set<string>();
interface AdvantestPostStopReentryState {
  stoppedSide: "long" | "short";
  stopTime: string;
  reentryUsed: boolean;
}
const advantestPostStopReentry = new Map<string, AdvantestPostStopReentryState>();
/** ★6146: 専用LONG/SHORTは各方向1日1回。決済後は未発火の反対方向を再評価できる。 */
const discoConfirmedBreakLongFired = new Set<string>();
const discoOpeningBreakShortFired = new Set<string>();

/** 当日の全シグナル履歴（最新200件まで） */
const signalHistory: Array<{
  time: string;       // HH:MM
  symbol: string;
  symbolName: string;
  action: string;     // buy/sell/short/cover/stop_loss/take_profit/forced_close
  price: number;
  shares: number;
  pnl: number | null;
  reason: string;
  confidence?: SignalConfidence;
}> = [];

/** シグナル履歴の最大件数 */
const MAX_SIGNAL_HISTORY = 200;

// ============================================================
// ヘルパー関数
// ============================================================

/**
 * 大台乖離率を計算する。
 * エントリー価格がキリ番価格から何%乖離しているかを返す。
 * @param entryPrice エントリー価格
 * @param roundLevel キリ番価格
 * @returns 乖離率（%、絶対値）
 */
export function calculateRoundDistancePct(entryPrice: number, roundLevel: number): number {
  if (roundLevel <= 0) return 0;
  return Math.abs(entryPrice - roundLevel) / roundLevel * 100;
}

// 大台乖離率フィルター: 撤廃済み（2026-07-28）
// export function shouldBlockRoundDistance(...) { ... }

/**
 * 現在の日本時間の日付を YYYY-MM-DD 形式で返す
 */
function getTodayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 日付が変わった場合にバッファをリセットする
 */
function resetIfNewDay(tradeDate: string): void {
  if (tradeDate !== currentTradeDate) {
    console.log(`[RealtimeSim] 新しい取引日: ${tradeDate}（前日: ${currentTradeDate}）— 当日構築モード: 全バッファクリア`);
    candleBuffers.clear();
    openPositions.clear();
    candleCounters.clear();
    pullbackStates.clear(); // 日付変更時に押し目確認ステートもリセット
    roundLevelPendingStates.clear(); // 日付変更時に大台確認待ちステートもリセット
    roundPullbackStates.clear(); // 日付変更時に大台押し目待ちステートもリセット
    symbolPnlMap.clear(); // 日付変更時に銘柄別損益もリセット
    signalHistory.length = 0; // 日付変更時にシグナル履歴もリセット
    bprHistory.clear(); // ★v6: 板圧力履歴もリセット
    clearBoardRingBuffer(); // ★v8: 10秒リングバッファもリセット
    lastStopLossTime.clear(); // ★v5.5応急: 損切り時刻記録もリセット
    dayHighTracker.clear(); // ★反転LONG: 当日高値追跡もリセット
    dayLowTracker.clear();
    dayHighIndexTracker.clear();
    reversalLongFired.clear(); // ★反転LONG: エントリー済みフラグもリセット
    reversalShortFired.clear();
    trendLongFired.clear();
    trendShortFired.clear();
    afternoonLowBreakShortFired.clear();
    lowReversalBreakLongFired.clear();
    highFadeBreakShortFired.clear();
    lowReversalBreakLongPending.clear();
    highFadeBreakShortPending.clear();
    openingBreakShortFired.clear();
    openingBreakShortPending.clear();
    taiyoMorningInitialShortFired.clear();
    taiyoAfternoonReversalFired.clear();
    taiyoMorningInitialShortPending.clear();
    taiyoAfternoonReversalLongPending.clear();
    taiyoAfternoonReversalShortPending.clear();
    peakReversalShortFired.clear();
    advantestHighFadeShortFired.clear();
    advantestConfirmedBreakLongFired.clear();
    advantestPostStopReentry.clear();
    discoConfirmedBreakLongFired.clear();
    discoOpeningBreakShortFired.clear();
    resetThreePeakState(tradeDate); // ★3山v2: 日次リセット
    // B2方式撤廃済み（+D構成）
    currentTradeDate = tradeDate;
    bufferRestored = false; // 日付変更時は復元フラグもリセット
  }
}

/**
 * 285A専用の安全CB SHORT判定。
 * 大幅下落を追いかけるケースと、当日安値から反発済みのケースを除外する。
 */
function shouldBlockSafeCbShort(symbol: string, candle: RtCandle1Min, buffer: CandleWithSignal[]): boolean {
  const config = getSymbolConfig(symbol);
  if (!config.enableSafeCbShort || buffer.length === 0) return false;

  const dayOpen = buffer[0].open;
  const dayLow = dayLowTracker.get(symbol) ?? candle.low;
  const dropFromOpenPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
  const reboundFromDayLowPct = dayLow > 0 ? (candle.close - dayLow) / dayLow * 100 : 0;
  const maxDrop = config.safeCbMaxDropFromOpenPct ?? -8.0;
  const maxRebound = config.safeCbMaxReboundFromDayLowPct ?? 1.0;

  if (dropFromOpenPct <= maxDrop) {
    console.log(
      `[RealtimeSim] ${symbol} 安全CB SHORTブロック: 始値比${dropFromOpenPct.toFixed(2)}% <= ${maxDrop.toFixed(1)}%（下落末端の追撃回避）`
    );
    return true;
  }
  if (reboundFromDayLowPct >= maxRebound) {
    console.log(
      `[RealtimeSim] ${symbol} 安全CB SHORTブロック: 当日安値から+${reboundFromDayLowPct.toFixed(2)}% >= +${maxRebound.toFixed(1)}%（反発後の追撃回避）`
    );
    return true;
  }
  return false;
}

/**
 * サーバー起動時にDBから当日の1分足のみを読み込んでcandleBuffersを復元する（当日構築モード）
 *
 * 前日以前のバッファは一切引き継がない。サーバーが取引時間中に再起動した場合でも、
 * 当日分のDBに保存済みの足のみからシグナル判定を即座に再開できる。
 */
export async function restoreBuffersFromDb(): Promise<void> {
  if (bufferRestored) return;

  const today = getTodayJst();

  // ★当日構築モード: 前日バッファが残っていた場合は完全クリア
  if (candleBuffers.size > 0) {
    console.log(`[RealtimeSim] 当日構築モード: 既存バッファ${candleBuffers.size}銘柄をクリア`);
    candleBuffers.clear();
    candleCounters.clear();
  }

  try {
    const rows = await getRtCandlesAllForDate(today);
    if (rows.length === 0) {
      console.log(`[RealtimeSim] バッファ復元(当日構築): ${today} の足なし（初回起動）`);
      bufferRestored = true;
      currentTradeDate = today;
      return;
    }

    // 銀柄ごとにグループ化してバッファに追加
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
      grouped.get(row.symbol)!.push(row);
    }

    for (const [symbol, candles] of Array.from(grouped.entries())) {
      const buf: CandleWithSignal[] = candles.map((c) => ({
        time: `${c.tradeDate}T${c.candleTime}:00`,
        dayKey: c.tradeDate,
        timestamp: new Date(`${c.tradeDate}T${c.candleTime}:00+09:00`).getTime(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume ?? 0,
        ma5: null,
        ma25: null,
        rsi: null,
        bbUpper: null,
        bbMiddle: null,
        bbLower: null,
      }));

      // MA5・MA25・RSI・BBを事前計算してバッファに設定
      // （detectSignalsは入力のma5/ma25/rsi/bbをそのまま使うため、事前計算が必須）
      const closesForRestore = buf.map(c => c.close);
      const ma5R = calcMA(closesForRestore, 5);
      const ma25R = calcMA(closesForRestore, 25);
      const rsiR = calcRSI(closesForRestore, 14);
      const bbR = calcBollinger(closesForRestore, 20);
      buf.forEach((c, i) => {
        c.ma5 = ma5R[i];
        c.ma25 = ma25R[i];
        c.rsi = rsiR[i];
        c.bbUpper = bbR.upper[i];
        c.bbMiddle = bbR.middle[i];
        c.bbLower = bbR.lower[i];
      });

      // detectSignalsでシグナルを一括計算してバッファを初期化
      const withSignals = detectSignals(buf);
      candleBuffers.set(symbol, withSignals);
      candleCounters.set(symbol, candles.length);

      // 反転LONG/SHORT用の当日高値・安値・高値位置を復元
      if (withSignals.length > 0) {
        const dayHigh = Math.max(...withSignals.map(c => c.high));
        const dayLow = Math.min(...withSignals.map(c => c.low));
        const dayHighIndex = withSignals.findIndex(c => c.high === dayHigh);
        dayHighTracker.set(symbol, dayHigh);
        dayLowTracker.set(symbol, dayLow);
        dayHighIndexTracker.set(symbol, dayHighIndex);
      }
    }

    currentTradeDate = today;
    bufferRestored = true;
    console.log(`[RealtimeSim] バッファ復元完了(当日構築): ${today} / ${grouped.size}銀柄 / 合計1分足${rows.length}本`);

    // ---- オープンポジションのDBからの復元 ----
    try {
      const dbOpenTrades = await getRtOpenPositionsFromDb(today);
      if (dbOpenTrades.length > 0) {
        for (const entry of dbOpenTrades) {
          if (!openPositions.has(entry.symbol)) {
            const symbolConfig = getSymbolConfig(entry.symbol);
            const isReversalShort = entry.side === "short" && entry.reason.includes("反転SHORT");
            const isAfternoonLowBreakShort = entry.side === "short" && entry.reason.includes("後場安値更新SHORT");
            const isLowReversalBreakLong = entry.side === "long" && entry.reason.includes("安値反転ブレイクLONG");
            const isHighFadeBreakShort = entry.side === "short" && entry.reason.includes("高値失速ブレイクSHORT");
            const isOpeningBreakShort = entry.side === "short" && entry.reason.includes("寄り付きブレイクSHORT");
            const isTaiyoStrategy = entry.reason.includes("太陽誘電朝初動SHORT") || entry.reason.includes("太陽誘電後場反転");
            const isAdvantestHighFadeShort = entry.side === "short" && entry.reason.includes("アドバンテスト高値失速SHORT");
            const isAdvantestConfirmedBreakLong = entry.side === "long" && entry.reason.includes("アドバンテスト確認型LONG");
            const isDiscoConfirmedBreakLong = entry.side === "long" && entry.reason.includes("ディスコ確認型10本高値更新LONG");
            const isDiscoOpeningBreakShort = entry.side === "short" && entry.reason.includes("ディスコ寄り付き10本安値更新SHORT");
            openPositions.set(entry.symbol, {
              symbol: entry.symbol,
              side: entry.side as "long" | "short",
              entryPrice: Number(entry.price),
              shares: entry.shares,
              entryTime: entry.tradeTime,
              entryReason: entry.reason,
              slPctOverride: isReversalShort
                ? symbolConfig.reversalShortSlPct
                : isAfternoonLowBreakShort
                  ? symbolConfig.afternoonLowBreakShortSlPct
                  : isLowReversalBreakLong
                    ? symbolConfig.lowReversalBreakLongSlPct
                    : isHighFadeBreakShort
                      ? symbolConfig.highFadeBreakShortSlPct
                      : isOpeningBreakShort
                        ? symbolConfig.openingBreakShortSlPct
                        : isTaiyoStrategy
                          ? symbolConfig.taiyoAfternoonSlPct ?? symbolConfig.taiyoMorningInitialShortSlPct
                          : isAdvantestHighFadeShort
                            ? symbolConfig.advantestHighFadeShortSlPct
                            : isAdvantestConfirmedBreakLong
                              ? symbolConfig.advantestConfirmedBreakLongSlPct
                              : isDiscoConfirmedBreakLong
                                ? symbolConfig.discoConfirmedBreakLongSlPct
                                : isDiscoOpeningBreakShort
                                  ? symbolConfig.discoOpeningBreakShortSlPct
                            : undefined,
              tpPctOverride: isReversalShort
                ? symbolConfig.reversalShortTpPct
                : isAfternoonLowBreakShort
                  ? symbolConfig.afternoonLowBreakShortTpPct
                  : isLowReversalBreakLong
                    ? symbolConfig.lowReversalBreakLongTpPct
                    : isHighFadeBreakShort
                      ? symbolConfig.highFadeBreakShortTpPct
                      : isOpeningBreakShort
                        ? symbolConfig.openingBreakShortTpPct
                        : isTaiyoStrategy
                          ? symbolConfig.taiyoAfternoonTpPct ?? symbolConfig.taiyoMorningInitialShortTpPct
                          : isAdvantestHighFadeShort
                            ? symbolConfig.advantestHighFadeShortTpPct
                            : isAdvantestConfirmedBreakLong
                              ? symbolConfig.advantestConfirmedBreakLongTpPct
                              : isDiscoConfirmedBreakLong
                                ? symbolConfig.discoConfirmedBreakLongTpPct
                                : isDiscoOpeningBreakShort
                                  ? symbolConfig.discoOpeningBreakShortTpPct
                            : undefined,
            });
          }
        }
        console.log(`[RealtimeSim] オープンポジション復元: ${dbOpenTrades.length}件 (${dbOpenTrades.map(t => t.symbol).join(", ")})`);
      }
    } catch (posErr) {
      console.error("[RealtimeSim] オープンポジション復元エラー:", posErr);
    }

    // ---- シグナル履歴のDBからの復元 ----
    try {
      const allTrades = await getRtTradesForDate(today);
      if (allTrades.length > 0 && signalHistory.length === 0) {
        let latestAdvantestSpecialSide: "long" | "short" | null = null;
        for (const t of allTrades.slice().reverse()) {
          signalHistory.push({
            time: t.tradeTime,
            symbol: t.symbol,
            symbolName: t.symbolName ?? getStockName(t.symbol),
            action: t.action,
            price: Number(t.price),
            shares: t.shares,
            pnl: t.pnl !== null ? Number(t.pnl) : null,
            reason: t.reason,
          });

          const isAdvantestShort = t.symbol === "6857" && t.reason.startsWith("アドバンテスト高値失速SHORT");
          const isAdvantestLong = t.symbol === "6857" && t.reason.startsWith("アドバンテスト確認型LONG");
          const isDiscoLong = t.symbol === "6146" && t.reason.startsWith("ディスコ確認型10本高値更新LONG");
          const isDiscoShort = t.symbol === "6146" && t.reason.startsWith("ディスコ寄り付き10本安値更新SHORT");
          if (isDiscoLong && t.action === "buy") discoConfirmedBreakLongFired.add("6146");
          if (isDiscoShort && t.action === "short") discoOpeningBreakShortFired.add("6146");
          if (isAdvantestShort && t.action === "short") {
            advantestHighFadeShortFired.add("6857");
            latestAdvantestSpecialSide = "short";
            if (t.reason.includes("損切り後再評価")) {
              const state = advantestPostStopReentry.get("6857") ?? { stoppedSide: "long" as const, stopTime: t.tradeTime, reentryUsed: false };
              state.reentryUsed = true;
              advantestPostStopReentry.set("6857", state);
            }
          } else if (isAdvantestLong && t.action === "buy") {
            advantestConfirmedBreakLongFired.add("6857");
            latestAdvantestSpecialSide = "long";
            if (t.reason.includes("損切り後再評価")) {
              const state = advantestPostStopReentry.get("6857") ?? { stoppedSide: "short" as const, stopTime: t.tradeTime, reentryUsed: false };
              state.reentryUsed = true;
              advantestPostStopReentry.set("6857", state);
            }
          } else if (
            t.symbol === "6857" &&
            (t.action === "sell" || t.action === "cover") &&
            t.reason.startsWith("損切り") &&
            latestAdvantestSpecialSide !== null
          ) {
            advantestPostStopReentry.set("6857", { stoppedSide: latestAdvantestSpecialSide, stopTime: t.tradeTime, reentryUsed: false });
            latestAdvantestSpecialSide = null;
          } else if (t.symbol === "6857" && (t.action === "sell" || t.action === "cover")) {
            latestAdvantestSpecialSide = null;
          }
        }
        if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;
        console.log(`[RealtimeSim] シグナル履歴復元: ${signalHistory.length}件`);
      }
    } catch (sigErr) {
      console.error("[RealtimeSim] シグナル履歴復元エラー:", sigErr);
    }

  } catch (err) {
    console.error("[RealtimeSim] バッファ復元エラー:", err);
    // エラー時は復元済みにしない（次回のリクエストで再試行する）
  }
}

/**
 * 現在のオープンポジション合計投資額を計算する
 */
function calcCurrentExposure(): number {
  let total = 0;
  for (const pos of Array.from(openPositions.values())) {
    total += pos.entryPrice * pos.shares;
  }
  return total;
}

/**
 * ロット計算: 元金 × LOT_RATIO / 株価 → 株数（100株単位切り捨て）
 */
function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

/**
 * 板情報から BoardSnapshot を生成する
 */
function getBoardSnapshot(symbol: string): BoardSnapshot | null {
  const book = getOrderBook(symbol);
  if (!book) return null;

  const signals = analyzeOrderBook(book);
  const totalBidQty = book.bids.reduce((s, b) => s + b.qty, 0) + book.underBuyQty;
  const totalAskQty = book.asks.reduce((s, a) => s + a.qty, 0) + book.overSellQty;
  const totalMarketQty = book.marketOrderBuyQty + book.marketOrderSellQty;
  const totalAll = totalBidQty + totalAskQty + totalMarketQty;

  const buyPressureRatio = totalAskQty > 0 ? totalBidQty / totalAskQty : 1.0;
  const marketOrderRatio = totalAll > 0 ? totalMarketQty / totalAll : 0;
  const largeBuyWall = signals.some(s => s.type === "large_bid_wall");
  const largeSellWall = signals.some(s => s.type === "large_ask_wall");

  let signal: BoardSnapshot["signal"] = "neutral";
  if (signals.some(s => s.type === "board_buy_pressure")) signal = "buy_pressure";
  else if (signals.some(s => s.type === "board_sell_pressure")) signal = "sell_pressure";
  else if (largeBuyWall) signal = "large_buy_wall";
  else if (largeSellWall) signal = "large_sell_wall";
  else if (signals.some(s => s.type === "market_order_surge")) signal = "market_surge";

  // v5拡張フィールドを計算
  const extended = calcExtendedBoardFields(book);

  // v8: 10秒リングバッファの集約結果を追加
  const aggregated = getAggregatedBoardStats(symbol);
  const aggregatedFields = aggregated ? {
    icebergAskCount: aggregated.icebergAskCount,
    icebergBidCount: aggregated.icebergBidCount,
    cancelAskCount: aggregated.cancelAskCount,
    cancelBidCount: aggregated.cancelBidCount,
    avgBprIn10s: aggregated.avgBpr,
    bprDeltaIn10s: aggregated.bprDelta,
    largeTradeDirection: aggregated.largeTradeDirection,
    boardSampleCount: aggregated.sampleCount,
  } : {};

  return {
    buyPressureRatio: Math.round(buyPressureRatio * 100) / 100,
    largeBuyWall,
    largeSellWall,
    marketOrderRatio: Math.round(marketOrderRatio * 1000) / 1000,
    signal,
    ...extended,
    ...aggregatedFields,
  };
}

/** ★v6: 銀柄ごとのbuyPressureRatio履歴（直近5本分） */
const bprHistory = new Map<string, number[]>();

/**
 * ★v7: 歩み値方向推定（改良案B）
 * marketOrderDirectionフィールド + BPRトレンド/絶対値から約定方向を推定
 */
function estimateTickDirection(symbol: string, snapshot: BoardSnapshot | null): "uptick" | "downtick" | "neutral" {
  if (!snapshot) return "neutral";
  
  // marketOrderDirectionが明確な場合はそれを使用
  const mod = (snapshot as any).marketOrderDirection;
  if (mod === "buy") return "uptick";
  if (mod === "sell") return "downtick";
  
  // BPRの直近トレンドで判定
  const history = bprHistory.get(symbol) ?? [];
  if (history.length < 3) return "neutral";
  const first = history[0];
  const last = history[history.length - 1];
  const trend = last - first;
  
  // BPRが明確に上昇トレンド → 買い圧力増加 → アップティック
  if (trend >= 0.2) return "uptick";
  if (trend <= -0.2) return "downtick";
  
  // BPRの絶対値で判定（強い買い圧力/売り圧力）
  if (last >= 1.3) return "uptick";
  if (last <= 0.7) return "downtick";
  
  return "neutral";
}

/**
 * ★v7: 見せ板検出強化（改良案C）
 * データの既存フラグ（askCancelDetected/bidCancelDetected/icebergAskDetected/icebergBidDetected）を直接活用
 */
function detectFakeOrder(snapshot: BoardSnapshot | null): { cancelDetected: boolean; icebergDetected: boolean; icebergSide: "buy" | "sell" | null } {
  if (!snapshot) return { cancelDetected: false, icebergDetected: false, icebergSide: null };
  
  const snap = snapshot as any;
  
  // キャンセル検出: データの既存フラグを使用
  const cancelDetected = !!(snap.askCancelDetected || snap.bidCancelDetected);
  
  // アイスバーグ検出: データの既存フラグを使用
  let icebergDetected = false;
  let icebergSide: "buy" | "sell" | null = null;
  
  if (snap.icebergAskDetected) {
    // 売り板にアイスバーグ → 売り板が食われている → 買い方向の勢い
    icebergDetected = true;
    icebergSide = "buy";
  }
  if (snap.icebergBidDetected) {
    // 買い板にアイスバーグ → 買い板が食われている → 売り方向の勢い
    icebergDetected = true;
    icebergSide = "sell";
  }
  
  return { cancelDetected, icebergDetected, icebergSide };
}

/**
 * ★v7: 板読みスコアを計算する
 *
 * 7要素の統合スコア:
 * A) アグレッシブ注文検出 (±2): marketOrderRatio≧ 0.08で方向判定
  * B) 厚い板のアノマリー (±1): largeBuyWall/largeSellWall
  * C) 板圧力トレンド (±1): 直近5本のbpr変化量≧ 0.15
  * D) 相場モード判定 (+1/-2): active/building→+1, trap/quiet→-2、キャンセル検出時はtrap強制
  * E) 板圧力の強さ (±1): bpr≧ 1.4(買い圧力強) or bpr≦ 0.65(売り圧力強)
  * F) 歩み値方向推定 (±2): marketOrderDirection + BPRトレンドで約定方向を推定
  * G) アイスバーグ検出 (±1): エントリー方向と一致すれば+1、逆方向なら-1
  * J) neutral時SHORT減点 (-2): boardSignal=neutral時のSHORTを抑制
  */
export function boardReadingScore(symbol: string, side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1; // 板情報なし → 中立（シグナルを通す）

  let score = 0;
  const bpr = snapshot.buyPressureRatio;

  // 要素A: アグレッシブ注文検出 (±2)
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr >= 0.8 && bpr <= 1.2) score += 2;  // ★案A: 均衡〜やや買い優勢が最適帯
    else if (side === "long" && bpr < 0.8) score -= 2;             // 売り圧力強い
    else if (side === "long" && bpr >= 1.5) score -= 2;            // ★案A: 過熱（天井掴みリスク）
    // BPR 1.2〜1.5のLONGは加減点なし（中立）
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }

  // 要素B: 厚い板のアノマリー (±1)
  // 「板の厚い方に動く」→ 逆側の壁はブレイクスルーのサイン
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;  // 売り壁を突破する勢い
    if (snapshot.largeBuyWall) score -= 1;   // 買い壁がサポート→過信になりやすい
  } else {
    if (snapshot.largeBuyWall) score += 1;   // 買い壁を突破する勢い
    if (snapshot.largeSellWall) score -= 1;  // 売り壁がサポート→過信になりやすい
  }

  // 要素C: 板圧力トレンド (±1)
  const history = bprHistory.get(symbol) ?? [];
  if (history.length >= 3) {
    const oldest = history[0];
    const newest = history[history.length - 1];
    const delta = newest - oldest;
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }

  // 要素D: 相場モード判定 (+1/-2)
  // ★改良案C: キャンセル検出時はtrap強制
  const { cancelDetected, icebergDetected, icebergSide } = detectFakeOrder(snapshot);
  let mode: "active" | "building" | "trap" | "quiet";
  if (cancelDetected) {
    mode = "trap"; // 見せ板検出 → 強制trap
  } else {
    mode = detectMarketMode(symbol, snapshot);
  }
  if (mode === "active" || mode === "building") {
    score += 1;
  } else if (mode === "trap" || mode === "quiet") {
    score -= 2;
  }

  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.5) score -= 1;    // ★案A: 過熱時は減点（旧: bpr>=1.4で+1）
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;

  // ★要素J: neutral時SHORT減点 (-2)【BPR改善】
  // 本番データ: neutral時SHORT = 25件中1勝24敗 -260,374円
  // 板に方向感がない時のSHORTは反発リスクが高い
  if (side === "short" && snapshot.signal === "neutral") {
    score -= 2;
  }

  // ★要素F: 歩み値方向推定 (±2)【改良案B】
  const tickDir = estimateTickDirection(symbol, snapshot);
  if (tickDir === "uptick") {
    if (side === "long") score += 2; else score -= 2;
  } else if (tickDir === "downtick") {
    if (side === "short") score += 2; else score -= 2;
  }

  // ★要素G: アイスバーグ検出 (±1)【改良案C】
  if (icebergDetected && icebergSide) {
    if (side === "long" && icebergSide === "buy") score += 1;
    else if (side === "short" && icebergSide === "sell") score += 1;
    // 逆方向のアイスバーグは減点
    else if (side === "long" && icebergSide === "sell") score -= 1;
    else if (side === "short" && icebergSide === "buy") score -= 1;
  }

  // ★要素H: 10秒集約アイスバーグ強化 (±2)【v8】
  // 直近1分間で2回以上のアイスバーグ検出 = 強い大口の意囷
  const snap = snapshot as any;
  const iceAskCount = snap.icebergAskCount ?? 0;
  const iceBidCount = snap.icebergBidCount ?? 0;
  if (iceAskCount >= 2) {
    // ask側アイスバーグ複数回 = 売り板が食われても補充される = 大口は売りたい
    if (side === "short") score += 2;
    else score -= 2;
  }
  if (iceBidCount >= 2) {
    // bid側アイスバーグ複数回 = 買い板が食われても補充される = 大口は買いたい
    if (side === "long") score += 2;
    else score -= 2;
  }

  // ★要素I: 10秒集約大口約定方向 (±1)【v8】
  const ltDir = snap.largeTradeDirection;
  if (ltDir === "buy") {
    if (side === "long") score += 1; else score -= 1;
  } else if (ltDir === "sell") {
    if (side === "short") score += 1; else score -= 1;
  }

  return score;
}

/**
 * ★v6: 相場モード判定
 * - active: 板圧力が明確に一方向（bpr > 1.2 or bpr < 0.8）
 * - building: 板圧力が徐々に変化中（0.8≤bpr≤1.2でトレンドあり）
 * - trap: 板圧力が強いのに価格が動かない（大口の罠）
 * - quiet: 出来高が極端に少ない（様子見相場）
 */
export function detectMarketMode(symbol: string, snapshot: BoardSnapshot): "active" | "building" | "trap" | "quiet" {
  const bpr = snapshot.buyPressureRatio;
  const history = bprHistory.get(symbol) ?? [];

  // quiet: 板圧力がほぼ1.0で変化がない
  if (history.length >= 3) {
    const allNeutral = history.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  }

  // active: 板圧力が明確に一方向
  if (bpr > 1.2 || bpr < 0.8) return "active";

  // building: 変化トレンドがある
  if (history.length >= 3) {
    const oldest = history[0];
    const newest = history[history.length - 1];
    const delta = Math.abs(newest - oldest);
    if (delta >= 0.1) return "building";
  }

  // trap: 板圧力はあるが変化がない（大口が板を固めている）
  return "trap";
}

/**
 * ★v6: 板読み早期利確チェック
 * 保有中に逆方向の強い板シグナルが出た場合、利益があれば早期利確する
 */
export function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;

  const pnlPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;

  // 利益が最低利益率以上ある場合のみ
  if (pnlPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;

  // 逆方向の強い板シグナルを検出
  if (pos.side === "long") {
    // ロング保有中に売り圧力が強い
    return snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall";
  } else {
    // ショート保有中に買い圧力が強い
    return snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall";
  }
}

// ============================================================
// メインエンジン
// ============================================================

/**
 * 1分足を受信してシミュレーションを実行するメイン関数
 *
 * @param candle 受信した1分足データ
 * @returns 実行結果（取引が発生した場合はその情報）
 */
export async function processCandle(candle: RtCandle1Min): Promise<{
  symbol: string;
  tradeDate: string;
  candleTime: string;
  action: "entry" | "exit" | "stop_loss" | "take_profit" | "forced_close" | "none";
  reason?: string;
  pnl?: number;
}> {
  const { symbol, tradeDate, candleTime } = candle;

  // 昧休み（11:30〜12:29）の足は完全にスキップ（DB保存もしない）
  if (candleTime >= "11:30" && candleTime < "12:30") {
    return { symbol, tradeDate, candleTime, action: "none" as const };
  }

  // 日付変更チェック
  resetIfNewDay(tradeDate);

  // 1分足をDBに保存（取引除外銀柄でもデータは蓄積する）
  const boardSnapshot = getBoardSnapshot(symbol);

  // ★v6: buyPressureRatio履歴を更新（直近5本分保持）
  if (boardSnapshot) {
    const history = bprHistory.get(symbol) ?? [];
    history.push(boardSnapshot.buyPressureRatio);
    if (history.length > 5) history.shift();
    bprHistory.set(symbol, history);
  }

  await insertRtCandle({
    symbol,
    tradeDate,
    candleTime,
    open: String(candle.open),
    high: String(candle.high),
    low: String(candle.low),
    close: String(candle.close),
    volume: candle.volume,
    boardSnapshot,
  });

  // 取引除外銀柄チェック: TARGET_STOCKSに含まれない銀柄またはTRADE_EXCLUDEDの銀柄はデータ保存後にスキップ
  if (!ALLOWED_SYMBOLS.has(symbol) || TRADE_EXCLUDED_SYMBOLS.has(symbol)) {
    return { symbol, tradeDate, candleTime, action: "none" as const };
  }

  // エントリー対象銘柄制限: ACTIVE_ENTRY_SYMBOLSが設定されている場合、対象外銘柄はシグナル検出・データ蓄積は継続するがエントリーはスキップ
  const isEntryAllowed = ACTIVE_ENTRY_SYMBOLS === null || ACTIVE_ENTRY_SYMBOLS.has(symbol);

  // バッファに追加
  if (!candleBuffers.has(symbol)) {
    candleBuffers.set(symbol, []);
  }
  const buffer = candleBuffers.get(symbol)!;

  // CandleWithSignal形式に変換してバッファに追加
  const candleForSignal: CandleWithSignal = {
    time: `${tradeDate}T${candleTime}:00`,
    dayKey: tradeDate,
    timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    ma5: null,
    ma25: null,
    rsi: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  };

  // バッファに追加
  buffer.push(candleForSignal);

  // ★反転LONG: 当日高値を追跡（全銘柄で更新、反転LONG発火条件の判定に使用）
  const prevDayHigh = dayHighTracker.get(symbol) ?? 0;
  if (candle.high > prevDayHigh) {
    dayHighTracker.set(symbol, candle.high);
    dayHighIndexTracker.set(symbol, buffer.length - 1);
  }
  const prevDayLow = dayLowTracker.get(symbol) ?? Number.POSITIVE_INFINITY;
  if (candle.low < prevDayLow) dayLowTracker.set(symbol, candle.low);

  // MA5・MA25・RSI・BBを計算してバッファの最新足に設定
  // （detectSignalsは入力のma5/ma25/rsi/bbをそのまま使うため、事前計算が必須）
  const closes = buffer.map(c => c.close);
  const ma5Series = calcMA(closes, 5);
  const ma25SeriesCalc = calcMA(closes, 25);
  const rsiSeries = calcRSI(closes, 14);
  const bbSeries = calcBollinger(closes, 20);
  const lastIdx = buffer.length - 1;
  buffer[lastIdx].ma5 = ma5Series[lastIdx];
  buffer[lastIdx].ma25 = ma25SeriesCalc[lastIdx];
  buffer[lastIdx].rsi = rsiSeries[lastIdx];
  buffer[lastIdx].bbUpper = bbSeries.upper[lastIdx];
  buffer[lastIdx].bbMiddle = bbSeries.middle[lastIdx];
  buffer[lastIdx].bbLower = bbSeries.lower[lastIdx];

  // カウンター更新
  candleCounters.set(symbol, (candleCounters.get(symbol) ?? 0) + 1);
  // 最後受信時刻を更新（接続監視用）
  lastCandleReceivedAt = new Date().toISOString();

  // 日次サマリーを更新（受信足数のみ）
  await updateDailySummary(tradeDate);

  // ★3山v2シグナル検出（ログ記録のみ、エントリーなし）
  // 6981のみ対象。現行エンジンの動作には一切影響しない。
  await processThreePeakCandle(symbol, tradeDate, candleTime, candle.open, candle.high, candle.low, candle.close, candle.volume);

  // ウォームアップ期間中はシグナル判定しない
  if (buffer.length < MIN_CANDLES_FOR_SIGNAL) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 既存ポジションの損切り・利確チェック ----
  const existingPos = openPositions.get(symbol);
  if (existingPos) {
    const result = await checkExitConditions(existingPos, candle, tradeDate, candleTime, boardSnapshot);
    if (result.action !== "none") {
      return result;
    }
  }

  // ---- 前場強制決済チェック (11:27) ----
  if (candleTime >= AM_SESSION_CLOSE_TIME && candleTime < "11:30" && existingPos) {
    return await forceClosePosition(existingPos, candle, tradeDate, candleTime, "前場強制決済");
  }

  // ---- 大引け強制決済チェック ----
  if (candleTime >= MARKET_CLOSE_TIME && existingPos) {
    return await forceClosePosition(existingPos, candle, tradeDate, candleTime, "大引け強制決済");
  }

  // ---- 改善④: 09:30以前エントリー禁止 ----
  if (candleTime < NO_ENTRY_BEFORE) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }
  // ---- 午後エントリー禁止 ----
  if (candleTime >= NO_ENTRY_AFTER) {
  return { symbol, tradeDate, candleTime, action: "none" };
  }
  // ---- 後場序盤（12:30-12:50）エントリー禁止 ----
  if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 既にポジションがある場合は新規エントリーしない ----
  if (existingPos) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- ★反転LONG: 銘柄別設定で反転LONGが有効な場合の検出 ----
  // 大台超えLONGの代替として、当日高値からの下落後に反転上昇を検出してLONGエントリー
  const symConfig = getSymbolConfig(symbol);
  if (symConfig.enableReversalLong && !reversalLongFired.has(symbol) && isEntryAllowed) {
    const dropPct = symConfig.reversalLongDropPct ?? 2.5;
    const amOnly = symConfig.reversalLongAmOnly ?? true;

    // 前場のみ制限
    const startTime = symConfig.reversalLongStartTime ?? "09:30";
    const inTimeWindow = amOnly ? (candleTime >= startTime && candleTime <= AM_SESSION_CLOSE_TIME) : true;

    if (inTimeWindow && buffer.length >= IS_BULLISH_MA_PERIOD + 1) {
      const currentDayHigh = dayHighTracker.get(symbol) ?? 0;
      const dropFromHigh = currentDayHigh > 0 ? (currentDayHigh - candle.close) / currentDayHigh * 100 : 0;

      // 条件1: 当日高値からX%以上下落
      if (dropFromHigh >= dropPct) {
        // 条件2: MA8上向き（isBullish）
        const maPeriod = symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD;
        const currentSlice = buffer.slice(buffer.length - maPeriod).map(c => c.close);
        const currentMA = currentSlice.reduce((a, b) => a + b, 0) / maPeriod;
        const prevSlice = buffer.slice(buffer.length - maPeriod - 1, buffer.length - 1).map(c => c.close);
        const prevMA = prevSlice.reduce((a, b) => a + b, 0) / maPeriod;
        const maRising = currentMA > prevMA;

        // 条件3: MA傾き閾値チェック（2本前のMAとの比較）
        const minSlope = symConfig.reversalLongMinSlope ?? 0;
        let slopeOk = true;
        if (minSlope > 0 && buffer.length >= maPeriod + 2) {
          const slice2ago = buffer.slice(buffer.length - maPeriod - 2, buffer.length - 2).map(c => c.close);
          const ma2ago = slice2ago.reduce((a, b) => a + b, 0) / maPeriod;
          const maSlope = ma2ago > 0 ? (currentMA - ma2ago) / ma2ago * 100 : 0;
          slopeOk = maSlope >= minSlope;
        }

        // 条件4: 直近10本の高値を更新
        const lookback = Math.min(10, buffer.length - 1);
        const recent10Highs = buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(c => c.high);
        const recent10High = recent10Highs.length > 0 ? Math.max(...recent10Highs) : 0;
        const highBreak = candle.high > recent10High;

        if (maRising && highBreak && slopeOk) {
          reversalLongFired.add(symbol);
          console.log(
            `[RealtimeSim] ${symbol} ★反転LONG発火: 高値${currentDayHigh}→現在${candle.close} ` +
            `(落${dropFromHigh.toFixed(1)}% >= ${dropPct}%) MA${maPeriod}上向き + 傾き>=0.02% + 直近10本高値更新`
          );
          // sell_pressure時はブロック
          const boardSnapshot2 = getBoardSnapshot(symbol);
          if (boardSnapshot2 && boardSnapshot2.signal === "sell_pressure") {
            console.log(`[RealtimeSim] ${symbol} 反転LONG: sell_pressure時ブロック`);
            return { symbol, tradeDate, candleTime, action: "none" };
          }
          return await enterPosition("long", candle, tradeDate, candleTime, `反転LONG: 高値${currentDayHigh}から${dropFromHigh.toFixed(1)}%下落後の反転 (前場)`, boardSnapshot);
        }
      }
    }
  }

  // ---- シグナル検出 ----
  // バッファ全体にdetectSignalsを適用（MA/RSI/BBを計算するため）
  const withSignals = detectSignals(buffer);
  const latestSignal = withSignals[withSignals.length - 1];

  // バッファのMA/RSI/BB値を更新（次回以降の計算効率化）
  buffer[buffer.length - 1] = latestSignal;

  const sig = latestSignal.signal;
  const isRoundBreakdownSignal = sig?.type === "sell" && sig.reason.startsWith("大台割れ");
  // 安全CBをブロックする場面では、同一足の反転SHORTを評価できるようにする。
  const safeCbBlockedNow = isRoundBreakdownSignal && shouldBlockSafeCbShort(symbol, candle, buffer);

  // ---- ★285A反転SHORT: 上昇後の明確な反落を捉える ----
  // 安全な大台割れCBが同じ足で出ている場合はCBを優先する。
  if (
    symConfig.enableReversalShort &&
    !reversalShortFired.has(symbol) &&
    isEntryAllowed &&
    (!isRoundBreakdownSignal || safeCbBlockedNow) &&
    buffer.length >= (symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD) + 1
  ) {
    const startTime = symConfig.reversalShortStartTime ?? "09:45";
    const endTime = symConfig.reversalShortEndTime ?? "14:30";
    if (candleTime >= startTime && candleTime <= endTime) {
      const dayOpen = buffer[0]?.open ?? candle.open;
      const dayHigh = dayHighTracker.get(symbol) ?? candle.high;
      const riseFromOpenPct = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
      const dropFromHighPct = dayHigh > 0 ? (dayHigh - candle.close) / dayHigh * 100 : 0;
      const minRise = symConfig.reversalShortMinRisePct ?? 3.0;
      const minDrop = symConfig.reversalShortDropPct ?? 1.5;

      if (riseFromOpenPct >= minRise && dropFromHighPct >= minDrop) {
        const maPeriod = symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD;
        const currentSlice = buffer.slice(buffer.length - maPeriod).map(c => c.close);
        const currentMA = currentSlice.reduce((sum, value) => sum + value, 0) / maPeriod;
        const prevSlice = buffer.slice(buffer.length - maPeriod - 1, buffer.length - 1).map(c => c.close);
        const previousMA = prevSlice.reduce((sum, value) => sum + value, 0) / maPeriod;
        const maFalling = currentMA < previousMA;

        const lookback = Math.min(10, buffer.length - 1);
        const recent10Lows = buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(c => c.low);
        const recent10Low = recent10Lows.length ? Math.min(...recent10Lows) : Number.NEGATIVE_INFINITY;
        const lowBreak = candle.low < recent10Low;

        if (maFalling && lowBreak) {
          reversalShortFired.add(symbol);
          const slPct = symConfig.reversalShortSlPct ?? 0.8;
          const tpPct = symConfig.reversalShortTpPct ?? 1.5;
          console.log(
            `[RealtimeSim] ${symbol} ★反転SHORT発火: 始値比+${riseFromOpenPct.toFixed(1)}% ` +
            `高値${dayHigh}→現在${candle.close}（落${dropFromHighPct.toFixed(1)}%） ` +
            `MA${maPeriod}下向き + 直近10本安値更新 (SL${slPct}%/TP${tpPct}%)`
          );
          return await enterPosition(
            "short",
            candle,
            tradeDate,
            candleTime,
            `反転SHORT: 始値+${riseFromOpenPct.toFixed(1)}%後、高値から${dropFromHighPct.toFixed(1)}%反落`,
            boardSnapshot,
            { slPct, tpPct },
          );
        }
      }
    }
  }

  // ---- ★285A順張り: 明確な上昇・下落の継続局面を捉える ----
  // 既存の反転シグナルが先に成立した場合は上記でreturnするため、反転を優先する。
  // 順張りSHORTでは、安全な大台割れCBが同一足にある場合にCBを優先する。
  if (isEntryAllowed && buffer.length >= 21) {
    const dayOpen = buffer[0]?.open ?? candle.open;
    const maPeriod = symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD;
    const canCalcMa = buffer.length >= maPeriod + 2;
    const currentMA = canCalcMa
      ? buffer.slice(buffer.length - maPeriod).reduce((sum, item) => sum + item.close, 0) / maPeriod
      : 0;
    const prevMA = canCalcMa
      ? buffer.slice(buffer.length - maPeriod - 1, buffer.length - 1).reduce((sum, item) => sum + item.close, 0) / maPeriod
      : 0;
    const ma2Ago = canCalcMa
      ? buffer.slice(buffer.length - maPeriod - 2, buffer.length - 2).reduce((sum, item) => sum + item.close, 0) / maPeriod
      : 0;
    const maSlope2 = ma2Ago > 0 ? (currentMA - ma2Ago) / ma2Ago * 100 : 0;
    const openGainPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
    const recentVolumes = buffer.slice(buffer.length - 21, buffer.length - 1);
    const avgVolume = recentVolumes.reduce((sum, item) => sum + item.volume, 0) / recentVolumes.length;
    const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;

    // ---- ★6146: 確認型10本高値更新LONG ----
    // 当該1分足の終値で高値更新・VWAP上・MA8上向き・出来高増を確認して直接エントリーする。
    // 板情報は記録のみとし、過学習を避けるため新たな板フィルターは加えない。
    if (
      symConfig.enableDiscoConfirmedBreakLong &&
      !discoConfirmedBreakLongFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.discoConfirmedBreakLongStartTime ?? "09:30") &&
      candleTime <= (symConfig.discoConfirmedBreakLongEndTime ?? "14:30")
    ) {
      const lookback = symConfig.discoConfirmedBreakLongHighLookback ?? 10;
      const priorCandles = buffer.slice(buffer.length - 1 - lookback, buffer.length - 1);
      const recentHigh = priorCandles.length >= lookback
        ? Math.max(...priorCandles.map(item => item.high))
        : Number.POSITIVE_INFINITY;
      const cumulativeVolume = buffer.reduce((sum, item) => sum + item.volume, 0);
      const cumulativePriceVolume = buffer.reduce(
        (sum, item) => sum + ((item.high + item.low + item.close) / 3) * item.volume,
        0,
      );
      const vwap = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : candle.close;
      // 6146の事前検証で用いた、現在MA8と直前MA8の1本差分を傾きとする。
      const maSlopePct = prevMA > 0 ? (currentMA - prevMA) / prevMA * 100 : 0;
      const longOk =
        priorCandles.length >= lookback &&
        candle.close > recentHigh &&
        candle.close > vwap &&
        maSlopePct >= (symConfig.discoConfirmedBreakLongMinMaSlopePct ?? 0.02) &&
        volumeRatio >= (symConfig.discoConfirmedBreakLongMinVolumeRatio ?? 1.2);

      if (longOk) {
        const slPct = symConfig.discoConfirmedBreakLongSlPct ?? 0.5;
        const tpPct = symConfig.discoConfirmedBreakLongTpPct ?? 1.8;
        console.log(
          `[RealtimeSim] ${symbol} ★ディスコ確認型10本高値更新LONG発火: ` +
          `終値${candle.close} > 直前${lookback}本高値${recentHigh}・VWAP${vwap.toFixed(1)}・` +
          `MA8傾き${maSlopePct.toFixed(3)}%・出来高${volumeRatio.toFixed(2)}倍 (SL${slPct}%/TP${tpPct}%)`,
        );
        const result = await enterPosition(
          "long",
          candle,
          tradeDate,
          candleTime,
          `ディスコ確認型10本高値更新LONG: VWAP上、MA8傾き${maSlopePct.toFixed(3)}%、出来高${volumeRatio.toFixed(2)}倍`,
          boardSnapshot,
          { slPct, tpPct },
        );
        if (result.action === "entry") discoConfirmedBreakLongFired.add(symbol);
        return result;
      }
    }

    // ---- ★6146: 寄り付き10本安値更新SHORT ----
    // 前場の下落初動のみを、当該1分足終値による安値更新で捉える。1本確認待ちは置かない。
    if (
      symConfig.enableDiscoOpeningBreakShort &&
      !discoOpeningBreakShortFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.discoOpeningBreakShortStartTime ?? "09:30") &&
      candleTime <= (symConfig.discoOpeningBreakShortEndTime ?? "10:45")
    ) {
      const lookback = symConfig.discoOpeningBreakShortLowLookback ?? 10;
      const priorCandles = buffer.slice(buffer.length - 1 - lookback, buffer.length - 1);
      const recentLow = priorCandles.length >= lookback
        ? Math.min(...priorCandles.map(item => item.low))
        : Number.NEGATIVE_INFINITY;
      // LONGと同じく、事前検証に合わせて1本差分のMA8傾きを使う。
      const maSlopePct = prevMA > 0 ? (currentMA - prevMA) / prevMA * 100 : 0;
      const shortOk =
        priorCandles.length >= lookback &&
        openGainPct <= (symConfig.discoOpeningBreakShortMaxOpenGainPct ?? -1.0) &&
        candle.close < recentLow &&
        maSlopePct <= (symConfig.discoOpeningBreakShortMaxMaSlopePct ?? 0) &&
        volumeRatio >= (symConfig.discoOpeningBreakShortMinVolumeRatio ?? 0.8);

      if (shortOk) {
        const slPct = symConfig.discoOpeningBreakShortSlPct ?? 0.5;
        const tpPct = symConfig.discoOpeningBreakShortTpPct ?? 2.0;
        console.log(
          `[RealtimeSim] ${symbol} ★ディスコ寄り付き10本安値更新SHORT発火: ` +
          `始値比${openGainPct.toFixed(2)}%・終値${candle.close} < 直前${lookback}本安値${recentLow}・` +
          `MA8傾き${maSlopePct.toFixed(3)}%・出来高${volumeRatio.toFixed(2)}倍 (SL${slPct}%/TP${tpPct}%)`,
        );
        const result = await enterPosition(
          "short",
          candle,
          tradeDate,
          candleTime,
          `ディスコ寄り付き10本安値更新SHORT: 始値比${openGainPct.toFixed(2)}%、MA8傾き${maSlopePct.toFixed(3)}%、出来高${volumeRatio.toFixed(2)}倍`,
          boardSnapshot,
          { slPct, tpPct },
        );
        if (result.action === "entry") discoOpeningBreakShortFired.add(symbol);
        return result;
      }
    }

    // 順張りLONG: 10:15以降、始値以上、MA8上向き、20本高値更新、陽線、出来高1.2倍。
    if (
      symConfig.enableTrendLong &&
      !trendLongFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.trendLongStartTime ?? "10:15") &&
      candleTime <= (symConfig.trendLongEndTime ?? "14:20")
    ) {
      const lookback = symConfig.trendLongHighLookback ?? 20;
      const recentHigh = Math.max(...buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(item => item.high));
      const highBreak = candle.high > recentHigh;
      const trendLongOk =
        openGainPct >= (symConfig.trendLongMinOpenGainPct ?? 0) &&
        openGainPct <= (symConfig.trendLongMaxOpenGainPct ?? Number.POSITIVE_INFINITY) &&
        currentMA > prevMA &&
        maSlope2 >= 0.02 &&
        highBreak &&
        candle.close > candle.open &&
        volumeRatio >= (symConfig.trendLongMinVolumeRatio ?? 1.2);

      if (trendLongOk) {
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        const trendBoard = getBoardSnapshot(symbol);
        const trendBoardScore = boardReadingScore(symbol, "long", trendBoard);
        const trendBpr = trendBoard?.buyPressureRatio ?? 0;
        const trendBprMax = symConfig.trendBoardBprMax;
        if (htfTrend === "down") {
          console.log(`[RealtimeSim] ${symbol} 順張りLONG: 3分足HTF downでブロック`);
        } else if (trendBoard?.signal === "sell_pressure") {
          console.log(`[RealtimeSim] ${symbol} 順張りLONG: sell_pressureでブロック`);
        } else if (trendBprMax !== undefined && trendBpr > trendBprMax) {
          console.log(`[RealtimeSim] ${symbol} 順張りLONG: BPR過熱(${trendBpr.toFixed(2)} > ${trendBprMax})でブロック`);
        } else if (trendBoardScore < BOARD_SCORE_THRESHOLD) {
          console.log(`[RealtimeSim] ${symbol} 順張りLONG: 板読みスコア不足(${trendBoardScore})でブロック`);
        } else {
          trendLongFired.add(symbol);
          const slPct = symConfig.trendLongSlPct ?? 0.6;
          const tpPct = symConfig.trendLongTpPct ?? 0.8;
          console.log(`[RealtimeSim] ${symbol} ★順張りLONG発火: 始値比+${openGainPct.toFixed(1)}%・20本高値更新・出来高${volumeRatio.toFixed(1)}倍 (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition("long", candle, tradeDate, candleTime, `順張りLONG: 始値比+${openGainPct.toFixed(1)}%、20本高値更新、出来高${volumeRatio.toFixed(1)}倍`, trendBoard, { slPct, tpPct });
        }
      }
    }

    // ---- ★6976: 朝初動SHORT ----
    // 寄り付き直後の最初の5分レンジを下抜け、出来高を伴って下落が継続した場合だけを1本確認で捉える。
    if (
      symConfig.enableTaiyoMorningInitialShort &&
      !taiyoMorningInitialShortFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.taiyoMorningInitialShortStartTime ?? "09:30") &&
      candleTime <= (symConfig.taiyoMorningInitialShortEndTime ?? "11:20")
    ) {
      const rangeBars = symConfig.taiyoMorningInitialShortRangeBars ?? 5;
      const openingRange = buffer.slice(0, Math.min(rangeBars, buffer.length));
      const openingRangeLow = Math.min(...openingRange.map(item => item.low));
      const morningShortOk =
        openingRange.length >= rangeBars &&
        candle.close < openingRangeLow &&
        candle.close < candle.open &&
        currentMA < prevMA &&
        maSlope2 <= -0.02 &&
        volumeRatio >= (symConfig.taiyoMorningInitialShortMinVolumeRatio ?? 2.2);
      const pending = taiyoMorningInitialShortPending.get(symbol);
      if (pending && candleTime > pending.triggerTime) {
        taiyoMorningInitialShortPending.delete(symbol);
        if (candle.close < pending.triggerClose && candle.close < candle.open) {
          taiyoMorningInitialShortFired.add(symbol);
          const slPct = symConfig.taiyoMorningInitialShortSlPct ?? 1.0;
          const tpPct = symConfig.taiyoMorningInitialShortTpPct ?? 1.5;
          console.log(`[RealtimeSim] ${symbol} ★太陽誘電朝初動SHORT発火: 1本確認・5分安値下抜け・出来高${volumeRatio.toFixed(2)}倍 (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition("short", candle, tradeDate, candleTime, `太陽誘電朝初動SHORT: 1本確認、5分安値下抜け、出来高${volumeRatio.toFixed(2)}倍`, boardSnapshot, { slPct, tpPct });
        }
        console.log(`[RealtimeSim] ${symbol} 太陽誘電朝初動SHORT: 1本確認が不成立で取消`);
      } else if (morningShortOk) {
        taiyoMorningInitialShortPending.set(symbol, { triggerClose: candle.close, triggerTime: candleTime });
        console.log(`[RealtimeSim] ${symbol} 太陽誘電朝初動SHORT: 初動検出、次の1本を確認待ち`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }

    // ---- ★6976: 前場偏り後の後場反転LONG/SHORT ----
    // 前場で3%以上一方向に偏った日のみ、安値/高値から1%以上の反転と5本ブレイクを1本確認で捉える。
    if (
      (symConfig.enableTaiyoAfternoonReversalLong || symConfig.enableTaiyoAfternoonReversalShort) &&
      !taiyoAfternoonReversalFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.taiyoAfternoonReversalStartTime ?? "12:50") &&
      candleTime <= (symConfig.taiyoAfternoonReversalEndTime ?? "14:20")
    ) {
      const morningCandles = buffer.filter(item => item.time.slice(11, 16) < "12:00");
      const morningClose = morningCandles[morningCandles.length - 1]?.close ?? dayOpen;
      const morningMovePct = dayOpen > 0 ? (morningClose - dayOpen) / dayOpen * 100 : 0;
      const dayLow = dayLowTracker.get(symbol) ?? candle.low;
      const dayHigh = dayHighTracker.get(symbol) ?? candle.high;
      const reversalPctFromLow = dayLow > 0 ? (candle.close - dayLow) / dayLow * 100 : 0;
      const reversalPctFromHigh = dayHigh > 0 ? (dayHigh - candle.close) / dayHigh * 100 : 0;
      const lookback = symConfig.taiyoAfternoonHighLowLookback ?? 5;
      const recentHigh = Math.max(...buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(item => item.high));
      const recentLow = Math.min(...buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(item => item.low));
      const minMorningMove = symConfig.taiyoAfternoonMinMorningMovePct ?? 3.0;
      const minReversal = symConfig.taiyoAfternoonMinReversalPct ?? 1.0;
      const longTrigger =
        symConfig.enableTaiyoAfternoonReversalLong &&
        morningMovePct <= -minMorningMove &&
        reversalPctFromLow >= minReversal &&
        candle.close > recentHigh &&
        candle.close > candle.open &&
        currentMA > prevMA &&
        maSlope2 >= 0.02 &&
        volumeRatio >= (symConfig.taiyoAfternoonLongMinVolumeRatio ?? 1.5);
      const shortTrigger =
        symConfig.enableTaiyoAfternoonReversalShort &&
        morningMovePct >= minMorningMove &&
        reversalPctFromHigh >= minReversal &&
        candle.close < recentLow &&
        candle.close < candle.open &&
        currentMA < prevMA &&
        maSlope2 <= -0.02 &&
        volumeRatio >= (symConfig.taiyoAfternoonShortMinVolumeRatio ?? 1.2);
      const longPending = taiyoAfternoonReversalLongPending.get(symbol);
      const shortPending = taiyoAfternoonReversalShortPending.get(symbol);
      if (longPending && candleTime > longPending.triggerTime) {
        taiyoAfternoonReversalLongPending.delete(symbol);
        if (candle.close > longPending.triggerClose && candle.close > candle.open) {
          taiyoAfternoonReversalFired.add(symbol);
          const slPct = symConfig.taiyoAfternoonSlPct ?? 1.0;
          const tpPct = symConfig.taiyoAfternoonTpPct ?? 1.5;
          console.log(`[RealtimeSim] ${symbol} ★太陽誘電後場反転LONG発火: 1本確認・前場${morningMovePct.toFixed(2)}%・安値反発${reversalPctFromLow.toFixed(2)}% (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition("long", candle, tradeDate, candleTime, `太陽誘電後場反転LONG: 1本確認、前場${morningMovePct.toFixed(2)}%、安値反発${reversalPctFromLow.toFixed(2)}%`, boardSnapshot, { slPct, tpPct });
        }
        console.log(`[RealtimeSim] ${symbol} 太陽誘電後場反転LONG: 1本確認が不成立で取消`);
      } else if (shortPending && candleTime > shortPending.triggerTime) {
        taiyoAfternoonReversalShortPending.delete(symbol);
        if (candle.close < shortPending.triggerClose && candle.close < candle.open) {
          taiyoAfternoonReversalFired.add(symbol);
          const slPct = symConfig.taiyoAfternoonSlPct ?? 1.0;
          const tpPct = symConfig.taiyoAfternoonTpPct ?? 1.5;
          console.log(`[RealtimeSim] ${symbol} ★太陽誘電後場反転SHORT発火: 1本確認・前場+${morningMovePct.toFixed(2)}%・高値反落${reversalPctFromHigh.toFixed(2)}% (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition("short", candle, tradeDate, candleTime, `太陽誘電後場反転SHORT: 1本確認、前場+${morningMovePct.toFixed(2)}%、高値反落${reversalPctFromHigh.toFixed(2)}%`, boardSnapshot, { slPct, tpPct });
        }
        console.log(`[RealtimeSim] ${symbol} 太陽誘電後場反転SHORT: 1本確認が不成立で取消`);
      } else if (longTrigger) {
        taiyoAfternoonReversalLongPending.set(symbol, { triggerClose: candle.close, triggerTime: candleTime });
        console.log(`[RealtimeSim] ${symbol} 太陽誘電後場反転LONG: 初動検出、次の1本を確認待ち`);
        return { symbol, tradeDate, candleTime, action: "none" };
      } else if (shortTrigger) {
        taiyoAfternoonReversalShortPending.set(symbol, { triggerClose: candle.close, triggerTime: candleTime });
        console.log(`[RealtimeSim] ${symbol} 太陽誘電後場反転SHORT: 初動検出、次の1本を確認待ち`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }

    // ---- ★5803: 安値反転ブレイクLONG ----
    // 当日安値が始値を明確に下回った後の直近高値更新を、1本の陽線確認で捉える。
    // BPRが極端な売り優勢のときは、戻りではなく下落継続の可能性が高いためこの方式だけ停止する。
    if (
      symConfig.enableLowReversalBreakLong &&
      !lowReversalBreakLongFired.has(symbol) &&
      !openingBreakShortFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.lowReversalBreakLongStartTime ?? "09:45") &&
      candleTime <= (symConfig.lowReversalBreakLongEndTime ?? "14:30")
    ) {
      const lowLookback = symConfig.lowReversalBreakLongLowLookback ?? 20;
      const highLookback = symConfig.lowReversalBreakLongHighLookback ?? 5;
      const dayLow = Math.min(...buffer.map(item => item.low));
      const recentHigh = Math.max(...buffer.slice(buffer.length - 1 - highLookback, buffer.length - 1).map(item => item.high));
      const dayLowDropPct = dayOpen > 0 ? (dayLow - dayOpen) / dayOpen * 100 : 0;
      const reboundFromDayLowPct = dayLow > 0 ? (candle.close - dayLow) / dayLow * 100 : 0;
      const maxDayLowDropPct = symConfig.lowReversalBreakLongMaxDayLowDropPct ?? -0.5;
      const minReboundPct = symConfig.lowReversalBreakLongMinReboundPct ?? 0;
      const reversalLongOk =
        buffer.length > lowLookback &&
        dayLowDropPct <= maxDayLowDropPct &&
        reboundFromDayLowPct >= minReboundPct &&
        candle.close > recentHigh &&
        candle.close > candle.open &&
        currentMA > prevMA &&
        maSlope2 >= 0.02 &&
        volumeRatio >= (symConfig.lowReversalBreakLongMinVolumeRatio ?? 1.0);

      const longPending = lowReversalBreakLongPending.get(symbol);
      if (longPending && candleTime > longPending.triggerTime) {
        lowReversalBreakLongPending.delete(symbol);
        const reversalBoard = getBoardSnapshot(symbol);
        const reversalBpr = reversalBoard?.buyPressureRatio ?? 0;
        const bprMax = symConfig.lowReversalBreakLongBprMax ?? 0.8;
        const bprFloor = symConfig.lowReversalBreakLongBprFloor ?? 0.25;
        const confirmedLong = candle.close > longPending.triggerClose && candle.close > candle.open;
        if (!confirmedLong) {
          console.log(`[RealtimeSim] ${symbol} 安値反転ブレイクLONG: 1本確認が不成立で取消`);
        } else if (reversalBoard?.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 安値反転ブレイクLONG: buy_pressureでブロック`);
        } else if (reversalBpr > bprMax) {
          console.log(`[RealtimeSim] ${symbol} 安値反転ブレイクLONG: BPR過熱(${reversalBpr.toFixed(2)} > ${bprMax})でブロック`);
        } else if (reversalBpr <= bprFloor) {
          console.log(`[RealtimeSim] ${symbol} 安値反転ブレイクLONG: 極端な売り圧力(BPR${reversalBpr.toFixed(2)} <= ${bprFloor})でブロック`);
        } else {
          lowReversalBreakLongFired.add(symbol);
          const slPct = symConfig.lowReversalBreakLongSlPct ?? 0.5;
          const tpPct = symConfig.lowReversalBreakLongTpPct ?? 0.5;
          console.log(`[RealtimeSim] ${symbol} ★安値反転ブレイクLONG発火: 1本確認・当日安値始値比${dayLowDropPct.toFixed(2)}%・${highLookback}本高値更新・BPR${reversalBpr.toFixed(2)} (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition(
            "long", candle, tradeDate, candleTime,
            `安値反転ブレイクLONG: 1本確認、当日安値始値比${dayLowDropPct.toFixed(2)}%、${highLookback}本高値更新、BPR${reversalBpr.toFixed(2)}`,
            reversalBoard, { slPct, tpPct },
          );
        }
      } else if (reversalLongOk) {
        lowReversalBreakLongPending.set(symbol, { triggerClose: candle.close, triggerTime: candleTime });
        console.log(`[RealtimeSim] ${symbol} 安値反転ブレイクLONG: 初動検出、次の1本を確認待ち`);
      }
    }

    // ---- ★6981: 寄り付きブレイクSHORT ----
    // 始値から十分に下落し直近20本安値を更新した初動を、1本の陰線確認で捉える。
    // 大きな値幅と出来高急増が同時に出たショック足は、下落末端の追撃としてこの方式だけ停止する。
    if (
      symConfig.enableOpeningBreakShort &&
      !openingBreakShortFired.has(symbol) &&
      !lowReversalBreakLongFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.openingBreakShortStartTime ?? "09:45") &&
      candleTime <= (symConfig.openingBreakShortEndTime ?? "10:45")
    ) {
      const lowLookback = symConfig.openingBreakShortLowLookback ?? 20;
      const recentLow = Math.min(...buffer.slice(buffer.length - 1 - lowLookback, buffer.length - 1).map(item => item.low));
      const candleRangePct = candle.high > 0 ? Math.abs((candle.high - candle.low) / candle.high * 100) : 0;
      const shockRangePct = symConfig.openingBreakShortShockRangePct ?? 1.0;
      const shockVolumeRatio = symConfig.openingBreakShortShockVolumeRatio ?? 2.0;
      const isShockCandle = candleRangePct >= shockRangePct && volumeRatio >= shockVolumeRatio;
      const openingShortOk =
        buffer.length > lowLookback &&
        openGainPct <= (symConfig.openingBreakShortMaxOpenGainPct ?? -1.5) &&
        candle.close < recentLow &&
        candle.close < candle.open &&
        volumeRatio >= (symConfig.openingBreakShortMinVolumeRatio ?? 1.0) &&
        !isShockCandle;

      const shortPending = openingBreakShortPending.get(symbol);
      if (shortPending && candleTime > shortPending.triggerTime) {
        openingBreakShortPending.delete(symbol);
        const openingBoard = getBoardSnapshot(symbol);
        const openingBpr = openingBoard?.buyPressureRatio ?? 0;
        const bprMax = symConfig.openingBreakShortBprMax ?? 0.8;
        const confirmedShort = candle.close < shortPending.triggerClose && candle.close < candle.open;
        if (!confirmedShort) {
          console.log(`[RealtimeSim] ${symbol} 寄り付きブレイクSHORT: 1本確認が不成立で取消`);
        } else if (openingBoard?.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 寄り付きブレイクSHORT: buy_pressureでブロック`);
        } else if (openingBpr > bprMax) {
          console.log(`[RealtimeSim] ${symbol} 寄り付きブレイクSHORT: BPR買い優勢(${openingBpr.toFixed(2)} > ${bprMax})でブロック`);
        } else {
          openingBreakShortFired.add(symbol);
          const slPct = symConfig.openingBreakShortSlPct ?? 0.6;
          const tpPct = symConfig.openingBreakShortTpPct ?? 1.5;
          console.log(`[RealtimeSim] ${symbol} ★寄り付きブレイクSHORT発火: 1本確認・始値比${openGainPct.toFixed(2)}%・${lowLookback}本安値更新 (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition(
            "short", candle, tradeDate, candleTime,
            `寄り付きブレイクSHORT: 1本確認、始値比${openGainPct.toFixed(2)}%、${lowLookback}本安値更新`,
            openingBoard, { slPct, tpPct },
          );
        }
        return { symbol, tradeDate, candleTime, action: "none" };
      } else if (isShockCandle && openGainPct <= (symConfig.openingBreakShortMaxOpenGainPct ?? -1.5) && candle.close < recentLow) {
        console.log(`[RealtimeSim] ${symbol} 寄り付きブレイクSHORT: ショック足でブロック (値幅${candleRangePct.toFixed(3)}%、出来高${volumeRatio.toFixed(2)}倍)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      } else if (openingShortOk) {
        openingBreakShortPending.set(symbol, { triggerClose: candle.close, triggerTime: candleTime });
        console.log(`[RealtimeSim] ${symbol} 寄り付きブレイクSHORT: 初動検出、次の1本を確認待ち`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }

    // ---- ★5803: 高値失速ブレイクSHORT ----
    // 始値より上で推移した後の直近安値更新を、1本の陰線確認で捉える。
    // MA8が急落済みなら下落末端の追撃となるため、この方式だけ停止する。
    if (
      symConfig.enableHighFadeBreakShort &&
      !highFadeBreakShortFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.highFadeBreakShortStartTime ?? "09:45") &&
      candleTime <= (symConfig.highFadeBreakShortEndTime ?? "14:30")
    ) {
      const lowLookback = symConfig.highFadeBreakShortLowLookback ?? 5;
      const recentLow = Math.min(...buffer.slice(buffer.length - 1 - lowLookback, buffer.length - 1).map(item => item.low));
      const highFadeShortOk =
        openGainPct >= (symConfig.highFadeBreakShortMinOpenGainPct ?? 1.0) &&
        candle.close < recentLow &&
        candle.close < candle.open &&
        currentMA <= prevMA &&
        maSlope2 <= -0.02 &&
        volumeRatio >= (symConfig.highFadeBreakShortMinVolumeRatio ?? 0.5);

      const shortPending = highFadeBreakShortPending.get(symbol);
      if (shortPending && candleTime > shortPending.triggerTime) {
        highFadeBreakShortPending.delete(symbol);
        const fadeBoard = getBoardSnapshot(symbol);
        const fadeBpr = fadeBoard?.buyPressureRatio ?? 0;
        const bprMax = symConfig.highFadeBreakShortBprMax ?? 0.8;
        const maSlopeFloor = symConfig.highFadeBreakShortMaSlopeFloor ?? -0.20;
        const confirmedShort = candle.close < shortPending.triggerClose && candle.close < candle.open;
        if (!confirmedShort) {
          console.log(`[RealtimeSim] ${symbol} 高値失速ブレイクSHORT: 1本確認が不成立で取消`);
        } else if (fadeBoard?.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 高値失速ブレイクSHORT: buy_pressureでブロック`);
        } else if (fadeBpr > bprMax) {
          console.log(`[RealtimeSim] ${symbol} 高値失速ブレイクSHORT: BPR買い優勢(${fadeBpr.toFixed(2)} > ${bprMax})でブロック`);
        } else if (maSlope2 <= maSlopeFloor) {
          console.log(`[RealtimeSim] ${symbol} 高値失速ブレイクSHORT: 急落末端(MA8傾き${maSlope2.toFixed(3)}% <= ${maSlopeFloor}%)でブロック`);
        } else {
          highFadeBreakShortFired.add(symbol);
          const slPct = symConfig.highFadeBreakShortSlPct ?? 0.6;
          const tpPct = symConfig.highFadeBreakShortTpPct ?? 1.5;
          console.log(`[RealtimeSim] ${symbol} ★高値失速ブレイクSHORT発火: 1本確認・始値比+${openGainPct.toFixed(2)}%・${lowLookback}本安値更新・MA傾き${maSlope2.toFixed(3)}% (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition(
            "short", candle, tradeDate, candleTime,
            `高値失速ブレイクSHORT: 1本確認、始値比+${openGainPct.toFixed(2)}%、${lowLookback}本安値更新、MA傾き${maSlope2.toFixed(3)}%`,
            fadeBoard, { slPct, tpPct },
          );
        }
      } else if (highFadeShortOk) {
        highFadeBreakShortPending.set(symbol, { triggerClose: candle.close, triggerTime: candleTime });
        console.log(`[RealtimeSim] ${symbol} 高値失速ブレイクSHORT: 初動検出、次の1本を確認待ち`);
      }
    }

    // ---- ★5803候補C: 後場の下落継続を5本安値更新で捉えるSHORT ----
    // 急落・出来高急増が同時に起きた足は、投げ売り後の反発を避けるため候補Cだけ停止する。
    if (
      symConfig.enableAfternoonLowBreakShort &&
      !afternoonLowBreakShortFired.has(symbol) &&
      canCalcMa &&
      candleTime >= (symConfig.afternoonLowBreakShortStartTime ?? "13:30") &&
      candleTime <= (symConfig.afternoonLowBreakShortEndTime ?? "14:00")
    ) {
      const lookback = symConfig.afternoonLowBreakShortLowLookback ?? 5;
      const recentLow = Math.min(...buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(item => item.low));
      const lowBreak = candle.close < recentLow;
      const cShortOk =
        openGainPct <= (symConfig.afternoonLowBreakShortMaxOpenGainPct ?? -1.0) &&
        maSlope2 <= (symConfig.afternoonLowBreakShortMaxMaSlopePct ?? -0.1) &&
        lowBreak &&
        candle.close < candle.open &&
        volumeRatio >= (symConfig.afternoonLowBreakShortMinVolumeRatio ?? 1.0);

      if (cShortOk) {
        const cBoard = getBoardSnapshot(symbol);
        const cBpr = cBoard?.buyPressureRatio ?? 0;
        const cBprMax = symConfig.afternoonLowBreakShortBprMax ?? 1.0;
        const candleRangePct = candle.high > 0
          ? Math.abs((candle.low - candle.high) / candle.high * 100)
          : 0;
        const shockRangePct = symConfig.afternoonLowBreakShortShockRangePct ?? 0.75;
        const shockVolumeRatio = symConfig.afternoonLowBreakShortShockVolumeRatio ?? 3.0;
        const isShockCandle = candleRangePct >= shockRangePct && volumeRatio >= shockVolumeRatio;

        if (cBoard?.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 後場安値更新SHORT: buy_pressureでブロック`);
        } else if (cBpr > cBprMax) {
          console.log(`[RealtimeSim] ${symbol} 後場安値更新SHORT: BPR買い優勢(${cBpr.toFixed(2)} > ${cBprMax})でブロック`);
        } else if (isShockCandle) {
          console.log(
            `[RealtimeSim] ${symbol} 後場安値更新SHORT: ショック足でブロック ` +
            `(値幅${candleRangePct.toFixed(3)}% >= ${shockRangePct}%、出来高${volumeRatio.toFixed(2)}倍 >= ${shockVolumeRatio}倍)`
          );
        } else {
          afternoonLowBreakShortFired.add(symbol);
          const slPct = symConfig.afternoonLowBreakShortSlPct ?? 0.6;
          const tpPct = symConfig.afternoonLowBreakShortTpPct ?? 1.5;
          console.log(
            `[RealtimeSim] ${symbol} ★後場安値更新SHORT発火: 始値比${openGainPct.toFixed(1)}%・` +
            `${lookback}本安値更新・MA傾き${maSlope2.toFixed(3)}%・出来高${volumeRatio.toFixed(2)}倍 ` +
            `(SL${slPct}%/TP${tpPct}%)`
          );
          return await enterPosition(
            "short",
            candle,
            tradeDate,
            candleTime,
            `後場安値更新SHORT: 始値比${openGainPct.toFixed(1)}%、${lookback}本安値更新、出来高${volumeRatio.toFixed(2)}倍`,
            cBoard,
            { slPct, tpPct },
          );
        }
      }
    }

    // 順張りSHORT: 10:15以降、始値比-1%以下、MA8下向き、10本安値更新、陰線、平均以上の出来高。
    if (
      symConfig.enableTrendShort &&
      !trendShortFired.has(symbol) &&
      canCalcMa &&
      (!isRoundBreakdownSignal || safeCbBlockedNow) &&
      candleTime >= (symConfig.trendShortStartTime ?? "10:15") &&
      candleTime <= (symConfig.trendShortEndTime ?? "14:20")
    ) {
      const lookback = symConfig.trendShortLowLookback ?? 10;
      const recentLow = Math.min(...buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(item => item.low));
      const lowBreak = candle.low < recentLow;
      const trendShortOk =
        openGainPct >= (symConfig.trendShortMinOpenGainPct ?? Number.NEGATIVE_INFINITY) &&
        openGainPct <= (symConfig.trendShortMaxOpenGainPct ?? -1.0) &&
        currentMA <= prevMA &&
        maSlope2 <= -0.02 &&
        lowBreak &&
        candle.close < candle.open &&
        volumeRatio >= (symConfig.trendShortMinVolumeRatio ?? 1.0);

      if (trendShortOk) {
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        const trendBoard = getBoardSnapshot(symbol);
        const trendBoardScore = boardReadingScore(symbol, "short", trendBoard);
        const trendBpr = trendBoard?.buyPressureRatio ?? 0;
        const trendBprMax = symConfig.trendBoardBprMax;
        const isNeutralBoard = trendBoard?.signal === "neutral";
        if (htfTrend === "up") {
          console.log(`[RealtimeSim] ${symbol} 順張りSHORT: 3分足HTF upでブロック`);
        } else if (trendBoard?.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 順張りSHORT: buy_pressureでブロック`);
        } else if (trendBprMax !== undefined && trendBpr > trendBprMax) {
          console.log(`[RealtimeSim] ${symbol} 順張りSHORT: BPR買い優勢(${trendBpr.toFixed(2)} > ${trendBprMax})でブロック`);
        } else if (trendBoardScore < BOARD_SCORE_THRESHOLD && isNeutralBoard) {
          console.log(`[RealtimeSim] ${symbol} 順張りSHORT: neutral時の板読みスコア不足(${trendBoardScore})でブロック`);
        } else {
          trendShortFired.add(symbol);
          const slPct = symConfig.trendShortSlPct ?? 0.8;
          const tpPct = symConfig.trendShortTpPct ?? 1.2;
          console.log(`[RealtimeSim] ${symbol} ★順張りSHORT発火: 始値比${openGainPct.toFixed(1)}%・10本安値更新・出来高${volumeRatio.toFixed(1)}倍 (SL${slPct}%/TP${tpPct}%)`);
          return await enterPosition("short", candle, tradeDate, candleTime, `順張りSHORT: 始値比${openGainPct.toFixed(1)}%、10本安値更新、出来高${volumeRatio.toFixed(1)}倍`, trendBoard, { slPct, tpPct });
        }
      }
    }
  }

  // ---- ★6857: 確認型20本高値更新LONG ----
  // 前足の陽線ブレイクを確認してから、当足も20本高値を更新する上昇継続だけを狙う。
  // 初回取引後は、損切りで反対方向の再評価権が生じた場合を除いて、同日反対側へ入らない。
  const advantestReentryState = advantestPostStopReentry.get(symbol);
  const isAdvantestLongReentry = advantestReentryState?.stoppedSide === "short" && !advantestReentryState.reentryUsed;
  const hasNoAdvantestInitialEntry = !advantestHighFadeShortFired.has(symbol) && !advantestConfirmedBreakLongFired.has(symbol);
  if (
    symConfig.enableAdvantestConfirmedBreakLong &&
    isEntryAllowed &&
    (hasNoAdvantestInitialEntry || isAdvantestLongReentry) &&
    buffer.length >= (symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD) + 22 &&
    candleTime >= (symConfig.advantestConfirmedBreakLongStartTime ?? "10:00") &&
    candleTime <= (symConfig.advantestConfirmedBreakLongEndTime ?? "11:15")
  ) {
    const maPeriod = symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD;
    const currentMA = buffer.slice(buffer.length - maPeriod).reduce((sum, item) => sum + item.close, 0) / maPeriod;
    const ma2Ago = buffer.slice(buffer.length - maPeriod - 2, buffer.length - 2).reduce((sum, item) => sum + item.close, 0) / maPeriod;
    const maSlope2 = ma2Ago > 0 ? (currentMA - ma2Ago) / ma2Ago * 100 : 0;
    const lookback = symConfig.advantestConfirmedBreakLongHighLookback ?? 20;
    const priorCandle = buffer[buffer.length - 2];
    const priorHigh = Math.max(...buffer.slice(buffer.length - 2 - lookback, buffer.length - 2).map(item => item.high));
    const currentHigh = Math.max(...buffer.slice(buffer.length - 1 - lookback, buffer.length - 1).map(item => item.high));
    const priorBullBodyPct = priorCandle?.open > 0 ? (priorCandle.close - priorCandle.open) / priorCandle.open * 100 : 0;
    const priorVolumes = buffer.slice(buffer.length - 21, buffer.length - 1);
    const avgVolume = priorVolumes.reduce((sum, item) => sum + item.volume, 0) / priorVolumes.length;
    const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;
    const dayOpen = buffer[0]?.open ?? candle.open;
    const runningVolume = buffer.reduce((sum, item) => sum + item.volume, 0);
    const dayVwap = runningVolume > 0
      ? buffer.reduce((sum, item) => sum + ((item.high + item.low + item.close) / 3) * item.volume, 0) / runningVolume
      : candle.close;
    const recentSix = buffer.slice(Math.max(0, buffer.length - 6));
    const recentRangePct = candle.close > 0
      ? (Math.max(...recentSix.map(item => item.high)) - Math.min(...recentSix.map(item => item.low))) / candle.close * 100
      : Number.POSITIVE_INFINITY;
    const longOk =
      candle.close > dayOpen &&
      priorCandle.close > priorHigh &&
      candle.close > currentHigh &&
      candle.close > candle.open &&
      priorBullBodyPct >= (symConfig.advantestConfirmedBreakLongMinPriorBodyPct ?? 0.10) &&
      maSlope2 >= (symConfig.advantestConfirmedBreakLongMinMaSlopePct ?? 0.03) &&
      volumeRatio >= (symConfig.advantestConfirmedBreakLongMinVolumeRatio ?? 1.0) &&
      candle.close > dayVwap &&
      (!isAdvantestLongReentry || recentRangePct <= (symConfig.advantestConfirmedBreakLongMaxRecentRangePct ?? 1.5));

    if (longOk) {
      const slPct = symConfig.advantestConfirmedBreakLongSlPct ?? 0.5;
      const tpPct = symConfig.advantestConfirmedBreakLongTpPct ?? 1.0;
      const result = await enterPosition(
        "long", candle, tradeDate, candleTime,
        `アドバンテスト確認型LONG${isAdvantestLongReentry ? "（損切り後再評価）" : ""}: ${lookback}本高値更新、前足陽線実体${priorBullBodyPct.toFixed(3)}%、VWAP上、出来高${volumeRatio.toFixed(2)}倍`,
        boardSnapshot, { slPct, tpPct },
      );
      if (result.action === "entry") {
        advantestConfirmedBreakLongFired.add(symbol);
        if (isAdvantestLongReentry && advantestReentryState) advantestReentryState.reentryUsed = true;
      }
      return result;
    }
  }

  // ---- ★6857: 高値失速SHORT ----
  // 始値より上の高値形成後に、高値から0.8%以上反落して5本安値を更新する陰線を捉える。
  // 前足が実体0.05%未満の小陰線なら下落継続を確認できないため、この方式だけ停止する。
  if (
    symConfig.enableAdvantestHighFadeShort &&
    (hasNoAdvantestInitialEntry || (advantestReentryState?.stoppedSide === "long" && !advantestReentryState.reentryUsed)) &&
    isEntryAllowed &&
    buffer.length >= (symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD) + 2 &&
    candleTime >= (symConfig.advantestHighFadeShortStartTime ?? "09:45") &&
    candleTime <= (symConfig.advantestHighFadeShortEndTime ?? "11:15")
  ) {
    const maPeriod = symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD;
    const currentMA = buffer.slice(buffer.length - maPeriod).reduce((sum, item) => sum + item.close, 0) / maPeriod;
    const prevMA = buffer.slice(buffer.length - maPeriod - 1, buffer.length - 1).reduce((sum, item) => sum + item.close, 0) / maPeriod;
    const ma2Ago = buffer.slice(buffer.length - maPeriod - 2, buffer.length - 2).reduce((sum, item) => sum + item.close, 0) / maPeriod;
    const maSlope2 = ma2Ago > 0 ? (currentMA - ma2Ago) / ma2Ago * 100 : 0;
    const dayOpen = buffer[0]?.open ?? candle.open;
    const priorVolumes = buffer.slice(buffer.length - 21, buffer.length - 1);
    const avgVolume = priorVolumes.reduce((sum, item) => sum + item.volume, 0) / priorVolumes.length;
    const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;
    const lowLookback = symConfig.advantestHighFadeShortLowLookback ?? 5;
    const recentLow = Math.min(...buffer.slice(buffer.length - 1 - lowLookback, buffer.length - 1).map(item => item.low));
    const dayHigh = dayHighTracker.get(symbol) ?? candle.high;
    const riseFromOpenPct = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
    const dropFromHighPct = dayHigh > 0 ? (dayHigh - candle.close) / dayHigh * 100 : 0;
    const priorCandle = buffer[buffer.length - 2];
    const priorBearBodyPct = priorCandle?.open > 0
      ? (priorCandle.open - priorCandle.close) / priorCandle.open * 100
      : 0;
    const minPriorBearBodyPct = symConfig.advantestHighFadeShortMinPriorBearBodyPct ?? 0.05;
    const dayVwap = buffer.reduce((sum, item) => sum + ((item.high + item.low + item.close) / 3) * item.volume, 0) /
      Math.max(1, buffer.reduce((sum, item) => sum + item.volume, 0));
    const recentSix = buffer.slice(Math.max(0, buffer.length - 6));
    const fiveBarChangePct = recentSix[0]?.close > 0 ? (candle.close - recentSix[0].close) / recentSix[0].close * 100 : 0;
    const isAdvantestShortReentry = advantestReentryState?.stoppedSide === "long" && !advantestReentryState.reentryUsed;
    const shortOk =
      riseFromOpenPct >= (symConfig.advantestHighFadeShortMinOpenGainPct ?? 1.0) &&
      dropFromHighPct >= (symConfig.advantestHighFadeShortDropPct ?? 0.8) &&
      candle.close < recentLow &&
      candle.close < candle.open &&
      priorBearBodyPct >= minPriorBearBodyPct &&
      currentMA < prevMA &&
      maSlope2 <= (symConfig.advantestHighFadeShortMaxMaSlopePct ?? -0.05) &&
      volumeRatio >= (symConfig.advantestHighFadeShortMinVolumeRatio ?? 1.2) &&
      (!isAdvantestShortReentry || (
        candle.close < dayVwap &&
        fiveBarChangePct <= (symConfig.advantestPostStopShortMaxFiveBarChangePct ?? -0.3)
      ));

    if (shortOk) {
      const slPct = symConfig.advantestHighFadeShortSlPct ?? 1.0;
      const tpPct = symConfig.advantestHighFadeShortTpPct ?? 1.2;
      console.log(`[RealtimeSim] ${symbol} ★アドバンテスト高値失速SHORT発火: 始値比+${riseFromOpenPct.toFixed(2)}%、高値から${dropFromHighPct.toFixed(2)}%反落、${lowLookback}本安値更新、前足実体${priorBearBodyPct.toFixed(3)}% (SL${slPct}%/TP${tpPct}%)`);
      const result = await enterPosition(
        "short", candle, tradeDate, candleTime,
        `アドバンテスト高値失速SHORT${isAdvantestShortReentry ? "（損切り後再評価）" : ""}: 始値比+${riseFromOpenPct.toFixed(2)}%、高値から${dropFromHighPct.toFixed(2)}%反落、${lowLookback}本安値更新、前足陰線実体${priorBearBodyPct.toFixed(3)}%`,
        boardSnapshot, { slPct, tpPct },
      );
      if (result.action === "entry") {
        advantestHighFadeShortFired.add(symbol);
        if (isAdvantestShortReentry && advantestReentryState) advantestReentryState.reentryUsed = true;
      }
      return result;
    }
  }

  // アドバンテストは検証済みの高値失速SHORTだけで運用する。
  // 後段の汎用ダウ理論・大台・VWAP系が迂回してエントリーすることは許可しない。
  if (symConfig.enableAdvantestHighFadeShort || symConfig.enableAdvantestConfirmedBreakLong) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // 太陽誘電は検証済みの朝初動SHORT・後場反転2方向だけで運用する。
  // 上記の専用判定でエントリーしなかった足を、後段の汎用ダウ理論・大台・VWAP系が
  // 迂回してエントリーすることは許可しない。
  if (
    symConfig.enableTaiyoMorningInitialShort ||
    symConfig.enableTaiyoAfternoonReversalLong ||
    symConfig.enableTaiyoAfternoonReversalShort
  ) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // 高値反転SHORT: 急騰後、当日高値の近傍から反落した初動を捉える。
  // 安全CBが同一足にある場合はCBを優先し、板読み・3分足HTFも順張りSHORTと同様に適用する。
  if (
    symConfig.enablePeakReversalShort &&
    !peakReversalShortFired.has(symbol) &&
    buffer.length >= (symConfig.maPeriod ?? IS_BULLISH_MA_PERIOD) + 2 &&
    (!isRoundBreakdownSignal || safeCbBlockedNow) &&
    candleTime >= (symConfig.peakReversalShortStartTime ?? "09:45") &&
    candleTime <= (symConfig.peakReversalShortEndTime ?? "11:27")
  ) {
    const currentDayHigh = dayHighTracker.get(symbol) ?? candle.high;
    const peakDayOpen = buffer[0]?.open ?? candle.open;
    const riseFromOpenPct = peakDayOpen > 0 ? (currentDayHigh - peakDayOpen) / peakDayOpen * 100 : 0;
    const dropFromHighPct = currentDayHigh > 0 ? (currentDayHigh - candle.close) / currentDayHigh * 100 : 0;
    const bodyPct = candle.open > 0 ? (candle.open - candle.close) / candle.open * 100 : 0;
    const peakRecentVolumes = buffer.slice(buffer.length - 21, buffer.length - 1);
    const peakAvgVolume = peakRecentVolumes.reduce((sum, item) => sum + item.volume, 0) / peakRecentVolumes.length;
    const peakVolumeRatio = peakAvgVolume > 0 ? candle.volume / peakAvgVolume : 0;
    const recent3High = Math.max(...buffer.slice(Math.max(0, buffer.length - 3)).map(item => item.high));
    const nearRecentDayHigh = Math.abs(recent3High - currentDayHigh) < 0.000001;
    const peakShortOk =
      riseFromOpenPct >= (symConfig.peakReversalShortMinRisePct ?? 2.5) &&
      dropFromHighPct >= (symConfig.peakReversalShortDropPct ?? 0.4) &&
      bodyPct >= (symConfig.peakReversalShortMinBodyPct ?? 0.1) &&
      peakVolumeRatio >= (symConfig.peakReversalShortMinVolumeRatio ?? 1.0) &&
      nearRecentDayHigh;

    if (peakShortOk) {
      const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
      const peakBoard = getBoardSnapshot(symbol);
      const peakBoardScore = boardReadingScore(symbol, "short", peakBoard);
      const peakBpr = peakBoard?.buyPressureRatio ?? 0;
      const peakBprMax = symConfig.trendBoardBprMax;
      const isNeutralBoard = peakBoard?.signal === "neutral";
      if (htfTrend === "up") {
        console.log(`[RealtimeSim] ${symbol} 高値反転SHORT: 3分足HTF upでブロック`);
      } else if (peakBoard?.signal === "buy_pressure") {
        console.log(`[RealtimeSim] ${symbol} 高値反転SHORT: buy_pressureでブロック`);
      } else if (peakBprMax !== undefined && peakBpr > peakBprMax) {
        console.log(`[RealtimeSim] ${symbol} 高値反転SHORT: BPR買い優勢(${peakBpr.toFixed(2)} > ${peakBprMax})でブロック`);
      } else if (peakBoardScore < BOARD_SCORE_THRESHOLD && isNeutralBoard) {
        console.log(`[RealtimeSim] ${symbol} 高値反転SHORT: neutral時の板読みスコア不足(${peakBoardScore})でブロック`);
      } else {
        peakReversalShortFired.add(symbol);
        const slPct = symConfig.peakReversalShortSlPct ?? 0.6;
        const tpPct = symConfig.peakReversalShortTpPct ?? 1.8;
        console.log(`[RealtimeSim] ${symbol} ★高値反転SHORT発火: 始値比+${riseFromOpenPct.toFixed(1)}%後、高値から${dropFromHighPct.toFixed(1)}%反落 (SL${slPct}%/TP${tpPct}%)`);
        return await enterPosition("short", candle, tradeDate, candleTime, `高値反転SHORT: 始値+${riseFromOpenPct.toFixed(1)}%後、高値から${dropFromHighPct.toFixed(1)}%反落`, peakBoard, { slPct, tpPct });
      }
    }
  }

  // 個別最適化が完了した銘柄は、上段で実装済みの専用方式だけを使用する。
  // 専用方式がこの足で発火しなければ、後段の汎用ダウ理論・大台・押し目・VWAP系へは進めない。
  if (symConfig.exclusiveEntryRoutes) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  if (!sig) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- isBullish方式: 動的MA傾き判定（+D構成改良） ----
  // MA20の傾きが閾値以上（上向き）ならその銘柄は上昇相場と判定しSHORT禁止
  // バッファ不足時は従来の始値比フォールバックを使用
  const isBullish = (() => {
    if (buffer.length < 2) return false;
    const maPeriod = IS_BULLISH_MA_PERIOD;
    if (buffer.length < maPeriod + 1) {
      // ウォームアップ中: 従来の始値比方式にフォールバック
      const openPrice = buffer[0].open;
      const priceChangeRatio = (candle.close - openPrice) / openPrice * 100;
      return priceChangeRatio >= IS_BULLISH_FALLBACK_THRESHOLD;
    }
    // MA20の現在値を計算（直近20本のclose平均）
    const currentSlice = buffer.slice(buffer.length - maPeriod).map(c => c.close);
    const currentMA = currentSlice.reduce((a, b) => a + b, 0) / maPeriod;
    // MA20の1本前の値を計算（1本前までの20本のclose平均）
    const prevSlice = buffer.slice(buffer.length - maPeriod - 1, buffer.length - 1).map(c => c.close);
    const prevMA = prevSlice.reduce((a, b) => a + b, 0) / maPeriod;
    // 傾き = (現在MA - 前MA) / 前MA * 100 (%)
    const slope = (currentMA - prevMA) / prevMA * 100;
    // 傾きが閾値を超えていれば上昇中（isBullish=true → SHORT禁止）
    return slope > IS_BULLISH_SLOPE_THRESHOLD;
  })();

  // ---- 押し目確認ステートマシン処理 (ダウ理論上昇のみ) ----
  const pullbackState = pullbackStates.get(symbol);
  if (pullbackState) {
    pullbackState.waitCount++;

    // 直近安値を割ったらキャンセル
    if (candle.low < pullbackState.recentSwingLow) {
      pullbackStates.delete(symbol);
      console.log(`[RealtimeSim] ${symbol} 押し目確認キャンセル: 安値割れ (${candle.low} < ${pullbackState.recentSwingLow})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 最大待機足数超過でキャンセル
    if (pullbackState.waitCount > PULLBACK_MAX_WAIT) {
      pullbackStates.delete(symbol);
      console.log(`[RealtimeSim] ${symbol} 押し目確認キャンセル: 待機タイムアウト (${pullbackState.waitCount}本超過)`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 押しが入ったか確認（現在足の終値がシグナル発生時価格より下）
    if (!pullbackState.pulledBack && candle.close < pullbackState.signalPrice) {
      pullbackState.pulledBack = true;
    }

    // 押し後に再上昇した足でエントリー
    if (pullbackState.pulledBack && candle.close > pullbackState.signalPrice) {
      pullbackStates.delete(symbol);
      // ★3分足HTFフィルター（ステートマシンエントリー時）: 逆方向のみブロック
      {
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        if (htfTrend === "down") {
          console.log(`[RealtimeSim] ${symbol} 押し目確認: 3分足HTFフィルターによりブロック (LONG時にdown)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
      }
      // ★v6b対策A: sell_pressure時のプルバック経由LONG禁止
      if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
        console.log(`[RealtimeSim] ${symbol} 押し目確認: sell_pressure時LONG禁止(プルバック経由)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ★v6: 板読みスコアで統合判定
      const brScore = boardReadingScore(symbol, "long", boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) {
        console.log(`[RealtimeSim] ${symbol} 押し目確認: 板読みスコア不足(${brScore})`);
        // ★スコア0+信頼度強ブロック記録
        if (brScore === 0 && pullbackState.reason.includes("信頼度：強")) {
          insertScore0Block({
            tradeDate,
            symbol,
            candleTime,
            side: "BUY",
            signalReason: pullbackState.reason.substring(0, 200),
            entryPrice: String(candle.close),
            boardScore: 0,
            confidence: "strong",
            context: "pullback_buy",
          });
        }
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      console.log(`[RealtimeSim] ${symbol} 押し目確認後エントリー: ${pullbackState.reason} (板スコア:${brScore})`);
      return await enterPosition("long", candle, tradeDate, candleTime, `押し目確認: ${pullbackState.reason}`, boardSnapshot);
    }

    // まだ待機中
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 大台確認バーステートマシン処理 ----
  const roundPending = roundLevelPendingStates.get(symbol);
  if (roundPending) {
    // ポジションが入ったらキャンセル
    if (openPositions.has(symbol)) {
      roundLevelPendingStates.delete(symbol);
    } else {
      const stillValid =
        roundPending.direction === "buy"
          ? candle.close >= roundPending.level
          : candle.close <= roundPending.level;

      if (stillValid) {
        roundPending.confirmCount++;
        // ★方向別確認バー数: 大台割れSHORT=ROUND_SHORT_CONFIRM_BARS, 大台超えLONG=ROUND_LEVEL_CONFIRM_BARS
        const requiredBars = roundPending.direction === "sell" ? ROUND_SHORT_CONFIRM_BARS : ROUND_LEVEL_CONFIRM_BARS;
        if (roundPending.confirmCount >= requiredBars) {
          roundLevelPendingStates.delete(symbol);
          // 改善⑤: 確認完了 → 即エントリーせず押し目待ちステートに移行
          if (candleTime < NO_ENTRY_AFTER) {
            console.log(`[RealtimeSim] ${symbol} 大台確認完了(${requiredBars}本維持) → 押し目待ち開始: ${roundPending.reason}`);
            roundPullbackStates.set(symbol, {
              direction: roundPending.direction,
              level: roundPending.level,
              signalPrice: candle.close,
              waitCount: 0,
              pulledBack: false,
              reason: `大台確認(${requiredBars}本維持): ${roundPending.reason}`,
            });
          }
        }
      } else {
        // キリ番を維持できなかった → キャンセル
        console.log(`[RealtimeSim] ${symbol} 大台確認キャンセル: キリ番割れ (${candle.close} vs ${roundPending.level})`);
        roundLevelPendingStates.delete(symbol);
      }
      return { symbol, tradeDate, candleTime, action: "none" };
    }
  }

  // ---- 改善⑤: 大台確認後の押し目待ちステートマシン処理 ----
  const roundPb = roundPullbackStates.get(symbol);
  if (roundPb) {
    roundPb.waitCount++;
    const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";

    // キリ番を割り込んだらキャンセル
    if (roundPb.direction === "buy" && candle.close < roundPb.level) {
      console.log(`[RealtimeSim] ${symbol} 大台押し目待ちキャンセル: キリ番割れ (${candle.close} < ${roundPb.level})`);
      roundPullbackStates.delete(symbol);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    if (roundPb.direction === "sell" && candle.close > roundPb.level) {
      console.log(`[RealtimeSim] ${symbol} 大台押し目待ちキャンセル: キリ番上拜り (${candle.close} > ${roundPb.level})`);
      roundPullbackStates.delete(symbol);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // タイムアウト: 押し目なし＝強トレンド → そのままエントリー
    // ★方向別押し目待ち: 大台割れSHORT=ROUND_SHORT_PULLBACK_MAX_WAIT, 大台超えLONG=ROUND_PULLBACK_MAX_WAIT
    const maxWait = roundPb.direction === "sell" ? ROUND_SHORT_PULLBACK_MAX_WAIT : ROUND_PULLBACK_MAX_WAIT;
    if (roundPb.waitCount > maxWait) {
      roundPullbackStates.delete(symbol);
      // ★3分足HTFフィルター（ステートマシンエントリー時）: 逆方向のみブロック
      {
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        if (side === "long" && htfTrend === "down") {
          console.log(`[RealtimeSim] ${symbol} 大台押し目タイムアウト: 3分足HTFフィルターによりブロック (LONG時にdown)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        if (side === "short" && htfTrend === "up") {
          console.log(`[RealtimeSim] ${symbol} 大台押し目タイムアウト: 3分足HTFフィルターによりブロック (SHORT時にup)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
      }
      // ★v6b対策A: プルバック経由の板圧力チェック
      if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") {
        console.log(`[RealtimeSim] ${symbol} 大台押し目タイムアウト: sell_pressure時LONG禁止(プルバック経由)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") {
        console.log(`[RealtimeSim] ${symbol} 大台押し目タイムアウト: buy_pressure時SHORT禁止(プルバック経由)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ★v6: 板読みスコアで統合判定
      const brScoreTimeout = boardReadingScore(symbol, side, boardSnapshot);
      if (brScoreTimeout < BOARD_SCORE_THRESHOLD) {
        console.log(`[RealtimeSim] ${symbol} 大台押し目待ちタイムアウト: 板読みスコア不足(${brScoreTimeout})`);
        // ★スコア0+信頼度強ブロック記録
        if (brScoreTimeout === 0 && roundPb.reason.includes("信頼度：強")) {
          insertScore0Block({
            tradeDate,
            symbol,
            candleTime,
            side: side === "long" ? "BUY" : "SHORT",
            signalReason: roundPb.reason.substring(0, 200),
            entryPrice: String(candle.close),
            boardScore: 0,
            confidence: "strong",
            context: "round_timeout",
          });
        }
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      console.log(`[RealtimeSim] ${symbol} 大台押し目なし・強トレンドエントリー: ${roundPb.reason} (板スコア:${brScoreTimeout})`);
      // ★逆張りSHORT: 大台確認LONG + buy_pressure → SHORTに反転（過熱反転シグナル）
      if (side === "long" && boardSnapshot && boardSnapshot.signal === "buy_pressure") {
        console.log(`[RealtimeSim] ${symbol} 大台確認LONG×buy_pressure → 逆張りSHORTに反転: ${roundPb.reason}`);
        return await enterPosition("short", candle, tradeDate, candleTime, `${roundPb.reason} (過熱反転SHORT)`, boardSnapshot);
      }
      // ★大台超えLONGブロック（2026-08-13）: buy_pressureでなければLONGエントリーしない
      if (side === "long") {
        console.log(`[RealtimeSim] ${symbol} 大台超えLONGブロック(タイムアウト): buy_pressureなし → エントリーしない`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      return await enterPosition(side, candle, tradeDate, candleTime, `${roundPb.reason} (押し目なし・強トレンド)`, boardSnapshot);
    }

    // 押し目判定
    if (roundPb.direction === "buy") {
      // 買い: 一度下がった（close < signalPrice）→ 再上昇（close > signalPrice）でエントリー
      if (!roundPb.pulledBack && candle.close < roundPb.signalPrice) {
        roundPb.pulledBack = true;
      }
      if (roundPb.pulledBack && candle.close > roundPb.signalPrice) {
        roundPullbackStates.delete(symbol);
        // ★3分足HTFフィルター（ステートマシンエントリー時）: 逆方向のみブロック
        {
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
          if (htfTrend === "down") {
            console.log(`[RealtimeSim] ${symbol} 大台押し目確認: 3分足HTFフィルターによりブロック (LONG時にdown)`);
            return { symbol, tradeDate, candleTime, action: "none" };
          }
        }
        // ★v6b対策A: sell_pressure時の大台プルバック経由LONG禁止
        if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: sell_pressure時LONG禁止(プルバック経由)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        // ★v6: 板読みスコアで統合判定
        const brScoreBuy = boardReadingScore(symbol, "long", boardSnapshot);
        if (brScoreBuy < BOARD_SCORE_THRESHOLD) {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: 板読みスコア不足(${brScoreBuy})`);
          // ★スコア0+信頼度強ブロック記録
          if (brScoreBuy === 0 && roundPb.reason.includes("信頼度：強")) {
            insertScore0Block({
              tradeDate,
              symbol,
              candleTime,
              side: "BUY",
              signalReason: roundPb.reason.substring(0, 200),
              entryPrice: String(candle.close),
              boardScore: 0,
              confidence: "strong",
              context: "round_pullback_buy",
            });
          }
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        console.log(`[RealtimeSim] ${symbol} 大台押し目確認後エントリー: ${roundPb.reason} (板スコア:${brScoreBuy})`);
        // ★逆張りSHORT: 大台確認LONG + buy_pressure → SHORTに反転（過熱反転シグナル）
        if (boardSnapshot && boardSnapshot.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 大台確認LONG×buy_pressure → 逆張りSHORTに反転(押し目後): ${roundPb.reason}`);
          return await enterPosition("short", candle, tradeDate, candleTime, `${roundPb.reason} (過熱反転SHORT・押し目後)`, boardSnapshot);
        }
        // ★大台超えLONGブロック（2026-08-13）: buy_pressureでなければLONGエントリーしない
        console.log(`[RealtimeSim] ${symbol} 大台超えLONGブロック(押し目後): buy_pressureなし → エントリーしない`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    } else {
      // 売り: 一度上がった（close > signalPrice）→ 再下落（close < signalPrice）でエントリー
      if (!roundPb.pulledBack && candle.close > roundPb.signalPrice) {
        roundPb.pulledBack = true;
      }
      if (roundPb.pulledBack && candle.close < roundPb.signalPrice) {
        roundPullbackStates.delete(symbol);
        // ★3分足HTFフィルター（ステートマシンエントリー時）: 逆方向のみブロック
        {
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
          if (htfTrend === "up") {
            console.log(`[RealtimeSim] ${symbol} 大台押し目確認: 3分足HTFフィルターによりブロック (SHORT時にup)`);
            return { symbol, tradeDate, candleTime, action: "none" };
          }
        }
        // ★v6b対策A: buy_pressure時の大台プルバック経由SHORT禁止
        if (boardSnapshot && boardSnapshot.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: buy_pressure時SHORT禁止(プルバック経由)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        // ★v6: 板読みスコアで統合判定
        const brScoreSell = boardReadingScore(symbol, "short", boardSnapshot);
        if (brScoreSell < BOARD_SCORE_THRESHOLD) {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: 板読みスコア不足(${brScoreSell})`);
          // ★スコア0+信頼度強ブロック記録
          if (brScoreSell === 0 && roundPb.reason.includes("信頼度：強")) {
            insertScore0Block({
              tradeDate,
              symbol,
              candleTime,
              side: "SHORT",
              signalReason: roundPb.reason.substring(0, 200),
              entryPrice: String(candle.close),
              boardScore: 0,
              confidence: "strong",
              context: "round_pullback_short",
            });
          }
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        console.log(`[RealtimeSim] ${symbol} 大台押し目確認後エントリー: ${roundPb.reason} (板スコア:${brScoreSell})`);
        return await enterPosition("short", candle, tradeDate, candleTime, `${roundPb.reason} (押し目確認後)`, boardSnapshot);
      }
    }

    // まだ待機中
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 買いエントリー ----
  if (sig.type === "buy") {
    // ★VWAPクロス上抜けシグナル無効化（5日間検証で0勝4敗, -69,803円のため除外）
    if (sig.reason.includes("VWAPクロス上抜け")) {
      console.log(`[RealtimeSim] ${symbol} VWAPクロス上抜けシグナル: 無効化によりブロック (${sig.reason.substring(0, 40)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // ★v6b: sell_pressure時のLONG禁止（板が売り圧力時に買いエントリーをブロック）
    if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
      console.log(`[RealtimeSim] ${symbol} BUYシグナル: sell_pressure時LONG禁止 (${sig.reason.substring(0, 30)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // ★v6: 板読みスコアで統合判定
    const brScoreBuy = boardReadingScore(symbol, "long", boardSnapshot);
    let quietRiseBypassed = false; // 静かな上昇バイパスが適用されたかのフラグ
    if (brScoreBuy < BOARD_SCORE_THRESHOLD) {
      // ★静かな上昇バイパス（2026-08-17）: ①+②条件を満たすLONGはスコア0でもエントリー許可
      // ① MA乖離<0.5% + エントリー足実体<0.2%（静かな上昇）— 緩和A（8/18）
      // ② 直近10本で陰線4本以下（売り圧力不在）— 緩和A（8/18）
      // ③ 逆三尊シグナルは除外（逆三尊はmediumの精度が低いため、信頼度「強」のみエントリー）— 8/19
      const isInverseHS = sig.reason.includes("逆三尊") || sig.reason.includes("インバースH&S");
      const ma20 = buffer.length >= IS_BULLISH_MA_PERIOD
        ? buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).reduce((s, c) => s + c.close, 0) / IS_BULLISH_MA_PERIOD
        : 0;
      const maDeviation = ma20 > 0 ? (candle.close - ma20) / ma20 * 100 : 999;
      const barBody = Math.abs(candle.close - candle.open) / candle.open * 100;
      const recentBearBars = buffer.length >= 10
        ? buffer.slice(buffer.length - 10).filter(c => c.close < c.open).length
        : 999;
      const quietRiseBypass = isBullish && maDeviation < 0.5 && barBody < 0.2 && recentBearBars <= 4 && !isInverseHS;

      // ★案A: 前場ブースト（09:30〜11:27のみ緩和条件でバイパス）
      // ★案A: 前場ブースト — 撤廃（2026-08-19検証: PF0.83でマイナス、SHORTとの競合が発生）
      const isAMBoost = candleTime < AM_BOOST_END_TIME;
      // amBoostBypass は常にfalse（撤廃）
      const amBoostBypass = false;

      // ★案B: 出来高ブレイクLONG（前場のみ、出来高1.5倍以上 + 直近高値更新 + isBullish）
      let amVolBreakBypass = false;
      if (isAMBoost && isBullish && !isInverseHS && buffer.length >= 21) {
        const volLookback = buffer.slice(buffer.length - 21, buffer.length - 1);
        const avgVol = volLookback.reduce((s, c) => s + c.volume, 0) / 20;
        const volRatio = avgVol > 0 ? candle.volume / avgVol : 0;
        if (volRatio >= AM_VOL_BREAK_RATIO) {
          amVolBreakBypass = true;
        }
      }

      if (quietRiseBypass || amBoostBypass || amVolBreakBypass) {
        const bypassReason = quietRiseBypass ? "静かな上昇バイパス" : amBoostBypass ? "前場ブースト" : "出来高ブレイク";
        console.log(`[RealtimeSim] ${symbol} BUYシグナル: 板読みスコア0だが${bypassReason}でエントリー許可 (MA乖離:${maDeviation.toFixed(3)}%, 実体:${barBody.toFixed(3)}%, 陰線:${recentBearBars}本) (${sig.reason.substring(0, 30)})`);
        // ブロックせずに次のフィルターへ進む
        quietRiseBypassed = true;
      } else {
        console.log(`[RealtimeSim] ${symbol} BUYシグナル: 板読みスコア不足(${brScoreBuy}) (${sig.reason.substring(0, 30)})`);
      // ★スコア0+信頼度強ブロック記録
      if (brScoreBuy === 0 && sig.confidence === "strong") {
        insertScore0Block({
          tradeDate,
          symbol,
          candleTime,
          side: "BUY",
          signalReason: sig.reason.substring(0, 200),
          entryPrice: String(candle.close),
          boardScore: 0,
          confidence: "strong",
          context: "direct_buy",
        });
      }
      return { symbol, tradeDate, candleTime, action: "none" };
      }
    } else {
      // スコア1以上: 静かな上昇バイパスは不要（通常通過）
    }

    // ★3分足HTFフィルター: BUYシグナル全体に適用（逆方向=downのみブロック、neutral通過）
    {
      const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
      if (htfTrend === "down") {
        console.log(`[RealtimeSim] ${symbol} BUYシグナル: 3分足HTFフィルターによりブロック (トレンド: ${htfTrend}) (${sig.reason.substring(0, 40)})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }

    // ダウ理論（上昇）シグナルは押し目確認ステートマシンに登録して待機
    if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
      // ---- ★押し目深さフィルター (LONG) ----
      // 直近20本のスイング高値/安値を基準に、現在価格の押し目深さを計算
      // 30-70%の範囲外ならブロック（浅すぎ=高値づかみ、深すぎ=トレンド崩壊）
      if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
        const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK, buffer.length);
        const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
        const swingLow = Math.min(...lookbackWindow.map(c => c.low));
        if (swingHigh > swingLow) {
          const pullbackDepth = (swingHigh - candle.close) / (swingHigh - swingLow);
          if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) {
            console.log(
              `[RealtimeSim] ${symbol} ダウ理論LONG: 押し目深さフィルターによりブロック ` +
              `(深さ=${(pullbackDepth * 100).toFixed(1)}%, 許可範囲=${(PULLBACK_DEPTH_MIN * 100).toFixed(0)}-${(PULLBACK_DEPTH_MAX * 100).toFixed(0)}%)`
            );
            return { symbol, tradeDate, candleTime, action: "none" };
          }
        }
      }
      pullbackStates.set(symbol, {
        recentSwingLow: sig.recentSwingLow,
        signalPrice: candle.close,
        waitCount: 0,
        pulledBack: false,
        reason: sig.reason,
        boardSignal: boardSnapshot?.signal ?? undefined,
      });
      console.log(`[RealtimeSim] ${symbol} 押し目待機開始: ${sig.reason} (SwingLow:${sig.recentSwingLow})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 大台超えシグナルは確認バーステートマシンに登録して待機
    if (sig.reason.startsWith("大台超え")) {
      // ★大台超えLONG: LONGエントリーは停止（全敗のため）だが、
      // buy_pressure時の逆張りSHORTを有効にするためステートマシン登録は復活（2026-08-13）。
      // ステートマシン内でbuy_pressureなら逆張りSHORT、それ以外はLONGブロック。
      // ★銘柄別: disableRoundUpLong=trueの場合、逆張りSHORT用のステートマシン登録も行わない
      const symCfg = getSymbolConfig(symbol);
      if (symCfg.disableRoundUpLong) {
        console.log(`[RealtimeSim] ${symbol} 大台超えLONG完全無効化(銘柄別設定): ${sig.reason.substring(0, 50)}`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
      const level = m ? parseFloat(m[1]) : candle.close;
      roundLevelPendingStates.set(symbol, {
        direction: "buy",
        level,
        confirmCount: 0,
        reason: sig.reason,
        boardSignal: boardSnapshot?.signal ?? undefined,
      });
      console.log(`[RealtimeSim] ${symbol} 大台超え確認待機開始(逆張りSHORT用): ${sig.reason} (キリ番:${level}円)`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // ★改良策3改: medium直接エントリー禁止（ステートマシントリガー以外のmediumシグナルをブロック）
    if (sig.confidence === "medium") {
      // ★静かな上昇バイパス適用時はmediumでもエントリー許可（2026-08-17）
      if (quietRiseBypassed) {
        console.log(`[RealtimeSim] ${symbol} BUYシグナル: medium品質だがバイパスでエントリー許可 (${sig.reason.substring(0, 50)})`);
        return await enterPosition("long", candle, tradeDate, candleTime, sig.reason + " (バイパスLONG)", boardSnapshot);
      }
      // ★太陽誘電(6976)のみGC medium許可: close>MA20 + 陽線の場合にLONGエントリーを許可
      // 30日間シミュレーション: 27件, 勝率40.7%, +169,056円, PF 2.06
      if (symbol === "6976" && sig.reason.includes("ゴールデンクロス")) {
        const ma20Val = buffer.length >= 20
          ? buffer.slice(-20).reduce((s, c) => s + c.close, 0) / 20
          : 0;
        if (ma20Val > 0 && candle.close > ma20Val && candle.close > candle.open) {
          console.log(`[RealtimeSim] ${symbol} GC medium許可(太陽誘電特例): close=${candle.close} > MA20=${ma20Val.toFixed(0)}, 陽線`);
          return await enterPosition("long", candle, tradeDate, candleTime, sig.reason + " (GC medium許可)", boardSnapshot);
        }
      }
      console.log(`[RealtimeSim] ${symbol} BUY直接エントリーブロック: medium品質のため禁止 (${sig.reason.substring(0, 50)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    return await enterPosition("long", candle, tradeDate, candleTime, quietRiseBypassed ? sig.reason + " (静かな上昇バイパス)" : sig.reason, boardSnapshot);
  }

  // ---- 売り（空売り）エントリー ----
  if (sig.type === "sell") {
    // ★v6b: buy_pressure時のSHORT禁止（板が買い圧力時に売りエントリーをブロック）
    if (boardSnapshot && boardSnapshot.signal === "buy_pressure") {
      console.log(`[RealtimeSim] ${symbol} SHORTシグナル: buy_pressure時SHORT禁止 (${sig.reason.substring(0, 30)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // ★+D構成: isBullish方式によるSHORT全面禁止
    // その鋘柄が始値比+0.2%以上の上昇相場ならSHORTエントリー禁止
    if (isBullish) {
      console.log(`[RealtimeSim] ${symbol} SHORTブロック: isBullish方式 上昇相場判定 (${sig.reason.substring(0, 50)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // ★高値下落フィルター: 直近20本高値から1.5%以上下落済みならSHORTブロック
    // 下落の途中での追いかけSHORT（反発リスク大）を防止し、下落の初動のみに絞る
    if (buffer.length >= SHORT_DROP_FROM_HIGH_LOOKBACK) {
      const recentHighForDrop = Math.max(...buffer.slice(buffer.length - SHORT_DROP_FROM_HIGH_LOOKBACK).map(c => c.high));
      const dropFromHighPct = (recentHighForDrop - candle.close) / recentHighForDrop * 100;
      if (dropFromHighPct > SHORT_DROP_FROM_HIGH_MAX) {
        console.log(`[RealtimeSim] ${symbol} SHORTブロック: 高値下落フィルター (下落${dropFromHighPct.toFixed(2)}% > ${SHORT_DROP_FROM_HIGH_MAX}%) (${sig.reason.substring(0, 50)})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }

    // ★v6: 板読みスコアで統合判定
    const brScoreShort = boardReadingScore(symbol, "short", boardSnapshot);
    if (brScoreShort < BOARD_SCORE_THRESHOLD) {
      // ★SHORTスコア0ブロック緩和（2026-08-19）: 逆三尊以外かつneutral以外はスコア0でもエントリー許可
      const isInverseHS_short = sig.reason.includes("逆三尊") || sig.reason.includes("インバースH&S");
      const isNeutralBoard = boardSnapshot?.signal === "neutral";
      if (isInverseHS_short || isNeutralBoard) {
        // 逆三尊SHORTまたはneutral時SHORTはスコア0でブロック維持
        const blockReason = isInverseHS_short ? "逆三尊ブロック維持" : "neutralブロック";
        console.log(`[RealtimeSim] ${symbol} SHORTシグナル: 板読みスコア不足(${brScoreShort}) [${blockReason}] (${sig.reason.substring(0, 30)})`);
        if (brScoreShort === 0 && sig.confidence === "strong") {
          insertScore0Block({
            tradeDate,
            symbol,
            candleTime,
            side: "SHORT",
            signalReason: sig.reason.substring(0, 200),
            entryPrice: String(candle.close),
            boardScore: 0,
            confidence: "strong",
            context: isInverseHS_short ? "direct_short" : "neutral_short",
          });
        }
        return { symbol, tradeDate, candleTime, action: "none" };
      } else {
        // 逆三尊以外かつneutral以外（ダウ理論/VWAP/大台割れ）はスコア0でもSHORTエントリー許可
        console.log(`[RealtimeSim] ${symbol} SHORTシグナル: 板読みスコア不足(${brScoreShort})だがスコア0バイパス許可 (${sig.reason.substring(0, 30)})`);
      }
    }
    // ★3分足HTFフィルター: SELLシグナル全体に適用（逆方向=upのみブロック、neutral通過）
    {
      const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
      if (htfTrend === "up") {
        console.log(`[RealtimeSim] ${symbol} SELLシグナル: 3分足HTFフィルターによりブロック (トレンド: ${htfTrend}) (${sig.reason.substring(0, 40)})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }

    if (sig.reason.startsWith("ダウ理論: 直近安値更新")) {
      // ---- ★押し目深さフィルター (SHORT) ----
      // 直近20本のスイング高値/安値を基準に、現在価格の戻り深さを計算
      // 30-70%の範囲外ならブロック（浅すぎ=安値圈、深すぎ=トレンド崩壊）
      if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
        const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK, buffer.length);
        const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
        const swingLow = Math.min(...lookbackWindow.map(c => c.low));
        if (swingHigh > swingLow) {
          // SHORTの押し目深さ: 安値からどれだけ戻したか
          const pullbackDepth = (candle.close - swingLow) / (swingHigh - swingLow);
          if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) {
            console.log(
              `[RealtimeSim] ${symbol} ダウ理論SHORT: 押し目深さフィルターによりブロック ` +
              `(深さ=${(pullbackDepth * 100).toFixed(1)}%, 許可範囲=${(PULLBACK_DEPTH_MIN * 100).toFixed(0)}-${(PULLBACK_DEPTH_MAX * 100).toFixed(0)}%)`
            );
            return { symbol, tradeDate, candleTime, action: "none" };
          }
        }
      }
    }

    // 大台割れシグナルは確認バーステートマシンに登録して待機
    if (sig.reason.startsWith("大台割れ")) {
      if (safeCbBlockedNow || shouldBlockSafeCbShort(symbol, candle, buffer)) {
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ★案6改: 出来高急増時は即エントリー（CB/MW待機をスキップ）— sell_pressure条件撤廃
      const buffer6 = candleBuffers.get(symbol);
      let volRatio = 0;
      if (buffer6 && buffer6.length >= FAST_ENTRY_VOL_LOOKBACK && candle.volume > 0) {
        const recentVols = buffer6.slice(buffer6.length - FAST_ENTRY_VOL_LOOKBACK);
        const avgVol = recentVols.reduce((s, c) => s + c.volume, 0) / FAST_ENTRY_VOL_LOOKBACK;
        volRatio = avgVol > 0 ? candle.volume / avgVol : 0;
      }
      if (volRatio >= FAST_ENTRY_VOL_RATIO) {
        console.log(`[RealtimeSim] ${symbol} 大台割れSHORT即エントリー: 出来高${volRatio.toFixed(1)}倍(≥${FAST_ENTRY_VOL_RATIO}倍) (${sig.reason})`);
        return await enterPosition("short", candle, tradeDate, candleTime, sig.reason + " (即エントリー: vol)", boardSnapshot);
      }

      // ② 案4a: 前足がキリ番+0.05%以内 → 即エントリー
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
      const level = m ? parseFloat(m[1]) : candle.close;
      if (buffer6 && buffer6.length >= 2) {
        const prevClose = buffer6[buffer6.length - 2].close;
        if (prevClose >= level) {
          const prevDistPct = (prevClose - level) / level * 100;
          if (prevDistPct <= FAST_ENTRY_PREV_DIST_PCT) {
            console.log(`[RealtimeSim] ${symbol} 大台割れSHORT即エントリー(前足近接): 前足乖離${prevDistPct.toFixed(3)}%(≤${FAST_ENTRY_PREV_DIST_PCT}%) (${sig.reason})`);
            return await enterPosition("short", candle, tradeDate, candleTime, sig.reason + " (即エントリー: 前足近接)", boardSnapshot);
          }
        }
      }

      // ③ 従来フロー: CB=2, MW=1で待機
      roundLevelPendingStates.set(symbol, {
        direction: "sell",
        level,
        confirmCount: 0,
        reason: sig.reason,
        boardSignal: boardSnapshot?.signal ?? undefined,
      });
      console.log(`[RealtimeSim] ${symbol} 大台割れ確認待機開始: ${sig.reason} (キリ番:${level}円)`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // ★+D構成: SHORT medium全ブロック（6/26版回帰）
    // アブレーションテストでmedium許可は-18.3%のマイナス影響が確認されたため全ブロック
    if (sig.confidence === "medium") {
      console.log(`[RealtimeSim] ${symbol} SHORT mediumブロック: 全ブロック方式 (${sig.reason.substring(0, 50)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 6981はダウ理論の即時SHORTではなく、寄り付きブレイクSHORTの1本確認だけで下落初動を扱う。
    if (symConfig.enableOpeningBreakShort && sig.reason.startsWith("ダウ理論: 直近安値更新")) {
      console.log(`[RealtimeSim] ${symbol} ダウ理論SHORT: 寄り付きブレイクSHORTの専用確認経路へ委譲`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // ★案1: 直近安値更新即エントリー（大台割れとは独立した条件）（2026-08-19）
    // 直近20本の安値を更新 + 出来高1.2倍以上 + isBullish=false → 即SHORTエントリー
    // 30営業日シミュレーション: 229件 勝率47.2% +808,325円 PF1.41
    if (!isBullish && sig.reason.startsWith("ダウ理論: 直近安値更新") && buffer.length >= SHORT_LOW_BREAK_LOOKBACK + 1) {
      const recentVols = buffer.slice(buffer.length - SHORT_LOW_BREAK_LOOKBACK - 1, buffer.length - 1);
      const avgVol = recentVols.reduce((s, c) => s + c.volume, 0) / SHORT_LOW_BREAK_LOOKBACK;
      const volRatio = avgVol > 0 ? candle.volume / avgVol : 0;
      if (volRatio >= SHORT_LOW_BREAK_VOL_RATIO) {
        console.log(`[RealtimeSim] ${symbol} 直近安値更新SHORT即エントリー: 出来高${volRatio.toFixed(1)}倍(≥${SHORT_LOW_BREAK_VOL_RATIO}倍) (${sig.reason.substring(0, 60)})`);
        return await enterPosition("short", candle, tradeDate, candleTime, sig.reason + " (安値更新即エントリー)", boardSnapshot);
      }
    }

    return await enterPosition("short", candle, tradeDate, candleTime, sig.reason, boardSnapshot);
  }

  return { symbol, tradeDate, candleTime, action: "none" };
}

/**
 * ポジションをエントリーする
 */
export async function enterPosition(
  side: "long" | "short",
  candle: RtCandle1Min,
  tradeDate: string,
  candleTime: string,
  reason: string,
  boardSnapshot: BoardSnapshot | null,
  riskOverride?: { slPct: number; tpPct: number },
): Promise<ReturnType<typeof processCandle>> {
  const { symbol } = candle;

  // エントリー対象銘柄制限チェック
  if (ACTIVE_ENTRY_SYMBOLS !== null && !ACTIVE_ENTRY_SYMBOLS.has(symbol)) {
    return { symbol, tradeDate, candleTime, action: "none" as const };
  }

  const price = candle.close;
  const shares = calcShares(price);
  const amount = price * shares;
  const action = side === "long" ? "buy" : "short";
  const boardSignal = boardSnapshot?.signal ?? undefined;
  const isFujikuraAfternoonLowBreakShort = reason.startsWith("後場安値更新SHORT");

  // ---- ★v5.5応急フィルター: 出来高取得不可時のエントリー制限 ----
  const buffer = candleBuffers.get(symbol);
  const isVolumeUnavailable = checkVolumeUnavailable(buffer);
  if (isVolumeUnavailable) {
    // 応急②: 12時台（昼休み明け）のエントリー禁止
    if (candleTime >= NO_ENTRY_LUNCH_START && candleTime <= NO_ENTRY_LUNCH_END) {
      console.log(
        `[RealtimeSim] ★応急フィルター: ${symbol} 12時台エントリーブロック（出来高取得不可）`
      );
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // 応急③: 損切り後30分以内の同一銘柄再エントリー禁止
    const lastSL = lastStopLossTime.get(symbol);
    if (lastSL) {
      const minSinceStop = timeToMinutes(candleTime) - timeToMinutes(lastSL);
      if (minSinceStop >= 0 && minSinceStop < NO_REENTRY_AFTER_STOPLOSS_MIN) {
        console.log(
          `[RealtimeSim] ★応急フィルター: ${symbol} 損切り後${minSinceStop}分で再エントリーブロック ` +
          `(禁止期間:${NO_REENTRY_AFTER_STOPLOSS_MIN}分, 前回損切り:${lastSL})`
        );
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }
  }

  // ---- ★ATRフィルター: 低ボラティリティ銀柄のエントリーをブロック ----
  if (buffer && buffer.length >= ATR_FILTER_PERIOD + 1) {
    const highs = buffer.map(c => c.high);
    const lows = buffer.map(c => c.low);
    const closes = buffer.map(c => c.close);
    const atrSeries = calcATR(highs, lows, closes, ATR_FILTER_PERIOD);
    const latestATR = atrSeries[atrSeries.length - 1];
    if (latestATR !== null && price > 0) {
      const atrRatio = latestATR / price;
      if (atrRatio < ATR_FILTER_THRESHOLD) {
        console.log(
          `[RealtimeSim] ATRフィルター: ${symbol} エントリーブロック ` +
          `(ATR率=${(atrRatio * 100).toFixed(4)}% < 閾値${(ATR_FILTER_THRESHOLD * 100).toFixed(2)}%)`
        );
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }
  }

  // ---- ★後場BPRフィルター: 13:00以降SHORTでBPR>=0.65ならブロック ----
  if (side === "short" && !isFujikuraAfternoonLowBreakShort && candleTime >= PM_BPR_FILTER_START && boardSnapshot) {
    const bpr = boardSnapshot.buyPressureRatio;
    if (typeof bpr === "number" && bpr >= PM_BPR_BLOCK_THRESHOLD) {
      console.log(
        `[RealtimeSim] 後場BPRフィルター: ${symbol} SHORTエントリーブロック ` +
        `(BPR=${bpr.toFixed(3)} >= 閾値${PM_BPR_BLOCK_THRESHOLD}, 時刻=${candleTime})`
      );
      // シグナル履歴にブロックを記録
      signalHistory.unshift({
        time: candleTime,
        symbol,
        symbolName: getStockName(symbol),
        action: "pm_bpr_block",
        price,
        shares: 0,
        pnl: null,
        reason: `後場BPRフィルター: BPR=${bpr.toFixed(3)}>=${PM_BPR_BLOCK_THRESHOLD} → SHORTブロック (${reason.substring(0, 40)})`,
      });
      if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;
      return { symbol, tradeDate, candleTime, action: "none" };
    }
  }

  // ---- ★午後安値圏フィルター: 13:00以降SHORTで始値比-5%以上下落済みならブロック ----
  if (side === "short" && !isFujikuraAfternoonLowBreakShort && candleTime >= "13:00" && buffer && buffer.length > 0) {
    const openPrice = buffer[0].open; // 当日始値（バッファ先頭 = 09:00台の最初の足）
    if (openPrice > 0) {
      const dropFromOpen = (price - openPrice) / openPrice;
      if (dropFromOpen <= -0.05) {
        console.log(
          `[RealtimeSim] 午後安値圏フィルター: ${symbol} SHORTブロック ` +
          `(始値${openPrice}→現在${price}, 始値比${(dropFromOpen * 100).toFixed(1)}% <= -5%)`
        );
        signalHistory.unshift({
          time: candleTime,
          symbol,
          symbolName: getStockName(symbol),
          action: "pm_lowzone_block",
          price,
          shares: 0,
          pnl: null,
          reason: `午後安値圏フィルター: 始値比${(dropFromOpen * 100).toFixed(1)}% <= -5% → SHORTブロック (${reason.substring(0, 40)})`,
        });
        if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }
  }

  // ---- ★午後高値圏フィルター: 13:00以降LONGで始値比+4%以上上昇済みならブロック ----
  if (side === "long" && candleTime >= "13:00" && buffer && buffer.length > 0) {
    const openPrice = buffer[0].open;
    if (openPrice > 0) {
      const riseFromOpen = (price - openPrice) / openPrice;
      if (riseFromOpen >= PM_HIGHZONE_THRESHOLD) {
        console.log(
          `[RealtimeSim] 午後高値圏フィルター: ${symbol} LONGブロック ` +
          `(始値${openPrice}→現在${price}, 始値比+${(riseFromOpen * 100).toFixed(1)}% >= +${(PM_HIGHZONE_THRESHOLD * 100).toFixed(0)}%)`
        );
        signalHistory.unshift({
          time: candleTime,
          symbol,
          symbolName: getStockName(symbol),
          action: "pm_highzone_block",
          price,
          shares: 0,
          pnl: null,
          reason: `午後高値圏フィルター: 始値比+${(riseFromOpen * 100).toFixed(1)}% >= +${(PM_HIGHZONE_THRESHOLD * 100).toFixed(0)}% → LONGブロック (${reason.substring(0, 40)})`,
        });
        if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }
  }

  // ---- 証拠金使用率制限チェック ----
  // 現在のオープンポジション合計 + 今回の投資額が MAX_TOTAL_EXPOSURE を超える場合はエントリー停止
  const currentExposure = calcCurrentExposure();
  if (currentExposure + amount > MAX_TOTAL_EXPOSURE) {
    console.log(
      `[RealtimeSim] 証拠金使用率制限: ${symbol} エントリーキャンセル ` +
      `(現在${(currentExposure / 10000).toFixed(0)}万円 + 今回${(amount / 10000).toFixed(0)}万円 = ` +
      `${((currentExposure + amount) / 10000).toFixed(0)}万円 > 上限${(MAX_TOTAL_EXPOSURE / 10000).toFixed(0)}万円)`
    );
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 信頼度（confidence）を計算 ----
  let confidence: SignalConfidence = "medium";
  if (buffer && buffer.length > 1) {
    const volumes = buffer.map(c => c.volume);
    const closes = buffer.map(c => c.close);
    const idx = buffer.length - 1;
    const ma5Val = buffer[idx]?.ma5 ?? null;
    const ma25Val = buffer[idx]?.ma25 ?? null;
    const confResult = evaluateConfirmation({
      type: side === "long" ? "buy" : "sell",
      close: price,
      volume: candle.volume,
      avgVolume: trailingAvgVolume(volumes, idx, 10),
      ma5: ma5Val,
      ma25: ma25Val,
      momentum: priceMomentum(closes, idx, 3),
    });
    confidence = confResult.confidence;
  }

  const pos: OpenPosition = {
    symbol,
    side,
    entryPrice: price,
    shares,
    entryTime: candleTime,
    entryReason: reason,
    boardSignal,
    confidence,
    slPctOverride: riskOverride?.slPct,
    tpPctOverride: riskOverride?.tpPct,
  };

  openPositions.set(symbol, pos);

  await insertRtTrade({
    tradeDate,
    symbol,
    symbolName: getStockName(symbol),
    action,
    price: String(price),
    shares,
    amount,
    pnl: null,
    reason,
    tradeTime: candleTime,
    side,
    boardSignal: boardSignal ?? null,
  });

  console.log(`[RealtimeSim] ${symbol} ${action} @${price}円 ×${shares}株 (${reason})`);

  // シグナル履歴に追加（エントリー）
  signalHistory.unshift({
    time: candleTime,
    symbol,
    symbolName: getStockName(symbol),
    action,
    price,
    shares,
    pnl: null,
    reason,
    confidence,
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;

  return { symbol, tradeDate, candleTime, action: "entry", reason };
}

/**
 * 損切り・利確チェック
 */
async function checkExitConditions(
  pos: OpenPosition,
  candle: RtCandle1Min,
  tradeDate: string,
  candleTime: string,
  boardSnapshot: BoardSnapshot | null,
): Promise<ReturnType<typeof processCandle>> {
  const { symbol, side, entryPrice, shares } = pos;
  const { high, low, close } = candle;

  // ---- +D構成: BEストップ撤廃、純粋SL/TPのみ ----
  // アブレーションテストでBEストップは-15.4%のマイナス影響が確認されたため撤廃

  let exitPrice: number | null = null;
  let exitReason = "";
  let action: "exit" | "stop_loss" | "take_profit" = "exit";

  // 銘柄別TP/SL解決
  const override = SYMBOL_TP_SL_OVERRIDE[symbol];
  // ★銘柄別SYMBOL_CONFIGのTP設定を優先（反転LONG用のTP 0.8%等）
  const symCfgExit = getSymbolConfig(symbol);
  const configuredTpPct = symCfgExit.tp
    ? (side === "long" ? symCfgExit.tp.long : symCfgExit.tp.short)
    : override ? override.tp : (side === "long" ? TAKE_PROFIT_PERCENT_LONG : TAKE_PROFIT_PERCENT_SHORT);
  const tpPct = pos.tpPctOverride ?? configuredTpPct;
  // SL: USE_PER_SYMBOL_SL有効時はSYMBOL_SL_MAPを優先、なければレガシーoverride、最終デフォルト
  const slEntry = SYMBOL_SL_MAP[symbol];
  const configuredSlPct = USE_PER_SYMBOL_SL && slEntry !== undefined
    ? (side === "long" ? slEntry.long : slEntry.short)
    : override ? override.sl : STOP_LOSS_PERCENT;
  const slPct = pos.slPctOverride ?? configuredSlPct;

  if (side === "long") {
    // 損切り: 通常SLのみ
    const stopLine = entryPrice * (1 - slPct / 100);
    if (low <= stopLine) {
      exitPrice = stopLine;
      exitReason = `損切り (損切りライン:${stopLine.toFixed(0)}円)`;
      action = "stop_loss";
    }
    // 利確: 高値が利確ラインを上回った
    const tpLine = entryPrice * (1 + tpPct / 100);
    if (high >= tpLine && exitPrice === null) {
      exitPrice = tpLine;
      exitReason = `利確 (利確ライン:${tpLine.toFixed(0)}円)`;
      action = "take_profit";
    }
  } else {
    // 空売り: 損切り（通常SLのみ）
    const stopLine = entryPrice * (1 + slPct / 100);
    if (high >= stopLine) {
      exitPrice = stopLine;
      exitReason = `損切り (損切りライン:${stopLine.toFixed(0)}円)`;
      action = "stop_loss";
    }
    // 空売り: 利確（安値が利確ラインを下回った）
    const tpLine = entryPrice * (1 - tpPct / 100);
    if (low <= tpLine && exitPrice === null) {
      exitPrice = tpLine;
      exitReason = `利確 (利確ライン:${tpLine.toFixed(0)}円)`;
      action = "take_profit";
    }
  }

  // シグナル反転による決済
  if (exitPrice === null) {
    const buffer = candleBuffers.get(symbol);
    if (buffer && buffer.length > 0) {
      const latest = buffer[buffer.length - 1];
      if (latest.signal) {
        if (side === "long" && latest.signal.type === "sell") {
          exitPrice = close;
          exitReason = `シグナル反転決済: ${latest.signal.reason}`;
          action = "exit";
        } else if (side === "short" && latest.signal.type === "buy") {
          exitPrice = close;
          exitReason = `シグナル反転決済: ${latest.signal.reason}`;
          action = "exit";
        }
      }
    }
  }

  // ★v6: 板読み早期利確
  if (exitPrice === null && shouldBoardEarlyExit(pos, close, boardSnapshot)) {
    exitPrice = close;
    exitReason = `板読み早期利確 (逆方向板圧力検出)`;
    action = "take_profit";
    console.log(`[RealtimeSim] ${symbol} 板読み早期利確: @${close}円 (bpr:${boardSnapshot?.buyPressureRatio}, signal:${boardSnapshot?.signal})`);
  }

  // 東京エレクトロン: 22本の確定足を経過してもTP・SL・既存決済がなければ次足始値で決済する。
  // 当足でSL/TP等が先に成立した場合はそれらを優先し、未来情報は参照しない。
  if (exitPrice === null && symCfgExit.telMaxHoldingMinutes !== undefined) {
    const elapsedMinutes = timeToMinutes(candleTime) - timeToMinutes(pos.entryTime);
    if (elapsedMinutes > symCfgExit.telMaxHoldingMinutes) {
      exitPrice = candle.open;
      exitReason = `最大保有${symCfgExit.telMaxHoldingMinutes}分経過後の次足始値決済`;
      action = "exit";
    }
  }

  if (exitPrice === null) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  return await closePosition(pos, exitPrice, exitReason, action, tradeDate, candleTime, boardSnapshot);
}

/**
 * 大引け強制決済
 */
async function forceClosePosition(
  pos: OpenPosition,
  candle: RtCandle1Min,
  tradeDate: string,
  candleTime: string,
  reason: string,
): Promise<ReturnType<typeof processCandle>> {
  return await closePosition(pos, candle.close, reason, "exit", tradeDate, candleTime, null);
}

/**
 * ポジションを決済する
 */
async function closePosition(
  pos: OpenPosition,
  exitPrice: number,
  reason: string,
  action: "exit" | "stop_loss" | "take_profit",
  tradeDate: string,
  candleTime: string,
  boardSnapshot: BoardSnapshot | null,
): Promise<ReturnType<typeof processCandle>> {
  const { symbol, side, entryPrice, shares } = pos;
  const exitAction = side === "long" ? "sell" : "cover";
  const amount = exitPrice * shares;

  // 損益計算
  const pnl = side === "long"
    ? Math.round((exitPrice - entryPrice) * shares)
    : Math.round((entryPrice - exitPrice) * shares);

  openPositions.delete(symbol);

  // ★v5.5応急: 損切り時刻を記録（再エントリー禁止フィルター用）
  if (action === "stop_loss") {
    lastStopLossTime.set(symbol, candleTime);
    const config = getSymbolConfig(symbol);
    const isAdvantestSpecial = symbol === "6857" && (
      pos.entryReason.startsWith("アドバンテスト高値失速SHORT") ||
      pos.entryReason.startsWith("アドバンテスト確認型LONG")
    );
    if (config.enableAdvantestPostStopReentry && isAdvantestSpecial) {
      advantestPostStopReentry.set(symbol, { stoppedSide: side, stopTime: candleTime, reentryUsed: false });
      console.log(`[RealtimeSim] ${symbol} アドバンテスト損切り後再評価を許可: ${side}停止 @${candleTime}`);
    }
  }

  await insertRtTrade({
    tradeDate,
    symbol,
    symbolName: getStockName(symbol),
    action: exitAction,
    price: String(exitPrice),
    shares,
    amount,
    pnl,
    reason,
    tradeTime: candleTime,
    side,
    boardSignal: boardSnapshot?.signal ?? null,
  });

  console.log(`[RealtimeSim] ${symbol} ${exitAction} @${exitPrice}円 ×${shares}株 損益:${pnl >= 0 ? "+" : ""}${pnl}円 (${reason})`);

  // 銘柄別損益を更新
  symbolPnlMap.set(symbol, (symbolPnlMap.get(symbol) ?? 0) + pnl);

  // シグナル履歴に追加（決済エントリ）
  signalHistory.unshift({
    time: candleTime,
    symbol,
    symbolName: getStockName(symbol),
    action: action === "stop_loss" ? "stop_loss" : action === "take_profit" ? "take_profit" : exitAction,
    price: exitPrice,
    shares,
    pnl,
    reason,
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;

  // 日次サマリーを更新
  await updateDailySummary(tradeDate);

  return { symbol, tradeDate, candleTime, action, reason, pnl };
}

/**
 * 日次サマリーをDBに更新する
 */
async function updateDailySummary(tradeDate: string): Promise<void> {
  try {
    const trades = await getRtTradesForDate(tradeDate);

    // 決済済みトレードのみ集計（buy/shortはエントリー、sell/coverは決済）
    const closedTrades = trades.filter(t => t.action === "sell" || t.action === "cover");
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const winCount = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
    const lossCount = closedTrades.filter(t => (t.pnl ?? 0) <= 0).length;

    // 全銘柄の受信足数合計
    let totalCandles = 0;
    for (const count of Array.from(candleCounters.values())) {
      totalCandles += count;
    }

    await upsertRtDailySummary({
      tradeDate,
      initialCapital: INITIAL_CAPITAL_PER_STOCK * 5, // 5銘柄分
      totalPnl,
      tradesCount: closedTrades.length,
      winCount,
      lossCount,
      candlesReceived: totalCandles,
    });
  } catch (err) {
    console.error("[RealtimeSim] 日次サマリー更新エラー:", err);
  }
}

/**
 * 大引け後の全ポジション強制決済（スケジューラーから呼ばれる）
 *
 * @param tradeDate 対象日 (YYYY-MM-DD)
 * @param closingPrices 銘柄コード → 引け値のマップ
 */
export async function forceCloseAllPositions(
  tradeDate: string,
  closingPrices: Map<string, number>,
): Promise<void> {
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  const jstMin = now.getUTCMinutes();
  const closeTime = `${String(jstHour).padStart(2, "0")}:${String(jstMin).padStart(2, "0")}`;

  for (const [symbol, pos] of Array.from(openPositions.entries()) as [string, OpenPosition][]) {
    const price = closingPrices.get(symbol) ?? pos.entryPrice;
    const fakeCandle: RtCandle1Min = {
      symbol,
      tradeDate,
      candleTime: closeTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
    await forceClosePosition(pos, fakeCandle, tradeDate, closeTime, "大引け強制決済（スケジューラー）");
  }

  // ★3山v2: 仮想ポジションも強制決済
  const price6981 = closingPrices.get("6981");
  if (price6981) {
    await forceCloseThreePeakPosition(tradeDate, price6981);
  }
}

/**
 * 現在のオープンポジション一覧を返す（UI表示用）
 */
export function getOpenPositions(): OpenPosition[] {
  return Array.from(openPositions.values());
}

/**
 * DBから復元したエントリーレコードをメモリ上のopenPositions Mapに復元する。
 * サーバー再起動後にスケジューラーが大引け強制決済を行う際に使用する。
 */
export function restoreOpenPositions(entries: Array<{
  symbol: string;
  side: "long" | "short";
  price: string | number;
  shares: number;
  tradeTime: string;
  reason: string;
}>): void {
  for (const entry of entries) {
    if (!openPositions.has(entry.symbol)) {
      openPositions.set(entry.symbol, {
        symbol: entry.symbol,
        side: entry.side,
        entryPrice: Number(entry.price),
        shares: entry.shares,
        entryTime: entry.tradeTime,
        entryReason: entry.reason,
      });
      console.log(`[RealtimeSim] Restored open position from DB: ${entry.symbol} ${entry.side} @${entry.price}円 ×${entry.shares}株`);
    }
  }
}

/**
 * 当日の受信足数を返す（UI表示用）
 */
export function getCandleCounters(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sym, count] of Array.from(candleCounters.entries())) {
    result[sym] = count;
  }
  return result;
}

/**
 * 最後に1分足を受信した時刻を返す（接続監視用）
 */
export function getLastCandleReceivedAt(): string | null {
  return lastCandleReceivedAt;
}

/**
 * 銘柄ごとの確定損益（当日分）を返す
 */
export function getSymbolPnlMap(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sym, pnl] of Array.from(symbolPnlMap.entries())) {
    result[sym] = pnl;
  }
  return result;
}

/**
 * 当日のシグナル履歴を返す（最新N件）
 */
export function getSignalHistory(limit = 50): typeof signalHistory {
  return signalHistory.slice(0, limit);
}

/**
 * ダッシュボード用の統合ステータスを返す
 */
// ============================================================
// ★v5.5応急フィルター: ヘルパー関数
// ============================================================

/**
 * 出来高取得不可状態を判定する。
 * 直近20本の足のうち90%以上がvolume=0なら「出来高取得不可」と判定。
 * WebSocket出来高が復旧すれば自動的にフィルターが無効化される。
 */
function checkVolumeUnavailable(buffer: CandleWithSignal[] | undefined): boolean {
  if (!buffer || buffer.length < 10) return false;
  const lookback = Math.min(buffer.length, 20);
  const recentCandles = buffer.slice(buffer.length - lookback);
  const zeroVolumeCount = recentCandles.filter(c => c.volume === 0).length;
  return (zeroVolumeCount / lookback) >= VOLUME_UNAVAILABLE_RATIO;
}

/**
 * HH:MM形式の時刻文字列を分単位の数値に変換する。
 * 例: "09:30" → 570, "12:00" → 720
 */
function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

export function getDashboardStatus(): {
  lastCandleReceivedAt: string | null;
  currentTradeDate: string;
  totalCandlesReceived: number;
  openPositionCount: number;
  symbolPnl: Record<string, number>;
  totalPnl: number;
  candleCounters: Record<string, number>;
  signalHistory: typeof signalHistory;
} {
  const symbolPnl = getSymbolPnlMap();
  const totalPnl = Object.values(symbolPnl).reduce((sum, v) => sum + v, 0);
  let totalCandlesReceived = 0;
  const counters: Record<string, number> = {};
  for (const [sym, count] of Array.from(candleCounters.entries())) {
    counters[sym] = count;
    totalCandlesReceived += count;
  }
  return {
    lastCandleReceivedAt,
    currentTradeDate,
    totalCandlesReceived,
    openPositionCount: openPositions.size,
    symbolPnl,
    totalPnl,
    candleCounters: counters,
    signalHistory: signalHistory.slice(0, 100),
  };
}

/** ★案6改: 大台割れSHORT即エントリー条件（出来高急増時はCB/MW待機をスキップ）
 *  sell_pressure条件撤廃: 40営業日検証で出来高のみの方が勝率+2pt, PF+0.12, 損益+149,473円改善
 *  条件: 出来高が直近20本平均の1.5倍以上 */
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_VOL_LOOKBACK = 20;

/** ★案4a: 前足近接即エントリー条件（前足closeがキリ番から+0.05%以内で割れたら即エントリー）
 *  30営業日検証: 現行比+159,592円改善, 勝率40.9%(+1.4pt), PF1.44(+0.08)
 *  優先順位: ①即vol(出来高1.5倍) → ②即4a(前足近接) → ③従来CB2MW1 */
const FAST_ENTRY_PREV_DIST_PCT = 0.05; // 前足closeがキリ番から0.05%以内

// ============================================================
// ★案A+B前場のみ: 前場ブースト + 出来高ブレイクLONG（2026-08-19）
// 30営業日シミュレーション: 860件 54.8% +1,177,390円 PF1.17 (現行577件 51.6% +294,492円 PF1.06)
// 前場のみ適用、後場は現行バイパス条件を維持
// ============================================================

/** 案A: 前場ブースト終了時刻（分）— 09:30〜11:27の間で緩和条件を適用 */
const AM_BOOST_END_TIME = "11:27"; // 前場強制決済と同じ

/** 案A: 前場ブーストのMA乖離閾値（通常0.5%→前場は1.0%に緩和） */
const AM_BOOST_MA_DEV_MAX = 1.0;
/** 案A: 前場ブーストの実体閾値（通常0.2%→前場は0.5%に緩和） */
const AM_BOOST_BODY_MAX = 0.5;
/** 案A: 前場ブーストの陰線閾値（通常4本→前場は5本に緩和） */
const AM_BOOST_BEAR_MAX = 5;

/** 案B: 出来高ブレイクLONGの出来高倍率閾値（前場のみ適用） */
const AM_VOL_BREAK_RATIO = 1.5;

/** ★SHORT改善 案1: 直近安値更新即エントリーの出来高閾値（直近20本平均の1.2倍以上） */
const SHORT_LOW_BREAK_VOL_RATIO = 1.2;
/** ★SHORT改善 案1: 直近安値更新のルックバック期間 */
const SHORT_LOW_BREAK_LOOKBACK = 20;

/** ★高値下落フィルター: 直近20本高値から1.5%以上下落済みならSHORTブロック */
const SHORT_DROP_FROM_HIGH_MAX = 2.0; // % (旧1.5% → 2.0%に緩和: 30営業日 +3,835k PF1.33)
const SHORT_DROP_FROM_HIGH_LOOKBACK = 20;
