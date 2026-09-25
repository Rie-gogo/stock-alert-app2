# 監視・比較基盤 generation v1

## 目的

現行取引と既存シャドーを変更・停止せず、同一source eventから生じたシグナルを、同じ実行可能価格規約で比較する。

## 固定したentry規約

- generation: `monitoring-comparison-strict-next-depth-v1`
- シグナル判定後、正式`engineSequence`で最初に現れる同一銘柄source eventだけを評価する
- LONGはask側、SHORTはbid側の100株depth VWAPを使う
- 板鮮度はWindows内・cloud内の同一時計区間だけで算出し、5秒以内を必須とする
- source eventはsignal判定完了後にcloudへ到着し、板観測時刻はsignal eventより後でなければならない
- 板欠損、時刻欠損、因果性違反、古い板、100株未満は`unfillable`とする
- `unfillable`後に、後続の有利な板へ選び直さない
- シグナル足終値や次足終値へのfallbackは行わない

## 成績利用規約

- 1分後・3分後・5分後・最終損益は`availableAt`到達前に入口判定へ使用しない
- route不明は`unclassified`として全体損益へ残し、route別比較だけから除外する
- signal quality（100株）と891万円portfolioは別集計とする
- `actual_receipt`と`minute_normalized`は別結果として保持し、一致を要求しない
- 同一strategyVersion・同一source event・同一engineSequence・同一generationのparityだけ100%一致を必須とする

## 安全境界

このgenerationは比較用であり、通常`rt_trades`、OrderBridge、Windows Executor、実注文instructionへ接続しない。現行TP/SL、証拠金配分、正式評価Gate、自動採用・自動停止を変更しない。

## 段階導入

1. 本ファイルと`server/monitoringComparisonContract.ts`で純粋規約を固定する
2. 固定fixtureと期待値で再現性を検証する
3. 専用永続化領域へ接続し、現行・A・Bを同じgenerationで収集する
4. 新しい完全営業日のparityを確認してから正式な前向き評価期間を開始する

段階3まではロジック成績の改善を主張しない。段階4を通過しても、人の承認なしに本番ロジックへ昇格させない。

## ローリング管理表示（285A先行）

`monitoringComparisonTrend.ts`は、現行285Aと既存A/Bシャドーを次の二軸に分けて表示する。

- 成績軸: 各方式が実時に保存した`signal_quality`決済を100株へ正規化し、直近5・10・20営業日と全期間を集計する
- 実行品質軸: 本generationのstrict-next depthで、約定可能率と理論価格からの不利差を集計する

入口価格だけを後から差し替えると、TP/SL・利益保護・時間決済の到達順が元の取引と変わる。このため両軸を混ぜた架空損益は作らない。

「最近改善／悪化」は、監査確定済みの直近5営業日とその前5営業日について、勝率と1取引平均損益を比較する。両方改善なら`improving`、両方悪化なら`deteriorating`、逆方向なら`mixed`、各期間2決済未満なら`insufficient`とする。これは整理表示であり、自動採用・自動停止・正式Gate更新には接続しない。
