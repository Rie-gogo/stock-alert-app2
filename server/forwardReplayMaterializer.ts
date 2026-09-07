import {
  getRtDailyAuditMaterializationsForComponent,
  getRtForwardShadowEventsForDateAndStrategy,
  getRtRealtimeDecisionEventsForDateAndSymbol,
  getRtSourceEventsForDateAndSymbol,
  upsertRtDailyAuditMaterialization,
} from "./db";
import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";
import { replayForwardShadowDay } from "./forwardShadow";
import { replayFujikuraForwardShadowDay } from "./fujikuraForwardShadowEngine";
import { replayKioxiaForwardShadowDay } from "./kioxiaForwardShadowEngine";
import { replayKioxiaAtrForwardShadowDay } from "./kioxiaAtrForwardShadowEngine";
import { TEL_EXECUTABLE_CONFIRM_VERSION } from "./telExecutableConfirm";
import { auditTelExecutableConfirmDay } from "./telExecutableConfirmEngine";
import { TEL_EXECUTABLE_DEPTH_VERSION } from "./telExecutableConfirmDepth";
import { auditTelExecutableConfirmDepthDay } from "./telExecutableConfirmDepthEngine";
import { auditSoftbankForwardShadowDay } from "./softbankForwardShadowEngine";
import { auditTaiyoForwardShadowDay } from "./taiyoForwardShadowEngine";
import { auditTaiyoAfternoonForwardShadowDay } from "./taiyoAfternoonForwardShadowEngine";
import { auditSocionextForwardShadowDay } from "./socionextForwardShadowEngine";
import { auditSumcoForwardShadowDay } from "./sumcoForwardShadowEngine";

export const FORWARD_REPLAY_MATERIALIZATION_COMPONENT = "forward_strategy_replay";

type ReplayRunner = (sourceEvents: any[], shadowEvents: any[], realtimeDecisionEvents: any[]) => unknown;

const FORWARD_REPLAY_DEFINITIONS: ReadonlyArray<{
  version: string;
  symbol: string;
  run: ReplayRunner;
}> = [
  { version: FORWARD_STRATEGY_VERSION, symbol: "8035", run: (source, shadow) => replayForwardShadowDay(source, shadow) },
  { version: FUJIKURA_FORWARD_STRATEGY_VERSION, symbol: "5803", run: (source, shadow) => replayFujikuraForwardShadowDay(source, shadow) },
  { version: KIOXIA_FORWARD_STRATEGY_VERSION, symbol: "285A", run: (source, shadow) => replayKioxiaForwardShadowDay(source, shadow) },
  { version: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, symbol: "285A", run: (source, shadow) => replayKioxiaAtrForwardShadowDay(source, shadow) },
  { version: TEL_EXECUTABLE_CONFIRM_VERSION, symbol: "8035", run: (source, shadow) => auditTelExecutableConfirmDay(source, shadow) },
  { version: TEL_EXECUTABLE_DEPTH_VERSION, symbol: "8035", run: (source, shadow, realtime) => auditTelExecutableConfirmDepthDay(source, shadow, realtime) },
  { version: SOFTBANK_DEPTH_CONFIRM_VERSION, symbol: "9984", run: (source, shadow, realtime) => auditSoftbankForwardShadowDay(source, shadow, realtime, "depth_confirm") },
  { version: SOFTBANK_RR2_PROTECT_VERSION, symbol: "9984", run: (source, shadow, realtime) => auditSoftbankForwardShadowDay(source, shadow, realtime, "rr2_protect") },
  { version: TAIYO_BOARD_DEMAND_VERSION, symbol: "6976", run: (source, shadow, realtime) => auditTaiyoForwardShadowDay(source, shadow, realtime, "board_demand") },
  { version: TAIYO_RR2_PROTECT_VERSION, symbol: "6976", run: (source, shadow, realtime) => auditTaiyoForwardShadowDay(source, shadow, realtime, "rr2_protect") },
  { version: TAIYO_AFTERNOON_RR2_VERSION, symbol: "6976", run: (source, shadow, realtime) => auditTaiyoAfternoonForwardShadowDay(source, shadow, realtime, "rr2_exit") },
  { version: TAIYO_AFTERNOON_DEPTH_VERSION, symbol: "6976", run: (source, shadow, realtime) => auditTaiyoAfternoonForwardShadowDay(source, shadow, realtime, "depth_execution") },
  { version: SOCIONEXT_INITIAL_STRENGTH_VERSION, symbol: "6526", run: (source, shadow) => auditSocionextForwardShadowDay(source, shadow, "initial_strength") },
  { version: SOCIONEXT_CONFIRM_STRENGTH_VERSION, symbol: "6526", run: (source, shadow) => auditSocionextForwardShadowDay(source, shadow, "confirmation_strength") },
  { version: SUMCO_VOLUME_110_VERSION, symbol: "3436", run: (source, shadow) => auditSumcoForwardShadowDay(source, shadow, "volume_110") },
  { version: SUMCO_TIME_15_VERSION, symbol: "3436", run: (source, shadow) => auditSumcoForwardShadowDay(source, shadow, "time_15") },
];

export async function materializeNextForwardReplayForDate(input: {
  tradeDate: string;
  processedThroughEngineSequence: number;
  sourceDecisionCount: number;
}) {
  const existing = await getRtDailyAuditMaterializationsForComponent({
    component: FORWARD_REPLAY_MATERIALIZATION_COMPONENT,
    tradeDate: input.tradeDate,
  });
  const completeVersions = new Map(existing
    .filter(row => row.status === "complete" && row.sourceDecisionCount === input.sourceDecisionCount)
    .map(row => [row.version, row]));
  const definition = FORWARD_REPLAY_DEFINITIONS.find(item => !completeVersions.has(item.version));
  if (!definition) return { status: "complete" as const, completedVersions: completeVersions.size };

  const [sourceEvents, shadowEvents, realtimeDecisionEvents] = await Promise.all([
    getRtSourceEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol: definition.symbol }),
    getRtForwardShadowEventsForDateAndStrategy({ tradeDate: input.tradeDate, strategyVersion: definition.version }),
    getRtRealtimeDecisionEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol: definition.symbol }),
  ]);
  const result = definition.run(sourceEvents, shadowEvents, realtimeDecisionEvents);
  await upsertRtDailyAuditMaterialization({
    component: FORWARD_REPLAY_MATERIALIZATION_COMPONENT,
    version: definition.version,
    tradeDate: input.tradeDate,
    status: "complete",
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    sourceDecisionCount: input.sourceDecisionCount,
    resultJson: result,
    lastError: null,
    generatedAt: new Date(),
  });
  return {
    status: "processing" as const,
    version: definition.version,
    completedVersions: completeVersions.size + 1,
    totalVersions: FORWARD_REPLAY_DEFINITIONS.length,
    result,
  };
}
