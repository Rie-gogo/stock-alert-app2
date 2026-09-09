import React from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import {
  AlertCircle,
  Database,
  Loader2,
  LockKeyhole,
  LogIn,
  ShieldCheck,
} from "lucide-react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type SignalCandidateLedgerData = RouterOutputs["trading"]["getRtSignalCandidateLedger"];
export type SignalCandidateLedgerRow = SignalCandidateLedgerData["rows"][number];

export function shouldEnableSignalCandidateLedgerQuery(input: {
  authLoading: boolean;
  isAuthenticated: boolean;
}): boolean {
  return !input.authLoading && input.isAuthenticated;
}

function formatNumber(value: number | null, suffix = ""): string {
  if (value === null) return "未生成";
  return `${value.toLocaleString("ja-JP", { maximumFractionDigits: 4 })}${suffix}`;
}

function outcomeLabel(outcome: SignalCandidateLedgerRow["virtualTrade"]["outcome"]): string {
  if (outcome === "win") return "勝ち";
  if (outcome === "loss") return "負け";
  if (outcome === "draw") return "引き分け";
  if (outcome === "open") return "未決済";
  return "判定前";
}

function auditStatusLabel(status: SignalCandidateLedgerRow["audit"]["overallStatus"]): string {
  if (status === "complete") return "完了";
  if (status === "pending") return "未処理";
  if (status === "processing") return "処理中";
  if (status === "retryable_error") return "再試行可能エラー";
  if (status === "terminal_error") return "terminal gap";
  return "データ欠損";
}

function portfolioDecisionLabel(decision: SignalCandidateLedgerRow["portfolioAudit"]["actualReceipt"]["decision"]): string {
  if (decision === "accepted") return "採用";
  if (decision === "margin_block") return "証拠金ブロック";
  if (decision === "symbol_position_block") return "同一銘柄ブロック";
  if (decision === "not_candidate") return "候補外";
  if (decision === "missing") return "欠損";
  if (decision === "closed") return "決済";
  return "未生成";
}

function decisionClass(decision: SignalCandidateLedgerRow["realtimeDecision"]): string {
  return decision === "accepted"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
}

function outcomeClass(outcome: SignalCandidateLedgerRow["virtualTrade"]["outcome"]): string {
  if (outcome === "win") return "text-emerald-300";
  if (outcome === "loss") return "text-red-300";
  if (outcome === "draw") return "text-sky-300";
  return "text-muted-foreground";
}

export function SignalCandidateLedgerTable({ rows }: { rows: SignalCandidateLedgerRow[] }) {
  return (
    <Table className="min-w-[1760px]" aria-label="全シグナル監査台帳">
      <TableCaption className="sr-only">
        現行エンジンが証拠金判定まで到達した全候補と、100株仮想取引・監査状態・891万円portfolio二方式
      </TableCaption>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead scope="col">時刻</TableHead>
          <TableHead scope="col">銘柄</TableHead>
          <TableHead scope="col" className="min-w-[260px]">ロジック</TableHead>
          <TableHead scope="col">方向</TableHead>
          <TableHead scope="col" className="min-w-[150px]">現行判断</TableHead>
          <TableHead scope="col" className="text-right">理論入口</TableHead>
          <TableHead scope="col" className="text-right">現行株数</TableHead>
          <TableHead scope="col" className="text-right">必要証拠金</TableHead>
          <TableHead scope="col" className="text-right">証拠金使用前</TableHead>
          <TableHead scope="col" className="text-right">上限</TableHead>
          <TableHead scope="col">仮想決済</TableHead>
          <TableHead scope="col" className="text-right">仮想決済価格</TableHead>
          <TableHead scope="col" className="min-w-[190px]">決済理由</TableHead>
          <TableHead scope="col" className="text-right">100株仮想損益</TableHead>
          <TableHead scope="col">勝敗</TableHead>
          <TableHead scope="col" className="min-w-[210px]">監査状態</TableHead>
          <TableHead scope="col" className="min-w-[260px]">891万円portfolio</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(row => (
          <TableRow key={row.candidateId} className="border-border align-top" data-testid={`ledger-row-${row.candidateId}`}>
            <TableCell className="font-mono">{row.candleTime}</TableCell>
            <TableCell>
              <div className="font-mono font-semibold">{row.symbol}</div>
              <div className="text-xs text-muted-foreground">{row.symbolName}</div>
            </TableCell>
            <TableCell className="whitespace-normal">
              <div className="font-medium text-foreground">{row.logicName}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{row.routeId}</div>
              <details className="mt-1 text-xs text-muted-foreground">
                <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
                  シグナル理由
                </summary>
                <p className="mt-1 max-w-[360px] whitespace-normal break-words">{row.signalReason}</p>
              </details>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className={row.side === "long" ? "text-emerald-300 border-emerald-500/40" : "text-red-300 border-red-500/40"}>
                {row.side === "long" ? "LONG" : "SHORT"}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-normal">
              <Badge variant="outline" className={decisionClass(row.realtimeDecision)}>
                {row.realtimeDecision}
              </Badge>
              {row.blockReasonLabel && <div className="mt-1 text-[11px] text-amber-200">{row.blockReasonLabel}</div>}
              {row.blockerAvailability === "not_recorded" && (
                <div className="mt-1 text-[11px] text-muted-foreground">原因取引IDは未保存</div>
              )}
            </TableCell>
            <TableCell className="text-right font-mono">{formatNumber(row.theoreticalEntryPrice, "円")}</TableCell>
            <TableCell className="text-right font-mono">{row.capitalShares.toLocaleString()}株</TableCell>
            <TableCell className="text-right font-mono">{formatNumber(row.requiredMargin, "円")}</TableCell>
            <TableCell className="text-right font-mono">{formatNumber(row.marginUsedBefore, "円")}</TableCell>
            <TableCell className="text-right font-mono">{formatNumber(row.marginLimit, "円")}</TableCell>
            <TableCell className="font-mono">{row.virtualTrade.exitCandleTime ?? "未決済／未生成"}</TableCell>
            <TableCell className="text-right font-mono">{formatNumber(row.virtualTrade.exitPrice, "円")}</TableCell>
            <TableCell className="whitespace-normal">
              <div className="font-mono text-xs">{row.virtualTrade.exitReasonCode ?? "未生成"}</div>
              {row.virtualTrade.exitReasonDetail && (
                <div className="mt-1 text-[11px] text-muted-foreground break-words">{row.virtualTrade.exitReasonDetail}</div>
              )}
            </TableCell>
            <TableCell className={`text-right font-mono font-semibold ${outcomeClass(row.virtualTrade.outcome)}`}>
              {row.virtualTrade.pnl === null ? "未生成" : `${row.virtualTrade.pnl >= 0 ? "+" : ""}${row.virtualTrade.pnl.toLocaleString()}円`}
            </TableCell>
            <TableCell className={outcomeClass(row.virtualTrade.outcome)}>{outcomeLabel(row.virtualTrade.outcome)}</TableCell>
            <TableCell className="whitespace-normal">
              <div className="font-medium">{auditStatusLabel(row.audit.overallStatus)}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                candidate: {row.audit.candidatePhase.status} / virtual: {row.audit.virtualPhase.status}
              </div>
              {row.audit.hasAnyGap && (
                <div className={row.audit.hasUnresolvedGap ? "mt-1 text-[11px] text-red-300" : "mt-1 text-[11px] text-muted-foreground"}>
                  gap: {row.audit.hasUnresolvedGap ? "未解決" : "解決済み"}
                </div>
              )}
            </TableCell>
            <TableCell className="whitespace-normal text-xs">
              <div>
                <span className="text-muted-foreground">実受信順: </span>
                {portfolioDecisionLabel(row.portfolioAudit.actualReceipt.decision)}
                {row.portfolioAudit.actualReceipt.blockerSymbol && `（原因 ${row.portfolioAudit.actualReceipt.blockerSymbol}）`}
              </div>
              <div className="mt-1">
                <span className="text-muted-foreground">同一分固定順: </span>
                {portfolioDecisionLabel(row.portfolioAudit.minuteNormalized.decision)}
                {row.portfolioAudit.minuteNormalized.blockerSymbol && `（原因 ${row.portfolioAudit.minuteNormalized.blockerSymbol}）`}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                active generation: {row.portfolioAudit.actualReceipt.activeGeneration ?? "未生成"} / {row.portfolioAudit.minuteNormalized.activeGeneration ?? "未生成"}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function SignalCandidateLedgerSection({
  tradeDate,
  autoRefresh,
}: {
  tradeDate: string;
  autoRefresh: boolean;
}) {
  const { loading: authLoading, isAuthenticated } = useAuth();
  const queryEnabled = shouldEnableSignalCandidateLedgerQuery({ authLoading, isAuthenticated });
  const ledgerQuery = trpc.trading.getRtSignalCandidateLedger.useQuery(
    { tradeDate },
    {
      enabled: queryEnabled,
      retry: false,
      refetchInterval: queryEnabled && autoRefresh ? 15_000 : false,
      staleTime: 10_000,
    },
  );

  if (authLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> 認証状態を確認中です
        </CardContent>
      </Card>
    );
  }

  if (!isAuthenticated) {
    return (
      <Card className="bg-card border-amber-500/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <LockKeyhole className="w-5 h-5 text-amber-300" />
            全シグナル（証拠金ブロック含む）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            ロジック条件と証拠金情報を含むため、監査台帳はログイン後だけ表示します。未認証状態では台帳APIも実行されません。
          </p>
          <Button
            type="button"
            className="gap-2 active:scale-[0.97]"
            onClick={startLogin}
          >
            <LogIn className="w-4 h-4" /> ログインして監査台帳を表示
          </Button>
        </CardContent>
      </Card>
    );
  }

  const data = ledgerQuery.data;
  const summary = data?.summary;

  return (
    <Card className="bg-card border-cyan-500/30" data-testid="signal-candidate-ledger-section">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2 text-base">
            <Database className="w-5 h-5 text-cyan-300" />
            全シグナル（証拠金ブロック含む）
          </span>
          {summary && (
            <Badge variant="outline" className={summary.coverageComplete ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"}>
              {summary.coverageComplete ? "監査coverage 完全" : "監査coverage 未完了"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          100株仮想取引と891万円portfolio監査です。実際の注文・実資金の取引ではありません。
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {ledgerQuery.isLoading ? (
          <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> 監査台帳を読み込み中です
          </div>
        ) : ledgerQuery.error ? (
          <div className="m-4 rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200" role="alert">
            <div className="flex items-center gap-2 font-medium"><AlertCircle className="w-4 h-4" />監査台帳を取得できませんでした</div>
            <p className="mt-1 text-xs text-red-200/80">{ledgerQuery.error.message}</p>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            この日のcandidate記録はありません。0件と未生成は区別して表示しています。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 border-y border-border bg-muted/10 p-4 sm:grid-cols-3 xl:grid-cols-6">
              <div><div className="text-[11px] text-muted-foreground">候補</div><div className="text-xl font-semibold">{summary?.candidateCount ?? 0}件</div></div>
              <div><div className="text-[11px] text-muted-foreground">accepted / block</div><div className="text-xl font-semibold"><span className="text-emerald-300">{summary?.acceptedCount ?? 0}</span> / <span className="text-amber-300">{summary?.marginBlockedCount ?? 0}</span></div></div>
              <div><div className="text-[11px] text-muted-foreground">仮想決済</div><div className="text-xl font-semibold">{summary?.virtualCompletedCount ?? 0} / {summary?.virtualCreatedCount ?? 0}</div></div>
              <div><div className="text-[11px] text-muted-foreground">勝 / 負 / 分</div><div className="text-xl font-semibold">{summary?.wins ?? 0} / {summary?.losses ?? 0} / {summary?.draws ?? 0}</div></div>
              <div><div className="text-[11px] text-muted-foreground">100株仮想損益</div><div className={`text-xl font-semibold ${(summary?.signalQualityPnl ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}`}>{(summary?.signalQualityPnl ?? 0) >= 0 ? "+" : ""}{(summary?.signalQualityPnl ?? 0).toLocaleString()}円</div></div>
              <div><div className="text-[11px] text-muted-foreground">pending / retry / terminal</div><div className="text-xl font-semibold">{summary?.pendingCount ?? 0} / {summary?.retryableErrorCount ?? 0} / {summary?.terminalCount ?? 0}</div></div>
            </div>
            {data.orphanGaps.length > 0 && (
              <div className="m-4 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200" role="alert">
                candidate行へ結合できない未解決gapが{data.orphanGaps.length}件あります。coverageは未完了です。
              </div>
            )}
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
              <ShieldCheck className="w-4 h-4 text-emerald-300" />
              表は実HTMLで表示され、横方向へスクロールできます。固定source hash: <span className="font-mono">{summary?.fixedSourceHash.slice(0, 12)}…</span>
            </div>
            <SignalCandidateLedgerTable rows={data.rows} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
