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
 * テクニカル指標、大口歩み値、板需給から、現在の売買判断スコアを計算する
 */
export function diagnoseMarket(
  candles: CandleData[],
  trades: TradeTick[],
  rsiUpper: number,
  rsiLower: number,
  askTotal: number = 0,
  bidTotal: number = 0
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

  // トレンドの厳密判定
  const isUpTrend = curr.ma5 !== undefined && curr.ma25 !== undefined && curr.ma5 > curr.ma25;
  const isDownTrend = curr.ma5 !== undefined && curr.ma25 !== undefined && curr.ma5 < curr.ma25;
  const isStrongDownTrend = isDownTrend && curr.ma5 !== undefined && curr.close < curr.ma5; // 価格が短期線の下にある極めて強い下落トレンド
  const isStrongUpTrend = isUpTrend && curr.ma5 !== undefined && curr.close >= curr.ma5; // バンドウォーク等、非常に強い上昇トレンド

  // 1. 移動平均線（MA）の状況
  if (curr.ma5 !== undefined && curr.ma25 !== undefined && prev.ma5 !== undefined && prev.ma25 !== undefined) {
    if (isStrongUpTrend) {
      score += 35;
      reasons.push('📈 短期線(5MA)が長期線(25MA)の上方にあり、価格も5MAの上を推移する強い上昇トレンドです。');
    } else if (isStrongDownTrend) {
      score -= 45; // 下落トレンド時のペナルティを大幅に強化
      reasons.push('📉 短期線(5MA)が長期線(25MA)の下方にあり、価格が5MAの下を滑り落ちる極めて危険な下降トレンドです。');
    } else if (isUpTrend) {
      score += 15;
      reasons.push('📈 上昇トレンドですが、勢いはやや落ち着いています。');
    } else if (isDownTrend) {
      score -= 20;
      reasons.push('📉 下降トレンドです。買いエントリーは慎重に避けるべき局面です。');
    }

    // ゴールデンクロス/デッドクロス直後の加点
    if (prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25) {
      score += 25;
      reasons.push('🚀 【大チャンス】ゴールデンクロスが直近で発生しました！トレンド転換の兆しです。');
    } else if (prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25) {
      score -= 30;
      reasons.push('⚠️ 【急落注意】デッドクロスが直近で発生しました！直ちに売り避難を検討してください。');
    }
  }

  // 2. RSI（売られすぎ・買われすぎ）
  if (curr.rsi !== undefined) {
    if (curr.rsi <= rsiLower) {
      if (isStrongDownTrend) {
        // 【重要改善】落ちてくるナイフ対策：強い下降トレンド中は、RSIがどれだけ低くても買い推奨に加点しない（むしろペナルティ）
        score -= 25;
        reasons.push(`🛡️ RSIは${curr.rsi.toFixed(0)}%と極めて低いですが、「落ちてくるナイフ（強い下落）」状態のため、反発を確認するまで絶対に買ってはいけません。`);
      } else {
        score += 30;
        reasons.push(`⚡ RSIが${curr.rsi.toFixed(0)}%と低く、下落トレンドではないため「売られすぎ」からの反発チャンスです。`);
      }
    } else if (curr.rsi >= rsiUpper) {
      if (isStrongUpTrend) {
        // 強い上昇トレンド中は、RSIが高くても売りスコアを引かず、上昇の強さを評価してホールド推奨とする
        score += 15; 
        reasons.push(`🔥 RSIは${curr.rsi.toFixed(0)}%と高い（買われすぎ）ですが、非常に強い上昇トレンドのため「ホールド（上昇継続）」を推奨します。`);
      } else {
        score -= 35;
        reasons.push(`🔥 RSIが${curr.rsi.toFixed(0)}%と極めて高く、調整下落（天井圏）の危険があります。`);
      }
    } else {
      if (curr.rsi > 45 && curr.rsi < 55) {
        reasons.push('⚖️ RSIは50%前後で、拮抗状態（もみ合い）です。');
      }
    }
  }

  // 3. ボリンジャーバンド
  if (curr.bbUpper !== undefined && curr.bbLower !== undefined) {
    if (curr.close <= curr.bbLower) {
      if (isStrongDownTrend) {
        // 【重要改善】ボリバン下限を突き破って落ちている時は、反発ではなく下落加速のシグナル
        score -= 20;
        reasons.push('⚠️ 価格がボリバン下限(-2σ)を突き破って下落中。下落が加速しているため様子見が安全です。');
      } else {
        score += 25;
        reasons.push('🛡️ 価格がボリバン下限(-2σ)に到達。緩やかな相場での自律反発ポイントです。');
      }
    } else if (curr.close >= curr.bbUpper) {
      if (isStrongUpTrend) {
        score += 10;
        reasons.push('🎯 価格がボリバン上限(+2σ)を突破してバンドウォーク中。強い買い圧力が続いています。');
      } else {
        score -= 30;
        reasons.push('🎯 価格がボリバン上限(+2σ)に到達。上昇トレンドではないため、押し戻されやすい天井です。');
      }
    }
  }

  // 4. 板情報（需給バランス）の統合評価
  if (askTotal > 0 && bidTotal > 0) {
    const askRatio = askTotal / (askTotal + bidTotal);
    if (askRatio >= 0.6) {
      score -= 25; // 売り板が圧倒的に厚い場合は、買い評価を大幅減点
      reasons.push(`📊 板需給：売り注文が圧倒的に優勢（売り板 ${(askRatio * 100).toFixed(0)}%）。上値が極めて重い状態です。`);
    } else if (askRatio <= 0.4) {
      score += 20; // 買い板が厚い場合
      reasons.push(`📊 板需給：買い注文が優勢（買い板 ${((1 - askRatio) * 100).toFixed(0)}%）。下値が支えられています。`);
    }
  }

  // 5. 大口の直近取引傾向 (歩み値の累積ネット出来高)
  const recentTrades = trades.slice(0, 15);
  let netLargeVolume = 0; // 大口のネット出来高 (買い株数 - 売り株数)
  
  recentTrades.forEach(t => {
    if (t.sizeType === 'large' || t.sizeType === 'huge') {
      if (t.changeType === 'up') {
        netLargeVolume += t.volume;
      } else if (t.changeType === 'down') {
        netLargeVolume -= t.volume;
      }
    }
  });

  if (netLargeVolume > 5000) {
    score += 15;
    reasons.push(`🛒 歩み値：直近で「大口の純買い（+${netLargeVolume.toLocaleString()}株）」が流入。強い買い支えがあります。`);
  } else if (netLargeVolume < -5000) {
    score -= 25; // 大口の売り崩しは警戒度を上げる
    reasons.push(`⚠️ 歩み値：直近で「大口の純売り崩し（${netLargeVolume.toLocaleString()}株）」が発生。急落への警戒が必要です。`);
  }

  // 【重要改善】絶対様子見ルール（落ちてくるナイフの強制排除）
  // 強い下降トレンド中で、大口の圧倒的な純買いが入っていない場合は、強制的に買いスコアをマイナスにする
  if (isStrongDownTrend && netLargeVolume < 10000) {
    score = Math.min(-30, score); // 買い推奨（正の数）になるのを絶対に阻止
  }

  // スコア範囲を [-100, 100] に制限
  score = Math.max(-100, Math.min(100, score));

  // ステータスの判定
  let status: AdvisorDiagnosis['status'] = 'neutral';
  let label = '様子見（ニュートラル）';
  let colorClass = 'text-muted-foreground';
  let bgClass = 'bg-muted/10 border-border';

  if (score >= 65) { // 買い推奨の基準値を引き上げ（より厳格に）
    status = 'strong_buy';
    label = '🔥 強力に買うべき（絶好の買い場）';
    colorClass = 'text-destructive';
    bgClass = 'bg-destructive/10 border-destructive/30 animate-pulse';
  } else if (score >= 25) {
    status = 'buy';
    label = '📈 買うべき（買い優勢）';
    colorClass = 'text-red-400';
    bgClass = 'bg-red-500/5 border-red-500/20';
  } else if (score <= -65) { // 売り推奨の基準値を引き下げ（より厳格に）
    status = 'strong_sell';
    label = '❄️ 強力に売るべき（即時避難推奨）';
    colorClass = 'text-emerald-400';
    bgClass = 'bg-emerald-500/10 border-emerald-500/30 animate-pulse';
  } else if (score <= -25) {
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
