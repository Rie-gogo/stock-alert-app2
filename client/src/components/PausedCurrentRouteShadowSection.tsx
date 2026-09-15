import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function PausedCurrentRouteShadowSection({
  asOfDate,
  autoRefresh,
}: {
  asOfDate: string;
  autoRefresh: boolean;
}) {
  const { loading: authLoading, isAuthenticated } = useAuth();
  const enabled = !authLoading && isAuthenticated;
  const summaryQuery = trpc.trading.getPausedCurrentRouteShadowSummary.useQuery(
    { asOfDate },
    {
      enabled,
      retry: false,
      refetchInterval: enabled && autoRefresh ? 60_000 : false,
      staleTime: 30_000,
    },
  );
  const rows = [...(summaryQuery.data ?? [])].sort((a, b) =>
    (b.winRatePct ?? -1) - (a.winRatePct ?? -1)
    || a.symbol.localeCompare(b.symbol),
  );

  return (
    <Card className="bg-card border-sky-500/30" data-testid="paused-current-route-shadow-section">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">停止現行11経路・シャドー成績</CardTitle>
        <p className="text-xs text-muted-foreground">
          選択日までの累計です。9/16以降に停止した10経路と、既に停止済みの6146 SHORTを表示します。
          100株仮想取引であり、実口座損益や正式評価ではありません。
        </p>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <p className="text-sm text-muted-foreground">ログイン後にシャドー成績を表示します。</p>
        ) : summaryQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> 集計中です
          </p>
        ) : summaryQuery.isError ? (
          <p className="text-sm text-amber-300">シャドー成績を取得できませんでした。取引やデータ受信は継続しています。</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map(row => (
              <div key={`${row.symbol}:${row.routeId}`} className="rounded-lg border border-border/70 p-3 min-w-0">
                <div className="font-medium text-sm break-words">
                  {row.symbol} {row.logicName} <span className="text-xs text-muted-foreground">{row.side === "long" ? "LONG" : "SHORT"}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-sm">勝率 <strong>{row.winRatePct === null ? "未決済" : `${row.winRatePct.toFixed(1)}%`}</strong></span>
                  <span className={`text-sm font-semibold ${row.pnl < 0 ? "text-rose-300" : "text-emerald-300"}`}>
                    損益 {row.pnl >= 0 ? "+" : ""}{row.pnl.toLocaleString("ja-JP")}円
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {row.closedTrades}件決済・{row.wins}勝{row.losses}敗{row.draws}分／未決済{row.openTrades}件
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
