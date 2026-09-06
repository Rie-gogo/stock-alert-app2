import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applySumcoTime15Transition,
  applySumcoVolume110Transition,
  createEmptySumcoForwardState,
  type SumcoClosedPosition,
  type SumcoForwardVariant,
} from "./sumcoForwardShadow";

type CandleTuple = [string, number, number, number, number, number];
type Segment = { tradeDate: string; purpose: string; candles: CandleTuple[] };
type Fixture = { symbol: string; dateCount: number; rowCount: number; segments: Segment[] };

const baselinePath = new URL("./fixtures/sumcoBreakdownShort.audit.fixture.json", import.meta.url);
const supplementPath = new URL("./fixtures/sumcoBreakdownShort.audit.supplement-20260904.fixture.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Fixture;
const supplementRaw = readFileSync(supplementPath);
const supplement = JSON.parse(supplementRaw.toString("utf8")) as Fixture & {
  learningCutoffDate: string;
  knownGap: Record<string, unknown>;
};

function syntheticTradeDate(index: number) {
  const date = new Date(Date.UTC(2099, 0, index + 1));
  return date.toISOString().slice(0, 10);
}

function replay(segments: Segment[], variant: SumcoForwardVariant) {
  const transition = variant === "volume_110" ? applySumcoVolume110Transition : applySumcoTime15Transition;
  const trades: SumcoClosedPosition[] = [];
  let volumeRejections = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    let state = createEmptySumcoForwardState(variant);
    const tradeDate = syntheticTradeDate(segmentIndex);
    for (const [candleIndex, candle] of segment.candles.entries()) {
      const [candleTime, open, high, low, close, volume] = candle;
      const result = transition(state, {
        sourceEventId: `${variant}:${segment.tradeDate}:${candleIndex}`,
        candle: { symbol: "3436", tradeDate, candleTime, open, high, low, close, volume },
        board: null,
      }, "signal_quality");
      if (result.actions.some(action => action.type === "volume_filter_rejected")) volumeRejections += 1;
      if (result.closedPosition) trades.push(result.closedPosition);
      state = result.nextState;
    }
  }
  return {
    trades: trades.length,
    wins: trades.filter(trade => trade.pnl > 0).length,
    losses: trades.filter(trade => trade.pnl < 0).length,
    pnl: trades.reduce((sum, trade) => sum + trade.pnl, 0),
    pnlAfterAdverseExit: trades.reduce((sum, trade) => sum + trade.pnlAfterAdverseExit, 0),
    volumeRejections,
  };
}

describe("3436 VOLUME110/TIME15 Git-fixed 34-day replay", () => {
  it("追加5日fixtureの出典境界・日付・1,667足・SHA・8/31既知欠損を固定する", () => {
    expect(supplement).toMatchObject({
      symbol: "3436",
      learningCutoffDate: "2026-09-04",
      dateCount: 5,
      rowCount: 1667,
      knownGap: { tradeDate: "2026-08-31", expectedRows: 330, actualRows: 329 },
    });
    expect(supplement.segments.map(segment => segment.tradeDate)).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
    ]);
    expect(createHash("sha256").update(supplementRaw).digest("hex"))
      .toBe("16f9be167ab078f55272d01768346d8ed500ff0ab93b04fd358cafe162c59bd5");
  });

  it("29日fixtureでVOLUME110=21件17勝4敗、TIME15=22件17勝5敗を再現する", () => {
    expect(replay(baseline.segments, "volume_110")).toMatchObject({ trades: 21, wins: 17, losses: 4 });
    expect(replay(baseline.segments, "time_15")).toMatchObject({ trades: 22, wins: 17, losses: 5 });
  });

  it("追加5日込み34日でVOLUME110=25件19勝6敗、TIME15=26件19勝7敗を再現する", () => {
    const combined = [...baseline.segments, ...supplement.segments];
    expect(replay(combined, "volume_110")).toMatchObject({ trades: 25, wins: 19, losses: 6 });
    expect(replay(combined, "time_15")).toMatchObject({ trades: 26, wins: 19, losses: 7 });
  });

  it("追加5日は双方4件2勝2敗で選定用データを正式未見成績へ混ぜない", () => {
    expect(replay(supplement.segments, "volume_110")).toMatchObject({ trades: 4, wins: 2, losses: 2 });
    expect(replay(supplement.segments, "time_15")).toMatchObject({ trades: 4, wins: 2, losses: 2 });
  });
});
