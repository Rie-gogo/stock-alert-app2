export interface TaiyoCandidateAExpectedTrade {
  date: string;
  route: "primary" | "fallback_short";
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitAction: "exit" | "stop_loss" | "take_profit";
  pnlPer100: number;
}

export const TAIYO_CANDIDATE_A_EXPECTED_TRADES: readonly TaiyoCandidateAExpectedTrade[] = Object.freeze([
  { date: "2026-06-25", route: "fallback_short", side: "short", entryTime: "12:58", entryPrice: 18745, exitTime: "13:12", exitAction: "take_profit", pnlPer100: 22494 },
  { date: "2026-06-26", route: "fallback_short", side: "short", entryTime: "10:33", entryPrice: 17055, exitTime: "10:58", exitAction: "take_profit", pnlPer100: 25583 },
  { date: "2026-06-29", route: "primary", side: "long", entryTime: "09:59", entryPrice: 18305, exitTime: "10:05", exitAction: "exit", pnlPer100: 2500 },
  { date: "2026-06-30", route: "primary", side: "long", entryTime: "10:14", entryPrice: 19915, exitTime: "10:16", exitAction: "take_profit", pnlPer100: 21906 },
  { date: "2026-07-03", route: "primary", side: "long", entryTime: "10:03", entryPrice: 19300, exitTime: "10:09", exitAction: "exit", pnlPer100: 12000 },
  { date: "2026-07-06", route: "primary", side: "short", entryTime: "10:04", entryPrice: 19070, exitTime: "10:08", exitAction: "stop_loss", pnlPer100: -15256 },
  { date: "2026-07-07", route: "primary", side: "short", entryTime: "10:25", entryPrice: 16705, exitTime: "10:27", exitAction: "take_profit", pnlPer100: 18376 },
  { date: "2026-07-09", route: "primary", side: "short", entryTime: "09:53", entryPrice: 15010, exitTime: "09:58", exitAction: "take_profit", pnlPer100: 16511 },
  { date: "2026-07-13", route: "fallback_short", side: "short", entryTime: "10:38", entryPrice: 13030, exitTime: "10:47", exitAction: "take_profit", pnlPer100: 19545 },
  { date: "2026-07-27", route: "fallback_short", side: "short", entryTime: "11:10", entryPrice: 11170, exitTime: "11:27", exitAction: "exit", pnlPer100: -3500 },
  { date: "2026-07-30", route: "fallback_short", side: "short", entryTime: "12:59", entryPrice: 8959, exitTime: "13:14", exitAction: "take_profit", pnlPer100: 10750.67 },
  { date: "2026-08-03", route: "primary", side: "short", entryTime: "10:16", entryPrice: 9768, exitTime: "10:22", exitAction: "exit", pnlPer100: 600 },
  { date: "2026-08-06", route: "primary", side: "short", entryTime: "10:28", entryPrice: 9909, exitTime: "10:34", exitAction: "take_profit", pnlPer100: 10900 },
  { date: "2026-08-07", route: "primary", side: "short", entryTime: "10:21", entryPrice: 9469, exitTime: "10:27", exitAction: "exit", pnlPer100: -1400 },
  { date: "2026-08-13", route: "primary", side: "long", entryTime: "09:53", entryPrice: 11265, exitTime: "09:59", exitAction: "exit", pnlPer100: 3500 },
  { date: "2026-08-14", route: "primary", side: "short", entryTime: "10:02", entryPrice: 10810, exitTime: "10:08", exitAction: "exit", pnlPer100: 500 },
  { date: "2026-08-18", route: "primary", side: "short", entryTime: "09:59", entryPrice: 11000, exitTime: "10:02", exitAction: "take_profit", pnlPer100: 12100 },
  { date: "2026-08-19", route: "primary", side: "long", entryTime: "10:06", entryPrice: 9859, exitTime: "10:12", exitAction: "stop_loss", pnlPer100: -7887 },
  { date: "2026-08-26", route: "primary", side: "short", entryTime: "09:52", entryPrice: 8816, exitTime: "09:58", exitAction: "exit", pnlPer100: 2200 },
  { date: "2026-08-27", route: "primary", side: "short", entryTime: "09:50", entryPrice: 8703, exitTime: "09:56", exitAction: "exit", pnlPer100: 2100 },
  { date: "2026-08-28", route: "primary", side: "long", entryTime: "10:12", entryPrice: 9258, exitTime: "10:17", exitAction: "take_profit", pnlPer100: 10184 },
]);

export interface TaiyoCandidateAExpectedBoardRejection {
  date: string;
  time: string;
  side: "long" | "short";
  code: "board_bpr" | "board_signal";
  detail: string;
}

/**
 * 5本終値ブレイク・足色・MA8方向・出来高1.0倍を満たしたが、初動足のloose板条件だけで拒否された全候補。
 * 確認足まで到達していないため、反実仮想の「取引」ではなく初動候補として監査する。
 */
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
  { date: "2026-07-06", time: "09:48", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
  { date: "2026-07-07", time: "09:48", side: "long", code: "board_bpr", detail: "BPR=0.690" },
  { date: "2026-07-09", time: "09:45", side: "long", code: "board_bpr", detail: "BPR=0.730" },
  { date: "2026-07-21", time: "10:15", side: "long", code: "board_bpr", detail: "BPR=0.780" },
  { date: "2026-07-21", time: "10:16", side: "long", code: "board_bpr", detail: "BPR=0.760" },
  { date: "2026-07-23", time: "10:26", side: "long", code: "board_bpr", detail: "BPR=0.740" },
  { date: "2026-08-06", time: "10:10", side: "long", code: "board_signal", detail: "signal=sell_pressure,marketOrderDirection=neutral" },
]);

export const TAIYO_CANDIDATE_A_EXPECTED_SUMMARY = Object.freeze({
  trades: 21,
  primaryTrades: 16,
  fallbackShortTrades: 5,
  wins: 17,
  losses: 4,
  winRatePct: 80.95,
  pnlPer100: 163706.67,
  boardRejectedTriggers: 18,
  recentFiveDates: Object.freeze(["2026-08-20", "2026-08-21", "2026-08-26", "2026-08-27", "2026-08-28"]),
  recentFiveTrades: 3,
  recentFiveWins: 3,
  recentFiveLosses: 0,
});
