export interface Stock {
  symbol: string;
  name: string;
  basePrice: number;
}

export interface CandleData {
  time: string; // HH:MM
  timestamp: number; // Unix timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  
  // Technical Indicators
  ma5?: number;
  ma25?: number;
  rsi?: number;
  bbUpper?: number;
  bbMiddle?: number;
  bbLower?: number;
  
  // Plot Markers
  signals?: {
    type: 'buy' | 'sell' | 'warn';
    reason: string;
  }[];
}

export interface BoardItem {
  price: number;
  volume: number;
  type: 'ask' | 'bid'; // ask = 売り気配, bid = 買い気配
  isBest?: boolean;
}

export interface BoardData {
  asks: BoardItem[]; // 売り気配 (高い順、または安い順)
  bids: BoardItem[]; // 買い気配 (高い順)
  totalAskVolume: number;
  totalBidVolume: number;
}

export interface TradeTick {
  id: string;
  time: string; // HH:MM:SS
  timestamp: number;
  price: number;
  volume: number;
  changeType: 'up' | 'down' | 'flat'; // 前値比
  sizeType: 'normal' | 'large' | 'huge'; // 大口判定
}

export interface AlertLog {
  id: string;
  time: string;
  symbol: string;
  type: 'ma_cross' | 'rsi' | 'bollinger' | 'volume_sell_off' | 'volume_buy_up';
  signal: 'B' | 'S' | 'W'; // Buy, Sell, Warning
  title: string;
  message: string;
  price: number;
  timestamp: number;
}

export interface MarketState {
  currentPrice: number;
  priceChange: number;
  priceChangePercent: number;
  volume: number;
  candles: CandleData[];
  board: BoardData;
  trades: TradeTick[];
}
