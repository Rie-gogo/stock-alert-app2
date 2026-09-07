import { describe, expect, it } from "vitest";
import { buildTelExecutableDepthReplayCurrentAudit } from "./telExecutableConfirmDepthEngine";

describe("8035 depth v2 replay availability復元", () => {
  it("source列とrealtime resultJsonから実時と同じcurrentAuditを復元する", () => {
    const audit = buildTelExecutableDepthReplayCurrentAudit({
      sourceEventId: "source:1",
      status: "processed",
      resultAction: "processed",
      payloadJson: {},
      relayReceivedAtMs: 1_000,
      relaySentAtMs: 1_100,
      cloudReceivedAtMs: 50_000,
    }, {
      id: 77,
      sourceEventId: "source:1",
      resultType: "no_signal",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "pass",
      causalityReason: "no_fill_price_used",
      decisionStartedAtMs: 50_050,
      decisionCompletedAtMs: 50_200,
      resultJson: {
        availabilityTimeline: {
          boardObservedAtMs: 900,
          relayAssembledAtMs: 1_000,
          relaySentAtMs: 1_100,
          cloudReceivedAtMs: 50_000,
        },
      },
    });

    expect(audit).toMatchObject({
      engineSequence: 77,
      boardObservedAtMs: 900,
      relayAssembledAtMs: 1_000,
      relaySentAtMs: 1_100,
      cloudReceivedAtMs: 50_000,
      decisionStartedAtMs: 50_050,
      decisionCompletedAtMs: 50_200,
    });
  });
});
