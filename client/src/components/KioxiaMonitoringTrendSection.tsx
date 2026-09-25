import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

const trendText = {
  improving: { label: "最近改善", className: "border-emerald-400/50 text-emerald-300" },
  deteriorating: { label: "最近悪化", className: "border-rose-400/50 text-rose-300" },
  mixed: { label: "勝率と損益が混在", className: "border-amber-400/50 text-amber-300" },
  stable: { label: "横ばい", className: "border-sky-400/50 text-sky-300" },
  insufficient: { label: "比較件数不足", className: "border-border text-muted-foreground" },
} as const;

function yen(value: number) {
  return `${value >= 0 ? "+" : ""}${Math.round(value).toLocaleString("ja-JP")}円`;
}

function pct(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export default function KioxiaMonitoringTrendSection({
  asOfDate,
  autoRefresh,
}: {
  asOfDate: string;
  autoRefresh: boolean;
}) {
  const { loading: authLoading, isAuthenticated } = useAuth();
  const enabled = !authLoading && isAuthenticated;
  const trendQuery = trpc.trading.getKioxiaMonitoringTrend.useQuery(
    { asOfDate },
    {
      enabled,
      retry: false,
      refetchInterval: enabled && autoRefresh ? 60_000 : false,
      staleTime: 30_000,
    },
  );

  return (
    <Card className="bg-card border-cyan-500/30" data-testid="kioxia-monitoring-trend-section">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">285A 現行・A案・B案 自動比較</CardTitle>
        <p className="text-xs text-muted-foreground">
          監査が完了した営業日だけで、直近5・10・20日と全期間を自動集計します。
          並び順は直近10日の勝率・損益順です。表示結果から自動採用や自動停止は行いません。
        </p>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <p className="text-sm text-muted-foreground">ログイン後に比較結果を表示します。</p>
        ) : trendQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 比較中です
          </p>
        ) : trendQuery.isError ? (
          <p className="text-sm text-amber-300">比較結果を取得できませんでした。現行運用とシャドー検証は継続しています。</p>
        ) : !trendQuery.data ? null : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              対象：{trendQuery.data.monitoringStartDate}〜{trendQuery.data.asOfDate}／監査完了
              {trendQuery.data.eligibleTradeDates.length}営業日
            </div>
            <div className="grid gap-3 xl:grid-cols-3">
              {trendQuery.data.plans.map((plan, index) => {
                const trend = trendText[plan.trend.status];
                const windows = [
                  ["直近5日", plan.windows.recent5],
                  ["直近10日", plan.windows.recent10],
                  ["直近20日", plan.windows.recent20],
                  ["全期間", plan.windows.all],
                ] as const;
                return (
                  <div key={plan.planId} className="rounded-lg border border-border/70 p-3 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-xs text-muted-foreground">暫定順位 {index + 1}</div>
                        <div className="font-medium text-sm break-words">{plan.label}</div>
                      </div>
                      <Badge variant="outline" className={trend.className}>{trend.label}</Badge>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      {windows.map(([label, item]) => (
                        <div key={label} className="grid grid-cols-[72px_1fr_1fr] items-center gap-2 text-xs">
                          <span className="text-muted-foreground">{label}</span>
                          <span>{item.completedTrades}件・勝率 <strong>{pct(item.winRatePct)}</strong></span>
                          <span className={`text-right font-semibold ${item.pnlPer100 < 0 ? "text-rose-300" : "text-emerald-300"}`}>
                            {yen(item.pnlPer100)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground space-y-1">
                      <div>
                        実行可能板・直近5日：{plan.strictExecution.recent5.signals}件中
                        {plan.strictExecution.recent5.filled}件約定可能
                        （{pct(plan.strictExecution.recent5.fillRatePct)}）
                      </div>
                      <div>
                        直近5日 vs 前5日：勝率差 {plan.trend.recentWinRateDeltaPt === null ? "—" : `${plan.trend.recentWinRateDeltaPt >= 0 ? "+" : ""}${plan.trend.recentWinRateDeltaPt.toFixed(1)}pt`}
                        ／平均損益差 {plan.trend.recentAveragePnlDelta === null ? "—" : yen(plan.trend.recentAveragePnlDelta)}
                      </div>
                      <div>標本判定：{plan.windows.all.sampleStatus === "ten_or_more" ? "10件以上" : plan.windows.all.sampleStatus === "preliminary" ? "暫定（10件未満）" : "決済なし"}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              損益は各方式が保存した100株換算の決済結果です。実行可能板の約定率・価格差とは別軸で表示し、
              入口価格を後から差し替えて損益を作り直していません。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
