interface RiskPair {
  path: string;
  slPct: number;
  tpPct: number;
}

const TAIYO_AFTERNOON_LONG_WINRATE_VERSION = "candidate-6976-afternoon-long-recovery-winrate-v1";
const TAIYO_WINRATE_EXCEPTION = "user_approved_forward_shadow_tp_below_2r_2026-09-12";
const TECHNICAL_LEVEL_EXCEPTION = "user_approved_dynamic_technical_levels_2026-10-02";
const BOLLINGER_DIRECTIONAL_EXCEPTION = "user_approved_bollinger_directional_shadow_2026-10-06";

function permitsExplicitRiskRewardException(input: { versionId: string; configJson: unknown }): boolean {
  if (input.versionId !== TAIYO_AFTERNOON_LONG_WINRATE_VERSION
    || !input.configJson || typeof input.configJson !== "object") return false;
  const policy = (input.configJson as Record<string, unknown>).riskRewardPolicy;
  return Boolean(policy && typeof policy === "object"
    && (policy as Record<string, unknown>).exception === TAIYO_WINRATE_EXCEPTION
    && (policy as Record<string, unknown>).automaticAdoption === false);
}

function permitsDynamicTechnicalLevels(input: { versionId: string; configJson: unknown }): boolean {
  if (!input.versionId.match(/^candidate-(285a|3436|5803|6146|6526|6857|6976|6981|8035|9984)-technical-regime-a-v1$/)
    || !input.configJson || typeof input.configJson !== "object") return false;
  const policy = (input.configJson as Record<string, unknown>).riskRewardPolicy;
  return Boolean(policy && typeof policy === "object"
    && (policy as Record<string, unknown>).mode === "dynamic_technical_levels"
    && (policy as Record<string, unknown>).exception === TECHNICAL_LEVEL_EXCEPTION
    && Number((policy as Record<string, unknown>).minimumRewardRisk) >= 1.2
    && (policy as Record<string, unknown>).automaticAdoption === false);
}

function permitsFixedEntryBollingerLevels(input: { versionId: string; configJson: unknown; eligibleForAdoption?: boolean }): boolean {
  if (!input.versionId.match(/^candidate-(285a|3436|5803|6146|6526|6857|6976|6981|8035|9984)-bollinger-directional-(fixed-stop140-cooldown30|sma20-dynamic-rsi14-gap060-stop140-cooldown30|sma10-slope-gap050-stop140-cooldown30)-v[12]$/)
    || !input.configJson || typeof input.configJson !== "object") return false;
  const policy = (input.configJson as Record<string, unknown>).riskRewardPolicy;
  return Boolean(policy && typeof policy === "object"
    && (policy as Record<string, unknown>).mode === "fixed_entry_bollinger_opposite_band"
    && (policy as Record<string, unknown>).exception === BOLLINGER_DIRECTIONAL_EXCEPTION
    && (policy as Record<string, unknown>).automaticAdoption === false
    && input.eligibleForAdoption === false);
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
  if (purpose !== "candidate") return [];
  const pairs = collectRiskPairs(input.configJson);
  if (pairs.length === 0 && (permitsDynamicTechnicalLevels(input) || permitsFixedEntryBollingerLevels(input))) return [];
  if (pairs.length === 0) {
    throw new Error(`candidate_risk_reward_missing:${input.versionId}`);
  }
  const invalid = pairs.filter(pair => pair.tpPct + 1e-12 < pair.slPct * 2);
  if (invalid.length > 0 && !permitsExplicitRiskRewardException(input)) {
    throw new Error(`candidate_risk_reward_below_2x:${input.versionId}:${invalid.map(pair => `${pair.path}=${pair.tpPct}/${pair.slPct}`).join(",")}`);
  }
  return pairs;
}
