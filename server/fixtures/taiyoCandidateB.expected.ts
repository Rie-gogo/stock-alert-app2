export interface TaiyoCandidateBExpectedTrade {
  date: string;
  route: "primary" | "afternoon_short";
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitAction: "exit" | "stop_loss" | "take_profit";
  exitReason: string;
  pnlPer100: number;
}

export const TAIYO_CANDIDATE_B_EXPECTED_TRADES: readonly TaiyoCandidateBExpectedTrade[] = Object.freeze([
  { date: "2026-06-25", route: "afternoon_short", side: "short", entryTime: "12:58", entryPrice: 18745, exitTime: "13:12", exitAction: "take_profit", exitReason: "利確 (利確ライン:18520円)", pnlPer100: 22494 },
  { date: "2026-06-26", route: "primary", side: "short", entryTime: "10:30", entryPrice: 17180, exitTime: "10:32", exitAction: "take_profit", exitReason: "利確 (利確ライン:17077円)", pnlPer100: 10308 },
  { date: "2026-06-29", route: "primary", side: "long", entryTime: "09:57", entryPrice: 18105, exitTime: "09:58", exitAction: "take_profit", exitReason: "利確 (利確ライン:18214円)", pnlPer100: 10863 },
  { date: "2026-06-29", route: "afternoon_short", side: "short", entryTime: "13:19", entryPrice: 18205, exitTime: "13:42", exitAction: "take_profit", exitReason: "利確 (利確ライン:17987円)", pnlPer100: 21846 },
  { date: "2026-06-30", route: "primary", side: "long", entryTime: "09:50", entryPrice: 19325, exitTime: "09:52", exitAction: "take_profit", exitReason: "利確 (利確ライン:19441円)", pnlPer100: 11595 },
  { date: "2026-07-01", route: "primary", side: "long", entryTime: "10:57", entryPrice: 23190, exitTime: "11:01", exitAction: "stop_loss", exitReason: "損切り (損切りライン:22958円)", pnlPer100: -23190 },
  { date: "2026-07-03", route: "primary", side: "long", entryTime: "10:03", entryPrice: 19300, exitTime: "10:04", exitAction: "take_profit", exitReason: "利確 (利確ライン:19416円)", pnlPer100: 11580 },
  { date: "2026-07-06", route: "primary", side: "short", entryTime: "10:04", entryPrice: 19070, exitTime: "10:08", exitAction: "stop_loss", exitReason: "損切り (損切りライン:19261円)", pnlPer100: -19070 },
  { date: "2026-07-07", route: "primary", side: "short", entryTime: "09:58", entryPrice: 17275, exitTime: "09:59", exitAction: "take_profit", exitReason: "利確 (利確ライン:17171円)", pnlPer100: 10365 },
  { date: "2026-07-08", route: "primary", side: "short", entryTime: "10:34", entryPrice: 15365, exitTime: "10:38", exitAction: "take_profit", exitReason: "利確 (利確ライン:15273円)", pnlPer100: 9219 },
  { date: "2026-07-09", route: "primary", side: "short", entryTime: "09:53", entryPrice: 15010, exitTime: "09:54", exitAction: "take_profit", exitReason: "利確 (利確ライン:14920円)", pnlPer100: 9006 },
  { date: "2026-07-13", route: "primary", side: "short", entryTime: "09:54", entryPrice: 13595, exitTime: "10:04", exitAction: "take_profit", exitReason: "利確 (利確ライン:13513円)", pnlPer100: 8157 },
  { date: "2026-07-14", route: "primary", side: "short", entryTime: "10:09", entryPrice: 11590, exitTime: "10:12", exitAction: "stop_loss", exitReason: "損切り (損切りライン:11706円)", pnlPer100: -11590 },
  { date: "2026-07-15", route: "primary", side: "long", entryTime: "09:58", entryPrice: 12435, exitTime: "10:04", exitAction: "take_profit", exitReason: "利確 (利確ライン:12510円)", pnlPer100: 7461 },
  { date: "2026-07-17", route: "primary", side: "long", entryTime: "10:11", entryPrice: 11460, exitTime: "10:12", exitAction: "take_profit", exitReason: "利確 (利確ライン:11529円)", pnlPer100: 6876 },
  { date: "2026-07-21", route: "primary", side: "short", entryTime: "10:39", entryPrice: 10930, exitTime: "10:43", exitAction: "take_profit", exitReason: "利確 (利確ライン:10864円)", pnlPer100: 6558 },
  { date: "2026-07-23", route: "primary", side: "short", entryTime: "10:18", entryPrice: 12380, exitTime: "10:26", exitAction: "stop_loss", exitReason: "損切り (損切りライン:12504円)", pnlPer100: -12380 },
  { date: "2026-07-24", route: "primary", side: "long", entryTime: "10:26", entryPrice: 11620, exitTime: "10:32", exitAction: "stop_loss", exitReason: "損切り (損切りライン:11504円)", pnlPer100: -11620 },
  { date: "2026-07-27", route: "primary", side: "short", entryTime: "09:56", entryPrice: 11350, exitTime: "10:00", exitAction: "take_profit", exitReason: "利確 (利確ライン:11282円)", pnlPer100: 6810 },
  { date: "2026-07-30", route: "primary", side: "long", entryTime: "10:31", entryPrice: 9273, exitTime: "10:32", exitAction: "take_profit", exitReason: "利確 (利確ライン:9329円)", pnlPer100: 5564 },
  { date: "2026-07-30", route: "afternoon_short", side: "short", entryTime: "12:59", entryPrice: 8959, exitTime: "13:14", exitAction: "take_profit", exitReason: "利確 (利確ライン:8851円)", pnlPer100: 10750.67 },
  { date: "2026-08-06", route: "primary", side: "short", entryTime: "10:28", entryPrice: 9909, exitTime: "10:34", exitAction: "take_profit", exitReason: "利確 (利確ライン:9850円)", pnlPer100: 5945.5 },
  { date: "2026-08-07", route: "primary", side: "short", entryTime: "10:21", entryPrice: 9469, exitTime: "10:33", exitAction: "take_profit", exitReason: "利確 (利確ライン:9412円)", pnlPer100: 5681.5 },
  { date: "2026-08-10", route: "primary", side: "long", entryTime: "10:16", entryPrice: 10010, exitTime: "10:17", exitAction: "take_profit", exitReason: "利確 (利確ライン:10070円)", pnlPer100: 6006 },
  { date: "2026-08-13", route: "primary", side: "long", entryTime: "09:49", entryPrice: 11145, exitTime: "09:51", exitAction: "take_profit", exitReason: "利確 (利確ライン:11212円)", pnlPer100: 6687 },
  { date: "2026-08-14", route: "primary", side: "short", entryTime: "10:02", entryPrice: 10810, exitTime: "10:04", exitAction: "take_profit", exitReason: "利確 (利確ライン:10745円)", pnlPer100: 6486 },
  { date: "2026-08-18", route: "primary", side: "short", entryTime: "09:58", entryPrice: 11060, exitTime: "09:59", exitAction: "take_profit", exitReason: "利確 (利確ライン:10994円)", pnlPer100: 6636 },
  { date: "2026-08-19", route: "primary", side: "long", entryTime: "10:04", entryPrice: 9773, exitTime: "10:06", exitAction: "take_profit", exitReason: "利確 (利確ライン:9832円)", pnlPer100: 5864 },
  { date: "2026-08-20", route: "primary", side: "long", entryTime: "09:56", entryPrice: 9662, exitTime: "10:07", exitAction: "take_profit", exitReason: "利確 (利確ライン:9720円)", pnlPer100: 5797 },
  { date: "2026-08-21", route: "primary", side: "short", entryTime: "10:04", entryPrice: 9337, exitTime: "10:34", exitAction: "exit", exitReason: "候補B最大保有30分境界の確定足終値決済", pnlPer100: 1100 },
  { date: "2026-08-26", route: "primary", side: "short", entryTime: "09:52", entryPrice: 8816, exitTime: "09:59", exitAction: "take_profit", exitReason: "利確 (利確ライン:8763円)", pnlPer100: 5289.67 },
  { date: "2026-08-27", route: "primary", side: "short", entryTime: "09:50", entryPrice: 8703, exitTime: "09:51", exitAction: "take_profit", exitReason: "利確 (利確ライン:8651円)", pnlPer100: 5221.67 },
  { date: "2026-08-28", route: "primary", side: "long", entryTime: "10:12", entryPrice: 9258, exitTime: "10:14", exitAction: "take_profit", exitReason: "利確 (利確ライン:9314円)", pnlPer100: 5555 },
]);

export const TAIYO_CANDIDATE_B_EXPECTED_SUMMARY = Object.freeze({
  sourceDates: 46,
  sourceRows: 14_719,
  trades: 33,
  primaryTrades: 30,
  afternoonShortTrades: 3,
  wins: 28,
  losses: 5,
  winRatePct: 84.85,
  pnlPer100: 157_872.01,
  confirmationRejected: 42,
  engineRejectedWithoutCapitalLimit: 0,
  recentFiveDates: Object.freeze(["2026-08-20", "2026-08-21", "2026-08-26", "2026-08-27", "2026-08-28"]),
  recentFiveTrades: 5,
  recentFiveWins: 5,
  recentFiveLosses: 0,
  recentFivePnlPer100: 22_963.34,
});

export const TAIYO_CANDIDATE_B_PORTFOLIO_SOURCE_EXPECTATIONS = Object.freeze({
  order: "tradeDate_then_saved_id",
  processedRows: 93_072,
  trades: 214,
  wins: 164,
  losses: 50,
  pnl: 3_831_483,
  bySymbol: Object.freeze({
    "285A": Object.freeze({ trades: 57, wins: 43, losses: 14, pnl: 1_755_735 }),
    "8035": Object.freeze({ trades: 30, wins: 22, losses: 8, pnl: 358_369 }),
    "5803": Object.freeze({ trades: 41, wins: 30, losses: 11, pnl: 462_493 }),
    "6981": Object.freeze({ trades: 22, wins: 18, losses: 4, pnl: 277_861 }),
    "6976": Object.freeze({ trades: 28, wins: 25, losses: 3, pnl: 264_390 }),
    "6857": Object.freeze({ trades: 21, wins: 17, losses: 4, pnl: 362_678 }),
    "6146": Object.freeze({ trades: 15, wins: 9, losses: 6, pnl: 349_957 }),
  }),
});

export const TAIYO_CANDIDATE_B_FIXTURE_SHA256 = "8ba72c0fbdb043135bf3c8677e82a2205a6b1f644c958e0d49ac7e6cda3c244e";
export const TAIYO_CANDIDATE_B_REJECTION_STREAM_SHA256 = "17f38dd6f5881258360930ca11065459e22f10aab87d8ebea65a20e5ad057ca2";
