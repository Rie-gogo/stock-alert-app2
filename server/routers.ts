import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { tradingRouter } from "./routers/trading";
import { aiAnalysisRouter } from "./routers/aiAnalysis";
import { stockDataRouter } from "./routers/stockData";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // トレーディングシミュレーション & レポート管理
  trading: tradingRouter,

  // リアルタイムAI市場分析
  aiAnalysis: aiAnalysisRouter,

  // 実際の株価データ（Yahoo Finance）
  stockData: stockDataRouter,
});

export type AppRouter = typeof appRouter;
