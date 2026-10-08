import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getLatestRtPremarketContextSnapshot,
  getRtSourceEventsForDateAndSymbol,
} from "../server/db";
import {
  bollingerDirectionalVariantConfig,
  buildBollingerDirectionalPlan,
  buildBollingerIntradaySmaDirectionPlan,
  type BollingerDirectionalVariant,
} from "../server/bollingerDirectionalShadow";
import { replayBollingerDirectionalShadowDay } from "../server/bollingerDirectionalShadowEngine";
import type { ForwardSourceEventInput } from "../server/forwardShadow";

/**
 * 2026-10-08 保存足を使う、書込みなし・参考専用のBollinger条件成立診断。
 * 板履歴がないため、close価格を100株bid/ask depthとして置くOHLC板proxyである。
 * 実約定、正式前向き成績、rt_forward_shadow_* のいずれも作成・更新しない。
 */
const TRADE_DATE = "2026-10-08";
const SESSION_START = "09:00";
const SESSION_END = "11:29";
const SYMBOLS = ["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"] as const;
const VARIANTS: ReadonlyArray<{ plan: string; variant: BollingerDirectionalVariant }> = [
  { plan: "plan1_fixed_stop140", variant: "fixed_stop_140_cooldown_30" },
  { plan: "plan2_sma20_dynamic", variant: "fixed_stop_140_cooldown_30_sma20_dynamic_gap060_v3" },
  { plan: "plan3_sma20_slope", variant: "fixed_stop_140_cooldown_30_sma20_slope_gap060" },
  { plan: "plan4_sma20_slope_width", variant: "fixed_stop_140_cooldown_30_sma20_slope_bbwidth5_gap060" },
  { plan: "plan5_sma10_slope", variant: "fixed_stop_140_cooldown_30_sma10_slope_gap050" },
];

function toFreshClosePriceBoardProxy(row: any): ForwardSourceEventInput | null {
  const payload = row?.payloadJson as Record<string, unknown> | null;
  if (!payload || typeof payload.symbol !== "string" || typeof payload.tradeDate !== "string" || typeof payload.candleTime !== "string") return null;
  if (![payload.open, payload.high, payload.low, payload.close, payload.volume].every(value => typeof value === "number")) return null;
  const provenance = (payload.provenance ?? {}) as Record<string, unknown>;
  const relayAssembledAtMs = typeof provenance.relayAssembledAtMs === "number" ? provenance.relayAssembledAtMs : null;
  if (relayAssembledAtMs === null) return null;
  const close = payload.close as number;
  return {
    sourceEventId: row.sourceEventId,
    candle: {
      symbol: payload.symbol,
      tradeDate: payload.tradeDate,
      candleTime: payload.candleTime,
      open: payload.open as number,
      high: payload.high as number,
      low: payload.low as number,
      close,
      volume: payload.volume as number,
    },
    board: {
      asks: [{ price: close, qty: 100 }],
      bids: [{ price: close, qty: 100 }],
    },
    currentAudit: {
      boardObservedAtMs: relayAssembledAtMs - 100,
      relayAssembledAtMs,
      relaySentAtMs: relayAssembledAtMs + 1,
      cloudReceivedAtMs: relayAssembledAtMs + 2,
      decisionCompletedAtMs: relayAssembledAtMs + 3,
    },
  };
}

async function main() {
  const snapshot = await getLatestRtPremarketContextSnapshot({ tradeDate: TRADE_DATE, usableOnly: false });
  const allSources = new Map<string, ForwardSourceEventInput[]>();
  for (const symbol of SYMBOLS) {
    const rows = await getRtSourceEventsForDateAndSymbol({ tradeDate: TRADE_DATE, symbol });
    allSources.set(symbol, rows
      .filter(row => row.candleTime >= SESSION_START && row.candleTime <= SESSION_END)
      .map(toFreshClosePriceBoardProxy)
      .filter((row): row is ForwardSourceEventInput => row !== null));
  }

  const results = [] as Array<Record<string, unknown>>;
  for (const { plan: planName, variant } of VARIANTS) {
    const config = bollingerDirectionalVariantConfig(variant);
    for (const symbol of SYMBOLS) {
      const plan = config.directionSource === "intraday_sma"
        ? buildBollingerIntradaySmaDirectionPlan(TRADE_DATE)
        : buildBollingerDirectionalPlan({ tradeDate: TRADE_DATE, snapshot });
      const replay = replayBollingerDirectionalShadowDay({
        sources: allSources.get(symbol) ?? [],
        plan,
        variant,
        mode: "signal_quality",
      });
      const entries = replay.transitions.filter(transition => transition.openedPosition !== null);
      const exits = replay.transitions.filter(transition => transition.closedPosition !== null);
      results.push({
        plan: planName,
        variant,
        symbol,
        directionSource: config.directionSource,
        sourceEvents: (allSources.get(symbol) ?? []).length,
        entries: entries.length,
        exits: exits.length,
        entryActions: entries.flatMap(transition => transition.actions.filter(action => action.type === "entry")),
        finalResultType: replay.state.lastResultType,
        finalStateHash: replay.stateHash,
      });
    }
  }

  const summary = VARIANTS.map(({ plan, variant }) => {
    const rows = results.filter(row => row.plan === plan);
    return {
      plan,
      variant,
      totalSourceEvents: rows.reduce((sum, row) => sum + Number(row.sourceEvents), 0),
      totalEntries: rows.reduce((sum, row) => sum + Number(row.entries), 0),
      symbolsWithEntry: rows.filter(row => Number(row.entries) > 0).map(row => row.symbol),
      totalExits: rows.reduce((sum, row) => sum + Number(row.exits), 0),
    };
  });

  const artifact = {
    referenceOnly: true,
    notFormalPerformance: true,
    databaseWrites: 0,
    tradeDate: TRADE_DATE,
    scope: `10 symbols, ${SESSION_START}-${SESSION_END} JST, signal_quality only`,
    boardProxy: "Each stored candle close is used as a synthetic fresh causal 100-share bid/ask depth proxy; raw board history is unavailable.",
    premarketSnapshot: snapshot
      ? { sourceSnapshotId: snapshot.sourceSnapshotId, qualityStatus: snapshot.qualityStatus, regimeState: snapshot.regimeState, confidence: snapshot.confidence }
      : null,
    sourceEventCounts: Object.fromEntries([...allSources.entries()].map(([symbol, events]) => [symbol, events.length])),
    summary,
    results,
  };
  const output = join(process.cwd(), `analysis/bollinger_source_time_reference_${TRADE_DATE}.json`);
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, ...artifact }, null, 2));
}

void main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
