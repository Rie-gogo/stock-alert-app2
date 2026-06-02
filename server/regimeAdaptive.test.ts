import { describe, it, expect } from "vitest";
import { evaluateRegimeGates, getLotRatio, REGIME_CONSTANTS } from "./realSimulation";

/**
 * レジーム適応型ロジックの単体テスト
 * 「その時の相場の雰囲気」に合った方向だけを許可することを検証する。
 */
describe("evaluateRegimeGates（レジーム方向ゲート）", () => {
  const base = {
    slope: 0,
    flow: 0,
    mktBias: 0,
    inWarmup: false,
    halted: false,
    isHighVolDay: false,
  };

  it("上昇トレンド+買い圧力ならロングのみ許可", () => {
    const r = evaluateRegimeGates({ ...base, slope: 0.001, flow: 1000 });
    expect(r.allowLong).toBe(true);
    expect(r.allowShort).toBe(false);
  });

  it("下落トレンド+売り圧力ならショートのみ許可", () => {
    const r = evaluateRegimeGates({ ...base, slope: -0.001, flow: -1000 });
    expect(r.allowShort).toBe(true);
    expect(r.allowLong).toBe(false);
  });

  it("市場全体が下落ムードのときはロングを禁止する", () => {
    // 個別は上昇でも、市場全体が下げていればロングしない
    const r = evaluateRegimeGates({ ...base, slope: 0.001, flow: 1000, mktBias: -0.01 });
    expect(r.allowLong).toBe(false);
  });

  it("市場全体が上昇ムードのときはショートを禁止する", () => {
    const r = evaluateRegimeGates({ ...base, slope: -0.001, flow: -1000, mktBias: 0.01 });
    expect(r.allowShort).toBe(false);
  });

  it("超高ボラ日はショートを全面禁止する（急騰ダマシ回避）", () => {
    const r = evaluateRegimeGates({ ...base, slope: -0.001, flow: -1000, isHighVolDay: true });
    expect(r.allowShort).toBe(false);
  });

  it("超高ボラ日でもロングは許可される", () => {
    const r = evaluateRegimeGates({ ...base, slope: 0.001, flow: 1000, isHighVolDay: true });
    expect(r.allowLong).toBe(true);
  });

  it("寄り後ウォームアップ中は両方禁止する", () => {
    const long = evaluateRegimeGates({ ...base, slope: 0.001, flow: 1000, inWarmup: true });
    const short = evaluateRegimeGates({ ...base, slope: -0.001, flow: -1000, inWarmup: true });
    expect(long.allowLong).toBe(false);
    expect(short.allowShort).toBe(false);
  });

  it("サーキットブレーカー発動中は両方禁止する", () => {
    const long = evaluateRegimeGates({ ...base, slope: 0.001, flow: 1000, halted: true });
    const short = evaluateRegimeGates({ ...base, slope: -0.001, flow: -1000, halted: true });
    expect(long.allowLong).toBe(false);
    expect(short.allowShort).toBe(false);
  });

  it("トレンドと勢いが矛盾する場合（上昇トレンドだが売り圧力）はロングを許可しない", () => {
    const r = evaluateRegimeGates({ ...base, slope: 0.001, flow: -1000 });
    expect(r.allowLong).toBe(false);
    expect(r.allowShort).toBe(false);
  });

  it("方向感のない（傾きが小さい）相場では両方とも許可しない", () => {
    const r = evaluateRegimeGates({ ...base, slope: 0.0001, flow: 1000 });
    expect(r.allowLong).toBe(false);
    expect(r.allowShort).toBe(false);
  });
});

describe("getLotRatio（銘柄別ロット縮小）", () => {
  it("超ボラ銘柄（ソフトバンクG・第一三共・ソシオネクスト）は極小ロット", () => {
    expect(getLotRatio("9984")).toBe(REGIME_CONSTANTS.LOT_SMALL);
    expect(getLotRatio("4568")).toBe(REGIME_CONSTANTS.LOT_SMALL);
    expect(getLotRatio("6526")).toBe(REGIME_CONSTANTS.LOT_SMALL);
  });

  it("通常銘柄は通常ロット", () => {
    expect(getLotRatio("9107")).toBe(REGIME_CONSTANTS.LOT_NORMAL);
    expect(getLotRatio("8306")).toBe(REGIME_CONSTANTS.LOT_NORMAL);
  });

  it("超ボラ銘柄のロットは通常銘柄より十分小さい", () => {
    expect(getLotRatio("9984")).toBeLessThan(getLotRatio("9107"));
  });
});

describe("REGIME_CONSTANTS（パラメータの妥当性）", () => {
  it("サーキットブレーカーは正の損失額", () => {
    expect(REGIME_CONSTANTS.CIRCUIT_BREAKER).toBeGreaterThan(0);
  });
  it("1銘柄あたりの最大取引回数は制限されている", () => {
    expect(REGIME_CONSTANTS.MAX_TRADES_PER_DAY).toBeGreaterThan(0);
    expect(REGIME_CONSTANTS.MAX_TRADES_PER_DAY).toBeLessThanOrEqual(5);
  });
  it("超高ボラ日の閾値は妥当な範囲（5%〜15%）", () => {
    expect(REGIME_CONSTANTS.HIGH_VOL_DAY_THRESHOLD).toBeGreaterThanOrEqual(0.05);
    expect(REGIME_CONSTANTS.HIGH_VOL_DAY_THRESHOLD).toBeLessThanOrEqual(0.15);
  });
});
