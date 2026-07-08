/**
 * orderBridge.ts
 *
 * 自動売買ブリッジ: シグナルエンジン(rt_trades)と発注実行(kabu_order_executor.py)を接続する。
 *
 * 役割:
 * 1. rt_tradesテーブルの新規レコードを監視し、order_instructionsに発注指示を生成する
 * 2. ローカルPC上のexecutorがポーリングで取得するpending指示を返す
 * 3. executorからの実行結果を受け取り、order_instructionsを更新する
 * 4. 期限切れ指示の自動expire処理
 * 5. 日次リスク管理（損失上限、緊急停止）
 *
 * 重要な設計原則:
 * - realtimeSimEngine.ts は一切変更しない
 * - このモジュールはrt_tradesを「読み取り専用」で監視する
 * - 発注指示の生成はrt_tradesへの新規INSERT検知がトリガー
 */

import { getDb } from "./db";
import { orderInstructions, autoTradeDaily, rtTrades, type OrderInstruction, type AutoTradeDaily, type InsertOrderInstruction } from "../drizzle/schema";
import { eq, and, desc, inArray, gte, lt } from "drizzle-orm";
import { getStockName } from "../shared/stocks";

// ============================================================
// 定数
// ============================================================

/** エントリー指示の有効期限（秒） */
const ENTRY_EXPIRY_SECONDS = 60;

/** 固定注文数量 */
const FIXED_QTY = 100;

// ============================================================
// DB ヘルパー関数
// ============================================================

/**
 * 発注指示を作成する
 */
export async function createOrderInstruction(data: Omit<InsertOrderInstruction, "id" | "createdAt" | "updatedAt">): Promise<OrderInstruction> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(orderInstructions).values(data);

  // 最後に挿入したレコードを返す
  const [inserted] = await db
    .select()
    .from(orderInstructions)
    .where(
      and(
        eq(orderInstructions.symbol, data.symbol),
        eq(orderInstructions.tradeDate, data.tradeDate),
        eq(orderInstructions.reason, data.reason),
      )
    )
    .orderBy(desc(orderInstructions.id))
    .limit(1);

  return inserted;
}

/**
 * pending状態の発注指示を取得する（executor用ポーリング）
 * 期限切れのentry指示は自動的にexpiredに更新してから除外する
 */
export async function getPendingInstructions(tradeDate: string): Promise<OrderInstruction[]> {
  const db = await getDb();
  if (!db) return [];

  // まず期限切れのentry指示をexpireする
  await expireStaleEntryInstructions();

  // pending状態の指示を古い順に返す
  return db
    .select()
    .from(orderInstructions)
    .where(
      and(
        eq(orderInstructions.tradeDate, tradeDate),
        eq(orderInstructions.status, "pending"),
      )
    )
    .orderBy(orderInstructions.id);
}

/**
 * 60秒を超過したentry指示をexpiredに更新する
 */
async function expireStaleEntryInstructions(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const now = new Date();

  // expiresAtがnullでなく、現在時刻を過ぎていて、まだpendingのものをexpire
  const stale = await db
    .select()
    .from(orderInstructions)
    .where(
      and(
        eq(orderInstructions.status, "pending"),
        eq(orderInstructions.instructionType, "entry"),
      )
    );

  let expiredCount = 0;
  for (const instruction of stale) {
    if (instruction.expiresAt && instruction.expiresAt < now) {
      await db
        .update(orderInstructions)
        .set({ status: "expired" })
        .where(eq(orderInstructions.id, instruction.id));
      expiredCount++;
      console.log(`[OrderBridge] 期限切れ: #${instruction.id} ${instruction.symbol} ${instruction.side} (${Math.round((now.getTime() - instruction.expiresAt.getTime()) / 1000)}秒超過)`);
    }
  }

  return expiredCount;
}

/**
 * 発注指示のステータスを更新する（executor→cloud報告用）
 */
export async function updateInstructionStatus(
  id: number,
  update: {
    status: "sent" | "executed" | "failed" | "cancelled";
    kabuOrderId?: string;
    executedPrice?: string;
    executedAt?: Date;
    pnl?: number;
    errorMessage?: string;
    executorLog?: Record<string, unknown>;
  }
): Promise<OrderInstruction | null> {
  const db = await getDb();
  if (!db) return null;

  await db
    .update(orderInstructions)
    .set({
      status: update.status,
      ...(update.kabuOrderId ? { kabuOrderId: update.kabuOrderId } : {}),
      ...(update.executedPrice ? { executedPrice: update.executedPrice } : {}),
      ...(update.executedAt ? { executedAt: update.executedAt } : {}),
      ...(update.pnl !== undefined ? { pnl: update.pnl } : {}),
      ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
      ...(update.executorLog ? { executorLog: update.executorLog } : {}),
    })
    .where(eq(orderInstructions.id, id));

  const [updated] = await db
    .select()
    .from(orderInstructions)
    .where(eq(orderInstructions.id, id));

  return updated ?? null;
}

/**
 * 指定日の全発注指示を取得する（ダッシュボード用）
 */
export async function getOrderInstructionsForDate(tradeDate: string): Promise<OrderInstruction[]> {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(orderInstructions)
    .where(eq(orderInstructions.tradeDate, tradeDate))
    .orderBy(desc(orderInstructions.id));
}

// ============================================================
// 日次リスク管理
// ============================================================

/**
 * 当日のauto_trade_dailyレコードを取得（なければ作成）
 */
export async function getOrCreateAutoTradeDaily(tradeDate: string): Promise<AutoTradeDaily> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [existing] = await db
    .select()
    .from(autoTradeDaily)
    .where(eq(autoTradeDaily.tradeDate, tradeDate));

  if (existing) return existing;

  // 新規作成（デフォルト: ドライラン有効、取引有効）
  await db.insert(autoTradeDaily).values({
    tradeDate,
    realizedPnl: 0,
    tradeCount: 0,
    dailyLossLimit: -50000,
    tradingEnabled: true,
    emergencyStop: false,
    isDryRun: true,
  });

  const [created] = await db
    .select()
    .from(autoTradeDaily)
    .where(eq(autoTradeDaily.tradeDate, tradeDate));

  return created;
}

/**
 * 日次損益を更新する
 */
export async function updateAutoTradeDailyPnl(tradeDate: string, pnlDelta: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const daily = await getOrCreateAutoTradeDaily(tradeDate);
  const newPnl = (daily.realizedPnl ?? 0) + pnlDelta;
  const newCount = (daily.tradeCount ?? 0) + 1;

  await db
    .update(autoTradeDaily)
    .set({
      realizedPnl: newPnl,
      tradeCount: newCount,
    })
    .where(eq(autoTradeDaily.id, daily.id));

  // 日次損失上限チェック
  if (newPnl <= daily.dailyLossLimit) {
    await db
      .update(autoTradeDaily)
      .set({
        tradingEnabled: false,
        emergencyStop: true,
        emergencyStopReason: `日次損失上限到達: ${newPnl}円 (上限: ${daily.dailyLossLimit}円)`,
      })
      .where(eq(autoTradeDaily.id, daily.id));
    console.log(`[OrderBridge] ⚠️ 日次損失上限到達! ${newPnl}円 → 新規エントリー停止`);
  }
}

/**
 * 緊急停止を設定する
 */
export async function setEmergencyStop(tradeDate: string, reason: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const daily = await getOrCreateAutoTradeDaily(tradeDate);
  await db
    .update(autoTradeDaily)
    .set({
      tradingEnabled: false,
      emergencyStop: true,
      emergencyStopReason: reason,
    })
    .where(eq(autoTradeDaily.id, daily.id));

  console.log(`[OrderBridge] 🚨 緊急停止: ${reason}`);
}

/**
 * 取引可能かチェックする（日次リスク管理）
 */
export async function canTrade(tradeDate: string, instructionType: "entry" | "exit" | "force_close"): Promise<{ allowed: boolean; reason?: string }> {
  // exit/force_closeは常に許可（ポジションを閉じる操作は止めてはいけない）
  if (instructionType === "exit" || instructionType === "force_close") {
    return { allowed: true };
  }

  const daily = await getOrCreateAutoTradeDaily(tradeDate);

  if (daily.emergencyStop) {
    return { allowed: false, reason: `緊急停止中: ${daily.emergencyStopReason}` };
  }

  if (!daily.tradingEnabled) {
    return { allowed: false, reason: "取引停止中（日次損失上限到達）" };
  }

  return { allowed: true };
}

// ============================================================
// rt_trades監視 → 発注指示生成
// ============================================================

/** 最後に処理したrt_tradesのID（重複防止） */
let lastProcessedRtTradeId = 0;

/**
 * サーバー起動時に最後のrt_trade IDを復元する
 */
export async function initOrderBridge(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // 今日の日付を取得（JST）
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstDate = new Date(now.getTime() + jstOffset);
  const tradeDate = jstDate.toISOString().slice(0, 10);

  // 当日の最後のrt_trade IDを取得
  const [lastTrade] = await db
    .select()
    .from(rtTrades)
    .where(eq(rtTrades.tradeDate, tradeDate))
    .orderBy(desc(rtTrades.id))
    .limit(1);

  if (lastTrade) {
    lastProcessedRtTradeId = lastTrade.id;
    console.log(`[OrderBridge] 初期化完了: lastProcessedRtTradeId=${lastProcessedRtTradeId}`);
  } else {
    lastProcessedRtTradeId = 0;
    console.log(`[OrderBridge] 初期化完了: 当日の取引なし`);
  }

  // auto_trade_dailyレコードを確保
  await getOrCreateAutoTradeDaily(tradeDate);
}

/**
 * rt_tradesの新規レコードを検知して発注指示を生成する。
 * processCandle()の後に呼び出される想定（pushCandleWithBoardの直後）。
 *
 * 動作:
 * 1. lastProcessedRtTradeId以降の新しいrt_tradesを取得
 * 2. 各レコードに対して対応するorder_instructionを生成
 * 3. lastProcessedRtTradeIdを更新
 */
export async function checkAndGenerateInstructions(): Promise<OrderInstruction[]> {
  const db = await getDb();
  if (!db) return [];

  // 今日の日付を取得（JST）
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstDate = new Date(now.getTime() + jstOffset);
  const tradeDate = jstDate.toISOString().slice(0, 10);

  // lastProcessedRtTradeId以降の新しいrt_tradesを取得
  const newTrades = await db
    .select()
    .from(rtTrades)
    .where(
      and(
        eq(rtTrades.tradeDate, tradeDate),
        gte(rtTrades.id, lastProcessedRtTradeId + 1),
      )
    )
    .orderBy(rtTrades.id);

  if (newTrades.length === 0) return [];

  const generatedInstructions: OrderInstruction[] = [];

  for (const trade of newTrades) {
    // rt_tradesのactionを発注指示のsideに変換
    const side = mapActionToSide(trade.action);
    if (!side) {
      // 未知のaction（通常ありえない）
      lastProcessedRtTradeId = trade.id;
      continue;
    }

    // 指示種別を決定
    const instructionType = determineInstructionType(trade.action, trade.reason);

    // リスクチェック
    const canTradeResult = await canTrade(tradeDate, instructionType);
    if (!canTradeResult.allowed) {
      console.log(`[OrderBridge] 発注ブロック: ${trade.symbol} ${side} - ${canTradeResult.reason}`);
      lastProcessedRtTradeId = trade.id;
      continue;
    }

    // 期限切れ時刻を計算（entryのみ60秒）
    const expiresAt = instructionType === "entry"
      ? new Date(now.getTime() + ENTRY_EXPIRY_SECONDS * 1000)
      : null;

    // 発注指示を生成
    const instruction = await createOrderInstruction({
      tradeDate,
      symbol: trade.symbol,
      symbolName: trade.symbolName,
      side,
      instructionType,
      qty: FIXED_QTY,
      status: "pending",
      reason: trade.reason,
      referencePrice: trade.price,
      expiresAt,
      kabuOrderId: null,
      executedPrice: null,
      executedAt: null,
      pnl: null,
      rtTradeId: trade.id,
      errorMessage: null,
      isDryRun: true, // デフォルトはドライラン
      executorLog: null,
    });

    generatedInstructions.push(instruction);
    console.log(`[OrderBridge] 発注指示生成: #${instruction.id} ${trade.symbol} ${side} ${instructionType} @${trade.price}円 (${trade.reason.slice(0, 40)}...)`);

    lastProcessedRtTradeId = trade.id;
  }

  return generatedInstructions;
}

/**
 * rt_tradesのaction → order_instructionsのside変換
 */
function mapActionToSide(action: string): "buy" | "sell" | "short" | "cover" | null {
  switch (action) {
    case "buy": return "buy";       // LONG新規
    case "sell": return "sell";     // LONG決済
    case "short": return "short";   // SHORT新規
    case "cover": return "cover";   // SHORT決済
    default: return null;
  }
}

/**
 * 指示種別を決定する
 * - buy/short → entry（新規建て）
 * - sell/cover → exit or force_close
 */
function determineInstructionType(action: string, reason: string): "entry" | "exit" | "force_close" {
  if (action === "buy" || action === "short") {
    return "entry";
  }

  // 大引け強制決済かどうかを判定
  if (reason.includes("大引け") || reason.includes("強制決済") || reason.includes("MARKET_CLOSE")) {
    return "force_close";
  }

  return "exit";
}

/**
 * 同一銘柄に対して既にpending/sentの指示がないかチェック（二重発注防止）
 */
export async function hasPendingOrSentInstruction(tradeDate: string, symbol: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const existing = await db
    .select()
    .from(orderInstructions)
    .where(
      and(
        eq(orderInstructions.tradeDate, tradeDate),
        eq(orderInstructions.symbol, symbol),
        inArray(orderInstructions.status, ["pending", "sent"]),
      )
    )
    .limit(1);

  return existing.length > 0;
}
