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
 * VWAP反発の検出
 * 価格がVWAPまで下落した後に反発した場合（押し目買いシグナル）
 * または価格がVWAPまで上昇した後に反落した場合（戻り売りシグナル）
 *
 * 条件（買い反発）:
 *   - 前々足: close < vwap（VWAP以下に下落）
 *   - 前足: low <= vwap * 1.002（VWAPに接近またはタッチ）
 *   - 現在足: close > vwap（VWAPを回復して反発）
 *   - 現在足が陽線（close > open）
 *
 * 条件（売り反落）:
 *   - 前々足: close > vwap（VWAP以上に上昇）
 *   - 前足: high >= vwap * 0.998（VWAPに接近またはタッチ）
 *   - 現在足: close < vwap（VWAPを割り込んで反落）
 *   - 現在足が陰線（close < open）
 */
export function detectVwapBounce(
  candles: VwapCandle[],
  vwapSeries: (number | null)[]
): { isBullishBounce: boolean; isBearishBounce: boolean }[] {
  return candles.map((c, i) => {
    if (i < 2) return { isBullishBounce: false, isBearishBounce: false };
    const vwap = vwapSeries[i];
    const vwapPrev = vwapSeries[i - 1];
    const vwapPrev2 = vwapSeries[i - 2];
    if (vwap === null || vwapPrev === null || vwapPrev2 === null) {
      return { isBullishBounce: false, isBearishBounce: false };
    }
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];
    // 買い反発: VWAP下→VWAP接触→VWAP上回復
    const isBullishBounce =
      prev2.close < vwapPrev2 &&           // 前々足がVWAP以下
      prev.low <= vwapPrev * 1.002 &&       // 前足がVWAPに接近（±0.2%）
      c.close > vwap &&                     // 現在足がVWAPを上回る
      c.close > c.open;                     // 現在足が陽線
    // 売り反落: VWAP上→VWAP接触→VWAP下割れ
    const isBearishBounce =
      prev2.close > vwapPrev2 &&            // 前々足がVWAP以上
      prev.high >= vwapPrev * 0.998 &&      // 前足がVWAPに接近（±0.2%）
      c.close < vwap &&                     // 現在足がVWAPを下回る
      c.close < c.open;                     // 現在足が陰線
    return { isBullishBounce, isBearishBounce };
  });
}

/**
 * ダブルトップ / ダブルボトムの検出
 *
 * ダブルトップ（売りシグナル）:
 *   - 直近 lookback 本の中に2つの「山」がある
 *   - 2つの山の高値が近い（差が山高値の1%以内）
 *   - 現在足の終値がネックライン（2つの山の間の最安値）を下抜け
 *
 * ダブルボトム（買いシグナル）:
 *   - 直近 lookback 本の中に2つの「谷」がある
 *   - 2つの谷の安値が近い（差が谷安値の1%以内）
 *   - 現在足の終値がネックライン（2つの谷の間の最高値）を上抜け
 */
export function detectDoubleTopBottom(
  candles: VwapCandle[],
  lookback = 40
): { isDoubleTop: boolean; isDoubleBottom: boolean; neckline: number | null }[] {
  return candles.map((c, i) => {
    if (i < lookback + 2) return { isDoubleTop: false, isDoubleBottom: false, neckline: null };
    const window = candles.slice(i - lookback, i); // 直前lookback本
    const n = window.length;
    // ローカル高値（山）と安値（谷）を検出
    const peaks: { idx: number; price: number }[] = [];
    const troughs: { idx: number; price: number }[] = [];
    for (let j = 1; j < n - 1; j++) {
      if (window[j].high > window[j - 1].high && window[j].high > window[j + 1].high) {
        peaks.push({ idx: j, price: window[j].high });
      }
      if (window[j].low < window[j - 1].low && window[j].low < window[j + 1].low) {
        troughs.push({ idx: j, price: window[j].low });
      }
    }
    let isDoubleTop = false;
    let isDoubleBottom = false;
    let neckline: number | null = null;
    // ダブルトップ: 最後の2つの山が近い高値
    if (peaks.length >= 2) {
      const p1 = peaks[peaks.length - 2];
      const p2 = peaks[peaks.length - 1];
      const priceDiff = Math.abs(p1.price - p2.price) / Math.max(p1.price, p2.price);
      if (priceDiff <= 0.01 && p2.idx > p1.idx + 3) { // 2つの山が1%以内かつ3本以上離れている
        // ネックライン = 2つの山の間の最安値
        const between = window.slice(p1.idx, p2.idx + 1);
        const neck = Math.min(...between.map(w => w.low));
        if (c.close < neck) { // ネックライン割れ
          isDoubleTop = true;
          neckline = neck;
        }
      }
    }
    // ダブルボトム: 最後の2つの谷が近い安値
    if (!isDoubleTop && troughs.length >= 2) {
      const t1 = troughs[troughs.length - 2];
      const t2 = troughs[troughs.length - 1];
      const priceDiff = Math.abs(t1.price - t2.price) / Math.min(t1.price, t2.price);
      if (priceDiff <= 0.01 && t2.idx > t1.idx + 3) { // 2つの谷が1%以内かつ3本以上離れている
        // ネックライン = 2つの谷の間の最高値
        const between = window.slice(t1.idx, t2.idx + 1);
        const neck = Math.max(...between.map(w => w.high));
        if (c.close > neck) { // ネックライン超え
          isDoubleBottom = true;
          neckline = neck;
        }
      }
    }
    return { isDoubleTop, isDoubleBottom, neckline };
  });
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

/**
 * 三尊（ヘッド&ショルダー）/ 逆三尊（インバース H&S）の検出
 *
 * 三尊（ヘッド&ショルダー）— 売りシグナル:
 *   - 直近 lookback 本の中に3つの山がある
 *   - 中央の山（ヘッド）が最も高く、左右の山（ショルダー）は近い高さ（差が1.5%以内）
 *   - ネックライン = 左ショルダー谷と右ショルダー谷の平均
 *   - 現在足の終値がネックラインを下抜け → 売りシグナル
 *
 * 逆三尊（インバース H&S）— 買いシグナル:
 *   - 直近 lookback 本の中に3つの谷がある
 *   - 中央の谷（ヘッド）が最も深く、左右の谷（ショルダー）は近い深さ（差が1.5%以内）
 *   - ネックライン = 左ショルダー山と右ショルダー山の平均
 *   - 現在足の終値がネックラインを上抜け → 買いシグナル
 */
export function detectHeadAndShoulders(
  candles: VwapCandle[],
  lookback = 60
): { isHeadAndShoulders: boolean; isInverseHeadAndShoulders: boolean; neckline: number | null }[] {
  return candles.map((c, i) => {
    if (i < lookback + 2) {
      return { isHeadAndShoulders: false, isInverseHeadAndShoulders: false, neckline: null };
    }

    const window = candles.slice(i - lookback, i); // 直前lookback本（現在足は含まない）
    const n = window.length;

    // ローカル高値（山）と安値（谷）を検出（前後1本より高い/低い点）
    const peaks: { idx: number; price: number }[] = [];
    const troughs: { idx: number; price: number }[] = [];

    for (let j = 1; j < n - 1; j++) {
      if (window[j].high > window[j - 1].high && window[j].high > window[j + 1].high) {
        peaks.push({ idx: j, price: window[j].high });
      }
      if (window[j].low < window[j - 1].low && window[j].low < window[j + 1].low) {
        troughs.push({ idx: j, price: window[j].low });
      }
    }

    let isHeadAndShoulders = false;
    let isInverseHeadAndShoulders = false;
    let neckline: number | null = null;

    // ===== 三尊（ヘッド&ショルダー）=====
    if (peaks.length >= 3) {
      const ls = peaks[peaks.length - 3]; // 左ショルダー
      const hd = peaks[peaks.length - 2]; // ヘッド
      const rs = peaks[peaks.length - 1]; // 右ショルダー

      // 各山が時系列順に並んでいること（最低3本間隔）
      if (hd.idx > ls.idx + 2 && rs.idx > hd.idx + 2) {
        // ヘッドが最も高い
        const headIsHighest = hd.price > ls.price && hd.price > rs.price;

        // 左右ショルダーの高さが近い（差が1.5%以内）
        const shoulderDiff = Math.abs(ls.price - rs.price) / Math.max(ls.price, rs.price);
        const shouldersSymmetric = shoulderDiff <= 0.015;

        if (headIsHighest && shouldersSymmetric) {
          // ネックライン = 左ショルダーとヘッドの間の最安値 と ヘッドと右ショルダーの間の最安値 の平均
          const leftTrough = Math.min(...window.slice(ls.idx, hd.idx + 1).map(w => w.low));
          const rightTrough = Math.min(...window.slice(hd.idx, rs.idx + 1).map(w => w.low));
          const neck = (leftTrough + rightTrough) / 2;

          // 現在足がネックラインを下抜け
          if (c.close < neck) {
            isHeadAndShoulders = true;
            neckline = Math.round(neck * 10) / 10;
          }
        }
      }
    }

    // ===== 逆三尊（インバース H&S）=====
    if (!isHeadAndShoulders && troughs.length >= 3) {
      const ls = troughs[troughs.length - 3]; // 左ショルダー
      const hd = troughs[troughs.length - 2]; // ヘッド（最も深い谷）
      const rs = troughs[troughs.length - 1]; // 右ショルダー

      // 各谷が時系列順に並んでいること（最低3本間隔）
      if (hd.idx > ls.idx + 2 && rs.idx > hd.idx + 2) {
        // ヘッドが最も深い（安値が最も低い）
        const headIsLowest = hd.price < ls.price && hd.price < rs.price;

        // 左右ショルダーの深さが近い（差が1.5%以内）
        const shoulderDiff = Math.abs(ls.price - rs.price) / Math.min(ls.price, rs.price);
        const shouldersSymmetric = shoulderDiff <= 0.015;

        if (headIsLowest && shouldersSymmetric) {
          // ネックライン = 左ショルダーとヘッドの間の最高値 と ヘッドと右ショルダーの間の最高値 の平均
          const leftPeak = Math.max(...window.slice(ls.idx, hd.idx + 1).map(w => w.high));
          const rightPeak = Math.max(...window.slice(hd.idx, rs.idx + 1).map(w => w.high));
          const neck = (leftPeak + rightPeak) / 2;

          // 現在足がネックラインを上抜け
          if (c.close > neck) {
            isInverseHeadAndShoulders = true;
            neckline = Math.round(neck * 10) / 10;
          }
        }
      }
    }

    return { isHeadAndShoulders, isInverseHeadAndShoulders, neckline };
  });
}
