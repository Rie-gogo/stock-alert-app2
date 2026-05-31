import React from 'react';
import { AdvisorDiagnosis } from '../lib/advisor';
import { Sparkles, HelpCircle, ArrowRight } from 'lucide-react';

interface AdvisorPanelProps {
  diagnosis: AdvisorDiagnosis;
}

export default function AdvisorPanel({ diagnosis }: AdvisorPanelProps) {
  // スコア（-100〜100）をプログレスバー用の%（0〜100）に変換
  const percentage = ((diagnosis.score + 100) / 200) * 100;

  return (
    <div className={`border rounded-lg p-3.5 ${diagnosis.bgClass} transition-all duration-300`}>
      <div className="flex items-center justify-between mb-3 select-none">
        <div className="flex items-center space-x-2">
          <Sparkles className={`w-4 h-4 ${diagnosis.colorClass}`} />
          <h3 className="text-xs font-bold text-foreground">リアルタイム売買シグナル診断（AIアドバイザー）</h3>
        </div>
        <div className="text-[10px] text-muted-foreground flex items-center space-x-1">
          <span>信頼度: 高（テクニカル合致度）</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
        {/* 左側: メーター表示 (5/12) */}
        <div className="md:col-span-5 space-y-2">
          <div className="flex justify-between items-end">
            <span className="text-[10px] text-muted-foreground font-bold">現在の市場センチメント</span>
            <span className={`text-sm font-extrabold tracking-tight ${diagnosis.colorClass}`}>
              {diagnosis.label}
            </span>
          </div>

          {/* カスタムメーターバー */}
          <div className="relative h-4 bg-secondary/60 rounded-full overflow-hidden border border-border/50">
            {/* ニュートラル中心線 */}
            <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-border/80 z-10" />
            
            {/* メーターのカラーグラデーション背景 */}
            <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/20 via-transparent to-destructive/20" />

            {/* 現在のスコアを指すインジケーターピン */}
            <div
              className="absolute top-0 bottom-0 w-1 bg-foreground shadow-[0_0_8px_rgba(255,255,255,0.8)] transition-all duration-500 ease-out z-20"
              style={{ left: `${percentage}%` }}
            />
          </div>

          <div className="flex justify-between text-[9px] text-muted-foreground font-mono">
            <span>売り（ショート）</span>
            <span>様子見</span>
            <span>買い（ロング）</span>
          </div>
        </div>

        {/* 右側: 判断理由リスト (7/12) */}
        <div className="md:col-span-7 border-t md:border-t-0 md:border-l border-border/40 pt-3 md:pt-0 md:pl-4 space-y-1.5">
          <span className="text-[10px] text-muted-foreground font-bold block">💡 診断された判断理由:</span>
          <div className="space-y-1 max-h-[85px] overflow-y-auto pr-1">
            {diagnosis.reason.map((r, index) => (
              <div key={index} className="flex items-start space-x-1.5 text-[10px] text-foreground leading-normal">
                <ArrowRight className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                <span>{r}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
