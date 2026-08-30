import { describe, expect, it } from "vitest";
import {
  ADVANTEST_INITIAL_SHORT_WEAK_VOLUME_SPEC,
  shouldBlockAdvantestInitialShortByWeakVolume,
} from "./advantestWeakVolumeFilter";

describe("6857 初回SHORT弱出来高ブロック", () => {
  it("始値比1.9%以上かつ出来高2.2倍未満の初回SHORTだけを停止する", () => {
    expect(ADVANTEST_INITIAL_SHORT_WEAK_VOLUME_SPEC).toEqual({
      minRiseFromOpenPct: 1.9,
      maxVolumeRatioExclusive: 2.2,
      initialShortOnly: true,
    });

    expect(shouldBlockAdvantestInitialShortByWeakVolume({
      isReentry: false,
      riseFromOpenPct: 1.9,
      volumeRatio: 2.1999,
    })).toBe(true);
  });

  it("始値比が1.9%未満なら出来高が弱くても停止しない", () => {
    expect(shouldBlockAdvantestInitialShortByWeakVolume({
      isReentry: false,
      riseFromOpenPct: 1.8999,
      volumeRatio: 1.2,
    })).toBe(false);
  });

  it("出来高2.2倍ちょうど以上なら始値比が高くても停止しない", () => {
    expect(shouldBlockAdvantestInitialShortByWeakVolume({
      isReentry: false,
      riseFromOpenPct: 3.0,
      volumeRatio: 2.2,
    })).toBe(false);
  });

  it("損切り後の再評価SHORTには適用しない", () => {
    expect(shouldBlockAdvantestInitialShortByWeakVolume({
      isReentry: true,
      riseFromOpenPct: 4.0,
      volumeRatio: 1.2,
    })).toBe(false);
  });
});
