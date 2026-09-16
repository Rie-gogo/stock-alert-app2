import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routerSource = readFileSync(resolve(process.cwd(), "server/routers/trading.ts"), "utf8");

describe("trading.getForwardShadowSummary 5803前場SHORT公開登録", () => {
  it("開始前でも5803独立shadowの2方式・採用不可設定を公開strategy一覧へ登録する", () => {
    expect(routerSource).toContain("FUJIKURA_MORNING_SHORT_VERSION");
    expect(routerSource).toContain("FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE");
    expect(routerSource).toContain("FUJIKURA_MORNING_SHORT_FORMAL_START_DATE");
    expect(routerSource).toContain('strategyVersion: FUJIKURA_MORNING_SHORT_VERSION');
    expect(routerSource).toContain('symbol: "5803"');
    expect(routerSource).toContain('purpose: "diagnostic_candidate" as const');
    expect(routerSource).toContain("eligibleForAdoption: false");
    expect(routerSource).toContain("automaticAdoption: false");
    expect(routerSource).toContain("orderInstructionConnection: false");
  });
});
