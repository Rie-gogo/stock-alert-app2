import { eq, desc, gte, inArray, and } from "drizzle-orm";
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
