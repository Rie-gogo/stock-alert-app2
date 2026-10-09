import { finalizeClosedTradeDateTail } from "../server/closedTradeDateTailDrain.ts";

const tradeDate = process.argv[2];
const maxHeartbeats = Number.parseInt(process.argv[3] ?? "160", 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate ?? "")) {
  throw new Error(`tradeDate must be YYYY-MM-DD: ${tradeDate}`);
}
if (
  !Number.isInteger(maxHeartbeats) ||
  maxHeartbeats <= 0 ||
  maxHeartbeats > 480
) {
  throw new Error(
    `maxHeartbeats must be an integer between 1 and 480: ${process.argv[3]}`
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let priorOutstanding = Number.POSITIVE_INFINITY;
let stalledHeartbeats = 0;

for (let heartbeat = 1; heartbeat <= maxHeartbeats; heartbeat += 1) {
  const result = await finalizeClosedTradeDateTail({
    tradeDate,
    now: new Date(),
    limits: {
      // One bounded existing-worker pass per heartbeat. The next heartbeat resumes from
      // the persisted CAS/lease queue head; no shadow condition or source event is rebuilt.
      maxDrainPasses: 1,
      maxRowsPerPass: 50,
      maxDurationMsPerPass: 15_000,
      maxRetryCycles: 1,
      retryBackoffMs: 0,
      maxMaterializationPasses: 40,
      materializationPauseMs: 250,
    },
  });
  const outstanding =
    result.watermark.shadow.pending +
    result.watermark.shadow.processing +
    result.watermark.shadow.error +
    result.watermark.candidate.pending +
    result.watermark.candidate.processing +
    result.watermark.candidate.retryableError +
    result.watermark.candidate.terminal;
  const errors =
    result.watermark.shadow.error +
    result.watermark.candidate.retryableError +
    result.watermark.candidate.terminal;
  const progress = {
    heartbeat,
    status: result.status,
    outstanding,
    errors,
    processed: result.watermark.shadow.processed,
    sourceCount: result.watermark.sourceCount,
    finalityReady: result.watermark.ready,
    materializationComplete: result.materialization.complete,
    reason: result.reason ?? null,
  };
  console.log(JSON.stringify(progress));

  if (result.status === "complete") process.exit(0);
  if (errors > 0) {
    console.error(
      "tail-drain stopped: audit-visible queue error or terminal gap",
      JSON.stringify(progress)
    );
    process.exit(2);
  }
  if (outstanding < priorOutstanding) {
    stalledHeartbeats = 0;
  } else {
    stalledHeartbeats += 1;
  }
  if (stalledHeartbeats >= 3) {
    console.error(
      "tail-drain stopped: no persisted queue progress across three bounded heartbeats",
      JSON.stringify(progress)
    );
    process.exit(3);
  }
  priorOutstanding = outstanding;
  // A finite 15-second heartbeat reclaims no lease itself; the underlying worker retains
  // its normal CAS/lease rules and resumes from the durable queue head on the next pass.
  await sleep(15_000);
}

console.error(`tail-drain stopped: heartbeat limit ${maxHeartbeats} reached`);
process.exit(4);
