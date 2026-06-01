import React, { useState, useCallback, useRef } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, Brain, TrendingUp, TrendingDown, Minus, Target, ShieldAlert } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { MarketState, Stock } from '../types';
import { AdvisorDiagnosis } from '../lib/advisor';

interface AIAdvisorPanelProps {
  marketState: MarketState | null;
  selectedStock: Stock;
  rsiUpper: number;
  rsiLower: number;
  ruleBasedDiagnosis: AdvisorDiagnosis | null;
}

type AnalysisResult = {
  verdict: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  reason: string;
  warning: string | null;
  timestamp: number;
  currentPrice: number;
};

const VERDICT_CONFIG = {
  BUY: {
    label: '買い',
    labelEn: 'BUY',
    bg: 'bg-red-500',
    border: 'border-red-500/60',
    text: 'text-red-400',
    bgLight: 'bg-red-950/30',
    icon: TrendingUp,
    description: '今すぐエントリー推奨',
  },
  SELL: {
    label: '売り',
    labelEn: 'SELL',
    bg: 'bg-emerald-500',
    border: 'border-emerald-500/60',
    text: 'text-emerald-400',
    bgLight: 'bg-emerald-950/30',
    icon: TrendingDown,
    description: '手仕舞い / 空売り推奨',
  },
  WAIT: {
    label: '様子見',
    labelEn: 'WAIT',
    bg: 'bg-yellow-500',
    border: 'border-yellow-500/60',
    text: 'text-yellow-400',
    bgLight: 'bg-yellow-950/20',
    icon: Minus,
    description: 'エントリー見送り',
  },
};

export default function AIAdvisorPanel({
  marketState,
  selectedStock,
  rsiUpper,
  rsiLower,
  ruleBasedDiagnosis,
}: AIAdvisorPanelProps) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRequestRef = useRef<number>(0);

  const analyzeMarket = trpc.aiAnalysis.analyzeMarket.useMutation({
    onSuccess: (data) => {
      setResult(data as AnalysisResult);
      setIsAnalyzing(false);
      setError(null);
    },
    onError: (err) => {
      setError('AI分析に失敗しました。再試行してください。');
      setIsAnalyzing(false);
    },
  });

  const handleAnalyze = useCallback(() => {
    if (!marketState || isAnalyzing) return;
    const now = Date.now();
    if (now - lastRequestRef.current < 8000) return;
    lastRequestRef.current = now;

    setIsAnalyzing(true);
    setError(null);

    analyzeMarket.mutate({
      symbol: selectedStock.symbol,
      stockName: selectedStock.name,
      currentPrice: marketState.currentPrice,
      priceChange: marketState.priceChange,
      priceChangePercent: marketState.priceChangePercent,
      volume: marketState.volume,
      candles: marketState.candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        ma5: c.ma5,
        ma25: c.ma25,
        rsi: c.rsi,
        bbUpper: c.bbUpper,
        bbMiddle: c.bbMiddle,
        bbLower: c.bbLower,
      })),
      board: {
        asks: marketState.board.asks.map((a) => ({ price: a.price, volume: a.volume, type: a.type })),
        bids: marketState.board.bids.map((b) => ({ price: b.price, volume: b.volume, type: b.type })),
        totalAskVolume: marketState.board.totalAskVolume,
        totalBidVolume: marketState.board.totalBidVolume,
      },
      trades: marketState.trades.slice(0, 20).map((t) => ({
        time: t.time,
        price: t.price,
        volume: t.volume,
        changeType: t.changeType,
        sizeType: t.sizeType,
      })),
      rsiUpper,
      rsiLower,
    });
  }, [marketState, isAnalyzing, selectedStock, rsiUpper, rsiLower, analyzeMarket]);

  const cfg = result ? VERDICT_CONFIG[result.verdict] : null;
  const VerdictIcon = cfg?.icon ?? Brain;

  // ルールベーススコアのメーター表示（-100〜+100 → 0〜100%）
  const ruleScore = ruleBasedDiagnosis?.score ?? 0;
  const rulePercentage = ((ruleScore + 100) / 200) * 100;

  return (
    <div className={`border rounded-lg overflow-hidden transition-all duration-300 ${
      result
        ? `${VERDICT_CONFIG[result.verdict].border} ${VERDICT_CONFIG[result.verdict].bgLight}`
        : 'border-border bg-card/60'
    }`}>
      {/* ヘッダー行 */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/40 bg-card/40">
        <div className="flex items-center space-x-2">
          <Brain className="w-4 h-4 text-primary" />
          <span className="text-xs font-bold text-foreground">AI売買シグナル診断</span>
          <span className="text-[9px] bg-primary/20 text-primary px-1.5 py-0.5 rounded border border-primary/30 font-mono">LLM搭載</span>
        </div>
        <button
          onClick={handleAnalyze}
          disabled={!marketState || isAnalyzing}
          className={`flex items-center space-x-1.5 px-3 py-1 rounded text-[11px] font-bold border transition-all duration-200 ${
            isAnalyzing
              ? 'bg-primary/10 text-primary border-primary/30 cursor-wait'
              : !marketState
              ? 'bg-muted text-muted-foreground border-border cursor-not-allowed'
              : 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20 active:scale-95'
          }`}
        >
          {isAnalyzing ? (
            <><RefreshCw className="w-3 h-3 animate-spin" /><span>分析中...</span></>
          ) : (
            <><Sparkles className="w-3 h-3" /><span>AI分析を実行</span></>
          )}
        </button>
      </div>

      <div className="p-3.5">
        {/* ===== AI分析結果エリア ===== */}
        {isAnalyzing && (
          <div className="flex items-center justify-center py-5 space-x-3">
            <div className="flex space-x-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">チャート・板・歩み値をAIが読み解いています...</span>
          </div>
        )}

        {error && !isAnalyzing && (
          <div className="flex items-center space-x-2 text-yellow-400 text-xs bg-yellow-950/30 border border-yellow-500/30 rounded p-2 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && !isAnalyzing && cfg && (
          <div className="space-y-3">
            {/* ★ 結論バッジ（最も目立つ部分） */}
            <div className="flex items-center gap-3">
              <div className={`flex items-center space-x-2 px-4 py-2.5 rounded-lg ${cfg.bg} text-white font-extrabold text-lg tracking-wide shadow-lg`}>
                <VerdictIcon className="w-5 h-5" />
                <span>{cfg.label}</span>
              </div>
              <div className="flex flex-col">
                <span className={`text-xs font-bold ${cfg.text}`}>{cfg.description}</span>
                <div className="flex items-center space-x-1 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">確信度:</span>
                  <div className="flex space-x-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className={`w-3 h-3 rounded-sm ${i <= result.confidence ? cfg.bg : 'bg-secondary/60'}`}
                      />
                    ))}
                  </div>
                  <span className={`text-[10px] font-bold ${cfg.text}`}>{result.confidence}/5</span>
                </div>
              </div>
              <div className="ml-auto text-[10px] text-muted-foreground font-mono">
                {new Date(result.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            </div>

            {/* 価格情報（エントリー・損切り・利確） */}
            {(result.entry_price || result.stop_loss || result.take_profit) && (
              <div className="grid grid-cols-3 gap-2">
                {result.entry_price && (
                  <div className="bg-secondary/30 border border-border/50 rounded p-2 text-center">
                    <div className="text-[9px] text-muted-foreground font-bold flex items-center justify-center space-x-1">
                      <Target className="w-2.5 h-2.5" /><span>エントリー</span>
                    </div>
                    <div className="text-sm font-extrabold text-foreground font-mono mt-0.5">{result.entry_price.toFixed(1)}</div>
                  </div>
                )}
                {result.stop_loss && (
                  <div className="bg-secondary/30 border border-border/50 rounded p-2 text-center">
                    <div className="text-[9px] text-muted-foreground font-bold flex items-center justify-center space-x-1">
                      <ShieldAlert className="w-2.5 h-2.5 text-emerald-400" /><span>損切り</span>
                    </div>
                    <div className="text-sm font-extrabold text-emerald-400 font-mono mt-0.5">{result.stop_loss.toFixed(1)}</div>
                  </div>
                )}
                {result.take_profit && (
                  <div className="bg-secondary/30 border border-border/50 rounded p-2 text-center">
                    <div className="text-[9px] text-muted-foreground font-bold flex items-center justify-center space-x-1">
                      <TrendingUp className="w-2.5 h-2.5 text-destructive" /><span>利確目標</span>
                    </div>
                    <div className="text-sm font-extrabold text-destructive font-mono mt-0.5">{result.take_profit.toFixed(1)}</div>
                  </div>
                )}
              </div>
            )}

            {/* 判断理由（1〜2文） */}
            <div className={`rounded p-2.5 border ${cfg.border} bg-card/40`}>
              <p className="text-[11px] text-foreground leading-relaxed">{result.reason}</p>
              {result.warning && (
                <p className="text-[10px] text-yellow-400 mt-1.5 flex items-start space-x-1">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{result.warning}</span>
                </p>
              )}
            </div>
          </div>
        )}

        {!result && !isAnalyzing && !error && (
          <div className="flex flex-col items-center justify-center py-3 space-y-2 text-center">
            <Brain className="w-7 h-7 text-muted-foreground/40" />
            <p className="text-[11px] text-muted-foreground">
              「AI分析を実行」を押すと、<br />
              <span className="font-bold text-foreground">買い / 売り / 様子見</span> を即座に判定します
            </p>
          </div>
        )}

        {/* ===== テクニカル指標メーター（ルールベース・常時表示） ===== */}
        {ruleBasedDiagnosis && (
          <div className="mt-3 pt-3 border-t border-border/30">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-muted-foreground">テクニカル指標スコア（自動計算）</span>
              <span className={`text-[10px] font-bold ${ruleBasedDiagnosis.colorClass}`}>
                {ruleScore > 20 ? '買い優勢' : ruleScore < -20 ? '売り優勢' : '中立'}
                {' '}({ruleScore > 0 ? '+' : ''}{ruleScore})
              </span>
            </div>
            <div className="relative h-2 bg-secondary/60 rounded-full overflow-hidden border border-border/50">
              <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/20 via-transparent to-destructive/20" />
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border/80 z-10" />
              <div
                className="absolute top-0.5 bottom-0.5 w-1.5 rounded-full bg-foreground shadow-[0_0_6px_rgba(255,255,255,0.7)] transition-all duration-500 ease-out z-20"
                style={{ left: `calc(${rulePercentage}% - 3px)` }}
              />
            </div>
            <div className="flex justify-between text-[9px] text-muted-foreground font-mono mt-0.5">
              <span>←売り</span><span>中立</span><span>買い→</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
