export type CandidateVirtualDrainSummary = {
  stoppedReason: string;
  processedEngineSequences: number[];
};

export type CandidateVirtualWorkCounts = {
  pending: number;
  processing: number;
  retryableError: number;
};

export function shouldVerifyCandidateVirtualRecovery(result: CandidateVirtualDrainSummary): boolean {
  return result.stoppedReason === "empty_or_claimed" && result.processedEngineSequences.length === 0;
}

export function isCandidateVirtualRecoveryComplete(counts: CandidateVirtualWorkCounts): boolean {
  return counts.pending === 0 && counts.processing === 0 && counts.retryableError === 0;
}
