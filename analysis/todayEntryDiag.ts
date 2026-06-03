/**
 * todayEntryDiag.ts
 * 本日(既定はJST今日)の各銘柄について、本番ロジックのエントリー中間条件が
 * どのバーで成立/不成立だったかを集計し、「取引が少ない理由」を切り分ける。
 *
 * 本番と同じ指標期間（MA5/MA25/RSI14/SLOPE_LOOKBACK=25/FLOW_LOOKBACK=10）で計算する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/todayEntryDiag.ts [YYYY-MM-DD]
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";

// 本番 realSimulation.ts と同じ閾値（参照: SLOPE_THRESHOLD, MARKET_REGIME_THRESHOLD 等）
const SLOPE_THRESHOLD = 0.0003;
const MARKET_REGIME_THRESHOLD = 0.0015;
const PULLBACK_RSI = 50;
const PULLBACK_NEAR_MA = 0.004;
const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;
const WARMUP_BARS = 10;

function calcMA(d: number[], p: number) { const r: (number | null)[] = new Array(d.length).fill(null); for (let i = p - 1; i < d.length; i++) r[i] = d.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p; return r; }
function calcRSI(d: number[], p: number) { const r: (number | null)[] = new Array(d.length).fill(null); if (d.length < p + 1) return r; const g: number[] = [], l: number[] = []; for (let i = 1; i < d.length; i++) { const x = d[i] - d[i - 1]; g.push(Math.max(x, 0)); l.push(Math.max(-x, 0)); } let ag = g.slice(0, p).reduce((a, b) => a + b, 0) / p, al = l.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < d.length; i++) { r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); if (i < d.length - 1) { ag = (ag * (p - 1) + g[i]) / p; al = (al * (p - 1) + l[i]) / p; } } return r; }

interface Bar { open: number; high: number; low: number; close: number; volume: number; }
async function fetchDay(ticker: string, day: string): Promise<Bar[]> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", { query: { symbol: ticker, region: "JP", interval: "1m", range: "5d" } }) as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> } }> } };
  const res = raw?.chart?.result?.[0]; const out: Bar[] = []; if (!res) return out;
  const ts = res.timestamp ?? [], q = res.indicators.quote[0];
  for (let i = 0; i < ts.length; i++) { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]; if (o == null || c == null) continue; const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000); const d = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`; if (d !== day) continue; out.push({ open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0 }); }
  return out;
}

async function main() {
  const argDay = process.argv[2];
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = argDay || `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;
  console.log(`診断日(JST): ${today}\n`);

  // 市場全体バイアス（全銘柄の始値比平均）を進行率で作るため、まず全銘柄取得
  const barsBySym = new Map<string, Bar[]>();
  for (const s of TARGET_STOCKS) {
    const bars = await fetchDay(s.ticker, today);
    if (bars.length >= 60) barsBySym.set(s.symbol, bars);
    await new Promise(r => setTimeout(r, 250));
  }
  if (barsBySym.size === 0) { console.error("当日データなし"); process.exit(2); }

  // 進行率ベースの市場バイアス
  const ratioSeries: number[][] = [];
  for (const bars of barsBySym.values()) { const open = bars[0].open; ratioSeries.push(bars.map(b => open > 0 ? (b.close - open) / open : 0)); }
  const mktBiasAt = (p: number) => { let s = 0, c = 0; for (const ser of ratioSeries) { if (!ser.length) continue; const idx = Math.min(ser.length - 1, Math.max(0, Math.round(p * (ser.length - 1)))); s += ser[idx]; c++; } return c ? s / c : 0; };

  // 集計ヘッダ
  console.log("銘柄 | 有効本 | レジームLong許可 | 買いシグナル候補 | 出来高裏付 | →全成立 || ショート許可");
  for (const [sym, bars] of barsBySym) {
    const st = TARGET_STOCKS.find(s => s.symbol === sym)!;
    const closes = bars.map(b => b.close);
    const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
    const slope: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = SLOPE_LOOKBACK; i < bars.length; i++) { const pm = ma25[i - SLOPE_LOOKBACK]; if (pm != null && pm !== 0 && ma25[i] != null) slope[i] = ((ma25[i] as number) - pm) / pm; }
    const signed = bars.map(c => { const r = (c.high - c.low) || 1; return ((c.close - c.low) - (c.high - c.close)) / r * c.volume; });
    const flow: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = FLOW_LOOKBACK - 1; i < bars.length; i++) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signed[k]; flow[i] = s; }
    // 出来高平均
    const avgVol = (i: number) => { const st2 = Math.max(0, i - 10); let s = 0, c = 0; for (let k = st2; k < i; k++) { s += bars[k].volume; c++; } return c ? s / c : 0; };

    let valid = 0, cLong = 0, cBuySig = 0, cVol = 0, cAll = 0, cShort = 0;
    for (let i = WARMUP_BARS; i < bars.length; i++) {
      if (ma5[i] == null || ma25[i] == null || rsi[i] == null || slope[i] == null || flow[i] == null) continue;
      valid++;
      const sl = slope[i] as number, fl = flow[i] as number, r = rsi[i] as number, c = bars[i].close, m25 = ma25[i] as number, m5 = ma5[i] as number;
      const p = bars.length > 1 ? i / (bars.length - 1) : 1;
      const mb = mktBiasAt(p);
      const mktUp = mb > MARKET_REGIME_THRESHOLD, mktDown = mb < -MARKET_REGIME_THRESHOLD;
      const trendUp = sl > SLOPE_THRESHOLD, trendDown = sl < -SLOPE_THRESHOLD;
      const flowUp = fl > 0, flowDown = fl < 0;
      const allowLong = trendUp && flowUp && !mktDown;
      const allowShort = trendDown && flowDown && !mktUp;
      if (allowLong) cLong++;
      if (allowShort) cShort++;
      // 買いシグナル候補
      const golden = m5 > m25;
      const pullback = sl > SLOPE_THRESHOLD && r <= PULLBACK_RSI && (m25 > 0 && Math.abs(c - m25) / m25 <= PULLBACK_NEAR_MA) && c >= m25;
      const buySig = golden || pullback;
      if (buySig) cBuySig++;
      const volOk = bars[i].volume >= avgVol(i) * 0.8;
      if (volOk) cVol++;
      if (allowLong && buySig && volOk) cAll++;
    }
    console.log(`${sym} ${st.name.padEnd(10)} | ${String(valid).padStart(3)} | Long許可${String(cLong).padStart(3)} | 買候補${String(cBuySig).padStart(3)} | 出来高OK${String(cVol).padStart(3)} | 全成立${String(cAll).padStart(3)} || Short許可${String(cShort).padStart(3)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
