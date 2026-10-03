import { Eye, ShieldAlert, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function statusStyle(status: string) {
  if (status === "closed") return "bg-emerald-500/15 text-emerald-200 border-emerald-500/40";
  if (status === "entered") return "bg-sky-500/15 text-sky-200 border-sky-500/40";
  if (status === "signal_rejected") return "bg-amber-500/15 text-amber-200 border-amber-500/40";
  if (status === "plan_ready_no_signal") return "bg-violet-500/15 text-violet-200 border-violet-500/40";
  return "bg-slate-500/15 text-slate-200 border-slate-500/40";
}

function readableStatus(status: string) {
  return ({
    data_blocked: "data_blocked",
    plan_ready_no_signal: "plan_ready_no_signal",
    signal_rejected: "signal_rejected",
    entered: "entered",
    closed: "closed",
  } as Record<string, string>)[status] ?? status;
}

/** Snapshot-only Technical A v2 observation view. It deliberately does not poll. */
export default function TechnicalAObservationV2Section({ asOfDate }: { asOfDate: string }) {
  const query = trpc.trading.getTechnicalAObservationV2.useQuery(
    { asOfDate },
    { refetchInterval: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );
  if (query.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">Technical A v2 observationの保存済みsnapshotを読み込み中…</CardContent></Card>;
  if (query.isError || !query.data) return <Card><CardContent className="p-4 text-sm text-amber-300">Technical A v2 observation snapshotはまだありません。</CardContent></Card>;
  const plans = (query.data.plans as any[]).at(-1) as any | undefined;
  const result = (query.data.results as any[]).at(-1) as any | undefined;
  const resultBySymbol = new Map((result?.symbols ?? []).map((row: any) => [row.symbol, row]));
  const planRows = plans?.plansBySymbol ?? {};
  const symbols = ["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"];

  return <Card className="border-cyan-500/30 bg-card" data-testid="technical-a-observation-v2-section">
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center gap-2 text-base"><Eye className="h-4 w-4 text-cyan-300" />Technical A v2 observation（参考監視）</CardTitle>
      <p className="text-xs text-muted-foreground">旧relay由来の特徴量は <code>legacy_reference_bootstrap</code> と明示し、正式未見成績・自動採用・注文へは一切使いません。画面は閉場後の保存snapshotだけを読み、polling・raw再集計は行いません。</p>
    </CardHeader>
    <CardContent className="space-y-3">
      {!plans ? <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">閉場後のv2 feature / D−1 plan snapshotを待機しています。</div> : <>
        <div className="grid gap-2 rounded bg-muted/30 p-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><span className="text-muted-foreground">data cutoff</span><div className="font-mono">{plans.dataCutoff}</div></div>
          <div><span className="text-muted-foreground">対象日</span><div className="font-mono">{plans.targetDate}</div></div>
          <div><span className="text-muted-foreground">入力hash</span><div className="font-mono">{String(plans.inputHash ?? "—").slice(0, 12)}</div></div>
          <div><span className="text-muted-foreground">用途</span><div>diagnostic / adoption不可</div></div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full min-w-[1100px] text-xs">
            <thead className="bg-muted/30 text-muted-foreground"><tr>
              <th className="px-3 py-2 text-left">銘柄</th><th className="px-2 py-2 text-left">D−1 plan / 相場状態</th><th className="px-2 py-2 text-left">データtier</th><th className="px-2 py-2 text-left">signal_quality</th><th className="px-2 py-2 text-left">capital_constrained</th><th className="px-2 py-2 text-left">near-miss / 未達条件</th>
            </tr></thead>
            <tbody>{symbols.map(symbol => {
              const planRow = planRows[symbol] ?? {};
              const plan = planRow.plan ?? {};
              const observed = resultBySymbol.get(symbol) as any;
              const modes = new Map((observed?.modes ?? []).map((mode: any) => [mode.mode, mode]));
              const signal = modes.get("signal_quality") as any;
              const constrained = modes.get("capital_constrained") as any;
              const near = signal?.nearMiss ?? constrained?.nearMiss;
              return <tr key={symbol} className="border-t border-border/50 align-top">
                <td className="px-3 py-2 font-semibold">{symbol}</td>
                <td className="px-2 py-2"><div className="font-mono">{plan.kind ?? "—"}</div><div className="text-[10px] text-muted-foreground">{plan.setup ?? "unknown"} / {plan.confidence ?? "unavailable"}</div></td>
                <td className="px-2 py-2"><Badge variant="outline" className="text-[10px]">{planRow.sourceTier ?? "—"}</Badge><div className="mt-1 text-[10px] text-muted-foreground">{(plan.reasonCodes ?? []).join("、")}</div></td>
                <td className="px-2 py-2"><Badge variant="outline" className={`text-[10px] ${statusStyle(signal?.status ?? planRow.status ?? "data_blocked")}`}>{readableStatus(signal?.status ?? planRow.status ?? "data_blocked")}</Badge><div className="mt-1 text-[10px] text-muted-foreground">{signal?.closedTrades ? `決済 ${signal.closedTrades}` : signal?.entries ? `保有 ${signal.entries}` : "—"}</div></td>
                <td className="px-2 py-2"><Badge variant="outline" className={`text-[10px] ${statusStyle(constrained?.status ?? planRow.status ?? "data_blocked")}`}>{readableStatus(constrained?.status ?? planRow.status ?? "data_blocked")}</Badge><div className="mt-1 text-[10px] text-muted-foreground">{constrained?.closedTrades ? `決済 ${constrained.closedTrades}` : constrained?.entries ? `保有 ${constrained.entries}` : "—"}</div></td>
                <td className="px-2 py-2 text-[10px] text-muted-foreground">{near ? <><div>{(near.unmetConditions ?? []).join("、") || "—"}</div><div className="font-mono">break {near.priceBreakDistancePct == null ? "—" : `${Number(near.priceBreakDistancePct).toFixed(3)}%`} / VWAP {near.vwapDistancePct == null ? "—" : `${Number(near.vwapDistancePct).toFixed(3)}%`} / vol {near.volumeRatio == null ? "—" : Number(near.volumeRatio).toFixed(2)}</div></> : "保存済み結果なし"}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="flex gap-2 rounded bg-cyan-500/5 p-2 text-xs text-cyan-100"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>状態は <b>data_blocked / plan_ready_no_signal / signal_rejected / entered / closed</b> を混在させず表示します。<code>partial_59_of_60</code> は最大confidence=mediumです。</span></div>
        {result && <div className="flex gap-2 rounded bg-muted/30 p-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-cyan-300" />{result.tradeDate} の保存済み観測結果を表示しています。正式評価・自動選択・注文接続はいずれも無効です。</div>}
      </>}
    </CardContent>
  </Card>;
}
