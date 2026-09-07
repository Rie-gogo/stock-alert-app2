import { describe, expect, it } from "vitest";
import {
  isCandidateVirtualRecoveryComplete,
  shouldVerifyCandidateVirtualRecovery,
} from "./candidateVirtualRecoveryPolicy";

describe("candidate/virtual one-time recovery policy", () => {
  it("worker実返却empty_or_claimedかつ0件の時だけDB完了確認へ進む", () => {
    expect(shouldVerifyCandidateVirtualRecovery({ stoppedReason: "empty_or_claimed", processedEngineSequences: [] })).toBe(true);
    expect(shouldVerifyCandidateVirtualRecovery({ stoppedReason: "no_work", processedEngineSequences: [] })).toBe(false);
    expect(shouldVerifyCandidateVirtualRecovery({ stoppedReason: "empty_or_claimed", processedEngineSequences: [1] })).toBe(false);
  });

  it("pending・processing・retryable errorが全て0の時だけ復旧完了とする", () => {
    expect(isCandidateVirtualRecoveryComplete({ pending: 0, processing: 0, retryableError: 0 })).toBe(true);
    expect(isCandidateVirtualRecoveryComplete({ pending: 1, processing: 0, retryableError: 0 })).toBe(false);
    expect(isCandidateVirtualRecoveryComplete({ pending: 0, processing: 1, retryableError: 0 })).toBe(false);
    expect(isCandidateVirtualRecoveryComplete({ pending: 0, processing: 0, retryableError: 1 })).toBe(false);
  });
});
