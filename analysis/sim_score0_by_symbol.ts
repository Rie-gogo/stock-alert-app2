import mysql from "mysql2/promise";

const SYMBOL_SL: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5, "6920": 0.9,
};
const TP_PCT = 1.5;
const NAMES: Record<string, string> = {
  "8035": "東京エレクトロン", "6857": "アドバンテスト", "6976": "太陽誘電",
  "6526": "ソシオネクスト", "5803": "フジクラ", "6981": "村田製作所",
  "285A": "キオクシア", "6146": "ディスコ", "6594": "ニデック",
  "8316": "三井住友FG", "6920": "レーザーテック",
};

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);
  const [blocks] = await conn.query(
    "SELECT trade_date, symbol, candle_time, side, signal_reason, entry_price FROM rt_score0_blocks ORDER BY trade_date, candle_time"
  ) as any[];
  const cache = new Map<string, any[]>();
  const results: Array<{ symbol: string; side: string; pnl: number; res: string }> = [];

  for (const b of blocks) {
    const key = `${b.trade_date}_${b.symbol}`;
    if (!cache.has(key)) {
      const [c] = await conn.query(
        "SELECT candleTime, high, low, close FROM rt_candles WHERE tradeDate=? AND symbol=? ORDER BY candleTime",
        [b.trade_date, b.symbol]
      ) as any[];
      cache.set(key, c);
    }
    const candles = cache.get(key) as any[];
    const ep = Number(b.entry_price);
    const sl = SYMBOL_SL[b.symbol] ?? 0.5;
    const shares = Math.max(100, Math.floor(3000000 / ep / 100) * 100);
    const isLong = b.side === "BUY";
    const slP = isLong ? ep * (1 - sl / 100) : ep * (1 + sl / 100);
    const tpP = isLong ? ep * (1 + TP_PCT / 100) : ep * (1 - TP_PCT / 100);
    const si = candles.findIndex((c: any) => c.candleTime > b.candle_time);
    const after = si >= 0 ? candles.slice(si) : [];
    let res = "EOD", pnl = 0;
    for (const c of after) {
      const h = Number(c.high), l = Number(c.low);
      if ((isLong && l <= slP) || (!isLong && h >= slP)) { res = "SL"; pnl = -ep * sl / 100 * shares; break; }
      if ((isLong && h >= tpP) || (!isLong && l <= tpP)) { res = "TP"; pnl = ep * TP_PCT / 100 * shares; break; }
    }
    if (res === "EOD") {
      const ec = candles.length ? Number(candles[candles.length - 1].close) : ep;
      pnl = (isLong ? ec - ep : ep - ec) * shares;
    }
    results.push({ symbol: b.symbol, side: b.side, pnl, res });
  }
  await conn.end();

  const syms = [...new Set(results.map(r => r.symbol))].sort((a, b) => {
    const pa = results.filter(r => r.symbol === a).reduce((s, r) => s + r.pnl, 0);
    const pb = results.filter(r => r.symbol === b).reduce((s, r) => s + r.pnl, 0);
    return pb - pa;
  });

  console.log("銘柄 | 名前 | 件数 | 勝率 | 損益 | TP | SL | EOD | PF");
  console.log("-".repeat(95));
  for (const sym of syms) {
    const sr = results.filter(r => r.symbol === sym);
    const w = sr.filter(r => r.pnl > 0);
    const l = sr.filter(r => r.pnl <= 0);
    const tot = sr.reduce((s, r) => s + r.pnl, 0);
    const gw = w.reduce((s, r) => s + r.pnl, 0);
    const gl = Math.abs(l.reduce((s, r) => s + r.pnl, 0));
    const pf = gl ? (gw / gl).toFixed(2) : (gw > 0 ? "Inf" : "0.00");
    console.log(
      `${sym} | ${(NAMES[sym] || sym).padEnd(10)} | ${String(sr.length).padStart(2)} | ${(w.length / sr.length * 100).toFixed(0).padStart(3)}% | ${(tot >= 0 ? "+" : "") + Math.round(tot).toLocaleString().padStart(10)} | ${sr.filter(r => r.res === "TP").length.toString().padStart(2)} | ${sr.filter(r => r.res === "SL").length.toString().padStart(2)} | ${sr.filter(r => r.res === "EOD").length.toString().padStart(2)} | ${pf}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
