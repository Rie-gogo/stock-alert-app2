# P0監査基盤復旧・増分化 設計

## 不変条件

- `realtimeSimEngine.ts`、既存strategyVersion、売買条件、DRY_RUN/LIVE Gate、通常`rt_trades`、OrderBridge、Executor、relay order経路を変更しない。
- 復旧は`rt_realtime_decision_events.candidate_virtual_input_json`だけを入力とし、現行売買エンジンを再実行しない。
- 2026-09-07はcollection/validation扱いのまま正式評価から除外する。
- 新しい実行可能価格版のstrategyVersion追加は、本P0復旧・parity・materialization正常化後の別工程とする。

## outbox state machine

既存の行全体statusに加え、candidate/virtualを独立phaseとして保存する。

| Phase status | 意味 |
|---|---|
| `pending` | 未処理 |
| `processing` | lease取得済み |
| `complete` | DB更新完了 |
| `retryable_error` | 再試行可能 |
| `terminal_error` | 復旧不能。gapとして日次不適格 |
| `not_applicable` | 当該eventでcandidate作成が不要 |

行全体statusは`pending / processing / processed / error / terminal`とし、candidateとvirtualの両phaseが`complete`または`not_applicable`なら`processed`とする。terminal phaseが1つでもあれば行全体を`terminal`とし、後続処理は許可するがそのtrade dateを正式評価不適格にする。

## structured candidate descriptor

新規eventは判断時点で次をpayloadと列へ固定する。

- applicable
- side
- routeId
- signalReason
- capitalShares
- requiredMargin
- realtimeDecision
- routeSpec

既存9月7日payloadだけは、descriptor不在時に`latestTrade.side`、`decisionSignal.action`、`rawSignal.type`の順で復元する。日本語理由中のLONG/SHORTはside authorityにしない。

## worker

- リアルタイム受信はoutbox insertまでで返し、drainしない。
- `/api/scheduled/candidate-virtual-worker`を独立登録する。
- 1runは最大100行、最大20秒、1つのglobal worker leaseで並列実行を禁止する。
- 最小未完了idからengineSequence順に処理する。
- 最大試行済み行はterminal化してgapを保存し、後続へ進む。
- heartbeatは2分ごとに実行する。22銘柄×2分を上回る100行上限で通常受信に追従し、9月7日backlogも約49runで解消可能とする。

## migration backfill

- 行全体`processed`はcandidate/virtual両phaseを`complete`として移行する。
- `pending`は両phase`pending`。
- `processing/error`はcandidate実在をDB照合し、candidateがあればcandidate phase=`complete`、なければ`pending`。virtual phaseは必ず`pending`から保存payloadで再開する。
- 10:35 poison rowはcandidate不存在、rawSignal=`sell`のためcandidate=`pending`、virtual=`pending`。
- phaseは各DB更新成功後だけ`complete`にする。

## parity

- realtime exit routeIdは`stateBefore.positions`の対象symbolの`entryReason`から引き継ぐ。
- 8035 parityは11:30～12:29をstate mutation前にskipする。
- 合格条件はaction、position、routeId、symbolCandleCountの差がすべて0。

## formal evaluation

永続controlに`activationCheckpointId`、`activatedAtUtc`、`formalStartTradeDate`、`excludedTradeDates`を保存する。初期値は未有効、2026-09-07除外。formal metricsはactivatedかつstart date以降かつ除外日でないtradeだけ、collection metricsは別表示する。

## portfolio materialization

`actual_receipt`と`minute_normalized`を別progressで管理し、結果一致は要求しない。共通の合格条件は元source件数、対象範囲、最終処理位置、欠損0。各方式は自身の順序規則へ内部整合することを確認する。

progressにはversion/date/mode、processedThroughEngineSequence、sourceDecisionCount、openAllocations、marginUsed、dirtyFromEngineSequence、status、generatedAt、errorを保存する。minute bucketは次分受信だけでなく、その分以前のoutbox未完了0で閉じる。

## 16時処理

candidate/virtual worker、portfolio materializer、parity/replay materializer、report formatterを分離する。16時reportは保存済みmaterializationだけを読み、未完了を0件として表示しない。旧CB/branch/score0 simulationはreport requestから分離する。
