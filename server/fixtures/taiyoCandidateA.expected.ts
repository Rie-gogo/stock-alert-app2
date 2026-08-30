export interface TaiyoCandidateAExpectedTrade {
  date: string;
  route: "primary" | "fallback_short";
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitAction: "exit" | "stop_loss" | "take_profit";
  exitReason: string;
  pnlPer100: number;
}

export const TAIYO_CANDIDATE_A_EXPECTED_TRADES: readonly TaiyoCandidateAExpectedTrade[] = Object.freeze([
  { date: "2026-06-25", route: "fallback_short", side: "short", entryTime: "12:58", entryPrice: 18745, exitTime: "13:12", exitAction: "take_profit", exitReason: "利確 (利確ライン:18520円)", pnlPer100: 22494 },
  { date: "2026-06-26", route: "fallback_short", side: "short", entryTime: "10:33", entryPrice: 17055, exitTime: "10:58", exitAction: "take_profit", exitReason: "利確 (利確ライン:16799円)", pnlPer100: 25583 },
  { date: "2026-06-29", route: "primary", side: "long", entryTime: "09:59", entryPrice: 18305, exitTime: "10:04", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 3000 },
  { date: "2026-06-30", route: "primary", side: "long", entryTime: "10:14", entryPrice: 19915, exitTime: "10:16", exitAction: "take_profit", exitReason: "利確 (利確ライン:20134円)", pnlPer100: 21906 },
  { date: "2026-07-03", route: "primary", side: "long", entryTime: "10:03", entryPrice: 19300, exitTime: "10:08", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 12000 },
  { date: "2026-07-06", route: "primary", side: "short", entryTime: "10:04", entryPrice: 19070, exitTime: "10:08", exitAction: "stop_loss", exitReason: "損切り (損切りライン:19223円)", pnlPer100: -15256 },
  { date: "2026-07-07", route: "primary", side: "short", entryTime: "10:25", entryPrice: 16705, exitTime: "10:27", exitAction: "take_profit", exitReason: "利確 (利確ライン:16521円)", pnlPer100: 18376 },
  { date: "2026-07-09", route: "primary", side: "short", entryTime: "09:53", entryPrice: 15010, exitTime: "09:58", exitAction: "take_profit", exitReason: "利確 (利確ライン:14845円)", pnlPer100: 16511 },
  { date: "2026-07-13", route: "fallback_short", side: "short", entryTime: "10:38", entryPrice: 13030, exitTime: "10:47", exitAction: "take_profit", exitReason: "利確 (利確ライン:12835円)", pnlPer100: 19545 },
  { date: "2026-07-27", route: "fallback_short", side: "short", entryTime: "11:10", entryPrice: 11170, exitTime: "11:27", exitAction: "exit", exitReason: "前場強制決済", pnlPer100: -3500 },
  { date: "2026-07-30", route: "fallback_short", side: "short", entryTime: "12:59", entryPrice: 8959, exitTime: "13:14", exitAction: "take_profit", exitReason: "利確 (利確ライン:8851円)", pnlPer100: 10750.67 },
  { date: "2026-08-03", route: "primary", side: "short", entryTime: "10:16", entryPrice: 9768, exitTime: "10:21", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 600 },
  { date: "2026-08-06", route: "primary", side: "short", entryTime: "10:28", entryPrice: 9909, exitTime: "10:33", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 3300 },
  { date: "2026-08-07", route: "primary", side: "short", entryTime: "10:21", entryPrice: 9469, exitTime: "10:26", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: -1400 },
  { date: "2026-08-13", route: "primary", side: "long", entryTime: "09:53", entryPrice: 11265, exitTime: "09:58", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 3500 },
  { date: "2026-08-14", route: "primary", side: "short", entryTime: "10:02", entryPrice: 10810, exitTime: "10:07", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 500 },
  { date: "2026-08-18", route: "primary", side: "short", entryTime: "09:59", entryPrice: 11000, exitTime: "10:02", exitAction: "take_profit", exitReason: "利確 (利確ライン:10879円)", pnlPer100: 12100 },
  { date: "2026-08-19", route: "primary", side: "long", entryTime: "10:06", entryPrice: 9859, exitTime: "10:11", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: -7000 },
  { date: "2026-08-26", route: "primary", side: "short", entryTime: "09:52", entryPrice: 8816, exitTime: "09:57", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 2200 },
  { date: "2026-08-27", route: "primary", side: "short", entryTime: "09:50", entryPrice: 8703, exitTime: "09:55", exitAction: "exit", exitReason: "候補A最大保有5分境界の確定足終値決済", pnlPer100: 2100 },
  { date: "2026-08-28", route: "primary", side: "long", entryTime: "10:12", entryPrice: 9258, exitTime: "10:17", exitAction: "take_profit", exitReason: "利確 (利確ライン:9360円)", pnlPer100: 10184 },
]);

export interface TaiyoCandidateAExpectedBoardRejection {
  date: string;
  time: string;
  side: "long" | "short";
  code: "board_missing" | "board_bpr" | "board_signal";
  detail: string;
}

/** 初動価格・足色・MA8方向・出来高を通過し、初動足の板条件だけで拒否された全候補。 */
export const TAIYO_CANDIDATE_A_EXPECTED_BOARD_REJECTIONS: readonly TaiyoCandidateAExpectedBoardRejection[] = Object.freeze([
  { date: "2026-06-25", time: "09:51", side: "long", code: "board_bpr", detail: "BPR=0.730" },
  { date: "2026-06-26", time: "10:12", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-06-29", time: "09:48", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-06-29", time: "09:56", side: "long", code: "board_bpr", detail: "BPR=0.790" },
  { date: "2026-06-30", time: "09:46", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-06-30", time: "09:49", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-06-30", time: "09:52", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-06-30", time: "09:59", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-06-30", time: "10:12", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-07-01", time: "10:14", side: "short", code: "board_signal", detail: "signal=buy_pressure,marketOrderDirection=neutral" },
  { date: "2026-07-01", time: "10:16", side: "short", code: "board_signal", detail: "signal=buy_pressure,marketOrderDirection=neutral" },
  { date: "2026-07-02", time: "10:26", side: "long", code: "board_missing", detail: "boardSnapshot=null" },
  { date: "2026-07-06", time: "09:48", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-07-07", time: "09:48", side: "long", code: "board_bpr", detail: "BPR=0.690" },
  { date: "2026-07-09", time: "09:45", side: "long", code: "board_bpr", detail: "BPR=0.730" },
  { date: "2026-07-21", time: "10:15", side: "long", code: "board_bpr", detail: "BPR=0.780" },
  { date: "2026-07-21", time: "10:16", side: "long", code: "board_bpr", detail: "BPR=0.760" },
  { date: "2026-07-23", time: "10:26", side: "long", code: "board_bpr", detail: "BPR=0.740" },
  { date: "2026-08-06", time: "10:10", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
]);

export const TAIYO_CANDIDATE_A_EXPECTED_SUMMARY = Object.freeze({
  dates: 46,
  rows: 14_719,
  trades: 21,
  primaryTrades: 16,
  fallbackShortTrades: 5,
  wins: 17,
  losses: 4,
  winRatePct: 80.95,
  pnlPer100: 157493.67,
  boardRejectedTriggers: 19,
  recentFiveDates: Object.freeze(["2026-08-20", "2026-08-21", "2026-08-26", "2026-08-27", "2026-08-28"]),
  recentFiveTrades: 3,
  recentFiveWins: 3,
  recentFiveLosses: 0,
});

/** 各取引の100株損益から entryPrice × adversePct を一律控除する片道総悪化モデル。 */
export const TAIYO_CANDIDATE_A_SLIPPAGE_EXPECTATIONS = Object.freeze({
  definition: "pnlPer100 - entryPrice * adversePct",
  adverse005Pct: Object.freeze({ wins: 16, losses: 5, winRatePct: 76.19, pnlPer100: 143687.62 }),
  adverse010Pct: Object.freeze({ wins: 15, losses: 6, winRatePct: 71.43, pnlPer100: 129881.57 }),
});

export const TAIYO_CANDIDATE_A_PORTFOLIO_SOURCE_EXPECTATIONS = Object.freeze({
  order: "tradeDate_then_saved_id",
  processedRows: 93_072,
  baseline: Object.freeze({
    trades: 211,
    wins: 166,
    losses: 45,
    pnl: 4_127_147,
    bySymbol: Object.freeze({
      "285A": Object.freeze({ trades: 57, wins: 43, losses: 14, pnl: 1_788_323 }),
      "8035": Object.freeze({ trades: 30, wins: 23, losses: 7, pnl: 435_785 }),
      "5803": Object.freeze({ trades: 42, wins: 31, losses: 11, pnl: 475_575 }),
      "6981": Object.freeze({ trades: 23, wins: 19, losses: 4, pnl: 291_861 }),
      "6976": Object.freeze({ trades: 29, wins: 26, losses: 3, pnl: 266_590 }),
      "6857": Object.freeze({ trades: 19, wins: 16, losses: 3, pnl: 383_532 }),
      "6146": Object.freeze({ trades: 11, wins: 8, losses: 3, pnl: 485_481 }),
    }),
  }),
  candidate: Object.freeze({
    trades: 202,
    wins: 156,
    losses: 46,
    pnl: 3_993_425,
    bySymbol: Object.freeze({
      "285A": Object.freeze({ trades: 57, wins: 42, losses: 15, pnl: 1_664_917 }),
      "8035": Object.freeze({ trades: 31, wins: 24, losses: 7, pnl: 474_560 }),
      "5803": Object.freeze({ trades: 42, wins: 32, losses: 10, pnl: 497_915 }),
      "6981": Object.freeze({ trades: 23, wins: 19, losses: 4, pnl: 291_861 }),
      "6976": Object.freeze({ trades: 19, wins: 15, losses: 4, pnl: 195_159 }),
      "6857": Object.freeze({ trades: 19, wins: 16, losses: 3, pnl: 383_532 }),
      "6146": Object.freeze({ trades: 11, wins: 8, losses: 3, pnl: 485_481 }),
    }),
  }),
  delta: Object.freeze({ trades: -9, wins: -10, losses: 1, pnl: -133_722 }),
});

export const TAIYO_CANDIDATE_A_FIXTURE_SHA256 = "8ba72c0fbdb043135bf3c8677e82a2205a6b1f644c958e0d49ac7e6cda3c244e";
