/**
 * RtDashboard.tsx
 *
 * リアルタイム運用ダッシュボード
 *
 * 表示内容:
 * - 接続状態（kabuステーション®との最終受信時刻・接続ステータス）
 * - 当日累計損益（大きく表示）
 * - 銘柄別確定損益カード
 * - 現在のオープンポジション（含み損益付き）
 * - シグナル履歴（エントリー・決済をリアルタイム更新）
 * - 受信足数カウンター
 */
import { useState, useCallback } from "react";
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
  Wifi,
  WifiOff,
  AlertCircle,
  CheckCircle2,
  Zap,
  Target,
  Shield,
  OctagonX,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getStockName } from "@shared/stocks";

// ===== ユーティリティ =====
function getTodayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function formatPnl(pnl: number | null | undefined): { text: string; color: string } {
  if (pnl === null || pnl === undefined) return { text: "-", color: "text-muted-foreground" };
  if (pnl > 0) return { text: `+${pnl.toLocaleString()}円`, color: "text-emerald-400" };
  if (pnl < 0) return { text: `${pnl.toLocaleString()}円`, color: "text-red-400" };
  return { text: "±0円", color: "text-muted-foreground" };
}

function formatAction(action: string): { label: string; color: string; icon: React.ReactNode } {
  switch (action) {
    case "buy":
      return { label: "BUY", color: "text-emerald-400 bg-emerald-400/10", icon: <TrendingUp className="w-3 h-3" /> };
    case "short":
      return { label: "SHORT", color: "text-orange-400 bg-orange-400/10", icon: <TrendingDown className="w-3 h-3" /> };
    case "sell":
      return { label: "SELL", color: "text-blue-400 bg-blue-400/10", icon: <TrendingDown className="w-3 h-3" /> };
    case "cover":
      return { label: "COVER", color: "text-purple-400 bg-purple-400/10", icon: <TrendingUp className="w-3 h-3" /> };
    case "stop_loss":
      return { label: "損切", color: "text-red-400 bg-red-400/10", icon: <Shield className="w-3 h-3" /> };
    case "take_profit":
      return { label: "利確", color: "text-emerald-400 bg-emerald-400/10", icon: <Target className="w-3 h-3" /> };
    case "forced_close":
      return { label: "強制決済", color: "text-yellow-400 bg-yellow-400/10", icon: <Zap className="w-3 h-3" /> };
    case "be_trigger":
      return { label: "BE発動", color: "text-yellow-300 bg-yellow-400/10", icon: <Shield className="w-3 h-3" /> };
    case "pm_bpr_block":
      return { label: "BPRブロック", color: "text-orange-400 bg-orange-400/10", icon: <Shield className="w-3 h-3" /> };
    default:
      return { label: action, color: "text-muted-foreground bg-muted", icon: null };
  }
}

/** 接続状態を判定する（最後受信から何分経過したか） */
function getConnectionStatus(lastReceivedAt: string | null): {
  status: "connected" | "warning" | "disconnected" | "idle";
  label: string;
  color: string;
  icon: React.ReactNode;
} {
  if (!lastReceivedAt) {
    return {
      status: "idle",
      label: "未接続（データなし）",
      color: "text-muted-foreground",
      icon: <WifiOff className="w-4 h-4" />,
    };
  }
  const diffMs = Date.now() - new Date(lastReceivedAt).getTime();
  const diffMin = diffMs / 60000;

  if (diffMin < 3) {
    return {
      status: "connected",
      label: "接続中",
      color: "text-emerald-400",
      icon: <Wifi className="w-4 h-4" />,
    };
  } else if (diffMin < 10) {
    return {
      status: "warning",
      label: `${Math.floor(diffMin)}分前に受信`,
      color: "text-yellow-400",
      icon: <AlertCircle className="w-4 h-4" />,
    };
  } else {
    return {
      status: "disconnected",
      label: `${Math.floor(diffMin)}分間データなし`,
      color: "text-red-400",
      icon: <WifiOff className="w-4 h-4" />,
    };
  }
}

/** 最終受信時刻を日本語表示 */
function formatLastReceived(lastReceivedAt: string | null): string {
  if (!lastReceivedAt) return "なし";
  const d = new Date(lastReceivedAt);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(11, 19).replace("T", " "); // HH:MM:SS
}



// ===== メインコンポーネント =====
export default function RtDashboard() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const today = getTodayJst();

  // ダッシュボードステータス（5秒ごと更新）
  const dashboardQuery = trpc.trading.getRtDashboardStatus.useQuery(undefined, {
    refetchInterval: autoRefresh ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  // 当日の取引ログ（10秒ごと更新）
  const tradesQuery = trpc.trading.getRtTrades.useQuery(
    { tradeDate: today },
    { refetchInterval: autoRefresh ? 10_000 : false },
  );

  // 自動売買ステータス（緊急停止状態確認用）
  const autoTradeStatusQuery = trpc.trading.getAutoTradeStatus.useQuery(
    { tradeDate: today },
    { refetchInterval: autoRefresh ? 5_000 : false },
  );
  const isEmergencyStopped = autoTradeStatusQuery.data?.emergencyStop ?? false;

  // 緊急停止ミューテーション
  const emergencyStopMutation = trpc.trading.emergencyStopWithForceClose.useMutation({
    onSuccess: (result) => {
      alert(result.message);
      utils.trading.getRtDashboardStatus.invalidate();
      utils.trading.getRtTrades.invalidate();
      utils.trading.getAutoTradeStatus.invalidate();
    },
    onError: (err) => {
      alert(`緊急停止失敗: ${err.message}`);
    },
  });

  // 緊急停止解除ミューテーション
  const clearEmergencyStopMutation = trpc.trading.clearEmergencyStop.useMutation({
    onSuccess: (result) => {
      alert(result.message);
      utils.trading.getAutoTradeStatus.invalidate();
    },
    onError: (err) => {
      alert(`解除失敗: ${err.message}`);
    },
  });

  const utils = trpc.useUtils();
  const handleRefresh = useCallback(() => {
    utils.trading.getRtDashboardStatus.invalidate();
    utils.trading.getRtTrades.invalidate();
    utils.trading.getAutoTradeStatus.invalidate();
  }, [utils]);

  const data = dashboardQuery.data;
  const trades = tradesQuery.data ?? [];
  const closedTrades = trades.filter(t => t.action === "sell" || t.action === "cover");

  // 接続状態
  const connStatus = getConnectionStatus(data?.lastCandleReceivedAt ?? null);

  // 銘柄別損益（symbolPnlMapから）
  const symbolPnl = data?.symbolPnl ?? {};
  const symbolPnlEntries = Object.entries(symbolPnl).sort((a, b) => b[1] - a[1]);

  // オープンポジション
  const openPositions = data?.openPositions ?? [];

  // シグナル履歴
  const signalHistory = data?.signalHistory ?? [];

  // 受信足数
  const candleCounters = data?.candleCounters ?? {};
  const candleEntries = Object.entries(candleCounters).sort((a, b) => b[1] - a[1]);

  // 当日累計損益
  const totalPnl = data?.totalPnl ?? 0;
  const totalPnlFmt = formatPnl(totalPnl);

  // 勝率計算
  const winCount = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const lossCount = closedTrades.filter(t => (t.pnl ?? 0) <= 0).length;
  const winRate = closedTrades.length > 0 ? Math.round((winCount / closedTrades.length) * 100) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ヘッダー */}
      <div className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4" />
                戻る
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              <h1 className="text-lg font-bold">リアルタイム運用ダッシュボード</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* 接続状態バッジ */}
            <div className={`flex items-center gap-1.5 text-sm font-medium ${connStatus.color}`}>
              {connStatus.icon}
              <span>{connStatus.label}</span>
              {data?.lastCandleReceivedAt && (
                <span className="text-xs text-muted-foreground ml-1">
                  ({formatLastReceived(data.lastCandleReceivedAt)})
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoRefresh(v => !v)}
              className={`gap-2 ${autoRefresh ? "border-primary/50 text-primary" : ""}`}
            >
              <RefreshCw className={`w-4 h-4 ${autoRefresh ? "animate-spin" : ""}`} style={{ animationDuration: "3s" }} />
              {autoRefresh ? "自動更新中" : "自動更新OFF"}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleRefresh} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              更新
            </Button>
            {/* 緊急停止ボタン */}
            {!isEmergencyStopped ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  >
                    <OctagonX className="w-4 h-4" />
                    緊急停止
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-red-500/30">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-red-400 flex items-center gap-2">
                      <OctagonX className="w-5 h-5" />
                      緊急停止を実行しますか？
                    </AlertDialogTitle>
                    <AlertDialogDescription className="space-y-2">
                      <p>以下の操作が実行されます：</p>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>新規エントリーを全面禁止</li>
                        <li>保有中の全ポジションを即時決済</li>
                      </ul>
                      <p className="text-yellow-400 text-xs mt-2">※ この操作は取り消しできません。解除は別途行えます。</p>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>キャンセル</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => emergencyStopMutation.mutate()}
                      className="bg-red-600 hover:bg-red-700 text-white"
                      disabled={emergencyStopMutation.isPending}
                    >
                      {emergencyStopMutation.isPending ? "実行中..." : "緊急停止を実行"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    停止解除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-emerald-500/30">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-emerald-400 flex items-center gap-2">
                      <ShieldCheck className="w-5 h-5" />
                      緊急停止を解除しますか？
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      新規エントリーが再開されます。決済済みのポジションは復元されません。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>キャンセル</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => clearEmergencyStopMutation.mutate({ tradeDate: today })}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={clearEmergencyStopMutation.isPending}
                    >
                      {clearEmergencyStopMutation.isPending ? "解除中..." : "停止を解除"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </div>

      {/* 緊急停止中バナー */}
      {isEmergencyStopped && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-red-400 text-sm font-medium">
            <OctagonX className="w-4 h-4 animate-pulse" />
            <span>緊急停止中 — 新規エントリーは全面禁止されています</span>
            {autoTradeStatusQuery.data?.emergencyStopReason && (
              <span className="text-red-400/70">({autoTradeStatusQuery.data.emergencyStopReason})</span>
            )}
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* 当日サマリー（上段） */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* 累計損益 */}
          <Card className="col-span-2 md:col-span-1 bg-card/80 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
                <BarChart2 className="w-4 h-4" />
                当日累計損益
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold tabular-nums ${totalPnlFmt.color}`}>
                {totalPnlFmt.text}
              </div>
              <div className="text-xs text-muted-foreground mt-1">{today}</div>
            </CardContent>
          </Card>

          {/* 取引回数 */}
          <Card className="bg-card/80 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
                <Activity className="w-4 h-4" />
                決済回数
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{closedTrades.length}</div>
              <div className="text-xs text-muted-foreground mt-1">
                勝{winCount} / 負{lossCount}
              </div>
            </CardContent>
          </Card>

          {/* 勝率 */}
          <Card className="bg-card/80 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                勝率
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold tabular-nums ${winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}>
                {winRate}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">{closedTrades.length}回中{winCount}勝</div>
            </CardContent>
          </Card>

          {/* 受信足数 */}
          <Card className="bg-card/80 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
                <Clock className="w-4 h-4" />
                受信足数合計
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{data?.totalCandlesReceived ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {data?.openPositionCount ?? 0}銘柄ポジション中
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 中段：銘柄別損益 + オープンポジション */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 銘柄別確定損益 */}
          <Card className="bg-card/80 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-primary" />
                銘柄別確定損益
              </CardTitle>
            </CardHeader>
            <CardContent>
              {symbolPnlEntries.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  まだ決済取引がありません
                </div>
              ) : (
                <div className="space-y-2">
                  {symbolPnlEntries.map(([symbol, pnl]) => {
                    const fmt = formatPnl(pnl);
                    const barWidth = Math.min(Math.abs(pnl) / Math.max(...symbolPnlEntries.map(([, v]) => Math.abs(v))) * 100, 100);
                    return (
                      <div key={symbol} className="flex items-center gap-3">
                        <div className="w-20 text-xs font-mono text-muted-foreground shrink-0">
                          {symbol}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-muted-foreground truncate mb-1">
                            {getStockName(symbol)}
                          </div>
                          <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${pnl >= 0 ? "bg-emerald-400" : "bg-red-400"}`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                        </div>
                        <div className={`text-sm font-bold tabular-nums shrink-0 ${fmt.color}`}>
                          {fmt.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* オープンポジション */}
          <Card className="bg-card/80 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />
                オープンポジション
                {openPositions.length > 0 && (
                  <Badge variant="secondary" className="ml-auto text-xs">
                    {openPositions.length}件
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {openPositions.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  現在ポジションなし
                </div>
              ) : (
                <div className="space-y-3">
                  {openPositions.map((pos) => (
                    <div key={pos.symbol} className="rounded-lg border border-border/50 p-3 bg-background/50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold">{pos.symbol}</span>
                          <span className="text-xs text-muted-foreground">{getStockName(pos.symbol)}</span>
                          <Badge
                            variant="outline"
                            className={pos.side === "long" ? "border-emerald-400/50 text-emerald-400" : "border-red-400/50 text-red-400"}
                          >
                            {pos.side === "long" ? "LONG" : "SHORT"}
                          </Badge>
                          {pos.confidence && (
                            <Badge
                              variant="outline"
                              className={
                                pos.confidence === "strong"
                                  ? "border-amber-400/50 text-amber-300 bg-amber-500/10"
                                  : pos.confidence === "medium"
                                  ? "border-sky-400/50 text-sky-300 bg-sky-500/10"
                                  : "border-border/50 text-muted-foreground"
                              }
                            >
                              {pos.confidence === "strong" ? "信頼度：強" : pos.confidence === "medium" ? "信頼度：中" : "信頼度：弱"}
                            </Badge>
                          )}

                        </div>
                        <div className="text-xs text-muted-foreground">{pos.entryTime}</div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-muted-foreground">エントリー</div>
                          <div className="font-mono font-semibold">{Number(pos.entryPrice).toLocaleString()}円</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">株数</div>
                          <div className="font-mono font-semibold">{pos.shares.toLocaleString()}株</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">理由</div>
                          <div className="truncate">{pos.entryReason}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 下段：シグナル履歴 + 受信足数 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* シグナル履歴 */}
          <Card className="lg:col-span-2 bg-card/80 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                シグナル履歴（当日）
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {signalHistory.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  まだシグナルがありません
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/50">
                        <TableHead className="text-xs w-16">時刻</TableHead>
                        <TableHead className="text-xs w-20">銘柄</TableHead>
                        <TableHead className="text-xs w-20">アクション</TableHead>
                        <TableHead className="text-xs w-16">信頼度</TableHead>
                        <TableHead className="text-xs text-right w-24">価格</TableHead>
                        <TableHead className="text-xs text-right w-20">株数</TableHead>
                        <TableHead className="text-xs text-right w-24">損益</TableHead>
                        <TableHead className="text-xs">理由</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {signalHistory.slice(0, 50).map((sig, i) => {
                        const actionFmt = formatAction(sig.action);
                        const pnlFmt = formatPnl(sig.pnl);
                        return (
                          <TableRow key={i} className="border-border/30 hover:bg-muted/30">
                            <TableCell className="text-xs font-mono text-muted-foreground py-2">
                              {sig.time}
                            </TableCell>
                            <TableCell className="py-2">
                              <div className="text-xs font-mono font-bold">{sig.symbol}</div>
                              <div className="text-xs text-muted-foreground">{sig.symbolName}</div>
                            </TableCell>
                            <TableCell className="py-2">
                              <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${actionFmt.color}`}>
                                {actionFmt.icon}
                                {actionFmt.label}
                              </span>
                            </TableCell>
                            <TableCell className="py-2">
                              {sig.confidence ? (
                                <span
                                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                                    sig.confidence === "strong"
                                      ? "text-amber-300 bg-amber-500/15 border-amber-400/50"
                                      : sig.confidence === "medium"
                                      ? "text-sky-300 bg-sky-500/10 border-sky-400/40"
                                      : "text-muted-foreground bg-muted border-border/50"
                                  }`}
                                >
                                  {sig.confidence === "strong" ? "強" : sig.confidence === "medium" ? "中" : "弱"}
                                </span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-right py-2">
                              {sig.price.toLocaleString()}円
                            </TableCell>
                            <TableCell className="text-xs font-mono text-right py-2">
                              {sig.shares.toLocaleString()}株
                            </TableCell>
                            <TableCell className={`text-xs font-mono font-bold text-right py-2 ${pnlFmt.color}`}>
                              {pnlFmt.text}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground py-2 max-w-[200px] truncate">
                              {sig.reason}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 受信足数カウンター */}
          <Card className="bg-card/80 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                銘柄別受信足数
              </CardTitle>
            </CardHeader>
            <CardContent>
              {candleEntries.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  データなし
                </div>
              ) : (
                <div className="space-y-2">
                  {candleEntries.map(([symbol, count]) => (
                    <div key={symbol} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground w-12">{symbol}</span>
                        <span className="text-xs truncate max-w-[100px]">{getStockName(symbol)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary/60 rounded-full"
                            style={{ width: `${Math.min(count / 4, 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs tabular-nums w-8 text-right">{count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 当日の全取引ログ */}
        <Card className="bg-card/80 border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-primary" />
              当日の全取引ログ
              <Badge variant="secondary" className="ml-auto text-xs">{trades.length}件</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {trades.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-8">
                まだ取引がありません
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border/50">
                      <TableHead className="text-xs">時刻</TableHead>
                      <TableHead className="text-xs">銘柄</TableHead>
                      <TableHead className="text-xs">アクション</TableHead>
                      <TableHead className="text-xs text-right">価格</TableHead>
                      <TableHead className="text-xs text-right">株数</TableHead>
                      <TableHead className="text-xs text-right">損益</TableHead>
                      <TableHead className="text-xs">理由</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...trades].reverse().map((trade) => {
                      const actionFmt = formatAction(trade.action);
                      const pnlFmt = formatPnl(trade.pnl);
                      return (
                        <TableRow key={trade.id} className="border-border/30 hover:bg-muted/30">
                          <TableCell className="text-xs font-mono text-muted-foreground py-2">
                            {trade.tradeTime}
                          </TableCell>
                          <TableCell className="py-2">
                            <div className="text-xs font-mono font-bold">{trade.symbol}</div>
                            <div className="text-xs text-muted-foreground">{trade.symbolName}</div>
                          </TableCell>
                          <TableCell className="py-2">
                            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${actionFmt.color}`}>
                              {actionFmt.icon}
                              {actionFmt.label}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs font-mono text-right py-2">
                            {Number(trade.price).toLocaleString()}円
                          </TableCell>
                          <TableCell className="text-xs font-mono text-right py-2">
                            {trade.shares.toLocaleString()}株
                          </TableCell>
                          <TableCell className={`text-xs font-mono font-bold text-right py-2 ${pnlFmt.color}`}>
                            {pnlFmt.text}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground py-2 max-w-[200px] truncate">
                            {trade.reason}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
