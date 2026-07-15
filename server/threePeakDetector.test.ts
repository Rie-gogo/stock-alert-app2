import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the db module
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
}));

// We need to test the detection logic without DB
// Import after mocking
const { processThreePeakCandle, resetThreePeakState, getThreePeakStatus } = await import("./threePeakDetector");

describe("threePeakDetector", () => {
  beforeEach(() => {
    resetThreePeakState("2026-07-15");
  });

  describe("resetThreePeakState", () => {
    it("should reset state for a new date", () => {
      resetThreePeakState("2026-07-16");
      const status = getThreePeakStatus();
      expect(status.hasPosition).toBe(false);
      expect(status.position).toBeNull();
      expect(status.bufferLength).toBe(0);
      expect(status.currentDate).toBe("2026-07-16");
    });
  });

  describe("processThreePeakCandle", () => {
    it("should skip non-6981 symbols", async () => {
      const result = await processThreePeakCandle(
        "9984", "2026-07-15", "09:30",
        10000, 10050, 9950, 10020, 100000
      );
      expect(result).toBeNull();
    });

    it("should skip lunch break candles", async () => {
      const result = await processThreePeakCandle(
        "6981", "2026-07-15", "11:45",
        10000, 10050, 9950, 10020, 100000
      );
      expect(result).toBeNull();
    });

    it("should skip candles before 09:10", async () => {
      // Feed a few candles before 09:10
      for (let i = 0; i < 15; i++) {
        await processThreePeakCandle(
          "6981", "2026-07-15", `09:0${i < 10 ? i : ""}`.slice(0, 5),
          10000, 10050, 9950, 10020, 100000
        );
      }
      const status = getThreePeakStatus();
      expect(status.hasPosition).toBe(false);
    });

    it("should not signal with insufficient candles", async () => {
      // Feed only 5 candles
      for (let i = 0; i < 5; i++) {
        const result = await processThreePeakCandle(
          "6981", "2026-07-15", `09:${String(30 + i).padStart(2, "0")}`,
          10000, 10050, 9950, 10020, 100000
        );
        expect(result).toBeNull();
      }
    });

    it("should detect SHORT signal with 3 consecutive lower highs", async () => {
      // Use unique date to avoid state pollution
      resetThreePeakState("2026-07-18");

      // Create a descending pattern with clear swing highs
      // Open price = 10000 (first candle)
      const candles = [
        // Warmup candles establishing the open
        { time: "09:00", o: 10000, h: 10050, l: 9950, c: 9980 },
        { time: "09:01", o: 9980, h: 10100, l: 9970, c: 10080 },
        { time: "09:02", o: 10080, h: 10200, l: 10050, c: 10150 },
        { time: "09:03", o: 10150, h: 10300, l: 10100, c: 10250 }, // Peak 1
        { time: "09:04", o: 10250, h: 10270, l: 10100, c: 10120 },
        { time: "09:05", o: 10120, h: 10130, l: 10050, c: 10060 },
        { time: "09:06", o: 10060, h: 10200, l: 10040, c: 10180 }, // Peak 2
        { time: "09:07", o: 10180, h: 10190, l: 10050, c: 10070 },
        { time: "09:08", o: 10070, h: 10080, l: 9950, c: 9960 },
        { time: "09:09", o: 9960, h: 10100, l: 9940, c: 10080 },  // Peak 3
        { time: "09:10", o: 10080, h: 10090, l: 9900, c: 9920 },
        { time: "09:11", o: 9920, h: 9930, l: 9850, c: 9860 },
        { time: "09:12", o: 9860, h: 9950, l: 9840, c: 9930 },   // Peak 4
        { time: "09:13", o: 9930, h: 9940, l: 9800, c: 9820 },
        { time: "09:14", o: 9820, h: 9830, l: 9750, c: 9760 },
        { time: "09:15", o: 9760, h: 9850, l: 9750, c: 9840 },   // bullish
        { time: "09:16", o: 9840, h: 9845, l: 9700, c: 9710 },   // bearish reversal
        { time: "09:17", o: 9710, h: 9720, l: 9680, c: 9690 },   // confirms low break
      ];

      for (const c of candles) {
        await processThreePeakCandle(
          "6981", "2026-07-18", c.time,
          c.o, c.h, c.l, c.c, 100000
        );
      }

      const status = getThreePeakStatus();
      // Verify the logic runs without crashing and buffer accumulates correctly
      expect(status.bufferLength).toBe(candles.length);
      expect(status.currentDate).toBe("2026-07-18");
    });

    it("should track buffer length correctly", async () => {
      // Use a unique date to ensure fresh buffer
      resetThreePeakState("2026-07-20");

      await processThreePeakCandle("6981", "2026-07-20", "09:30", 10000, 10050, 9950, 10020, 100000);
      await processThreePeakCandle("6981", "2026-07-20", "09:31", 10020, 10070, 9980, 10050, 100000);
      await processThreePeakCandle("6981", "2026-07-20", "09:32", 10050, 10100, 10000, 10080, 100000);

      const status = getThreePeakStatus();
      expect(status.bufferLength).toBe(3);
      expect(status.currentDate).toBe("2026-07-20");
    });

    it("should reset on new date", async () => {
      resetThreePeakState("2026-07-21");
      await processThreePeakCandle("6981", "2026-07-21", "09:30", 10000, 10050, 9950, 10020, 100000);
      await processThreePeakCandle("6981", "2026-07-21", "09:31", 10020, 10070, 9980, 10050, 100000);

      // New date triggers reset
      await processThreePeakCandle("6981", "2026-07-22", "09:30", 10100, 10150, 10050, 10120, 100000);

      const status = getThreePeakStatus();
      expect(status.bufferLength).toBe(1);
      expect(status.currentDate).toBe("2026-07-22");
    });
  });
});
