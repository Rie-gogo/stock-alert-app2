# 自動売買システム設計書 — Phase 1: ドライラン

## 概要

本システムは、既存のリアルタイムシミュレーションエンジン（realtimeSimEngine.ts）が生成するシグナルを、KABUステーションAPIを通じて実際の証券口座で自動執行するための仕組みである。Phase 1ではドライランモード（実際の発注を行わない）で全体のパイプラインを構築し、動作検証を行う。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────────┐
│                        クラウド (Manus WebApp)                        │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ KABUステーション │───▶│ realtimeSim  │───▶│    rt_trades DB      │  │
│  │ データ送信     │    │ Engine       │    │  (シグナル記録)       │  │
│  └──────────────┘    └──────────────┘    └──────────┬───────────┘  │
│                                                      │              │
│                                                      ▼              │
│                                           ┌──────────────────────┐  │
│                                           │   orderBridge.ts     │  │
│                                           │  (rt_trades監視→     │  │
│                                           │   発注指示生成)       │  │
│                                           └──────────┬───────────┘  │
│                                                      │              │
│                                                      ▼              │
│                                           ┌──────────────────────┐  │
│                                           │ order_instructions   │  │
│                                           │      DB              │  │
│                                           └──────────┬───────────┘  │
│                                                      │              │
│                                           ┌──────────┴───────────┐  │
│                                           │  tRPC Endpoints      │  │
│                                           │ (ポーリング/結果報告)  │  │
│                                           └──────────┬───────────┘  │
└──────────────────────────────────────────────────────┼──────────────┘
                                                       │
                                              HTTPS (1秒ポーリング)
                                                       │
┌──────────────────────────────────────────────────────┼──────────────┐
│                     ローカルPC (Windows)               │              │
│                                                      ▼              │
│                                           ┌──────────────────────┐  │
│                                           │ kabu_order_executor  │  │
│                                           │      .py             │  │
│                                           └──────────┬───────────┘  │
│                                                      │              │
│                                                      ▼              │
│                                           ┌──────────────────────┐  │
│                                           │ KABUステーション API  │  │
│                                           │ (localhost:18080)     │  │
│                                           └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## データフロー

| ステップ | コンポーネント | 動作 |
|---------|--------------|------|
| 1 | ローカルPC (data_sender.py) | 1分足+板情報をクラウドに送信 |
| 2 | pushCandleWithBoard (tRPC) | processCandle()でシグナル判定 |
| 3 | realtimeSimEngine | シグナル発生時にrt_tradesにINSERT |
| 4 | orderBridge.ts | rt_tradesの新規レコードを検知 |
| 5 | orderBridge.ts | order_instructionsに発注指示を生成 |
| 6 | kabu_order_executor.py | 1秒ごとにpending指示をポーリング |
| 7 | kabu_order_executor.py | プリフライトチェック（8項目） |
| 8 | kabu_order_executor.py | KABUステーションAPIに発注（or ドライラン） |
| 9 | kabu_order_executor.py | 結果をクラウドに報告 |

## テーブル設計

### order_instructions

| カラム | 型 | 説明 |
|--------|------|------|
| id | INT AUTO_INCREMENT | 主キー |
| tradeDate | VARCHAR(10) | 対象日 (YYYY-MM-DD) |
| symbol | VARCHAR(10) | 銘柄コード |
| symbolName | VARCHAR(50) | 銘柄名 |
| oi_side | ENUM | buy/sell/short/cover |
| oi_instruction_type | ENUM | entry/exit/force_close |
| qty | INT | 注文数量（株） |
| oi_status | ENUM | pending/sent/executed/failed/expired/cancelled |
| reason | TEXT | シグナル理由 |
| referencePrice | DECIMAL(12,2) | 参照価格 |
| expiresAt | TIMESTAMP | 期限切れ日時（entryのみ） |
| kabuOrderId | VARCHAR(30) | KABU API OrderId |
| executedPrice | DECIMAL(12,2) | 実約定価格 |
| executedAt | TIMESTAMP | 約定日時 |
| pnl | BIGINT | 損益（円） |
| rtTradeId | INT | 対応するrt_tradesのID |
| errorMessage | TEXT | エラーメッセージ |
| isDryRun | BOOLEAN | ドライランフラグ |
| executorLog | JSON | デバッグログ |
| createdAt | TIMESTAMP | 作成日時 |
| updatedAt | TIMESTAMP | 更新日時 |

### auto_trade_daily

| カラム | 型 | 説明 |
|--------|------|------|
| id | INT AUTO_INCREMENT | 主キー |
| tradeDate | VARCHAR(10) | 対象日（UNIQUE） |
| realizedPnl | BIGINT | 当日の実現損益合計（円） |
| tradeCount | INT | 当日の取引回数 |
| dailyLossLimit | BIGINT | 日次損失上限（デフォルト: -50,000円） |
| tradingEnabled | BOOLEAN | 取引有効フラグ |
| emergencyStop | BOOLEAN | 緊急停止フラグ |
| emergencyStopReason | TEXT | 緊急停止理由 |
| isDryRun | BOOLEAN | ドライランモード |
| createdAt | TIMESTAMP | 作成日時 |
| updatedAt | TIMESTAMP | 更新日時 |

## ステータス遷移

```
                    ┌─────────┐
                    │ pending │
                    └────┬────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌───────────┐
      │  sent    │ │ expired  │ │ cancelled │
      └────┬─────┘ └──────────┘ └───────────┘
           │
      ┌────┴────┐
      │         │
      ▼         ▼
┌──────────┐ ┌──────────┐
│ executed │ │  failed  │
└──────────┘ └──────────┘
```

| 遷移 | 条件 |
|------|------|
| pending → sent | executorがKABU APIに送信完了 |
| pending → expired | entry指示が60秒超過（自動） |
| pending → cancelled | 緊急停止時 |
| sent → executed | 約定確認 |
| sent → failed | APIエラー |

## リスク管理

### 多重防御レイヤー

| レイヤー | 場所 | 内容 |
|---------|------|------|
| L1 | orderBridge (クラウド) | 日次損失上限チェック、緊急停止状態チェック |
| L2 | orderBridge (クラウド) | entry指示の60秒期限切れ自動expire |
| L3 | executor (ローカル) | 8項目プリフライトチェック |
| L4 | executor (ローカル) | ローカル日次損失上限の二重チェック |
| L5 | KABUステーション | 証券会社側の注文制限 |

### プリフライトチェック（8項目）

1. 取引有効チェック（緊急停止中でないか）
2. 二重発注チェック（同一銘柄にpending/sent指示がないか）
3. 日次損失上限チェック（ローカル側）
4. KABUステーション接続チェック
5. 数量検証（0 < qty ≤ 1000）
6. 指示鮮度チェック（entryのみ: 60秒以内か）
7. 取引時間帯チェック（08:55〜15:30）
8. 銘柄コード妥当性チェック

### 重要な設計原則

- **決済指示は絶対に止めない**: exit/force_closeは緊急停止中でも実行される
- **エントリーのみ制限**: 新規建ては日次損失上限・緊急停止で停止可能
- **ドライランデフォルト**: isDryRun=trueがデフォルト、本番切替は明示的に行う

## KABUステーションAPI パラメータ

### 信用デイトレ発注パラメータ

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| Exchange | 27 | 東証+ |
| SecurityType | 1 | 株式 |
| MarginTradeType | 3 | 一般信用（デイトレ） |
| FrontOrderType | 10 | 成行 |
| Price | 0 | 成行時は0 |
| AccountType | 4 | 特定口座 |
| ExpireDay | 0 | 本日 |

### Side / CashMargin マッピング

| 操作 | Side | CashMargin | DelivType |
|------|------|-----------|-----------|
| 信用新規買い (buy) | "2" | 2 | 0 |
| 信用新規売り (short) | "1" | 2 | 0 |
| 信用返済売り (sell) | "1" | 3 | 2 |
| 信用返済買い (cover) | "2" | 3 | 2 |

## tRPC エンドポイント

| エンドポイント | メソッド | 用途 |
|--------------|---------|------|
| trading.getOrderInstructions | query | pending指示のポーリング |
| trading.reportOrderExecution | mutation | 実行結果の報告 |
| trading.getOrderInstructionHistory | query | 全指示の履歴取得 |
| trading.getAutoTradeStatus | query | 日次リスク管理ステータス |
| trading.setEmergencyStop | mutation | 緊急停止の設定 |

## ファイル構成

```
クラウド側:
  server/orderBridge.ts          — 発注指示生成・リスク管理
  server/routers/trading.ts      — executor向けtRPCエンドポイント
  drizzle/schema.ts              — order_instructions, auto_trade_daily テーブル定義
  server/orderBridge.test.ts     — ユニットテスト (14件)

ローカルPC側:
  kabu_order_executor.py         — ポーリング・発注実行エンジン
```

## 起動方法

### ドライラン

```bash
# ローカルPCで実行
C:\Python314\python.exe kabu_order_executor.py
```

設定:
- `DRY_RUN = True`（デフォルト）
- `CLOUD_APP_URL` を実際のデプロイURLに設定

### 本番切替（Phase 2以降）

1. `auto_trade_daily.isDryRun` を `false` に変更
2. `kabu_order_executor.py` の `DRY_RUN = False` に変更
3. `KABU_API_PASSWORD` を設定
4. KABUステーションを起動・ログイン済みにする

## Phase 2 以降の予定

- [ ] 本番発注ロジックの実装（DRY_RUN=false時）
- [ ] 約定確認ループ（注文ステータスのポーリング）
- [ ] 部分約定対応
- [ ] WebSocket通知（ポーリングからの移行）
- [ ] ダッシュボードUI（発注履歴・リスク管理画面）
- [ ] スリッページ分析（参照価格 vs 実約定価格）
- [ ] 自動リカバリー（サーバー再起動時のポジション整合性チェック）
