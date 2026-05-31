import { CandleData, TradeTick } from '../types';
import { enrichCandlesWithTechnicals } from './technicals';

export interface DailyTrade {
  time: string;
  type: 'buy' | 'sell';
  price: number;
  shares: number;
  totalAmount: number;
  profit?: number; // 決済（売り）時のみ
  profitRate?: number;
}

export interface StockReport {
  symbol: string;
  name: string;
  initialCapital: number;
  finalBalance: number;
  profitAmount: number;
  profitRate: number;
  tradesCount: number;
  winCount: number;
  winRate: number;
  trades: DailyTrade[];
  lossCauses: string[];
  countermeasures: string[];
}

export interface DailyReport {
  date: string;
  totalInitialCapital: number;
  totalFinalBalance: number;
  totalProfitAmount: number;
  totalProfitRate: number;
  stockReports: StockReport[];
}

// 指定された10銘柄の定義
export const TARGET_STOCKS = [
  { symbol: '6526', name: 'ソシオネクスト' },
  { symbol: '6920', name: 'レーザーテック' },
  { symbol: '6857', name: 'アドバンテスト' },
  { symbol: '9107', name: '川崎汽船' },
  { symbol: '8306', name: '三菱UFJ FG' },
  { symbol: '9984', name: 'ソフトバンクグループ' },
  { symbol: '8035', name: '東京エレクトロン' },
  { symbol: '7011', name: '三菱重工業' },
  { symbol: '4568', name: '第一三共' },
  { symbol: '3778', name: 'さくらインターネット' },
];

/**
 * 擬似的なヒストリカルデータを生成する
 */
function generateHistoricalCandles(symbol: string, seedPrice: number, count = 100): CandleData[] {
  const candles: CandleData[] = [];
  let currentPrice = seedPrice;
  const now = new Date();

  for (let i = count; i >= 0; i--) {
    const timeStr = new Date(now.getTime() - i * 60 * 1000).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    // 銘柄ごとのボラティリティ特性
    let volatility = 0.003;
    if (['6920', '3778', '8035'].includes(symbol)) volatility = 0.006; // ハイボラティリティ
    if (['8306', '4568'].includes(symbol)) volatility = 0.0015; // ローボラティリティ

    const change = currentPrice * volatility * (Math.random() - 0.49); // わずかに上昇バイアス
    const open = currentPrice;
    const close = currentPrice + change;
    const high = Math.max(open, close) + currentPrice * volatility * 0.3 * Math.random();
    const low = Math.min(open, close) - currentPrice * volatility * 0.3 * Math.random();
    const volume = Math.floor(10000 + Math.random() * 90000);

    candles.push({
      time: timeStr,
      timestamp: now.getTime() - i * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });

    currentPrice = close;
  }

  return enrichCandlesWithTechnicals(candles);
}

/**
 * 1銘柄のバックテスト（シミュレーション）を実行する
 */
export function simulateStock(
  symbol: string,
  name: string,
  initialCapital = 3000000, // 元金300万円
  rsiUpper = 70,
  rsiLower = 30
): StockReport {
  // 銘柄ごとの基準価格
  let basePrice = 3000;
  if (symbol === '6920') basePrice = 25000;
  if (symbol === '8035') basePrice = 35000;
  if (symbol === '8306') basePrice = 1500;
  if (symbol === '9107') basePrice = 2200;

  const candles = generateHistoricalCandles(symbol, basePrice, 80);
  const trades: DailyTrade[] = [];
  
  let capital = initialCapital;
  let positionShares = 0;
  let positionPrice = 0;
  let winCount = 0;
  let lossCount = 0;

  // 移動平均、RSI、ボリンジャーバンドに基づいたシミュレーション
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    if (
      curr.rsi === undefined ||
      curr.ma5 === undefined ||
      curr.ma25 === undefined ||
      curr.bbLower === undefined ||
      curr.bbUpper === undefined ||
      prev.ma5 === undefined ||
      prev.ma25 === undefined
    ) {
      continue;
    }

    // 1. 買いシグナル (高勝率な合流条件：ゴールデンクロス、またはトレンドが下降中でない状態での売られすぎ＋ボリバン下限タッチ)
    const isRsiOversold = curr.rsi <= rsiLower;
    const isBbLower = curr.close <= curr.bbLower;
    const isGoldenCross = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    
    // 強い下降トレンド（落ちてくるナイフ）の判定
    const isDownTrend = curr.ma5 < curr.ma25;
    const isStrongDownTrend = isDownTrend && curr.close < curr.ma5;

    // 「ここぞというタイミング」：
    // - 強い下降トレンド中は絶対に買わない
    // - (ゴールデンクロス発生) または (RSI売られすぎ かつ ボリバン下限にタッチ) の時に厳選
    const shouldBuy = !isStrongDownTrend && (isGoldenCross || (isRsiOversold && isBbLower));

    if (positionShares === 0 && shouldBuy) {
      // 資金の全額(または最大)で買えるだけ買う
      const maxSpend = capital * 0.98; // 手数料等のバッファ
      const shares = Math.floor(maxSpend / curr.close);
      
      if (shares > 0) {
        const totalAmount = shares * curr.close;
        positionShares = shares;
        positionPrice = curr.close;
        capital -= totalAmount;

        trades.push({
          time: curr.time,
          type: 'buy',
          price: curr.close,
          shares,
          totalAmount,
        });
      }
    }

    // 2. 売りシグナル (上昇トレンドのフライング売り防止 ＆ デッドクロス厳選)
    const isRsiOverbought = curr.rsi >= rsiUpper;
    const isBbUpper = curr.close >= curr.bbUpper;
    const isDeadCross = prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25;

    // 強い上昇トレンド中はRSI/ボリバン上限タッチでの売りを抑制（ホールド）
    const isStrongUpTrend = curr.ma5 > curr.ma25 * 1.003 && curr.close >= curr.ma5;
    
    // 売りシグナルの厳格化：デッドクロス発生、または(トレンドが強くない状態での買われすぎ＋ボリバン上限)
    const shouldSell = isDeadCross || (isRsiOverbought && isBbUpper && !isStrongUpTrend);

    // 損切りロジック (-1.5% で強制損切り)
    const isStopLoss = positionShares > 0 && curr.close <= positionPrice * 0.985;

    if (positionShares > 0 && (shouldSell || isStopLoss)) {
      const totalAmount = positionShares * curr.close;
      const profit = totalAmount - (positionShares * positionPrice);
      const profitRate = (curr.close - positionPrice) / positionPrice;
      
      capital += totalAmount;

      if (profit > 0) winCount++;
      else lossCount++;

      trades.push({
        time: curr.time,
        type: 'sell',
        price: curr.close,
        shares: positionShares,
        totalAmount,
        profit,
        profitRate,
      });

      positionShares = 0;
      positionPrice = 0;
    }
  }

  // 最後にポジションが残っていたら、現在の価格で強制決済（ノーポジションで1日を終える）
  if (positionShares > 0) {
    const lastCandle = candles[candles.length - 1];
    const totalAmount = positionShares * lastCandle.close;
    const profit = totalAmount - (positionShares * positionPrice);
    const profitRate = (lastCandle.close - positionPrice) / positionPrice;
    
    capital += totalAmount;
    if (profit > 0) winCount++;
    else lossCount++;

    trades.push({
      time: lastCandle.time,
      type: 'sell',
      price: lastCandle.close,
      shares: positionShares,
      totalAmount,
      profit,
      profitRate,
    });
  }

  const finalBalance = capital;
  const profitAmount = finalBalance - initialCapital;
  const profitRate = profitAmount / initialCapital;
  const tradesCount = trades.filter(t => t.type === 'sell').length;
  const winRate = tradesCount > 0 ? winCount / tradesCount : 0;

  // マイナス（損失）が発生した場合の原因と対策を動的生成
  const lossCauses: string[] = [];
  const countermeasures: string[] = [];

  if (profitAmount < 0) {
    if (lossCount > winCount) {
      lossCauses.push('📉 レンジ相場（もみ合い）での細かな損切りの連続（往復ビンタ）。');
      countermeasures.push('🛡️ レンジ相場を検知した場合は、MAクロスによるトレンドフォロー取引を一時停止し、RSI逆張りに切り替える。');
    }
    // ボラティリティの高い銘柄
    if (['6920', '3778', '8035'].includes(symbol)) {
      lossCauses.push('⚡ 値動き（ボラティリティ）が非常に激しく、買いエントリー直後に逆行して強制損切りにかかった。');
      countermeasures.push('📏 激しい銘柄については、損切り幅を通常の1.5%から2.5%〜3%に広げ、ノイズによる損切りを回避する。');
    } else {
      lossCauses.push('💤 トレンドが弱く、買いシグナル後に価格が動かず、手数料や微減のまま時間切れ決済となった。');
      countermeasures.push('⏱️ ボラティリティ（値幅）が一定以下の時はエントリーを見送るフィルター（ADX等の導入）を検討する。');
    }
    lossCauses.push('📈 急激なトレンド転換に対して、1分足の移動平均線の反応が遅れ、高値掴み・安値売りとなった。');
    countermeasures.push('⚙️ 移動平均線の期間を5MAから3MAなど、より短期に設定して反応速度を上げる。');
  } else {
    // 利益が出ている場合でも、潜在的なリスク要因
    lossCauses.push('✅ 本日は利益を確保できましたが、トレンドの終盤でエントリーする微小な高値掴みが発生していました。');
    countermeasures.push('🎯 トレンド発生から時間が経過している場合は、エントリーのロット数を半分にするなどの資金管理を徹底する。');
  }

  return {
    symbol,
    name,
    initialCapital,
    finalBalance,
    profitAmount,
    profitRate,
    tradesCount,
    winCount,
    winRate,
    trades,
    lossCauses,
    countermeasures,
  };
}

/**
 * 10銘柄すべてのデイリーレポートを生成する
 */
export function generateDailyReport(dateStr: string, rsiUpper = 70, rsiLower = 30): DailyReport {
  const stockReports = TARGET_STOCKS.map(stock =>
    simulateStock(stock.symbol, stock.name, 3000000, rsiUpper, rsiLower)
  );

  const totalInitialCapital = 3000000 * TARGET_STOCKS.length; // 3000万円
  const totalFinalBalance = stockReports.reduce((sum, r) => sum + r.finalBalance, 0);
  const totalProfitAmount = totalFinalBalance - totalInitialCapital;
  const totalProfitRate = totalProfitAmount / totalInitialCapital;

  return {
    date: dateStr,
    totalInitialCapital,
    totalFinalBalance,
    totalProfitAmount,
    totalProfitRate,
    stockReports,
  };
}
