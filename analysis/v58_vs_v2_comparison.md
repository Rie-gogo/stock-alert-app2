# kabu_board_relay_v5_8.py vs kabu_order_executor_v2.py 比較メモ

## 重要な発見

### 1. v5.8は既にexecutor機能を統合済み
- v5.8 = board relay + executor が1つのファイルに統合されている
- executorは別スレッド（executor_polling_loop）で1秒間隔ポーリング
- kabu_order_executor_v2.py は別プロセスとして設計 → 競合する

### 2. tRPC通信形式
- v5.8: `{"json": input_data}` 形式（superjson対応済み）
- v2: `{"json": input_data}` 形式（同じ）
- v5.8のsend_candle_with_board: `json={"json": payload}` 形式

### 3. フィールド名の違い
- v5.8: `instruction["side"]`, `instruction["instructionType"]`
- v2: `instruction["oi_side"]`, `instruction["oi_instruction_type"]`
- ★v2のフィールド名はクラウドのorderBridge.tsと不整合の可能性あり

### 4. v5.8に無くてv2にある機能（第1段階5項目）
- ❌ 起動時建玉同期（/positions）
- ❌ 約定確認ループ（/orders照会）
- ❌ クラウド通信断検知（last_cloud_success_at）
- ❌ ローカル大引け強制決済（15:25〜15:29）
- ❌ バックオフ短縮（ポジション保有中2秒）

### 5. v5.8にあってv2にない機能
- ✅ board relay（WebSocket + RESTフォールバック）
- ✅ 1分足ポーリング＋クラウド送信
- ✅ 板情報分析（大口壁、アイスバーグ、キャンセル検出）
- ✅ WebSocket自動復旧
- ✅ 夜間省電力待機
- ✅ 15:35自動終了（毎日クリーンスタート）
- ✅ 共有トークン管理（全スレッドで1つのトークン）
- ✅ 401時のロック付き再取得

### 6. 結論
v2を別プロセスとして使うのではなく、v5.8のexecutor部分に第1段階5項目を追加するのが正解。
v2を使うと、board relayとexecutorが別プロセスになり、v5.8の統合設計が崩れる。
