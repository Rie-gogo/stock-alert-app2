import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  updateRtStrategyVersionStatus: vi.fn(async () => undefined),
}));
vi.mock("./db", () => dbMock);

import {
  resetSixShadowRetirementForTest,
  RETIRED_SIX_SHADOW_STATUS_REASON,
  RETIRED_SIX_SHADOW_VERSIONS,
  retireSixShadowStrategyVersions,
} from "./retiredSixStrategies";

describe("six retired shadow lifecycle enforcement", () => {
  beforeEach(() => {
    dbMock.updateRtStrategyVersionStatus.mockClear();
    resetSixShadowRetirementForTest();
  });

  it("changes only the four existing lifecycle rows to stopped and is idempotent", async () => {
    await retireSixShadowStrategyVersions();
    await retireSixShadowStrategyVersions();

    expect(dbMock.updateRtStrategyVersionStatus).toHaveBeenCalledTimes(4);
    expect(dbMock.updateRtStrategyVersionStatus.mock.calls.map(([input]) => input)).toEqual(
      RETIRED_SIX_SHADOW_VERSIONS.map(versionId => ({
        versionId,
        status: "stopped",
        statusReason: RETIRED_SIX_SHADOW_STATUS_REASON,
      })),
    );
  });
});
