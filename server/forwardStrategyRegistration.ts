interface RiskPair {
  path: string;
  slPct: number;
  tpPct: number;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function collectRiskPairs(value: unknown, path = "config", pairs: RiskPair[] = []): RiskPair[] {
  if (!value || typeof value !== "object") return pairs;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRiskPairs(item, `${path}[${index}]`, pairs));
    return pairs;
  }
  const record = value as Record<string, unknown>;
  const directSl = finite(record.slPct);
  const directTp = finite(record.tpPct);
  if (directSl !== null && directTp !== null) pairs.push({ path, slPct: directSl, tpPct: directTp });
  for (const [key, item] of Object.entries(record)) collectRiskPairs(item, `${path}.${key}`, pairs);
  return pairs;
}

export function assertForwardCandidateRiskReward(input: {
  versionId: string;
  evaluationPurpose?: "candidate" | "parity_only" | "causality_audit";
  eligibleForAdoption?: boolean;
  configJson: unknown;
}): RiskPair[] {
  const purpose = input.evaluationPurpose ?? "candidate";
  const eligible = input.eligibleForAdoption ?? true;
  if (purpose !== "candidate" || !eligible) return [];
  const pairs = collectRiskPairs(input.configJson);
  if (pairs.length === 0) {
    throw new Error(`candidate_risk_reward_missing:${input.versionId}`);
  }
  const invalid = pairs.filter(pair => pair.tpPct + 1e-12 < pair.slPct * 2);
  if (invalid.length > 0) {
    throw new Error(`candidate_risk_reward_below_2x:${input.versionId}:${invalid.map(pair => `${pair.path}=${pair.tpPct}/${pair.slPct}`).join(",")}`);
  }
  return pairs;
}
