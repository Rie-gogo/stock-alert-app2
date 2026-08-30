/**
 * 6857（アドバンテスト）高値失速SHORTの弱出来高ブロック仕様。
 *
 * 「始値比」は判定時点までの当日高値と当日始値の差であり、現在値との
 * 差ではない。初回SHORTだけに適用し、損切り後の再評価SHORTには適用しない。
 */
export const ADVANTEST_INITIAL_SHORT_WEAK_VOLUME_SPEC = {
  minRiseFromOpenPct: 1.9,
  maxVolumeRatioExclusive: 2.2,
  initialShortOnly: true,
} as const;

export interface AdvantestWeakVolumeBlockInput {
  isReentry: boolean;
  riseFromOpenPct: number;
  volumeRatio: number;
  minRiseFromOpenPct?: number;
  maxVolumeRatioExclusive?: number;
}

export function shouldBlockAdvantestInitialShortByWeakVolume({
  isReentry,
  riseFromOpenPct,
  volumeRatio,
  minRiseFromOpenPct = ADVANTEST_INITIAL_SHORT_WEAK_VOLUME_SPEC.minRiseFromOpenPct,
  maxVolumeRatioExclusive = ADVANTEST_INITIAL_SHORT_WEAK_VOLUME_SPEC.maxVolumeRatioExclusive,
}: AdvantestWeakVolumeBlockInput): boolean {
  return !isReentry &&
    riseFromOpenPct >= minRiseFromOpenPct &&
    volumeRatio < maxVolumeRatioExclusive;
}
