import { describe, it, expect } from "vitest";
import {
  isVolumeConfirmed,
  isTrendAligned,
  isMomentumAligned,
  scoreToConfidence,
  evaluateConfirmation,
  trailingAvgVolume,
  priceMomentum,
  VOLUME_SURGE_MULT,
} from "./signalConfirmation";

describe("isVolumeConfirmed", () => {
  it("平均が取れない場合は裏付けなし(false)", () => {
    expect(isVolumeConfirmed(1000, null)).toBe(false);
    expect(isVolumeConfirmed(1000, 0)).toBe(false);
  });
  it("平均比がしきい値以上なら true", () => {
    expect(isVolumeConfirmed(1200, 1000)).toBe(true); // 1.2倍 = しきい値
    expect(isVolumeConfirmed(2000, 1000)).toBe(true);
  });
  it("平均比がしきい値未満なら false", () => {
    expect(isVolumeConfirmed(1100, 1000)).toBe(false); // 1.1倍 < 1.2
  });
  it("しきい値はカスタマイズできる", () => {
    expect(isVolumeConfirmed(1100, 1000, 1.05)).toBe(true);
  });
  it("VOLUME_SURGE_MULT は 1.2", () => {
    expect(VOLUME_SURGE_MULT).toBe(1.2);
  });
});

describe("isTrendAligned", () => {
  it("buy: MA5>=MA25 なら一致", () => {
    expect(isTrendAligned("buy", 110, 100)).toBe(true);
    expect(isTrendAligned("buy", 100, 100)).toBe(true);
    expect(isTrendAligned("buy", 90, 100)).toBe(false);
  });
  it("sell: MA5<=MA25 なら一致", () => {
    expect(isTrendAligned("sell", 90, 100)).toBe(true);
    expect(isTrendAligned("sell", 110, 100)).toBe(false);
  });
  it("warn は常に true", () => {
    expect(isTrendAligned("warn", null, null)).toBe(true);
  });
  it("MAがnullなら売買方向は false", () => {
    expect(isTrendAligned("buy", null, 100)).toBe(false);
    expect(isTrendAligned("sell", 100, null)).toBe(false);
  });
});

describe("isMomentumAligned", () => {
  it("buy: momentum>0 で一致", () => {
    expect(isMomentumAligned("buy", 5)).toBe(true);
    expect(isMomentumAligned("buy", -5)).toBe(false);
    expect(isMomentumAligned("buy", 0)).toBe(false);
  });
  it("sell: momentum<0 で一致", () => {
    expect(isMomentumAligned("sell", -5)).toBe(true);
    expect(isMomentumAligned("sell", 5)).toBe(false);
  });
  it("warn は常に true、null は売買方向で false", () => {
    expect(isMomentumAligned("warn", null)).toBe(true);
    expect(isMomentumAligned("buy", null)).toBe(false);
  });
});

describe("scoreToConfidence", () => {
  it("3で強、2で中、1以下で弱", () => {
    expect(scoreToConfidence(3)).toBe("strong");
    expect(scoreToConfidence(2)).toBe("medium");
    expect(scoreToConfidence(1)).toBe("weak");
    expect(scoreToConfidence(0)).toBe("weak");
  });
});

describe("trailingAvgVolume", () => {
  it("index=0 は null", () => {
    expect(trailingAvgVolume([100, 200, 300], 0)).toBeNull();
  });
  it("直近 lookback 本の平均を返す", () => {
    const vols = [100, 200, 300, 400];
    expect(trailingAvgVolume(vols, 3, 2)).toBe(250); // (200+300)/2
    expect(trailingAvgVolume(vols, 3, 10)).toBe(200); // (100+200+300)/3
  });
});

describe("priceMomentum", () => {
  it("データ不足なら null", () => {
    expect(priceMomentum([100, 101], 1, 3)).toBeNull();
  });
  it("k本前との差を返す", () => {
    expect(priceMomentum([100, 102, 104, 106], 3, 3)).toBe(6); // 106-100
  });
});

describe("evaluateConfirmation", () => {
  it("3つ全て裏付けありなら strong かつ通知対象", () => {
    const r = evaluateConfirmation({
      type: "buy",
      close: 110,
      volume: 2000,
      avgVolume: 1000,
      ma5: 110,
      ma25: 100,
      momentum: 5,
    });
    expect(r.score).toBe(3);
    expect(r.confidence).toBe("strong");
    expect(r.shouldNotify).toBe(true);
    expect(r.summary).toContain("信頼度：強");
  });

  it("裏付け2つなら medium かつ通知対象", () => {
    const r = evaluateConfirmation({
      type: "buy",
      close: 110,
      volume: 900, // 出来高薄（裏付けなし）
      avgVolume: 1000,
      ma5: 110, // トレンド一致
      ma25: 100,
      momentum: 5, // 勢い一致
    });
    expect(r.score).toBe(2);
    expect(r.confidence).toBe("medium");
    expect(r.shouldNotify).toBe(true);
  });

  it("裏付け1つ以下なら weak かつ通知対象外", () => {
    const r = evaluateConfirmation({
      type: "buy",
      close: 90,
      volume: 900, // 薄
      avgVolume: 1000,
      ma5: 90, // トレンド逆行
      ma25: 100,
      momentum: 5, // 勢いのみ一致
    });
    expect(r.score).toBe(1);
    expect(r.confidence).toBe("weak");
    expect(r.shouldNotify).toBe(false);
  });

  it("sell方向でも正しく評価する", () => {
    const r = evaluateConfirmation({
      type: "sell",
      close: 90,
      volume: 2000, // 出来高増
      avgVolume: 1000,
      ma5: 90, // 下向き一致
      ma25: 100,
      momentum: -5, // 下落勢い一致
    });
    expect(r.score).toBe(3);
    expect(r.confidence).toBe("strong");
  });
});
