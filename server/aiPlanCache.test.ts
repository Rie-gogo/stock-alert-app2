import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  revision: vi.fn(),
  candidates: vi.fn(),
  dashboard: vi.fn(),
}));
vi.mock("./aiDailyForecastService", async importOriginal => ({
  ...(await importOriginal<typeof import("./aiDailyForecastService")>()),
  getAiDailyForecastDashboard: mocks.dashboard,
}));
vi.mock("./aiIntradayForecastService", async importOriginal => ({
  ...(await importOriginal<typeof import("./aiIntradayForecastService")>()),
  getAiForecastPlanRevision: mocks.revision,
  getAiIntradayPlanCandidates: mocks.candidates,
}));
import {
  getPlanData,
  shareAiPlanPromise,
  selectAiIntradayPlanForTest,
} from "./aiDailyForecastShadowEngine";
import {
  AI_INTRADAY_CHECKPOINTS,
  selectEffectiveAiIntradayPlan,
  _aiIntradayForecastTest,
} from "./aiIntradayForecastService";
const candidates = AI_INTRADAY_CHECKPOINTS.map((checkpoint, i) => ({
  id: i + 1,
  checkpoint,
  sourceRevisionId: `snapshot-${i}`,
  qualityStatus: "verified",
  forecastJson: {},
  priorSymbols: [],
  validationJson: { activationAudit: { activationAfterEngineSequence: i + 1 } },
})).reverse();
afterEach(() => vi.restoreAllMocks());
function setup(revision: string) {
  mocks.revision.mockReset().mockResolvedValue(revision);
  mocks.dashboard
    .mockReset()
    .mockResolvedValue({ snapshot: null, revisions: [] });
  mocks.candidates.mockReset().mockResolvedValue(candidates);
  vi.spyOn(console, "info").mockImplementation(() => {});
}
describe("shared plan cache", () => {
  it("coalesces concurrent events and reloads a new revision within the same minute", async () => {
    setup("1:0:16");
    const rows = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        getPlanData("2026-10-16", "10:00", 50 + i, `e${i}`)
      )
    );
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
    expect(mocks.candidates).toHaveBeenCalledTimes(1);
    expect(
      rows.every(row => row.intradaySnapshot?.checkpoint === "10:00")
    ).toBe(true);
    mocks.revision.mockResolvedValue("1:0:17");
    mocks.candidates.mockResolvedValue([
      ...candidates.filter(row => row.checkpoint > "10:00"),
      {
        ...candidates[0],
        id: 17,
        checkpoint: "10:00",
        sourceRevisionId: "new-same-minute",
        validationJson: {
          activationAudit: { activationAfterEngineSequence: 69 },
        },
      },
      ...candidates.filter(row => row.checkpoint <= "10:00"),
    ]);
    const next = await getPlanData("2026-10-16", "10:00", 70);
    expect(next.intradaySnapshot?.sourceRevisionId).toBe("new-same-minute");
    const earlier = await getPlanData("2026-10-16", "10:00", 69);
    expect(earlier.intradaySnapshot?.sourceRevisionId).not.toBe(
      "new-same-minute"
    );
    expect(mocks.candidates).toHaveBeenCalledTimes(2);
  });
  it("retries failed fetches and rejects a torn revision", async () => {
    setup("2:0:16");
    mocks.candidates.mockRejectedValueOnce(Error("fetch failed"));
    await expect(getPlanData("2026-10-17", "10:00", 50)).rejects.toThrow(
      "fetch failed"
    );
    await getPlanData("2026-10-17", "10:00", 50);
    expect(mocks.candidates).toHaveBeenCalledTimes(2);
    setup("3:0:16");
    mocks.revision.mockResolvedValueOnce("3:0:15");
    const row = await getPlanData("2026-10-18", "10:00", 50);
    expect(row.revision).toBe("3:0:16");
    expect(mocks.candidates).toHaveBeenCalledTimes(2);
  });
  it("an old rejected promise cannot delete its replacement", async () => {
    const cache = new Map<string, Promise<string>>();
    let reject!: (error: Error) => void;
    const old = shareAiPlanPromise(
      cache,
      "key",
      () =>
        new Promise<string>((_, fail) => {
          reject = fail;
        })
    ).promise;
    await Promise.resolve();
    cache.delete("key");
    const next = shareAiPlanPromise(cache, "key", async () => "new").promise;
    reject(Error("old"));
    await expect(old).rejects.toThrow("old");
    expect(cache.get("key")).toBe(next);
    expect(await next).toBe("new");
  });
  it("matches former SQL ordering/filter/limit and causal selection for every checkpoint", () => {
    for (const time of ["09:00", ...AI_INTRADAY_CHECKPOINTS])
      for (const sequence of [null, 0, 5, 20]) {
        const old =
          candidates
            .filter(s => s.checkpoint <= time)
            .sort(
              (a, b) => b.checkpoint.localeCompare(a.checkpoint) || b.id - a.id
            )
            .slice(0, 16)
            .find(s =>
              _aiIntradayForecastTest.isAiIntradaySnapshotCausallyAvailable(
                s.validationJson,
                sequence
              )
            ) ?? null;
        expect(
          selectEffectiveAiIntradayPlan(candidates, time, sequence)
        ).toEqual(old);
      }
  });
  it("projected baseline preserves plan and management selection", () => {
    const inputJson = {
      priorData: { symbols: [{ symbol: "8035", baseline: { atr5: 2 } }] },
    };
    const snapshot = {
      ...candidates[0],
      forecastJson: {
        aiFinalForecast: {
          forecast: {
            forecasts: [
              {
                symbol: "8035",
                direction: "up",
                forecastLow: 90,
                forecastHigh: 120,
                zoneLow: 99,
                zoneHigh: 101,
                confirmPrice: 102,
                firstTarget: 110,
                stretchTarget: 115,
              },
            ],
          },
          controls: [{ symbol: "8035", planDecision: "enabled" }],
          managementPlans: [],
        },
      },
      inputJson,
    };
    const legacy = selectAiIntradayPlanForTest(snapshot, "8035");
    const projected = {
      ...snapshot,
      inputJson: undefined,
      priorSymbols: JSON.stringify(inputJson.priorData.symbols),
    };
    expect(selectAiIntradayPlanForTest(projected, "8035")).toEqual(legacy);
    expect(legacy?.plan?.atr5).toBe(2);
  });
  it("benchmarks 16 snapshots, 40 event bursts and 6 strategy callers", async () => {
    setup("benchmark:16");
    const delay = () => new Promise(resolve => setTimeout(resolve, 2));
    let oldFetches = 0;
    const startOld = performance.now();
    for (let event = 0; event < 40; event++) {
      const cache = new Map();
      await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            shareAiPlanPromise(cache, String(event), async () => {
              oldFetches++;
              await delay();
              return candidates;
            }).promise
        )
      );
    }
    const oldMs = performance.now() - startOld;
    mocks.candidates.mockImplementation(async () => {
      await delay();
      return candidates;
    });
    const startNew = performance.now();
    for (let event = 0; event < 40; event++)
      await Promise.all(
        Array.from({ length: 6 }, () =>
          getPlanData("2026-10-19", "15:00", 100 + event, `burst-${event}`)
        )
      );
    const newMs = performance.now() - startNew;
    expect(oldFetches).toBe(40);
    expect(mocks.candidates).toHaveBeenCalledTimes(1);
    process.stdout.write(
      `BENCHMARK ${JSON.stringify({
        oldHeavyFetches: oldFetches,
        newHeavyFetches: mocks.candidates.mock.calls.length,
        revisionQueries: mocks.revision.mock.calls.length,
        oldMs,
        newMs,
        simulatedFetchLatencyMs: 2,
        snapshots: 16,
        events: 40,
        callers: 6,
      })}\n`
    );
  });
});
