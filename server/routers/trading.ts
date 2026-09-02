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

export const tradingRouter = router({
  /** 実際に稼働中のビルドと固定評価設定を自己証明する。 */
  getRuntimeIdentity: publicProcedure.query(() => getRuntimeIdentity()),

  /** 8035・5803のstrategyVersion別未見データ前向き成績。注文指示とは分離される。 */
  getForwardShadowSummary: publicProcedure
    .input(z.object({ asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const { getForwardShadowSummary } = await import("../forwardShadow");
      const { FORWARD_STRATEGY_VERSION, FUJIKURA_FORWARD_STRATEGY_VERSION } = await import("../runtimeIdentity");
      return {
        strategies: [
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
        ],
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
      })
    )
    .mutation(async ({ input }) => {
      const { ingestSourceCandle } = await import("../sourceEventIngestion");
      return ingestSourceCandle(input);
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
        // 板情報データ（オプション：取得できなかった場合はnull）
        board: z
          .object({
            symbolName: z.string(),
            currentPrice: z.number(),
            currentPriceTime: z.string(),
            asks: z.array(z.object({ price: z.number(), qty: z.number() })),
            bids: z.array(z.object({ price: z.number(), qty: z.number() })),
            marketOrderSellQty: z.number().default(0),
            marketOrderBuyQty: z.number().default(0),
            overSellQty: z.number().default(0),
            underBuyQty: z.number().default(0),
            vwap: z.number().default(0),
            // v5拡張フィールド（パターン6.14対応）
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
          })
          .nullable()
          .optional(),
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
