import { CandleData, TradeTick } from '../types';

export interface AdvisorDiagnosis {
  score: number; // -100 (強力な売り) から +100 (強力な買い)
  status: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  label: string;
  colorClass: string;
  bgClass: string;
  reason: string[];
}

/**
 * テクニカル指標と大口歩み値から、現在の売買判断スコアを計算する
 */
export function diagnoseMarket(
  candles: CandleData[],
  trades: TradeTick[],
  rsiUpper: number,
  rsiLower: number
): AdvisorDiagnosis {
  if (candles.length < 2) {
    return {
      score: 0,
      status: 'neutral',
      label: 'データ収集中',
      colorClass: 'text-muted-foreground',
      bgClass: 'bg-muted/10 border-border',
      reason: ['十分なデータがまだ蓄積されていません。'],
    };
  }

  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  let score = 0;
  const reasons: string[] = [];

  // 1. 移動平均線（MA）の状況
  if (curr.ma5 !== undefined && curr.ma25 !== undefined && prev.ma5 !== undefined && prev.ma25 !== undefined) {
    if (curr.ma5 > curr.ma25) {
      score += 25;
      reasons.push('📈 短期線(5MA)が長期線(25MA)の上方にあり、上昇トレンドです。');
    } else {
      score -= 25;
      reasons.push('📉 短期線(5MA)が長期線(25MA)の下方にあり、下降トレンドです。');
    }

    // ゴールデンクロス/デッドクロス直後の加点
    if (prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25) {
      score += 20;
      reasons.push('🚀 【大チャンス】ゴールデンクロスが直近で発生しました！');
    } else if (prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25) {
      score -= 20;
      reasons.push('⚠️ 【急落注意】デッドクロスが直近で発生しました！');
    }
  }

  // 2. RSI（売られすぎ・買われすぎ）
  if (curr.rsi !== undefined) {
    if (curr.rsi <= rsiLower) {
      score += 35;
      reasons.push(`⚡ RSIが${curr.rsi.toFixed(0)}%と極めて低く、「売られすぎ」からの反発タイミングです。`);
    } else if (curr.rsi >= rsiUpper) {
      score -= 35;
      reasons.push(`🔥 RSIが${curr.rsi.toFixed(0)}%と極めて高く、「買われすぎ」による調整下落の危険があります。`);
    } else {
      // ニュートラル
      if (curr.rsi > 45 && curr.rsi < 55) {
        reasons.push('⚖️ RSIは50%前後で、拮抗状態（もみ合い）です。');
      }
    }
  }

  // 3. ボリンジャーバンド
  if (curr.bbUpper !== undefined && curr.bbLower !== undefined) {
    if (curr.close <= curr.bbLower) {
      score += 30;
      reasons.push('🛡️ 価格がボリンジャーバンドの最下限(-2σ)に到達。反発しやすい位置です。');
    } else if (curr.close >= curr.bbUpper) {
      score -= 30;
      reasons.push('🎯 価格がボリンジャーバンドの最上限(+2σ)に到達。売られやすい天井圏です。');
    }
  }

  // 4. 大口の直近取引傾向 (歩み値)
  const recentTrades = trades.slice(0, 10);
  const largeBuys = recentTrades.filter(t => (t.sizeType === 'large' || t.sizeType === 'huge') && t.changeType === 'up');
  const largeSells = recentTrades.filter(t => (t.sizeType === 'large' || t.sizeType === 'huge') && t.changeType === 'down');

  if (largeBuys.length > largeSells.length) {
    score += 15;
    reasons.push('🛒 直近で「大口の買い」が優勢です。仕掛けが入っている可能性があります。');
  } else if (largeSells.length > largeBuys.length) {
    score -= 15;
    reasons.push('⚠️ 直近で「大口の売り崩し」が優勢です。下落への警戒が必要です。');
  }

  // スコア範囲を [-100, 100] に制限
  score = Math.max(-100, Math.min(100, score));

  // ステータスの判定
  let status: AdvisorDiagnosis['status'] = 'neutral';
  let label = '様子見（ニュートラル）';
  let colorClass = 'text-muted-foreground';
  let bgClass = 'bg-muted/10 border-border';

  if (score >= 60) {
    status = 'strong_buy';
    label = '🔥 強力に買うべき（絶好の買い場）';
    colorClass = 'text-destructive';
    bgClass = 'bg-destructive/10 border-destructive/30 animate-pulse';
  } else if (score >= 20) {
    status = 'buy';
    label = '📈 買うべき（買い優勢）';
    colorClass = 'text-red-400';
    bgClass = 'bg-red-500/5 border-red-500/20';
  } else if (score <= -60) {
    status = 'strong_sell';
    label = '❄️ 強力に売るべき（即時避難推奨）';
    colorClass = 'text-emerald-400';
    bgClass = 'bg-emerald-500/10 border-emerald-500/30 animate-pulse';
  } else if (score <= -20) {
    status = 'sell';
    label = '📉 売るべき（売り優勢）';
    colorClass = 'text-emerald-500';
    bgClass = 'bg-emerald-500/5 border-emerald-500/20';
  }

  return {
    score,
    status,
    label,
    colorClass,
    bgClass,
    reason: reasons.length > 0 ? reasons : ['目立った売買シグナルはなく、価格は安定しています。'],
  };
}
