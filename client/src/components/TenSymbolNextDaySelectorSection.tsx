import { AlertCircle, Eye, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function yen(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${Math.round(n).toLocaleString("ja-JP")}円` : "—";
}

/** Immutable, snapshot-only ten-symbol selector view. It deliberately has no polling. */
export default function TenSymbolNextDaySelectorSection({ asOfDate }: { asOfDate: string }) {
  const query = trpc.trading.getTenSymbolNextDaySelector.useQuery(
    { asOfDate },
    { refetchInterval: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );
  if (query.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">10銘柄翌日選択器の保存済みsnapshotを読み込み中…</CardContent></Card>;
  if (query.isError || !query.data) return <Card><CardContent className="p-4 text-sm text-amber-300">10銘柄翌日選択器snapshotはまだありません。</CardContent></Card>;
  const snapshot = (query.data.snapshots as any[]).at(-1) as any | undefined;
  const result = snapshot ? (query.data.results as any[]).find(item => item?.tradeDate === snapshot.targetDate) : undefined;
  const scores = snapshot?.scores ?? [];
  const selections = snapshot?.selections ?? [];
  const outcomes = new Map((result?.results ?? []).map((item: any) => [item.symbol, item]));

  return <Card className="bg-card border-violet-500/30" data-testid="ten-symbol-next-day-selector-section">
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center gap-2 text-base"><Eye className="h-4 w-4 text-violet-300" />旧・案単位 翌日固定比較（参考専用）</CardTitle>
      <p className="text-xs text-muted-foreground">複数経路を含む案があるため選択根拠には使用しません。履歴比較のため保存表示だけを継続します。正式な判断材料は経路別最近傾向です。日中raw再集計・自動採用・自動停止・注文接続はありません。</p>
    </CardHeader>
    <CardContent className="space-y-3">
      {!snapshot ? <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">初回closed日後のimmutable snapshotを待機しています。</div> : <>
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-muted-foreground">data cutoff</span><div className="font-mono">{snapshot.dataCutoff}</div></div>
          <div><span className="text-muted-foreground">対象日</span><div className="font-mono">{snapshot.targetDate}</div></div>
          <div><span className="text-muted-foreground">入力hash</span><div className="font-mono">{String(snapshot.inputHash ?? "—").slice(0, 12)}</div></div>
          <div><span className="text-muted-foreground">設定</span><div className="font-mono">{String(snapshot.selectorVersion ?? "—")}</div></div>
        </div>
        <div className="grid gap-2 rounded bg-muted/30 p-2 text-xs sm:grid-cols-3">
          <div><span className="text-muted-foreground">固定選択（結果観測）</span><div>{query.data.aggregate?.selected?.completedTrades ?? 0}件 / {yen(query.data.aggregate?.selected?.pnlPer100)}</div></div>
          <div><span className="text-muted-foreground">Current固定（結果観測）</span><div>{query.data.aggregate?.current?.completedTrades ?? 0}件 / {yen(query.data.aggregate?.current?.pnlPer100)}</div></div>
          <div><span className="text-muted-foreground">selected − Current（同日両観測）</span><div>{query.data.aggregate?.selectedCurrent?.pairedCoverage ?? 0}組 / {yen(query.data.aggregate?.selectedCurrent?.pnlPer100Delta)}</div></div>
        </div>
        <div className="space-y-2">
          {selections.map((selection: any) => {
            const rows = scores.filter((score: any) => score.symbol === selection.symbol);
            const outcome = outcomes.get(selection.symbol) as any;
            return <details key={selection.symbol} className="rounded-lg border border-border/70" open={selection.symbol === "285A"}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
                {selection.symbol} — {selection.selectedSlot ? `${selection.selectedSlot}固定比較` : "no_selection"}
                <Badge variant="outline" className="ml-2 text-[10px]">{selection.regime?.full ?? "unknown"}</Badge>
              </summary>
              <div className="overflow-x-auto border-t border-border/60">
                <table className="w-full min-w-[900px] text-xs"><thead className="bg-muted/30 text-muted-foreground"><tr>
                  <th className="px-3 py-2 text-left">固定行</th><th className="px-2 py-2 text-left">状態</th><th className="px-2 py-2 text-right">完全日 / 決済</th><th className="px-2 py-2 text-right">期待日次損益</th><th className="px-2 py-2 text-left">fallback / 理由</th><th className="px-2 py-2 text-left">D結果</th>
                </tr></thead><tbody>{rows.map((row: any) => {
                  const fixed = outcome?.fixed?.find((item: any) => item.planId === row.planId);
                  return <tr key={row.planId} className="border-t border-border/50"><td className="px-3 py-2"><div className="font-medium">{row.slot}：{row.label}</div><div className="font-mono text-[10px] text-muted-foreground">{row.strategyVersion ?? "unavailable"}</div></td><td className="px-2 py-2"><Badge variant={row.selectable ? "default" : "outline"} className="text-[10px]">{row.selectable ? "reference_only" : row.lifecycle}</Badge></td><td className="px-2 py-2 text-right font-mono">{row.eligibleDays ?? 0} / {row.completedTrades ?? 0}</td><td className="px-2 py-2 text-right font-mono">{yen(row.expectedDailyPnlPer100)}</td><td className="px-2 py-2">{row.fallbackLevel}<div className="text-[10px] text-muted-foreground">{(row.exclusionReasons ?? []).join("、") || "選択候補（監視のみ）"}</div></td><td className="px-2 py-2">{fixed ? `${fixed.outcome} / ${fixed.completedTrades}件 / ${yen(fixed.pnlPer100)}` : "未観測"}</td></tr>;
                })}</tbody></table>
              </div>
              {selection.decision !== "reference_only" && <div className="m-2 flex gap-1 text-xs text-amber-200"><AlertCircle className="mt-0.5 h-3 w-3" />{selection.reason}</div>}
            </details>;
          })}
        </div>
        {result && <div className="rounded bg-muted/30 p-2 text-xs"><ShieldCheck className="mr-1 inline h-3 w-3 text-violet-300" />結果はD-1に固定した選択だけとDの固定Current/A/Bを結合した監視値です。結果後の再選択・backfill上書きはしません。</div>}
      </>}
    </CardContent>
  </Card>;
}
