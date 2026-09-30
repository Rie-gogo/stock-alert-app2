import { AlertCircle, CheckCircle2, Eye, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function r(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(3)}R` : "—";
}

function verdictLabel(value: string | undefined) {
  if (value === "selector_outperformed_fixed_in_both_modes") return "選択器が両集計で固定運用を上回った";
  if (value === "selector_underperformed_fixed_in_at_least_one_mode") return "選択器が固定運用を下回った";
  if (value === "inconclusive") return "差をまだ確定できない";
  return "判定に必要な未見データを蓄積中";
}

/** Read-only view of daily immutable selector snapshots. No polling or raw-ledger calculation occurs here. */
export default function KioxiaNextDaySelectorSection({ asOfDate }: { asOfDate: string }) {
  const query = trpc.trading.getKioxiaNextDaySelector.useQuery({ asOfDate }, { refetchOnWindowFocus: false, staleTime: 60_000 });
  if (query.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">285A翌日選択器の保存済みsnapshotを読み込み中…</CardContent></Card>;
  if (query.isError || !query.data) return <Card><CardContent className="p-4 text-sm text-amber-300">285A翌日選択器snapshotはまだありません。</CardContent></Card>;
  const snapshots = query.data.snapshots as any[];
  const results = query.data.results as any[];
  const snapshot = snapshots.at(-1) as any | undefined;
  const result = snapshot ? results.find(item => item?.tradeDate === snapshot.targetDate) : undefined;
  const scores = snapshot?.scores ?? [];
  const performance = (query.data as any).performanceComparison;
  const signalComparison = performance?.signalQuality;
  const capitalComparison = performance?.capitalConstrained;
  const selectorMetrics = signalComparison?.selector;
  const bestFixedPlan = signalComparison?.bestFixedPlan;
  return <Card className="bg-card border-sky-500/25">
    <CardHeader className="pb-3">
      <CardTitle className="text-sm font-medium flex items-center gap-2"><Eye className="w-4 h-4 text-sky-300" />285A翌日選択器（監視専用）</CardTitle>
      <div className="text-xs text-muted-foreground">閉場後に一度だけ凍結したsnapshotのみを表示。自動採用・自動停止・注文接続はありません。</div>
    </CardHeader>
    <CardContent className="space-y-3">
      {!snapshot ? <div className="text-sm text-muted-foreground">provenance+manifest v2による最初の閉場後snapshotを待機しています。</div> : <>
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-muted-foreground">対象日</span><div className="font-mono">{snapshot.targetDate}</div></div>
          <div><span className="text-muted-foreground">特徴量日 / regime</span><div className="font-mono">{snapshot.sourceTradeDate} / {snapshot.featureSource?.regime?.full ?? "unknown"}</div></div>
          <div><span className="text-muted-foreground">推薦</span><div>{snapshot.primary?.label ?? "no_trade"}</div></div>
          <div><span className="text-muted-foreground">状態</span><div className="flex gap-1 items-center">{snapshot.recommendation === "reference_only" ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <AlertCircle className="w-3 h-3 text-amber-300" />}{snapshot.recommendation}</div></div>
        </div>
        {!snapshot.featureSource?.eligible && <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 text-xs text-amber-200">正式選択不可: {snapshot.noTradeReason ?? "insufficient_feature_source"}。旧payload/unknown provenanceは実測足として補完しません。</div>}
        <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>固定11経路</TableHead><TableHead>eligible / signal</TableHead><TableHead>posterior発火率</TableHead><TableHead>posterior R</TableHead><TableHead>期待日次R</TableHead><TableHead>0.10%不利後</TableHead><TableHead>信頼度</TableHead></TableRow></TableHeader><TableBody>{scores.map((score: any) => <TableRow key={`${score.strategyVersion}:${score.routeId}`}><TableCell className="text-xs">{score.label}</TableCell><TableCell className="font-mono text-xs">{score.eligibleDays} / {score.signalDays}</TableCell><TableCell className="font-mono text-xs">{Number(score.posteriorFireRate ?? 0).toFixed(3)}</TableCell><TableCell className="font-mono text-xs">{r(score.regimePosteriorR)}</TableCell><TableCell className="font-mono text-xs">{r(score.expectedDailyR)}</TableCell><TableCell className="font-mono text-xs">{r(score.adverseExpectedDailyR)}</TableCell><TableCell><Badge variant={score.selectable ? "default" : "outline"} className="text-[10px]">{score.confidence}</Badge></TableCell></TableRow>)}</TableBody></Table></div>
        {result && <div className="rounded bg-muted/30 p-2 text-xs"><ShieldCheck className="inline mr-1 w-3 h-3 text-sky-300" />選択器shadow結果: signal quality={result.signalQuality?.outcome} / signal {result.signalQuality?.signalCount ?? 0} / completed {result.signalQuality?.completedTrades ?? 0} / {r(result.signalQuality?.totalR)}。891万円制約は別集計: {result.capitalConstrained?.outcome} / margin block {result.capitalConstrained?.marginBlockCount ?? 0} / {r(result.capitalConstrained?.totalR)}。</div>}
      </>}
      <div className="rounded border border-sky-500/20 bg-sky-500/5 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">選択器 vs 固定運用（未見・同一営業日比較）</div>
          <Badge variant="outline" className="text-[10px]">{verdictLabel(performance?.verdict)}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          ウォームアップ日は除外し、選択可能になった後のno_trade日は0Rとして含めます。20営業日かつ選択器10決済までは優劣を確定しません。
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
          <div><span className="text-muted-foreground">評価済み</span><div className="font-mono">{performance?.evaluationDays ?? 0} / 20営業日</div></div>
          <div><span className="text-muted-foreground">全発火の決済</span><div className="font-mono">{selectorMetrics?.completedTrades ?? 0} / 10件</div></div>
          <div><span className="text-muted-foreground">891万円版の決済</span><div className="font-mono">{capitalComparison?.selector?.completedTrades ?? 0} / 10件</div></div>
          <div><span className="text-muted-foreground">選択器 平均日次R</span><div className="font-mono">{r(selectorMetrics?.meanDailyR)}</div></div>
          <div><span className="text-muted-foreground">最良固定案</span><div>{bestFixedPlan?.label ?? "—"}</div></div>
        </div>
        {signalComparison?.fixedPlans?.length > 0 && <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow><TableHead>方式</TableHead><TableHead>日数</TableHead><TableHead>決済</TableHead><TableHead>勝率</TableHead><TableHead>合計R</TableHead><TableHead>平均日次R</TableHead><TableHead>最大DD</TableHead><TableHead>選択器−固定 95%区間</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow><TableCell className="text-xs font-medium">翌日選択器</TableCell><TableCell>{selectorMetrics?.evaluationDays ?? 0}</TableCell><TableCell>{selectorMetrics?.completedTrades ?? 0}</TableCell><TableCell>{selectorMetrics?.winRatePct == null ? "—" : `${Number(selectorMetrics.winRatePct).toFixed(1)}%`}</TableCell><TableCell>{r(selectorMetrics?.totalR)}</TableCell><TableCell>{r(selectorMetrics?.meanDailyR)}</TableCell><TableCell>{r(selectorMetrics?.maxDrawdownR)}</TableCell><TableCell>基準</TableCell></TableRow>
            {signalComparison.fixedPlans.map((plan: any) => <TableRow key={plan.key}><TableCell className="text-xs">{plan.label}</TableCell><TableCell>{plan.metrics?.evaluationDays ?? 0}</TableCell><TableCell>{plan.metrics?.completedTrades ?? 0}</TableCell><TableCell>{plan.metrics?.winRatePct == null ? "—" : `${Number(plan.metrics.winRatePct).toFixed(1)}%`}</TableCell><TableCell>{r(plan.metrics?.totalR)}</TableCell><TableCell>{r(plan.metrics?.meanDailyR)}</TableCell><TableCell>{r(plan.metrics?.maxDrawdownR)}</TableCell><TableCell className="font-mono text-xs">{plan.pairedVsSelector?.ci95LowerR == null ? "—" : `${r(plan.pairedVsSelector.ci95LowerR)}〜${r(plan.pairedVsSelector.ci95UpperR)}`}</TableCell></TableRow>)}
          </TableBody>
        </Table></div>}
        <div className="text-[11px] text-muted-foreground">100株・全発火のsignal qualityと891万円制約版を別々に判定し、両方で固定運用を上回った場合だけ「上回った」と表示します。結果から自動採用・自動停止はしません。</div>
      </div>
    </CardContent>
  </Card>;
}
