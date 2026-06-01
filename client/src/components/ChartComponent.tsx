import React, { useState } from 'react';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  Bar,
} from 'recharts';
import { CandleData } from '../types';

interface ChartComponentProps {
  data: CandleData[];
  selectedCandle: CandleData | null;
  onSelectCandle: (candle: CandleData | null) => void;
}

// ホバー中のシグナル情報
interface HoveredSignal {
  x: number;
  y: number;
  type: 'buy' | 'sell' | 'warn';
  reason: string;
  price: number;
  time: string;
}

// カスタムローソク足レンダラー
const Candlestick = (props: any) => {
  const { x, y, open, close, high, low, width, yDomain, height, signals, onSignalHover, onSignalLeave } = props;
  const isUp = close >= open;

  const fill = isUp ? 'oklch(0.65 0.18 15)' : 'oklch(0.6 0.18 140)';
  const stroke = fill;

  const candleWidth = Math.max(3, width - 2);
  const xOffset = x + (width - candleWidth) / 2;
  const cx = xOffset + candleWidth / 2;

  const toY = (price: number) =>
    y + (1 - (price - yDomain[0]) / (yDomain[1] - yDomain[0])) * height;

  const openY = toY(open);
  const closeY = toY(close);
  const highY = toY(high);
  const lowY = toY(low);

  const top = Math.min(openY, closeY);
  const bottom = Math.max(openY, closeY);
  const bodyHeight = Math.max(1, bottom - top);

  return (
    <g>
      {/* 芯 */}
      <line x1={cx} y1={highY} x2={cx} y2={lowY} stroke={stroke} strokeWidth={1.5} />
      {/* 実体 */}
      <rect x={xOffset} y={top} width={candleWidth} height={bodyHeight} fill={fill} stroke={stroke} strokeWidth={1} />

      {/* シグナルマーカー */}
      {signals && signals.map((sig: { type: 'buy' | 'sell' | 'warn'; reason: string }, index: number) => {
        const isBuy = sig.type === 'buy';
        const isWarn = sig.type === 'warn';
        // 買い=下に上向き矢印、売り=上に下向き矢印、警告=上にひし形
        const arrowTip = (isBuy) ? lowY + 6 : highY - 6;
        const arrowBase = (isBuy) ? lowY + 18 : highY - 18;
        const labelY = (isBuy) ? lowY + 28 : highY - 22;
        const color = isBuy ? '#ef4444' : isWarn ? '#eab308' : '#22c55e'; // 赤=買い、黄=警告、緑=売り
        const centerY = isWarn ? highY - 12 : (isBuy ? lowY + 12 : highY - 12);

        // 矢印の向き（買い=上向き▲、売り=下向き▼、警告=ひし形◆）
        const arrowPath = isWarn
          ? `M ${cx} ${highY - 20} L ${cx - 6} ${highY - 12} L ${cx} ${highY - 4} L ${cx + 6} ${highY - 12} Z`
          : isBuy
          ? `M ${cx} ${arrowTip} L ${cx - 6} ${arrowBase} L ${cx + 6} ${arrowBase} Z`
          : `M ${cx} ${arrowTip} L ${cx - 6} ${arrowBase} L ${cx + 6} ${arrowBase} Z`;

        return (
          <g
            key={index}
            style={{ cursor: 'pointer' }}
            onMouseEnter={(e) => {
              const rect = (e.target as SVGElement).closest('svg')?.getBoundingClientRect();
              if (rect && onSignalHover) {
                onSignalHover({
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                  type: sig.type,
                  reason: sig.reason,
                  price: isBuy ? low : high,
                  time: props.time,
                });
              }
            }}
            onMouseLeave={() => onSignalLeave && onSignalLeave()}
          >
            {/* 発光エフェクト */}
            <circle cx={cx} cy={centerY} r={12} fill={color} opacity={0.15} />
            {/* 矢印/ひし形 */}
            <path d={arrowPath} fill={color} stroke={color} strokeWidth={1} opacity={0.9} />
            {/* ラベル（B/S/W） */}
            <text
              x={cx}
              y={isWarn ? highY - 26 : labelY}
              fill={color}
              fontSize="10"
              fontWeight="900"
              textAnchor="middle"
              fontFamily="monospace"
            >
              {isBuy ? 'B' : isWarn ? 'W' : 'S'}
            </text>
          </g>
        );
      })}
    </g>
  );
};

export default function ChartComponent({ data, selectedCandle, onSelectCandle }: ChartComponentProps) {
  const [hoveredSignal, setHoveredSignal] = useState<HoveredSignal | null>(null);

  const activeCandles = data.slice(-40);

  const minPrice = Math.min(...activeCandles.map((c) => {
    const vals = [c.low, c.ma5, c.ma25, c.bbLower].filter((v) => v !== undefined) as number[];
    return Math.min(...vals);
  }));
  const maxPrice = Math.max(...activeCandles.map((c) => {
    const vals = [c.high, c.ma5, c.ma25, c.bbUpper].filter((v) => v !== undefined) as number[];
    return Math.max(...vals);
  }));

  const priceMargin = (maxPrice - minPrice) * 0.12 || 5;
  const yDomain = [
    Number((minPrice - priceMargin).toFixed(1)),
    Number((maxPrice + priceMargin).toFixed(1)),
  ];

  const maxVolume = Math.max(...activeCandles.map((c) => c.volume), 1);

  const handleMouseMove = (state: any) => {
    if (state && state.activePayload && state.activePayload.length > 0) {
      onSelectCandle(state.activePayload[0].payload);
    }
  };

  const handleMouseLeave = () => {
    onSelectCandle(null);
  };

  // カスタムツールチップ
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const c: CandleData = payload[0].payload;
      const hasSignals = c.signals && c.signals.length > 0;
      return (
        <div className="bg-card/98 border border-border p-2.5 text-xs font-mono rounded shadow-xl backdrop-blur-sm z-50 min-w-[160px]">
          <div className="text-muted-foreground border-b border-border pb-1 mb-1.5 font-bold text-[11px]">{c.time}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span className="text-muted-foreground">始値:</span><span className="text-right font-bold">{c.open.toFixed(1)}</span>
            <span className="text-destructive">高値:</span><span className="text-right text-destructive font-bold">{c.high.toFixed(1)}</span>
            <span className="text-emerald-500">安値:</span><span className="text-right text-emerald-500 font-bold">{c.low.toFixed(1)}</span>
            <span className="text-muted-foreground">終値:</span><span className="text-right font-bold">{c.close.toFixed(1)}</span>
            <span className="text-yellow-500">出来高:</span><span className="text-right text-yellow-500 font-bold">{c.volume.toLocaleString()}</span>
            {c.rsi !== undefined && (
              <><span className="text-purple-400">RSI:</span><span className="text-right text-purple-400 font-bold">{c.rsi.toFixed(1)}%</span></>
            )}
          </div>
          {hasSignals && (
            <div className="mt-1.5 pt-1.5 border-t border-border/50 space-y-0.5">
              {c.signals!.map((sig, i) => (
                <div key={i} className={`text-[10px] font-bold flex items-center space-x-1 ${sig.type === 'buy' ? 'text-destructive' : 'text-emerald-400'}`}>
                  <span className="font-mono">{sig.type === 'buy' ? '▲BUY' : '▼SELL'}</span>
                  <span className="font-normal text-muted-foreground truncate max-w-[120px]">{sig.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  // シグナル数のカウント（チャート上部に表示用）
  const signalCount = activeCandles.reduce((acc, c) => acc + (c.signals?.length ?? 0), 0);
  const buyCount = activeCandles.reduce((acc, c) => acc + (c.signals?.filter(s => s.type === 'buy').length ?? 0), 0);
  const sellCount = signalCount - buyCount;

  return (
    <div className="flex flex-col h-full space-y-2 relative">
      {/* メインチャート */}
      <div className="flex-1 min-h-[320px] bg-background border border-border p-2 relative">
        <div className="absolute top-2 left-3 flex items-center flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono z-10 bg-background/90 px-2 py-1 rounded backdrop-blur-sm border border-border/30">
          <span className="flex items-center"><span className="w-2 h-2 bg-destructive rounded-full mr-1" />陽線</span>
          <span className="flex items-center"><span className="w-2 h-2 bg-emerald-500 rounded-full mr-1" />陰線</span>
          <span className="text-cyan-400">5MA: {selectedCandle?.ma5?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.ma5?.toFixed(1) ?? '-'}</span>
          <span className="text-yellow-400">25MA: {selectedCandle?.ma25?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.ma25?.toFixed(1) ?? '-'}</span>
          {signalCount > 0 && (
            <span className="flex items-center gap-1 ml-1">
              {buyCount > 0 && <span className="bg-destructive/20 text-destructive border border-destructive/40 px-1.5 py-0 rounded font-bold">▲B×{buyCount}</span>}
              {sellCount > 0 && <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-1.5 py-0 rounded font-bold">▼S×{sellCount}</span>}
            </span>
          )}
        </div>

        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={activeCandles}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            margin={{ top: 10, right: 10, bottom: 5, left: -10 }}
          >
            <XAxis
              dataKey="time"
              tick={{ fill: 'oklch(0.65 0.02 240)', fontSize: 9 }}
              stroke="oklch(0.25 0.02 240)"
            />
            <YAxis
              domain={yDomain}
              orientation="right"
              tick={{ fill: 'oklch(0.65 0.02 240)', fontSize: 9 }}
              stroke="oklch(0.25 0.02 240)"
            />
            <Tooltip content={<CustomTooltip />} />

            {/* ボリンジャーバンド */}
            <Area type="monotone" dataKey="bbUpper" stroke="transparent" fill="oklch(0.6 0.12 300 / 5%)" activeDot={false} />
            <Area type="monotone" dataKey="bbLower" stroke="transparent" fill="transparent" activeDot={false} />
            <Line type="monotone" dataKey="bbUpper" stroke="oklch(0.6 0.12 300 / 30%)" strokeDasharray="3 3" dot={false} activeDot={false} />
            <Line type="monotone" dataKey="bbLower" stroke="oklch(0.6 0.12 300 / 30%)" strokeDasharray="3 3" dot={false} activeDot={false} />

            {/* 移動平均線 */}
            <Line type="monotone" dataKey="ma5" stroke="oklch(0.7 0.15 200)" strokeWidth={1.5} dot={false} activeDot={false} />
            <Line type="monotone" dataKey="ma25" stroke="oklch(0.75 0.15 80)" strokeWidth={1.5} dot={false} activeDot={false} />

            {/* ローソク足（カスタムレンダラー） */}
            <Bar
              dataKey="close"
              shape={(props: any) => {
                const candleData = activeCandles[props.index];
                return (
                  <Candlestick
                    {...props}
                    yDomain={yDomain}
                    signals={candleData?.signals}
                    time={candleData?.time}
                    onSignalHover={setHoveredSignal}
                    onSignalLeave={() => setHoveredSignal(null)}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>

        {/* シグナルホバーツールチップ */}
        {hoveredSignal && (
          <div
            className="absolute z-50 pointer-events-none"
            style={{
              left: Math.min(hoveredSignal.x + 12, 400),
              top: Math.max(hoveredSignal.y - 60, 8),
            }}
          >
            <div               className={`rounded-lg border px-3 py-2 text-xs shadow-xl backdrop-blur-sm ${
              hoveredSignal.type === 'buy'
                ? 'bg-red-950/95 border-destructive/60 text-destructive'
                : hoveredSignal.type === 'warn'
                ? 'bg-yellow-950/95 border-yellow-500/60 text-yellow-400'
                : 'bg-emerald-950/95 border-emerald-500/60 text-emerald-400'
            }`}>
              <div className="font-extrabold text-sm mb-1">
                {hoveredSignal.type === 'buy' ? '▲ BUY シグナル' : hoveredSignal.type === 'warn' ? '◆ WARNING 警告' : '▼ SELL シグナル'}
              </div>
              <div className="text-foreground font-bold">{hoveredSignal.time} @ {hoveredSignal.price.toFixed(1)}</div>
              <div className="text-muted-foreground mt-0.5 max-w-[200px] leading-relaxed">{hoveredSignal.reason}</div>
            </div>
          </div>
        )}
      </div>

      {/* サブチャート（出来高 + RSI） */}
      <div className="h-[120px] flex space-x-2">
        {/* 出来高 */}
        <div className="w-[30%] bg-background border border-border p-2 relative">
          <div className="absolute top-1 left-2 text-[9px] font-mono text-muted-foreground">出来高</div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={activeCandles} margin={{ top: 15, right: 5, bottom: 5, left: -25 }}>
              <XAxis dataKey="time" hide />
              <YAxis domain={[0, maxVolume]} hide />
              <Bar dataKey="volume" fill="oklch(0.7 0.15 200 / 30%)" radius={[1, 1, 0, 0]} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* RSI */}
        <div className="w-[70%] bg-background border border-border p-2 relative">
          <div className="absolute top-1 left-2 text-[9px] font-mono text-purple-400">
            RSI(14): {selectedCandle?.rsi?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.rsi?.toFixed(1) ?? '-'}%
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={activeCandles} margin={{ top: 15, right: 10, bottom: 5, left: -25 }}>
              <XAxis dataKey="time" hide />
              <YAxis domain={[0, 100]} orientation="right" tick={{ fill: 'oklch(0.65 0.02 240)', fontSize: 8 }} stroke="oklch(0.25 0.02 240)" />
              <ReferenceLine y={70} stroke="oklch(0.6 0.18 25 / 40%)" strokeDasharray="3 3" />
              <ReferenceLine y={30} stroke="oklch(0.65 0.18 140 / 40%)" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="rsi" stroke="oklch(0.6 0.12 300)" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
