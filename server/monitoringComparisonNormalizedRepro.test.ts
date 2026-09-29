import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MONITORING_COMPARISON_CONTRACT,
  resolveMonitoringComparisonEntry,
  resolveMonitoringComparisonExit,
  type MonitoringComparisonSignal,
  type MonitoringComparisonSourceEvent,
} from "./monitoringComparisonContract";

const fixtureDir = new URL("./fixtures/monitoring-comparison-v3/", import.meta.url);
const raw = (name: string) => readFileSync(new URL(name, fixtureDir));
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

describe("285A route別比較 Git固定再現package", () => {
  it("entry/exit intent、板時刻、価格規約、期待結果を同一manifest hashで再現する", () => {
    const manifest = JSON.parse(raw("manifest.json").toString("utf8")) as {
      manifestVersion: string;
      comparisonGeneration: string;
      priceConvention: string;
      files: Record<string, string>;
    };
    expect(manifest.manifestVersion).toBe("monitoring-comparison-replay-v3");
    expect(manifest.comparisonGeneration).toBe(MONITORING_COMPARISON_CONTRACT.comparisonGeneration);
    expect(manifest.priceConvention).toBe("strict-next-same-symbol-causal-100-share-depth-vwap-entry-and-exit");
    expect(sha256(raw("input.json"))).toBe(manifest.files["input.json"]);
    expect(sha256(raw("expected.json"))).toBe(manifest.files["expected.json"]);

    const input = JSON.parse(raw("input.json").toString("utf8")) as {
      datasetId: string;
      rows: Array<{
        id: string;
        strategyVersion: string;
        routeId: string;
        side: "long" | "short";
        entryIntent: MonitoringComparisonSignal;
        entryBoardEvent: MonitoringComparisonSourceEvent;
        exitIntent: MonitoringComparisonSignal;
        exitBoardEvent: MonitoringComparisonSourceEvent;
      }>;
    };
    const expected = JSON.parse(raw("expected.json").toString("utf8")) as { datasetId: string; results: unknown[] };
    expect(input.datasetId).toBe(expected.datasetId);
    expect(input.rows.map(row => ({
      id: row.id,
      strategyVersion: row.strategyVersion,
      routeId: row.routeId,
      entry: resolveMonitoringComparisonEntry(row.entryIntent, row.entryBoardEvent),
      exit: resolveMonitoringComparisonExit(row.exitIntent, row.side, row.exitBoardEvent),
    }))).toEqual(expected.results);
  });
});
