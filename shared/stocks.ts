/**
 * 監視対象銘柄の正規定義（サーバー・クライアント共通）
 * server/realSimulation.ts および client/src/hooks/useRealMarketData.ts の両方から参照する。
 *
 * 選定方針: 出来高（売買代金）が大きく流動性の高い主力銘柄に限定する。
 * デイトレでは約定しやすさ（流動性）が最優先のため、低出来高銘柄は採用しない。
 *
 * 2026-07-16: データ受信と取引除外を分離。
 * TARGET_STOCKSには全銘柄を含め（データ受信・DB保存対象）、
 * TRADE_EXCLUDED_SYMBOLSで取引のみ除外する。
 * これにより除外銘柄のデータも蓄積され、将来の復活判断に活用できる。
 */
export const TARGET_STOCKS = [
  // --- アクティブ取引銘柄 ---
  { symbol: '8035', ticker: '8035.T', name: '東京エレクトロン',        basePrice: 24800, sector: '半導体' },
  { symbol: '6857', ticker: '6857.T', name: 'アドバンテスト',          basePrice: 8800,  sector: '半導体' },
  { symbol: '6976', ticker: '6976.T', name: '太陽誘電',               basePrice: 14500, sector: '電子部品' },
  { symbol: '6526', ticker: '6526.T', name: 'ソシオネクスト',         basePrice: 3250,  sector: '半導体' },
  { symbol: '5803', ticker: '5803.T', name: 'フジクラ',               basePrice: 4400,  sector: '電線' },
  { symbol: '6981', ticker: '6981.T', name: '村田製作所',             basePrice: 10000, sector: '電子部品' },
  { symbol: '285A', ticker: '285A.T', name: 'キオクシアHD',           basePrice: 70000, sector: '半導体' },
  // --- 8/6追加銘柄 ---
  { symbol: '6146', ticker: '6146.T', name: 'ディスコ',               basePrice: 40000, sector: '半導体製造装置' }, // 8/6追加: 高ボラ・トレンド明確
  { symbol: '6594', ticker: '6594.T', name: 'ニデック',               basePrice: 3000,  sector: 'モーター' },   // 8/6追加: セクター分散
  { symbol: '8316', ticker: '8316.T', name: '三井住友FG',             basePrice: 3900,  sector: '銀行' },     // 7/23復活: 銀行セクター分散
  // --- 取引除外銘柄（データ受信は継続、TRADE_EXCLUDED_SYMBOLSで取引停止） ---
  { symbol: '6920', ticker: '6920.T', name: 'レーザーテック',          basePrice: 22400, sector: '半導体' },   // 除外: 8/6 勝率18.2%・-172,904円・12連敗
  { symbol: '6758', ticker: '6758.T', name: 'ソニーグループ',          basePrice: 3650,  sector: '電機' },     // 除外: 8/6 PF 0.04・方向正解率0%
  { symbol: '9984', ticker: '9984.T', name: 'ソフトバンクグループ',    basePrice: 8420,  sector: '通信・投資' }, // 除外: 7/1以降0勝5敗、-61,758円
  { symbol: '7011', ticker: '7011.T', name: '三菱重工業',              basePrice: 2900,  sector: '機械' },     // 除外: 7/1以降0勝2敗、-26,670円
  { symbol: '9107', ticker: '9107.T', name: '川崎汽船',               basePrice: 2100,  sector: '海運' },     // 除外: 7/1以降取引なし
  { symbol: '8306', ticker: '8306.T', name: '三菱UFJ FG',             basePrice: 1650,  sector: '銀行' },     // 除外: 7/1以降取引なし
  { symbol: '4568', ticker: '4568.T', name: '第一三共',               basePrice: 4500,  sector: '医薬' },     // 除外: 7/1以降取引なし
  { symbol: '5016', ticker: '5016.T', name: 'JX金属',                 basePrice: 3600,  sector: '非鉄' },     // 除外: SHORT 0勝8敗、-71,086円
  { symbol: '7203', ticker: '7203.T', name: 'トヨタ自動車',           basePrice: 2800,  sector: '自動車' },   // 除外: 7/1以降取引なし
  { symbol: '3778', ticker: '3778.T', name: 'さくらインターネット',    basePrice: 4100,  sector: 'IT' },       // 除外: 2026-06-19
  { symbol: '3436', ticker: '3436.T', name: 'SUMCO',                  basePrice: 4100,  sector: '半導体材料' }, // 除外: 2026-06-19
  { symbol: '6723', ticker: '6723.T', name: 'ルネサスエレクトロニクス', basePrice: 2200,  sector: '半導体' },   // 除外: 2026-06-19
] as const;

export type TargetStock = typeof TARGET_STOCKS[number];

/**
 * 取引除外銘柄セット（データ受信は継続するが、シグナル判定・エントリーは行わない）
 * 復活させる場合はこのセットから削除するだけでOK。
 */
export const TRADE_EXCLUDED_SYMBOLS: ReadonlySet<string> = new Set([
  '6920',  // レーザーテック: 8/6除外 — 勝率18.2%・-172,904円・12連敗
  '9984',  // ソフトバンクG: 7/1以降0勝5敗、-61,758円
  '7011',  // 三菱重工業: 7/1以降0勝2敗、-26,670円
  '9107',  // 川崎汽船: 7/1以降取引なし
  '8306',  // 三菱UFJ FG: 7/1以降取引なし
  '4568',  // 第一三共: 7/1以降取引なし
  '5016',  // JX金属: SHORT 0勝8敗、-71,086円
  '6758',  // ソニーグループ: 8/6除外 — PF 0.04・方向正解率0%
  '7203',  // トヨタ自動車: 7/1以降取引なし
  '3778',  // さくらインターネット: 2026-06-19除外
  '6723',  // ルネサスエレクトロニクス: 2026-06-19除外
]);

/**
 * エントリー対象銘柄セット（銘柄別ロジック最適化用）
 * 
 * null = 全アクティブ銘柄でエントリー可能（従来動作）
 * Set<string> = 指定銘柄のみエントリー可能（他銘柄はデータ受信・シグナル検出は継続するがエントリーはスキップ）
 * 
 * 使い方:
 * - 1銘柄集中モード: new Set(['285A'])
 * - 複数銘柄モード: new Set(['285A', '8035', '5803'])
 * - 全銘柄モード: null
 */
// 2026-08-25 DRY_RUN: 個別最適化が完了した7銘柄だけをエントリー対象とする。
// TARGET_STOCKSは変更しないため、他銘柄のリアルタイム受信・1分足・板保存は継続する。
export const ACTIVE_ENTRY_SYMBOLS: ReadonlySet<string> | null = new Set([
  '285A', // キオクシアHD
  '8035', // 東京エレクトロン
  '6526', // ソシオネクスト（確認型ブレイクLONG・DRY_RUN限定）
  '5803', // フジクラ
  '6981', // 村田製作所
  '6976', // 太陽誘電
  '6857', // アドバンテスト
  '6146', // ディスコ
  '3436', // SUMCO（15本安値更新SHORT・DRY_RUN限定）
]);

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
