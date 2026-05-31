import React, { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { generateDailyReport, DailyReport, StockReport } from '../lib/dailyReport';
import { FileText, TrendingUp, TrendingDown, ArrowRight, AlertTriangle, CheckCircle2, Calendar, ShieldAlert } from 'lucide-react';

interface DailyReportModalProps {
  rsiUpper: number;
  rsiLower: number;
}

export default function DailyReportModal({ rsiUpper, rsiLower }: DailyReportModalProps) {
  const [selectedDate, setSelectedDate] = useState('2026-05-31');
  const [selectedStock, setSelectedStock] = useState<string | null>(null);

  // レポートデータの生成
  const report: DailyReport = useMemo(() => {
    return generateDailyReport(selectedDate, rsiUpper, rsiLower);
  }, [selectedDate, rsiUpper, rsiLower]);

  // 選択中の個別銘柄詳細レポート
  const activeStockReport = useMemo(() => {
    if (!selectedStock) return report.stockReports[0];
    return report.stockReports.find(r => r.symbol === selectedStock) || report.stockReports[0];
  }, [selectedStock, report]);

  const isTotalProfit = report.totalProfitAmount >= 0;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-primary/20 hover:bg-primary/30 border border-primary/30 text-xs font-bold text-primary transition-all duration-200">
          <FileText className="w-3.5 h-3.5" />
          <span>デイリー検証レポート</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto bg-card text-foreground border border-border">
        <DialogHeader className="border-b border-border/60 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center space-x-2">
              <FileText className="w-5 h-5 text-primary" />
              <DialogTitle className="text-base font-bold">10銘柄デイリーシミュレーション検証レポート</DialogTitle>
            </div>
            {/* 日付選択 */}
            <div className="flex items-center space-x-2 bg-secondary/40 px-2.5 py-1 rounded border border-border/60">
              <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent border-none text-xs font-mono font-bold focus:outline-none cursor-pointer"
              >
                <option value="2026-05-31" className="bg-card text-foreground">2026年05月31日（本日）</option>
                <option value="2026-05-30" className="bg-card text-foreground">2026年05月30日（昨日）</option>
                <option value="2026-05-29" className="bg-card text-foreground">2026年05月29日（２日前）</option>
              </select>
            </div>
          </div>
        </DialogHeader>

        {/* 1. 総合サマリーカード */}
        <div className={`mt-4 p-4 rounded-lg border ${isTotalProfit ? 'bg-destructive/5 border-destructive/20' : 'bg-emerald-500/5 border-emerald-500/20'} grid grid-cols-1 md:grid-cols-4 gap-4`}>
          <div>
            <span className="text-[10px] text-muted-foreground font-bold block">総元金（10銘柄合計）</span>
            <span className="text-lg font-mono font-extrabold text-foreground">30,000,000 円</span>
            <span className="text-[9px] text-muted-foreground block">各銘柄 3,000,000 円運用</span>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground font-bold block">検証後評価額合計</span>
            <span className="text-lg font-mono font-extrabold text-foreground">
              {report.totalFinalBalance.toLocaleString()} 円
            </span>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground font-bold block">総合損益（額）</span>
            <span className={`text-lg font-mono font-extrabold flex items-center ${isTotalProfit ? 'text-destructive' : 'text-emerald-400'}`}>
              {isTotalProfit ? <TrendingUp className="w-4 h-4 mr-1" /> : <TrendingDown className="w-4 h-4 mr-1" />}
              {isTotalProfit ? '+' : ''}{report.totalProfitAmount.toLocaleString()} 円
            </span>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground font-bold block">総合利益率</span>
            <span className={`text-lg font-mono font-extrabold ${isTotalProfit ? 'text-destructive' : 'text-emerald-400'}`}>
              {isTotalProfit ? '+' : ''}{(report.totalProfitRate * 100).toFixed(2)} %
            </span>
          </div>
        </div>

        {/* 2. メイングリッド: 左側 銘柄リスト (4/12) ＋ 右側 詳細分析 (8/12) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mt-4">
          
          {/* 左側: 10銘柄一覧 */}
          <div className="lg:col-span-4 border border-border/60 rounded-lg p-2.5 bg-card/40 space-y-1.5">
            <span className="text-[10px] text-muted-foreground font-bold block px-1">📊 銘柄別検証結果</span>
            <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
              {report.stockReports.map((r) => {
                const isProfit = r.profitAmount >= 0;
                const isSelected = selectedStock === r.symbol || (!selectedStock && r.symbol === '6526');

                return (
                  <button
                    key={r.symbol}
                    onClick={() => setSelectedStock(r.symbol)}
                    className={`w-full text-left p-2 rounded border transition-all duration-150 flex items-center justify-between ${
                      isSelected
                        ? 'bg-primary/10 border-primary text-foreground'
                        : 'bg-secondary/20 border-border/40 hover:bg-secondary/40 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-1.5">
                        <span className="text-[10px] font-mono font-bold text-foreground">{r.symbol}</span>
                        <span className="text-[10px] font-bold truncate text-foreground">{r.name}</span>
                      </div>
                      <span className="text-[9px] text-muted-foreground font-mono block">勝率: {(r.winRate * 100).toFixed(0)}% ({r.tradesCount}回)</span>
                    </div>
                    <div className="text-right ml-2 shrink-0">
                      <span className={`text-[11px] font-mono font-bold block ${isProfit ? 'text-destructive' : 'text-emerald-400'}`}>
                        {isProfit ? '+' : ''}{r.profitAmount.toLocaleString()}
                      </span>
                      <span className={`text-[9px] font-mono block ${isProfit ? 'text-destructive' : 'text-emerald-400'}`}>
                        {isProfit ? '+' : ''}{(r.profitRate * 100).toFixed(2)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 右側: 選択銘柄の詳細検証レポート */}
          <div className="lg:col-span-8 space-y-4">
            
            {/* 選択銘柄サマリー */}
            <div className="border border-border/60 rounded-lg p-3 bg-card/60 flex items-center justify-between">
              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-mono font-bold bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{activeStockReport.symbol}</span>
                  <h4 className="text-sm font-extrabold text-foreground">{activeStockReport.name}</h4>
                </div>
                <span className="text-[10px] text-muted-foreground block mt-1">
                  検証パラメータ: RSI(上限{rsiUpper} / 下限{rsiLower})・5MA/25MAクロス・ボリンジャーバンド±2σ
                </span>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-muted-foreground block">損益結果</span>
                <span className={`text-base font-mono font-extrabold ${activeStockReport.profitAmount >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                  {activeStockReport.profitAmount >= 0 ? '+' : ''}{activeStockReport.profitAmount.toLocaleString()} 円 ({(activeStockReport.profitRate * 100).toFixed(2)}%)
                </span>
              </div>
            </div>

            {/* マイナス原因 ＆ 対策パネル (ご要望の核心部分) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              {/* 原因 */}
              <div className="border border-border/60 rounded-lg p-3 bg-red-500/5">
                <div className="flex items-center space-x-1.5 mb-2 select-none">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                  <span className="text-[10px] text-red-400 font-extrabold">マイナス発生原因（または潜在的リスク）</span>
                </div>
                <div className="space-y-2">
                  {activeStockReport.lossCauses.map((cause, idx) => (
                    <div key={idx} className="flex items-start space-x-1.5 text-[10px] text-foreground leading-relaxed">
                      <span className="text-red-400 shrink-0">•</span>
                      <span>{cause}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 対策 */}
              <div className="border border-border/60 rounded-lg p-3 bg-emerald-500/5">
                <div className="flex items-center space-x-1.5 mb-2 select-none">
                  <ShieldAlert className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[10px] text-emerald-400 font-extrabold">今後の具体的な対策・回避ロジック</span>
                </div>
                <div className="space-y-2">
                  {activeStockReport.countermeasures.map((measure, idx) => (
                    <div key={idx} className="flex items-start space-x-1.5 text-[10px] text-foreground leading-relaxed">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                      <span>{measure}</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {/* 取引履歴タイムライン */}
            <div className="border border-border/60 rounded-lg p-3 bg-card/40">
              <span className="text-[10px] text-muted-foreground font-bold block mb-2">🕒 取引履歴（タイムライン）</span>
              <div className="max-h-[160px] overflow-y-auto space-y-1.5 pr-1">
                {activeStockReport.trades.length === 0 ? (
                  <div className="text-center py-6 text-[10px] text-muted-foreground">
                    本日、この銘柄での取引条件（シグナル）は発生しませんでした。
                  </div>
                ) : (
                  activeStockReport.trades.map((trade, idx) => {
                    const isBuy = trade.type === 'buy';
                    return (
                      <div key={idx} className="flex items-center justify-between p-2 rounded bg-secondary/20 border border-border/30 text-[10px] font-mono">
                        <div className="flex items-center space-x-3">
                          <span className="text-muted-foreground">{trade.time}</span>
                          <span className={`px-1.5 py-0.5 rounded font-bold text-[9px] ${isBuy ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-400'}`}>
                            {isBuy ? '買い' : '売り'}
                          </span>
                          <span className="text-foreground">{trade.shares.toLocaleString()} 株</span>
                          <span className="text-muted-foreground">@{trade.price.toFixed(1)} 円</span>
                        </div>
                        <div className="text-right">
                          <span className="text-foreground mr-3">取引額: {trade.totalAmount.toLocaleString()} 円</span>
                          {trade.profit !== undefined && (
                            <span className={`font-bold ${trade.profit >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                              損益: {trade.profit >= 0 ? '+' : ''}{trade.profit.toLocaleString()} 円 ({(trade.profitRate! * 100).toFixed(2)}%)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}
