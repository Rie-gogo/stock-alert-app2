import { describe, expect, it } from "vitest";
import {
  KIOXIA_CONFIRMED_MORNING_LONG_REASON_PREFIX,
  KIOXIA_CONFIRMED_MORNING_LONG_SPEC,
  calculateKioxiaConfirmedMorningLongMetrics,
  evaluateKioxiaConfirmedMorningLongOrderApproval,
  isKioxiaConfirmedMorningLongEntryTime,
  type KioxiaConfirmedMorningLongCandle,
} from "./kioxiaConfirmedMorningLong";

function buildBuffer(options: {
  bodyPct?: number;
  volumeRatio?: number;
  openGainPct?: number;
  maSlopeStep?: number;
} = {}): KioxiaConfirmedMorningLongCandle[] {
  const bodyPct = options.bodyPct ?? 0.21;
  const volumeRatio = options.volumeRatio ?? 1.21;
  const openGainPct = options.openGainPct ?? 0.51;
  const maSlopeStep = options.maSlopeStep ?? 0.02;
  const baseOpen = 100;
  const rows: KioxiaConfirmedMorningLongCandle[] = [];
  for (let index = 0; index < 20; index += 1) {
    const close = 100 + index * maSlopeStep;
    rows.push({ time: `09:${String(25 + index).padStart(2, "0")}`, open: close, high: close + 0.01, low: close - 0.01, close, volume: 100 });
  }
  const close = baseOpen * (1 + openGainPct / 100);
  const open = close / (1 + bodyPct / 100);
  rows.push({ time: "09:45", open, high: close + 0.01, low: open - 0.01, close, volume: 100 * volumeRatio });
  return rows;
}

describe("285A確認型前場LONG純粋仕様", () => {
  it("設定TP1.6%はSL0.8%の2倍で、LIVEは未承認", () => {
    expect(KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.tpPct).toBe(KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.slPct * 2);
    expect(KIOXIA_CONFIRMED_MORNING_LONG_SPEC.liveOrderApproved).toBe(false);
    expect(KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.nextCandleConfirmation).toBe(false);
  });

  it("09:45と11:20を含み、09:44と11:21を除外する", () => {
    expect(isKioxiaConfirmedMorningLongEntryTime("09:44")).toBe(false);
    expect(isKioxiaConfirmedMorningLongEntryTime("09:45")).toBe(true);
    expect(isKioxiaConfirmedMorningLongEntryTime("11:20")).toBe(true);
    expect(isKioxiaConfirmedMorningLongEntryTime("11:21")).toBe(false);
  });

  it("中心値の終値高値更新・実体・MA・出来高・始値比をすべて満たす", () => {
    expect(calculateKioxiaConfirmedMorningLongMetrics(buildBuffer())?.eligible).toBe(true);
  });

  it.each([
    ["実体", { bodyPct: 0.19 }],
    ["出来高", { volumeRatio: 1.19 }],
    ["始値比", { openGainPct: 0.49 }],
  ])("%sが閾値未満なら候補外", (_label, options) => {
    expect(calculateKioxiaConfirmedMorningLongMetrics(buildBuffer(options))?.eligible).toBe(false);
  });

  it("10本高値更新でもMA8二本傾きが負なら候補外", () => {
    const buffer: KioxiaConfirmedMorningLongCandle[] = [];
    for (let index = 0; index < 21; index += 1) {
      let close = 100.2;
      if (index === 0) close = 100;
      if (index === 11 || index === 12) close = 100.5;
      if (index === 19) close = 99;
      if (index === 20) close = 100.6;
      buffer.push({
        time: index === 20 ? "09:45" : `09:${String(24 + index).padStart(2, "0")}`,
        open: index === 20 ? 100.3 : close,
        high: close + 0.01,
        low: (index === 20 ? 100.3 : close) - 0.01,
        close,
        volume: index === 20 ? 121 : 100,
      });
    }
    const metrics = calculateKioxiaConfirmedMorningLongMetrics(buffer);
    expect(metrics?.closeBreaksHigh).toBe(true);
    expect(metrics?.maSlope2Pct).toBeLessThan(0);
    expect(metrics?.eligible).toBe(false);
  });

  it("LIVE新規entryだけを拒否し、DRY_RUNと決済を許可する", () => {
    const reason = `${KIOXIA_CONFIRMED_MORNING_LONG_REASON_PREFIX}: テスト`;
    expect(evaluateKioxiaConfirmedMorningLongOrderApproval({ reason, instructionType: "entry", isDryRun: false }))
      .toEqual({ allowed: false, code: "kioxia_confirmed_morning_long_live_not_approved" });
    expect(evaluateKioxiaConfirmedMorningLongOrderApproval({ reason, instructionType: "entry", isDryRun: true }))
      .toEqual({ allowed: true });
    expect(evaluateKioxiaConfirmedMorningLongOrderApproval({ reason, instructionType: "exit", isDryRun: false }))
      .toEqual({ allowed: true });
  });
});
