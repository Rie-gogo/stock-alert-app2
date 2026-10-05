import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const dbMock = vi.hoisted(() => ({
  getRtDailyAuditMaterialization: vi.fn(),
  getRtPremarketContextSnapshot: vi.fn(),
  insertRtPremarketContextSnapshot: vi.fn(),
}));

vi.mock("./db", () => dbMock);

import { ingestPremarketContext } from "./premarketContextIngestion";
import { tradingRouter } from "./routers/trading";

const input = {
  sourceSnapshotId: "premarket:2026-10-05:0830:fixed",
  tradeDate: "2026-10-05",
  capturedAtMs: Date.parse("2026-10-05T08:30:00+09:00"),
  collectorVersion: "scheduled-research-v1",
  sourceMode: "scheduled_research" as const,
  dow: {
    sessionDate: "2026-10-02",
    close: 45000,
    changePct: 1.1,
    observedAtMs: Date.parse("2026-10-05T08:00:00+09:00"),
    sourceUrl: "https://example.com/dow",
    status: "verified" as const,
  },
  cme: {
    providerSymbol: "NIY",
    contractMonth: "2026/12",
    currency: "JPY" as const,
    quote: 50600,
    observedAtMs: Date.parse("2026-10-05T08:25:00+09:00"),
    comparisonPolicy: "same_cme_previous_jpx_business_day_0830" as const,
    previousSession: {
      tradeDate: "2026-10-02",
      providerSymbol: "NIY",
      contractMonth: "2026/12",
      currency: "JPY" as const,
      quote: 50000,
      observedAtMs: Date.parse("2026-10-02T08:25:00+09:00"),
    },
    sourceUrl: "https://example.com/cme",
    status: "verified" as const,
  },
  usdJpy: {
    previousRate: 150,
    previousAtMs: Date.parse("2026-10-04T15:30:00+09:00"),
    currentRate: 151,
    currentAtMs: Date.parse("2026-10-05T08:20:00+09:00"),
    sourceUrl: "https://example.com/fx",
    status: "verified" as const,
  },
};

function stored(inputHash: string, qualityStatus: "verified" | "degraded" | "invalid" = "verified") {
  return {
    id: 1,
    sourceSnapshotId: input.sourceSnapshotId,
    inputHash,
    qualityStatus,
    resultJson: { monitoringOnly: true },
  };
}

describe("premarket context immutable snapshot ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtDailyAuditMaterialization.mockResolvedValue(null);
    dbMock.getRtPremarketContextSnapshot.mockResolvedValue(null);
    dbMock.insertRtPremarketContextSnapshot.mockImplementation(async (row: Record<string, unknown>) => stored(
      String(row.inputHash),
      row.qualityStatus as "verified" | "degraded" | "invalid",
    ));
  });

  it("keeps a same-ID identical retry idempotent and rejects different content without writing", async () => {
    dbMock.getRtPremarketContextSnapshot.mockResolvedValueOnce(null);
    const first = await ingestPremarketContext(input);
    expect(first).toMatchObject({ accepted: true, duplicate: false, payloadMismatch: false });
    const savedHash = dbMock.insertRtPremarketContextSnapshot.mock.calls[0]?.[0]?.inputHash;
    dbMock.getRtPremarketContextSnapshot.mockResolvedValueOnce(stored(savedHash));
    const duplicate = await ingestPremarketContext(input);
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, payloadMismatch: false });

    dbMock.getRtPremarketContextSnapshot.mockResolvedValueOnce(stored("f".repeat(64)));
    const mismatch = await ingestPremarketContext({ ...input, usdJpy: { ...input.usdJpy, currentRate: 152 } });
    expect(mismatch).toMatchObject({ accepted: false, duplicate: true, payloadMismatch: true });
    expect(dbMock.insertRtPremarketContextSnapshot).toHaveBeenCalledTimes(1);
  });

  it("fails closed after 09:00 or when a source observation is after snapshot capture", async () => {
    const late = await ingestPremarketContext({ ...input, sourceSnapshotId: "late", capturedAtMs: Date.parse("2026-10-05T09:00:00+09:00") });
    expect(late).toMatchObject({ accepted: false, qualityStatus: "invalid" });
    const futureObservation = await ingestPremarketContext({
      ...input,
      sourceSnapshotId: "future-observation",
      dow: { ...input.dow, observedAtMs: input.capturedAtMs + 1 },
    });
    expect(futureObservation).toMatchObject({ accepted: false, qualityStatus: "invalid" });
  });

  it.each([
    {
      name: "旧OSE-only形式",
      expected: "cme_comparison_policy_invalid",
      cme: {
        ...input.cme,
        comparisonPolicy: undefined,
        previousSession: undefined,
        oseDayClose: 50000,
      },
    },
    {
      name: "別限月",
      expected: "cme_previous_session_instrument_mismatch",
      cme: {
        ...input.cme,
        previousSession: { ...input.cme.previousSession, contractMonth: "2027/03" },
      },
    },
    {
      name: "USD建て",
      expected: "cme_currency_not_jpy",
      cme: {
        ...input.cme,
        currency: "USD" as const,
        previousSession: { ...input.cme.previousSession, currency: "USD" as const },
      },
    },
    {
      name: "08:25以外",
      expected: "cme_comparison_not_same_0825_completed_bar",
      cme: {
        ...input.cme,
        observedAtMs: Date.parse("2026-10-05T08:20:00+09:00"),
      },
    },
    {
      name: "直前JPX営業日ではない参照",
      expected: "cme_reference_not_previous_jpx_business_day",
      cme: {
        ...input.cme,
        previousSession: {
          ...input.cme.previousSession,
          tradeDate: "2026-10-01",
          observedAtMs: Date.parse("2026-10-01T08:25:00+09:00"),
        },
      },
    },
  ])("rejects $name before every DB read/write", async ({ cme, expected }) => {
    const result = await ingestPremarketContext({
      ...input,
      sourceSnapshotId: `rejected:${expected}`,
      cme,
    } as never);
    expect(result).toMatchObject({
      accepted: false,
      qualityStatus: "invalid",
      rejectionReason: expected,
    });
    expect(dbMock.getRtPremarketContextSnapshot).not.toHaveBeenCalled();
    expect(dbMock.getRtDailyAuditMaterialization).not.toHaveBeenCalled();
    expect(dbMock.insertRtPremarketContextSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an old OSE-only payload at the public automation schema boundary", async () => {
    const caller = tradingRouter.createCaller({} as never);
    await expect(caller.pushPremarketMarketContextAutomated({
      ...input,
      ingestKey: "a".repeat(64),
      cme: {
        ...input.cme,
        comparisonPolicy: undefined,
        previousSession: undefined,
        oseDayClose: 50000,
      },
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMock.getRtPremarketContextSnapshot).not.toHaveBeenCalled();
    expect(dbMock.insertRtPremarketContextSnapshot).not.toHaveBeenCalled();
  });

  it("①〜③を08:30時点の経路選択シャドーへ渡す", async () => {
    dbMock.getRtDailyAuditMaterialization.mockResolvedValue({
      resultJson: {
        selectorVersion: "route-v3",
        inputHash: "frozen-route-input",
        scores: [
          {
            symbol: "285A",
            rowId: "285a-long-a",
            canonicalLogic: "candidate-long-a",
            strategyVersion: "candidate-long-a-v1",
            direction: "long",
            marketContextEligible: true,
            marketContextEvidenceLevel: "provisional",
            marketContextExpectedDailyPnlPer100: 150,
            marketContextCompletedTrades: 3,
            marketContextRecent10CompletedTrades: 1,
          },
        ],
      },
    });
    await ingestPremarketContext(input);
    expect(dbMock.insertRtPremarketContextSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      oseDayClose: null,
      cmeBasisPct: null,
      inputJson: expect.objectContaining({
        cme: expect.objectContaining({
          comparisonPolicy: "same_cme_previous_jpx_business_day_0830",
          previousSession: expect.objectContaining({
            tradeDate: "2026-10-02",
            quote: 50000,
          }),
        }),
      }),
      resultJson: expect.objectContaining({
        selectorReason: "premarket_0830_selector_shadow_recorded",
        selectorShadow: expect.objectContaining({
          decisionAt: "08:30",
          decisionStage: "premarket_0830",
          selections: [expect.objectContaining({ symbol: "285A", selectedRowId: "285a-long-a" })],
        }),
      }),
    }));
  });

  it("does not import trading engines, shadow dispatch, candidate workers, or order routing", async () => {
    const source = await readFile(new URL("./premarketContextIngestion.ts", import.meta.url), "utf8");
    for (const forbidden of ["./realtimeSimEngine", "./sourceEventIngestion", "./forwardShadow", "./orderBridge", "processCandle("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
