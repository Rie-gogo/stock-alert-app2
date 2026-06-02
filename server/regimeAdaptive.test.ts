import { describe, it, expect } from "vitest";
import {
  evaluateRegimeGates,
  getLotRatio,
  REGIME_CONSTANTS,
  computeMarketEfficiency,
  isRangeBoundDay,
} from "./realSimulation";

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
  it("超ボラ/低相性銘柄（ソフトバンクG・第一三共・ソシオネクスト・川崎汽船）は極小ロット", () => {
    expect(getLotRatio("9984")).toBe(REGIME_CONSTANTS.LOT_SMALL);
    expect(getLotRatio("4568")).toBe(REGIME_CONSTANTS.LOT_SMALL);
    expect(getLotRatio("6526")).toBe(REGIME_CONSTANTS.LOT_SMALL);
  });

  it("川崎汽船(9107)はトレンド系ロジックと相性が悪いため最小ロットで監視継続する", () => {
    // 出来高重視の方針により除外せず、ロットを極小にして損失を抑える
    expect(getLotRatio("9107")).toBe(REGIME_CONSTANTS.LOT_SMALL);
  });

  it("通常銘柄は通常ロット", () => {
    expect(getLotRatio("8306")).toBe(REGIME_CONSTANTS.LOT_NORMAL);
  });

  it("極小ロット銘柄のロットは通常銘柄より十分小さい", () => {
    expect(getLotRatio("9984")).toBeLessThan(getLotRatio("8306"));
  });
});

describe("computeMarketEfficiency / isRangeBoundDay（レンジ回避フィルター）", () => {
  it("一方向にトレンドした日は効率が高くレンジと見なされない", () => {
    // 寄り100、高値110、安値100、引け110：値幅の全てが上げに使われた（効率1.0）
    const eff = computeMarketEfficiency([
      { open: 100, high: 110, low: 100, close: 110 },
      { open: 200, high: 220, low: 200, close: 220 },
    ]);
    expect(eff).toBeCloseTo(1, 5);
    expect(isRangeBoundDay(eff)).toBe(false);
  });

  it("大きく往復して始値近くに戻った日は効率が低くレンジと判定される", () => {
    // 寄り100、高値110、安傐90、引け101：値幅20%だが純変厖1%→効率0.05
    const eff = computeMarketEfficiency([
      { open: 100, high: 110, low: 90, close: 101 },
    ]);
    expect(eff).toBeLessThan(REGIME_CONSTANTS.RANGE_EFFICIENCY_THRESHOLD);
    expect(isRangeBoundDay(eff)).toBe(true);
  });

  it("閾値を0.30として境界を正しく判定する", () => {
    expect(REGIME_CONSTANTS.RANGE_EFFICIENCY_THRESHOLD).toBe(0.3);
    expect(isRangeBoundDay(0.29)).toBe(true);
    expect(isRangeBoundDay(0.31)).toBe(false);
  });

  it("データが空のときは効率1（レンジでない）を返し誤った取引停止を防ぐ", () => {
    expect(computeMarketEfficiency([])).toBe(1);
    expect(isRangeBoundDay(computeMarketEfficiency([]))).toBe(false);
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
