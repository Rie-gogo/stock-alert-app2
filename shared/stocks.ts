/**
 * 監視対象銘柄の正規定義（サーバー・クライアント共通）
 * server/realSimulation.ts および client/src/hooks/useRealMarketData.ts の両方から参照する。
 *
 * 選定方針: 出来高（売買代金）が大きく流動性の高い主力銘柄に限定する。
 * デイトレでは約定しやすさ（流動性）が最優先のため、低出来高銘柄は採用しない。
 *
 * 2026-07-01: パターンC+10銘柄方式に移行。
 * バックテスト結果（6/17-6/30, 10日間）:
 *   17銘柄: -211,469円, PF 0.89, 最大DD 405,177円
 *   10銘柄: +513,026円, PF 1.24, 最大DD 214,225円
 * 追加7銘柄（9107, 8306, 4568, 285A, 5016, 6758, 7203）は合計-330,196円の損失のため除外。
 */
export const TARGET_STOCKS = [
  // --- パターンC+10銘柄（2026-07-01採用） ---
  { symbol: '6920', ticker: '6920.T', name: 'レーザーテック',          basePrice: 22400, sector: '半導体' },
  { symbol: '8035', ticker: '8035.T', name: '東京エレクトロン',        basePrice: 24800, sector: '半導体' },
  { symbol: '6857', ticker: '6857.T', name: 'アドバンテスト',          basePrice: 8800,  sector: '半導体' },
  { symbol: '6976', ticker: '6976.T', name: '太陽誘電',               basePrice: 14500, sector: '電子部品' },
  { symbol: '6526', ticker: '6526.T', name: 'ソシオネクスト',         basePrice: 3250,  sector: '半導体' },
  { symbol: '9984', ticker: '9984.T', name: 'ソフトバンクグループ',    basePrice: 8420,  sector: '通信・投資' },
  { symbol: '8316', ticker: '8316.T', name: '三井住友FG',             basePrice: 3900,  sector: '銀行' },
  { symbol: '7011', ticker: '7011.T', name: '三菱重工業',              basePrice: 2900,  sector: '機械' },
  { symbol: '5803', ticker: '5803.T', name: 'フジクラ',               basePrice: 4400,  sector: '電線' },
  { symbol: '6981', ticker: '6981.T', name: '村田製作所',             basePrice: 10000, sector: '電子部品' },
  // --- 除外銘柄（2026-07-01パターンC+10移行により除外） ---
  // { symbol: '9107', ticker: '9107.T', name: '川崎汽船',               basePrice: 2100,  sector: '海運' },    // -45,720円
  // { symbol: '8306', ticker: '8306.T', name: '三菱UFJ FG',             basePrice: 1650,  sector: '銀行' },    // -44,558円
  // { symbol: '4568', ticker: '4568.T', name: '第一三共',               basePrice: 4500,  sector: '医薬' },    // +10,847円
  // { symbol: '285A', ticker: '285A.T', name: 'キオクシアHD',           basePrice: 70000, sector: '半導体' },   // -83,820円
  // { symbol: '5016', ticker: '5016.T', name: 'JX金属',                 basePrice: 3600,  sector: '非鉄' },    // -93,608円
  // { symbol: '6758', ticker: '6758.T', name: 'ソニーグループ',          basePrice: 3650,  sector: '電機' },    // -66,623円
  // { symbol: '7203', ticker: '7203.T', name: 'トヨタ自動車',           basePrice: 2800,  sector: '自動車' },   // -6,714円
  // --- 過去除外銘柄 ---
  // { symbol: '3778', ticker: '3778.T', name: 'さくらインターネット',    basePrice: 4100,  sector: 'IT' },      // 2026-06-19除外
  // { symbol: '3436', ticker: '3436.T', name: 'SUMCO',                  basePrice: 4100,  sector: '半導体材料' },  // 2026-06-19除外
  // { symbol: '6723', ticker: '6723.T', name: 'ルネサスエレクトロニクス', basePrice: 2200,  sector: '半導体' },  // 2026-06-19除外
] as const;

export type TargetStock = typeof TARGET_STOCKS[number];

/** 同時保有の上限（ハイブリッド運用） */
export const MAX_CONCURRENT_POSITIONS = 3;
/** 同一業種で同時保有できる上限（一極集中の防止） */
export const MAX_PER_SECTOR = 2;

/** symbol -> sector の早見表 */
export const SECTOR_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  TARGET_STOCKS.map((s) => [s.symbol, s.sector]),
);

export function getSector(symbol: string): string {
  return SECTOR_BY_SYMBOL[symbol] ?? 'その他';
}

/** symbol -> name の早見表 */
export const NAME_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  TARGET_STOCKS.map((s) => [s.symbol, s.name]),
);

export function getStockName(symbol: string): string {
  return NAME_BY_SYMBOL[symbol] ?? symbol;
}

/** symbol -> ticker の早見表 */
export const TICKER_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  TARGET_STOCKS.map((s) => [s.symbol, s.ticker]),
);
