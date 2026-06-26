/**
 * RealtimeTradingLog.tsx
 *
 * リアルタイム取引シミュレーション監視ページ
 *
 * 表示内容:
 * - 当日のオープンポジション（リアルタイム）
 * - 当日の取引ログ（エントリー・決済・損益）
 * - 1分足受信カウンター（銘柄別）
 * - 過去の日次サマリー
 */

import { useState, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import {
  Activity,
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Clock,
  BarChart2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Wifi,
  WifiOff,
  AlertCircle,
  CheckCircle2,
  Minus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ===== ユーティリティ =====

function getTodayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function formatPnl(pnl: number | null): { text: string; color: string } {
  if (pnl === null) return { text: "-", color: "text-muted-foreground" };
  if (pnl > 0) return { text: `+${pnl.toLocaleString()}円`, color: "text-emerald-400" };
  if (pnl < 0) return { text: `${pnl.toLocaleString()}円`, color: "text-red-400" };
  return { text: "±0円", color: "text-muted-foreground" };
}

function formatAction(action: string): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  switch (action) {
    case "buy": return { label: "買エントリー", variant: "default" };
    case "short": return { label: "売エントリー", variant: "destructive" };
    case "sell": return { label: "売決済", variant: "secondary" };
    case "cover": return { label: "買戻し", variant: "outline" };
    default: return { label: action, variant: "secondary" };
  }
}

/** reasonテキストから信頼度を抽出し、信頼度バッジ用情報と残りテキストを返す */
function extractConfidence(reason: string): { confidence: "strong" | "medium" | "weak" | null; reasonText: string } {
  const match = reason.match(/[|｜]\s*\[信頼度[：:]\s*(強|中|弱)\](.*)$/);
  if (match) {
    const level = match[1] === "強" ? "strong" : match[1] === "中" ? "medium" : "weak";
    const reasonText = reason.replace(/[|｜]\s*\[信頼度[：:]\s*(強|中|弱)\].*$/, "").trim();
    return { confidence: level, reasonText };
  }
  return { confidence: null, reasonText: reason };
}

// ===== コンポーネント =====

export default function RealtimeTradingLog() {
  const today = getTodayJst();
  const [selectedDate, setSelectedDate] = useState(today);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [showSummaryHistory, setShowSummaryHistory] = useState(false);

  // ---- データ取得 ----

  const openPositionsQuery = trpc.trading.getRtOpenPositions.useQuery(undefined, {
    refetchInterval: autoRefresh ? 10_000 : false, // 10秒ごとに更新
    staleTime: 5_000,
  });

  const tradesQuery = trpc.trading.getRtTrades.useQuery(
    { tradeDate: selectedDate },
    {
      refetchInterval: autoRefresh ? 15_000 : false, // 15秒ごとに更新
      staleTime: 10_000,
    }
  );

  const summariesQuery = trpc.trading.getRtDailySummaries.useQuery(
    { limit: 30 },
    { staleTime: 60_000 }
  );

  const utils = trpc.useUtils();

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      utils.trading.getRtOpenPositions.invalidate(),
      utils.trading.getRtTrades.invalidate({ tradeDate: selectedDate }),
      utils.trading.getRtDailySummaries.invalidate(),
    ]);
    setLastRefreshed(new Date());
  }, [utils, selectedDate]);

  // 自動更新時に lastRefreshed を更新
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      setLastRefreshed(new Date());
    }, 15_000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // ---- 集計 ----

  const trades = tradesQuery.data ?? [];
  const closedTrades = trades.filter(t => t.action === "sell" || t.action === "cover");
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const winCount = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const lossCount = closedTrades.filter(t => (t.pnl ?? 0) <= 0).length;
  const winRate = closedTrades.length > 0 ? (winCount / closedTrades.length * 100).toFixed(1) : "-";

  const openPositions = openPositionsQuery.data?.positions ?? [];
  const candleCounters = openPositionsQuery.data?.candleCounters ?? {};
  const totalCandles = Object.values(candleCounters).reduce((sum, c) => sum + c, 0);

  const isToday = selectedDate === today;
  const pnlFormatted = formatPnl(totalPnl);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ヘッダー */}
      <div className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-1">
                <ArrowLeft className="w-4 h-4" />
                ホーム
              </Button>
            </Link>
            <div className="h-5 w-px bg-border" />
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-400" />
              <h1 className="text-lg font-semibold">リアルタイム取引シミュレーション</h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* 自動更新トグル */}
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              className="gap-2"
              onClick={() => setAutoRefresh(prev => !prev)}
            >
              {autoRefresh ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              {autoRefresh ? "自動更新中" : "手動更新"}
            </Button>

            {/* 手動更新ボタン */}
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleRefresh}
              disabled={openPositionsQuery.isFetching || tradesQuery.isFetching}
            >
              <RefreshCw className={`w-4 h-4 ${(openPositionsQuery.isFetching || tradesQuery.isFetching) ? "animate-spin" : ""}`} />
              更新
            </Button>

            <span className="text-xs text-muted-foreground hidden sm:block">
              最終更新: {lastRefreshed.toLocaleTimeString("ja-JP")}
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* 日付選択 */}
        <div className="flex items-center gap-3">
          <label className="text-sm text-muted-foreground">対象日:</label>
          <input
            type="date"
            value={selectedDate}
            max={today}
            onChange={e => setSelectedDate(e.target.value)}
            className="bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {isToday && (
            <Badge variant="default" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
              本日
            </Badge>
          )}
        </div>

        {/* ===== 当日サマリーカード ===== */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {/* 当日損益 */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="text-xs text-muted-foreground mb-1">当日損益</div>
              <div className={`text-2xl font-bold ${pnlFormatted.color}`}>
                {closedTrades.length > 0 ? pnlFormatted.text : "-"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {closedTrades.length > 0 ? `${closedTrades.length}回取引` : "取引なし"}
              </div>
            </CardContent>
          </Card>

          {/* 勝率 */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="text-xs text-muted-foreground mb-1">勝率</div>
              <div className="text-2xl font-bold text-foreground">{winRate !== "-" ? `${winRate}%` : "-"}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {closedTrades.length > 0 ? `勝${winCount} / 負${lossCount}` : "-"}
              </div>
            </CardContent>
          </Card>

          {/* 受信足数 */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="text-xs text-muted-foreground mb-1">受信1分足数</div>
              <div className="text-2xl font-bold text-foreground">
                {isToday ? totalCandles.toLocaleString() : "-"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {isToday ? `${Object.keys(candleCounters).length}銘柄` : "当日のみ表示"}
              </div>
            </CardContent>
          </Card>

          {/* オープンポジション */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="text-xs text-muted-foreground mb-1">保有ポジション</div>
              <div className="text-2xl font-bold text-foreground">
                {isToday ? openPositions.length : "-"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {isToday ? (openPositions.length > 0 ? "運用中" : "なし") : "当日のみ表示"}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ===== 1分足受信カウンター（当日のみ） ===== */}
        {isToday && Object.keys(candleCounters).length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-blue-400" />
                1分足受信カウンター（銘柄別）
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {Object.entries(candleCounters).map(([symbol, count]) => (
                  <div key={symbol} className="flex items-center gap-2 bg-muted/30 rounded-md px-3 py-2">
                    <span className="text-sm font-mono font-medium text-foreground">{symbol}</span>
                    <Badge variant="secondary" className="text-xs">
                      {count}本
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ===== オープンポジション（当日のみ） ===== */}
        {isToday && openPositions.length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                保有ポジション（リアルタイム）
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-xs text-muted-foreground">銘柄</TableHead>
                    <TableHead className="text-xs text-muted-foreground">方向</TableHead>
                    <TableHead className="text-xs text-muted-foreground text-right">エントリー価格</TableHead>
                    <TableHead className="text-xs text-muted-foreground text-right">株数</TableHead>
                    <TableHead className="text-xs text-muted-foreground">エントリー時刻</TableHead>
                    <TableHead className="text-xs text-muted-foreground">信頼度</TableHead>
                    <TableHead className="text-xs text-muted-foreground">理由</TableHead>
                    <TableHead className="text-xs text-muted-foreground">板シグナル</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openPositions.map((pos, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell className="font-mono font-medium">{pos.symbol}</TableCell>
                      <TableCell>
                        {pos.side === "long" ? (
                          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 gap-1">
                            <TrendingUp className="w-3 h-3" /> 買い
                          </Badge>
                        ) : (
                          <Badge className="bg-red-500/20 text-red-400 border-red-500/30 gap-1">
                            <TrendingDown className="w-3 h-3" /> 売り
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {Number(pos.entryPrice).toLocaleString()}円
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {pos.shares.toLocaleString()}株
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {pos.entryTime}
                        </span>
                      </TableCell>
                      <TableCell className="py-2">
                        {(() => {
                          const { confidence } = extractConfidence(pos.entryReason ?? "");
                          if (!confidence) return <span className="text-muted-foreground">—</span>;
                          return (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              confidence === "strong" ? "text-amber-300 bg-amber-500/15 border-amber-400/50"
                              : confidence === "medium" ? "text-sky-300 bg-sky-500/10 border-sky-400/40"
                              : "text-muted-foreground bg-muted border-border/50"
                            }`}>
                              {confidence === "strong" ? "強" : confidence === "medium" ? "中" : "弱"}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[300px] whitespace-normal">
                        {extractConfidence(pos.entryReason ?? "").reasonText}
                      </TableCell>
                      <TableCell className="text-xs">
                        {pos.boardSignal ? (
                          <Badge variant="outline" className="text-xs">
                            {pos.boardSignal}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* ===== 取引ログ ===== */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-400" />
              取引ログ（{selectedDate}）
              {tradesQuery.isLoading && (
                <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {trades.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                <AlertCircle className="w-8 h-8 opacity-40" />
                <p className="text-sm">
                  {tradesQuery.isLoading ? "読み込み中..." : "この日の取引記録はありません"}
                </p>
                {isToday && (
                  <p className="text-xs opacity-60">
                    取引時間中にWindowsスクリプトから1分足データが送信されると自動で記録されます
                  </p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-xs text-muted-foreground">時刻</TableHead>
                    <TableHead className="text-xs text-muted-foreground">銘柄</TableHead>
                    <TableHead className="text-xs text-muted-foreground">アクション</TableHead>
                    <TableHead className="text-xs text-muted-foreground text-right">価格</TableHead>
                    <TableHead className="text-xs text-muted-foreground text-right">株数</TableHead>
                    <TableHead className="text-xs text-muted-foreground text-right">損益</TableHead>
                    <TableHead className="text-xs text-muted-foreground">信頼度</TableHead>
                    <TableHead className="text-xs text-muted-foreground">理由</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.map((trade, i) => {
                    const actionInfo = formatAction(trade.action);
                    const pnl = formatPnl(trade.pnl);
                    const isEntry = trade.action === "buy" || trade.action === "short";
                    const { confidence, reasonText } = extractConfidence(trade.reason);
                    return (
                      <TableRow key={i} className={`border-border ${isEntry ? "bg-muted/10" : ""}`}>
                        <TableCell className="text-sm text-muted-foreground font-mono">
                          {trade.tradeTime}
                        </TableCell>
                        <TableCell className="font-mono font-medium">
                          <div>{trade.symbol}</div>
                          <div className="text-xs text-muted-foreground">{trade.symbolName}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={actionInfo.variant} className="text-xs">
                            {actionInfo.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {Number(trade.price).toLocaleString()}円
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {trade.shares.toLocaleString()}株
                        </TableCell>
                        <TableCell className={`text-right font-mono font-medium ${pnl.color}`}>
                          {isEntry ? (
                            <span className="text-muted-foreground flex items-center justify-end gap-1">
                              <Minus className="w-3 h-3" />
                              エントリー
                            </span>
                          ) : pnl.text}
                        </TableCell>
                        <TableCell className="py-2">
                          {confidence ? (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              confidence === "strong" ? "text-amber-300 bg-amber-500/15 border-amber-400/50"
                              : confidence === "medium" ? "text-sky-300 bg-sky-500/10 border-sky-400/40"
                              : "text-muted-foreground bg-muted border-border/50"
                            }`}>
                              {confidence === "strong" ? "強" : confidence === "medium" ? "中" : "弱"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[300px] whitespace-normal">
                          {reasonText}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* ===== 当日集計（取引がある場合） ===== */}
        {closedTrades.length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                当日決済済み集計
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground">総損益</div>
                  <div className={`text-xl font-bold mt-1 ${pnlFormatted.color}`}>
                    {pnlFormatted.text}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">取引回数</div>
                  <div className="text-xl font-bold mt-1">{closedTrades.length}回</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">勝率</div>
                  <div className="text-xl font-bold mt-1">{winRate}%</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">勝/負</div>
                  <div className="text-xl font-bold mt-1">
                    <span className="text-emerald-400">{winCount}</span>
                    <span className="text-muted-foreground mx-1">/</span>
                    <span className="text-red-400">{lossCount}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ===== 過去の日次サマリー ===== */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 cursor-pointer" onClick={() => setShowSummaryHistory(prev => !prev)}>
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-purple-400" />
                過去の日次サマリー
              </div>
              {showSummaryHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </CardTitle>
          </CardHeader>
          {showSummaryHistory && (
            <CardContent className="p-0">
              {summariesQuery.isLoading ? (
                <div className="py-8 text-center text-muted-foreground text-sm">読み込み中...</div>
              ) : (summariesQuery.data ?? []).length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  まだ記録がありません
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="text-xs text-muted-foreground">日付</TableHead>
                      <TableHead className="text-xs text-muted-foreground text-right">損益</TableHead>
                      <TableHead className="text-xs text-muted-foreground text-right">取引数</TableHead>
                      <TableHead className="text-xs text-muted-foreground text-right">勝率</TableHead>
                      <TableHead className="text-xs text-muted-foreground text-right">受信足数</TableHead>
                      <TableHead className="text-xs text-muted-foreground">レポート</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(summariesQuery.data ?? []).map((summary, i) => {
                      const pnl = formatPnl(summary.totalPnl);
                      const wr = summary.tradesCount > 0
                        ? `${(summary.winCount / summary.tradesCount * 100).toFixed(1)}%`
                        : "-";
                      return (
                        <TableRow
                          key={i}
                          className="border-border cursor-pointer hover:bg-muted/20"
                          onClick={() => setSelectedDate(summary.tradeDate)}
                        >
                          <TableCell className="font-mono text-sm">{summary.tradeDate}</TableCell>
                          <TableCell className={`text-right font-mono font-medium ${pnl.color}`}>
                            {pnl.text}
                          </TableCell>
                          <TableCell className="text-right text-sm">{summary.tradesCount}</TableCell>
                          <TableCell className="text-right text-sm">{wr}</TableCell>
                          <TableCell className="text-right text-sm">
                            {summary.candlesReceived?.toLocaleString() ?? "-"}
                          </TableCell>
                          <TableCell>
                            {summary.reportSent ? (
                              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
                                送信済み
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-muted-foreground">
                                未送信
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          )}
        </Card>

        {/* 注意事項 */}
        <div className="text-xs text-muted-foreground border border-border rounded-md p-4 space-y-1">
          <p className="font-medium text-foreground">⚠️ このページについて</p>
          <p>このページはリアルタイム取引シミュレーションの結果を表示します。実際の取引ではありません。</p>
          <p>1分足データはWindowsのkabuステーション®中継スクリプトから送信されます。スクリプトが起動していない場合、データは記録されません。</p>
          <p>大引け後（JST 16:00）に当日の結果がメールで自動送信されます。</p>
        </div>
      </div>
    </div>
  );
}
