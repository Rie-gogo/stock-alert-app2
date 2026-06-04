// SUMCO本日のslope/flow/regimeGateを確認するデバッグスクリプト
const apiKey = 'csmPTBGa6DCWH1aE2fK5ym3YNiITLt7HHQRwlVhmFSs';
const url = 'https://api.jquants.com/v2/equities/bars/minute?code=34360&from=2026-06-04&to=2026-06-04';

const resp = await fetch(url, { headers: { 'x-api-key': apiKey } });
const j = await resp.json();
const bars = j.data || [];
console.log('Total bars:', bars.length);

const closes = bars.map(b => b.C);

function calcMA(arr, n) {
  return arr.map((_, i) => i < n-1 ? null : arr.slice(i-n+1, i+1).reduce((a,b)=>a+b,0)/n);
}
const ma25 = calcMA(closes, 25);

const SLOPE_LOOKBACK = 5;
const SLOPE_THRESHOLD = 0.0003;
const FLOW_LOOKBACK = 10;
const MARKET_REGIME_THRESHOLD = 0.004;
const WARMUP_BARS = 10;

const signedVol = bars.map(b => {
  const range = (b.H - b.L) || 1;
  const clv = ((b.C - b.L) - (b.H - b.C)) / range;
  return clv * b.Vo;
});

const gcTimes = new Set(['09:56', '10:37', '11:27', '13:11', '13:51', '15:08']);
const dcTimes = new Set(['10:17', '10:58', '12:50', '13:37', '14:45', '15:16']);
const open0 = bars[0].O;

console.log('\n=== GC/DC シグナルポイントでのレジーム判定 ===');
for (let i = WARMUP_BARS; i < bars.length; i++) {
  const time = bars[i].Time;
  if (!gcTimes.has(time) && !dcTimes.has(time)) continue;

  const slope = (i >= SLOPE_LOOKBACK && ma25[i] !== null && ma25[i-SLOPE_LOOKBACK] !== null)
    ? (ma25[i] - ma25[i-SLOPE_LOOKBACK]) / ma25[i-SLOPE_LOOKBACK]
    : 0;

  let flowSum = 0;
  if (i >= FLOW_LOOKBACK - 1) {
    for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) flowSum += signedVol[k];
  }

  const mktBias = (bars[i].C - open0) / open0;
  const stockTrendUp = slope > SLOPE_THRESHOLD;
  const stockTrendDown = slope < -SLOPE_THRESHOLD;
  const flowUp = flowSum > 0;
  const flowDown = flowSum < 0;
  const mktUp = mktBias > MARKET_REGIME_THRESHOLD;
  const mktDown = mktBias < -MARKET_REGIME_THRESHOLD;
  const allowLong = stockTrendUp && flowUp && !mktDown;
  const allowShort = stockTrendDown && flowDown && !mktUp;

  const type = gcTimes.has(time) ? 'GC(買い)' : 'DC(売り)';
  const expected = gcTimes.has(time) ? 'allowLong' : 'allowShort';
  const result = gcTimes.has(time) ? allowLong : allowShort;
  
  console.log(`\n${time} ${type}:`);
  console.log(`  slope: ${(slope*10000).toFixed(2)}bps (threshold: ${SLOPE_THRESHOLD*10000}bps) → trendUp:${stockTrendUp} trendDown:${stockTrendDown}`);
  console.log(`  flow: ${flowSum > 0 ? '+' : ''}${Math.round(flowSum/1000)}k → flowUp:${flowUp} flowDown:${flowDown}`);
  console.log(`  mktBias: ${(mktBias*100).toFixed(2)}% → mktUp:${mktUp} mktDown:${mktDown}`);
  console.log(`  ${expected}: ${result} ${result ? '✅ エントリー可' : '❌ ブロック'}`);
  if (!result) {
    if (gcTimes.has(time)) {
      const reasons = [];
      if (!stockTrendUp) reasons.push(`slope不足(${(slope*10000).toFixed(1)}bps < ${SLOPE_THRESHOLD*10000}bps)`);
      if (!flowUp) reasons.push('flow売り優勢');
      if (mktDown) reasons.push('市場下落ムード');
      console.log(`  ブロック理由: ${reasons.join(', ')}`);
    } else {
      const reasons = [];
      if (!stockTrendDown) reasons.push(`slope不足(${(slope*10000).toFixed(1)}bps > -${SLOPE_THRESHOLD*10000}bps)`);
      if (!flowDown) reasons.push('flow買い優勢');
      if (mktUp) reasons.push('市場上昇ムード');
      console.log(`  ブロック理由: ${reasons.join(', ')}`);
    }
  }
}

// 全体サマリー
console.log('\n=== 全バー統計 ===');
let longAllowed = 0, shortAllowed = 0, total = 0;
for (let i = WARMUP_BARS; i < bars.length; i++) {
  const slope = (i >= SLOPE_LOOKBACK && ma25[i] !== null && ma25[i-SLOPE_LOOKBACK] !== null)
    ? (ma25[i] - ma25[i-SLOPE_LOOKBACK]) / ma25[i-SLOPE_LOOKBACK] : 0;
  let flowSum = 0;
  if (i >= FLOW_LOOKBACK - 1) {
    for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) flowSum += signedVol[k];
  }
  const mktBias = (bars[i].C - open0) / open0;
  const stockTrendUp = slope > SLOPE_THRESHOLD;
  const flowUp = flowSum > 0;
  const mktDown = mktBias < -MARKET_REGIME_THRESHOLD;
  const stockTrendDown = slope < -SLOPE_THRESHOLD;
  const flowDown = flowSum < 0;
  const mktUp = mktBias > MARKET_REGIME_THRESHOLD;
  if (stockTrendUp && flowUp && !mktDown) longAllowed++;
  if (stockTrendDown && flowDown && !mktUp) shortAllowed++;
  total++;
}
console.log(`ロングエントリー可能バー: ${longAllowed}/${total} (${(longAllowed/total*100).toFixed(1)}%)`);
console.log(`ショートエントリー可能バー: ${shortAllowed}/${total} (${(shortAllowed/total*100).toFixed(1)}%)`);
