# Technical Shadow V2 参考再生の再現手順

## 目的

この手順は、2026-10-04に得た「30営業日・10銘柄／8銘柄」の参考検証を、Manusを含む別環境で同じコードから再現するためのものです。

この参考再生は、正式な未見成績ではありません。公開 `getRtCandles` の保存済み1分足からD-1特徴量を組み立て、板がないため次の1分足始値を実行価格proxyとして使います。本番候補エンジンの厳格監査とは別の検証です。

## 2つの結果を混ぜない

1. **厳格監査**: 保存済みprovenance、325分coverage、raw depthなどを要求する。本番採否の安全確認に使う。不足時は `no_trade` が正しい。
2. **参考再生**: 保存済み1分足から特徴量を再構成し、次足始値proxyで傾向を見る。正式成績・採用判定には使わない。

厳格監査が0件でも、参考再生の116件と矛盾しません。入力資格と目的が異なります。

## 固定実装

- `server/technicalAnalysisShadowV2.ts`
- `server/technicalRegimeShadow.ts`
- `server/technicalRegimeShadowEngine.ts`
- `analysis/replayTechnicalShadowV2Last5.ts`
- `analysis/summarizeTechnicalShadowTpPolicies.ts`
- `analysis/validateTechnicalShadowV2ReferenceBaseline.ts`

本番コードを似たロジックで再実装せず、このリポジトリ内のexportを直接呼び出します。

## 実行コマンド

```bash
pnpm exec tsx analysis/replayTechnicalShadowV2Last5.ts 30 2026-07-20 2026-10-02 all10 compare-targets
pnpm exec tsx analysis/summarizeTechnicalShadowTpPolicies.ts \
  analysis/technical-shadow-v2-last30-20260818-20261002-compare-targets.json \
  analysis/technical-shadow-v2-tp-policy-summary-eight-symbols-last30.json
pnpm exec tsx analysis/validateTechnicalShadowV2ReferenceBaseline.ts \
  analysis/technical-shadow-v2-last30-20260818-20261002-compare-targets.json \
  analysis/technical-shadow-v2-tp-policy-summary-eight-symbols-last30.json
```

最終コマンドが `exact_reference_match` を返せば、対象日、シグナル、売買、TP反実仮想の主要値が以前の参考検証と一致しています。

## 期待値の要点

8銘柄（285A・5803除外）、全entry、100株固定、30営業日：

| TP方針 | 件数 | 勝敗分 | 勝率 | 損益 |
|---|---:|---:|---:|---:|
| raw技術水準 | 116 | 76勝39敗1分 | 65.52% | -84,151円 |
| 呼値丸め | 116 | 76勝39敗1分 | 65.52% | -77,611円 |
| 最低0.5R | 116 | 52勝61敗3分 | 44.83% | -63,461円 |
| 最低0.8R | 116 | 48勝64敗4分 | 41.38% | +44,739円 |
| 最低1.0R | 116 | 47勝64敗5分 | 40.52% | +15,739円 |
| 最低1.2R | 116 | 41勝64敗11分 | 35.34% | -13,611円 |
| 次の技術水準 | 116 | 56勝56敗4分 | 48.28% | -88,261円 |

## 不一致時の扱い

- 数値を合わせるために条件を変更しない。
- APIの対象日、銘柄別足数、OHLCVを先に比較する。
- `reference_mismatch` は本番不具合とは断定せず、保存データが後から訂正・補完された可能性を分離して報告する。
- 結果をformal Gate、通常取引、OrderBridge、Executorへ接続しない。
