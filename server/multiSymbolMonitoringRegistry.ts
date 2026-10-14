import { ACTIVE_ENTRY_SYMBOLS, NAME_BY_SYMBOL } from "../shared/stocks";
import {
  ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
  ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
  AI_DAILY_FORECAST_VERSIONS,
  RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS,
  BOLLINGER_DIRECTIONAL_FIXED_STOP_140_V3_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V3_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V5_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V3_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V3_VERSIONS,
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
  DISCO_SHORT_BASELINE_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  FUJIKURA_MORNING_SHORT_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";

export type MonitoringPlanPurpose = "current" | "candidate" | "diagnostic" | "paused_baseline";

export interface MonitoringPlanDefinition {
  planId: string;
  /** 古いimmutable日次snapshotにだけ存在する同一監視行のID。read-time集計専用。 */
  legacyPlanIds?: readonly string[];
  symbol: string;
  symbolName: string;
  label: string;
  origin: "current" | "forward_shadow";
  /** 表示上の運用role。データ取得元originと分離し、forward shadowを現行仮想として昇格できる。 */
  role: "current" | "shadow";
  /** current ledgerから読む場合だけ、通常候補か降格済みshadow_only候補かを固定する。 */
  candidateRouteId?: string;
  candidateDisposition?: "active" | "shadow_only";
  strategyVersion: string;
  purpose: MonitoringPlanPurpose;
  eligibleForAdoption: boolean;
}

export const TEN_MONITORED_SYMBOLS = Object.freeze(
  Array.from(ACTIVE_ENTRY_SYMBOLS ?? []).sort(),
);
export const PROMOTED_FORWARD_CURRENT_VERSIONS = Object.freeze([
  SUMCO_TIME_15_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
] as const);
const PROMOTED_FORWARD_CURRENT_SYMBOLS = new Set(["3436", "6146", "6976"]);

const SHADOW_PLANS: ReadonlyArray<
  Omit<MonitoringPlanDefinition, "planId" | "origin" | "symbolName" | "role"> & {
    role?: MonitoringPlanDefinition["role"];
  }
> = [
  { strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, symbol: "285A", label: "A案：確認型前場LONG・MA8失速保護", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, symbol: "285A", label: "B案：現行5経路・ATR0.36%", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SUMCO_VOLUME_110_VERSION, symbol: "3436", label: "A案：出来高1.10倍", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SUMCO_TIME_15_VERSION, symbol: "3436", label: "現行仮想：B案・15分時間決済", role: "current", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, symbol: "5803", label: "安値反転LONG A/B", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: FUJIKURA_MORNING_SHORT_VERSION, symbol: "5803", label: "前場20本安値更新SHORT", purpose: "diagnostic", eligibleForAdoption: false },
  { strategyVersion: DISCO_SHORT_BASELINE_VERSION, symbol: "6146", label: "旧Current：寄り付きSHORT（比較シャドー）", purpose: "paused_baseline", eligibleForAdoption: false },
  { strategyVersion: DISCO_SHORT_EXECUTABLE_A_VERSION, symbol: "6146", label: "現行仮想：SHORT A・実行可能価格確認", role: "current", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: DISCO_SHORT_RETEST_B_VERSION, symbol: "6146", label: "SHORT B案：再安値更新", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: DISCO_LONG_PROFIT_PROTECTION_A_VERSION, symbol: "6146", label: "LONG A案：利益保護", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: DISCO_LONG_PRIOR_THREE_B_VERSION, symbol: "6146", label: "LONG B案：直前3本確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SOCIONEXT_INITIAL_STRENGTH_VERSION, symbol: "6526", label: "A案：初動強度確認", purpose: "diagnostic", eligibleForAdoption: false },
  { strategyVersion: SOCIONEXT_CONFIRM_STRENGTH_VERSION, symbol: "6526", label: "B案：確認足強度", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: ADVANTEST_SHORT_BODY008_DEPTH_VERSION, symbol: "6857", label: "A案：高値失速SHORT・陰線実体0.08%＋次イベント板", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION, symbol: "6857", label: "B案：確認型継続LONG・二段階高値更新＋次イベント板", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_BOARD_DEMAND_VERSION, symbol: "6976", label: "候補B A案：板需要確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_RR2_PROTECT_VERSION, symbol: "6976", label: "候補B B案：2R利益保護", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION, symbol: "6976", label: "現行仮想：後場LONG B・回復勝率型", role: "current", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: MURATA_DEEP_REVERSAL_LONG_VERSION, symbol: "6981", label: "A案：深い下落後の確認反発LONG", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: MURATA_MORNING_BREAKDOWN_SHORT_VERSION, symbol: "6981", label: "B案：前場20本安値更新SHORT", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: FORWARD_STRATEGY_VERSION, symbol: "8035", label: "短期ブレイク既存シャドー", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION, symbol: "9984", label: "A案：次イベント板確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SOFTBANK_RR2_PROTECT_VERSION, symbol: "9984", label: "B案：2R利益保護（比較シャドー）", role: "shadow", purpose: "candidate", eligibleForAdoption: false },
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    strategyVersion: BOLLINGER_DIRECTIONAL_FIXED_STOP_140_V3_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_FIXED_STOP_140_V3_VERSIONS],
    symbol,
    label: "ボリンジャー方向判定：入口時固定±2σ・SL1.40%・損切り後30分停止",
    purpose: "candidate" as const,
    eligibleForAdoption: false,
  })),
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    strategyVersion: BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V5_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V5_VERSIONS],
    symbol,
    label: "ボリンジャー方向判定：①〜③不使用・完成5分足SMA20方向・最低戻し余地0.60%",
    purpose: "candidate" as const,
    eligibleForAdoption: false,
  })),
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    strategyVersion: BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V3_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V3_VERSIONS],
    symbol,
    label: "ボリンジャー方向判定 改善A：完成5分足SMA20方向＋傾き一致・最低戻し余地0.60%",
    purpose: "candidate" as const,
    eligibleForAdoption: false,
  })),
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    strategyVersion: BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V3_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V3_VERSIONS],
    symbol,
    label: "ボリンジャー方向判定 改善B：SMA20傾き一致＋BB幅5本非拡大・最低戻し余地0.60%",
    purpose: "candidate" as const,
    eligibleForAdoption: false,
  })),
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    strategyVersion: BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V3_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V3_VERSIONS],
    symbol,
    label: "ボリンジャー方向判定：5分SMA10＋傾き・最低戻し余地0.50%",
    purpose: "candidate" as const,
    eligibleForAdoption: false,
  })),
  // 専用AI予測カードとは別に、案単位の実績を固定行で監査する。
  // causality_audit lifecycleのまま、選択器・自動採用には渡さない。
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    strategyVersion: AI_DAILY_FORECAST_VERSIONS[symbol as keyof typeof AI_DAILY_FORECAST_VERSIONS],
    legacyPlanIds: [`shadow:${RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS[symbol as keyof typeof RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS]}`],
    symbol,
    label: "AI適応予測shadow v6（前場15分・後場30分更新）",
    purpose: "diagnostic" as const,
    eligibleForAdoption: false,
  })),
];

export const MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS: ReadonlyArray<MonitoringPlanDefinition> = Object.freeze([
  ...TEN_MONITORED_SYMBOLS.filter(symbol => !PROMOTED_FORWARD_CURRENT_SYMBOLS.has(symbol)).map(symbol => ({
    planId: `current:${symbol}`,
    symbol,
    symbolName: NAME_BY_SYMBOL[symbol] ?? symbol,
    label: "現行（証拠金ブロック含む）",
    origin: "current" as const,
    role: "current" as const,
    strategyVersion: "current-candidate-by-trade-date",
    purpose: "current" as const,
    eligibleForAdoption: false,
  })),
  // 降格後も通常engineの同一候補をshadow_onlyとして保存し、成績を新規forward版へ付け替えない。
  { planId: "shadow:current:3436:sumcoBreakdownShort", legacyPlanIds: ["current:3436"], symbol: "3436", symbolName: NAME_BY_SYMBOL["3436"] ?? "3436", label: "旧Current：前場安値更新SHORT（比較シャドー）", origin: "current", role: "shadow", candidateRouteId: "sumcoBreakdownShort", candidateDisposition: "shadow_only", strategyVersion: "current-candidate-by-trade-date", purpose: "current", eligibleForAdoption: false },
  { planId: "shadow:current:6976:taiyoAfternoonReversal", legacyPlanIds: ["current:6976"], symbol: "6976", symbolName: NAME_BY_SYMBOL["6976"] ?? "6976", label: "旧Current：後場反転LONG（比較シャドー）", origin: "current", role: "shadow", candidateRouteId: "taiyoAfternoonReversal", candidateDisposition: "shadow_only", strategyVersion: "current-candidate-by-trade-date", purpose: "current", eligibleForAdoption: false },
  ...SHADOW_PLANS.map(plan => ({
    ...plan,
    planId: `shadow:${plan.strategyVersion}`,
    symbolName: NAME_BY_SYMBOL[plan.symbol] ?? plan.symbol,
    origin: "forward_shadow" as const,
    role: plan.role ?? ("shadow" as const),
  })),
]);

export const MULTI_SYMBOL_MONITORING_PLAN_BY_VERSION = new Map(
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS
    .filter(plan => plan.origin === "forward_shadow")
    .map(plan => [plan.strategyVersion, plan]),
);
