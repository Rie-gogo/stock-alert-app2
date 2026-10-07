# Windows relay v6.0 — 手動配備チェックリスト

> **対象**: `scripts/kabu_board_relay.py` と同ディレクトリの新規 `scripts/relay_delivery_spool.py`。
>
> **重要**: クラウドのGitHub同期・checkpoint・公開は、Windows実機を変更しません。Windows側の既存relayをファイル全体で上書きする前に、下記を実機の管理者が実施してください。秘密値・token・URL・既存watchlist設定を手順書やログに貼り付けないでください。

## 配備前（10/08 08:30 JST以前）

1. Windows実機上で、現在稼働しているrelayのディレクトリとPython環境を確認する。既存relayとoutbox DBをバックアップする（資格情報を含む設定ファイルは共有・コミットしない）。
2. リリース物から **2ファイルのみ** を同じディレクトリへ配置する。
   - `kabu_board_relay.py`
   - `relay_delivery_spool.py`
3. 実機上でSHA-256を確認する。
   - `kabu_board_relay.py`: `940b25c378b23ad24e213d949b8d530b3fdc2e955d300e48e40a2122dc880c42`
   - `relay_delivery_spool.py`: `8a8a62bd30d621061dbd909c34fba3e04eaf274ce7609fa9403d902c08746e9d`
4. Windowsのrelay設定（API port、認証、cloud endpoint、監視銘柄）を既存の実機設定に照合する。**クラウド側の値を推測して移植しない**。
5. `websocket-client` と `requests` が、実際にrelayを起動するPython環境で利用可能か確認する。
   ```powershell
   python -c "import requests, websocket; print('dependencies_ok')"
   python -m py_compile .\kabu_board_relay.py .\relay_delivery_spool.py
   ```

## 起動と開始証跡

1. market open前に既存プロセスを停止し、同じ作業ディレクトリから新relayを起動する。
2. ログに次の意味の起動証跡があることを確認する。
   - `kabu-board-relay-v6.0-durable-fifo`
   - `provenance: relayVersion=... / relaySourceTreeHash=...`（hashが未設定の場合は `unavailable` のままにし、値を作らない）
   - `delivery: SQLite FIFO outbox / HTTP 200 ACK only / no candle leapfrogging`
   - `1分足FIFO送信worker起動完了`
3. SQLite outboxはrelay作業ディレクトリの `kabu_relay_candle_outbox.sqlite3`（環境変数で別パスにした場合はそのパス）に作成される。**削除・初期化しない**。未ACK先頭から再送するための永続キューである。

## 場中の受入確認

- `09:00` から通常10銘柄について、`1分足outbox追加` と後続の `1分足ACK` がsource event順で出ること。
- HTTP失敗時は `1分足未ACK。FIFO先頭を再送` が出て、後続minuteを追い越さないこと。
- 複数分の確定WebSocket bucketがscheduler遅延をまたいでもoutboxに入ること。
- WebSocket実測が無いminuteは `1分足実測bucket欠損（OHLC非生成）` と記録され、RESTの現在値から過去OHLCを作らないこと。
- `valueSource=ws_aggregated`、`rest_fallback`、`buffer_reuse`等のprovenanceをクラウドで偽装しないこと。
- アプリの「relay・Bollinger診断」を手動更新し、通常10銘柄の受信件数、固定セッション欠損、relay→cloud遅延、shadow queue backlog、Bollingerのvariant×mode状態を確認する。

## 異常時のロールバック

1. relayを停止する。
2. outbox SQLiteを**削除せず**バックアップする（未ACKイベントの監査証跡）。
3. 既存relayへ戻す場合も、クラウドの通常売買・OrderBridge・Executor設定は変更しない。
4. 原因、最初の失敗source event ID、outbox先頭、Windows時刻、relay versionだけを運用報告する。token・URL・認証値は出力しない。

## 境界

- これは**監視データ配送**だけであり、通常売買、`rt_trades`、OrderBridge、Executor、注文instruction、LIVE化には接続しない。
- 市場環境専用の1分足と通常10銘柄のoutboxは別経路のままにする。
