import { readFileSync, writeFileSync } from "node:fs";

const inputPath = process.argv[2] ?? "analysis/technical-shadow-v2-last30-20260818-20261002-compare-targets.json";
const outputPath = process.argv[3] ?? "analysis/technical-shadow-v2-tp-policy-summary-eight-symbols-last30.json";
const excluded = new Set(["285A", "5803"]);

type Action = Record<string, unknown>;
type Detail = {
  symbol: string;
  tradeDate: string;
  entries: Action[];
  exits: Action[];
  openAtEnd: unknown;
  pnlPer100: number;
};

const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
  targetDates: string[];
  detailsByPolicy: Record<string, Detail[]>;
};

function key(detail: Detail) {
  return `${detail.symbol}|${detail.tradeDate}`;
}

function selectedByEntryThreshold(detail: Detail) {
  const entry = detail.entries[0];
  if (!entry) return false;
  const entryPrice = Number(entry.executableEntryPrice);
  const stopPrice = Number(entry.stopPrice);
  const targetPrice = Number(entry.originalTargetPrice ?? entry.targetPrice);
  const eventTime = String(entry.eventTime ?? "");
  if (![entryPrice, stopPrice, targetPrice].every(Number.isFinite)) return false;
  const riskPer100 = Math.abs(entryPrice - stopPrice) * 100;
  const rewardPer100 = Math.abs(targetPrice - entryPrice) * 100;
  const rewardRisk = riskPer100 > 0 ? rewardPer100 / riskPer100 : null;
  return eventTime <= "14:20"
    && rewardPer100 >= 3_000
    && riskPer100 <= 125_000
    && rewardRisk !== null
    && rewardRisk >= 0.1
    && rewardRisk <= 1.15;
}

function maxDrawdown(values: Array<{ tradeDate: string; pnl: number }>) {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const item of values.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))) {
    equity += item.pnl;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

function summarize(details: Detail[]) {
  const trades = details.filter(detail => detail.exits.length > 0 || detail.openAtEnd);
  const wins = trades.filter(detail => detail.pnlPer100 > 0).length;
  const losses = trades.filter(detail => detail.pnlPer100 < 0).length;
  const draws = trades.filter(detail => detail.pnlPer100 === 0).length;
  const exitReasons = Object.fromEntries(Array.from(new Set(trades.flatMap(detail => detail.exits.map(exit => String(exit.exitReason ?? "open")))))
    .sort()
    .map(reason => {
      const rows = trades.filter(detail => detail.exits.some(exit => String(exit.exitReason ?? "open") === reason));
      return [reason, { trades: rows.length, pnlPer100: rows.reduce((sum, row) => sum + row.pnlPer100, 0) }];
    }));
  return {
    trades: trades.length,
    wins,
    losses,
    draws,
    winRate: trades.length ? wins / trades.length * 100 : null,
    pnlPer100: trades.reduce((sum, detail) => sum + detail.pnlPer100, 0),
    maxDrawdownPer100: maxDrawdown(trades.map(detail => ({ tradeDate: detail.tradeDate, pnl: detail.pnlPer100 }))),
    exitReasons,
  };
}

const raw = (input.detailsByPolicy.current_raw ?? []).filter(detail => !excluded.has(detail.symbol));
const selectedKeys = new Set(raw.filter(selectedByEntryThreshold).map(key));
const dateWindows = {
  all30: new Set(input.targetDates),
  first15: new Set(input.targetDates.slice(0, 15)),
  last15: new Set(input.targetDates.slice(-15)),
  last10: new Set(input.targetDates.slice(-10)),
  last5: new Set(input.targetDates.slice(-5)),
};
function summarizeWindows(details: Detail[]) {
  return Object.fromEntries(Object.entries(dateWindows).map(([name, dates]) => [name, summarize(details.filter(detail => dates.has(detail.tradeDate)))]));
}
const policyComparison = Object.fromEntries(Object.entries(input.detailsByPolicy).map(([policy, rows]) => {
  const eight = rows.filter(detail => !excluded.has(detail.symbol));
  return [policy, {
    allEntries: summarizeWindows(eight),
    fixedEntryThreshold: summarizeWindows(eight.filter(detail => selectedKeys.has(key(detail)))),
  }];
}));

const output = {
  generatedAt: new Date().toISOString(),
  inputPath,
  targetDates: input.targetDates,
  symbols: Array.from(new Set(raw.map(detail => detail.symbol))).sort(),
  excludedSymbols: Array.from(excluded),
  fixedEntryThresholdDefinition: {
    entryThrough: "14:20",
    originalTechnicalRewardPer100Min: 3_000,
    initialRiskPer100Max: 125_000,
    originalRewardRiskMin: 0.1,
    originalRewardRiskMax: 1.15,
    selectionUsesCurrentRawEntryOnly: true,
  },
  selectedTradeKeys: Array.from(selectedKeys).sort(),
  policyComparison,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, selectedTrades: selectedKeys.size, policyComparison }, null, 2));
