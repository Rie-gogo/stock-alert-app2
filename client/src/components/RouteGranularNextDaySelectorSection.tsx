import { AlertCircle, Eye, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function yen(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${Math.round(number).toLocaleString("ja-JP")}円` : "—";
}

function pct(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "—";
}

function windowCell(window: any) {
  if (!window) return <span className="text-muted-foreground">—</span>;
  return <>
    <div>{window.completedTrades ?? 0}件・{pct(window.winRatePct)}</div>
    <div className={Number(window.pnlPer100) < 0 ? "text-rose-300" : "text-emerald-300"}>{yen(window.pnlPer100)}</div>
  </>;
}

const trendLabel: Record<string, string> = {
  improving: "最近改善",
  deteriorating: "最近悪化",
  mixed: "勝率・損益混在",
  stable: "横ばい",
  insufficient: "件数不足",
};

/** Immutable routeGroup selector view. This query has no polling and cannot trigger materialization. */
export default function RouteGranularNextDaySelectorSection({ asOfDate }: { asOfDate: string }) {
  const query = trpc.trading.getRouteGranularNextDaySelector.useQuery(
    { asOfDate },
    { refetchInterval: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );
  if (query.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">経路別最近傾向の保存済みsnapshotを読み込み中…</CardContent></Card>;
  if (query.isError || !query.data) return <Card><CardContent className="p-4 text-sm text-amber-300">経路別最近傾向snapshotはまだありません。</CardContent></Card>;
  const snapshot = (query.data.snapshots as any[]).at(-1) as any | undefined;
  const result = snapshot ? (query.data.results as any[]).find(item => item?.tradeDate === snapshot.targetDate) : undefined;
  const scores = snapshot?.scores ?? [];
  const selections = snapshot?.selections ?? [];
  const resultByGroup = new Map((result?.results ?? []).map((item: any) => [`${item.symbol}:${item.routeGroupId}`, item]));

  return <Card className="border-violet-500/40 bg-card" data-testid="route-granular-next-day-selector-section">
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center gap-2 text-base"><Eye className="h-4 w-4 text-violet-300" />10銘柄 経路別最近傾向・翌日比較（正式判断材料）</CardTitle>
      <p className="text-xs text-muted-foreground">同一経路内のcanonical logic × strategyVersionだけを比較します。直近5日対前5日、直近10日、全期間を経路ごとに計算し、複合Plan・未分類・停止版は選択対象外です。自動採用・注文接続はありません。</p>
    </CardHeader>
    <CardContent className="space-y-3">
      {!snapshot ? <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">公開後の最初のclosed完全営業日を待機しています。案単位の表示は概要・履歴参照専用です。</div> : <>
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-muted-foreground">data cutoff</span><div className="font-mono">{snapshot.dataCutoff}</div></div>
          <div><span className="text-muted-foreground">対象日</span><div className="font-mono">{snapshot.targetDate}</div></div>
          <div><span className="text-muted-foreground">入力hash</span><div className="font-mono">{String(snapshot.inputHash).slice(0, 12)}</div></div>
          <div><span className="text-muted-foreground">判断基準</span><div className="font-mono">route recent trend</div></div>
        </div>
        <div className={`rounded p-2 text-xs ${snapshot.catalogAudit?.complete ? "bg-emerald-500/10 text-emerald-200" : "bg-amber-500/10 text-amber-200"}`}>
          経路catalog: {snapshot.catalogAudit?.complete ? "complete" : "unresolved（選択停止）"}
          {snapshot.catalogAudit?.requirementMissing?.length ? ` — 欠落: ${snapshot.catalogAudit.requirementMissing.join("、")}` : ""}
          {snapshot.catalogAudit?.duplicateSelectableRows?.length ? ` — 重複: ${snapshot.catalogAudit.duplicateSelectableRows.join("、")}` : ""}
        </div>
        <div className="space-y-2">{selections.map((selection: any) => {
          const key = `${selection.symbol}:${selection.routeGroupId}`;
          const rows = scores.filter((item: any) => item.symbol === selection.symbol && item.routeGroupId === selection.routeGroupId);
          const outcome: any = resultByGroup.get(key);
          return <details key={key} className="rounded-lg border border-border/70" open={selection.symbol === "285A"}>
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
              {selection.symbol} / {selection.routeGroupId} — {selection.selectedCanonicalLogic ?? "no_selection"}
              <Badge variant="outline" className="ml-2 text-[10px]">{selection.regime?.full ?? "unknown"}</Badge>
            </summary>
            <div className="overflow-x-auto border-t border-border/60"><table className="w-full min-w-[1320px] text-xs">
              <thead className="bg-muted/30 text-muted-foreground"><tr>
                <th className="px-3 py-2 text-left">経路variant</th><th className="px-2 py-2 text-left">version / lifecycle</th><th className="px-2 py-2 text-left">傾向</th><th className="px-2 py-2 text-right">直近5日</th><th className="px-2 py-2 text-right">前5日</th><th className="px-2 py-2 text-right">直近10日</th><th className="px-2 py-2 text-right">全期間</th><th className="px-2 py-2 text-right">期待日次</th><th className="px-2 py-2 text-left">選択可否 / 除外理由</th><th className="px-2 py-2 text-left">D結果</th>
              </tr></thead>
              <tbody>{rows.map((row: any) => {
                const actual = outcome?.variants?.find((item: any) => item.rowId === row.rowId);
                const trend = row.recentTrend;
                return <tr key={row.rowId} className="border-t border-border/50">
                  <td className="px-3 py-2"><div className="font-medium">{row.label}</div><div className="font-mono text-[10px] text-muted-foreground">{row.canonicalLogic ?? "unclassified"}</div></td>
                  <td className="px-2 py-2"><Badge variant={row.selectable ? "default" : "outline"} className="text-[10px]">{row.selectable ? "判断候補" : row.lifecycle}</Badge><div className="font-mono text-[10px] text-muted-foreground">{row.strategyVersion ?? "—"}</div></td>
                  <td className="px-2 py-2"><Badge variant="outline" className="text-[10px]">{trendLabel[trend?.status] ?? "未判定"}</Badge></td>
                  <td className="px-2 py-2 text-right font-mono">{windowCell(trend?.windows?.recent5)}</td>
                  <td className="px-2 py-2 text-right font-mono">{windowCell(trend?.windows?.previous5)}</td>
                  <td className="px-2 py-2 text-right font-mono">{windowCell(trend?.windows?.recent10)}</td>
                  <td className="px-2 py-2 text-right font-mono">{windowCell(trend?.windows?.all)}</td>
                  <td className="px-2 py-2 text-right font-mono">{yen(row.expectedDailyPnlPer100)}</td>
                  <td className="px-2 py-2">{row.fallbackLevel}<div className="text-[10px] text-muted-foreground">{(row.exclusionReasons ?? []).join("、") || "経路別最近傾向の判断候補"}</div></td>
                  <td className="px-2 py-2">{actual ? `${actual.outcome} / ${actual.completed}件 / ${yen(actual.pnl)}` : "未観測"}</td>
                </tr>;
              })}</tbody>
            </table></div>
            {selection.decision !== "reference_only" && <div className="m-2 flex gap-1 text-xs text-amber-200"><AlertCircle className="mt-0.5 h-3 w-3" />{selection.reason}</div>}
          </details>;
        })}</div>
        <div className="rounded bg-muted/30 p-2 text-xs"><ShieldCheck className="mr-1 inline h-3 w-3 text-violet-300" />D-1閉場後に凍結した経路別最近傾向だけを翌日の参考choiceへ使用します。案単位集計、結果後の再選択、過去snapshot上書きは使用しません。</div>
      </>}
    </CardContent>
  </Card>;
}
