/**
 * kabu STATION® API モジュール
 *
 * kabuステーションはWindowsのローカルアプリとして動作し、
 * localhost:18080（本番）または localhost:18081（検証）でAPIを提供します。
 *
 * このモジュールは:
 * 1. Windows中継スクリプトからWebSocket経由で受信した板情報をキャッシュ
 * 2. フロントエンドへtRPC経由で板情報を提供
 * 3. 板読みシグナルを計算
 */

export type OrderBookEntry = {
  price: number;
  qty: number;
};

export type KabuOrderBook = {
  symbol: string;
  symbolName: string;
  currentPrice: number;
  currentPriceTime: string;
  asks: OrderBookEntry[]; // 売気配 (ask1〜ask10)
  bids: OrderBookEntry[]; // 買気配 (bid1〜bid10)
  marketOrderSellQty: number; // 売成行数量
  marketOrderBuyQty: number; // 買成行数量
  overSellQty: number; // OVER気配数量
  underBuyQty: number; // UNDER気配数量
  vwap: number;
  receivedAt: number; // Unix timestamp (ms)
};

export type OrderBookSignal = {
  type: "board_buy_pressure" | "board_sell_pressure" | "large_bid_wall" | "large_ask_wall" | "market_order_surge";
  strength: number; // 0.0〜1.0
  description: string;
};

// メモリキャッシュ（銘柄コード → 最新板情報）
const orderBookCache = new Map<string, KabuOrderBook>();

// キャッシュの最大保持時間（60秒）※案A: 2026-06-12 板情報取得率改善のため5秒→60秒に延長
// 最終目標: 案C（1分足+板情報の同時送信）に移行後、再度短縮を検討
const CACHE_TTL_MS = 60_000;

/**
 * 板情報をキャッシュに保存（Windows中継スクリプトから呼ばれる）
 */
export function updateOrderBook(data: KabuOrderBook): void {
  orderBookCache.set(data.symbol, {
    ...data,
    receivedAt: Date.now(),
  });
  // 10秒リングバッファに追記（高頻度ポーリング対応）
  appendToRingBuffer(data);
}

/**
 * 特定銘柄の板情報を取得
 */
export function getOrderBook(symbol: string): KabuOrderBook | null {
  const cached = orderBookCache.get(symbol);
  if (!cached) return null;

  // キャッシュが古すぎる場合はnullを返す
  if (Date.now() - cached.receivedAt > CACHE_TTL_MS) {
    orderBookCache.delete(symbol);
    return null;
  }

  return cached;
}

/**
 * 全銘柄の板情報を取得
 */
export function getAllOrderBooks(): KabuOrderBook[] {
  const now = Date.now();
  const result: KabuOrderBook[] = [];

  for (const [key, book] of Array.from(orderBookCache.entries())) {
    if (now - book.receivedAt <= CACHE_TTL_MS) {
      result.push(book);
    } else {
      orderBookCache.delete(key);
    }
  }

  return result;
}

/**
 * 板情報から売買シグナルを計算
 *
 * シグナル1: 買い板・売り板の厚み比率（板圧力）
 *   - 買い板合計 / 売り板合計 >= 1.5 → 買い優勢
 *   - 買い板合計 / 売り板合計 <= 0.67 → 売り優勢
 *
 * シグナル2: 大口注文の壁検出（v5: 閾値を5倍に厳格化）
 *   - 特定価格帯に平均の5倍以上の注文 → サポート/レジスタンス
 *
 * シグナル3: 成行注文の急増
 *   - 成行注文が板全体の10%超 → 強いトレンド発生中
 */
export function analyzeOrderBook(book: KabuOrderBook): OrderBookSignal[] {
  const signals: OrderBookSignal[] = [];

  // 買い板・売り板の合計数量を計算
  const totalBidQty = book.bids.reduce((sum, b) => sum + b.qty, 0) + book.underBuyQty;
  const totalAskQty = book.asks.reduce((sum, a) => sum + a.qty, 0) + book.overSellQty;

  if (totalBidQty === 0 || totalAskQty === 0) return signals;

  // シグナル1: 板圧力
  const pressureRatio = totalBidQty / totalAskQty;

  if (pressureRatio >= 1.5) {
    signals.push({
      type: "board_buy_pressure",
      strength: Math.min(1.0, (pressureRatio - 1.5) / 1.5 + 0.5),
      description: `買い板が売り板の${pressureRatio.toFixed(1)}倍（買い優勢）`,
    });
  } else if (pressureRatio <= 0.67) {
    signals.push({
      type: "board_sell_pressure",
      strength: Math.min(1.0, (0.67 - pressureRatio) / 0.67 + 0.5),
      description: `売り板が買い板の${(1 / pressureRatio).toFixed(1)}倍（売り優勢）`,
    });
  }

  // シグナル2: 大口注文の壁検出（v5: 閾値を5倍に厳格化）
  const LARGE_WALL_MULTIPLIER = 5.0;
  if (book.bids.length > 0) {
    const avgBidQty = totalBidQty / book.bids.length;
    const largeBid = book.bids.find((b) => b.qty >= avgBidQty * LARGE_WALL_MULTIPLIER);
    if (largeBid) {
      signals.push({
        type: "large_bid_wall",
        strength: Math.min(1.0, largeBid.qty / (avgBidQty * LARGE_WALL_MULTIPLIER)),
        description: `${largeBid.price.toLocaleString()}円に大口買い注文（${largeBid.qty.toLocaleString()}株、平均の${(largeBid.qty / avgBidQty).toFixed(1)}倍）`,
      });
    }
  }

  if (book.asks.length > 0) {
    const avgAskQty = totalAskQty / book.asks.length;
    const largeAsk = book.asks.find((a) => a.qty >= avgAskQty * LARGE_WALL_MULTIPLIER);
    if (largeAsk) {
      signals.push({
        type: "large_ask_wall",
        strength: Math.min(1.0, largeAsk.qty / (avgAskQty * LARGE_WALL_MULTIPLIER)),
        description: `${largeAsk.price.toLocaleString()}円に大口売り注文（${largeAsk.qty.toLocaleString()}株、平均の${(largeAsk.qty / avgAskQty).toFixed(1)}倍）`,
      });
    }
  }

  // シグナル3: 成行注文の急増
  const totalMarketQty = book.marketOrderBuyQty + book.marketOrderSellQty;
  const totalAllQty = totalBidQty + totalAskQty + totalMarketQty;

  if (totalAllQty > 0) {
    const marketRatio = totalMarketQty / totalAllQty;
    if (marketRatio >= 0.1) {
      const isBuyDominant = book.marketOrderBuyQty > book.marketOrderSellQty;
      signals.push({
        type: "market_order_surge",
        strength: Math.min(1.0, marketRatio * 5),
        description: `成行注文が急増（${(marketRatio * 100).toFixed(0)}%、${isBuyDominant ? "買い" : "売り"}優勢）`,
      });
    }
  }

  return signals;
}

/**
 * v5拡張: 板情報からBoardSnapshotの追加フィールドを計算
 * アイスバーグ注文・板キャンセルは前回スナップショットとの差分で検出
 */
const prevBoardCache = new Map<string, { askMap: Map<number, number>; bidMap: Map<number, number> }>();

export function calcExtendedBoardFields(
  book: KabuOrderBook
): Partial<import("../drizzle/schema").BoardSnapshot> {
  const LARGE_WALL_MULTIPLIER = 5.0;
  const ICEBERG_DROP_RATIO = 0.5;
  const CANCEL_DROP_RATIO = 0.7;

  const totalBidQty = book.bids.reduce((sum, b) => sum + b.qty, 0) + book.underBuyQty;
  const totalAskQty = book.asks.reduce((sum, a) => sum + a.qty, 0) + book.overSellQty;

  // --- 大口注文の壁（数値として保存）---
  let largeAskWallRatio = 0;
  let largeAskWallPrice: number | null = null;
  let largeBidWallRatio = 0;
  let largeBidWallPrice: number | null = null;

  if (book.asks.length > 0) {
    const avgAsk = totalAskQty / book.asks.length;
    for (const a of book.asks) {
      const ratio = avgAsk > 0 ? a.qty / avgAsk : 0;
      if (ratio > largeAskWallRatio) {
        largeAskWallRatio = ratio;
        largeAskWallPrice = a.price;
      }
    }
    if (largeAskWallRatio < LARGE_WALL_MULTIPLIER) largeAskWallPrice = null;
  }

  if (book.bids.length > 0) {
    const avgBid = totalBidQty / book.bids.length;
    for (const b of book.bids) {
      const ratio = avgBid > 0 ? b.qty / avgBid : 0;
      if (ratio > largeBidWallRatio) {
        largeBidWallRatio = ratio;
        largeBidWallPrice = b.price;
      }
    }
    if (largeBidWallRatio < LARGE_WALL_MULTIPLIER) largeBidWallPrice = null;
  }

  // --- 現値から大口注文までの距離 ---
  let nearAskWallPct: number | null = null;
  let nearBidWallPct: number | null = null;
  if (book.currentPrice > 0) {
    if (largeAskWallPrice != null)
      nearAskWallPct = Math.round(((largeAskWallPrice - book.currentPrice) / book.currentPrice) * 10000) / 100;
    if (largeBidWallPrice != null)
      nearBidWallPct = Math.round(((book.currentPrice - largeBidWallPrice) / book.currentPrice) * 10000) / 100;
  }

  // --- 成り行き注文の方向 ---
  let marketOrderDirection: "buy" | "sell" | "neutral" = "neutral";
  if (book.marketOrderBuyQty > book.marketOrderSellQty * 1.5) marketOrderDirection = "buy";
  else if (book.marketOrderSellQty > book.marketOrderBuyQty * 1.5) marketOrderDirection = "sell";

  // --- アイスバーグ・キャンセル検出（前回との差分）---
  let askCancelDetected = false;
  let bidCancelDetected = false;
  let icebergAskDetected = false;
  let icebergBidDetected = false;

  const prev = prevBoardCache.get(book.symbol);
  if (prev) {
    const currAskMap = new Map(book.asks.map((a) => [a.price, a.qty]));
    const currBidMap = new Map(book.bids.map((b) => [b.price, b.qty]));
    const avgAsk = book.asks.length > 0 ? totalAskQty / book.asks.length : 0;
    const avgBid = book.bids.length > 0 ? totalBidQty / book.bids.length : 0;

    for (const [price, prevQty] of Array.from(prev.askMap.entries())) {
      const currQty = currAskMap.get(price) ?? 0;
      if (prevQty > 0) {
        const dropRatio = (prevQty - currQty) / prevQty;
        if (dropRatio >= CANCEL_DROP_RATIO && prevQty >= avgAsk * LARGE_WALL_MULTIPLIER) {
          askCancelDetected = true;
        } else if (dropRatio >= ICEBERG_DROP_RATIO && dropRatio < CANCEL_DROP_RATIO) {
          icebergAskDetected = true;
        }
      }
    }

    for (const [price, prevQty] of Array.from(prev.bidMap.entries())) {
      const currQty = currBidMap.get(price) ?? 0;
      if (prevQty > 0) {
        const dropRatio = (prevQty - currQty) / prevQty;
        if (dropRatio >= CANCEL_DROP_RATIO && prevQty >= avgBid * LARGE_WALL_MULTIPLIER) {
          bidCancelDetected = true;
        } else if (dropRatio >= ICEBERG_DROP_RATIO && dropRatio < CANCEL_DROP_RATIO) {
          icebergBidDetected = true;
        }
      }
    }
  }

  // 今回のスナップショットを保存
  prevBoardCache.set(book.symbol, {
    askMap: new Map(book.asks.map((a) => [a.price, a.qty])),
    bidMap: new Map(book.bids.map((b) => [b.price, b.qty])),
  });

  return {
    largeAskWallRatio: Math.round(largeAskWallRatio * 100) / 100,
    largeBidWallRatio: Math.round(largeBidWallRatio * 100) / 100,
    largeAskWallPrice,
    largeBidWallPrice,
    nearAskWallPct,
    nearBidWallPct,
    marketOrderDirection,
    askCancelDetected,
    bidCancelDetected,
    icebergAskDetected,
    icebergBidDetected,
    totalAskQty,
    totalBidQty,
  };
}

// ============================================================
// 10秒リングバッファ: 高頻度板ポーリング対応
// ============================================================

/** 10秒スナップショットの型 */
export interface BoardMicroSnapshot {
  timestamp: number; // Unix ms
  buyPressureRatio: number;
  icebergAskDetected: boolean;
  icebergBidDetected: boolean;
  askCancelDetected: boolean;
  bidCancelDetected: boolean;
  marketOrderDirection: "buy" | "sell" | "neutral";
  totalBidQty: number;
  totalAskQty: number;
  currentPrice: number;
  volume: number; // 累積出来高（差分計算用）
}

/** 銘柄ごとのリングバッファ（直近6回 = 約1分分） */
const boardRingBuffer = new Map<string, BoardMicroSnapshot[]>();
const RING_BUFFER_SIZE = 6;

/** 前回の累積出来高（大口約定方向推定用） */
const prevVolumeCache = new Map<string, number>();

/**
 * 板情報をリングバッファに追記する（updateOrderBookから自動呼び出し）
 * 10秒ごとにpushBoardが呼ばれる前提で、差分検出結果をバッファに蓄積
 */
function appendToRingBuffer(book: KabuOrderBook): void {
  const extended = calcExtendedBoardFields(book);
  
  const totalBidQty = book.bids.reduce((s, b) => s + b.qty, 0) + book.underBuyQty;
  const totalAskQty = book.asks.reduce((s, a) => s + a.qty, 0) + book.overSellQty;
  const bpr = totalAskQty > 0 ? totalBidQty / totalAskQty : 1.0;

  const micro: BoardMicroSnapshot = {
    timestamp: Date.now(),
    buyPressureRatio: Math.round(bpr * 100) / 100,
    icebergAskDetected: !!extended.icebergAskDetected,
    icebergBidDetected: !!extended.icebergBidDetected,
    askCancelDetected: !!extended.askCancelDetected,
    bidCancelDetected: !!extended.bidCancelDetected,
    marketOrderDirection: extended.marketOrderDirection ?? "neutral",
    totalBidQty,
    totalAskQty,
    currentPrice: book.currentPrice,
    volume: 0, // 将来の出来高差分用
  };

  const buffer = boardRingBuffer.get(book.symbol) ?? [];
  buffer.push(micro);
  if (buffer.length > RING_BUFFER_SIZE) buffer.shift();
  boardRingBuffer.set(book.symbol, buffer);
}

/** 集約結果の型 */
export interface AggregatedBoardStats {
  /** 直近1分間のアイスバーグ検出回数（ask側） */
  icebergAskCount: number;
  /** 直近1分間のアイスバーグ検出回数（bid側） */
  icebergBidCount: number;
  /** 直近1分間のキャンセル検出回数（ask側） */
  cancelAskCount: number;
  /** 直近1分間のキャンセル検出回数（bid側） */
  cancelBidCount: number;
  /** 直近1分間のBPR平均 */
  avgBpr: number;
  /** 直近1分間のBPR最大値 */
  maxBpr: number;
  /** 直近1分間のBPR最小値 */
  minBpr: number;
  /** 大口約定方向の推定（多数決） */
  largeTradeDirection: "buy" | "sell" | "neutral";
  /** サンプル数（何回の板スナップショットから集約したか） */
  sampleCount: number;
  /** BPRの変化幅（最初と最後の差） */
  bprDelta: number;
}

/**
 * 直近1分間（リングバッファ内）の板情報を集約して返す
 */
export function getAggregatedBoardStats(symbol: string): AggregatedBoardStats | null {
  const buffer = boardRingBuffer.get(symbol);
  if (!buffer || buffer.length === 0) return null;

  let icebergAskCount = 0;
  let icebergBidCount = 0;
  let cancelAskCount = 0;
  let cancelBidCount = 0;
  let bprSum = 0;
  let maxBpr = -Infinity;
  let minBpr = Infinity;
  let buyDirCount = 0;
  let sellDirCount = 0;

  for (const snap of buffer) {
    if (snap.icebergAskDetected) icebergAskCount++;
    if (snap.icebergBidDetected) icebergBidCount++;
    if (snap.askCancelDetected) cancelAskCount++;
    if (snap.bidCancelDetected) cancelBidCount++;
    bprSum += snap.buyPressureRatio;
    if (snap.buyPressureRatio > maxBpr) maxBpr = snap.buyPressureRatio;
    if (snap.buyPressureRatio < minBpr) minBpr = snap.buyPressureRatio;
    if (snap.marketOrderDirection === "buy") buyDirCount++;
    else if (snap.marketOrderDirection === "sell") sellDirCount++;
  }

  const avgBpr = Math.round((bprSum / buffer.length) * 100) / 100;
  const bprDelta = Math.round((buffer[buffer.length - 1].buyPressureRatio - buffer[0].buyPressureRatio) * 100) / 100;

  let largeTradeDirection: "buy" | "sell" | "neutral" = "neutral";
  if (buyDirCount > sellDirCount && buyDirCount >= 2) largeTradeDirection = "buy";
  else if (sellDirCount > buyDirCount && sellDirCount >= 2) largeTradeDirection = "sell";

  return {
    icebergAskCount,
    icebergBidCount,
    cancelAskCount,
    cancelBidCount,
    avgBpr,
    maxBpr: maxBpr === -Infinity ? avgBpr : Math.round(maxBpr * 100) / 100,
    minBpr: minBpr === Infinity ? avgBpr : Math.round(minBpr * 100) / 100,
    largeTradeDirection,
    sampleCount: buffer.length,
    bprDelta,
  };
}

/**
 * リングバッファをクリアする（日付変更時に呼び出し）
 */
export function clearBoardRingBuffer(): void {
  boardRingBuffer.clear();
  prevVolumeCache.clear();
}

/**
 * kabu STATION APIのWebSocketプッシュデータを板情報に変換
 * （Windows中継スクリプトから送られてくるJSONをパース）
 */
export function parseKabuPushData(raw: Record<string, unknown>): KabuOrderBook | null {
  try {
    const symbol = String(raw.Symbol ?? "");
    const symbolName = String(raw.SymbolName ?? "");
    const currentPrice = Number(raw.CurrentPrice ?? 0);
    const currentPriceTime = String(raw.CurrentPriceTime ?? "");

    const asks: OrderBookEntry[] = [];
    const bids: OrderBookEntry[] = [];

    // 売気配 Sell1〜Sell10
    for (let i = 1; i <= 10; i++) {
      const priceKey = `Sell${i}`;
      const qtyKey = `Sell${i}Qty`;
      const price = Number((raw[priceKey] as Record<string, unknown>)?.Price ?? 0);
      const qty = Number((raw[priceKey] as Record<string, unknown>)?.Qty ?? raw[qtyKey] ?? 0);
      if (price > 0) asks.push({ price, qty });
    }

    // 買気配 Buy1〜Buy10
    for (let i = 1; i <= 10; i++) {
      const priceKey = `Buy${i}`;
      const qtyKey = `Buy${i}Qty`;
      const price = Number((raw[priceKey] as Record<string, unknown>)?.Price ?? 0);
      const qty = Number((raw[priceKey] as Record<string, unknown>)?.Qty ?? raw[qtyKey] ?? 0);
      if (price > 0) bids.push({ price, qty });
    }

    return {
      symbol,
      symbolName,
      currentPrice,
      currentPriceTime,
      asks,
      bids,
      marketOrderSellQty: Number(raw.MarketOrderSellQty ?? 0),
      marketOrderBuyQty: Number(raw.MarketOrderBuyQty ?? 0),
      overSellQty: Number(raw.OverSellQty ?? 0),
      underBuyQty: Number(raw.UnderBuyQty ?? 0),
      vwap: Number(raw.VWAP ?? 0),
      receivedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
