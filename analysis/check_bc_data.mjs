import fs from "fs";

const data = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260625.json", "utf8"));

// 銘柄ごとにBPR変化を追跡
const bySymbol = new Map();
for (const c of data) {
  if (!c.boardSnapshot) continue;
  const snap = typeof c.boardSnapshot === "string" ? JSON.parse(c.boardSnapshot) : c.boardSnapshot;
  if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
  bySymbol.get(c.symbol).push(snap.buyPressureRatio);
}

// 改良案B: BPR変化率で70%以上が同方向になるケースを数える
let uptickCount = 0, downtickCount = 0, neutralCount = 0;
for (const [sym, bprs] of bySymbol.entries()) {
  for (let i = 4; i < bprs.length; i++) {
    const recent = bprs.slice(i - 4, i + 1);
    let up = 0, down = 0;
    for (let j = 1; j < recent.length; j++) {
      const diff = recent[j] - recent[j-1];
      if (diff > 0.03) up++;
      else if (diff < -0.03) down++;
    }
    const total = recent.length - 1;
    if (up / total >= 0.7) uptickCount++;
    else if (down / total >= 0.7) downtickCount++;
    else neutralCount++;
  }
}
console.log("改良案B発動回数:");
console.log("  uptick:", uptickCount);
console.log("  downtick:", downtickCount);
console.log("  neutral:", neutralCount);
console.log("  発動率:", ((uptickCount + downtickCount) / (uptickCount + downtickCount + neutralCount) * 100).toFixed(1) + "%");

// 改良案C: キャンセル/アイスバーグ検出の頻度
let cancelCount = 0, icebergCount = 0;
for (const c of data) {
  if (!c.boardSnapshot) continue;
  const snap = typeof c.boardSnapshot === "string" ? JSON.parse(c.boardSnapshot) : c.boardSnapshot;
  if (snap.askCancelDetected || snap.bidCancelDetected) cancelCount++;
  if (snap.icebergAskDetected || snap.icebergBidDetected) icebergCount++;
}
console.log("");
console.log("改良案C検出回数:");
console.log("  キャンセル検出:", cancelCount, "/", data.length);
console.log("  アイスバーグ検出:", icebergCount, "/", data.length);

// 板読みスコアが閾値(1)未満になるケースを確認
// シミュレーション中にboardReadingScoreが呼ばれるのはエントリー判定時のみ
// → BPR変化が大きいのに発動しない理由を調べる

// BPRの変化幅を確認
console.log("");
console.log("BPR変化幅の統計:");
let diffs = [];
for (const [sym, bprs] of bySymbol.entries()) {
  for (let i = 1; i < bprs.length; i++) {
    diffs.push(bprs[i] - bprs[i-1]);
  }
}
diffs.sort((a, b) => a - b);
console.log("  最小:", diffs[0]?.toFixed(3));
console.log("  25%:", diffs[Math.floor(diffs.length * 0.25)]?.toFixed(3));
console.log("  中央:", diffs[Math.floor(diffs.length * 0.5)]?.toFixed(3));
console.log("  75%:", diffs[Math.floor(diffs.length * 0.75)]?.toFixed(3));
console.log("  最大:", diffs[diffs.length - 1]?.toFixed(3));
console.log("  |diff|>0.03:", diffs.filter(d => Math.abs(d) > 0.03).length, "/", diffs.length);
console.log("  |diff|>0.1:", diffs.filter(d => Math.abs(d) > 0.1).length, "/", diffs.length);

// 問題の核心: シミュレーション中のbprHistoryは最大5件しか保持しない
// しかし同じ銘柄の足が連続で来る保証がない（時刻順ソートなので他銘柄が挟まる）
// → bprHistoryの更新タイミングを確認
console.log("");
console.log("板情報フィールド確認（bestBidSize/bestAskSizeの有無）:");
const sample = typeof data[0].boardSnapshot === "string" ? JSON.parse(data[0].boardSnapshot) : data[0].boardSnapshot;
console.log("  bestBidSize:", sample.bestBidSize);
console.log("  bestAskSize:", sample.bestAskSize);
console.log("  totalBidQty:", sample.totalBidQty);
console.log("  totalAskQty:", sample.totalAskQty);
