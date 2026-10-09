# Bollinger板鮮度修正 — 2026-10-13 受入チェック

## 前提

- 対象は10銘柄、Bollinger方向性shadow 5案、各 `signal_quality` / `capital_constrained` の2評価mode。
- 2026-10-13からの新versionのみを評価対象とする。
  - fixed stop: `v3`
  - SMA20 dynamic: `v5`
  - SMA20 slope: `v3`
  - SMA20 slope + BB幅: `v3`
  - SMA10 slope: `v3`
- 旧50 versionは履歴専用の `stopped`。新規source event、shadow event、tradeは作成しない。
- 新5案は `monitoring` のみ。`eligibleForAdoption=false`、`automaticAdoption=false`、`orderInstructionConnection=false` を維持する。

## Windows relay の事前確認

1. 実機relayを**ファイル全体上書きなし**でバックアップする。
2. relayのファイル名、起動パス、`start_kabu.bat`、タスクスケジューラ、URL、port、watchlist、Secrets、API passwordを変更しない。
3. relayログのversionが `kabu-board-relay-v6.1-board-receive-time` であることを確認する。
4. WebSocket `on_message` ごとに1回取得した `relayObservedAtMs` がboard payloadへ保存されることを確認する。
5. `pushOrderBook` 成功後も、同一immutable board snapshotを通常の `pushCandle` payloadに残すことを確認する。通常endpoint以外への送信、OrderBridge接続はしない。

## 受入観測項目

| 確認項目 | 合格条件 | 記録すべき値 |
|---|---|---|
| 10銘柄のrelay受信時刻 | 各監視銘柄で少なくとも1件以上の `relayObservedAtMs` を含むcanonical source event | 銘柄別 received / missing、firstMs / lastMs |
| 板鮮度拒否の内訳 | `relay_websocket_received_at_ms` だけがentry鮮度評価に使用される | basis不一致、時刻欠落、未来時刻、負値、5秒超、深度不足の件数 |
| CurrentPriceTime分離 | 古い `CurrentPriceTime` でもrelay時計差が0–5,000msならfresh候補として扱われる | `boardSourcePriceTimeMs`、`boardObservedAtMs`、`sourceBoardAgeMs` |
| legacy fail-closed | `relayObservedAtMs` がない旧payloadはBollinger entryを作らない | `boardObservationBasis=legacy_current_price_time` または `unavailable` の拒否件数 |
| 1分足完全性 | 各銘柄の欠損分を明示し、synthetic OHLCを作らない | 銘柄別の欠損minute一覧 |
| shadow queue | pending / in-flight / error が増加・停滞していない | queue backlog、lease、error、watermark |
| 初回発火 | 新versionだけで、5案×2 modeが独立に監査される | strategyVersion、mode、symbol、action、reject/entry/exit理由 |
| 不変条件 | 固定target、SL 1.4%、30分cooldown、次足確認、2 mode分離を維持する | entry / exit decision payload |

## 判定規則

- **fresh**: `boardObservationBasis=relay_websocket_received_at_ms` かつ、Windows同一時計の `relayAssembledAtMs - relayObservedAtMs` が `0..5,000ms`。
- **fail-closed**: 観測時刻欠落、legacy basis、future timestamp、負値、5秒超、または方向別100株板深度不足。
- `CurrentPriceTime`、cloud受信時刻、delivery遅延は監査用途のみ。entry鮮度の再代用は禁止。

## 市場終了後のレビュー

1. 新50 versionがactive registry / 最近傾向 / route catalogに各1（案別）、各2（LONG/SHORT）で存在し、欠落・重複・orphan=0を確認する。
2. 旧50 versionがすべて `stopped` かつactive registry、最近傾向、route selectorから除外されていることを確認する。
3. 通常engine、通常10銘柄ロジック、OrderBridge、Executor、注文instruction、既存raw event、schema/migrationに副作用がないことを確認する。
4. 自動採用・注文接続が行われていないことを再確認する。
