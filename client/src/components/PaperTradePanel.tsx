import React, { useState, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/_core/hooks/useAuth';
import { getLoginUrl } from '@/const';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Wallet,
  TrendingUp,
  Loader2,
  CircleDollarSign,
  ArrowDownCircle,
  ArrowUpCircle,
  Trash2,
  LogIn,
} from 'lucide-react';
import { toast } from 'sonner';
import { MAX_CONCURRENT_POSITIONS } from '@shared/stocks';

interface PaperTradePanelProps {
  /** 現在の監視銘柄コード（".T" なし、例: 9984） */
  symbol: string;
  /** 銘柄名 */
  symbolName: string;
  /** 現在値（円）。null の場合はボタンを無効化 */
  currentPrice: number | null;
}

const DEFAULT_QTY = 100;

export default function PaperTradePanel({ symbol, symbolName, currentPrice }: PaperTradePanelProps) {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const utils = trpc.useUtils();

  const [quantity, setQuantity] = useState<number>(DEFAULT_QTY);

  const tradesQuery = trpc.trading.getPaperTrades.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });

  const trades = tradesQuery.data ?? [];
  const openTrades = useMemo(() => trades.filter((t) => t.status === 'open'), [trades]);
  const closedTrades = useMemo(() => trades.filter((t) => t.status === 'closed'), [trades]);

  // 累計損益（決済済みのみ）
  const realizedPnl = useMemo(
    () => closedTrades.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0),
    [closedTrades]
  );
  const winCount = useMemo(
    () => closedTrades.filter((t) => Number(t.pnl ?? 0) > 0).length,
    [closedTrades]
  );
  const winRate = closedTrades.length > 0 ? (winCount / closedTrades.length) * 100 : 0;

  const openMutation = trpc.trading.openPaperTrade.useMutation({
    onSuccess: () => {
      utils.trading.getPaperTrades.invalidate();
    },
    onError: (e) => {
      toast.error('仮エントリーに失敗しました', { description: e.message });
    },
  });

  const closeMutation = trpc.trading.closePaperTrade.useMutation({
    onSuccess: (res) => {
      utils.trading.getPaperTrades.invalidate();
      const pnl = Number(res.trade?.pnl ?? 0);
      toast.success(`決済しました（損益 ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円）`, {
        duration: 2500,
      });
    },
    onError: (e) => {
      toast.error('決済に失敗しました', { description: e.message });
    },
  });

  const deleteMutation = trpc.trading.deletePaperTrade.useMutation({
    onSuccess: () => utils.trading.getPaperTrades.invalidate(),
    onError: (e) => toast.error('削除に失敗しました', { description: e.message }),
  });

  const positionsFull = openTrades.length >= MAX_CONCURRENT_POSITIONS;
  const canTrade = isAuthenticated && currentPrice != null && quantity > 0;

  const handleOpen = (side: 'long' | 'short') => {
    if (currentPrice == null) {
      toast.error('現在値が取得できていません');
      return;
    }
    if (positionsFull) {
      toast.warning(`同時保有は最大${MAX_CONCURRENT_POSITIONS}銘柄までです`, {
        description: 'まず保有中のポジションを決済してください。',
      });
      return;
    }
    openMutation.mutate({
      symbol,
      symbolName,
      side,
      entryPrice: currentPrice,
      quantity,
    });
    toast.success(`${side === 'long' ? '仮買い' : '仮売り'}を記録: ${symbolName} @ ${currentPrice.toFixed(1)}円 × ${quantity}株`, {
      duration: 2200,
    });
  };

  const handleClose = (id: number) => {
    if (currentPrice == null) {
      toast.error('現在値が取得できていません');
      return;
    }
    closeMutation.mutate({ id, exitPrice: currentPrice });
  };

  // 未ログイン時
  if (!authLoading && !isAuthenticated) {
    return (
      <Card className="border-border bg-card/60 backdrop-blur-sm">
        <CardHeader className="py-3 border-b border-border/50">
          <CardTitle className="text-xs font-extrabold flex items-center space-x-2">
            <Wallet className="w-4 h-4 text-primary" />
            <span>仮想売買（ペーパートレード）</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="py-5 text-center space-y-3">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            仮想売買を記録するにはログインが必要です。
            <br />
            ログインすると取引履歴があなたのアカウントに保存されます。
          </p>
          <a
            href={getLoginUrl()}
            className="inline-flex items-center space-x-1.5 px-4 py-1.5 rounded text-xs font-bold bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>ログイン</span>
          </a>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border bg-card/60 backdrop-blur-sm">
      <CardHeader className="py-3 border-b border-border/50">
        <CardTitle className="text-xs font-extrabold flex items-center justify-between">
          <span className="flex items-center space-x-2">
            <Wallet className="w-4 h-4 text-primary" />
            <span>仮想売買（ペーパートレード）</span>
          </span>
          <span className="text-[8px] bg-yellow-500/15 text-yellow-400 px-1.5 py-0.5 rounded font-mono border border-yellow-500/30">
            練習用
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-3 space-y-3">
        {/* ===== エントリーフォーム ===== */}
        <div className="bg-secondary/20 border border-border/50 rounded-lg p-2.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[9px] text-muted-foreground font-bold">対象銘柄（現在の監視銘柄）</span>
              <span className="text-xs font-bold text-foreground">
                {symbolName} <span className="text-muted-foreground font-mono">({symbol})</span>
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[9px] text-muted-foreground font-bold">現在値</span>
              <span className="text-sm font-extrabold font-mono text-foreground">
                {currentPrice != null ? `${currentPrice.toFixed(1)}円` : '--'}
              </span>
            </div>
          </div>

          {/* 数量入力 */}
          <div className="flex items-center space-x-2">
            <span className="text-[10px] text-muted-foreground font-bold whitespace-nowrap">数量</span>
            <input
              type="number"
              min={1}
              step={100}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
              className="flex-1 bg-background border border-border text-xs rounded px-2 py-1 font-mono font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-[10px] text-muted-foreground font-bold">株</span>
            <div className="flex space-x-1">
              {[100, 300, 500].map((q) => (
                <button
                  key={q}
                  onClick={() => setQuantity(q)}
                  className="text-[9px] px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* 概算金額 */}
          {currentPrice != null && (
            <div className="text-[9px] text-muted-foreground font-mono text-right">
              概算約定代金: 約 {Math.round(currentPrice * quantity).toLocaleString()}円
            </div>
          )}

          {/* 仮買い／仮売りボタン */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => handleOpen('long')}
              disabled={!canTrade || positionsFull || openMutation.isPending}
              className="flex items-center justify-center space-x-1.5 py-2 rounded-lg text-xs font-extrabold transition-all duration-150 active:scale-[0.97] bg-destructive/15 text-destructive border border-destructive/40 hover:bg-destructive/25 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              <ArrowUpCircle className="w-4 h-4" />
              <span>仮買い（買建）</span>
            </button>
            <button
              onClick={() => handleOpen('short')}
              disabled={!canTrade || positionsFull || openMutation.isPending}
              className="flex items-center justify-center space-x-1.5 py-2 rounded-lg text-xs font-extrabold transition-all duration-150 active:scale-[0.97] bg-emerald-500/15 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              <ArrowDownCircle className="w-4 h-4" />
              <span>仮売り（空売り）</span>
            </button>
          </div>

          {positionsFull && (
            <p className="text-[9px] text-yellow-400 font-bold text-center">
              同時保有が上限（{MAX_CONCURRENT_POSITIONS}銘柄）に達しています。決済すると新規記録できます。
            </p>
          )}
        </div>

        {/* ===== 累計損益サマリー ===== */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-secondary/20 border border-border/50 rounded p-2">
            <div className="text-[8px] text-muted-foreground font-bold">確定損益</div>
            <div className={`text-xs font-extrabold font-mono ${realizedPnl >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
              {realizedPnl >= 0 ? '+' : ''}{realizedPnl.toLocaleString()}
            </div>
          </div>
          <div className="bg-secondary/20 border border-border/50 rounded p-2">
            <div className="text-[8px] text-muted-foreground font-bold">勝率</div>
            <div className="text-xs font-extrabold font-mono text-foreground">
              {closedTrades.length > 0 ? `${winRate.toFixed(0)}%` : '--'}
            </div>
          </div>
          <div className="bg-secondary/20 border border-border/50 rounded p-2">
            <div className="text-[8px] text-muted-foreground font-bold">保有中</div>
            <div className="text-xs font-extrabold font-mono text-foreground">
              {openTrades.length}/{MAX_CONCURRENT_POSITIONS}
            </div>
          </div>
        </div>

        {/* ===== 保有中ポジション ===== */}
        <div>
          <h4 className="text-[10px] font-bold text-foreground mb-1.5 flex items-center">
            <CircleDollarSign className="w-3.5 h-3.5 mr-1 text-primary" />
            保有中ポジション
          </h4>
          {tradesQuery.isLoading ? (
            <div className="flex items-center justify-center py-3 text-muted-foreground text-[10px] font-mono space-x-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>読み込み中...</span>
            </div>
          ) : openTrades.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-3 leading-relaxed">
              保有中のポジションはありません。
              <br />
              上のボタンで仮エントリーを記録できます。
            </p>
          ) : (
            <div className="space-y-1.5">
              {openTrades.map((t) => {
                const entry = parseFloat(String(t.entryPrice));
                // 含み損益（現在値があれば計算）
                const unrealized =
                  currentPrice != null && t.symbol === symbol
                    ? t.side === 'long'
                      ? Math.round((currentPrice - entry) * t.quantity)
                      : Math.round((entry - currentPrice) * t.quantity)
                    : null;
                return (
                  <div
                    key={t.id}
                    className="bg-background/60 border border-border/60 rounded-lg p-2 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5">
                        <span
                          className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded ${
                            t.side === 'long'
                              ? 'bg-destructive/20 text-destructive'
                              : 'bg-emerald-500/20 text-emerald-400'
                          }`}
                        >
                          {t.side === 'long' ? '買建' : '空売り'}
                        </span>
                        <span className="text-[11px] font-bold text-foreground">{t.symbolName}</span>
                        <span className="text-[9px] text-muted-foreground font-mono">{t.symbol}</span>
                      </div>
                      <button
                        onClick={() => deleteMutation.mutate({ id: t.id })}
                        title="この記録を取り消し"
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[9px] font-mono text-muted-foreground">
                      <span>
                        建値 <span className="text-foreground font-bold">{entry.toFixed(1)}</span> × {t.quantity}株
                      </span>
                      {unrealized != null && (
                        <span className={unrealized >= 0 ? 'text-destructive font-bold' : 'text-emerald-400 font-bold'}>
                          含み {unrealized >= 0 ? '+' : ''}{unrealized.toLocaleString()}円
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => handleClose(t.id)}
                      disabled={currentPrice == null || closeMutation.isPending}
                      className="w-full text-[10px] font-bold py-1 rounded bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {currentPrice != null
                        ? `現在値 ${currentPrice.toFixed(1)}円で決済`
                        : '現在値待ち...'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ===== 決済済み履歴 ===== */}
        {closedTrades.length > 0 && (
          <div>
            <h4 className="text-[10px] font-bold text-foreground mb-1.5 flex items-center">
              <TrendingUp className="w-3.5 h-3.5 mr-1 text-muted-foreground" />
              取引履歴（決済済み）
            </h4>
            <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
              {closedTrades.map((t) => {
                const entry = parseFloat(String(t.entryPrice));
                const exit = t.exitPrice != null ? parseFloat(String(t.exitPrice)) : null;
                const pnl = Number(t.pnl ?? 0);
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between bg-background/40 border border-border/40 rounded px-2 py-1.5 text-[9px] font-mono"
                  >
                    <div className="flex items-center space-x-1.5 min-w-0">
                      <span
                        className={`text-[8px] font-extrabold px-1 py-0.5 rounded flex-shrink-0 ${
                          t.side === 'long'
                            ? 'bg-destructive/20 text-destructive'
                            : 'bg-emerald-500/20 text-emerald-400'
                        }`}
                      >
                        {t.side === 'long' ? '買' : '空'}
                      </span>
                      <span className="text-foreground font-bold truncate">{t.symbolName}</span>
                      <span className="text-muted-foreground flex-shrink-0">
                        {entry.toFixed(0)}→{exit != null ? exit.toFixed(0) : '--'}
                      </span>
                    </div>
                    <span className={`font-extrabold flex-shrink-0 ml-1 ${pnl >= 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                      {pnl >= 0 ? '+' : ''}{pnl.toLocaleString()}円
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-[8px] text-muted-foreground leading-relaxed border-t border-border/40 pt-2">
          ※ 実際の発注は行いません。決済は「決済」ボタンを押した時点の現在値で約定したものとして損益を計算します（手数料・スリッページは未考慮）。
        </p>
      </CardContent>
    </Card>
  );
}
