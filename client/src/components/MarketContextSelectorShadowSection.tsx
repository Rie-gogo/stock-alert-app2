import { Activity, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function pct(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "—";
}

const stateLabel: Record<string, string> = {
  waiting_open_confirmation: "寄り付き確認待ち",
  strong_up: "強い上昇",
  up: "上昇",
  mixed: "方向不一致",
  down: "下落",
  strong_down: "強い下落",
  gap_down_recovery: "ギャップ安から回復",
  gap_up_failure: "ギャップ高から失速",
  unavailable: "判定不能",
};

/** 専用テーブルの保存値だけを読む。通常銘柄のsource/engineへは接続しない。 */
export default function MarketContextSelectorShadowSection({ tradeDate, autoRefresh }: { tradeDate: string; autoRefresh: boolean }) {
  const query = trpc.trading.getMarketContextSelectorShadow.useQuery(
    { tradeDate, limit: 90 },
    { refetchInterval: autoRefresh ? 60_000 : false, refetchOnWindowFocus: false },
  );
  const latest: any = query.data?.latest;
  const premarket: any = query.data?.premarket;
  const premarketRegime: any = premarket?.resultJson?.regime ?? null;
  const result: any = latest?.resultJson ?? null;
  const regime: any = result?.regime ?? null;
  const decisionEvent: any = (query.data?.decisions as any[] | undefined)?.[0];
  const decision: any = decisionEvent?.resultJson?.selectorShadow ?? null;
  return <Card className="border-cyan-500/40 bg-card" data-testid="market-context-selector-shadow-section">
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-cyan-300" />①〜④ 市場環境・選択器専用シャドー</CardTitle>
      <p className="text-xs text-muted-foreground">開場前のNYダウ・CME日経先物・USD/JPYと、場中の日経225miniを統合します。通常売買、既存シャドー、証拠金、注文経路とは分離しています。</p>
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
                  <div>CME対OSE <strong>{pct(premarketRegime.metrics?.cmeBasisPct)}</strong></div>
                  <div>USD/JPY <strong>{pct(premarketRegime.metrics?.usdJpyChangePct)}</strong></div>
                </div> : <div className="mt-1 text-amber-200">8:30の構造化snapshotはまだ保存されていません。</div>}
              </div>
              {!latest ? <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">日経平均系の専用1分データを待っています。通常10銘柄の受信には影響しません。</div> : <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div><span className="text-muted-foreground">最新</span><div className="font-mono">{latest.candleTime} / {latest.instrumentKey}</div></div>
                <div><span className="text-muted-foreground">品質</span><div><Badge variant={latest.qualityStatus === "verified" ? "default" : "outline"}>{latest.qualityStatus}</Badge></div></div>
                <div><span className="text-muted-foreground">場中状態</span><div className="font-medium">{stateLabel[regime?.state] ?? "未判定"}</div></div>
                <div><span className="text-muted-foreground">許可方向</span><div className="font-mono">{regime?.allowedDirections?.join(" / ") || "見送り"}</div></div>
              </div>
              <div className="grid gap-2 rounded bg-muted/30 p-2 sm:grid-cols-4">
                <div>前日比 <strong>{pct(regime?.metrics?.previousCloseReturnPct)}</strong></div>
                <div>寄りギャップ <strong>{pct(regime?.metrics?.gapPct)}</strong></div>
                <div>始値比 <strong>{pct(regime?.metrics?.fromOpenPct)}</strong></div>
                <div>3分勢い <strong>{pct(regime?.metrics?.momentum3Pct)}</strong></div>
              </div>
              <div className="rounded border border-cyan-500/20 p-2">
                <div className="font-medium">直近の統合固定時刻判断：{decision?.decisionAt ?? "まだありません"}</div>
                {decision?.combinedRegime ? <div className="mt-1 text-muted-foreground">統合方向：{decision.combinedRegime.allowedDirections?.join(" / ") || "見送り"}（{decision.combinedRegime.reasonCodes?.join(", ")}）</div> : null}
                {decision?.selections?.length ? <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {decision.selections.map((item: any) => <div key={item.symbol} className="rounded bg-cyan-500/5 px-2 py-1">
                    <strong>{item.symbol}</strong>：{item.selectedCanonicalLogic ?? "no_trade"} {item.selectedDirection ? `(${item.selectedDirection})` : ""}
                  </div>)}
                </div> : <div className="mt-1 text-muted-foreground">9:05・9:15・10:00・12:35・13:30の判断を待っています。</div>}
                </div>
              </>}
              <div className="rounded bg-muted/30 p-2"><ShieldCheck className="mr-1 inline h-3 w-3 text-cyan-300" />監視専用です。選ばれた案は仮想比較にだけ使い、自動採用・自動停止・注文は行いません。</div>
            </>}
    </CardContent>
  </Card>;
}
