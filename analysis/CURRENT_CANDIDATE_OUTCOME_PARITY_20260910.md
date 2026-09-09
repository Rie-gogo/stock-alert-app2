# 現行と100株仮想の結果差監査（2026-09-10）

## 目的

同じ現行候補について、実時の現行DRY_RUNと、証拠金制限なし100株仮想取引の出口結果が最初にどこで分かれたかを日次で固定する。

この監査は診断専用であり、次を変更しない。

- `realtimeSimEngine.ts` の入口・出口・TP/SL・証拠金配分
- 現行DRY_RUN取引と損益計算
- 既存シャドー案の受信、状態、仮想取引
- source event / decision / candidate outbox の受信経路
- 正式評価Gate
- Windows Executor、OrderBridge、実注文経路

## 固定した基準

- 作業開始時の `origin/main`: `882837597d0fec8e5cdbdcc9cc424ae8a19fe8bc`
- candidate version: `current-10-symbol-candidates-v1`
- virtual engine version: `current-10-symbol-signal-quality-v1`
- comparison version: `current-vs-signal-quality-outcome-v1`

比較対象は `realtimeDecision=accepted` の候補だけとする。証拠金ブロック候補には実時ポジションがないため、この結果一致率からは除外する。ただし、ブロック候補は従来どおり全シグナル台帳と100株仮想成績に残す。

## 比較項目

可変株数の現行損益を100株へ換算し、同じ候補の仮想取引と次を比較する。

1. 勝ち・負け・引き分け
2. 決済source event
3. 決済時刻
4. 決済価格
5. 決済理由の分類
6. 100株換算損益

未決済、actual entry欠損、virtual trade欠損は不一致に混ぜず `incomplete` として隔離する。最初の `mismatch` はcandidateの `engineSequence` 順で保存する。

## 既知の回帰証拠

2026-09-08に報告済みの次の差を、純粋関数テストで固定した。

| 銘柄・経路 | 現行100株換算 | 100株仮想 | 判定 |
|---|---:|---:|---|
| 285A `trendLong` | +39,000円 | -4,000円 | outcome mismatch |
| 5803 `highFadeBreakShort` | +7,963.6円 | -1,500円 | outcome mismatch |

これは実データの再取得テストではなく、既知差分が監査器で見落とされないことを固定する回帰テストである。本番DBでの再集計は日次finality成立後に別途確認する。

## 実行位置と安全性

比較は営業中の受信処理ではなく、15:31 JST以降、source・decision・candidate outbox・shadow outbox・gapがすべて閉じた日次監査マテリアライザーで実行する。

既存の891万円portfolioと8035 parityが完成した後に、一回のheartbeatでこの比較だけを保存し、その回ではforward replay以降へ進まない。したがって営業中の現行運用やシャドー検証を待たせない。

## この段階で分かること／まだ分からないこと

この段階では、同じ候補の最終結果がどの出口イベントで分かれたかを特定できる。一方、入口判定前の全内部状態を10銘柄すべて純粋再生しているわけではないため、同一イベント・同一状態の100% parity完成ではない。

次段階では、記録された最初の差を起点に、現行と仮想で共有できる純粋な出口評価器を作り、シグナル反転、gap約定、時間決済、板早期利確の優先順位を同じ入力で項目別に一致させる。
