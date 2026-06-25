import fs from 'fs';

// 6/17のデータで sim_bc_only.ts と sweep_atr_sl_fast.ts の差を確認
// sim_bc_only.ts では取引8回だったのに、sweep版では0回

// データ読み込み
const data = JSON.parse(fs.readFileSync('/tmp/rt_candles_20260617.json', 'utf8'));
console.log('Total rows:', data.length);

// ALLOWED_SYMBOLS確認
const TARGET_STOCKS_FILE = fs.readFileSync('/home/ubuntu/stock-alert-app/shared/stocks.ts', 'utf8');
const symbolMatches = TARGET_STOCKS_FILE.match(/symbol:\s*"(\d+[A-Z]?)"/g);
const symbols = symbolMatches ? symbolMatches.map(m => m.match(/"([^"]+)"/)[1]) : [];
console.log('TARGET_STOCKS symbols:', symbols);

const dataSymbols = [...new Set(data.map(c => c.symbol))];
console.log('Data symbols:', dataSymbols);

const allowed = new Set(symbols);
const filtered = data.filter(c => allowed.has(c.symbol));
console.log('After ALLOWED filter:', filtered.length);

// 昼休みフィルター
const noLunch = filtered.filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"));
console.log('After lunch filter:', noLunch.length);

// 09:30以降
const after930 = noLunch.filter(c => c.candleTime >= "09:30");
console.log('After 09:30:', after930.length);

// MIN_CANDLES_FOR_SIGNAL = 30 → 各銘柄で30本以上蓄積後にシグナル検出
// 09:30以降で30本目は09:30 + 30分 = 10:00頃
// 銘柄ごとの足数を確認
const bySym = {};
for (const c of noLunch) {
  if (!bySym[c.symbol]) bySym[c.symbol] = 0;
  bySym[c.symbol]++;
}
console.log('Candles per symbol:', Object.entries(bySym).map(([s,n]) => `${s}:${n}`).join(', '));
