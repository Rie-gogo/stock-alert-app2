import { readFileSync } from "node:fs";

const replayPath = process.argv[2] ?? "analysis/technical-shadow-v2-last30-20260818-20261002-compare-targets.json";
const summaryPath = process.argv[3] ?? "analysis/technical-shadow-v2-tp-policy-summary-eight-symbols-last30.json";

type PolicyStats = {
  trades?: number;
  symbolDays?: number;
  signalDays?: number;
  entryDays?: number;
  rejectedDays?: number;
  wins: number;
  losses: number;
  draws: number;
  pnlPer100: number;
};

const expectedDates = [
  "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-25",
  "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01",
  "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08",
  "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15",
  "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-24", "2026-09-25",
  "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
];

const expectedTenSymbol: Record<string, PolicyStats> = {
  current_raw: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 88, losses: 51, draws: 2, pnlPer100: -87_616 },
  current_tick: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 88, losses: 51, draws: 2, pnlPer100: -79_561 },
  minimum_05r: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 60, losses: 75, draws: 6, pnlPer100: -45_411 },
  minimum_08r: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 56, losses: 78, draws: 7, pnlPer100: 66_189 },
  minimum_10r: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 54, losses: 78, draws: 9, pnlPer100: 32_189 },
  minimum_12r: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 47, losses: 78, draws: 16, pnlPer100: -18_661 },
  next_technical_level: { symbolDays: 300, signalDays: 155, entryDays: 141, rejectedDays: 110, wins: 67, losses: 69, draws: 5, pnlPer100: -66_111 },
};

const expectedEightSymbol: Record<string, PolicyStats> = {
  current_raw: { trades: 116, wins: 76, losses: 39, draws: 1, pnlPer100: -84_151 },
  current_tick: { trades: 116, wins: 76, losses: 39, draws: 1, pnlPer100: -77_611 },
  minimum_05r: { trades: 116, wins: 52, losses: 61, draws: 3, pnlPer100: -63_461 },
  minimum_08r: { trades: 116, wins: 48, losses: 64, draws: 4, pnlPer100: 44_739 },
  minimum_10r: { trades: 116, wins: 47, losses: 64, draws: 5, pnlPer100: 15_739 },
  minimum_12r: { trades: 116, wins: 41, losses: 64, draws: 11, pnlPer100: -13_611 },
  next_technical_level: { trades: 116, wins: 56, losses: 56, draws: 4, pnlPer100: -88_261 },
};

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function compare(label: string, actual: Record<string, any>, expected: Record<string, any>, failures: string[]) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) failures.push(`${label}.${key}: expected=${value} actual=${String(actual?.[key])}`);
  }
}

const replay = readJson(replayPath);
const summary = readJson(summaryPath);
const failures: string[] = [];

if (JSON.stringify(replay.targetDates) !== JSON.stringify(expectedDates)) {
  failures.push(`targetDates differ: expected=${expectedDates.join(",")} actual=${(replay.targetDates ?? []).join(",")}`);
}
if (replay.referenceOnly !== true || replay.formalForwardScore !== false) {
  failures.push("reference/formal flags differ: result must remain referenceOnly=true and formalForwardScore=false");
}
for (const [policy, expected] of Object.entries(expectedTenSymbol)) {
  compare(`tenSymbol.${policy}`, replay.policyComparison?.[policy] ?? {}, expected, failures);
}
for (const [policy, expected] of Object.entries(expectedEightSymbol)) {
  compare(`eightSymbol.${policy}`, summary.policyComparison?.[policy]?.allEntries?.all30 ?? {}, expected, failures);
}

const result = {
  status: failures.length === 0 ? "exact_reference_match" : "reference_mismatch",
  replayPath,
  summaryPath,
  checkedTargetDates: expectedDates.length,
  checkedPolicies: Object.keys(expectedTenSymbol),
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
