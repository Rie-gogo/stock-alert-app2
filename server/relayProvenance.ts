export const RELAY_PROVENANCE_VERSION = "kabu-relay-provenance-v1" as const;

export const RELAY_VALUE_SOURCES = ["ws_aggregated", "buffer_reuse", "rest_fallback", "unknown"] as const;
export type RelayValueSource = typeof RELAY_VALUE_SOURCES[number];
export type RelayNoTrade = true | false | "unknown";

export type RelayClockHealth = {
  timezone?: "JST" | "unknown";
  ntpOffsetMs?: number | null;
  monotonicAnomaly?: boolean;
  websocketConnected?: boolean | null;
  websocketLastReceivedAtMs?: number | null;
};

/**
 * Windows relayが将来のraw candleと一緒に送る、後方互換な生成元記録。
 * cloud側はこの情報を値の補正や取引判断には使わず、閉場後監査だけに用いる。
 */
export type RelayCandleProvenance = {
  relayVersion?: string;
  relaySourceTreeHash?: string;
  rawCandleTime?: string;
  barStartJst?: string;
  barEndJst?: string;
  valueSource?: RelayValueSource;
  tickCount?: number | null;
  firstTickAtMs?: number | null;
  lastTickAtMs?: number | null;
  fallbackReason?: string | null;
  isNoTrade?: RelayNoTrade;
  clockHealth?: RelayClockHealth;
  relayAssembledAtMs?: number | null;
};

export function parseRelayCandleProvenance(value: unknown): RelayCandleProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const valueSource = RELAY_VALUE_SOURCES.includes(item.valueSource as RelayValueSource)
    ? item.valueSource as RelayValueSource
    : undefined;
  const noTrade = item.isNoTrade === true || item.isNoTrade === false || item.isNoTrade === "unknown"
    ? item.isNoTrade
    : undefined;
  const finite = (input: unknown) => typeof input === "number" && Number.isFinite(input) ? input : null;
  const text = (input: unknown) => typeof input === "string" && input.length > 0 ? input : undefined;
  const clockRaw = item.clockHealth;
  const clockHealth = clockRaw && typeof clockRaw === "object" && !Array.isArray(clockRaw)
    ? (() => {
        const clock = clockRaw as Record<string, unknown>;
        return {
          timezone: clock.timezone === "JST" || clock.timezone === "unknown" ? clock.timezone : undefined,
          ntpOffsetMs: finite(clock.ntpOffsetMs),
          monotonicAnomaly: typeof clock.monotonicAnomaly === "boolean" ? clock.monotonicAnomaly : undefined,
          websocketConnected: typeof clock.websocketConnected === "boolean" ? clock.websocketConnected : null,
          websocketLastReceivedAtMs: finite(clock.websocketLastReceivedAtMs),
        } satisfies RelayClockHealth;
      })()
    : undefined;
  return {
    relayVersion: text(item.relayVersion),
    relaySourceTreeHash: text(item.relaySourceTreeHash),
    rawCandleTime: text(item.rawCandleTime),
    barStartJst: text(item.barStartJst),
    barEndJst: text(item.barEndJst),
    valueSource,
    tickCount: finite(item.tickCount),
    firstTickAtMs: finite(item.firstTickAtMs),
    lastTickAtMs: finite(item.lastTickAtMs),
    fallbackReason: typeof item.fallbackReason === "string" ? item.fallbackReason : null,
    isNoTrade: noTrade,
    clockHealth,
    relayAssembledAtMs: finite(item.relayAssembledAtMs),
  };
}
