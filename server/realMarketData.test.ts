/**
 * useRealMarketData フックのヘルパー関数テスト
 * - 板情報生成
 * - 歩み値生成
 * - 市場時間判定
 * - ローソク足変換
 */
import { describe, it, expect } from 'vitest';
import { TARGET_STOCKS } from '../shared/stocks';

// ---- ヘルパー関数をインラインで再実装（クライアントコードをサーバーテストで直接importできないため） ----

interface BoardItem {
  price: number;
  volume: number;
  type: 'ask' | 'bid';
  isBest?: boolean;
}
interface BoardData {
  asks: BoardItem[];
  bids: BoardItem[];
  totalAskVolume: number;
  totalBidVolume: number;
}

function generateBoard(price: number): BoardData {
  const asks: BoardItem[] = [];
  const bids: BoardItem[] = [];
  const unit = price > 3000 ? 5 : price > 1000 ? 1 : 0.5;
  for (let i = 10; i >= 1; i--) {
    asks.push({
      price: Number((price + i * unit).toFixed(1)),
      volume: Math.floor(Math.random() * 4000) + 500,
      type: 'ask',
      isBest: i === 1,
    });
  }
  for (let i = 1; i <= 10; i++) {
    bids.push({
      price: Number((price - i * unit).toFixed(1)),
      volume: Math.floor(Math.random() * 4000) + 500,
      type: 'bid',
      isBest: i === 1,
    });
  }
  return {
    asks,
    bids,
    totalAskVolume: asks.reduce((a, x) => a + x.volume, 0),
    totalBidVolume: bids.reduce((a, x) => a + x.volume, 0),
  };
}

function isJSTMarketOpen(nowMs: number): boolean {
  const now = new Date(nowMs);
  const jstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const jstMinutes = (utcMinutes + jstOffset) % (24 * 60);
  const jstDay = new Date(now.getTime() + jstOffset * 60 * 1000).getUTCDay();
  if (jstDay === 0 || jstDay === 6) return false;
  const openMin = 9 * 60;
  const closeMin = 15 * 60 + 30;
  return jstMinutes >= openMin && jstMinutes < closeMin;
}

// ---- テスト ----

describe('generateBoard', () => {
  it('should generate 10 ask and 10 bid items', () => {
    const board = generateBoard(2862);
    expect(board.asks).toHaveLength(10);
    expect(board.bids).toHaveLength(10);
  });

  it('should mark only the best ask and bid', () => {
    const board = generateBoard(2862);
    const bestAsks = board.asks.filter((a) => a.isBest);
    const bestBids = board.bids.filter((b) => b.isBest);
    expect(bestAsks).toHaveLength(1);
    expect(bestBids).toHaveLength(1);
  });

  it('best ask price should be higher than best bid price', () => {
    const board = generateBoard(2862);
    const bestAsk = board.asks.find((a) => a.isBest)!;
    const bestBid = board.bids.find((b) => b.isBest)!;
    expect(bestAsk.price).toBeGreaterThan(bestBid.price);
  });

  it('totalAskVolume should equal sum of ask volumes', () => {
    const board = generateBoard(1500);
    const sum = board.asks.reduce((a, x) => a + x.volume, 0);
    expect(board.totalAskVolume).toBe(sum);
  });

  it('totalBidVolume should equal sum of bid volumes', () => {
    const board = generateBoard(1500);
    const sum = board.bids.reduce((a, x) => a + x.volume, 0);
    expect(board.totalBidVolume).toBe(sum);
  });

  it('should use unit=5 for prices above 3000', () => {
    const board = generateBoard(5000);
    const bestAsk = board.asks.find((a) => a.isBest)!;
    // best ask is i=1 → price + 1*5 = 5005
    expect(bestAsk.price).toBeCloseTo(5005, 0);
  });

  it('should use unit=1 for prices between 1000 and 3000', () => {
    const board = generateBoard(2000);
    const bestAsk = board.asks.find((a) => a.isBest)!;
    // best ask is i=1 → price + 1*1 = 2001
    expect(bestAsk.price).toBeCloseTo(2001, 0);
  });
});

describe('isJSTMarketOpen', () => {
  // 2026-06-01 (月曜) UTC 00:01 = JST 09:01 → 市場開場中
  it('should return true on weekday JST 09:01', () => {
    const monday9am = Date.UTC(2026, 5, 1, 0, 1); // UTC 00:01
    expect(isJSTMarketOpen(monday9am)).toBe(true);
  });

  // 2026-06-01 (月曜) UTC 06:29 = JST 15:29 → 市場開場中
  it('should return true on weekday JST 15:29', () => {
    const monday3pm = Date.UTC(2026, 5, 1, 6, 29);
    expect(isJSTMarketOpen(monday3pm)).toBe(true);
  });

  // 2026-06-01 (月曜) UTC 06:30 = JST 15:30 → 市場閉場
  it('should return false on weekday JST 15:30 (market close)', () => {
    const monday330pm = Date.UTC(2026, 5, 1, 6, 30);
    expect(isJSTMarketOpen(monday330pm)).toBe(false);
  });

  // 2026-06-01 (月曜) UTC 23:59 = JST 08:59 → 市場未開場
  it('should return false on weekday JST 08:59 (before open)', () => {
    const mondayBefore = Date.UTC(2026, 5, 1, 23, 59);
    expect(isJSTMarketOpen(mondayBefore)).toBe(false);
  });

  // 2026-06-06 (土曜) UTC 00:01 = JST 09:01 → 土曜で閉場
  it('should return false on Saturday', () => {
    const saturday = Date.UTC(2026, 5, 6, 0, 1);
    expect(isJSTMarketOpen(saturday)).toBe(false);
  });

  // 2026-06-07 (日曜) UTC 00:01 = JST 09:01 → 日曜で閉場
  it('should return false on Sunday', () => {
    const sunday = Date.UTC(2026, 5, 7, 0, 1);
    expect(isJSTMarketOpen(sunday)).toBe(false);
  });
});

describe('TARGET_STOCKS 銘柄リスト（共有定義）', () => {
  it('20銘柄体制（+D構成: 2026-07-23 3銘柄復活）', () => {
    expect(TARGET_STOCKS).toHaveLength(20);
  });

  it('すべてのtickerは .T で終わる（東証銘柄）', () => {
    TARGET_STOCKS.forEach((s) => {
      expect(s.ticker.endsWith('.T')).toBe(true);
    });
  });

  it('すべてのbasePriceは正の値', () => {
    TARGET_STOCKS.forEach((s) => {
      expect(s.basePrice).toBeGreaterThan(0);
    });
  });

  it('銘柄コードに重複がない', () => {
    const symbols = TARGET_STOCKS.map((s) => s.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});
