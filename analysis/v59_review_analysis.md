# v5.9 レビュー精査結果

## 指摘1: 起動時建玉同期がトークン取得前に実行される
**判定: 妥当（最優先修正）**

main()の起動順序:
1. candle_thread起動
2. executor_thread起動 ← ここで即座にexecutor_sync_positions_on_startup()が呼ばれる
3. main whileループ → is_market_open()チェック → register_push_with_retry() でトークン取得

executorスレッドが先に動き出すため、get_current_token()がNoneを返し、
executor_get_positions()が「トークン未取得」で空リスト返却 → 建玉同期が空振り。

**修正方針**: executor_polling_loop()冒頭でトークン取得を待機する。
```python
executor_log("トークン取得を待機中...")
while not get_current_token():
    time.sleep(1)
executor_active_positions = executor_sync_positions_on_startup()
```

## 指摘2: 夜間起動でexecutorスレッドが終了し翌朝復活しない
**判定: 妥当（最優先修正）**

executor_polling_loop()で `current_time > EXECUTOR_TRADING_END` → `return` でスレッド終了。
main()は夜間sleepして翌朝継続するが、executorスレッドは再作成されない。

ただし、v5.8のmain()設計では15:35以降にsys.exit(0)でプロセスごと終了する。
タスクスケジューラで毎朝起動する運用なら問題ないが、万が一夜間起動した場合のエッジケース。

**修正方針**: executorスレッドを終了させず、日付変更検知で日次リセット+待機。

## 指摘3: 約定照会がlocal_session_lockを占有し板取得を阻害
**判定: 妥当（高優先度）**

/board, /sendorder, /orders, /positions が全て同一の local_session + local_session_lock を使用。
約定確認ループは最大30秒×1秒間隔で/ordersを呼ぶ。各呼び出しはtimeout=10秒。
板取得（fetch_board_from_api）も同じロックを使うため、約定確認中に板取得がブロックされる。

実際には各リクエストは数十ms〜数百msで完了するため、ロック保持時間は短い。
しかし、KABUステーション側が遅延した場合のリスクは確かに存在する。

**修正方針**: ローカルセッションを2系統に分離:
- board_session + board_session_lock: /board 専用
- trade_session + trade_session_lock: /sendorder, /orders, /positions 用

## 指摘4: 15:25の強制決済がメモリ状態で入口判定される
**判定: 妥当（高優先度）**

executor_polling_loop()で:
```python
if executor_active_positions:
    executor_local_force_close()
else:
    executor_log("建玉なし。スキップ。")
```

executor_active_positionsが空でも実建玉がある可能性（起動時同期失敗、手動発注等）。
executor_local_force_close()内部では/positionsを呼ぶが、入口で弾かれると呼ばれない。

**修正方針**: メモリ状態に関係なく必ずexecutor_local_force_close()を呼ぶ。

## 指摘5: API照会失敗と0件を区別できない
**判定: 妥当（高優先度）**

executor_get_positions()は:
- 成功+建玉なし → []
- トークン未取得 → []
- HTTPエラー → []
- 例外 → []

全て同じ[]を返すため、呼び出し側で「照会失敗」と「建玉なし」を区別できない。
特に強制決済時に照会失敗を「建玉なし」と誤判定するリスクがある。

**修正方針**: 失敗時はNoneを返し、呼び出し側でNoneチェック。

## 追加指摘: クラウドセッション分離
**判定: 妥当（中優先度）**

cloud_session_lockを1分足送信とexecutor tRPC通信が共有。
executor側のtRPC呼び出しがタイムアウトすると1分足送信がブロックされる。

**修正方針**: executor専用のクラウドセッションを作成。

## 追加指摘: 部分約定時のポジション管理
**判定: 妥当だが100株運用では低リスク**

exit/force_closeで部分約定時にdel executor_active_positions[symbol]で全削除。
100株単位の成行注文では部分約定はほぼ発生しないが、理論上のリスクはある。

**修正方針**: 今回は注意コメントのみ追加。本番前に対応。

## 修正対象サマリー

1. トークン待機追加（executor_polling_loop冒頭）
2. executorスレッド終了→待機に変更（日付変更検知）
3. ローカルセッション2系統分離（board用/trade用）
4. クラウドセッション2系統分離（candle用/executor用）
5. 15:25強制決済の入口条件削除（常に呼ぶ）
6. executor_get_positions/orders の戻り値分離（None=失敗, []=0件）
7. 起動時建玉同期のNoneチェック追加
8. executor_local_force_close内のNoneチェック追加
