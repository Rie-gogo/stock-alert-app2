# 他AI依頼用：現行テクニカル分析シャドー同一ロジック検証

Stock Alert App の既存プロジェクト `ULXu9jPfJKpbGaXVVcZcJZ` を対象に、現在実装されているテクニカル分析シャドーを**再実装せず、既存の本体関数を直接呼び出して**読み取り専用で再検証してください。

今回は調査・再生・報告だけです。コード、DB、Secrets、GitHub、strategy lifecycle、Manus checkpoint、公開環境、既存シャドー、通知、schedule、formal Gate、OrderBridge、Executor、注文instructionを変更しないでください。Manusの新規プロジェクト・新規公開URLも作成しないでください。

## 1. 最初に同一ロジックを固定する

検証前に、次のファイルを読み、既存exportを直接使用してください。

- `server/technicalAnalysisShadowV2.ts`
- `server/technicalRegimeShadow.ts`
- `server/technicalRegimeShadowEngine.ts`
- `server/runtimeIdentity.ts`

対象versionは次です。

- analysis version: `technical-analysis-shadow-v2`
- strategy versions: `candidate-<symbol>-technical-regime-a-v2-complete-technical`
- 対象銘柄: `285A, 3436, 5803, 6146, 6526, 6857, 6976, 6981, 8035, 9984`

依頼作成時点の主要3ファイルのSHA-256は次です。

| ファイル | SHA-256 |
|---|---|
| `technicalAnalysisShadowV2.ts` | `9DACB1A0963387F1725547D7B17292132BF1051FAB6B831C00D1E4C6765F1FD9` |
| `technicalRegimeShadow.ts` | `91C5E0352DDC3F510F34CB5284DD280293FBD8BD879614B5AA3F54F8214CDF1A` |
| `technicalRegimeShadowEngine.ts` | `E2A38263B2D043EF75600EE1549E5026B2206B1048B2EB27C0DFDA1664AB9672` |

改行コード差だけなら正規化後のdiffも確認してください。実質的な内容が異なる場合は、勝手に似たロジックを作らず、そこで停止して差分・現在のGit commit・Manus checkpoint・公開revision・`sourceTreeHash`を報告してください。

Git HEADだけで同一版と断定しないでください。対象ファイルに未commit差分がある可能性があるため、ファイル内容・strategyVersion・runtime identityを併せて固定してください。

## 2. 絶対条件：本体エンジンを直接使用する

独自にMA/VWAP/ATR/BBロジックを書き直してはいけません。最低限、次の既存関数・state transitionを直接利用してください。

- `calculateTechnicalIndicators`
- `buildTechnicalAnalysisSnapshot`
- `buildTechnicalRegimePlan`
- `createEmptyTechnicalRegimeShadowState`
- `applyTechnicalRegimeShadowTransition`

次の現行仕様を変更しないでください。

- D-1までの日足・時間足特徴量を当日開始前に固定
- 当日は確定済み1分足・5分足だけを順番に追加
- シグナル足と同じイベントではエントリーしない
- 次の同一銘柄source eventで方向別100株depthを確認
- 板時刻の因果性・5秒鮮度・100株depthを現行どおり判定
- 一日一回枠、pending、再探索、重複排除、状態遷移を現行どおり維持
- LONGはask、SHORTはbid
- 現行stop、break-even、反対confirmed signal、SMA21＋MACD、15:20終了を維持
- 同一足でSLとTPが成立する場合はSL優先
- 未来足、当日最終出来高、後続イベントを入口判定へ混入しない

既存関数を呼び出せない場合は「同一ロジック検証不能」と報告し、近似ロジックの結果を現行成績として提示しないでください。

## 3. データを二つの母集団へ分離する

保存KABU Stationデータだけを使い、外部株価や前値補完を行わないでください。

### A. raw source event厳格母集団

- generation、sourceEventId、engineSequence、受信順が確定できること
- 入力時点で利用可能だった板、板観測時刻、relay送信時刻、cloud受信時刻を使うこと
- terminal gap、因果性違反、重複、時刻逆転、未完了coverageは正式集計から除外し、件数と理由を別表にすること
- raw depthがないイベントは `not_evaluable` とし、人工的な板を作らないこと

### B. 保存1分OHLC参考母集団

- raw depthがない場合の参考診断専用
- 次の連続した同一銘柄1分足openを明示的なproxyとして使うこと
- raw source event成績と混ぜないこと
- 「実行可能損益」ではなく「OHLC proxy参考損益」と明記すること

日全体の完全性と、各取引に必要なlookback開始から決済・最大保有終了までの**取引区間完全性**を別々に判定してください。引け付近の無関係な欠損だけで午前中の完全な取引を捨てた場合は、その件数も感度分析として示してください。

## 4. 対象期間と分割

利用可能な最新データまでを対象に、最低でも次を出してください。

1. 全保存期間
2. 直近30完全営業日
3. 直近20完全営業日
4. 直近10完全営業日
5. 直近5完全営業日
6. 直近30日を前半15日／後半15日に固定分割
7. 可能なら最古側の未使用5日を、選定に使わない参考holdoutとして分離

各期間について、10銘柄全体と、`285A`・`5803`を除いた8銘柄を別集計してください。日数不足の場合は不足を隠さず、無理に20日・30日と呼ばないでください。

## 5. まず現行baselineを一切変更せず再生する

次を保存・集計してください。

- candidate/signal件数
- entry accepted / rejected / not_evaluable
- rejection reason別件数
- 決済件数、未決済件数
- 勝・負・分、勝率、100株損益
- 可変株数参考損益（現行の株数計算を使う）
- gross profit / gross loss / PF / 平均損益 / 平均R / 最大DD
- signal type、route、方向、銘柄、時間帯、日付別
- exit reason別件数・損益
- TP、SL、reward/risk、保有時間、MFE、MAE
- actual_receipt順とminute_normalized順は別集計。両者に同じportfolio損益を要求しない

## 6. 約定悪化は3段階で分離する

入口・SL・TP・シグナル発火は固定し、同じ取引集合に対して次を比較してください。

| ケース | 入口 | 出口 |
|---|---:|---:|
| S0 | 悪化なし | 悪化なし |
| S05 | 0.05%不利 | 0.05%不利 |
| S10 | 0.10%不利 | 0.10%不利 |

LONGは入口を高く・出口を低く、SHORTは入口を低く・出口を高くしてください。悪化後価格はJPXの現行呼値へ、常に不利になる方向へ丸めてください。

価格悪化によってブレイク維持、stopの有効性、target候補、entry acceptanceまで変わる実行時再評価版と、取引集合を固定して損益だけ悪化させる感度分析版を分けてください。

## 7. TP反実仮想は入口を固定して比較する

TPだけの影響を分けるため、現行baselineでacceptedになった同じ入口集合・同じSLに対して、次を再生してください。

1. 現行の最寄りテクニカル価格（raw）
2. 現行の最寄りテクニカル価格を正しいJPX呼値へ丸める
3. 最低0.5R
4. 最低0.8R
5. 最低1.0R
6. 最低1.2R
7. 次の有効テクニカル水準

最低Rを満たす既存テクニカル候補がない場合、次を分けてください。

- `candidate_only`: 見送り
- `synthetic_fixed_r`: 固定R価格を作る参考診断

両者を同じ結果へ混ぜないでください。TP候補には、支持抵抗線、前日高安、BB中央・上限・下限、1.2R、2Rなどの**候補種別ラベル**を残してください。数値だけへ潰さないでください。

TP変更後も、反対confirmed signal、SMA21＋MACD、break-even、日次終了、SL優先を含む全イベントを最後まで再生してください。単純に将来高値・安値がTPへ触れたかだけで勝敗を決めないでください。

## 8. 参考照合値

以下は公開OHLC proxyを使った別環境の参考値です。raw source event厳格母集団とは件数が異なって構いません。数値を合わせるために条件を変更せず、差があれば最初の不一致イベントから理由を説明してください。

### 8銘柄・直近30完全営業日・100株・現行完成版の参考

| TP方式 | 取引 | 勝率 | 損益 |
|---|---:|---:|---:|
| 現行raw | 116 | 65.52% | -84,151円 |
| 現行＋呼値proxy丸め | 116 | 65.52% | -77,611円 |
| 最低0.5R | 116 | 44.83% | -63,461円 |
| 最低0.8R | 116 | 41.38% | +44,739円 |
| 最低1.0R | 116 | 40.52% | +15,739円 |
| 最低1.2R | 116 | 35.34% | -13,611円 |
| 次のテクニカル水準 | 116 | 48.28% | -88,261円 |

この参考値は正式前向き成績ではありません。また、以前の旧世代結果である123件／候補24件と混ぜないでください。

## 9. 採否判定を三つに分ける

各銘柄・各route・各TP方式を、必ず次のいずれかへ分類してください。

1. `rejected_exact_spec`: 十分な評価可能件数があり、固定仕様が明確に負
2. `insufficient_data`: 品質通過日・評価可能件数が不足
3. `monitoring_only`: 正式採用根拠はないが、前向き観測を続ける価値がある

データ不足を「負けたため不採用」と表現しないでください。全10銘柄を一括で採否せず、少なくともroute別に判定してください。

## 10. 必須成果物

結果の要約だけでなく、再現可能な成果物を既存プロジェクト内の一時的なanalysis領域へ保存してください。

- 読み取り専用評価スクリプト
- 対象ファイルhash・Git commit・checkpoint・runtime identity
- データ品質レポート
- 全取引一覧CSV
- 全candidate/rejection/not_evaluable一覧CSV
- 集計JSON
- 人が読めるMarkdown報告書
- 入力範囲、件数、出力ファイルのSHA-256
- 最初のbaseline不一致イベントと原因

絶対パスだけを報告して終わらず、ユーザーがダウンロード又は確認できる形で提示してください。

## 11. 完了条件

完了は次をすべて満たした場合だけです。

- 現行本体関数を直接使ったことをコード上で確認済み
- 対象版のhashを記録済み
- raw厳格母集団とOHLC proxy母集団を分離済み
- S0/S05/S10を分離済み
- TP比較で入口・SLを固定済み
- 期間別・銘柄別・route別・exit reason別集計済み
- 成果物が再読可能
- コード、DB、GitHub、Manus公開環境、既存シャドー、formal Gate、注文経路を変更していない

最後に、現在のテクニカル分析シャドーについて、次を明確に回答してください。

1. 現行仕様をそのまま監視継続できるか
2. 呼値丸めだけは修正候補にすべきか
3. 全経路共通のTP変更が妥当か、route別が妥当か
4. 損益悪化の主因が入口、TP、SL、反対シグナル決済、SMA21＋MACD決済、約定悪化のどれか
5. 正式採用ではなく `monitoring_only` を維持すべきか

