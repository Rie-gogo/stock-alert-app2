import { Activity, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function pct(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "—";
}

const stateLabel: Record<string, string> = {
  waiting_open_confirmation: "寄り付き確認待ち", strong_up: "強い上昇", up: "上昇", mixed: "方向不一致",
  down: "下落", strong_down: "強い下落", gap_down_recovery: "ギャップ安から回復",
  gap_up_failure: "ギャップ高から失速", unavailable: "判定不能", wait: "見送り",
};

/** v4 snapshot-only UI. v3 history is shown separately and never aggregated with v4. */
export default function MarketContextSelectorShadowSection({ tradeDate, autoRefresh }: { tradeDate: string; autoRefresh: boolean }) {
  const query = trpc.trading.getMarketContextSelectorShadow.useQuery(
    { tradeDate, limit: 90 },
    { refetchInterval: autoRefresh ? 60_000 : false, refetchOnWindowFocus: false },
  );
  const latest: any = query.data?.latest;
  const premarket: any = query.data?.premarket;
  const premarketRegime: any = premarket?.resultJson?.regime ?? null;
  const latestResult: any = latest?.resultJson ?? null;
  const intradayRegime: any = latestResult?.regime ?? null;
  const v4: any = query.data?.v4 ?? null;
  const v4Decision: any = (v4?.decisions as any[] | undefined)?.[0]?.resultJson?.contextPerformanceSelectorV4 ?? v4?.premarketDecision ?? null;
  const latestSelectorWorker: any = v4?.latestSelectorWorker
    ?? (v4?.decisions as any[] | undefined)?.[0]?.resultJson?.selectorWorker
    ?? premarket?.resultJson?.selectorWorker
    ?? null;
  const v3: any = query.data?.v3History ?? null;
  const readiness: any = query.data?.readiness ?? null;
  const performance: any = v4?.performanceSnapshot ?? null;

  return <Card className="border-cyan-500/40 bg-card" data-testid="market-context-selector-shadow-section">
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-cyan-300" />①〜④ 市場環境・v4選択器専用シャドー</CardTitle>
      <p className="text-xs text-muted-foreground">開場前①〜③と場中④の固定判断を保存し、経路特性との適合度で監視候補を並行記録します。通常売買・既存shadow・証拠金・注文経路とは分離しています。</p>
    </CardHeader>
    <CardContent className="space-y-3 text-xs">
      {query.isLoading ? <div className="text-muted-foreground">市場環境データを読み込み中…</div>
        : query.isError ? <div className="text-rose-300">市場環境データを取得できませんでした。</div>
          : <>
              <div className="rounded border border-sky-500/20 p-2">
                <div className="font-medium">開場前①〜③：{stateLabel[premarketRegime?.state] ?? "snapshot待ち"}</div>
                {premarketRegime ? <div className="mt-1 grid gap-1 sm:grid-cols-4">
                  <div>品質 <strong>{premarket?.qualityStatus ?? "—"}</strong></div>
                  <div>NYダウ <strong>{pct(premarketRegime.metrics?.dowChangePct)}</strong></div>
                  <div>CME前営業日同時刻比 <strong>{pct(premarketRegime.metrics?.cmePreviousSessionChangePct)}</strong></div>
                  <div>USD/JPY <strong>{pct(premarketRegime.metrics?.usdJpyChangePct)}</strong></div>
                </div> : <div className="mt-1 text-amber-200">8:30の構造化snapshotはまだ保存されていません。</div>}
                <div className="mt-1 text-cyan-200">v4の08:30判断：{v4?.premarketDecision ? "固定保存済み" : premarket?.resultJson?.selectorWorker?.status === "scheduled" ? "受信後workerで処理予定" : "未作成"}</div>
              </div>

              {!latest ? <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">日経225miniの専用1分データを待っています。通常10銘柄の受信には影響しません。</div> : <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div><span className="text-muted-foreground">最新</span><div className="font-mono">{latest.candleTime} / {latest.instrumentKey}</div></div>
                  <div><span className="text-muted-foreground">品質</span><div><Badge variant={latest.qualityStatus === "verified" ? "default" : "outline"}>{latest.qualityStatus}</Badge></div></div>
                  <div><span className="text-muted-foreground">場中状態</span><div className="font-medium">{stateLabel[intradayRegime?.state] ?? "未判定"}</div></div>
                  <div><span className="text-muted-foreground">許可方向</span><div className="font-mono">{intradayRegime?.allowedDirections?.join(" / ") || "見送り"}</div></div>
                </div>
                <div className="grid gap-2 rounded bg-muted/30 p-2 sm:grid-cols-4">
                  <div>前日比 <strong>{pct(intradayRegime?.metrics?.previousCloseReturnPct)}</strong></div>
                  <div>寄りギャップ <strong>{pct(intradayRegime?.metrics?.gapPct)}</strong></div>
                  <div>始値比 <strong>{pct(intradayRegime?.metrics?.fromOpenPct)}</strong></div>
                  <div>3分勢い <strong>{pct(intradayRegime?.metrics?.momentum3Pct)}</strong></div>
                </div>
              </>}

              <div className="rounded border border-cyan-500/20 p-2">
                <div className="font-medium">v4直近固定判断：{v4Decision?.checkpoint ?? "まだありません"} {v4Decision ? `／${stateLabel[v4Decision.combinedRegime?.state] ?? "見送り"}` : ""}</div>
                {v4Decision?.combinedRegime ? <div className="mt-1 text-muted-foreground">統合方向：{v4Decision.combinedRegime.allowedDirections?.join(" / ") || "見送り"}（{v4Decision.combinedRegime.reasonCodes?.join(", ")}）</div> : null}
                {v4Decision?.selections?.length ? <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {v4Decision.selections.map((item: any) => <div key={item.symbol} className="rounded bg-cyan-500/5 px-2 py-1">
                    <strong>{item.symbol}</strong>：{item.selectedCanonicalLogic ?? "no_trade"} {item.selectedDirection ? `(${item.selectedDirection})` : ""}
                    {item.selectedCanonicalLogic ? <span className="ml-1 text-muted-foreground">[{item.routeStyle ?? "市場適合"} / 同率並行{item.selectedAlternatives?.length ?? 1}案]</span> : null}
                  </div>)}
                </div> : latestSelectorWorker?.status === "deferred" ? <div className="mt-1 text-amber-200">受信優先のため選択スキップ：{latestSelectorWorker.reason ?? "queue_or_finality"}。次の固定checkpointまたは閉場後に再試行します。</div> : latestSelectorWorker?.status === "scheduled" ? <div className="mt-1 text-cyan-200">受信保存は完了しました。選択専用workerが固定判断を処理中です。</div> : <div className="mt-1 text-muted-foreground">データ不足：08:30・9:05・9:15・10:00・12:35・13:30の固定判断を待っています。</div>}
                <div className="mt-1 text-muted-foreground">直近損益は選択に不使用です。市場状態×経路特性だけで絞り、同率案は並行記録します。</div>
              </div>

              <div className="rounded border border-slate-500/20 p-2">
                <div className="font-medium">v4閉場後・条件付きperformance snapshot：{v4?.performanceStatus ?? "not_materialized"}</div>
                {performance ? <div className="mt-1 grid gap-1 sm:grid-cols-4 text-muted-foreground">
                  <div>文脈数 <strong>{performance.summary?.contexts ?? 0}</strong></div>
                  <div>並行候補 <strong>{performance.summary?.selectedAlternatives ?? 0}</strong></div>
                  <div>観測決済 <strong>{performance.summary?.observedTrades ?? 0}</strong></div>
                  <div>100株損益 <strong>{performance.summary?.pnlPer100 ?? 0}</strong></div>
                </div> : <div className="mt-1 text-muted-foreground">閉場後finalityと経路別日次snapshot完了後に一度だけ作成します。</div>}
              </div>

              <div className="rounded border border-slate-500/20 p-2 text-muted-foreground">
                v3履歴：{v3?.decisions?.length ?? 0}件（表示・監査専用、v4の選択・成績には混在させません）
              </div>
              {readiness ? <div className="rounded border border-slate-500/20 p-2 text-muted-foreground">
                利用状況：①〜③ {readiness.premarketUsable ? "利用可" : "未利用"} / ④ {readiness.verifiedMarketContextEventCount > 0 ? `利用可（${readiness.verifiedMarketContextEventCount}件）` : "未着"} / v4場中判断 {readiness.intradaySelectorDecisionCount}件
                {readiness.missingInputs?.length ? <div className="mt-1 text-amber-200">不足：{readiness.missingInputs.join(" / ")}</div> : null}
              </div> : null}
              <div className="rounded bg-muted/30 p-2"><ShieldCheck className="mr-1 inline h-3 w-3 text-cyan-300" />監視専用です。自動採用・自動停止・注文は行わず、v4の市場条件別成績も正式評価には使用しません。</div>
            </>}
    </CardContent>
  </Card>;
}
