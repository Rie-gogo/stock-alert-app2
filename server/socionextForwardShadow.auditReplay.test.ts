import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applySocionextConfirmationStrengthTransition,
  applySocionextInitialStrengthTransition,
  createEmptySocionextForwardState,
  type SocionextClosedPosition,
  type SocionextForwardVariant,
} from "./socionextForwardShadow";

type CandleTuple = [string, number, number, number, number, number];
type Segment = { tradeDate: string; purpose: string; candles: CandleTuple[] };
type Fixture = { dateCount: number; rowCount: number; segments: Segment[] };

const baselinePath = new URL("./fixtures/socionextConfirmedLong.audit.fixture.json", import.meta.url);
const supplementPath = new URL("./fixtures/socionextConfirmedLong.audit.supplement-20260904.fixture.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Fixture;
const supplementRaw = readFileSync(supplementPath);
const supplement = JSON.parse(supplementRaw.toString("utf8")) as Fixture;

function syntheticTradeDate(index: number) {
  const date = new Date(Date.UTC(2099, 0, index + 1));
  return date.toISOString().slice(0, 10);
}

function replay(segments: Segment[], variant: SocionextForwardVariant) {
  const transition = variant === "initial_strength"
    ? applySocionextInitialStrengthTransition
    : applySocionextConfirmationStrengthTransition;
  const trades: SocionextClosedPosition[] = [];
  let dailyStops = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    let state = createEmptySocionextForwardState(variant);
    const tradeDate = syntheticTradeDate(segmentIndex);
    for (const [candleIndex, candle] of segment.candles.entries()) {
      const [candleTime, open, high, low, close, volume] = candle;
      const result = transition(state, {
        sourceEventId: `${variant}:${segment.tradeDate}:${candleIndex}`,
        candle: { symbol: "6526", tradeDate, candleTime, open, high, low, close, volume },
        board: null,
      }, "signal_quality");
      if (result.actions.some(action => action.type === "initial_strength_daily_stop" || action.type === "confirmation_strength_daily_stop")) {
        dailyStops += 1;
      }
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
    dailyStops,
  };
}

describe("6526 A/B Git-fixed 51-day replay", () => {
  it("追加5日fixtureの出典境界・日付・1,676足・ファイルSHAを固定する", () => {
    expect(supplement).toMatchObject({
      source: "production_rt_candles_saved_kabu_station_one_minute_supplement",
      symbol: "6526",
      throughDate: "2026-09-04",
      dateCount: 5,
      rowCount: 1676,
    });
    expect(supplement.segments.map(segment => segment.tradeDate)).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
    ]);
    expect(createHash("sha256").update(supplementRaw).digest("hex"))
      .toBe("ded0658bef7779e4b57d50eb856488b5582c17c6c901f243bf2bed03f1614995");
  });

  it("46日fixtureでA/Bとも14件11勝3敗を再現する", () => {
    expect(replay(baseline.segments, "initial_strength")).toMatchObject({ trades: 14, wins: 11, losses: 3 });
    expect(replay(baseline.segments, "confirmation_strength")).toMatchObject({ trades: 14, wins: 11, losses: 3 });
  });

  it("追加5日込み51日でA=16件11勝5敗、B=15件11勝4敗を再現する", () => {
    const combined = [...baseline.segments, ...supplement.segments];
    expect(replay(combined, "initial_strength")).toMatchObject({ trades: 16, wins: 11, losses: 5, dailyStops: 7 });
    expect(replay(combined, "confirmation_strength")).toMatchObject({ trades: 15, wins: 11, losses: 4, dailyStops: 7 });
  });

  it("追加5日だけではA=2敗、B=1敗で、選定用データを正式未見成績へ混ぜない", () => {
    expect(replay(supplement.segments, "initial_strength")).toMatchObject({ trades: 2, wins: 0, losses: 2 });
    expect(replay(supplement.segments, "confirmation_strength")).toMatchObject({ trades: 1, wins: 0, losses: 1 });
  });
});
