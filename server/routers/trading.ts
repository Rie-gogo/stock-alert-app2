import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import {
  getDailyReportByDate,
  getDailyReportList,
  getDailyReportWithStocks,
  saveDailyReport,
  getAlgorithmConfig,
  updateAlgorithmConfig,
  saveAlgorithmImprovement,
  getAlgorithmImprovements,
  getRecentStats,
  getSymbolPerformanceHistory,
  createPaperTrade,
  closePaperTrade,
  getPaperTrades,
  getOpenPaperTradeCount,
  deletePaperTrade,
  getKabuPlanSettings,
  upsertKabuPlanSettings,
  getRtTradesForDate,
  getRtDailySummaryList,
} from "../db";
import { MAX_CONCURRENT_POSITIONS } from "@shared/stocks";
import { generateDailySimReport } from "../simulation";
import { generateRealDailyReport } from "../realSimulation";
import { recommendForNextDay, type SymbolHistoryInput } from "../portfolio";
import { getRuntimeIdentity } from "../runtimeIdentity";
import {
  getRtSignalCandidateLedger,
  isValidRtSignalCandidateLedgerDate,
  RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN,
} from "../signalCandidateLedger";
import { isArchivedNoSignalStrategyVersion } from "../shadowArchiveLifecycle";
import {
  authorizePremarketAutomation,
  premarketAutomationEnvelopeViolation,
} from "../premarketAutomationIngress";
import { premarketCmeIngressViolation } from "../marketContextSelectorShadow";

const rtSignalCandidateLedgerInput = z.object({
  tradeDate: z.string()
    .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN, "日付はYYYY-MM-DD形式で指定してください")
    .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください"),
});

/** Optional, audit-only relay provenance. Old Windows payloads remain valid. */
const relayCandleProvenanceInput = z.object({
  relayVersion: z.string().max(128).optional(),
  relaySourceTreeHash: z.string().max(128).optional(),
  rawCandleTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  barStartJst: z.string().max(32).optional(),
  barEndJst: z.string().max(32).optional(),
  valueSource: z.enum(["ws_aggregated", "buffer_reuse", "rest_fallback", "unknown"]).optional(),
  tickCount: z.number().int().nonnegative().nullable().optional(),
  firstTickAtMs: z.number().int().nonnegative().nullable().optional(),
  lastTickAtMs: z.number().int().nonnegative().nullable().optional(),
  fallbackReason: z.string().max(512).nullable().optional(),
  isNoTrade: z.union([z.boolean(), z.literal("unknown")]).optional(),
  clockHealth: z.object({
    timezone: z.enum(["JST", "unknown"]).optional(),
    ntpOffsetMs: z.number().finite().nullable().optional(),
    monotonicAnomaly: z.boolean().optional(),
    websocketConnected: z.boolean().nullable().optional(),
    websocketLastReceivedAtMs: z.number().int().nonnegative().nullable().optional(),
  }).optional(),
  relayAssembledAtMs: z.number().int().nonnegative().nullable().optional(),
}).optional();

/** Immutable relay board snapshot. CurrentPriceTime remains source-price audit data. */
const candleBoardInput = z.object({
  symbol: z.string().optional(),
  symbolName: z.string(),
  currentPrice: z.number(),
  currentPriceTime: z.string(),
  relayObservedAtMs: z.number().int().nonnegative().optional(),
  asks: z.array(z.object({ price: z.number(), qty: z.number() })),
  bids: z.array(z.object({ price: z.number(), qty: z.number() })),
  marketOrderSellQty: z.number().default(0),
  marketOrderBuyQty: z.number().default(0),
  overSellQty: z.number().default(0),
  underBuyQty: z.number().default(0),
  vwap: z.number().default(0),
  largeAskWallRatio: z.number().optional(),
  largeBidWallRatio: z.number().optional(),
  largeAskWallPrice: z.number().nullable().optional(),
  largeBidWallPrice: z.number().nullable().optional(),
  nearAskWallPct: z.number().nullable().optional(),
  nearBidWallPct: z.number().nullable().optional(),
  marketOrderDirection: z.enum(["buy", "sell", "neutral"]).optional(),
  askCancelDetected: z.boolean().optional(),
  bidCancelDetected: z.boolean().optional(),
  icebergAskDetected: z.boolean().optional(),
  icebergBidDetected: z.boolean().optional(),
  totalAskQty: z.number().optional(),
  totalBidQty: z.number().optional(),
});

const marketContextInput = z.object({
  // Existing Windows relay transport remains public, but this endpoint accepts
  // only the dynamically resolved Nikkei 225 mini day/night instrument.
  instrumentKey: z.literal("nikkei225_mini_front"),
  providerSymbol: z.string().min(1).max(32),
  productType: z.literal("future"),
  contractMonth: z.string().regex(/^\d{4}\/\d{2}$/).nullable().optional(),
  marketSession: z.literal("day_night"),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  candleTime: z.string().regex(/^\d{2}:\d{2}$/).refine(
    value => value >= "08:45" && value <= "15:45",
    "市場環境1分足は日中立会時間（08:45〜15:45 JST）だけ受け付けます",
  ),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().int().nonnegative().nullable().optional(),
  previousClose: z.number().positive().nullable().optional(),
  valueSource: z.enum(["ws_aggregated", "rest_fallback"]),
  sourceEventId: z.string().min(1).max(128),
  relaySessionId: z.string().min(1).max(96),
  eventSeq: z.number().int().nonnegative(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAtMs: z.number().int().nonnegative(),
  relaySentAtMs: z.number().int().nonnegative(),
  correctedEventId: z.string().min(1).max(128).nullable().optional(),
}).superRefine((value, context) => {
  if (value.high < Math.max(value.open, value.close) || value.low > Math.min(value.open, value.close) || value.high < value.low) {
    context.addIssue({ code: "custom", message: "OHLCの大小関係が不正です" });
  }
  if (value.correctedEventId) {
    context.addIssue({ code: "custom", message: "市場環境1分足の訂正上書きは受け付けません" });
  }
});

const premarketLegStatus = z.enum(["verified", "degraded", "missing"]);
const httpsSource = z.string().url().refine(value => value.startsWith("https://"), "出典URLはHTTPSで指定してください");
const premarketContextInput = z.object({
  sourceSnapshotId: z.string().min(1).max(128).optional(),
  tradeDate: z.string()
    .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
    .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください"),
  capturedAtMs: z.number().int().nonnegative(),
  collectorVersion: z.string().min(1).max(96),
  sourceMode: z.enum(["scheduled_research", "provider_api", "manual_review"]),
  dow: z.object({
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    close: z.number().positive(),
    changePct: z.number().finite().min(-20).max(20),
    observedAtMs: z.number().int().nonnegative(),
    sourceUrl: httpsSource,
    status: premarketLegStatus,
  }).nullable(),
  cme: z.object({
    providerSymbol: z.string().min(1).max(32),
    contractMonth: z.string().regex(/^\d{4}\/\d{2}$/),
    currency: z.enum(["JPY", "USD"]),
    quote: z.number().positive(),
    observedAtMs: z.number().int().nonnegative(),
    comparisonPolicy: z.literal("same_cme_previous_jpx_business_day_0830").optional(),
    previousSession: z.object({
      tradeDate: z.string()
        .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
        .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください"),
      providerSymbol: z.string().min(1).max(32),
      contractMonth: z.string().regex(/^\d{4}\/\d{2}$/),
      currency: z.enum(["JPY", "USD"]),
      quote: z.number().positive(),
      observedAtMs: z.number().int().nonnegative(),
    }).nullable().optional(),
    // 旧collectorのpayloadを直ちに壊さないため受信だけ許可する。方向判定には使用しない。
    oseDayClose: z.number().positive().optional(),
    sourceUrl: httpsSource,
    status: premarketLegStatus,
  }).nullable(),
  usdJpy: z.object({
    previousRate: z.number().positive(),
    previousAtMs: z.number().int().nonnegative(),
    currentRate: z.number().positive(),
    currentAtMs: z.number().int().nonnegative(),
    sourceUrl: httpsSource,
    status: premarketLegStatus,
  }).nullable(),
}).superRefine((value, context) => {
  const violation = premarketCmeIngressViolation(value);
  if (violation) {
    context.addIssue({
      code: "custom",
      path: ["cme"],
      message: violation,
    });
  }
});
const premarketAutomationInput = premarketContextInput.safeExtend({
  ingestKey: z.string().min(32).max(256),
});

export const tradingRouter = router({
  /** D-1のみを返す日次AI予測のread-only input API。通常engineや注文には接続しない。 */
  getAiDailyForecastInput: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { buildAiDailyForecastInput } = await import("../aiDailyForecastService");
      return buildAiDailyForecastInput({ tradeDate: input.tradeDate });
    }),
  /** Snapshot/revisionのread-only表示契約。保存済みinput・forecastは更新しない。 */
  getAiDailyForecastDashboard: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getAiDailyForecastDashboard } = await import("../aiDailyForecastService");
      return getAiDailyForecastDashboard(input.tradeDate);
    }),
  /** Secretの存在確認専用。予測生成・DB書込み・model呼出しは行わない。 */
  validateAiDailyForecastIngestAuth: publicProcedure
    .input(z.object({ ingestKey: z.string().min(32).max(256) }))
    .query(({ input }) => {
      const key = process.env.AI_DAILY_FORECAST_INGEST_KEY;
      if (!key || input.ingestKey !== key) throw new TRPCError({ code: "UNAUTHORIZED", message: "AI forecast ingest authorization failed" });
      return { accepted: true, capability: "ai_daily_forecast_sender_only" as const };
    }),
  /** 08:30後のCodex専用senderだけが実行する、外部生成JSONのingest endpoint。 */
  ingestAiDailyForecast: publicProcedure
    .input(z.object({
      ingestKey: z.string().min(32).max(256),
      sourceSnapshotId: z.string().min(1).max(160),
      tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      capturedAtMs: z.number().int().positive(),
      sourceMode: z.enum(["scheduled_ai_forecast", "manual_dry_run"]).default("manual_dry_run"),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      quantBaseline: z.unknown(),
      aiFinalForecast: z.unknown(),
      generatorId: z.string().min(1).max(96),
      promptVersion: z.string().min(1).max(96),
      generatorMetadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      const key = process.env.AI_DAILY_FORECAST_INGEST_KEY;
      if (!key || input.ingestKey !== key) throw new TRPCError({ code: "UNAUTHORIZED", message: "AI forecast ingest authorization failed" });
      const { ingestAiDailyForecastSubmission } = await import("../aiDailyForecastService");
      const snapshot = await ingestAiDailyForecastSubmission(input);
      return {
        sourceSnapshotId: snapshot.sourceSnapshotId,
        tradeDate: snapshot.tradeDate,
        dataCutoffDate: snapshot.dataCutoffDate,
        qualityStatus: snapshot.qualityStatus,
        aiModelId: snapshot.aiModelId,
      };
    }),
  /**
   * 手動更新だけで読む、relay→source→decision→shadowの保存済み監査診断。
   * 受信hot path・raw再集計・pollingは増やさない。
   */
  getRelayBollingerDiagnostics: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getRelayBollingerDiagnosticsSnapshot } = await import("../relayBollingerDiagnostics");
      return getRelayBollingerDiagnosticsSnapshot(input.tradeDate);
    }),

  /** 実際に稼働中のビルドと固定評価設定を自己証明する。 */
  getRuntimeIdentity: publicProcedure.query(() => getRuntimeIdentity()),

  /**
   * 現行候補・100株仮想取引・phase/gap・891万円portfolioを1候補1行で返す読取専用台帳。
   * ロジック条件と証拠金情報を含むため、未認証アクセスは許可しない。
   */
  getRtSignalCandidateLedger: protectedProcedure
    .input(rtSignalCandidateLedgerInput)
    .query(async ({ input }) => {
      try {
        return await getRtSignalCandidateLedger(input.tradeDate);
      } catch {
        console.error("[RtSignalCandidateLedger] read failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "全シグナル監査台帳を取得できませんでした",
        });
      }
    }),

  /** プランDで停止した現行11経路の累計100株仮想損益。読取専用・認証必須。 */
  getPausedCurrentRouteShadowSummary: protectedProcedure
    .input(z.object({ asOfDate: z.string()
      .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
      .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください") }))
    .query(async ({ input }) => {
      try {
        const { getAllPausedCurrentRouteShadowSummary } = await import("../pausedCurrentRouteShadowSummary");
        return await getAllPausedCurrentRouteShadowSummary(input.asOfDate);
      } catch {
        console.error("[PausedCurrentRouteShadowSummary] read failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "停止現行経路のシャドー成績を取得できませんでした",
        });
      }
    }),

  /** 10銘柄の翌日固定選択器。closed日次snapshotだけを読む監視専用API。 */
  getTenSymbolNextDaySelector: protectedProcedure
    .input(z.object({ asOfDate: z.string()
      .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
      .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください") }))
    .query(async ({ input }) => {
      try {
        const { getTenSymbolNextDaySelectorDashboard } = await import("../tenSymbolNextDaySelector");
        return await getTenSymbolNextDaySelectorDashboard(input.asOfDate);
      } catch {
        console.error("[TenSymbolNextDaySelector] snapshot read failed");
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "10銘柄翌日選択器snapshotを取得できませんでした" });
      }
    }),

  /** routeGroupId単位の可変行selector。immutableな閉場後snapshotだけを読む。 */
  getRouteGranularNextDaySelector: protectedProcedure
    .input(z.object({ asOfDate: z.string()
      .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
      .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください") }))
    .query(async ({ input }) => {
      try {
        const { getRouteGranularSelectorDashboard } = await import("../routeGranularNextDaySelector");
        return await getRouteGranularSelectorDashboard(input.asOfDate);
      } catch {
        console.error("[RouteGranularNextDaySelector] snapshot read failed");
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "経路別翌日選択器snapshotを取得できませんでした" });
      }
    }),

  /** 閉場後snapshotだけを読む、現行10銘柄・全シャドーの最近傾向。 */
  getMultiSymbolMonitoringTrend: protectedProcedure
    .input(z.object({ asOfDate: z.string()
      .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
      .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください") }))
    .query(async ({ input }) => {
      try {
        const { getMultiSymbolMonitoringTrend } = await import("../multiSymbolMonitoringTrend");
        return await getMultiSymbolMonitoringTrend(input.asOfDate);
      } catch {
        console.error("[MultiSymbolMonitoringTrend] snapshot read failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "10銘柄の最近傾向を取得できませんでした",
        });
      }
    }),

  /** strategyVersion別未見成績と、現行再現・因果性・共有資金の監査情報。 */
  getForwardShadowSummary: publicProcedure
    .input(z.object({ asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getForwardShadowSummary } = await import("../forwardShadow");
      const { getAllPausedCurrentRouteShadowSummary } = await import("../pausedCurrentRouteShadowSummary");
      const {
        DISCO_SHORT_BASELINE_VERSION,
        DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION,
        DISCO_SHORT_RETEST_B_LEGACY_VERSION,
        DISCO_SHORT_EXECUTABLE_A_VERSION,
        DISCO_SHORT_RETEST_B_VERSION,
        DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
        DISCO_LONG_PRIOR_THREE_B_VERSION,
        FORWARD_STRATEGY_VERSION,
        FUJIKURA_FORWARD_STRATEGY_VERSION,
        FUJIKURA_MORNING_SHORT_VERSION,
        KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
        KIOXIA_FORWARD_STRATEGY_VERSION,
        KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
        KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
        SOFTBANK_DEPTH_CONFIRM_VERSION,
        SOFTBANK_RR2_PROTECT_VERSION,
        SOCIONEXT_CONFIRM_STRENGTH_VERSION,
        SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION,
        SOCIONEXT_INITIAL_STRENGTH_VERSION,
        SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION,
        SUMCO_TIME_15_VERSION,
        SUMCO_VOLUME_110_VERSION,
        TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
        TAIYO_BOARD_DEMAND_VERSION,
        TAIYO_RR2_PROTECT_VERSION,
        TEL_EXECUTABLE_DEPTH_LEGACY_VERSION,
      } = await import("../runtimeIdentity");
      const {
        FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE,
        FUJIKURA_MORNING_SHORT_FORMAL_START_DATE,
      } = await import("../fujikuraMorningBreakdownShortShadow");
      const {
        SOFTBANK_FORWARD_COLLECTION_START_DATE,
        SOFTBANK_FORWARD_FORMAL_START_DATE,
      } = await import("../softbankForwardShadow");
      const {
        TAIYO_FORWARD_COLLECTION_START_DATE,
        TAIYO_FORWARD_FORMAL_START_DATE,
      } = await import("../taiyoForwardShadow");
      const {
        TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE,
        TAIYO_AFTERNOON_LONG_FORMAL_START_DATE,
      } = await import("../taiyoAfternoonLongForwardShadow");
      const {
        SOCIONEXT_FORWARD_COLLECTION_START_DATE,
        SOCIONEXT_FORWARD_FORMAL_START_DATE,
      } = await import("../socionextForwardShadow");
      const {
        SUMCO_FORWARD_COLLECTION_START_DATE,
        SUMCO_FORWARD_FORMAL_START_DATE,
      } = await import("../sumcoForwardShadow");
      const {
        DISCO_SHORT_COLLECTION_START_DATE,
        DISCO_SHORT_FORMAL_START_DATE,
      } = await import("../discoOpeningShortForwardShadow");
      const {
        DISCO_LONG_FORWARD_COLLECTION_START_DATE,
        DISCO_LONG_FORWARD_FORMAL_START_DATE,
      } = await import("../discoConfirmedLongForwardShadow");
      const {
        TEL_AUDIT_EVALUATION_START_DATE,
        TEL_CAUSALITY_AUDIT_VERSION,
        TEL_CURRENT_PARITY_VERSION,
      } = await import("../telCurrentParity");
      const {
        TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
        TEL_EXECUTABLE_CONFIRM_VERSION,
      } = await import("../telExecutableConfirm");
      const {
        getRtDivergenceHypotheses,
        getRtDailyAuditMaterialization,
        getRtOutcomeLabelsForDate,
        getRtPortfolioAuditEventsForDate,
        getRtRealtimeDecisionEventsForDate,
        getRtReplayComparisonsForDate,
        getRtStrategyVersion,
      } = await import("../db");
      const {
        ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
        ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
        CURRENT_PORTFOLIO_AUDIT_VERSION,
        NORMALIZED_PORTFOLIO_AUDIT_VERSION,
      } = await import("../portfolioAudit");
      const {
        DISCO_SHORT_PORTFOLIO_COMPONENT,
        DISCO_SHORT_PORTFOLIO_VERSION,
      } = await import("../discoOpeningShortPortfolioComparison");
      const [
        currentDecisions,
        replayComparisons,
        actualReceiptPortfolio,
        minuteNormalizedPortfolio,
        allCandidateReceiptPortfolio,
        allCandidateMinutePortfolio,
        discoShortPortfolioComparison,
        outcomeLabels,
        divergenceHypotheses,
        pausedCurrentRoutes,
        telCurrentParityLifecycle,
        telCausalityAuditLifecycle,
      ] = await Promise.all([
        getRtRealtimeDecisionEventsForDate(input.asOfDate),
        getRtReplayComparisonsForDate({ tradeDate: input.asOfDate, baselineVersion: TEL_CURRENT_PARITY_VERSION }),
        getRtPortfolioAuditEventsForDate({ portfolioVersion: CURRENT_PORTFOLIO_AUDIT_VERSION, tradeDate: input.asOfDate, mode: "actual_receipt" }),
        getRtPortfolioAuditEventsForDate({ portfolioVersion: NORMALIZED_PORTFOLIO_AUDIT_VERSION, tradeDate: input.asOfDate, mode: "minute_normalized" }),
        getRtPortfolioAuditEventsForDate({ portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION, tradeDate: input.asOfDate, mode: "actual_receipt" }),
        getRtPortfolioAuditEventsForDate({ portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION, tradeDate: input.asOfDate, mode: "minute_normalized" }),
        getRtDailyAuditMaterialization({
          component: DISCO_SHORT_PORTFOLIO_COMPONENT,
          version: DISCO_SHORT_PORTFOLIO_VERSION,
          tradeDate: input.asOfDate,
        }),
        getRtOutcomeLabelsForDate({ baselineVersion: "current-realtime-outcome-label-v1", tradeDate: input.asOfDate }),
        getRtDivergenceHypotheses(input.asOfDate),
        getAllPausedCurrentRouteShadowSummary(input.asOfDate),
        getRtStrategyVersion(TEL_CURRENT_PARITY_VERSION),
        getRtStrategyVersion(TEL_CAUSALITY_AUDIT_VERSION),
      ]);
      const countBy = (values: Array<string | null | undefined>) => Object.fromEntries(
        Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
          .map(value => [value, values.filter(item => item === value).length]),
      );
      const summarizePortfolio = (events: typeof actualReceiptPortfolio) => ({
        events: events.length,
        byDecision: countBy(events.map(event => event.decision)),
        blockEdges: events.filter(event => event.decision === "margin_block" && event.blockerSourceEventId).length,
        maxMarginUsed: events.reduce((max, event) => Math.max(max, event.marginUsedAfter ?? 0), 0),
      });
      const strategies = [
          {
            strategyVersion: FORWARD_STRATEGY_VERSION,
            symbol: "8035",
            summaries: await getForwardShadowSummary(input.asOfDate, FORWARD_STRATEGY_VERSION),
          },
          {
            strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
            symbol: "5803",
            summaries: await getForwardShadowSummary(input.asOfDate, FUJIKURA_FORWARD_STRATEGY_VERSION),
          },
          {
            strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
            symbol: "5803",
            summaries: await getForwardShadowSummary(input.asOfDate, FUJIKURA_MORNING_SHORT_VERSION),
            purpose: "diagnostic_candidate" as const,
            eligibleForAdoption: false,
            automaticAdoption: false,
            orderInstructionConnection: false,
            collectionStartDate: FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE,
            evaluationStartDate: FUJIKURA_MORNING_SHORT_FORMAL_START_DATE,
          },
          {
            strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
            symbol: "285A",
            summaries: await getForwardShadowSummary(input.asOfDate, KIOXIA_FORWARD_STRATEGY_VERSION),
          },
          {
            strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
            symbol: "285A",
            summaries: await getForwardShadowSummary(input.asOfDate, KIOXIA_ATR_FORWARD_STRATEGY_VERSION),
          },
          {
            strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
            symbol: "285A",
            summaries: await getForwardShadowSummary(input.asOfDate, KIOXIA_REVERSAL_LONG_REOPEN_VERSION),
            purpose: "invalid_mapping_quarantined" as const,
            eligibleForAdoption: false,
            automaticAdoption: false,
            orderInstructionConnection: false,
            collectionStartDate: "2026-10-02",
            evaluationStartDate: "2026-10-02",
          },
          {
            strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
            symbol: "285A",
            summaries: await getForwardShadowSummary(input.asOfDate, KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: false,
            automaticAdoption: false,
            orderInstructionConnection: false,
            collectionStartDate: "2026-10-02",
            evaluationStartDate: "2026-10-02",
          },
          {
            strategyVersion: TEL_EXECUTABLE_CONFIRM_VERSION,
            symbol: "8035",
            summaries: await getForwardShadowSummary(input.asOfDate, TEL_EXECUTABLE_CONFIRM_VERSION),
            purpose: "superseded_stopped_audit_only" as const,
            eligibleForAdoption: false,
            evaluationStartDate: TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
          },
          {
            strategyVersion: TEL_EXECUTABLE_DEPTH_LEGACY_VERSION,
            symbol: "8035",
            summaries: await getForwardShadowSummary(input.asOfDate, TEL_EXECUTABLE_DEPTH_LEGACY_VERSION),
            purpose: "superseded_stopped_audit_only" as const,
            eligibleForAdoption: false,
            evaluationStartDate: "2026-09-07",
          },

          {
            strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION,
            symbol: "9984",
            summaries: await getForwardShadowSummary(input.asOfDate, SOFTBANK_DEPTH_CONFIRM_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: SOFTBANK_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: SOFTBANK_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: SOFTBANK_RR2_PROTECT_VERSION,
            symbol: "9984",
            summaries: await getForwardShadowSummary(input.asOfDate, SOFTBANK_RR2_PROTECT_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: SOFTBANK_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: SOFTBANK_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: TAIYO_BOARD_DEMAND_VERSION,
            symbol: "6976",
            summaries: await getForwardShadowSummary(input.asOfDate, TAIYO_BOARD_DEMAND_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: TAIYO_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: TAIYO_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: TAIYO_RR2_PROTECT_VERSION,
            symbol: "6976",
            summaries: await getForwardShadowSummary(input.asOfDate, TAIYO_RR2_PROTECT_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: TAIYO_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: TAIYO_FORWARD_FORMAL_START_DATE,
          },



          {
            strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
            symbol: "6976",
            summaries: await getForwardShadowSummary(input.asOfDate, TAIYO_AFTERNOON_LONG_WINRATE_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE,
            evaluationStartDate: TAIYO_AFTERNOON_LONG_FORMAL_START_DATE,
          },
          {
            strategyVersion: SOCIONEXT_INITIAL_STRENGTH_VERSION,
            symbol: "6526",
            summaries: await getForwardShadowSummary(input.asOfDate, SOCIONEXT_INITIAL_STRENGTH_VERSION),
            purpose: "diagnostic_candidate" as const,
            eligibleForAdoption: false,
            collectionStartDate: SOCIONEXT_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: SOCIONEXT_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION,
            symbol: "6526",
            summaries: await getForwardShadowSummary(input.asOfDate, SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION),
            purpose: "invalid_mapping_quarantined" as const,
            eligibleForAdoption: false,
            automaticAdoption: false,
            orderInstructionConnection: false,
            collectionStartDate: "2026-10-02",
            evaluationStartDate: "2026-10-02",
          },
          {
            strategyVersion: SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION,
            symbol: "6526",
            summaries: await getForwardShadowSummary(input.asOfDate, SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: false,
            automaticAdoption: false,
            orderInstructionConnection: false,
            collectionStartDate: "2026-10-02",
            evaluationStartDate: "2026-10-02",
          },
          {
            strategyVersion: SOCIONEXT_CONFIRM_STRENGTH_VERSION,
            symbol: "6526",
            summaries: await getForwardShadowSummary(input.asOfDate, SOCIONEXT_CONFIRM_STRENGTH_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: SOCIONEXT_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: SOCIONEXT_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: SUMCO_VOLUME_110_VERSION,
            symbol: "3436",
            summaries: await getForwardShadowSummary(input.asOfDate, SUMCO_VOLUME_110_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: SUMCO_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: SUMCO_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: SUMCO_TIME_15_VERSION,
            symbol: "3436",
            summaries: await getForwardShadowSummary(input.asOfDate, SUMCO_TIME_15_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: SUMCO_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: SUMCO_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: DISCO_SHORT_BASELINE_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_SHORT_BASELINE_VERSION),
            purpose: "paused_current_route_comparison_only" as const,
            eligibleForAdoption: false,
            collectionStartDate: DISCO_SHORT_COLLECTION_START_DATE,
            evaluationStartDate: DISCO_SHORT_FORMAL_START_DATE,
          },
          {
            strategyVersion: DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION),
            purpose: "superseded_stopped_audit_only" as const,
            eligibleForAdoption: false,
            collectionStartDate: "2026-09-11",
            evaluationStartDate: "2026-09-11",
          },
          {
            strategyVersion: DISCO_SHORT_RETEST_B_LEGACY_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_SHORT_RETEST_B_LEGACY_VERSION),
            purpose: "superseded_stopped_audit_only" as const,
            eligibleForAdoption: false,
            collectionStartDate: "2026-09-11",
            evaluationStartDate: "2026-09-11",
          },
          {
            strategyVersion: DISCO_SHORT_EXECUTABLE_A_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_SHORT_EXECUTABLE_A_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: "2026-09-18",
            evaluationStartDate: "2026-09-18",
          },
          {
            strategyVersion: DISCO_SHORT_RETEST_B_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_SHORT_RETEST_B_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: "2026-09-18",
            evaluationStartDate: "2026-09-18",
          },
          {
            strategyVersion: DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_LONG_PROFIT_PROTECTION_A_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: DISCO_LONG_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: DISCO_LONG_FORWARD_FORMAL_START_DATE,
          },
          {
            strategyVersion: DISCO_LONG_PRIOR_THREE_B_VERSION,
            symbol: "6146",
            summaries: await getForwardShadowSummary(input.asOfDate, DISCO_LONG_PRIOR_THREE_B_VERSION),
            purpose: "candidate" as const,
            eligibleForAdoption: true,
            collectionStartDate: DISCO_LONG_FORWARD_COLLECTION_START_DATE,
            evaluationStartDate: DISCO_LONG_FORWARD_FORMAL_START_DATE,
          },
        ];
      return {
        strategies,
        auditStrategies: [
          {
            strategyVersion: TEL_CURRENT_PARITY_VERSION,
            symbol: "8035",
            purpose: "parity_only" as const,
            eligibleForAdoption: false,
            evaluationStartDate: TEL_AUDIT_EVALUATION_START_DATE,
            lifecycle: telCurrentParityLifecycle?.status ?? "unregistered",
            lifecycleReason: telCurrentParityLifecycle?.statusReason ?? null,
            archivedAt: telCurrentParityLifecycle && isArchivedNoSignalStrategyVersion(telCurrentParityLifecycle)
              ? telCurrentParityLifecycle.updatedAt.toISOString()
              : null,
          },
          {
            strategyVersion: TEL_CAUSALITY_AUDIT_VERSION,
            symbol: "8035",
            purpose: "causality_audit" as const,
            eligibleForAdoption: false,
            evaluationStartDate: TEL_AUDIT_EVALUATION_START_DATE,
            lifecycle: isArchivedNoSignalStrategyVersion(telCausalityAuditLifecycle)
              ? "archived_no_signal"
              : telCausalityAuditLifecycle?.status ?? "unregistered",
            lifecycleReason: telCausalityAuditLifecycle?.statusReason ?? null,
            archivedAt: telCausalityAuditLifecycle && isArchivedNoSignalStrategyVersion(telCausalityAuditLifecycle)
              ? telCausalityAuditLifecycle.updatedAt.toISOString()
              : null,
          },
        ],
        pausedCurrentRoutes,
        audit: {
          currentDecisions: {
            events: currentDecisions.length,
            byResultType: countBy(currentDecisions.map(event => event.resultType)),
            byCausalityStatus: countBy(currentDecisions.map(event => event.causalityStatus)),
            lastEngineSequence: currentDecisions.at(-1)?.id ?? null,
          },
          replayComparisons: {
            events: replayComparisons.length,
            byMatchStatus: countBy(replayComparisons.map(event => event.matchStatus)),
            firstMismatch: replayComparisons.find(event => event.isFirstMismatch) ?? null,
          },
          actualReceiptPortfolio: summarizePortfolio(actualReceiptPortfolio),
          minuteNormalizedPortfolio: summarizePortfolio(minuteNormalizedPortfolio),
          allCandidateReceiptPortfolio: summarizePortfolio(allCandidateReceiptPortfolio),
          allCandidateMinutePortfolio: summarizePortfolio(allCandidateMinutePortfolio),
          discoShortPortfolioComparison: discoShortPortfolioComparison?.status === "complete"
            ? discoShortPortfolioComparison.resultJson
            : {
                status: discoShortPortfolioComparison?.status ?? "not_materialized",
                reason: discoShortPortfolioComparison?.lastError ?? null,
              },
          outcomeLabels: {
            events: outcomeLabels.length,
            completed: outcomeLabels.filter(event => event.completed).length,
            blocked: outcomeLabels.filter(event => event.counterfactualJson
              && typeof event.counterfactualJson === "object"
              && (event.counterfactualJson as Record<string, unknown>).wasMarginBlocked === true).length,
          },
          divergenceHypotheses: divergenceHypotheses.slice(0, 20),
          semantics: {
            superseded8035CandidateEvaluationStartDate: TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
            officialReplayOrder: "rt_realtime_decision_events.id_engine_sequence",
            relaySequenceRole: "gap_and_duplicate_diagnosis_only",
            brokerExecutionPrice: "unavailable_in_dry_run",
            automaticAdoption: false,
          },
        },
      };
    }),

  /**
   * 現在のアルゴリズム設定を取得
   */
  getConfig: publicProcedure.query(async () => {
    const config = await getAlgorithmConfig();
    return config;
  }),

  /**
   * アルゴリズム設定を更新
   */
  updateConfig: protectedProcedure
    .input(
      z.object({
        rsiUpper: z.number().min(55).max(90).optional(),
        rsiLower: z.number().min(10).max(45).optional(),
        stopLossPercent: z.number().min(0.5).max(5.0).optional(),
        largeVolumeThreshold: z.number().min(1000).max(50000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const updated = await updateAlgorithmConfig({
        rsiUpper: input.rsiUpper,
        rsiLower: input.rsiLower,
        stopLossPercent: input.stopLossPercent?.toString(),
        largeVolumeThreshold: input.largeVolumeThreshold,
      });
      return updated;
    }),

  /**
   * デイリーレポート一覧を取得
   */
  getReportList: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(30) }))
    .query(async ({ input }) => {
      return getDailyReportList(input.limit);
    }),

  /**
   * 特定日のレポートを詳細取得（銘柄別含む）
   */
  getReportDetail: publicProcedure
    .input(z.object({ reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const result = await getDailyReportWithStocks(input.reportDate);
      if (!result) return null;
      return result;
    }),

  /**
   * 手動でシミュレーションを実行してレポートを保存
   */
  runSimulation: protectedProcedure
    .input(
      z.object({
        reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rsiUpper: z.number().min(55).max(90).optional(),
        rsiLower: z.number().min(10).max(45).optional(),
        stopLossPercent: z.number().min(0.5).max(5.0).optional(),
        generateAiSummary: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      // 現在のアルゴリズム設定を取得
      const config = await getAlgorithmConfig();
      const rsiUpper = input.rsiUpper ?? config?.rsiUpper ?? 70;
      const rsiLower = input.rsiLower ?? config?.rsiLower ?? 30;
      const stopLossPercent = input.stopLossPercent ?? parseFloat(String(config?.stopLossPercent ?? "1.5"));

      // ★ 実際のYahoo Financeデータのみ使用（架空データへのフォールバックは絶対に行わない）
      const todayStr = new Date().toISOString().slice(0, 10);
      if (input.reportDate !== todayStr) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `手動シミュレーションは当日のみ実行できます。Yahoo Financeの1分足データは当日分のみ取得可能です。過去日付の架空データシミュレーションは実施しません。`,
        });
      }

      // 実データ取得失敗時はgenerateRealDailyReportがエラーをスローするのでそのまま伝播する
      const simResult = await generateRealDailyReport(input.reportDate, rsiUpper, rsiLower, stopLossPercent);
      const dataSource = `実際の株価データ (${simResult.realDataCount}/${simResult.realDataCount}銘柄)`;

      // AI分析サマリーの生成（オプション）
      // AI summary removed - LLM no longer used

      // データベースに保存
      const savedReport = await saveDailyReport(
        {
          reportDate: simResult.date,
          totalInitialCapital: simResult.totalInitialCapital,
          totalFinalBalance: simResult.totalFinalBalance,
          totalProfitAmount: simResult.totalProfitAmount,
          totalProfitRate: simResult.totalProfitRate.toString(),
          totalWinCount: simResult.totalWinCount,
          totalLossCount: simResult.totalLossCount,
          overallWinRate: simResult.overallWinRate.toString(),
          rsiUpper,
          rsiLower,
          stopLossPercent: stopLossPercent.toString(),
          aiSummary: `[${dataSource}]`,
          isAutoGenerated: false,
        },
        simResult.stockReports.map((r) => ({
          symbol: r.symbol,
          name: r.name,
          initialCapital: r.initialCapital,
          finalBalance: r.finalBalance,
          profitAmount: r.profitAmount,
          profitRate: r.profitRate.toString(),
          tradesCount: r.tradesCount,
          winCount: r.winCount,
          winRate: r.winRate.toString(),
          trades: r.trades,
          lossCauses: r.lossCauses,
          countermeasures: r.countermeasures,
          signals: r.signals ?? [],
          isRealData: (r as { isRealData?: boolean }).isRealData ?? false,
        }))
      );

      return { success: true, report: savedReport };
    }),

  /**
   * AIによるアルゴリズム改善提案を生成して適用
   */
  improveAlgorithm: protectedProcedure
    .input(
      z.object({
        dailyReportId: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const config = await getAlgorithmConfig();
      if (!config) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Config not found" });

      const stats = await getRecentStats(14);
      // AI削除済み: パラメータは現状維持
      const newParams = {
        newRsiUpper: config.rsiUpper,
        newRsiLower: config.rsiLower,
        newStopLossPercent: parseFloat(String(config.stopLossPercent)),
        reason: `現状維持（直近${stats.totalDays}日間 勝率${(stats.avgWinRate * 100).toFixed(1)}%）`,
      };
      // 改善履歴を保存
      await saveAlgorithmImprovement({
        dailyReportId: input.dailyReportId,
        prevRsiUpper: config.rsiUpper,
        prevRsiLower: config.rsiLower,
        prevStopLossPercent: String(config.stopLossPercent),
        newRsiUpper: newParams.newRsiUpper,
        newRsiLower: newParams.newRsiLower,
        newStopLossPercent: String(newParams.newStopLossPercent),
        improvementReason: newParams.reason,
      });

      // 設定を更新
      await updateAlgorithmConfig({
        rsiUpper: newParams.newRsiUpper,
        rsiLower: newParams.newRsiLower,
        stopLossPercent: String(newParams.newStopLossPercent),
      });

      return {
        success: true,
        improvement: newParams,
        newConfig: await getAlgorithmConfig(),
      };
    }),

  /**
   * アルゴリズム改善履歴を取得
   */
  getImprovements: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      return getAlgorithmImprovements(input.limit);
    }),

  /**
   * 直近の統計情報を取得
   */
  getStats: publicProcedure
    .input(z.object({ days: z.number().min(7).max(90).default(30) }))
    .query(async ({ input }) => {
      return getRecentStats(input.days);
    }),

  /**
   * 【本日の推奨銘柄トップ3】事前推奨
   * 過去レポート（直近N営業日の銘柄別調子）から、明日・本日狙うべき銘柄を返す。
   * 当日の結果を見ず（後知恵を避ける）、業種分散の上限を守って選別する。
   */
  getRecommendations: publicProcedure
    .input(
      z.object({
        days: z.number().min(3).max(30).default(10),
        topN: z.number().min(1).max(5).default(3),
        excludeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .query(async ({ input }) => {
      const history = await getSymbolPerformanceHistory(input.days, input.excludeDate);
      const recommendations = recommendForNextDay(
        history as SymbolHistoryInput[],
        input.topN
      );
      return {
        basedOnDays: history.length > 0 ? Math.min(input.days, history.length) : 0,
        recommendations,
      };
    }),

  // ============================================================
  // 仮想売買（ペーパートレード）
  // ============================================================

  /**
   * 仮想売買の履歴を取得（オープン中＋決済済み）
   */
  getPaperTrades: protectedProcedure.query(async ({ ctx }) => {
    const trades = await getPaperTrades(ctx.user.id);
    return trades;
  }),

  /**
   * 仮買い／仮売りエントリーを記録
   * 同時保有は最大 MAX_CONCURRENT 銘柄まで（保有中ポジション数で判定）。
   */
  openPaperTrade: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10),
        symbolName: z.string().min(1).max(50),
        side: z.enum(["long", "short"]),
        entryPrice: z.number().positive(),
        quantity: z.number().int().positive(),
        note: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const openCount = await getOpenPaperTradeCount(ctx.user.id);
      if (openCount >= MAX_CONCURRENT_POSITIONS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `同時保有は最大${MAX_CONCURRENT_POSITIONS}銘柄までです。新しく仮エントリーするには、まず保有中のポジションを決済してください。`,
        });
      }

      const trade = await createPaperTrade({
        userId: ctx.user.id,
        symbol: input.symbol,
        symbolName: input.symbolName,
        side: input.side,
        entryPrice: String(input.entryPrice),
        quantity: input.quantity,
        note: input.note ?? null,
      });
      return { success: true, trade };
    }),

  /**
   * 仮ポジションを決済（損益を計算して closed に更新）
   */
  closePaperTrade: protectedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        exitPrice: z.number().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const trade = await closePaperTrade({
        id: input.id,
        userId: ctx.user.id,
        exitPrice: input.exitPrice,
      });
      return { success: true, trade };
    }),

  /**
   * 仮ポジション／履歴を削除（誤記録の取り消し用）
   */
  deletePaperTrade: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await deletePaperTrade({ id: input.id, userId: ctx.user.id });
      return { success: true };
    }),

  /**
   * Windows中継スクリプトから板情報を受信・キャッシュ
   * POST /api/board/push エンドポイントで呼び出す
   */
  pushOrderBook: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        symbolName: z.string(),
        currentPrice: z.number(),
        currentPriceTime: z.string(),
        relayObservedAtMs: z.number().int().nonnegative().optional(),
        asks: z.array(z.object({ price: z.number(), qty: z.number() })),
        bids: z.array(z.object({ price: z.number(), qty: z.number() })),
        marketOrderSellQty: z.number().default(0),
        marketOrderBuyQty: z.number().default(0),
        overSellQty: z.number().default(0),
        underBuyQty: z.number().default(0),
        vwap: z.number().default(0),
      })
    )
    .mutation(async ({ input }) => {
      const { updateOrderBook } = await import("../kabuStation");
      updateOrderBook({ ...input, receivedAt: Date.now() });
      return { success: true };
    }),

  /**
   * 特定銘柄の板情報を取得
   */
  getOrderBook: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { getOrderBook, analyzeOrderBook } = await import("../kabuStation");
      const book = getOrderBook(input.symbol);
      if (!book) return null;
      const signals = analyzeOrderBook(book);
      return { ...book, boardSignals: signals };
    }),

  /**
   * 全銘柄の板情報を一括取得
   */
  getAllOrderBooks: publicProcedure.query(async () => {
    const { getAllOrderBooks, analyzeOrderBook } = await import("../kabuStation");
    const books = getAllOrderBooks();
    return books.map((book) => ({
      ...book,
      boardSignals: analyzeOrderBook(book),
    }));
  }),

  /**
   * 日経平均系の市場環境専用1分足。
   * 通常のpushCandleと入口を分け、売買engine・shadow dispatch・注文を一切呼ばない。
   */
  pushMarketContext: publicProcedure
    .input(marketContextInput)
    .mutation(async ({ input }) => {
      const { ingestMarketContext } = await import("../marketContextIngestion");
      return ingestMarketContext(input);
    }),

  /** ①〜③の構造化済み開場前snapshot。文章ではなく数値・時刻・出典だけを保存する。 */
  pushPremarketMarketContext: protectedProcedure
    .input(premarketContextInput)
    .mutation(async ({ input }) => {
      const { ingestPremarketContext } = await import("../premarketContextIngestion");
      return ingestPremarketContext(input);
    }),

  /**
   * 08:30のローカル自動調査専用。OAuthを持たないtaskから、Manus Secretと
   * ローカルkey fileが一致する場合だけ①〜③の構造化snapshotを受け付ける。
   */
  pushPremarketMarketContextAutomated: publicProcedure
    .input(premarketAutomationInput)
    .mutation(async ({ input }) => {
      const { ingestKey, ...snapshot } = input;
      if (!authorizePremarketAutomation(ingestKey)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Premarket automation key rejected" });
      }
      const envelopeViolation = premarketAutomationEnvelopeViolation(snapshot);
      if (envelopeViolation) {
        throw new TRPCError({ code: "BAD_REQUEST", message: envelopeViolation });
      }
      const { ingestPremarketContext } = await import("../premarketContextIngestion");
      return ingestPremarketContext(snapshot);
    }),

  /** 市場環境と固定時刻の選択器専用シャドー判断を読み取る。 */
  getMarketContextSelectorShadow: protectedProcedure
    .input(z.object({
      tradeDate: z.string()
        .regex(RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN)
        .refine(isValidRtSignalCandidateLedgerDate, "実在する日付を指定してください"),
      limit: z.number().int().min(1).max(240).default(90),
    }))
    .query(async ({ input }) => {
      const {
        getLatestRtMarketContextEvents,
        getLatestRtPremarketContextSnapshot,
        getRtDailyAuditMaterialization,
      } = await import("../db");
      const {
        MARKET_CONTEXT_PERFORMANCE_COMPONENT,
        MARKET_CONTEXT_PERFORMANCE_VERSION,
        MARKET_CONTEXT_PERFORMANCE_SELECTOR_VERSION,
      } = await import("../marketContextPerformanceSelector");
      const [events, premarket] = await Promise.all([
        getLatestRtMarketContextEvents(input),
        getLatestRtPremarketContextSnapshot({ tradeDate: input.tradeDate }),
      ]);
      const v3HistoryDecisions = events.filter(event => {
        const result = event.resultJson && typeof event.resultJson === "object"
          ? event.resultJson as Record<string, unknown>
          : {};
        return result.selectorShadow !== null && result.selectorShadow !== undefined;
      });
      const v4Decisions = events.filter(event => {
        const result = event.resultJson && typeof event.resultJson === "object"
          ? event.resultJson as Record<string, unknown>
          : {};
        return result.contextPerformanceSelectorV4 !== null && result.contextPerformanceSelectorV4 !== undefined;
      });
      const premarketResult = premarket?.resultJson && typeof premarket.resultJson === "object"
        ? premarket.resultJson as Record<string, unknown>
        : {};
      const latestResult = events[0]?.resultJson && typeof events[0].resultJson === "object"
        ? events[0].resultJson as Record<string, unknown>
        : {};
      const performanceSnapshot = await getRtDailyAuditMaterialization({
        component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
        version: MARKET_CONTEXT_PERFORMANCE_VERSION,
        tradeDate: input.tradeDate,
      });
      const verifiedMarketEvents = events.filter(event => event.qualityStatus === "verified").length;
      return {
        version: MARKET_CONTEXT_PERFORMANCE_SELECTOR_VERSION,
        tradeDate: input.tradeDate,
        monitoringOnly: true,
        automaticAdoption: false,
        orderInstructionConnection: false,
        premarket,
        latest: events[0] ?? null,
        // Keep compatibility rows explicit and separate: v3 must never be folded
        // into v4 context-conditioned performance or selection displays.
        v3History: {
          version: "market-context-selector-shadow-v3-market-affinity-monitoring",
          premarketDecision: premarketResult.selectorShadow ?? null,
          decisions: v3HistoryDecisions,
          displayOnly: true,
          usedForV4: false,
        },
        v4: {
          premarketDecision: premarketResult.contextPerformanceSelectorV4 ?? null,
          decisions: v4Decisions,
          latestSelectorWorker: latestResult.selectorWorker ?? premarketResult.selectorWorker ?? null,
          performanceSnapshot: performanceSnapshot?.resultJson ?? null,
          performanceStatus: performanceSnapshot?.status ?? "not_materialized",
        },
        events,
        readiness: {
          premarketSnapshotPresent: Boolean(premarket),
          premarketUsable: premarket?.qualityStatus === "verified" || premarket?.qualityStatus === "degraded",
          premarketSelectorRecorded: premarketResult.contextPerformanceSelectorV4 !== null && premarketResult.contextPerformanceSelectorV4 !== undefined,
          marketContextEventCount: events.length,
          verifiedMarketContextEventCount: verifiedMarketEvents,
          intradaySelectorDecisionCount: v4Decisions.length,
          selectorWorkerStatus: latestResult.selectorWorker ?? premarketResult.selectorWorker ?? null,
          performanceSnapshotStatus: performanceSnapshot?.status ?? "not_materialized",
          missingInputs: [
            ...(!premarket ? ["premarket_1_to_3"] : []),
            ...(verifiedMarketEvents === 0 ? ["nikkei225_mini_4"] : []),
          ],
        },
      };
    }),

  /**
   * kabuステーション® プラン設定を取得
   */
  getKabuPlanSettings: publicProcedure.query(async () => {
    const settings = await getKabuPlanSettings();
    return settings;
  }),

  /**
   * kabuステーション® プラン設定を更新
   */
  updateKabuPlanSettings: protectedProcedure
    .input(
      z.object({
        planType: z.enum(["normal", "professional", "premium"]),
        planExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD形式で入力してください"),
        note: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const updated = await upsertKabuPlanSettings({
        planType: input.planType,
        planExpiresAt: input.planExpiresAt,
        note: input.note,
      });
      return updated;
    }),

  /**
   * Windows中継スクリプトから1分足OHLCVを受信してシミュレーションを実行
   * POST /api/trpc/trading.pushCandle
   */
  pushCandle: publicProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10),
        tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        candleTime: z.string().regex(/^\d{2}:\d{2}$/),
        open: z.number().positive(),
        high: z.number().positive(),
        low: z.number().positive(),
        close: z.number().positive(),
        volume: z.number().min(0),
        sourceEventId: z.string().min(1).max(128).optional(),
        relaySessionId: z.string().min(1).max(96).optional(),
        eventSeq: z.number().int().nonnegative().optional(),
        payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        relayReceivedAtMs: z.number().int().nonnegative().optional(),
        relaySentAtMs: z.number().int().nonnegative().optional(),
        correctedEventId: z.string().min(1).max(128).optional(),
        provenance: relayCandleProvenanceInput,
        // Canonical/shadow board only; the current engine keeps its existing input.
        board: candleBoardInput.nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { ingestSourceCandle } = await import("../sourceEventIngestion");
      return ingestSourceCandle({ ...input, currentEngineBoard: null });
    }),

  /**
   * [案C] 1分足と板情報を同時受信するエンドポイント
   * Windows側スクリプトが1分足確定時にREST APIで板情報を取得し、
   * 1分足データと一緒に送信する。既存のpushCandleは変更なし。
   */
  pushCandleWithBoard: publicProcedure
    .input(
      z.object({
        // 1分足データ
        symbol: z.string().min(1).max(10),
        tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        candleTime: z.string().regex(/^\d{2}:\d{2}$/),
        open: z.number().positive(),
        high: z.number().positive(),
        low: z.number().positive(),
        close: z.number().positive(),
        volume: z.number().min(0),
        sourceEventId: z.string().min(1).max(128).optional(),
        relaySessionId: z.string().min(1).max(96).optional(),
        eventSeq: z.number().int().nonnegative().optional(),
        payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        relayReceivedAtMs: z.number().int().nonnegative().optional(),
        relaySentAtMs: z.number().int().nonnegative().optional(),
        correctedEventId: z.string().min(1).max(128).optional(),
        provenance: relayCandleProvenanceInput,
        // 板情報データ（オプション：取得できなかった場合はnull）
        board: candleBoardInput.nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { ingestSourceCandle } = await import("../sourceEventIngestion");
      const result = await ingestSourceCandle(input);

      // 自動売買ブリッジ: rt_tradesの新規レコードを検知して発注指示を生成
      if (!result.sourceEventDuplicate) {
        try {
          const { checkAndGenerateInstructions } = await import("../orderBridge");
          await checkAndGenerateInstructions();
        } catch (e) {
          // orderBridgeのエラーはシグナルエンジンに影響させない
          console.error("[OrderBridge] 発注指示生成エラー:", e);
        }
      }

      return result;
    }),

  /**
   * 指定日のリアルタイム取徕ログを取得
   */
  getRtTrades: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      return getRtTradesForDate(input.tradeDate);
    }),

  /**
   * リアルタイム日次サマリー一覧を取得
   */
  getRtDailySummaries: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(60).default(30) }))
    .query(async ({ input }) => {
      return getRtDailySummaryList(input.limit);
    }),

  /**
   * 現在のオープンポジション一覧を取得（リアルタイム確認用）
   */
  getRtOpenPositions: publicProcedure.query(async () => {
    const { getOpenPositions, getCandleCounters } = await import("../realtimeSimEngine");
    return {
      positions: getOpenPositions(),
      candleCounters: getCandleCounters(),
    };
  }),

  /**
   * リアルタイム運用ダッシュボード用統合ステータスを取得
   * 接続状態・銘柄別損益・シグナル履歴・当日サマリーを一括取得
   */
  getRtDashboardStatus: publicProcedure.query(async () => {
    const { getDashboardStatus, getOpenPositions } = await import("../realtimeSimEngine");
    const status = getDashboardStatus();
    const openPositions = getOpenPositions();
    return {
      ...status,
      openPositions,
    };
  }),

  /**
   * 指定日のリアルタイム1分足データを取得（再シミュレーション用）
   * KABUステーションAPIから取得したリアルタイムデータのみを返す
   */
  getRtCandles: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getRtCandlesAllForDate } = await import("../db");
      return getRtCandlesAllForDate(input.tradeDate);
    }),

  // ============================================================
  // 自動売買: executor向けエンドポイント
  // ============================================================

  /**
   * ポーリング: pending状態の発注指示を取得する
   * ローカルPCのkabu_order_executor.pyが1秒ごとに呼び出す
   */
  getOrderInstructions: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getPendingInstructions } = await import("../orderBridge");
      return getPendingInstructions(input.tradeDate);
    }),

  /**
   * executorからの実行結果報告
   * 発注指示のステータスを更新する
   */
  reportOrderExecution: publicProcedure
    .input(
      z.object({
        instructionId: z.number(),
        status: z.enum(["sent", "executed", "failed", "cancelled"]),
        kabuOrderId: z.string().optional(),
        executedPrice: z.number().optional(),
        executedAt: z.string().optional(), // ISO string
        pnl: z.number().optional(),
        errorMessage: z.string().optional(),
        executorLog: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { updateInstructionStatus, updateAutoTradeDailyPnl } = await import("../orderBridge");

      const updated = await updateInstructionStatus(input.instructionId, {
        status: input.status,
        kabuOrderId: input.kabuOrderId,
        executedPrice: input.executedPrice?.toString(),
        executedAt: input.executedAt ? new Date(input.executedAt) : undefined,
        pnl: input.pnl,
        errorMessage: input.errorMessage,
        executorLog: input.executorLog as Record<string, unknown> | undefined,
      });

      // 約定完了時に日次損益を更新
      if (input.status === "executed" && input.pnl !== undefined && updated) {
        await updateAutoTradeDailyPnl(updated.tradeDate, input.pnl);
      }

      return updated;
    }),

  /**
   * 指定日の全発注指示を取得（ダッシュボード用）
   */
  getOrderInstructionHistory: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getOrderInstructionsForDate } = await import("../orderBridge");
      return getOrderInstructionsForDate(input.tradeDate);
    }),

  /**
   * 日次リスク管理ステータスを取得
   */
  getAutoTradeStatus: publicProcedure
    .input(z.object({ tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getOrCreateAutoTradeDaily } = await import("../orderBridge");
      return getOrCreateAutoTradeDaily(input.tradeDate);
    }),

  /**
   * 緊急停止を設定する
   */
  setEmergencyStop: publicProcedure
    .input(z.object({
      tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const { setEmergencyStop } = await import("../orderBridge");
      await setEmergencyStop(input.tradeDate, input.reason);
      return { success: true };
    }),

  /**
   * 緊急停止（エントリー禁止 + 全ポジション即時決済）
   * UIの緊急停止ボタンから呼ばれる
   */
  emergencyStopWithForceClose: publicProcedure
    .mutation(async () => {
      const { setEmergencyStop } = await import("../orderBridge");
      const { getOpenPositions, forceCloseAllPositions, getDashboardStatus } = await import("../realtimeSimEngine");

      // 1. 当日の日付を取得
      const status = getDashboardStatus();
      const tradeDate = status.currentTradeDate || (() => {
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        return jst.toISOString().slice(0, 10);
      })();

      // 2. 緊急停止フラグを設定（以降エントリー禁止）
      await setEmergencyStop(tradeDate, "手動緊急停止（UIボタン）");

      // 3. オープンポジションを取得
      const openPositions = getOpenPositions();
      const closedCount = openPositions.length;

      // 4. 全ポジションを即時決済
      if (closedCount > 0) {
        // 最新のバッファから各銘柄の直近価格を取得して強制決済
        const closingPrices = new Map<string, number>();
        for (const pos of openPositions) {
          // エントリー価格をフォールバックとして使用（実際にはバッファの最新close値が使われる）
          closingPrices.set(pos.symbol, pos.entryPrice);
        }
        await forceCloseAllPositions(tradeDate, closingPrices);
      }

      console.log(`[EmergencyStop] 🚨 手動緊急停止実行: エントリー禁止 + ${closedCount}件ポジション強制決済`);

      return {
        success: true,
        tradeDate,
        closedPositions: closedCount,
        message: `緊急停止完了: 新規エントリー禁止 + ${closedCount}件のポジションを即時決済しました`,
      };
    }),

  /**
   * 緊急停止を解除する
   */
  clearEmergencyStop: publicProcedure
    .input(z.object({
      tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }))
    .mutation(async ({ input }) => {
      const { getOrCreateAutoTradeDaily } = await import("../orderBridge");
      const { getDb } = await import("../db");
      const { autoTradeDaily } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { success: false, message: "DB接続エラー" };
      const daily = await getOrCreateAutoTradeDaily(input.tradeDate);
      await db
        .update(autoTradeDaily)
        .set({
          tradingEnabled: true,
          emergencyStop: false,
          emergencyStopReason: null,
        })
        .where(eq(autoTradeDaily.id, daily.id));
      console.log(`[EmergencyStop] ✅ 緊急停止解除: ${input.tradeDate}`);
      return { success: true, message: "緊急停止を解除しました。新規エントリーが再開されます。" };
    }),
});
