/**
 * signalConfirmation.ts
 * シグナルの「確認フィルタ」と「信頼度判定」を行う純粋関数群。
 *
 * 目的: 移動平均クロス・RSIなどの単独シグナルは1分足ではダマシ（だまし）が多い。
 * そこで、シグナル候補が出た足に対して複数の独立した裏付け（出来高・短期トレンド方向・
 * 直近モメンタム）を確認し、裏付けの数に応じて信頼度を付与する。
 * 裏付けが弱いものは「弱いシグナル（weak）」として抑制（通知対象から外す）できるようにする。
 *
 * このモジュールは副作用を持たず、テスト容易性のためすべて純粋関数で構成する。
 */

export type SignalType = "buy" | "sell" | "warn";
export type SignalConfidence = "strong" | "medium" | "weak";

/** 確認フィルタに渡す、ある足までの市況スナップショット */
export interface ConfirmationContext {
  /** シグナルの方向 */
  type: SignalType;
  /** 当該足の終値 */
  close: number;
  /** 当該足の出来高 */
  volume: number;
  /** 直近 N 本（当該足を除く）の平均出来高。算出不能なら null */
  avgVolume: number | null;
  /** 短期移動平均(MA5)。null可 */
  ma5: number | null;
  /** 中期移動平均(MA25)。null可 */
  ma25: number | null;
  /** 直近の価格モメンタム = 当該足終値 - kバー前の終値。算出不能なら null */
  momentum: number | null;
}

/** 個々の確認結果 */
export interface ConfirmationChecks {
  /** 出来高がしきい値以上に増加してシグナルを裏付けているか */
  volumeConfirmed: boolean;
  /** 短期トレンド方向(MA5 vs MA25)がシグナル方向と一致しているか */
  trendAligned: boolean;
  /** 直近モメンタムの符号がシグナル方向と一致しているか */
  momentumAligned: boolean;
}

export interface ConfirmationResult {
  checks: ConfirmationChecks;
  /** 裏付けが取れた数(0〜3) */
  score: number;
  confidence: SignalConfidence;
  /** 通知対象にしてよいか（weak は false） */
  shouldNotify: boolean;
  /** 人間可読の裏付け要約（理由文に追記する用途） */
  summary: string;
}

/** 出来高が「急増」と見なす、直近平均に対する倍率のしきい値 */
export const VOLUME_SURGE_MULT = 1.2;

/**
 * 出来高がシグナルを裏付けているか。
 * 平均が取れない（序盤など）場合は「裏付けなし(false)」とせず中立に倒すと過剰発火するため、
 * ここでは明確に平均比 >= しきい値のときのみ true とする。
 */
export function isVolumeConfirmed(
  volume: number,
  avgVolume: number | null,
  mult: number = VOLUME_SURGE_MULT
): boolean {
  if (avgVolume === null || avgVolume <= 0) return false;
  return volume >= avgVolume * mult;
}

/**
 * 短期トレンド方向(MA5 vs MA25)がシグナル方向と一致しているか。
 * buy: MA5 >= MA25（上向き地合い） / sell: MA5 <= MA25（下向き地合い）。
 * warn は方向性を問わないため常に true 扱い。
 */
export function isTrendAligned(
  type: SignalType,
  ma5: number | null,
  ma25: number | null
): boolean {
  if (type === "warn") return true;
  if (ma5 === null || ma25 === null) return false;
  if (type === "buy") return ma5 >= ma25;
  return ma5 <= ma25; // sell
}

/**
 * 直近モメンタムの符号がシグナル方向と一致しているか。
 * buy: momentum > 0 / sell: momentum < 0 / warn: 常に true。
 */
export function isMomentumAligned(type: SignalType, momentum: number | null): boolean {
  if (type === "warn") return true;
  if (momentum === null) return false;
  if (type === "buy") return momentum > 0;
  return momentum < 0; // sell
}

/** スコア(0〜3)から信頼度ラベルを決める */
export function scoreToConfidence(score: number): SignalConfidence {
  if (score >= 3) return "strong";
  if (score === 2) return "medium";
  return "weak";
}

/**
 * シグナル候補に対する確認フィルタの総合評価。
 * 3つの独立した裏付け（出来高・トレンド方向・モメンタム）を数え、信頼度を決める。
 * weak（裏付け0〜1）は通知対象から外す（shouldNotify=false）。
 */
export function evaluateConfirmation(ctx: ConfirmationContext): ConfirmationResult {
  const volumeConfirmed = isVolumeConfirmed(ctx.volume, ctx.avgVolume);
  const trendAligned = isTrendAligned(ctx.type, ctx.ma5, ctx.ma25);
  const momentumAligned = isMomentumAligned(ctx.type, ctx.momentum);

  const checks: ConfirmationChecks = { volumeConfirmed, trendAligned, momentumAligned };
  const score = [volumeConfirmed, trendAligned, momentumAligned].filter(Boolean).length;
  const confidence = scoreToConfidence(score);
  const shouldNotify = confidence !== "weak";

  const parts: string[] = [];
  parts.push(trendAligned ? "トレンド一致" : "トレンド逆行");
  parts.push(momentumAligned ? "勢い一致" : "勢い不一致");
  parts.push(volumeConfirmed ? "出来高増" : "出来高薄");
  const summary = `[${confidenceLabel(confidence)}] ${parts.join("・")}`;

  return { checks, score, confidence, shouldNotify, summary };
}

/** 信頼度の日本語ラベル */
export function confidenceLabel(c: SignalConfidence): string {
  switch (c) {
    case "strong":
      return "信頼度：強";
    case "medium":
      return "信頼度：中";
    default:
      return "信頼度：弱";
  }
}

/**
 * 直近 lookback 本（当該indexを除く過去）の平均出来高を求めるヘルパー。
 * データ不足なら null。
 */
export function trailingAvgVolume(volumes: number[], index: number, lookback = 10): number | null {
  if (index <= 0) return null;
  const start = Math.max(0, index - lookback);
  const slice = volumes.slice(start, index);
  if (slice.length === 0) return null;
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / slice.length;
}

/**
 * 直近 k 本前の終値からのモメンタム（価格差）。データ不足なら null。
 */
export function priceMomentum(closes: number[], index: number, k = 3): number | null {
  if (index - k < 0) return null;
  return closes[index] - closes[index - k];
}
