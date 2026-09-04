import { eq, ne, desc, gte, lte, inArray, and, or, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  dailyReports,
  stockReports,
  algorithmImprovements,
  algorithmConfig,
  paperTrades,
  kabuPlanSettings,
  type InsertDailyReport,
  type InsertStockReport,
  type InsertAlgorithmImprovement,
  type InsertPaperTrade,
  type KabuPlanSettings,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============================================================
// User helpers
// ============================================================
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============================================================
// Algorithm Config helpers
// ============================================================
export async function getAlgorithmConfig() {
  const db = await getDb();
  if (!db) return null;

  const rows = await db.select().from(algorithmConfig).limit(1);
  if (rows.length === 0) {
    await db.insert(algorithmConfig).values({
      rsiUpper: 70,
      rsiLower: 30,
      stopLossPercent: "1.5",
      largeVolumeThreshold: 8000,
      recentWinRate: "0",
      recentProfitRate: "0",
    });
    const newRows = await db.select().from(algorithmConfig).limit(1);
    return newRows[0] ?? null;
  }
  return rows[0];
}

export async function updateAlgorithmConfig(data: {
  rsiUpper?: number;
  rsiLower?: number;
  stopLossPercent?: string;
  largeVolumeThreshold?: number;
  recentWinRate?: string;
  recentProfitRate?: string;
}) {
  const db = await getDb();
  if (!db) return null;

  const existing = await getAlgorithmConfig();
  if (!existing) return null;

  await db.update(algorithmConfig).set(data).where(eq(algorithmConfig.id, existing.id));
  return getAlgorithmConfig();
}

// ============================================================
// Daily Report helpers
// ============================================================
export async function getDailyReportByDate(reportDate: string) {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(dailyReports)
    .where(eq(dailyReports.reportDate, reportDate))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDailyReportList(limit = 30) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(dailyReports).orderBy(desc(dailyReports.reportDate)).limit(limit);
}

export async function getDailyReportWithStocks(reportDate: string) {
  const db = await getDb();
  if (!db) return null;

  const report = await getDailyReportByDate(reportDate);
  if (!report) return null;

  const stocks = await db
    .select()
    .from(stockReports)
    .where(eq(stockReports.dailyReportId, report.id));
  return { report, stocks };
}

export async function saveDailyReport(
  reportData: Omit<InsertDailyReport, "id" | "createdAt" | "updatedAt">,
  stockData: Omit<InsertStockReport, "id" | "dailyReportId" | "createdAt">[]
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 既存レポートがあれば削除して再作成
  const existing = await getDailyReportByDate(reportData.reportDate);
  if (existing) {
    await db.delete(stockReports).where(eq(stockReports.dailyReportId, existing.id));
    await db.delete(dailyReports).where(eq(dailyReports.id, existing.id));
  }

  await db.insert(dailyReports).values(reportData);
  const newReport = await getDailyReportByDate(reportData.reportDate);
  if (!newReport) throw new Error("Failed to save daily report");

  if (stockData.length > 0) {
    await db.insert(stockReports).values(
      stockData.map((s) => ({ ...s, dailyReportId: newReport.id }))
    );
  }

  return newReport;
}

/**
 * 直近N営業日の「銘柄別の調子（実績）」を集計する。
 * 事前推奨（明日の推奨銘柄）の算出に使う。後知恵にならないよう、
 * 指定日（excludeDate）より前のレポートだけを対象にできる。
 *
 * @param days 集計対象の営業日数（既定10）
 * @param excludeDate この日付以降を除外（YYYY-MM-DD）。当日の結果を見ないようにするため。
 */
export async function getSymbolPerformanceHistory(days = 10, excludeDate?: string) {
  const db = await getDb();
  if (!db) return [] as Array<{
    symbol: string;
    name: string;
    appearances: number;
    totalProfit: number;
    totalWin: number;
    totalLoss: number;
    avgWinRate: number;
  }>;

  // 対象の daily_reports を取得（excludeDate より前、新しい順に days 件）
  let reportRows = await db
    .select()
    .from(dailyReports)
    .orderBy(desc(dailyReports.reportDate));

  if (excludeDate) {
    reportRows = reportRows.filter((r) => r.reportDate < excludeDate);
  }
  reportRows = reportRows.slice(0, days);

  if (reportRows.length === 0) return [];

  const reportIds = reportRows.map((r) => r.id);
  const stocks = await db
    .select()
    .from(stockReports)
    .where(inArray(stockReports.dailyReportId, reportIds));

  // 銘柄ごとに集計
  const agg = new Map<string, {
    symbol: string;
    name: string;
    appearances: number;
    totalProfit: number;
    totalWin: number;
    totalLoss: number;
    winRateSum: number;
  }>();

  for (const s of stocks) {
    const cur = agg.get(s.symbol) ?? {
      symbol: s.symbol,
      name: s.name,
      appearances: 0,
      totalProfit: 0,
      totalWin: 0,
      totalLoss: 0,
      winRateSum: 0,
    };
    cur.appearances += 1;
    cur.totalProfit += Number(s.profitAmount);
    cur.totalWin += Number(s.winCount);
    cur.totalLoss += Number(s.tradesCount) - Number(s.winCount);
    cur.winRateSum += parseFloat(String(s.winRate));
    agg.set(s.symbol, cur);
  }

  return Array.from(agg.values()).map((a) => ({
    symbol: a.symbol,
    name: a.name,
    appearances: a.appearances,
    totalProfit: a.totalProfit,
    totalWin: a.totalWin,
    totalLoss: a.totalLoss,
    avgWinRate: a.appearances > 0 ? a.winRateSum / a.appearances : 0,
  }));
}

// ============================================================
// Algorithm Improvement helpers
// ============================================================
export async function saveAlgorithmImprovement(
  data: Omit<InsertAlgorithmImprovement, "id" | "appliedAt">
) {
  const db = await getDb();
  if (!db) return;

  await db.insert(algorithmImprovements).values(data);
}

export async function getAlgorithmImprovements(limit = 20) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(algorithmImprovements)
    .orderBy(desc(algorithmImprovements.appliedAt))
    .limit(limit);
}

// ============================================================
// Statistics helpers
// ============================================================
export async function getRecentStats(days = 30) {
  const db = await getDb();
  if (!db) return { totalDays: 0, avgWinRate: 0, avgProfitRate: 0, totalProfit: 0, reports: [] };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const reports = await db
    .select()
    .from(dailyReports)
    .where(gte(dailyReports.reportDate, cutoffStr))
    .orderBy(desc(dailyReports.reportDate));

  if (reports.length === 0) {
    return { totalDays: 0, avgWinRate: 0, avgProfitRate: 0, totalProfit: 0, reports: [] };
  }

  const totalDays = reports.length;
  const avgWinRate =
    reports.reduce((sum, r) => sum + parseFloat(String(r.overallWinRate)), 0) / totalDays;
  const avgProfitRate =
    reports.reduce((sum, r) => sum + parseFloat(String(r.totalProfitRate)), 0) / totalDays;
  const totalProfit = reports.reduce((sum, r) => sum + Number(r.totalProfitAmount), 0);

  return { totalDays, avgWinRate, avgProfitRate, totalProfit, reports };
}

// ============================================================
// Paper Trade (仮想売買) helpers
// ============================================================

/**
 * 仮想売買の損益を計算する純粋関数（テスト可能）。
 * long（買建）: (決済価格 - エントリー価格) × 株数
 * short（空売り）: (エントリー価格 - 決済価格) × 株数
 * 結果は円単位に丸める。
 */
export function computePaperTradePnl(params: {
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
}): number {
  const { side, entryPrice, exitPrice, quantity } = params;
  return side === "long"
    ? Math.round((exitPrice - entryPrice) * quantity)
    : Math.round((entryPrice - exitPrice) * quantity);
}

/**
 * 仮想売買のエントリーを記録する。
 */
export async function createPaperTrade(
  data: Omit<InsertPaperTrade, "id" | "status" | "exitPrice" | "pnl" | "exitAt" | "createdAt">
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(paperTrades).values({ ...data, status: "open" });

  const rows = await db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.userId, data.userId))
    .orderBy(desc(paperTrades.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 仮想売買を決済する。決済価格を受け取り、損益を計算して closed に更新する。
 * long: (決済価格 - エントリー価格) × 株数
 * short: (エントリー価格 - 決済価格) × 株数
 */
export async function closePaperTrade(params: {
  id: number;
  userId: number;
  exitPrice: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(paperTrades)
    .where(and(eq(paperTrades.id, params.id), eq(paperTrades.userId, params.userId)))
    .limit(1);
  const trade = rows[0];
  if (!trade) throw new Error("Paper trade not found");
  if (trade.status === "closed") throw new Error("Paper trade already closed");

  const entry = parseFloat(String(trade.entryPrice));
  const exit = params.exitPrice;
  const qty = Number(trade.quantity);
  const pnl = computePaperTradePnl({
    side: trade.side,
    entryPrice: entry,
    exitPrice: exit,
    quantity: qty,
  });

  await db
    .update(paperTrades)
    .set({
      status: "closed",
      exitPrice: String(exit),
      pnl,
      exitAt: new Date(),
    })
    .where(and(eq(paperTrades.id, params.id), eq(paperTrades.userId, params.userId)));

  const updated = await db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.id, params.id))
    .limit(1);
  return updated[0] ?? null;
}

/**
 * 指定ユーザーの仮想売買履歴を新しい順に取得する。
 */
export async function getPaperTrades(userId: number, limit = 200) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.userId, userId))
    .orderBy(desc(paperTrades.id))
    .limit(limit);
}

/**
 * 指定ユーザーの保有中（open）ポジション数を取得する。
 * 同時保有制限のチェックに使う。
 */
export async function getOpenPaperTradeCount(userId: number) {
  const db = await getDb();
  if (!db) return 0;

  const rows = await db
    .select()
    .from(paperTrades)
    .where(and(eq(paperTrades.userId, userId), eq(paperTrades.status, "open")));
  return rows.length;
}

/**
 * 指定の仮想売買を削除する（誤記録の取り消し用）。
 */
export async function deletePaperTrade(params: { id: number; userId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .delete(paperTrades)
    .where(and(eq(paperTrades.id, params.id), eq(paperTrades.userId, params.userId)));
}

// ============================================================
// kabuステーション® プラン期限管理 helpers
// ============================================================

/**
 * 現在のプラン設定を取得（常に1レコードのみ）
 */
export async function getKabuPlanSettings(): Promise<KabuPlanSettings | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db.select().from(kabuPlanSettings).orderBy(desc(kabuPlanSettings.id)).limit(1);
  return rows[0] ?? null;
}

/**
 * プラン設定を保存（初回は挿入、以降は更新）
 */
export async function upsertKabuPlanSettings(data: {
  planType: "normal" | "professional" | "premium";
  planExpiresAt: string;
  note?: string;
}): Promise<KabuPlanSettings> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getKabuPlanSettings();
  if (existing) {
    await db
      .update(kabuPlanSettings)
      .set({
        planType: data.planType,
        planExpiresAt: data.planExpiresAt,
        note: data.note ?? existing.note,
        // 期限日が変わった場合はリマインドフラグをリセット
        reminderSent: existing.planExpiresAt !== data.planExpiresAt ? false : existing.reminderSent,
        reminderSentAt: existing.planExpiresAt !== data.planExpiresAt ? null : existing.reminderSentAt,
      })
      .where(eq(kabuPlanSettings.id, existing.id));
  } else {
    await db.insert(kabuPlanSettings).values({
      planType: data.planType,
      planExpiresAt: data.planExpiresAt,
      note: data.note,
    });
  }

  const updated = await getKabuPlanSettings();
  if (!updated) throw new Error("Failed to upsert kabu plan settings");
  return updated;
}

/**
 * リマインド送信済みフラグを立てる
 */
export async function markKabuPlanReminderSent(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(kabuPlanSettings)
    .set({ reminderSent: true, reminderSentAt: new Date() })
    .where(eq(kabuPlanSettings.id, id));
}

// ============================================================
// リアルタイムシミュレーション helpers
// ============================================================

import {
  rtCandles,
  rtTrades,
  rtDailySummaries,
  rtScore0Blocks,
  rtTaiyoCandidateBEvents,
  rtSocionextConfirmedLongEvents,
  rtSumcoBreakdownShortEvents,
  rtSoftbankBreakoutLongEvents,
  rtKioxiaConfirmedMorningLongEvents,
  rtTelOpenDirectionBreakoutEvents,
  rtKioxiaShortGuardEvents,
  rtSourceEvents,
  rtShadowDispatchQueue,
  rtStrategyVersions,
  rtForwardShadowEvents,
  rtForwardShadowStates,
  rtForwardShadowLocks,
  rtForwardShadowTrades,
  rtCurrentEngineLocks,
  rtRealtimeDecisionEvents,
  rtReplayComparisons,
  rtPortfolioAuditEvents,
  rtOutcomeLabels,
  rtDivergenceHypotheses,
  rtSignalCandidates,
  rtSignalCandidateTrades,
  type InsertRtCandle,
  type InsertRtTrade,
  type RtTrade,
  type RtDailySummary,
  type InsertRtScore0Block,
  type RtScore0Block,
  type InsertRtTaiyoCandidateBEvent,
  type RtTaiyoCandidateBEvent,
  type InsertRtSocionextConfirmedLongEvent,
  type RtSocionextConfirmedLongEvent,
  type InsertRtSumcoBreakdownShortEvent,
  type RtSumcoBreakdownShortEvent,
  type InsertRtSoftbankBreakoutLongEvent,
  type RtSoftbankBreakoutLongEvent,
  type InsertRtKioxiaConfirmedMorningLongEvent,
  type RtKioxiaConfirmedMorningLongEvent,
  type InsertRtTelOpenDirectionBreakoutEvent,
  type RtTelOpenDirectionBreakoutEvent,
  type InsertRtKioxiaShortGuardEvent,
  type RtKioxiaShortGuardEvent,
  type InsertRtSourceEvent,
  type RtSourceEvent,
  type InsertRtShadowDispatchQueue,
  type RtShadowDispatchQueue,
  type InsertRtStrategyVersion,
  type RtStrategyVersion,
  type InsertRtForwardShadowEvent,
  type RtForwardShadowEvent,
  type InsertRtForwardShadowState,
  type RtForwardShadowState,
  type InsertRtForwardShadowTrade,
  type RtForwardShadowTrade,
  type InsertRtRealtimeDecisionEvent,
  type RtRealtimeDecisionEvent,
  type InsertRtReplayComparison,
  type RtReplayComparison,
  type InsertRtPortfolioAuditEvent,
  type RtPortfolioAuditEvent,
  type InsertRtOutcomeLabel,
  type RtOutcomeLabel,
  type InsertRtDivergenceHypothesis,
  type RtDivergenceHypothesis,
  type InsertRtSignalCandidate,
  type RtSignalCandidate,
  type InsertRtSignalCandidateTrade,
  type RtSignalCandidateTrade,
} from "../drizzle/schema";

/**
 * 1分足ローソク足を保存する
 */
export async function insertRtCandle(data: Omit<InsertRtCandle, "id" | "createdAt">) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtCandles).values(data);
}

/**
 * 指定日・銘柄の1分足を時刻順に取得する
 */
export async function getRtCandles(symbol: string, tradeDate: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtCandles)
    .where(and(eq(rtCandles.symbol, symbol), eq(rtCandles.tradeDate, tradeDate)))
    .orderBy(rtCandles.candleTime);
}

/**
 * 指定日の全銘柄1分足を時刻順に取得する（サーバー起動時のバッファ復元用）
 */
export async function getRtCandlesAllForDate(tradeDate: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtCandles)
    .where(eq(rtCandles.tradeDate, tradeDate))
    .orderBy(rtCandles.symbol, rtCandles.candleTime);
}

/**
 * リアルタイム架空取引を記録する
 */
export async function insertRtTrade(data: Omit<InsertRtTrade, "id" | "createdAt">) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtTrades).values(data);
}

/**
 * 指定日の架空取引ログを取得する（新しい順）
 */
export async function getRtTradesForDate(tradeDate: string): Promise<RtTrade[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtTrades)
    .where(eq(rtTrades.tradeDate, tradeDate))
    .orderBy(desc(rtTrades.id));
}

/** 同一イベント処理直後に、その銘柄・時刻で最後に保存されたDRY_RUN取引を取得する。 */
export async function getLatestRtTradeAt(input: {
  tradeDate: string;
  symbol: string;
  tradeTime: string;
}): Promise<RtTrade | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select().from(rtTrades).where(and(
    eq(rtTrades.tradeDate, input.tradeDate),
    eq(rtTrades.symbol, input.symbol),
    eq(rtTrades.tradeTime, input.tradeTime),
  )).orderBy(desc(rtTrades.id)).limit(1))[0] ?? null;
}

/**
 * 指定日の日次サマリーを取得する
 */
export async function getRtDailySummary(tradeDate: string): Promise<RtDailySummary | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(rtDailySummaries)
    .where(eq(rtDailySummaries.tradeDate, tradeDate))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 日次サマリーを保存（初回は挿入、以降は更新）
 */
export async function upsertRtDailySummary(data: {
  tradeDate: string;
  initialCapital: number;
  totalPnl: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  candlesReceived: number;
  reportSent?: boolean;
  reportSentAt?: Date | null;
}): Promise<RtDailySummary> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getRtDailySummary(data.tradeDate);
  if (existing) {
    await db
      .update(rtDailySummaries)
      .set({
        initialCapital: data.initialCapital,
        totalPnl: data.totalPnl,
        tradesCount: data.tradesCount,
        winCount: data.winCount,
        lossCount: data.lossCount,
        candlesReceived: data.candlesReceived,
        ...(data.reportSent !== undefined ? { reportSent: data.reportSent } : {}),
        ...(data.reportSentAt !== undefined ? { reportSentAt: data.reportSentAt } : {}),
      })
      .where(eq(rtDailySummaries.id, existing.id));
  } else {
    await db.insert(rtDailySummaries).values({
      tradeDate: data.tradeDate,
      initialCapital: data.initialCapital,
      totalPnl: data.totalPnl,
      tradesCount: data.tradesCount,
      winCount: data.winCount,
      lossCount: data.lossCount,
      candlesReceived: data.candlesReceived,
      reportSent: data.reportSent ?? false,
      reportSentAt: data.reportSentAt ?? null,
    });
  }

  const updated = await getRtDailySummary(data.tradeDate);
  if (!updated) throw new Error("Failed to upsert rt daily summary");
  return updated;
}

/**
 * レポート送信済みフラグを立てる
 */
export async function markRtDailySummaryReportSent(tradeDate: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(rtDailySummaries)
    .set({ reportSent: true, reportSentAt: new Date() })
    .where(eq(rtDailySummaries.tradeDate, tradeDate));
}

/**
 * 直近N日の日次サマリー一覧を取得する
 */
export async function getRtDailySummaryList(limit = 30): Promise<RtDailySummary[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtDailySummaries)
    .orderBy(desc(rtDailySummaries.tradeDate))
    .limit(limit);
}

/**
 * 指定日のオープンポジション（エントリーのみで決済されていない銘柄）をDBから取得する。
 * サーバー再起動等でメモリが消えた場合の大引け強制決済に使用する。
 *
 * 仕組み: rt_tradesを銘柄ごとにグループ化し、
 *   - buy/shortの件数 > sell/coverの件数 → まだオープン
 * となる銘柄のエントリーレコードを返す。
 */
export async function getRtOpenPositionsFromDb(tradeDate: string): Promise<RtTrade[]> {
  const db = await getDb();
  if (!db) return [];

  // 当日の全取引を取得
  const trades = await db
    .select()
    .from(rtTrades)
    .where(eq(rtTrades.tradeDate, tradeDate))
    .orderBy(rtTrades.id);

  // 銘柄ごとにエントリー/決済をカウント
  const entryCount = new Map<string, number>();
  const exitCount = new Map<string, number>();
  const lastEntry = new Map<string, RtTrade>();

  for (const t of trades) {
    if (t.action === "buy" || t.action === "short") {
      entryCount.set(t.symbol, (entryCount.get(t.symbol) ?? 0) + 1);
      lastEntry.set(t.symbol, t);
    } else if (t.action === "sell" || t.action === "cover") {
      exitCount.set(t.symbol, (exitCount.get(t.symbol) ?? 0) + 1);
    }
  }

  // エントリー件数 > 決済件数 → オープンポジションあり
  const openEntries: RtTrade[] = [];
  for (const [symbol, ec] of Array.from(entryCount.entries())) {
    const xc = exitCount.get(symbol) ?? 0;
    if (ec > xc) {
      const entry = lastEntry.get(symbol);
      if (entry) openEntries.push(entry);
    }
  }

  return openEntries;
}

// ============================================================
// スコア0+信頼度強ブロック記録 helpers
// ============================================================

/**
 * スコア0+信頼度強でブロックされたシグナルをDBに記録する
 */
export async function insertScore0Block(data: Omit<InsertRtScore0Block, "id" | "createdAt">) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(rtScore0Blocks).values(data);
  } catch (err) {
    console.error("[DB] insertScore0Block error:", err);
  }
}

/**
 * 指定日のスコア0ブロック記録を取得する
 */
export async function getScore0BlocksForDate(tradeDate: string): Promise<RtScore0Block[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtScore0Blocks)
    .where(eq(rtScore0Blocks.tradeDate, tradeDate))
    .orderBy(rtScore0Blocks.id);
}

// ============================================================
// 6976候補B DRY_RUN監査イベント helpers
// ============================================================

export async function upsertTaiyoCandidateBEvent(
  data: Omit<InsertRtTaiyoCandidateBEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtTaiyoCandidateBEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        rejectionCodes: data.rejectionCodes ?? null,
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getTaiyoCandidateBEventsForDate(
  tradeDate: string,
): Promise<RtTaiyoCandidateBEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtTaiyoCandidateBEvents)
    .where(eq(rtTaiyoCandidateBEvents.tradeDate, tradeDate))
    .orderBy(rtTaiyoCandidateBEvents.id);
}

// ============================================================
// 6526確認型LONG DRY_RUN監査イベント helpers
// ============================================================

export async function upsertSocionextConfirmedLongEvent(
  data: Omit<InsertRtSocionextConfirmedLongEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtSocionextConfirmedLongEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        rejectionCodes: data.rejectionCodes ?? null,
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getSocionextConfirmedLongEventsForDate(
  tradeDate: string,
): Promise<RtSocionextConfirmedLongEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtSocionextConfirmedLongEvents)
    .where(eq(rtSocionextConfirmedLongEvents.tradeDate, tradeDate))
    .orderBy(rtSocionextConfirmedLongEvents.id);
}

// ============================================================
// 3436専用SHORT DRY_RUN監査イベント helpers
// ============================================================

export async function upsertSumcoBreakdownShortEvent(
  data: Omit<InsertRtSumcoBreakdownShortEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtSumcoBreakdownShortEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getSumcoBreakdownShortEventsForDate(
  tradeDate: string,
): Promise<RtSumcoBreakdownShortEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtSumcoBreakdownShortEvents)
    .where(eq(rtSumcoBreakdownShortEvents.tradeDate, tradeDate))
    .orderBy(rtSumcoBreakdownShortEvents.id);
}

// ============================================================
// 9984専用LONG DRY_RUN監査イベント helpers
// ============================================================

export async function upsertSoftbankBreakoutLongEvent(
  data: Omit<InsertRtSoftbankBreakoutLongEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtSoftbankBreakoutLongEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getSoftbankBreakoutLongEventsForDate(
  tradeDate: string,
): Promise<RtSoftbankBreakoutLongEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtSoftbankBreakoutLongEvents)
    .where(eq(rtSoftbankBreakoutLongEvents.tradeDate, tradeDate))
    .orderBy(rtSoftbankBreakoutLongEvents.id);
}

// ============================================================
// 285A確認型前場LONG DRY_RUN監査イベント helpers
// ============================================================

export async function upsertKioxiaConfirmedMorningLongEvent(
  data: Omit<InsertRtKioxiaConfirmedMorningLongEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtKioxiaConfirmedMorningLongEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getKioxiaConfirmedMorningLongEventsForDate(
  tradeDate: string,
): Promise<RtKioxiaConfirmedMorningLongEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtKioxiaConfirmedMorningLongEvents)
    .where(eq(rtKioxiaConfirmedMorningLongEvents.tradeDate, tradeDate))
    .orderBy(rtKioxiaConfirmedMorningLongEvents.id);
}

// ============================================================
// 8035始値方向付き短期ブレイク DRY_RUN監査イベント helpers
// ============================================================

export async function upsertTelOpenDirectionBreakoutEvent(
  data: Omit<InsertRtTelOpenDirectionBreakoutEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtTelOpenDirectionBreakoutEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getTelOpenDirectionBreakoutEventsForDate(
  tradeDate: string,
): Promise<RtTelOpenDirectionBreakoutEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtTelOpenDirectionBreakoutEvents)
    .where(eq(rtTelOpenDirectionBreakoutEvents.tradeDate, tradeDate))
    .orderBy(rtTelOpenDirectionBreakoutEvents.id);
}

// ============================================================
// 285A SHORTガード DRY_RUN監査イベント helpers
// ============================================================

export async function upsertKioxiaShortGuardEvent(
  data: Omit<InsertRtKioxiaShortGuardEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(rtKioxiaShortGuardEvents)
    .values(data)
    .onDuplicateKeyUpdate({
      set: {
        observedValue: data.observedValue,
        thresholdValue: data.thresholdValue,
        averageVolume: data.averageVolume ?? null,
        zeroVolumeBars: data.zeroVolumeBars ?? 0,
        detail: data.detail ?? null,
        referencePrice: data.referencePrice,
      },
    });
}

export async function getKioxiaShortGuardEventsForDate(
  tradeDate: string,
): Promise<RtKioxiaShortGuardEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtKioxiaShortGuardEvents)
    .where(eq(rtKioxiaShortGuardEvents.tradeDate, tradeDate))
    .orderBy(rtKioxiaShortGuardEvents.id);
}

// ============================================================
// 未見データ前向き評価・受信イベント監査 helpers
// ============================================================

function isDuplicateEntryError(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return candidate.code === "ER_DUP_ENTRY"
    || candidate.errno === 1062
    || candidate.cause?.code === "ER_DUP_ENTRY"
    || candidate.cause?.errno === 1062;
}

/** relay生イベントを一度だけ受理し、重複時はfalseを返す。 */
export async function claimRtSourceEvent(
  data: Omit<InsertRtSourceEvent, "id" | "createdAt" | "processedAt">,
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(rtSourceEvents).values(data);
    return true;
  } catch (error) {
    if (isDuplicateEntryError(error)) return false;
    throw error;
  }
}

/** processing中にworkerが停止した親イベントだけを、期限切れlease後にCASで回収する。 */
export async function reclaimRtSourceEventProcessing(input: {
  sourceEventId: string;
  ownerToken: string;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<RtSourceEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const row = (await db.select().from(rtSourceEvents)
    .where(eq(rtSourceEvents.sourceEventId, input.sourceEventId)).limit(1))[0];
  if (!row || row.status !== "processing") return null;
  const now = new Date();
  if (row.leaseUntil && row.leaseUntil > now) return null;
  if (row.attemptCount >= (input.maxAttempts ?? 5)) return null;
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30_000));
  await db.update(rtSourceEvents).set({
    claimToken: input.ownerToken,
    leaseUntil,
    attemptCount: sql`${rtSourceEvents.attemptCount} + 1`,
    errorDetail: null,
  }).where(and(
    eq(rtSourceEvents.id, row.id),
    eq(rtSourceEvents.status, "processing"),
    eq(rtSourceEvents.attemptCount, row.attemptCount),
    or(isNull(rtSourceEvents.leaseUntil), lt(rtSourceEvents.leaseUntil, now)),
  ));
  const claimed = (await db.select().from(rtSourceEvents)
    .where(eq(rtSourceEvents.id, row.id)).limit(1))[0];
  return claimed?.claimToken === input.ownerToken ? claimed : null;
}

export async function markRtSourceEventEngineStarted(input: {
  sourceEventId: string;
  ownerToken: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtSourceEvents).set({
    processingStage: "engine_started",
  }).where(and(
    eq(rtSourceEvents.sourceEventId, input.sourceEventId),
    eq(rtSourceEvents.status, "processing"),
    eq(rtSourceEvents.processingStage, "claimed"),
    eq(rtSourceEvents.claimToken, input.ownerToken),
  ));
  const row = (await db.select().from(rtSourceEvents)
    .where(eq(rtSourceEvents.sourceEventId, input.sourceEventId)).limit(1))[0];
  return row?.claimToken === input.ownerToken && row.processingStage === "engine_started";
}

export async function getRtSourceEvent(sourceEventId: string): Promise<RtSourceEvent | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(rtSourceEvents)
    .where(eq(rtSourceEvents.sourceEventId, sourceEventId)).limit(1);
  return rows[0] ?? null;
}

export async function getPriorRtSourceEventForCandle(input: {
  sourceEventId: string;
  symbol: string;
  tradeDate: string;
  candleTime: string;
}): Promise<RtSourceEvent | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(rtSourceEvents).where(and(
    eq(rtSourceEvents.symbol, input.symbol),
    eq(rtSourceEvents.tradeDate, input.tradeDate),
    eq(rtSourceEvents.candleTime, input.candleTime),
    ne(rtSourceEvents.sourceEventId, input.sourceEventId),
  )).orderBy(desc(rtSourceEvents.id)).limit(1);
  return rows[0] ?? null;
}

export async function getRtSourceEventsForDate(tradeDate: string): Promise<RtSourceEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtSourceEvents)
    .where(eq(rtSourceEvents.tradeDate, tradeDate))
    .orderBy(rtSourceEvents.id);
}

export async function completeRtSourceEvent(input: {
  sourceEventId: string;
  status: "processed" | "failed" | "payload_mismatch";
  resultAction?: string | null;
  resultJson?: unknown;
  errorDetail?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtSourceEvents).set({
    status: input.status,
    processingStage: "engine_completed",
    claimToken: null,
    leaseUntil: null,
    resultAction: input.resultAction ?? null,
    resultJson: input.resultJson ?? null,
    errorDetail: input.errorDetail ?? null,
    processedAt: new Date(),
  }).where(eq(rtSourceEvents.sourceEventId, input.sourceEventId));
}

export async function upsertRtStrategyVersion(
  data: Omit<InsertRtStrategyVersion, "createdAt" | "updatedAt">,
): Promise<void> {
  const { assertForwardCandidateRiskReward } = await import("./forwardStrategyRegistration");
  assertForwardCandidateRiskReward(data);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtStrategyVersions).values(data).onDuplicateKeyUpdate({
    set: {
      buildGitSha: data.buildGitSha,
      sourceTreeHash: data.sourceTreeHash,
      evaluationPurpose: data.evaluationPurpose,
      eligibleForAdoption: data.eligibleForAdoption,
      ...(data.eligibleForAdoption === false ? {
        status: data.status,
        statusReason: data.statusReason,
      } : {}),
    },
  });
}

export async function getRtStrategyVersion(versionId: string): Promise<RtStrategyVersion | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(rtStrategyVersions)
    .where(eq(rtStrategyVersions.versionId, versionId)).limit(1);
  return rows[0] ?? null;
}

export async function updateRtStrategyVersionStatus(input: {
  versionId: string;
  status: RtStrategyVersion["status"];
  statusReason: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtStrategyVersions).set({
    status: input.status,
    statusReason: input.statusReason,
  }).where(eq(rtStrategyVersions.versionId, input.versionId));
}

export async function claimRtForwardShadowEvent(
  data: Omit<InsertRtForwardShadowEvent, "id" | "createdAt">,
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(rtForwardShadowEvents).values(data);
    return true;
  } catch (error) {
    if (isDuplicateEntryError(error)) return false;
    throw error;
  }
}

export type RtForwardShadowClaimResult = "claimed" | "completed" | "busy";

/**
 * シャドー判断専用claim。errorだけを期限付きで再試行し、完了済み判断は再実行しない。
 * 現行売買のsource-event claimとは独立しているため、再試行で実売買処理を二重実行しない。
 */
export async function claimOrRetryRtForwardShadowEvent(input: {
  data: Omit<InsertRtForwardShadowEvent, "id" | "createdAt" | "claimToken" | "claimUntil" | "attemptCount" | "lastError">;
  claimToken: string;
  leaseMs?: number;
}): Promise<RtForwardShadowClaimResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const claimUntil = new Date(now.getTime() + (input.leaseMs ?? 30_000));
  try {
    await db.insert(rtForwardShadowEvents).values({
      ...input.data,
      claimToken: input.claimToken,
      claimUntil,
      attemptCount: 1,
      lastError: null,
    });
    return "claimed";
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
  }

  const keyWhere = and(
    eq(rtForwardShadowEvents.strategyVersion, input.data.strategyVersion),
    eq(rtForwardShadowEvents.sourceEventId, input.data.sourceEventId),
    eq(rtForwardShadowEvents.evaluationMode, input.data.evaluationMode),
  );
  const existing = (await db.select().from(rtForwardShadowEvents).where(keyWhere).limit(1))[0];
  if (!existing) return "busy";
  if (existing.resultType !== "error") return "completed";
  if (existing.claimUntil && existing.claimUntil.getTime() > now.getTime()) return "busy";

  await db.update(rtForwardShadowEvents).set({
    resultType: "pending",
    decisionJson: { status: "retry_claimed" },
    claimToken: input.claimToken,
    claimUntil,
    attemptCount: sql`${rtForwardShadowEvents.attemptCount} + 1`,
    lastError: null,
  }).where(and(
    keyWhere,
    eq(rtForwardShadowEvents.resultType, "error"),
    or(isNull(rtForwardShadowEvents.claimUntil), lt(rtForwardShadowEvents.claimUntil, now)),
  ));
  const claimed = (await db.select().from(rtForwardShadowEvents).where(keyWhere).limit(1))[0];
  return claimed?.claimToken === input.claimToken ? "claimed" : "busy";
}

export async function failRtForwardShadowEvent(input: {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: RtForwardShadowEvent["evaluationMode"];
  errorDetail: string;
  stateHashBefore: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtForwardShadowEvents).set({
    resultType: "error",
    decisionJson: { error: input.errorDetail },
    stateHashAfter: input.stateHashBefore,
    claimToken: null,
    claimUntil: null,
    lastError: input.errorDetail,
  }).where(and(
    eq(rtForwardShadowEvents.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowEvents.sourceEventId, input.sourceEventId),
    eq(rtForwardShadowEvents.evaluationMode, input.evaluationMode),
  ));
}

export async function updateRtForwardShadowEvent(input: {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: RtForwardShadowEvent["evaluationMode"];
  resultType: RtForwardShadowEvent["resultType"];
  decisionJson: unknown;
  stateHashAfter: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtForwardShadowEvents).set({
    resultType: input.resultType,
    decisionJson: input.decisionJson,
    stateHashAfter: input.stateHashAfter,
    claimToken: null,
    claimUntil: null,
    lastError: null,
  }).where(and(
    eq(rtForwardShadowEvents.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowEvents.sourceEventId, input.sourceEventId),
    eq(rtForwardShadowEvents.evaluationMode, input.evaluationMode),
  ));
}

export async function getRtForwardShadowEventsForDate(
  tradeDate: string,
): Promise<RtForwardShadowEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtForwardShadowEvents)
    .where(eq(rtForwardShadowEvents.tradeDate, tradeDate))
    .orderBy(rtForwardShadowEvents.id);
}

export async function getRtForwardShadowState(input: {
  strategyVersion: string;
  evaluationMode: RtForwardShadowState["evaluationMode"];
}): Promise<RtForwardShadowState | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(rtForwardShadowStates).where(and(
    eq(rtForwardShadowStates.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowStates.evaluationMode, input.evaluationMode),
  )).limit(1);
  return rows[0] ?? null;
}

export async function upsertRtForwardShadowState(
  data: Omit<InsertRtForwardShadowState, "id" | "updatedAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtForwardShadowStates).values(data).onDuplicateKeyUpdate({
    set: {
      stateJson: data.stateJson,
      stateHash: data.stateHash,
      lastSourceEventId: data.lastSourceEventId ?? null,
    },
  });
}

/** strategyVersion・評価方式単位の短時間リースを取得する。 */
export async function acquireRtForwardShadowStateLock(input: {
  strategyVersion: string;
  evaluationMode: RtForwardShadowState["evaluationMode"];
  ownerToken: string;
  leaseMs?: number;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(rtForwardShadowLocks).values({
      strategyVersion: input.strategyVersion,
      evaluationMode: input.evaluationMode,
      ownerToken: null,
      leaseUntil: null,
    });
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
  }
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30_000));
  await db.update(rtForwardShadowLocks).set({
    ownerToken: input.ownerToken,
    leaseUntil,
  }).where(and(
    eq(rtForwardShadowLocks.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowLocks.evaluationMode, input.evaluationMode),
    or(
      isNull(rtForwardShadowLocks.ownerToken),
      isNull(rtForwardShadowLocks.leaseUntil),
      lt(rtForwardShadowLocks.leaseUntil, now),
      eq(rtForwardShadowLocks.ownerToken, input.ownerToken),
    ),
  ));
  const row = (await db.select().from(rtForwardShadowLocks).where(and(
    eq(rtForwardShadowLocks.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowLocks.evaluationMode, input.evaluationMode),
  )).limit(1))[0];
  return row?.ownerToken === input.ownerToken;
}

export async function releaseRtForwardShadowStateLock(input: {
  strategyVersion: string;
  evaluationMode: RtForwardShadowState["evaluationMode"];
  ownerToken: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtForwardShadowLocks).set({ ownerToken: null, leaseUntil: null }).where(and(
    eq(rtForwardShadowLocks.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowLocks.evaluationMode, input.evaluationMode),
    eq(rtForwardShadowLocks.ownerToken, input.ownerToken),
  ));
}

export async function insertRtForwardShadowTrade(
  data: Omit<InsertRtForwardShadowTrade, "id" | "createdAt" | "closedAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtForwardShadowTrades).values(data).onDuplicateKeyUpdate({
    set: { entrySourceEventId: data.entrySourceEventId },
  });
}

export async function closeRtForwardShadowTrade(input: {
  strategyVersion: string;
  evaluationMode: RtForwardShadowTrade["evaluationMode"];
  entrySourceEventId: string;
  exitSourceEventId: string;
  exitTradeDate: string;
  exitCandleTime: string;
  exitPrice: string;
  exitReason: string;
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtForwardShadowTrades).set({
    exitSourceEventId: input.exitSourceEventId,
    exitTradeDate: input.exitTradeDate,
    exitCandleTime: input.exitCandleTime,
    exitPrice: input.exitPrice,
    exitReason: input.exitReason,
    pnl: input.pnl,
    pnlAfterAdverseExit: input.pnlAfterAdverseExit,
    realizedR: input.realizedR,
    closedAt: new Date(),
  }).where(and(
    eq(rtForwardShadowTrades.strategyVersion, input.strategyVersion),
    eq(rtForwardShadowTrades.evaluationMode, input.evaluationMode),
    eq(rtForwardShadowTrades.entrySourceEventId, input.entrySourceEventId),
  ));
}

export async function getRtForwardShadowTrades(
  strategyVersion: string,
): Promise<RtForwardShadowTrade[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtForwardShadowTrades)
    .where(eq(rtForwardShadowTrades.strategyVersion, strategyVersion))
    .orderBy(rtForwardShadowTrades.id);
}

// ============================================================
// 現行実時・固定版再生・因果性・共有資金 監査 helpers
// ============================================================

/** 現行processCandle全体を複数サーバー間でも一列に実行する短時間リース。 */
export async function acquireRtCurrentEngineLock(input: {
  lockName: string;
  ownerToken: string;
  leaseMs?: number;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(rtCurrentEngineLocks).values({
      lockName: input.lockName,
      ownerToken: null,
      leaseUntil: null,
    });
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
  }
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30_000));
  await db.update(rtCurrentEngineLocks).set({
    ownerToken: input.ownerToken,
    leaseUntil,
  }).where(and(
    eq(rtCurrentEngineLocks.lockName, input.lockName),
    or(
      isNull(rtCurrentEngineLocks.ownerToken),
      isNull(rtCurrentEngineLocks.leaseUntil),
      lt(rtCurrentEngineLocks.leaseUntil, now),
      eq(rtCurrentEngineLocks.ownerToken, input.ownerToken),
    ),
  ));
  const row = (await db.select().from(rtCurrentEngineLocks)
    .where(eq(rtCurrentEngineLocks.lockName, input.lockName)).limit(1))[0];
  return row?.ownerToken === input.ownerToken;
}

export async function releaseRtCurrentEngineLock(input: {
  lockName: string;
  ownerToken: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtCurrentEngineLocks).set({ ownerToken: null, leaseUntil: null }).where(and(
    eq(rtCurrentEngineLocks.lockName, input.lockName),
    eq(rtCurrentEngineLocks.ownerToken, input.ownerToken),
  ));
}

export async function insertRtRealtimeDecisionEvent(
  data: Omit<InsertRtRealtimeDecisionEvent, "id" | "createdAt">,
): Promise<RtRealtimeDecisionEvent> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtRealtimeDecisionEvents).values(data).onDuplicateKeyUpdate({
    set: { sourceEventId: data.sourceEventId },
  });
  const row = (await db.select().from(rtRealtimeDecisionEvents)
    .where(eq(rtRealtimeDecisionEvents.sourceEventId, data.sourceEventId)).limit(1))[0];
  if (!row) throw new Error(`Realtime decision event not found after insert: ${data.sourceEventId}`);
  return row;
}

export async function getRtRealtimeDecisionEvent(sourceEventId: string): Promise<RtRealtimeDecisionEvent | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select().from(rtRealtimeDecisionEvents)
    .where(eq(rtRealtimeDecisionEvents.sourceEventId, sourceEventId)).limit(1))[0] ?? null;
}

export async function getRtRealtimeDecisionEventsForDate(tradeDate: string): Promise<RtRealtimeDecisionEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtRealtimeDecisionEvents)
    .where(eq(rtRealtimeDecisionEvents.tradeDate, tradeDate))
    .orderBy(rtRealtimeDecisionEvents.id);
}

/** candidate台帳・100株virtual更新outboxの未完了先頭行をCASでclaimする。 */
export async function claimNextRtCandidateVirtualWork(input: {
  ownerToken: string;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<RtRealtimeDecisionEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const row = (await db.select().from(rtRealtimeDecisionEvents)
    .where(ne(rtRealtimeDecisionEvents.candidateVirtualStatus, "processed"))
    .orderBy(rtRealtimeDecisionEvents.id)
    .limit(1))[0];
  if (!row) return null;
  const now = new Date();
  if (row.candidateVirtualStatus === "processing"
    && row.candidateVirtualLeaseUntil
    && row.candidateVirtualLeaseUntil > now) return null;
  if (row.candidateVirtualAttemptCount >= (input.maxAttempts ?? 5)) return null;
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30_000));
  await db.update(rtRealtimeDecisionEvents).set({
    candidateVirtualStatus: "processing",
    candidateVirtualClaimToken: input.ownerToken,
    candidateVirtualLeaseUntil: leaseUntil,
    candidateVirtualAttemptCount: sql`${rtRealtimeDecisionEvents.candidateVirtualAttemptCount} + 1`,
    candidateVirtualLastError: null,
  }).where(and(
    eq(rtRealtimeDecisionEvents.id, row.id),
    eq(rtRealtimeDecisionEvents.candidateVirtualAttemptCount, row.candidateVirtualAttemptCount),
    or(
      eq(rtRealtimeDecisionEvents.candidateVirtualStatus, "pending"),
      eq(rtRealtimeDecisionEvents.candidateVirtualStatus, "error"),
      and(
        eq(rtRealtimeDecisionEvents.candidateVirtualStatus, "processing"),
        or(
          isNull(rtRealtimeDecisionEvents.candidateVirtualLeaseUntil),
          lt(rtRealtimeDecisionEvents.candidateVirtualLeaseUntil, now),
        ),
      ),
    ),
  ));
  const claimed = (await db.select().from(rtRealtimeDecisionEvents)
    .where(eq(rtRealtimeDecisionEvents.id, row.id)).limit(1))[0];
  return claimed?.candidateVirtualClaimToken === input.ownerToken ? claimed : null;
}

export async function completeRtCandidateVirtualWork(input: { id: number; ownerToken: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtRealtimeDecisionEvents).set({
    candidateVirtualStatus: "processed",
    candidateVirtualClaimToken: null,
    candidateVirtualLeaseUntil: null,
    candidateVirtualLastError: null,
    candidateVirtualProcessedAt: new Date(),
  }).where(and(
    eq(rtRealtimeDecisionEvents.id, input.id),
    eq(rtRealtimeDecisionEvents.candidateVirtualClaimToken, input.ownerToken),
  ));
}

export async function failRtCandidateVirtualWork(input: { id: number; ownerToken: string; error: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtRealtimeDecisionEvents).set({
    candidateVirtualStatus: "error",
    candidateVirtualClaimToken: null,
    candidateVirtualLeaseUntil: null,
    candidateVirtualLastError: input.error,
  }).where(and(
    eq(rtRealtimeDecisionEvents.id, input.id),
    eq(rtRealtimeDecisionEvents.candidateVirtualClaimToken, input.ownerToken),
  ));
}

export async function enqueueRtShadowDispatch(
  data: Omit<InsertRtShadowDispatchQueue, "id" | "createdAt" | "processedAt" | "status" | "claimToken" | "leaseUntil" | "attemptCount" | "lastError">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtShadowDispatchQueue).values(data).onDuplicateKeyUpdate({
    set: {
      engineSequence: data.engineSequence,
      inputJson: data.inputJson,
    },
  });
}

/**
 * 未完了の最小engineSequenceだけをclaimする。先頭が他workerの有効lease中なら後続を返さず、追い越しを防ぐ。
 */
export async function claimNextRtShadowDispatch(input: {
  ownerToken: string;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<RtShadowDispatchQueue | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const row = (await db.select().from(rtShadowDispatchQueue)
    .where(ne(rtShadowDispatchQueue.status, "processed"))
    .orderBy(rtShadowDispatchQueue.engineSequence)
    .limit(1))[0];
  if (!row) return null;
  const now = new Date();
  const maxAttempts = input.maxAttempts ?? 5;
  if (row.status === "processing" && row.leaseUntil && row.leaseUntil > now) return null;
  if (row.attemptCount >= maxAttempts) return null;
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30_000));
  await db.update(rtShadowDispatchQueue).set({
    status: "processing",
    claimToken: input.ownerToken,
    leaseUntil,
    attemptCount: sql`${rtShadowDispatchQueue.attemptCount} + 1`,
    lastError: null,
  }).where(and(
    eq(rtShadowDispatchQueue.id, row.id),
    // 同時workerが同じ先頭行を読んでも、先にattemptCountを進めた1台だけがclaimを獲得するCAS条件。
    eq(rtShadowDispatchQueue.attemptCount, row.attemptCount),
    or(
      eq(rtShadowDispatchQueue.status, "pending"),
      eq(rtShadowDispatchQueue.status, "error"),
      and(eq(rtShadowDispatchQueue.status, "processing"), lt(rtShadowDispatchQueue.leaseUntil, now)),
    ),
  ));
  const claimed = (await db.select().from(rtShadowDispatchQueue)
    .where(eq(rtShadowDispatchQueue.id, row.id)).limit(1))[0];
  return claimed?.claimToken === input.ownerToken ? claimed : null;
}

export async function completeRtShadowDispatch(input: {
  id: number;
  ownerToken: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtShadowDispatchQueue).set({
    status: "processed",
    claimToken: null,
    leaseUntil: null,
    lastError: null,
    processedAt: new Date(),
  }).where(and(
    eq(rtShadowDispatchQueue.id, input.id),
    eq(rtShadowDispatchQueue.claimToken, input.ownerToken),
  ));
}

export async function failRtShadowDispatch(input: {
  id: number;
  ownerToken: string;
  error: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(rtShadowDispatchQueue).set({
    status: "error",
    claimToken: null,
    leaseUntil: null,
    lastError: input.error,
  }).where(and(
    eq(rtShadowDispatchQueue.id, input.id),
    eq(rtShadowDispatchQueue.claimToken, input.ownerToken),
  ));
}

export async function upsertRtReplayComparison(
  data: Omit<InsertRtReplayComparison, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtReplayComparisons).values(data).onDuplicateKeyUpdate({
    set: {
      engineSequence: data.engineSequence ?? null,
      matchStatus: data.matchStatus,
      isFirstMismatch: data.isFirstMismatch,
      mismatchType: data.mismatchType ?? null,
      realtimeDecisionId: data.realtimeDecisionId ?? null,
      realtimeStateHash: data.realtimeStateHash ?? null,
      replayStateHash: data.replayStateHash ?? null,
      diffJson: data.diffJson ?? null,
      replayResultJson: data.replayResultJson ?? null,
    },
  });
}

export async function getRtReplayComparisonsForDate(input: {
  baselineVersion: string;
  tradeDate: string;
}): Promise<RtReplayComparison[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtReplayComparisons).where(and(
    eq(rtReplayComparisons.baselineVersion, input.baselineVersion),
    eq(rtReplayComparisons.tradeDate, input.tradeDate),
  )).orderBy(rtReplayComparisons.id);
}

export async function upsertRtPortfolioAuditEvent(
  data: Omit<InsertRtPortfolioAuditEvent, "id" | "createdAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtPortfolioAuditEvents).values(data).onDuplicateKeyUpdate({
    set: {
      routeId: data.routeId ?? null,
      side: data.side ?? null,
      priorityRank: data.priorityRank ?? null,
      decision: data.decision,
      shares: data.shares ?? null,
      requiredMargin: data.requiredMargin ?? null,
      marginUsedBefore: data.marginUsedBefore,
      marginUsedAfter: data.marginUsedAfter,
      blockerSourceEventId: data.blockerSourceEventId ?? null,
      blockerSymbol: data.blockerSymbol ?? null,
      detailJson: data.detailJson,
    },
  });
}

export async function getRtPortfolioAuditEventsForDate(input: {
  portfolioVersion: string;
  mode: RtPortfolioAuditEvent["mode"];
  tradeDate: string;
}): Promise<RtPortfolioAuditEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtPortfolioAuditEvents).where(and(
    eq(rtPortfolioAuditEvents.portfolioVersion, input.portfolioVersion),
    eq(rtPortfolioAuditEvents.mode, input.mode),
    eq(rtPortfolioAuditEvents.tradeDate, input.tradeDate),
  )).orderBy(rtPortfolioAuditEvents.id);
}

export async function upsertRtOutcomeLabel(
  data: Omit<InsertRtOutcomeLabel, "id" | "createdAt" | "updatedAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtOutcomeLabels).values(data).onDuplicateKeyUpdate({
    set: {
      exitSourceEventId: data.exitSourceEventId ?? null,
      exitPrice: data.exitPrice ?? null,
      mfePct: data.mfePct ?? null,
      maePct: data.maePct ?? null,
      after1mPct: data.after1mPct ?? null,
      after3mPct: data.after3mPct ?? null,
      after5mPct: data.after5mPct ?? null,
      finalPnl: data.finalPnl ?? null,
      counterfactualJson: data.counterfactualJson ?? null,
      diagnosisOnly: data.diagnosisOnly,
      completed: data.completed,
    },
  });
}

export async function getRtOutcomeLabelsForDate(input: {
  baselineVersion: string;
  tradeDate: string;
}): Promise<RtOutcomeLabel[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtOutcomeLabels).where(and(
    eq(rtOutcomeLabels.baselineVersion, input.baselineVersion),
    eq(rtOutcomeLabels.tradeDate, input.tradeDate),
  )).orderBy(rtOutcomeLabels.id);
}

export async function getRtOutcomeLabelsThroughDate(input: {
  baselineVersion: string;
  asOfDate: string;
}): Promise<RtOutcomeLabel[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtOutcomeLabels).where(and(
    eq(rtOutcomeLabels.baselineVersion, input.baselineVersion),
    lte(rtOutcomeLabels.tradeDate, input.asOfDate),
  )).orderBy(rtOutcomeLabels.id);
}

export async function upsertRtDivergenceHypothesis(
  data: Omit<InsertRtDivergenceHypothesis, "id" | "createdAt" | "updatedAt">,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtDivergenceHypotheses).values(data).onDuplicateKeyUpdate({
    set: {
      confidence: data.confidence,
      realtimeLossCount: data.realtimeLossCount,
      historicalLossHit: data.historicalLossHit,
      historicalWinHit: data.historicalWinHit,
      preventedLossYen: data.preventedLossYen,
      lostWinYen: data.lostWinYen,
      followingTradeDeltaYen: data.followingTradeDeltaYen,
      portfolioDeltaYen: data.portfolioDeltaYen,
      status: data.status,
      metricsJson: data.metricsJson,
    },
  });
}

export async function getRtDivergenceHypotheses(asOfDate: string): Promise<RtDivergenceHypothesis[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtDivergenceHypotheses)
    .where(eq(rtDivergenceHypotheses.asOfDate, asOfDate))
    .orderBy(rtDivergenceHypotheses.id);
}

export async function upsertRtSignalCandidate(
  data: Omit<InsertRtSignalCandidate, "id" | "createdAt">,
): Promise<RtSignalCandidate> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtSignalCandidates).values(data).onDuplicateKeyUpdate({
    set: {
      engineSequence: data.engineSequence,
      routeId: data.routeId,
      side: data.side,
      signalReason: data.signalReason,
      theoreticalEntryPrice: data.theoreticalEntryPrice,
      capitalShares: data.capitalShares,
      requiredMargin: data.requiredMargin,
      marginUsedBefore: data.marginUsedBefore,
      marginLimit: data.marginLimit,
      realtimeDecision: data.realtimeDecision,
      slPct: data.slPct,
      tpPct: data.tpPct,
      maxHoldingMinutes: data.maxHoldingMinutes ?? null,
      sessionExitTime: data.sessionExitTime ?? null,
      profitProtectionJson: data.profitProtectionJson ?? null,
      entryObservedAtMs: data.entryObservedAtMs ?? null,
      decisionAtMs: data.decisionAtMs,
      inputJson: data.inputJson,
    },
  });
  const row = (await db.select().from(rtSignalCandidates).where(and(
    eq(rtSignalCandidates.candidateVersion, data.candidateVersion),
    eq(rtSignalCandidates.sourceEventId, data.sourceEventId),
  )).limit(1))[0];
  if (!row) throw new Error(`Signal candidate not found after insert: ${data.sourceEventId}`);
  return row;
}

export async function getRtSignalCandidatesForDate(input: {
  candidateVersion: string;
  tradeDate: string;
}): Promise<RtSignalCandidate[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtSignalCandidates).where(and(
    eq(rtSignalCandidates.candidateVersion, input.candidateVersion),
    eq(rtSignalCandidates.tradeDate, input.tradeDate),
  )).orderBy(rtSignalCandidates.engineSequence, rtSignalCandidates.id);
}

export async function getRtSignalCandidateById(candidateId: number): Promise<RtSignalCandidate | null> {
  const db = await getDb();
  if (!db) return null;
  return (await db.select().from(rtSignalCandidates)
    .where(eq(rtSignalCandidates.id, candidateId)).limit(1))[0] ?? null;
}

export async function upsertRtSignalCandidateTrade(
  data: Omit<InsertRtSignalCandidateTrade, "id" | "createdAt" | "updatedAt">,
): Promise<RtSignalCandidateTrade> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(rtSignalCandidateTrades).values(data).onDuplicateKeyUpdate({
    set: {
      stateJson: data.stateJson,
      exitSourceEventId: data.exitSourceEventId ?? null,
      exitTradeDate: data.exitTradeDate ?? null,
      exitCandleTime: data.exitCandleTime ?? null,
      exitPrice: data.exitPrice ?? null,
      exitReason: data.exitReason ?? null,
      pnl: data.pnl ?? null,
      realizedR: data.realizedR ?? null,
      mfePct: data.mfePct ?? null,
      maePct: data.maePct ?? null,
      completed: data.completed,
    },
  });
  const row = (await db.select().from(rtSignalCandidateTrades).where(and(
    eq(rtSignalCandidateTrades.virtualEngineVersion, data.virtualEngineVersion),
    eq(rtSignalCandidateTrades.candidateId, data.candidateId),
  )).limit(1))[0];
  if (!row) throw new Error(`Signal candidate trade not found after insert: ${data.candidateId}`);
  return row;
}

export async function getRtSignalCandidateTradesForDate(input: {
  virtualEngineVersion: string;
  tradeDate: string;
}): Promise<RtSignalCandidateTrade[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtSignalCandidateTrades).where(and(
    eq(rtSignalCandidateTrades.virtualEngineVersion, input.virtualEngineVersion),
    eq(rtSignalCandidateTrades.tradeDate, input.tradeDate),
  )).orderBy(rtSignalCandidateTrades.id);
}

export async function getOpenRtSignalCandidateTrades(
  virtualEngineVersion: string,
): Promise<RtSignalCandidateTrade[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rtSignalCandidateTrades).where(and(
    eq(rtSignalCandidateTrades.virtualEngineVersion, virtualEngineVersion),
    eq(rtSignalCandidateTrades.completed, false),
  )).orderBy(rtSignalCandidateTrades.id);
}
