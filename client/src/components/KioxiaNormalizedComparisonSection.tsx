import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

function yen(value: number) {
  return `${value >= 0 ? "+" : ""}${Math.round(value).toLocaleString("ja-JP")}円`;
}

function percent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function metrics(window: {
  completedTrades: number;
  winRatePct: number | null;
  pnlPer100: number;
  unfillable?: number;
}) {
  return (
    <div className="space-y-0.5 text-right">
      <div>{window.completedTrades}件・{percent(window.winRatePct)}</div>
      <div className={window.pnlPer100 < 0 ? "text-rose-300" : "text-emerald-300"}>{yen(window.pnlPer100)}</div>
      {typeof window.unfillable === "number" && window.unfillable > 0 && (
        <div className="text-[10px] text-amber-300">板不可 {window.unfillable}</div>
      )}
    </div>
  );
}

export default function KioxiaNormalizedComparisonSection({ asOfDate }: { asOfDate: string }) {
  const { loading: authLoading, isAuthenticated } = useAuth();
  const enabled = !authLoading && isAuthenticated;
  const query = trpc.trading.getKioxiaNormalizedComparisonTrend.useQuery(
    { asOfDate },
    {
      enabled,
      retry: false,
      // 閉場後に作成したsnapshotを読むだけ。日中のraw再集計・自動pollingはしない。
      refetchInterval: false,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: true,
    },
  );

  return (
    <Card className="bg-card border-violet-500/30" data-testid="kioxia-normalized-comparison-section">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">285A route別 監視・比較（保存済み）</CardTitle>
        <p className="text-xs text-muted-foreground">
          現行・A案・B案をstrategyVersion×canonical routeで分離します。自動選択・自動停止・通常取引への接続はありません。
        </p>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <p className="text-sm text-muted-foreground">ログイン後に保存済み比較を表示します。</p>
        ) : query.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 保存済み比較を読込中です</p>
        ) : query.isError ? (
          <p className="text-sm text-amber-300">比較snapshotを取得できませんでした。現行DRY_RUNとシャドー検証は継続しています。</p>
        ) : !query.data ? null : (
          <div className="space-y-3">
            <div className="rounded-md bg-violet-500/5 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <div>確定集計：{query.data.eligibleTradeDates.length}営業日（{query.data.eligibleTradeDates.at(-1) ?? "まだありません"}まで）</div>
              {query.data.pendingClosedTradeDates.length > 0 && <div className="text-amber-300">閉場済み・再集計待ち：{query.data.pendingClosedTradeDates.join("、")}</div>}
              <div>表Aは固有実装成績、表Bは入口・出口とも因果的な次event 100株depth VWAP、表Cは入口品質の未来ラベルです。</div>
            </div>

            {query.data.plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">対象日のroute別snapshotはまだありません。</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border/70">
                <table className="w-full min-w-[1200px] text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">方式・経路</th>
                      <th className="px-2 py-2 text-left">母集団</th>
                      <th className="px-2 py-2 text-right">表A 固有／全期間</th>
                      <th className="px-2 py-2 text-right">表B 正規化／直近5日</th>
                      <th className="px-2 py-2 text-right">表B 正規化／20日</th>
                      <th className="px-2 py-2 text-right">表B 正規化／全期間</th>
                      <th className="px-3 py-2 text-left">表C 入口品質（全期間）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.plans.map(plan => {
                      const quality5 = plan.entryQuality["5"];
                      const quality30 = plan.entryQuality["30"];
                      return (
                        <tr key={`${plan.strategyVersion}:${plan.routeId}:${plan.side}`} className="border-t border-border/50 align-top">
                          <td className="px-3 py-2">
                            <div className="font-medium">{plan.routeId}（{plan.side.toUpperCase()}）</div>
                            <div className="text-[10px] text-muted-foreground break-all">{plan.origin === "current_baseline" ? "Current" : "Shadow"}・{plan.strategyVersion}</div>
                            <Badge variant="outline" className="mt-1 text-[10px]">{plan.reviewStatus === "four_weeks_ten_trades_manual_review" ? "4週・10件以上（人の審査）" : "暫定・自動採用なし"}</Badge>
                          </td>
                          <td className="px-2 py-2 text-muted-foreground">
                            <div>accepted {plan.sourceDispositionTotals.accepted} / block {plan.sourceDispositionTotals.marginBlock}</div>
                            <div>entry {plan.sourceDispositionTotals.entry} / rejected {plan.sourceDispositionTotals.rejected}</div>
                            <div className="text-[10px]">条件拒否 {plan.sourceDispositionTotals.entryConditionRejected}・route終了 {plan.sourceDispositionTotals.routeEnded}</div>
                          </td>
                          <td className="px-2 py-2">{metrics(plan.intrinsic.all)}</td>
                          <td className="px-2 py-2">{metrics(plan.normalized.recent5)}</td>
                          <td className="px-2 py-2">{metrics(plan.normalized.recent20)}</td>
                          <td className="px-2 py-2">{metrics(plan.normalized.all)}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            <div>5分：{quality5?.available ?? 0}件／MFE {percent(quality5?.avgMfePct ?? null)}・MAE {percent(quality5?.avgMaePct ?? null)}</div>
                            <div>30分：{quality30?.available ?? 0}件／固定return {percent(quality30?.avgReturnPct ?? null)}</div>
                            <div className="mt-1 text-[10px]">診断専用。戦略順位・勝敗には使用しません。</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
