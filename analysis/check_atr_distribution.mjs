import fs from 'fs';

const DATES = ['2026-06-17','2026-06-18','2026-06-19','2026-06-22','2026-06-23','2026-06-24','2026-06-25'];
const allAtrRatios = [];

for (const date of DATES) {
  const file = `/tmp/rt_candles_${date.replace(/-/g,'')}.json`;
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  
  const bySymbol = {};
  for (const c of data) {
    if (!bySymbol[c.symbol]) bySymbol[c.symbol] = [];
    bySymbol[c.symbol].push({h: Number(c.high), l: Number(c.low), c: Number(c.close)});
  }
  
  for (const [sym, candles] of Object.entries(bySymbol)) {
    if (candles.length < 8) continue;
    const last7 = candles.slice(-8);
    let atrSum = 0;
    for (let i = 1; i < last7.length; i++) {
      const tr = Math.max(last7[i].h - last7[i].l, Math.abs(last7[i].h - last7[i-1].c), Math.abs(last7[i].l - last7[i-1].c));
      atrSum += tr;
    }
    const atr = atrSum / 7;
    const price = last7[last7.length-1].c;
    if (price > 0) {
      allAtrRatios.push({sym, date, ratio: atr / price, atr, price});
    }
  }
}

const ratios = allAtrRatios.map(r => r.ratio);
ratios.sort((a,b) => a-b);

console.log('ATR率の分布（全銘柄・全日）:');
console.log('  件数:', ratios.length);
console.log('  最小:', (ratios[0]*100).toFixed(4) + '%');
console.log('  25%:', (ratios[Math.floor(ratios.length*0.25)]*100).toFixed(4) + '%');
console.log('  中央値:', (ratios[Math.floor(ratios.length*0.5)]*100).toFixed(4) + '%');
console.log('  75%:', (ratios[Math.floor(ratios.length*0.75)]*100).toFixed(4) + '%');
console.log('  最大:', (ratios[ratios.length-1]*100).toFixed(4) + '%');
console.log('');
console.log('ATR率 × 1.5 → SL幅:');
console.log('  < 0.5%:', ratios.filter(r => r*1.5*100 < 0.5).length);
console.log('  0.5〜1.0%:', ratios.filter(r => r*1.5*100 >= 0.5 && r*1.5*100 < 1.0).length);
console.log('  >= 1.0%:', ratios.filter(r => r*1.5*100 >= 1.0).length);
console.log('');
console.log('ATR率 × 2.5 → SL幅:');
console.log('  < 0.5%:', ratios.filter(r => r*2.5*100 < 0.5).length);
console.log('  0.5〜1.0%:', ratios.filter(r => r*2.5*100 >= 0.5 && r*2.5*100 < 1.0).length);
console.log('  >= 1.0%:', ratios.filter(r => r*2.5*100 >= 1.0).length);
console.log('');
console.log('ATR率 × 3.0 → SL幅:');
console.log('  < 0.5%:', ratios.filter(r => r*3.0*100 < 0.5).length);
console.log('  0.5〜1.0%:', ratios.filter(r => r*3.0*100 >= 0.5 && r*3.0*100 < 1.0).length);
console.log('  >= 1.0%:', ratios.filter(r => r*3.0*100 >= 1.0).length);
console.log('');

// 銘柄別の平均ATR率
const bySymAvg = {};
for (const r of allAtrRatios) {
  if (!bySymAvg[r.sym]) bySymAvg[r.sym] = [];
  bySymAvg[r.sym].push(r.ratio);
}
console.log('銘柄別 平均ATR率（上位10）:');
const sorted = Object.entries(bySymAvg).map(([sym, arr]) => ({sym, avg: arr.reduce((s,v)=>s+v,0)/arr.length})).sort((a,b)=>b.avg-a.avg);
for (const {sym, avg} of sorted.slice(0,10)) {
  console.log(`  ${sym}: ${(avg*100).toFixed(3)}% → SL(×1.5)=${(avg*1.5*100).toFixed(3)}%, SL(×2.5)=${(avg*2.5*100).toFixed(3)}%, SL(×3.0)=${(avg*3.0*100).toFixed(3)}%`);
}
console.log('');
console.log('銘柄別 平均ATR率（下位5）:');
for (const {sym, avg} of sorted.slice(-5)) {
  console.log(`  ${sym}: ${(avg*100).toFixed(3)}% → SL(×1.5)=${(avg*1.5*100).toFixed(3)}%, SL(×2.5)=${(avg*2.5*100).toFixed(3)}%, SL(×3.0)=${(avg*3.0*100).toFixed(3)}%`);
}
