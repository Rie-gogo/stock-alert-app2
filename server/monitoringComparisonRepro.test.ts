import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MONITORING_COMPARISON_CONTRACT,
  resolveMonitoringComparisonEntry,
  type MonitoringComparisonSignal,
  type MonitoringComparisonSourceEvent,
} from "./monitoringComparisonContract";

const fixtureDir = new URL("./fixtures/monitoring-comparison-v1/", import.meta.url);

function raw(name: string): Buffer {
  return readFileSync(new URL(name, fixtureDir));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("monitoring comparison Git固定再現package", () => {
  it("manifestのhashと固定期待値を再現する", () => {
    const manifest = JSON.parse(raw("manifest.json").toString("utf8")) as {
      contractVersion: string;
      files: Record<string, string>;
    };
    expect(manifest.contractVersion).toBe(MONITORING_COMPARISON_CONTRACT.comparisonGeneration);
    expect(sha256(raw("input.json"))).toBe(manifest.files["input.json"]);
    expect(sha256(raw("expected.json"))).toBe(manifest.files["expected.json"]);

    const input = JSON.parse(raw("input.json").toString("utf8")) as {
      datasetId: string;
      scenarios: Array<{
        id: string;
        signal: MonitoringComparisonSignal;
        event: MonitoringComparisonSourceEvent;
      }>;
    };
    const expected = JSON.parse(raw("expected.json").toString("utf8")) as {
      datasetId: string;
      results: Array<{ id: string; resolution: unknown }>;
    };
    expect(input.datasetId).toBe(expected.datasetId);
    expect(input.scenarios.map(item => ({
      id: item.id,
      resolution: resolveMonitoringComparisonEntry(item.signal, item.event),
    }))).toEqual(expected.results);
  });
});
