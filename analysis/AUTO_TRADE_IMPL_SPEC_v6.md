# 自動売買実装仕様書 v6（最終確定版）

## 概要

kabu_board_relay_v5.9.2をベースに、逆指値SL・競合制御・状態管理を追加する。
既存の安全機能は全て維持。

## ステートマシン（10状態）

```
NO_POSITION → ENTRY_SENT → ENTRY_FILLED → SL_SENT → POSITION_ACTIVE
                                                   ↘ UNPROTECTED_POSITION
POSITION_ACTIVE → EXIT_REQUESTED → EXIT_SENT → EXIT_FILLED → NO_POSITION
任意状態 → ERROR_STOP
```

## エントリー後の逆指値SL

- FrontOrderType = 30
- LONG: TriggerPrice=SL価格, UnderOver=1, AfterHitOrderType=1, AfterHitPrice=0
- SHORT: TriggerPrice=SL価格, UnderOver=2, AfterHitOrderType=1, AfterHitPrice=0
- SL注文IDを銘柄ごとの状態に保存

## TP/EOD/EXIT時の競合制御

```
POSITION_ACTIVE → EXIT_REQUESTED
→ SL逆指値取消要求
→ /ordersで取消完了確認
→ /positionsで実建玉確認
→ 建玉残っていれば成行返済 → EXIT_SENT
→ /ordersで返済約定確認
→ /positionsで建玉0確認
→ EXIT_FILLED → NO_POSITION
```

## sendorderタイムアウト処理

- 即失敗扱い禁止、即再発注禁止
- 現ステート維持 → /orders確認 → 結果確定後に遷移
- /orders確認不能が継続 → ERROR_STOP

## UNPROTECTED_POSITION

- SL設置確認できない場合に遷移
- 全銘柄の新規ENTRY停止
- /ordersでSL確認 → あれば復帰 / なければ即時返済 / 確認不能→ERROR_STOP
- SL即再発注は禁止

## LIVE/SIMULATION管理

```python
LIVE_TRADE_SYMBOLS = {"8035"}
execution_mode = "LIVE" if (not DRY_RUN and symbol in LIVE_TRADE_SYMBOLS) else "SIMULATION"
```

- 各注文・ポジションにexecutionModeを保持
- SIMULATION注文はkabuステーションAPIへ実注文を送信しない
- 大引け強制決済: LIVE→実返済、SIMULATION→仮想決済のみ

## /positions同期

- 実建玉を全て確認し、アプリ管理LIVE建玉と照合
- SIMULATION建玉を実建玉として扱わない
- アプリ管理外の想定外実建玉 → 警告またはERROR_STOP

## NO_POSITION遷移条件

- 返済注文受付だけでは遷移しない
- /ordersで返済約定確認 + /positionsで建玉0確認 → NO_POSITION

## 発注APIレート制御

- 発注系5件/秒未満（/sendorder, /cancelorder）
- 共通レートリミッターまたは注文キュー

## 既存安全機能（全て維持）

- 成行発注、約定確認ループ、起動時建玉同期、大引け強制決済
- クラウド通信断時の新規ENTRY停止、日次損失上限
- プリフライトチェック、二重発注防止、注文照会失敗時二重返済防止
- HTTPセッション4系統分離、401時トークン再取得、DRY_RUN

## テスト方針

1. DRY_RUN=Trueで全異常系テスト
2. DRY_RUN=False, LIVE_TRADE_SYMBOLS={"8035"} で100株1銘柄テスト
3. 段階的にLIVE_TRADE_SYMBOLSを拡大

## KABUステーションAPI仕様メモ

- 発注: POST /sendorder (FrontOrderType: 10=成行, 30=逆指値)
- 取消: PUT /cancelorder (OrderId指定)
- 注文照会: GET /orders (product=0)
- 建玉照会: GET /positions (product=2=信用)
- 取引余力: GET /wallet/margin
- トークン: POST /token (早朝強制ログアウトで無効化)
- 流量制限: 発注系5件/秒、情報系10件/秒
- 逆指値ReverseLimitOrder: TriggerSec, TriggerPrice, UnderOver(1=以下,2=以上), AfterHitOrderType(1=成行), AfterHitPrice
- 信用デイトレ: MarginTradeType=3, CashMargin=2(新規)/3(返済)
- 市場: Exchange=27(東証+)
