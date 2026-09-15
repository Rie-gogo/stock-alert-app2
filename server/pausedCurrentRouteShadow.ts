/**
 * 低成績の現行経路を、本取引から外した後も比較用シャドーとして追跡する固定ポリシー。
 *
 * 2026-09-15の日中に部分適用されることを避けるため、翌営業日の09-16から有効化する。
 * 6146 SHORTは既存の専用paused baselineで追跡済みなので、ここでは二重生成しない。
 */
export const PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE = "2026-09-16";
export const PAUSED_CURRENT_ROUTE_SHADOW_POLICY_VERSION = "paused-current-routes-below40-v1";

export type PausedCurrentRouteSide = "long" | "short";
export type PausedCurrentRouteStateKey =
  | "trendLong"
  | "socionextConfirmedLong"
  | "lowReversalBreakLong"
  | "trendShort"
  | "highFadeBreakShort"
  | "afternoonLowBreakShort"
  | "taiyoAfternoonReversal"
  | "reversalLong"
  | "openingBreakShort"
  | "telShortBreak"
  | "discoOpeningBreakShort";

export type PausedCurrentRouteSpec = Readonly<{
  symbol: string;
  side: PausedCurrentRouteSide;
  stateKey: PausedCurrentRouteStateKey;
  publicRouteId: string;
  label: string;
  reasonPrefixes: readonly string[];
  captureViaGenericCandidateLedger: boolean;
}>;

export const PAUSED_CURRENT_ROUTE_SPECS: readonly PausedCurrentRouteSpec[] = Object.freeze([
  {
    symbol: "285A", side: "long", stateKey: "trendLong", publicRouteId: "trend_long",
    label: "順張りLONG／確認型前場LONG",
    reasonPrefixes: Object.freeze(["キオクシア確認型前場LONG", "順張りLONG"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "6526", side: "long", stateKey: "socionextConfirmedLong", publicRouteId: "socionext_confirmed_long",
    label: "確認型LONG",
    reasonPrefixes: Object.freeze(["ソシオネクスト確認型10本高値更新LONG"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "5803", side: "long", stateKey: "lowReversalBreakLong", publicRouteId: "low_reversal_break_long",
    label: "安値反転ブレイクLONG",
    reasonPrefixes: Object.freeze(["安値反転ブレイクLONG"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "285A", side: "short", stateKey: "trendShort", publicRouteId: "trend_short",
    label: "順張りSHORT",
    reasonPrefixes: Object.freeze(["順張りSHORT"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "5803", side: "short", stateKey: "highFadeBreakShort", publicRouteId: "high_fade_break_short",
    label: "高値失速ブレイクSHORT",
    reasonPrefixes: Object.freeze(["高値失速ブレイクSHORT"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "5803", side: "short", stateKey: "afternoonLowBreakShort", publicRouteId: "afternoon_low_break_short",
    label: "後場安値更新SHORT",
    reasonPrefixes: Object.freeze(["後場安値更新SHORT", "フジクラ後場安値更新SHORT"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "6976", side: "long", stateKey: "taiyoAfternoonReversal", publicRouteId: "reversal_long",
    label: "後場反転LONG",
    reasonPrefixes: Object.freeze(["太陽誘電後場反転LONG"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "285A", side: "long", stateKey: "reversalLong", publicRouteId: "reversal_long",
    label: "反転LONG",
    reasonPrefixes: Object.freeze(["反転LONG"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "6981", side: "short", stateKey: "openingBreakShort", publicRouteId: "opening_break_short",
    label: "寄り付きブレイクSHORT",
    reasonPrefixes: Object.freeze(["寄り付きブレイクSHORT"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "8035", side: "long", stateKey: "telShortBreak", publicRouteId: "8035_open_direction_breakout_long",
    label: "短期ブレイクLONG",
    reasonPrefixes: Object.freeze(["東京エレクトロン短期ブレイクLONG", "東京エレクトロン始値方向付き短期ブレイクLONG"]),
    captureViaGenericCandidateLedger: true,
  },
  {
    symbol: "6146", side: "short", stateKey: "discoOpeningBreakShort", publicRouteId: "disco_opening_short",
    label: "寄り付き10本安値更新SHORT",
    reasonPrefixes: Object.freeze(["ディスコ寄り付き10本安値更新SHORT"]),
    captureViaGenericCandidateLedger: false,
  },
]);

export function resolvePausedCurrentRoute(input: {
  symbol: string;
  side: PausedCurrentRouteSide;
  reason: string;
  tradeDate: string;
}): PausedCurrentRouteSpec | null {
  if (input.tradeDate < PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE) return null;
  return PAUSED_CURRENT_ROUTE_SPECS.find(spec =>
    spec.captureViaGenericCandidateLedger
    && spec.symbol === input.symbol
    && spec.side === input.side
    && spec.reasonPrefixes.some(prefix => input.reason.startsWith(prefix)),
  ) ?? null;
}

export function encodePausedCurrentRouteReason(spec: PausedCurrentRouteSpec, originalReason: string): string {
  return `shadow_route_pause:${spec.publicRouteId} (${originalReason})`;
}

export function encodePausedCurrentRouteRepeatReason(spec: PausedCurrentRouteSpec): string {
  return `shadow_route_repeat:${spec.publicRouteId}`;
}

export function isPausedCurrentRouteReason(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("shadow_route_pause:");
}

/** 呼出元の再探索ログを抑えるための制御理由。repeatは新しい候補としてDB保存しない。 */
export function isPausedCurrentRouteControlReason(value: string | null | undefined): boolean {
  return isPausedCurrentRouteReason(value)
    || (typeof value === "string" && value.startsWith("shadow_route_repeat:"));
}

export function pausedCurrentRouteOriginalReason(value: string | null | undefined): string | null {
  if (!isPausedCurrentRouteReason(value)) return null;
  const match = value!.match(/^shadow_route_pause:[^ ]+ \(([\s\S]+)\)$/);
  return match?.[1]?.trim() || null;
}
