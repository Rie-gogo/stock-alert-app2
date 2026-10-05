const SYMBOLS = ["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"];
const NAMES = {
  "285A": "キオクシアHD", "3436": "SUMCO", "5803": "フジクラ", "6146": "ディスコ",
  "6526": "ソシオネクスト", "6857": "アドバンテスト", "6976": "太陽誘電",
  "6981": "村田製作所", "8035": "東京エレクトロン", "9984": "ソフトバンクG",
};

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const baseUrl = (args.get("--base-url") ?? "").replace(/\/$/, "");
const summaryOnly = args.get("--summary-only") === "true";
const targetMode = args.get("--target-mode") ?? "dynamic";
const customStopPct = args.has("--custom-stop-pct") ? Number(args.get("--custom-stop-pct")) : null;
const stopCooldownMinutes = args.has("--stop-cooldown-minutes") ? Number(args.get("--stop-cooldown-minutes")) : 0;
const stopGridPct = (args.get("--stop-grid-pct") ?? "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean)
  .map(Number);
const dates = (args.get("--dates") ?? "").split(",").map(value => value.trim()).filter(Boolean).sort();
const directions = new Map((args.get("--directions") ?? "").split(",").map(value => value.trim()).filter(Boolean).map(value => {
  const [date, direction] = value.split(":");
  if (!date || !["long", "short", "mixed"].includes(direction)) throw new Error(`invalid_direction:${value}`);
  return [date, direction];
}));
if (!baseUrl) throw new Error("--base-url is required");
if (dates.length !== 10) throw new Error("--dates must contain exactly ten dates");
if (!["dynamic", "fixed_entry_band"].includes(targetMode)) throw new Error(`invalid_target_mode:${targetMode}`);
if (customStopPct !== null && (!Number.isFinite(customStopPct) || customStopPct <= 0)) throw new Error(`invalid_custom_stop_pct:${customStopPct}`);
if (!Number.isFinite(stopCooldownMinutes) || stopCooldownMinutes < 0) throw new Error(`invalid_stop_cooldown_minutes:${stopCooldownMinutes}`);
if (stopGridPct.some(value => !Number.isFinite(value) || value <= 0)) throw new Error(`invalid_stop_grid_pct:${stopGridPct.join(",")}`);

function minuteOfDay(candleTime) {
  const [hour, minute] = candleTime.split(":").map(Number);
  return hour * 60 + minute;
}

function bands(candles) {
  const closes = candles.slice(-20).map(candle => candle.close);
  if (closes.length !== 20) return null;
  const middle = closes.reduce((sum, value) => sum + value, 0) / 20;
  const variance = closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / 20;
  const deviation = Math.sqrt(variance);
  return { middle, upper: middle + 2 * deviation, lower: middle - 2 * deviation };
}

function allocatedShares(price) {
  return Math.max(100, Math.floor(Math.floor(3_000_000 * 0.9 / price) / 100) * 100);
}

function closePosition(position, candle, priorCandles, stopPct) {
  const currentBands = bands(priorCandles);
  const target = targetMode === "fixed_entry_band"
    ? position.initialTarget
    : currentBands ? (position.side === "long" ? currentBands.upper : currentBands.lower) : position.initialTarget;
  const stop = stopPct === null ? null : position.side === "long" ? position.entry * (1 - stopPct) : position.entry * (1 + stopPct);
  if (position.side === "long") {
    if (stop !== null && candle.open <= stop) return { price: candle.open, reason: "fixed_stop_pct_gap" };
    if (stop !== null && candle.low <= stop) return { price: stop, reason: "fixed_stop_pct" };
    if (candle.open >= target) return { price: candle.open, reason: "dynamic_upper_band_gap" };
    if (candle.high >= target) return { price: target, reason: "dynamic_upper_band" };
  } else {
    if (stop !== null && candle.open >= stop) return { price: candle.open, reason: "fixed_stop_pct_gap" };
    if (stop !== null && candle.high >= stop) return { price: stop, reason: "fixed_stop_pct" };
    if (candle.open <= target) return { price: candle.open, reason: "dynamic_lower_band_gap" };
    if (candle.low <= target) return { price: target, reason: "dynamic_lower_band" };
  }
  if (candle.candleTime >= "15:20") return { price: candle.close, reason: "day_end_flatten" };
  return null;
}

function replay(symbol, date, direction, candles, stopPct, cooldownMinutes = 0) {
  if (direction === "mixed") return [];
  const priorCandles = [];
  const trades = [];
  let pending = null;
  let position = null;
  let entryBlockedUntilMinute = -Infinity;
  for (const candle of candles) {
    const candleMinute = minuteOfDay(candle.candleTime);
    let result = "no_signal";
    if (position) {
      const exit = closePosition(position, candle, priorCandles, stopPct);
      if (exit) {
        const sign = position.side === "long" ? 1 : -1;
        const perShare = (exit.price - position.entry) * sign;
        const shares = allocatedShares(position.entry);
        const adverseExit = position.side === "long" ? exit.price * 0.999 : exit.price * 1.001;
        const adversePerShare = (adverseExit - position.entry) * sign;
        trades.push({
          symbol, name: NAMES[symbol], date, direction: position.side,
          touchTime: position.touchTime, entryTime: position.entryTime, entry: position.entry,
          exitTime: candle.candleTime, exitPrice: exit.price, exitReason: exit.reason,
          pnl100: Math.round(perShare * 100), shares, pnlAllocated: Math.round(perShare * shares),
          pnlAfterAdverse100: Math.round(adversePerShare * 100),
          pnlAfterAdverseAllocated: Math.round(adversePerShare * shares),
        });
        position = null;
        if (exit.reason.startsWith("fixed_stop") && cooldownMinutes > 0) {
          entryBlockedUntilMinute = candleMinute + cooldownMinutes;
        }
        result = "exit";
      } else result = "hold";
    } else if (pending) {
      const currentPending = pending;
      pending = null;
      const confirmed = currentPending.side === "long" ? candle.close > candle.open : candle.close < candle.open;
      if (confirmed) {
        // Public replay has no historical board endpoint. The completed confirmation close is the causal price proxy.
        const entry = candle.close;
        const targetBands = bands(priorCandles);
        const target = targetBands ? (currentPending.side === "long" ? targetBands.upper : targetBands.lower) : null;
        const targetBeyondEntry = target !== null && (currentPending.side === "long" ? target > entry : target < entry);
        if (targetBeyondEntry) {
          position = { side: currentPending.side, touchTime: currentPending.touchTime, entryTime: candle.candleTime, entry, initialTarget: target };
          result = "entry";
        } else result = "rejected";
      } else result = "rejected";
    }

    const bandsBeforeCurrent = bands(priorCandles);
    priorCandles.push(candle);
    if (!position && !pending && result !== "exit" && candleMinute >= entryBlockedUntilMinute && candle.candleTime >= "09:20" && candle.candleTime <= "14:57" && bandsBeforeCurrent) {
      const touched = direction === "long" ? candle.low <= bandsBeforeCurrent.lower : candle.high >= bandsBeforeCurrent.upper;
      if (touched) {
        pending = { side: direction, touchTime: candle.candleTime };
      }
    }
  }
  return trades;
}

function summarize(trades, key) {
  const wins = trades.filter(trade => trade[key] > 0).length;
  const losses = trades.filter(trade => trade[key] < 0).length;
  const flats = trades.length - wins - losses;
  const pnl = trades.reduce((sum, trade) => sum + trade[key], 0);
  const grossProfit = trades.filter(trade => trade[key] > 0).reduce((sum, trade) => sum + trade[key], 0);
  const grossLoss = trades.filter(trade => trade[key] < 0).reduce((sum, trade) => sum + trade[key], 0);
  return {
    trades: trades.length, wins, losses, flats,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    pnl, averagePnl: trades.length ? pnl / trades.length : 0,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    stopExits: trades.filter(trade => trade.exitReason.startsWith("fixed_stop")).length,
    dayEndExits: trades.filter(trade => trade.exitReason === "day_end_flatten").length,
  };
}

async function fetchCandles(date) {
  const input = encodeURIComponent(JSON.stringify({ json: { tradeDate: date } }));
  const response = await fetch(`${baseUrl}/api/trpc/trading.getRtCandles?input=${input}`);
  if (!response.ok) throw new Error(`getRtCandles_failed:${date}:${response.status}`);
  const payload = await response.json();
  const rows = payload?.result?.data?.json;
  if (!Array.isArray(rows)) throw new Error(`invalid_payload:${date}`);
  return rows;
}

const allRows = (await Promise.all(dates.map(fetchCandles))).flat();
const grouped = new Map();
for (const row of allRows) {
  if (!SYMBOLS.includes(String(row.symbol))) continue;
  const candleTime = String(row.candleTime).slice(0, 5);
  if (!((candleTime >= "09:00" && candleTime <= "11:30") || (candleTime >= "12:30" && candleTime <= "15:30"))) continue;
  const key = `${String(row.tradeDate)}:${String(row.symbol)}`;
  const byTime = grouped.get(key) ?? new Map();
  byTime.set(candleTime, { candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) });
  grouped.set(key, byTime);
}

function runVariant(stopPct, cooldownMinutes = 0) {
  const trades = [];
  for (const date of dates) {
    const direction = directions.get(date) ?? "mixed";
    for (const symbol of SYMBOLS) {
      const candles = [...(grouped.get(`${date}:${symbol}`)?.values() ?? [])].sort((a, b) => a.candleTime.localeCompare(b.candleTime));
      trades.push(...replay(symbol, date, direction, candles, stopPct, cooldownMinutes));
    }
  }
  return {
    summary100: summarize(trades, "pnl100"),
    summaryAllocated: summarize(trades, "pnlAllocated"),
    summaryAfterAdverse100: summarize(trades, "pnlAfterAdverse100"),
    summaryAfterAdverseAllocated: summarize(trades, "pnlAfterAdverseAllocated"),
    byDate100: dates.map(date => ({ date, direction: directions.get(date) ?? "mixed", ...summarize(trades.filter(trade => trade.date === date), "pnl100") })),
    bySymbol100: SYMBOLS.map(symbol => ({ symbol, name: NAMES[symbol], ...summarize(trades.filter(trade => trade.symbol === symbol), "pnl100") })),
    trades,
  };
}

const noStop = runVariant(null);
const stop060 = runVariant(0.006);
const customStop = customStopPct === null ? null : runVariant(customStopPct, stopCooldownMinutes);
const stopGrid = stopGridPct.map(stopPctValue => {
  const result = runVariant(stopPctValue / 100, stopCooldownMinutes);
  return {
    stopPct: stopPctValue,
    cooldownMinutes: stopCooldownMinutes,
    summary100: result.summary100,
    summaryAllocated: result.summaryAllocated,
    summaryAfterAdverse100: result.summaryAfterAdverse100,
    summaryAfterAdverseAllocated: result.summaryAfterAdverseAllocated,
    byDate100: result.byDate100,
    bySymbol100: result.bySymbol100,
  };
});
const quality = dates.map(date => ({
  date,
  direction: directions.get(date) ?? "mixed",
  symbols: SYMBOLS.filter(symbol => grouped.has(`${date}:${symbol}`)).length,
  bars: SYMBOLS.reduce((sum, symbol) => sum + (grouped.get(`${date}:${symbol}`)?.size ?? 0), 0),
}));
const output = {
  note: "Current production transition rules replayed from saved 1-minute candles. Confirmation close substitutes for unavailable historical executable board VWAP; board freshness/depth rejections therefore cannot be reproduced.",
  targetMode,
  dates, directions: Object.fromEntries(dates.map(date => [date, directions.get(date) ?? "mixed"])), quality,
  noStop: { summary100: noStop.summary100, summaryAllocated: noStop.summaryAllocated, summaryAfterAdverse100: noStop.summaryAfterAdverse100, summaryAfterAdverseAllocated: noStop.summaryAfterAdverseAllocated, byDate100: noStop.byDate100, bySymbol100: noStop.bySymbol100, trades: noStop.trades },
  stop060: { summary100: stop060.summary100, summaryAllocated: stop060.summaryAllocated, summaryAfterAdverse100: stop060.summaryAfterAdverse100, summaryAfterAdverseAllocated: stop060.summaryAfterAdverseAllocated, byDate100: stop060.byDate100, bySymbol100: stop060.bySymbol100, trades: stop060.trades },
  customStop: customStop ? { stopPct: customStopPct, cooldownMinutes: stopCooldownMinutes, summary100: customStop.summary100, summaryAllocated: customStop.summaryAllocated, summaryAfterAdverse100: customStop.summaryAfterAdverse100, summaryAfterAdverseAllocated: customStop.summaryAfterAdverseAllocated, byDate100: customStop.byDate100, bySymbol100: customStop.bySymbol100, trades: customStop.trades } : null,
  stopGrid,
};
console.log(JSON.stringify(summaryOnly ? {
  dates: output.dates,
  directions: output.directions,
  quality: output.quality,
  noStop: {
    summary100: output.noStop.summary100,
    summaryAllocated: output.noStop.summaryAllocated,
    summaryAfterAdverse100: output.noStop.summaryAfterAdverse100,
    summaryAfterAdverseAllocated: output.noStop.summaryAfterAdverseAllocated,
  },
  stop060: {
    summary100: output.stop060.summary100,
    summaryAllocated: output.stop060.summaryAllocated,
    summaryAfterAdverse100: output.stop060.summaryAfterAdverse100,
    summaryAfterAdverseAllocated: output.stop060.summaryAfterAdverseAllocated,
  },
  customStop: output.customStop ? {
    stopPct: output.customStop.stopPct,
    cooldownMinutes: output.customStop.cooldownMinutes,
    summary100: output.customStop.summary100,
    summaryAllocated: output.customStop.summaryAllocated,
    summaryAfterAdverse100: output.customStop.summaryAfterAdverse100,
    summaryAfterAdverseAllocated: output.customStop.summaryAfterAdverseAllocated,
  } : null,
  stopGrid: output.stopGrid,
} : output, null, 2));
