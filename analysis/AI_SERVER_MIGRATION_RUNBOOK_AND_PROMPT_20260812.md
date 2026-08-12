# stock-alert-app：新サーバー移行をAIへ依頼するための手順書・プロンプト

作成日: 2026-08-12（日本時間）

## 1. この資料の目的

この資料は、現在の `stock-alert-app` を新サーバーへ移す際に、別のAIへ安全かつ漏れなく依頼するためのものです。

移行の目的は、**現在の取引ロジック、画面、DBデータ、Windows KABU relay連携を維持したまま、稼働先だけを移すこと**です。戦略改善やシグナル条件の変更は移行の範囲に含めません。

> 最重要原則: 移行中および新サーバーでの検証中は、`DRY_RUN=True`を維持する。新規の実発注、`DRY_RUN=False`への変更、`LIVE_TRADE_SYMBOLS`の拡大は、ユーザーの明示許可があるまで行わない。

---

## 2. AIへ渡すファイル・情報

以下をAIに渡します。秘密値そのものは渡しません。

| 渡すもの | 内容 | AIの使い方 |
|---|---|---|
| GitHubリポジトリ | 最新`main`ブランチのソースコード | アプリ本体・DBスキーマ・テスト・分析資料を復元 |
| `stock-alert-app-backup-*.zip` | Git履歴、ソーススナップショット、DB全8テーブルのSQL.gz、relay v6.0参照版、SHA-256 | DB復元、GitHubとの整合性確認、データ保全 |
| `MIGRATION_BACKUP_GUIDE_20260812.md` | 退避・復元手順 | DB・relay・切替の全体確認 |
| `MIGRATION_ENVIRONMENT_VARIABLES_20260812.md` | 秘密値なしの環境変数一覧と置換方針 | 新サーバーのシークレット設定とManus依存の置換 |
| `.env.migration.example` | 移行先向け環境変数テンプレート | シークレット管理画面への設定の雛形 |
| `ENGINE_SPEC_20260809.md` | 現行リアルタイムシミュレーションエンジンの仕様 | ロジック不変であることの照合 |
| `AUTO_TRADE_IMPL_SPEC_v6.md` | relay v6.0自動売買の安全設計 | Windows側relayの安全制約を維持 |
| Windows relay一式 | ユーザーが保有する実稼働relay、タスクスケジューラーXML、bat/ps1、ログ | Windows側の設定を保持。新サーバーURLへの切替時に使用 |

### 秘密値の扱い

新サーバーのDB接続情報、JWT署名鍵、認証設定、外部API鍵は、移行先のシークレット管理で**新規に発行・設定**します。旧サーバーの値をGit、ZIP、ソースコード、チャットに保存・貼り付けしてはいけません。

---

## 3. 変更してはいけないもの

AIへ以下を明示します。

| 対象 | 禁止事項 |
|---|---|
| `server/realtimeSimEngine.ts` | シグナル条件、エントリー条件、損切り・利確、銘柄別SL、CONFIRM_BARS、大台LONG停止、buy_pressure逆張りSHORT、6976の例外条件を変更しない |
| DBデータ | 旧DB・バックアップDBを削除・上書きしない。新DBへ復元して比較する |
| 自動売買 | `DRY_RUN=False`にしない。KABUステーションAPIへ実注文を送らない |
| relay | Windowsのrelayを新サーバーが正常稼働するまで新URLに向けない。relayの発注安全機構を簡略化・削除しない |
| 秘密情報 | シークレットをリポジトリ、ログ、公開URL、チャットへ出力しない |
| 本番切替 | ユーザーの明示許可なしに、DNS、公開URL、relay送信先、本番DBを切り替えない |

---

## 4. 移行の実行順序

### Phase 0：事前調査と移行計画

AIはまず、新サーバーの種類、OS、Node.jsの対応版、DBの種類、認証方針、公開URL、定期実行の仕組みを確認します。ここでは何も切り替えず、移行計画・差分・リスク・切戻し手順を報告してユーザー承認を待ちます。

### Phase 1：新サーバーを隔離環境として準備

新サーバーに、Node.js 22系、pnpm、MySQL/TiDB互換DBを用意します。GitHubから`main`を取得して依存関係を固定版で導入します。

```bash
git clone <GITHUB_REPOSITORY_URL> stock-alert-app
cd stock-alert-app
pnpm install --frozen-lockfile
```

この段階では、旧サーバー、Windows relay、KABUステーションの設定を変更しません。

### Phase 2：DBの復元と照合

バックアップZIP内の`stock-alert-db-*.sql.gz`を新DBへ復元します。復元後、以下の8テーブルが存在し、件数がバックアップ元と一致することを確認します。

```text
__drizzle_migrations
auto_trade_daily
order_instructions
rt_3peak_signals
rt_candles
rt_daily_summaries
rt_score0_blocks
rt_trades
```

DBの移行は新しい空DBに対して行います。旧DBを操作しません。

### Phase 3：環境変数・認証・定期実行の置換

`analysis/.env.migration.example`を基に、新サーバーの秘密管理で設定します。

- `DATABASE_URL`、`JWT_SECRET`、`NODE_ENV=production`は必須です。
- `JQUANTS_API_KEY`は過去データ分析を新サーバーでも行う場合だけ設定します。
- Manus OAuth・Forge API関連の値はコピーしません。新サーバー用の認証、スケジュール実行、通知・ストレージへ置換します。
- スケジュールエンドポイントの保護にManus固有キーを使っている場合は、移行先では新しい`SCHEDULE_SECRET`等を導入し、定期実行サービス側と一致させます。

### Phase 4：アプリ単体の検証

新サーバーでアプリを起動し、以下を検証します。

1. 型チェック・既存テストが通ること。
2. 画面が表示され、DBの過去データを読めること。
3. `rt_candles`、`rt_trades`、`rt_daily_summaries`の既存データが表示・集計できること。
4. 新サーバーのログに接続・認証・DBエラーが継続して出ないこと。

この時点でもrelay送信先を変更しません。

### Phase 5：Windows relayとの接続確認（DRY_RUNのみ）

ユーザー承認後、取引終了後または休日に、Windows relayの`CLOUD_BASE_URL`を新サーバーURLに変更します。

以下を必ず守ります。

- `DRY_RUN=True`のままにする。
- `LIVE_TRADE_SYMBOLS`は変更しない。
- relayの起動前に、新サーバーの受信URLとTLSを確認する。
- 旧サーバーは削除せず、切戻し可能な状態に残す。

営業日に、20銘柄の1分足・板情報が新DBの`rt_candles`へ入り、シミュレーションによる`rt_trades`と`rt_daily_summaries`が作成されることを確認します。

### Phase 6：切替判定

下記の受入条件をすべて満たした結果をAIが報告し、ユーザーが承認した場合だけ、新サーバーを正式な運用先とします。

---

## 5. 受入条件

| 項目 | 合格条件 |
|---|---|
| ソース | GitHubの指定コミットと新サーバーのHEADが一致する |
| DB | 全8テーブルが存在し、主要テーブルの件数が移行元と一致する |
| エンジン | `realtimeSimEngine.ts`にロジック変更がないことを差分で示す |
| 画面・API | 新URLで画面、履歴、日次集計、RTログが利用できる |
| relay受信 | 新DBに当日分の1分足が入り、20銘柄を受信する |
| シミュレーション | `rt_trades`と`rt_daily_summaries`が新環境で作成される |
| 自動売買安全性 | `DRY_RUN=True`であり、実注文が0件である |
| 切戻し | relayの送信先を旧URLへ戻す手順、旧DB・旧サーバーを残した状態である |

---

## 6. 切戻し方針

異常が出た場合、AIは設定やロジックを場当たりで変更しません。以下の順で安全側へ戻します。

1. 新サーバーへのrelay送信を停止する。
2. Windows relayの`CLOUD_BASE_URL`を旧サーバーURLへ戻す。
3. `DRY_RUN=True`を維持する。
4. 新サーバーのログ、DB件数、受信時刻、失敗したAPIを報告する。
5. 旧サーバー、旧DB、バックアップZIPを削除しない。

---

# 7. 移行AIへ貼り付ける依頼プロンプト

以下をそのまま貼り付け、`<>`の箇所だけ実際の情報へ置き換えてください。

```text
あなたは既存の株式リアルタイムシミュレーションWebアプリを、新しいサーバーへ安全に移行する担当です。

## 目的
現在のアプリと同一の仕様・DBデータ・Windows KABU relay連携を、新サーバーへ再現してください。
戦略変更やシグナル条件の改善は目的ではありません。移行後も既存仕様を維持してください。

## 移行元の構成
- Web: React 19 + Vite + TypeScript + Tailwind
- Server: Express 4 + tRPC 11 + TypeScript
- DB: MySQL/TiDB互換
- リアルタイムデータ: Windows PC上のKABUステーションAPIを、Python relayが受信してサーバーへ送信
- 自動売買: Windows relay v6.0が担当。現時点ではDRY_RUN=True
- 対象銘柄: 20銘柄をデータ受信、取引対象はアプリ設定に従う

## 提供する資料
1. GitHubリポジトリ: <GITHUB_REPOSITORY_URL>
2. バックアップZIP: <ZIP_FILE_OR_URL>
3. バックアップ・復元手順: analysis/MIGRATION_BACKUP_GUIDE_20260812.md
4. 環境変数資料: analysis/MIGRATION_ENVIRONMENT_VARIABLES_20260812.md
5. 環境変数テンプレート: analysis/.env.migration.example
6. エンジン仕様: analysis/ENGINE_SPEC_20260809.md
7. 自動売買relay仕様: analysis/AUTO_TRADE_IMPL_SPEC_v6.md
8. Windows relay一式・タスクスケジューラーXMLは別途ユーザーが保持しています。

## 新サーバー情報
- サーバー/ホスティング: <NEW_SERVER_TYPE>
- OS: <OS>
- 新しい公開URL: <NEW_HTTPS_URL>
- DB: <NEW_DB_TYPE_AND_CONNECTION_METHOD>
- 認証方針: <AUTH_METHOD_OR_UNDECIDED>
- 定期実行方法: <SCHEDULER_METHOD_OR_UNDECIDED>

## 絶対に守る制約
1. ユーザーの明示許可なく、本番切替、DNS変更、旧サーバー削除、旧DB変更をしない。
2. `server/realtimeSimEngine.ts`のシグナル・エントリー・損切り/利確ロジックを変更しない。
3. `DRY_RUN=False`に変更しない。KABUステーションへ実注文を送らない。
4. `LIVE_TRADE_SYMBOLS`を変更しない。
5. 旧サーバーの秘密値をコピーしない。新サーバーのSecret Manager等で新規に設定する。
6. DBは新しい空DBへ復元する。移行元DBを削除・上書きしない。
7. Manus OAuth・Forge APIの値をコピーしない。新環境用の認証・スケジュール・外部サービスへ置換する。
8. Windows relayの送信先URLは、新サーバー単体の検証が終わり、ユーザーが許可するまで変更しない。

## 実行手順
Phase 0: まずコード、DBスキーマ、Manus依存箇所、認証、定期実行、relay送信仕様を調査し、移行計画・必要な置換・リスク・切戻し手順を報告してください。この段階では変更しないでください。

Phase 1: ユーザー承認後、新サーバーの隔離環境にNode.js 22系、pnpm、MySQL/TiDB互換DBを準備し、GitHubからソースを取得してください。

Phase 2: バックアップZIP内のDB SQL.gzを新DBへ復元してください。次の8テーブルが存在することを確認してください。
__drizzle_migrations, auto_trade_daily, order_instructions, rt_3peak_signals, rt_candles, rt_daily_summaries, rt_score0_blocks, rt_trades

Phase 3: DATABASE_URL、JWT_SECRET、NODE_ENVなどを新サーバーの秘密管理で設定してください。JQUANTS_API_KEYは過去データ分析を継続する場合のみ設定してください。Manus OAuth・Forge API依存は、新サーバーに適した仕組みへ置換してください。

Phase 4: アプリ単体を起動し、型チェック、テスト、画面表示、過去データ表示、DB接続、日次集計APIを検証してください。GitHub指定コミットとの差分も確認してください。

Phase 5: ユーザーの明示許可後にだけ、Windows relayのCLOUD_BASE_URLを新サーバーURLへ変更してください。ただしDRY_RUN=Trueを維持し、20銘柄の1分足受信、rt_candles保存、シミュレーション、rt_trades/rt_daily_summaries保存を確認してください。

## 受入条件
- GitHub指定コミットと新サーバーのコードが一致
- 全8テーブルの存在と主要テーブル件数が移行元と一致
- realtimeSimEngine.tsにロジック差分なし
- 新サーバーで画面、履歴、日次集計、RTログが利用可能
- relay接続後に20銘柄の1分足が新DBへ受信される
- DRY_RUN=Trueのまま、実注文は0件
- 異常時に旧URLへ戻せる切戻し手順を実演可能

## 報告形式
各Phaseの前後で、以下を表形式で報告してください。
- 実施内容
- 変更したファイル・設定
- テスト結果
- DB件数・受信状況
- 未解決リスク
- 次に必要なユーザー承認

実装・切替・削除・実注文につながる操作は、必ず事前にユーザー承認を得てください。
```
