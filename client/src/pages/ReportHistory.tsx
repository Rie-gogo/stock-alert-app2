import React, { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Link } from 'wouter';
import {
  TrendingUp,
  TrendingDown,
  Calendar,
  BarChart2,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  ArrowLeft,
  RefreshCw,
  Bot,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function ReportHistory() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<string | null>(null);

  const { data: reportList, isLoading: listLoading, refetch: refetchList } = trpc.trading.getReportList.useQuery({ limit: 60 });
  const { data: reportDetail, isLoading: detailLoading } = trpc.trading.getReportDetail.useQuery(
    { reportDate: selectedDate! },
    { enabled: !!selectedDate }
  );
  const { data: stats } = trpc.trading.getStats.useQuery({ days: 30 });

  const runSimMutation = trpc.trading.runSimulation.useMutation({
    onSuccess: () => {
      toast.success('シミュレーション完了！レポートを保存しました。');
      refetchList();
    },
    onError: (e) => toast.error(`エラー: ${e.message}`),
  });

  const improveMutation = trpc.trading.improveAlgorithm.useMutation({
    onSuccess: (data) => {
      toast.success(`AIがアルゴリズムを改善しました: ${data.improvement.reason}`);
    },
    onError: (e) => toast.error(`改善エラー: ${e.message}`),
  });

  const todayStr = new Date().toISOString().slice(0, 10);

  const handleRunToday = () => {
    runSimMutation.mutate({
      reportDate: todayStr,
      generateAiSummary: true,
    });
  };

  const handleImprove = () => {
    if (!reportDetail?.report?.id) {
      toast.error('先にレポートを選択してください');
      return;
    }
    improveMutation.mutate({ dailyReportId: reportDetail.report.id });
  };

  const activeStockReport = reportDetail?.stocks?.find((s) => s.symbol === selectedStock)
    ?? reportDetail?.stocks?.[0];

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* ヘッダー */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Link href="/">
            <button className="flex items-center space-x-1.5 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs">ダッシュボードに戻る</span>
            </button>
          </Link>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center space-x-2">
            <BarChart2 className="w-4 h-4 text-primary" />
            <h1 className="text-sm font-bold">デイリーレポート履歴 & アルゴリズム改善</h1>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRunToday}
            disabled={runSimMutation.isPending}
            className="text-xs"
          >
            {runSimMutation.isPending ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" />
            ) : (
              <Zap className="w-3.5 h-3.5 mr-1" />
            )}
            本日のシミュレーション実行
          </Button>
        </div>
      </header>

      <div className="p-4 grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* 左側: 統計サマリー + レポート一覧 */}
        <div className="xl:col-span-3 space-y-4">
          {/* 直近30日統計 */}
          {stats && (
            <Card className="border-border bg-card/60">
              <CardHeader className="py-2.5 px-3 border-b border-border/50">
                <CardTitle className="text-xs font-bold flex items-center space-x-1.5">
                  <BarChart2 className="w-3.5 h-3.5 text-primary" />
                  <span>直近30日間の成績</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="py-3 px-3 grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[9px] text-muted-foreground block">シミュレーション日数</span>
                  <span className="text-sm font-mono font-bold text-foreground">{stats.totalDays}日</span>
                </div>
                <div>
                  <span className="text-[9px] text-muted-foreground block">平均勝率</span>
                  <span className={`text-sm font-mono font-bold ${stats.avgWinRate >= 0.8 ? 'text-destructive' : stats.avgWinRate >= 0.6 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                    {(stats.avgWinRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div>
                  <span className="text-[9px] text-muted-foreground block">平均損益率</span>
                  <span className={`text-sm font-mono font-bold ${stats.avgProfitRate >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                    {stats.avgProfitRate >= 0 ? '+' : ''}{(stats.avgProfitRate * 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-[9px] text-muted-foreground block">累計損益</span>
                  <span className={`text-sm font-mono font-bold ${stats.totalProfit >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                    {stats.totalProfit >= 0 ? '+' : ''}{stats.totalProfit.toLocaleString()}円
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* レポート一覧 */}
          <Card className="border-border bg-card/60">
            <CardHeader className="py-2.5 px-3 border-b border-border/50">
              <CardTitle className="text-xs font-bold flex items-center space-x-1.5">
                <Calendar className="w-3.5 h-3.5 text-primary" />
                <span>レポート一覧</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {listLoading ? (
                <div className="text-center py-6 text-xs text-muted-foreground">読み込み中...</div>
              ) : !reportList || reportList.length === 0 ? (
                <div className="text-center py-6 space-y-2">
                  <p className="text-xs text-muted-foreground">レポートがまだありません</p>
                  <p className="text-[10px] text-muted-foreground">「本日のシミュレーション実行」ボタンで最初のレポートを作成しましょう</p>
                </div>
              ) : (
                <div className="space-y-1 max-h-[500px] overflow-y-auto">
                  {reportList.map((r) => {
                    const isProfit = Number(r.totalProfitAmount) >= 0;
                    const isSelected = selectedDate === r.reportDate;
                    const winRate = parseFloat(String(r.overallWinRate));
                    return (
                      <button
                        key={r.id}
                        onClick={() => {
                          setSelectedDate(r.reportDate);
                          setSelectedStock(null);
                        }}
                        className={`w-full text-left p-2 rounded border transition-all duration-150 ${
                          isSelected
                            ? 'bg-primary/10 border-primary'
                            : 'bg-secondary/20 border-border/40 hover:bg-secondary/40'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-[10px] font-mono font-bold text-foreground">{r.reportDate}</span>
                            {r.isAutoGenerated && (
                              <span className="ml-1.5 text-[8px] bg-primary/20 text-primary px-1 rounded">自動</span>
                            )}
                            {r.aiSummary?.includes('実際の株価データ') ? (
                              <span className="ml-1 text-[8px] bg-emerald-500/20 text-emerald-400 px-1 rounded border border-emerald-500/30">実データ</span>
                            ) : (
                              <span className="ml-1 text-[8px] bg-yellow-500/20 text-yellow-400 px-1 rounded border border-yellow-500/30">架空</span>
                            )}
                            <div className="text-[9px] text-muted-foreground mt-0.5">
                              勝率: {(winRate * 100).toFixed(0)}% | RSI {r.rsiUpper}/{r.rsiLower}
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`text-[11px] font-mono font-bold block ${isProfit ? 'text-destructive' : 'text-emerald-400'}`}>
                              {isProfit ? '+' : ''}{Number(r.totalProfitAmount).toLocaleString()}円
                            </span>
                            <ChevronRight className="w-3 h-3 text-muted-foreground ml-auto" />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 右側: レポート詳細 */}
        <div className="xl:col-span-9 space-y-4">
          {!selectedDate ? (
            <div className="flex items-center justify-center h-64 border border-border/50 rounded-lg bg-card/30">
              <div className="text-center space-y-2">
                <BarChart2 className="w-10 h-10 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">左のリストからレポートを選択してください</p>
                <p className="text-xs text-muted-foreground">または「本日のシミュレーション実行」で新しいレポートを作成</p>
              </div>
            </div>
          ) : detailLoading ? (
            <div className="flex items-center justify-center h-64">
              <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : !reportDetail ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              レポートが見つかりません
            </div>
          ) : (
            <>
              {/* 総合サマリー */}
              {/* データソースバッジ */}
              <div className="flex items-center gap-2 mb-1">
                {reportDetail.report.aiSummary?.includes('実際の株価データ') ? (
                  <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/30 font-bold">
                    ✅ 実際の株価データ使用
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] bg-yellow-500/15 text-yellow-400 px-2 py-0.5 rounded-full border border-yellow-500/30 font-bold">
                    ⚠️ 架空データ（過去日付または市場データ取得不可）
                  </span>
                )}
              </div>
              <div className={`p-4 rounded-lg border grid grid-cols-2 md:grid-cols-4 gap-4 ${
                Number(reportDetail.report.totalProfitAmount) >= 0
                  ? 'bg-destructive/5 border-destructive/20'
                  : 'bg-emerald-500/5 border-emerald-500/20'
              }`}>
                <div>
                  <span className="text-[9px] text-muted-foreground font-bold block">対象日</span>
                  <span className="text-sm font-mono font-bold text-foreground">{reportDetail.report.reportDate}</span>
                </div>
                <div>
                  <span className="text-[9px] text-muted-foreground font-bold block">総合損益</span>
                  <span className={`text-base font-mono font-extrabold flex items-center ${Number(reportDetail.report.totalProfitAmount) >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                    {Number(reportDetail.report.totalProfitAmount) >= 0 ? <TrendingUp className="w-4 h-4 mr-1" /> : <TrendingDown className="w-4 h-4 mr-1" />}
                    {Number(reportDetail.report.totalProfitAmount) >= 0 ? '+' : ''}{Number(reportDetail.report.totalProfitAmount).toLocaleString()}円
                  </span>
                </div>
                <div>
                  <span className="text-[9px] text-muted-foreground font-bold block">全体勝率</span>
                  <span className={`text-base font-mono font-extrabold ${parseFloat(String(reportDetail.report.overallWinRate)) >= 0.8 ? 'text-destructive' : 'text-yellow-400'}`}>
                    {(parseFloat(String(reportDetail.report.overallWinRate)) * 100).toFixed(1)}%
                  </span>
                </div>
                <div>
                  <span className="text-[9px] text-muted-foreground font-bold block">使用パラメータ</span>
                  <span className="text-xs font-mono text-foreground">
                    RSI {reportDetail.report.rsiUpper}/{reportDetail.report.rsiLower} | 損切{reportDetail.report.stopLossPercent}%
                  </span>
                </div>
              </div>

              {/* AIサマリー */}
              {reportDetail.report.aiSummary && (
                <div className="p-3 rounded-lg border border-primary/20 bg-primary/5">
                  <div className="flex items-center space-x-1.5 mb-1.5">
                    <Bot className="w-3.5 h-3.5 text-primary" />
                    <span className="text-[10px] text-primary font-bold">AI分析コメント</span>
                  </div>
                  <p className="text-xs text-foreground leading-relaxed">{reportDetail.report.aiSummary}</p>
                </div>
              )}

              {/* 銘柄別結果 + 詳細 */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* 銘柄一覧 */}
                <div className="lg:col-span-4 border border-border/60 rounded-lg p-2.5 bg-card/40 space-y-1.5">
                  <span className="text-[10px] text-muted-foreground font-bold block px-1">📊 銘柄別結果</span>
                  <div className="space-y-1 max-h-[360px] overflow-y-auto">
                    {reportDetail.stocks.map((r) => {
                      const isProfit = Number(r.profitAmount) >= 0;
                      const isSelected = selectedStock === r.symbol || (!selectedStock && r.symbol === reportDetail.stocks[0]?.symbol);
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
                            <span className="text-[9px] text-muted-foreground font-mono block">
                              勝率: {(parseFloat(String(r.winRate)) * 100).toFixed(0)}% ({r.tradesCount}回)
                            </span>
                          </div>
                          <div className="text-right ml-2 shrink-0">
                            <span className={`text-[11px] font-mono font-bold block ${isProfit ? 'text-destructive' : 'text-emerald-400'}`}>
                              {isProfit ? '+' : ''}{Number(r.profitAmount).toLocaleString()}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 選択銘柄の詳細 */}
                {activeStockReport && (
                  <div className="lg:col-span-8 space-y-3">
                    {/* 銘柄サマリー */}
                    <div className="border border-border/60 rounded-lg p-3 bg-card/60 flex items-center justify-between">
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-mono font-bold bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{activeStockReport.symbol}</span>
                          <h4 className="text-sm font-extrabold text-foreground">{activeStockReport.name}</h4>
                        </div>
                        <span className="text-[10px] text-muted-foreground block mt-1">
                          {activeStockReport.tradesCount}回取引 | 勝{activeStockReport.winCount}回 / 負{Number(activeStockReport.tradesCount) - Number(activeStockReport.winCount)}回
                        </span>
                      </div>
                      <div className="text-right">
                        <span className={`text-base font-mono font-extrabold ${Number(activeStockReport.profitAmount) >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                          {Number(activeStockReport.profitAmount) >= 0 ? '+' : ''}{Number(activeStockReport.profitAmount).toLocaleString()}円
                        </span>
                        <span className={`text-xs font-mono block ${Number(activeStockReport.profitAmount) >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                          ({(parseFloat(String(activeStockReport.profitRate)) * 100).toFixed(2)}%)
                        </span>
                      </div>
                    </div>

                    {/* 原因 & 対策 */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="border border-border/60 rounded-lg p-3 bg-red-500/5">
                        <div className="flex items-center space-x-1.5 mb-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                          <span className="text-[10px] text-red-400 font-extrabold">マイナス発生原因</span>
                        </div>
                        <div className="space-y-1.5">
                          {(activeStockReport.lossCauses as string[]).map((cause, idx) => (
                            <div key={idx} className="flex items-start space-x-1.5 text-[10px] text-foreground leading-relaxed">
                              <span className="text-red-400 shrink-0">•</span>
                              <span>{cause}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="border border-border/60 rounded-lg p-3 bg-emerald-500/5">
                        <div className="flex items-center space-x-1.5 mb-2">
                          <ShieldAlert className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-[10px] text-emerald-400 font-extrabold">今後の対策</span>
                        </div>
                        <div className="space-y-1.5">
                          {(activeStockReport.countermeasures as string[]).map((measure, idx) => (
                            <div key={idx} className="flex items-start space-x-1.5 text-[10px] text-foreground leading-relaxed">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                              <span>{measure}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* 取引履歴 */}
                    <div className="border border-border/60 rounded-lg p-3 bg-card/40">
                      <span className="text-[10px] text-muted-foreground font-bold block mb-2">🕒 取引履歴</span>
                      <div className="max-h-[140px] overflow-y-auto space-y-1">
                        {(activeStockReport.trades as any[]).length === 0 ? (
                          <div className="text-center py-4 text-[10px] text-muted-foreground">
                            取引シグナルが発生しませんでした
                          </div>
                        ) : (
                          (activeStockReport.trades as any[]).map((trade, idx) => {
                            const isBuy = trade.type === 'buy';
                            return (
                              <div key={idx} className="flex items-center justify-between p-2 rounded bg-secondary/20 border border-border/30 text-[10px] font-mono">
                                <div className="flex items-center space-x-3">
                                  <span className="text-muted-foreground">{trade.time}</span>
                                  <span className={`px-1.5 py-0.5 rounded font-bold text-[9px] ${isBuy ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                    {isBuy ? '買い' : '売り'}
                                  </span>
                                  <span className="text-foreground">{trade.shares?.toLocaleString()} 株</span>
                                  <span className="text-muted-foreground">@{trade.price?.toFixed(1)} 円</span>
                                </div>
                                <div className="text-right">
                                  {trade.profit !== undefined && (
                                    <span className={`font-bold ${trade.profit >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                                      {trade.profit >= 0 ? '+' : ''}{trade.profit?.toLocaleString()} 円
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* AIアルゴリズム改善ボタン */}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={handleImprove}
                        disabled={improveMutation.isPending}
                        className="text-xs"
                      >
                        {improveMutation.isPending ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" />
                        ) : (
                          <Bot className="w-3.5 h-3.5 mr-1" />
                        )}
                        AIでアルゴリズムを改善する
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
