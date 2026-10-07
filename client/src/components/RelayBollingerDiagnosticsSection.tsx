import { AlertTriangle, DatabaseZap, RefreshCw, RadioTower } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";

type Props = { tradeDate: string };

export default function RelayBollingerDiagnosticsSection({ tradeDate }: Props) {
  const diagnostic = trpc.trading.getRelayBollingerDiagnostics.useQuery(
    { tradeDate },
    { enabled: false, staleTime: Infinity, retry: false },
  );
  const data = diagnostic.data?.available ? diagnostic.data : null;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between gap-3">
          <span className="flex items-center gap-2"><RadioTower className="w-4 h-4 text-sky-400" />Relay・Bollinger信頼性診断</span>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => diagnostic.refetch()} disabled={diagnostic.isFetching}>
            <RefreshCw className={`w-3.5 h-3.5 ${diagnostic.isFetching ? "animate-spin" : ""}`} />
            手動更新
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground">保存済みの source / decision / shadow / queue だけを一回読取します。自動更新、受信経路、売買条件、注文経路は変更しません。</p>
        {!diagnostic.data && !diagnostic.isFetching && <p className="text-muted-foreground py-2">「手動更新」で {tradeDate} の監査スナップショットを表示します。</p>}
        {diagnostic.isFetching && <p className="text-muted-foreground py-2">保存済み監査データを読取中…</p>}
        {diagnostic.error && <p className="text-red-400">診断取得エラー: {diagnostic.error.message}</p>}
        {data && (
          <>
            <div className="grid gap-2 sm:grid-cols-4">
              <Metric label="source events" value={data.source.totalEvents.toLocaleString()} />
              <Metric label="shadow events" value={data.shadow.totalEvents.toLocaleString()} />
              <Metric label="queue backlog" value={data.queue.backlogCount.toLocaleString()} danger={data.queue.backlogCount > 0} />
              <Metric label="shadow errors" value={data.shadow.errorEvents.toLocaleString()} danger={data.shadow.errorEvents > 0} />
            </div>
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full min-w-[780px] text-xs">
                <thead className="bg-muted/40 text-muted-foreground"><tr>
                  <th className="p-2 text-left">銘柄</th><th className="p-2 text-right">受信/固有分</th><th className="p-2 text-left">最初–最後</th><th className="p-2 text-right">固定session欠損</th><th className="p-2 text-left">欠損範囲</th><th className="p-2 text-right">relay→cloud平均/最大</th><th className="p-2 text-right">処理失敗</th>
                </tr></thead>
                <tbody>{data.source.symbols.map(row => <tr key={row.symbol} className="border-t border-border">
                  <td className="p-2 font-mono">{row.symbol}</td>
                  <td className="p-2 text-right font-mono">{row.receivedEvents}/{row.distinctMinutes}</td>
                  <td className="p-2 font-mono">{row.firstCandleTime ?? "—"}–{row.lastCandleTime ?? "—"}</td>
                  <td className={`p-2 text-right font-mono ${row.missingFixedSessionMinutes ? "text-amber-400" : "text-emerald-400"}`}>{row.missingFixedSessionMinutes}</td>
                  <td className="p-2 max-w-60 truncate" title={row.missingRanges.join(", ")}>{row.missingRanges.join(", ") || "—"}</td>
                  <td className="p-2 text-right font-mono">{row.averageRelayToCloudMs === null ? "—" : `${row.averageRelayToCloudMs}/${row.maxRelayToCloudMs}ms`}</td>
                  <td className={`p-2 text-right font-mono ${row.processingFailed ? "text-red-400" : ""}`}>{row.processingFailed}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded border border-border p-3 space-y-2"><div className="font-medium flex items-center gap-1"><DatabaseZap className="w-4 h-4 text-violet-400" />Bollinger結果（mode別）</div>
                <div className="flex flex-wrap gap-1">{Object.entries(data.shadow.resultCounts).map(([key, value]) => <Badge variant="outline" key={key}>{key}: {value}</Badge>)}</div>
                <div className="text-muted-foreground">queue: {Object.entries(data.queue.counts).map(([key, value]) => `${key}=${value}`).join(" / ") || "記録なし"}、最大試行={data.queue.maxAttemptCount}、queue error={data.queue.errorCount}</div>
              </div>
              <div className="rounded border border-border p-3 space-y-2"><div className="font-medium flex items-center gap-1"><AlertTriangle className="w-4 h-4 text-amber-400" />板・深さ等のentry拒否理由</div>
                {data.shadow.boardOrDepthRejectionReasons.length ? <div className="flex flex-wrap gap-1">{data.shadow.boardOrDepthRejectionReasons.map(item => <Badge variant="outline" key={item.reason}>{item.reason}: {item.count}</Badge>)}</div> : <span className="text-muted-foreground">保存済みBollinger eventにentry拒否なし</span>}
              </div>
            </div>
            <div className="rounded border border-border p-3 space-y-2">
              <div className="font-medium">10銘柄 × 3案 × 2mode の当日保存済み状態</div>
              <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-xs">
                <thead className="text-muted-foreground"><tr><th className="p-1 text-left">strategy version</th><th className="p-1 text-left">mode</th><th className="p-1 text-left">状態</th><th className="p-1 text-right">件数</th></tr></thead>
                <tbody>{data.shadow.variantModeStatus.map(row => <tr key={`${row.strategyVersion}:${row.evaluationMode}:${row.status}`} className="border-t border-border">
                  <td className="p-1 font-mono">{row.strategyVersion}</td><td className="p-1">{row.evaluationMode}</td><td className={`p-1 ${row.status.startsWith("error") ? "text-red-400" : row.status.startsWith("blocked_data") || row.status.startsWith("rejected") ? "text-amber-400" : ""}`}>{row.status}</td><td className="p-1 text-right font-mono">{row.count}</td>
                </tr>)}</tbody>
              </table></div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return <div className="rounded border border-border p-2"><div className="text-muted-foreground">{label}</div><div className={`font-mono text-lg ${danger ? "text-red-400" : "text-foreground"}`}>{value}</div></div>;
}
