import { drainCurrentCandidateVirtualQueue } from "../server/realtimeDecisionAudit.ts";

const maxBatches = Number.parseInt(process.argv[2] ?? "40", 10);
const pauseMs = Number.parseInt(process.argv[3] ?? "3000", 10);

if (!Number.isInteger(maxBatches) || maxBatches <= 0 || maxBatches > 100) {
  throw new Error(`maxBatches must be an integer between 1 and 100: ${process.argv[2]}`);
}
if (!Number.isInteger(pauseMs) || pauseMs < 1000 || pauseMs > 60_000) {
  throw new Error(`pauseMs must be an integer between 1000 and 60000: ${process.argv[3]}`);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

for (let batch = 1; batch <= maxBatches; batch += 1) {
  const startedAt = Date.now();
  const result = await drainCurrentCandidateVirtualQueue({
    maxRows: 100,
    maxDurationMs: 20_000,
    maxAttempts: 5,
  });
  const summary = {
    batch,
    elapsedMs: Date.now() - startedAt,
    processed: result.processedEngineSequences.length,
    firstEngineSequence: result.processedEngineSequences[0] ?? null,
    lastEngineSequence: result.processedEngineSequences.at(-1) ?? null,
    terminalizedRows: result.terminalizedRows,
    stoppedReason: result.stoppedReason,
  };
  console.log(JSON.stringify(summary));

  if (result.stoppedReason === "no_work") break;
  await sleep(result.stoppedReason === "worker_busy" ? Math.max(pauseMs, 5000) : pauseMs);
}
