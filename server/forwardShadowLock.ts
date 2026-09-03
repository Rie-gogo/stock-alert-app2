import { createHash, randomUUID } from "node:crypto";

/**
 * rt_forward_shadow_locks.owner_token は varchar(64)。
 * relayの長いsourceEventIdを直接連結せず、取得試行ごとに一意な入力をSHA-256へ固定する。
 */
export function createForwardShadowLockOwnerToken(input: {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: string;
}): string {
  return createHash("sha256")
    .update(`${input.strategyVersion}\n${input.sourceEventId}\n${input.evaluationMode}\n${randomUUID()}`)
    .digest("hex");
}
