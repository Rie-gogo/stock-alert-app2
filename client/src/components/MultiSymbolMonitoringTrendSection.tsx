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

export default function MultiSymbolMonitoringTrendSection({ asOfDate }: { asOfDate: string }) {
  const { loading: authLoading, isAuthenticated } = useAuth();
  const enabled = !authLoading && isAuthenticated;
  const trendQuery = trpc.trading.getMultiSymbolMonitoringTrend.useQuery(
    { asOfDate },
    {
      enabled,
      retry: false,
      // 閉場後の日次snapshotなので日中の定期再読込はしない。画面再表示・手動更新時だけ読む。
      refetchInterval: false,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: true,
    },
  );

  return (
    <Card className="bg-card border-cyan-500/30" data-testid="multi-symbol-monitoring-trend-section">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">10銘柄 案単位 最近傾向（概要・選択根拠外）</CardTitle>
        <p className="text-xs text-muted-foreground">
          確定済み履歴は閉場後に監査完了した日次snapshotだけを読みます。確定snapshotを使えない過去営業日と、確定前の本日は、保存済み取引台帳の決済済み分だけを100株換算で暫定表示します。
          直近5日・直近10日・全期間には各暫定値を1営業日分として一度だけ加え、同日の確定snapshotができたら置き換えます。JPX休場日は加えません。
          1分足や場中処理は再計算せず、日中の受信・現行・シャドー処理は待たせません。
          複数経路を含む案があるため、この表は概要表示だけです。選択器は下段の経路別最近傾向を正式な判断材料とし、ここから自動採用・自動停止・自動切替は行いません。
        </p>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <p className="text-sm text-muted-foreground">ログイン後に比較結果を表示します。</p>
        ) : trendQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 保存済み日次集計と本日台帳を読込中です
          </p>
        ) : trendQuery.isError ? (
          <p className="text-sm text-amber-300">日次比較結果を取得できませんでした。現行運用とシャドー検証は継続しています。</p>
        ) : !trendQuery.data ? null : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground space-y-1">
              <div>
                確定集計：{trendQuery.data.latestCompletedTradeDate ?? "まだありません"}まで／
                {trendQuery.data.eligibleTradeDates.length}営業日
              </div>
              {trendQuery.data.provisionalLedgerTradeDates.length > 0 && (
                <div className="text-cyan-300">
                  暫定日（保存済み台帳・決済済み100株換算）：
                  {trendQuery.data.provisionalLedgerTradeDates.join("、")}
                  （各期間へ一度だけ加算し、確定snapshotで置換）
                </div>
              )}
              {trendQuery.data.provisionalIncompleteTradeDates.length > 0 && (
                <div className="text-amber-300">
                  未決済・missingを含む暫定日：
                  {trendQuery.data.provisionalIncompleteTradeDates.join("、")}
                  （未解決分を0件の確定成績とは扱わず、決済済み分だけ反映）
                </div>
              )}
              {trendQuery.data.todayStatus.source === "persisted_ledger_preview" && (
                <div className="text-cyan-300">
                  本日：保存済み台帳から暫定集計
                  {trendQuery.data.todayStatus.ready
                    ? "（各期間列にも一度だけ加算。閉場後snapshot確定時に置き換わります）"
                    : "（未決済・未生成を含むため決済済み分だけを各期間列にも一度だけ加算）"}
                </div>
              )}
              {!trendQuery.data.todayStatus.isTradingDay && (
                <div className="text-sky-300">本日：JPX休場日のため集計対象外（期間列にも加算しません）</div>
              )}
              {trendQuery.data.todayStatus.isTradingDay && trendQuery.data.todayStatus.source === "unavailable" && (
                <div className="text-amber-300">本日：保存済み取引はまだありません（開場前・未発火時は0件）</div>
              )}
              {trendQuery.data.pendingClosedTradeDates.length > 0 && (
                <div className="text-amber-300">
                  閉場済み・集計待ち：{trendQuery.data.pendingClosedTradeDates.join("、")}
                </div>
              )}
              {trendQuery.data.legacyFallbackTradeDates.length > 0 && (
                <div className="text-sky-300">
                  旧集計から互換引継ぎ：{trendQuery.data.legacyFallbackTradeDates.length}営業日
                  （変更のない現行・既存シャドーのみ）
                </div>
              )}
            </div>

            {trendQuery.data.symbols.map(symbol => {
              const symbolName = symbol.plans[0]?.symbolName ?? symbol.symbol;
              return (
                <details key={symbol.symbol} className="rounded-lg border border-border/70" open={symbol.symbol === "285A"}>
                  <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
                    {symbol.symbol} {symbolName}（現行＋シャドー {symbol.plans.length}案）
                  </summary>
                  <div className="overflow-x-auto border-t border-border/60">
                    <table className="w-full min-w-[920px] text-xs">
                      <thead className="bg-muted/30 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left">方式</th>
                          <th className="px-2 py-2 text-left">傾向</th>
                          <th className="px-2 py-2 text-right">
                            本日
                            {!trendQuery.data.todayStatus.isTradingDay
                              ? "（休場）"
                              : trendQuery.data.todayStatus.provisional
                                ? "（暫定）"
                                : ""}
                          </th>
                          <th className="px-2 py-2 text-right">直近5日</th>
                          <th className="px-2 py-2 text-right">直近10日</th>
                          <th className="px-2 py-2 text-right">全期間</th>
                          <th className="px-3 py-2 text-left">標本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {symbol.plans.map(plan => {
                          const trend = trendText[plan.trend.status];
                          return (
                            <tr key={plan.planId} className="border-t border-border/50">
                              <td className="px-3 py-2 align-top">
                                <div className="font-medium">{plan.label}</div>
                                <div className="text-[10px] text-muted-foreground">
                                  {plan.role === "current" ? "現行仮想" : "比較シャドー"}
                                  {plan.eligibleForAdoption ? "・採用候補" : "・診断/比較用"}
                                </div>
                              </td>
                              <td className="px-2 py-2 align-top">
                                <Badge variant="outline" className={trend.className}>{trend.label}</Badge>
                              </td>
                              {[plan.windows.today, plan.windows.recent5, plan.windows.recent10, plan.windows.all].map((window, index) => (
                                <td key={index} className="px-2 py-2 text-right align-top">
                                  <div>{window.completedTrades}件・{pct(window.winRatePct)}</div>
                                  <div className={window.pnlPer100 < 0 ? "text-rose-300" : "text-emerald-300"}>
                                    {yen(window.pnlPer100)}
                                  </div>
                                </td>
                              ))}
                              <td className="px-3 py-2 align-top text-muted-foreground">
                                {plan.reviewStatus === "four_weeks_ten_trades_manual_review"
                                  ? "4週・10件以上（人が審査）"
                                  : "暫定"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}

            <p className="text-[11px] text-muted-foreground">
              「最近改善／悪化」は直近5日と前5日の勝率・平均損益を比較し、双方に2件以上ある場合だけ表示します。
              この案単位集計は選択に使用しません。正式な採否は経路別に4週間かつ各variant 10件以上を確認した後、人が別途判断します。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
