/**
 * VWAP（出来高加重平均価格）計算ヘルパー
 *
 * VWAPは「その日の取引開始から現在まで」の出来高加重平均価格。
 * デイトレードの基準線として機能し、価格がVWAPより上なら買い優勢、下なら売り優勢を示す。
 *
 * 計算式: VWAP = Σ(典型価格 × 出来高) / Σ出来高
 * 典型価格 = (高値 + 安値 + 終値) / 3
 */

export interface VwapCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 営業日キー（JSTのYYYY-MM-DD）。当日のVWAP累積リセットに使用 */
  dayKey?: string;
}

/**
 * ローソク足配列に対してVWAPを計算して返す。
 * dayKeyが変わるたびに累積をリセットする（日をまたいだ場合は当日分のみ計算）。
 *
 * @param candles ローソク足配列（時系列順）
 * @returns 各足のVWAP値配列（null = 計算不能）
 */
export function calcVWAP(candles: VwapCandle[]): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);

  let cumulativeTPV = 0; // Σ(典型価格 × 出来高)
  let cumulativeVol = 0; // Σ出来高
  let currentDayKey: string | undefined = undefined;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // dayKeyが変わったら累積をリセット（新しい営業日の開始）
    const dk = c.dayKey ?? "__all__";
    if (dk !== currentDayKey) {
      cumulativeTPV = 0;
      cumulativeVol = 0;
      currentDayKey = dk;
    }

    // 典型価格 = (高値 + 安値 + 終値) / 3
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume;

    if (vol > 0) {
      cumulativeTPV += typicalPrice * vol;
      cumulativeVol += vol;
    }

    result[i] = cumulativeVol > 0 ? Math.round((cumulativeTPV / cumulativeVol) * 10) / 10 : null;
  }

  return result;
}

/**
 * ダウ理論：スイング高値・安値を検出する
 * 直近 lookback 本の中で最高値・最安値を更新したかどうかを返す。
 *
 * @param candles ローソク足配列
 * @param lookback 比較する直近の本数（デフォルト20本 = 約20分）
 * @returns 各足の {swingHighBreak, swingLowBreak} 配列
 */
export function calcDowSwings(
  candles: VwapCandle[],
  lookback = 20
): { swingHighBreak: boolean; swingLowBreak: boolean }[] {
  return candles.map((c, i) => {
    if (i < lookback) return { swingHighBreak: false, swingLowBreak: false };

    const window = candles.slice(i - lookback, i); // 直前lookback本（現在足は含まない）
    const prevHigh = Math.max(...window.map(w => w.high));
    const prevLow = Math.min(...window.map(w => w.low));

    return {
      swingHighBreak: c.high > prevHigh, // 直近高値を更新 → 上昇トレンド継続
      swingLowBreak: c.low < prevLow,    // 直近安値を更新 → 下落トレンド継続
    };
  });
}

/**
 * 長い上ヒゲ（上影線）の検出
 * 上ヒゲが実体の2倍以上 かつ 下ヒゲが実体の0.5倍以下 → 天井シグナル
 */
export function isLongUpperShadow(candle: VwapCandle): boolean {
  const body = Math.abs(candle.close - candle.open);
  const upperShadow = candle.high - Math.max(candle.close, candle.open);
  const lowerShadow = Math.min(candle.close, candle.open) - candle.low;

  if (body < 0.01) return false; // 十字線は除外
  return upperShadow >= body * 2 && lowerShadow <= body * 0.5;
}

/**
 * 長い下ヒゲ（下影線）の検出
 * 下ヒゲが実体の2倍以上 かつ 上ヒゲが実体の0.5倍以下 → 底値シグナル
 */
export function isLongLowerShadow(candle: VwapCandle): boolean {
  const body = Math.abs(candle.close - candle.open);
  const upperShadow = candle.high - Math.max(candle.close, candle.open);
  const lowerShadow = Math.min(candle.close, candle.open) - candle.low;

  if (body < 0.01) return false; // 十字線は除外
  return lowerShadow >= body * 2 && upperShadow <= body * 0.5;
}

/**
 * はらみ線（インサイドバー）の検出
 * 現在足の実体が前足の実体に完全に収まる → 勢いの衰えシグナル
 *
 * @param prev 前足
 * @param curr 現在足
 * @returns { isHarami: boolean, isBullishHarami: boolean, isBearishHarami: boolean }
 */
export function detectHarami(
  prev: VwapCandle,
  curr: VwapCandle
): { isHarami: boolean; isBullishHarami: boolean; isBearishHarami: boolean } {
  const prevBodyHigh = Math.max(prev.open, prev.close);
  const prevBodyLow = Math.min(prev.open, prev.close);
  const currBodyHigh = Math.max(curr.open, curr.close);
  const currBodyLow = Math.min(curr.open, curr.close);

  const prevBodySize = prevBodyHigh - prevBodyLow;
  if (prevBodySize < 0.01) return { isHarami: false, isBullishHarami: false, isBearishHarami: false };

  // 現在足の実体が前足の実体内に収まる
  const isHarami = currBodyHigh <= prevBodyHigh && currBodyLow >= prevBodyLow;

  // 強気はらみ: 前足が大陰線（下落）、現在足が陽線（反転の兆し）
  const isBullishHarami = isHarami && prev.close < prev.open && curr.close > curr.open;

  // 弱気はらみ: 前足が大陽線（上昇）、現在足が陰線（反転の兆し）
  const isBearishHarami = isHarami && prev.close > prev.open && curr.close < curr.open;

  return { isHarami, isBullishHarami, isBearishHarami };
}

/**
 * 大台割れ・大台超えの検出
 * キリ番（100円単位）を前足→現在足でまたいだかどうか
 *
 * @param prev 前足の終値
 * @param curr 現在足の終値
 * @returns { crossedBelow: boolean, crossedAbove: boolean, level: number | null }
 */
export function detectRoundLevel(
  prev: number,
  curr: number
): { crossedBelow: boolean; crossedAbove: boolean; level: number | null } {
  const step = 100; // 100円単位のキリ番
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;

  if (prevLevel === currLevel) {
    return { crossedBelow: false, crossedAbove: false, level: null };
  }

  // 下方向にキリ番を割った
  if (currLevel < prevLevel) {
    return { crossedBelow: true, crossedAbove: false, level: currLevel + step };
  }

  // 上方向にキリ番を超えた
  return { crossedBelow: false, crossedAbove: true, level: currLevel };
}
