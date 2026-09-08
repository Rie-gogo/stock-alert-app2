import { applyFujikuraCandidateVirtualRepair, getFujikuraCandidateVirtualRepair, prepareFujikuraCandidateVirtualRepair } from "../server/fujikuraCandidateVirtualRepair.ts";

const phase = process.argv[2] ?? "prepare";
const runId = process.argv[3] ?? "fujikura-2026-09-08-repair-v1";

if (phase === "prepare") {
  console.log(JSON.stringify(await prepareFujikuraCandidateVirtualRepair({ runId }), null, 2));
} else if (phase === "apply") {
  console.log(JSON.stringify(await applyFujikuraCandidateVirtualRepair(runId), null, 2));
} else if (phase === "status") {
  console.log(JSON.stringify(await getFujikuraCandidateVirtualRepair(runId), null, 2));
} else {
  throw new Error(`unknown_phase:${phase}`);
}
