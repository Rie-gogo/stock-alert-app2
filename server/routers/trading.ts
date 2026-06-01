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
} from "../db";
import { generateDailySimReport } from "../simulation";
import { generateRealDailyReport } from "../realSimulation";
import { invokeLLM } from "../_core/llm";

export const tradingRouter = router({
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

      // ★ 実際のYahoo Financeデータを使ったシミュレーション実行
      // 当日データの場合は実データを試みる。過去日の場合は架空データにフォールバック
      const todayStr = new Date().toISOString().slice(0, 10);
      let simResult: Awaited<ReturnType<typeof generateRealDailyReport>> | ReturnType<typeof generateDailySimReport>;
      let dataSource: string;

      if (input.reportDate === todayStr) {
        // 当日は実データを使用
        const realResult = await generateRealDailyReport(input.reportDate, rsiUpper, rsiLower, stopLossPercent);
        simResult = realResult;
        dataSource = realResult.isRealData
          ? `実際の株価データ (${realResult.realDataCount}/10銘柄)`
          : "架空データ（市場データ取得失敗のためフォールバック）";
      } else {
        // 過去日は架空データ（Yahoo Financeの1分足は当日のみ取得可能）
        simResult = generateDailySimReport(input.reportDate, rsiUpper, rsiLower, stopLossPercent);
        dataSource = "架空データ（過去日付のため）";
      }

      // AI分析サマリーの生成（オプション）
      let aiSummary: string | undefined;
      if (input.generateAiSummary) {
        try {
          const lossStocks = simResult.stockReports
            .filter((r) => r.profitAmount < 0)
            .map((r) => `${r.name}(${r.symbol}): ${r.profitAmount.toLocaleString()}円, 勝率${(r.winRate * 100).toFixed(0)}%`)
            .join(", ");

          const winStocks = simResult.stockReports
            .filter((r) => r.profitAmount >= 0)
            .map((r) => `${r.name}(${r.symbol}): +${r.profitAmount.toLocaleString()}円`)
            .join(", ");

          const prompt = `あなたは株式デイトレードのAIアドバイザーです。
以下の${input.reportDate}のシミュレーション結果を分析し、改善提案を日本語で200文字以内で簡潔にまとめてください。

【本日の結果】（${dataSource}）
- 総合損益: ${simResult.totalProfitAmount.toLocaleString()}円 (${(simResult.totalProfitRate * 100).toFixed(2)}%)
- 全体勝率: ${(simResult.overallWinRate * 100).toFixed(1)}%
- 使用パラメータ: RSI上限${rsiUpper} / RSI下限${rsiLower} / 損切り${stopLossPercent}%
- 利益銘柄: ${winStocks || "なし"}
- 損失銘柄: ${lossStocks || "なし"}

改善提案（200文字以内）:`;

          const response = await invokeLLM({
            messages: [{ role: "user", content: prompt }],
          });
          const rawContent = response.choices[0]?.message?.content;
          aiSummary = typeof rawContent === 'string' ? rawContent : undefined;
        } catch (e) {
          console.warn("AI summary generation failed:", e);
        }
      }

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
          aiSummary: aiSummary
            ? `[${dataSource}]\n${aiSummary}`
            : `[${dataSource}]`,
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
      const currentWinRate = stats.avgWinRate;

      // AIに改善提案を依頼
      const prompt = `あなたは株式デイトレードのアルゴリズム最適化AIです。
以下の直近のシミュレーション結果を分析し、パラメータ改善案をJSON形式で返してください。

【現在のパラメータ】
- RSI上限（買われすぎ閾値）: ${config.rsiUpper}
- RSI下限（売られすぎ閾値）: ${config.rsiLower}
- 損切り率: ${config.stopLossPercent}%

【直近${stats.totalDays}日間の成績】
- 平均勝率: ${(currentWinRate * 100).toFixed(1)}%
- 平均損益率: ${(stats.avgProfitRate * 100).toFixed(2)}%
- 累計損益: ${stats.totalProfit.toLocaleString()}円

目標勝率は80〜90%です。現在の勝率が低い場合は改善が必要です。

以下のJSON形式で回答してください（他のテキストは不要）:
{
  "newRsiUpper": <数値 55-90>,
  "newRsiLower": <数値 10-45>,
  "newStopLossPercent": <数値 0.5-5.0>,
  "reason": "<改善理由を100文字以内で>"
}`;

      let newParams = {
        newRsiUpper: config.rsiUpper,
        newRsiLower: config.rsiLower,
        newStopLossPercent: parseFloat(String(config.stopLossPercent)),
        reason: "パラメータ変更なし（現状維持）",
      };

      try {
        const response = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "algorithm_improvement",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  newRsiUpper: { type: "number" },
                  newRsiLower: { type: "number" },
                  newStopLossPercent: { type: "number" },
                  reason: { type: "string" },
                },
                required: ["newRsiUpper", "newRsiLower", "newStopLossPercent", "reason"],
                additionalProperties: false,
              },
            },
          },
        });

        const rawContent2 = response.choices[0]?.message?.content;
        const content = typeof rawContent2 === 'string' ? rawContent2 : null;
        if (content) {
          const parsed = JSON.parse(content);
          newParams = {
            newRsiUpper: Math.min(90, Math.max(55, parsed.newRsiUpper)),
            newRsiLower: Math.min(45, Math.max(10, parsed.newRsiLower)),
            newStopLossPercent: Math.min(5.0, Math.max(0.5, parsed.newStopLossPercent)),
            reason: parsed.reason,
          };
        }
      } catch (e) {
        console.warn("AI improvement generation failed:", e);
      }

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
});
