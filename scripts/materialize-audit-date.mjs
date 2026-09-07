import { materializeNextAuditComponentForDate } from "../server/auditMaterializer.ts";

const tradeDate = process.argv[2];
const maxRuns = Number.parseInt(process.argv[3] ?? "40", 10);
const pauseMs = Number.parseInt(process.argv[4] ?? "3000", 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate ?? "")) {
  throw new Error(`tradeDate must be YYYY-MM-DD: ${tradeDate}`);
}
if (!Number.isInteger(maxRuns) || maxRuns <= 0 || maxRuns > 100) {
  throw new Error(`maxRuns must be an integer between 1 and 100: ${process.argv[3]}`);
}
if (!Number.isInteger(pauseMs) || pauseMs < 1000 || pauseMs > 60_000) {
  throw new Error(`pauseMs must be an integer between 1000 and 60000: ${process.argv[4]}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let run = 1; run <= maxRuns; run += 1) {
  const startedAt = Date.now();
  const result = await materializeNextAuditComponentForDate(tradeDate, {
    now: new Date(),
    maxTimelineItems: 250,
    maxMinutes: 30,
  });
  console.log(JSON.stringify({
    run,
    elapsedMs: Date.now() - startedAt,
    status: result.status,
    component: result.component,
    processedThroughEngineSequence: result.processedThroughEngineSequence ?? null,
    sourceDecisionCount: result.sourceDecisionCount ?? null,
    strategyVersion: result.result?.strategyVersion ?? null,
    workerStatus: result.status === "worker_busy" ? "worker_busy" : "acquired",
  }));

  if (result.status === "complete" && result.component === "all") break;
  await sleep(result.status === "worker_busy" ? Math.max(pauseMs, 5000) : pauseMs);
}
