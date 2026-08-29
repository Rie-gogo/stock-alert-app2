# 6976 太陽誘電「候補A」再監査手順

**作成者:** Manus AI  
**対象:** 6976 太陽誘電、候補A「5本・5分ハイブリッド」  
**状態:** 監査専用、通常運用では無効、DRY_RUN維持

## 目的と結論

この監査物は、過去に一時検証だけで報告された候補Aを、第三者がGitから再実行できる形へ固定したものである。候補Aは通常の6976売買経路へ切り替えておらず、Vitestから明示的に有効化した場合だけ`realtimeSimEngine.ts`の実エンジン入口・共通ATR・建玉・SL/TP・板読み早期利確・時間決済を通る。

保存KABUステーション1分足と同時点板だけを、`tradeDate + candleTime`ごとに最大IDを採用して46保存日・14,719足再生した結果、候補Aは**21件・17勝4敗・勝率80.95%・100株換算+163,706.67円**を再現した。内訳は新方式16件、非発火日にだけ使う既存SHORT予備5件である。直近5完全日である2026年8月20日（木）、21日（金）、26日（水）、27日（木）、28日（金）は3件・3勝0敗だった。

| 指標 | 固定期待値 |
|---|---:|
| 全取引 | 21件 |
| 新方式 | 16件 |
| 既存SHORT予備 | 5件 |
| 勝敗 | 17勝4敗 |
| 勝率 | 80.95% |
| 100株換算損益 | +163,706.67円 |
| 初動足の板拒否候補 | 18件 |
| 直近5完全日 | 3件・3勝0敗 |

> 以前の報告値`+163,581円`とは126円弱の差がある。恒久fixtureと現在の実エンジン再生では`+163,706.67円`で一致しており、今後の再監査基準はこちらを採用する。旧報との差を隠さず、全21件の時刻・価格・出口・100株損益を`server/fixtures/taiyoCandidateA.expected.ts`へ固定した。

## 固定仕様

新方式の初動は09:45から10:30までの確定1分足で判定する。現足終値が直前5本の高値を上抜いた陽線をLONG、直前5本の安値を下抜いた陰線をSHORTとし、MA8の二本差分傾きが方向一致、現足出来高が直前20本平均の1.0倍以上であることを要求する。

| 項目 | 固定値・定義 |
|---|---|
| 対象時間 | 09:45〜10:30、両端を含む |
| ブレイク | 現足終値と直前5本の高値・安値を比較 |
| 足色 | LONGは陽線、SHORTは陰線 |
| MA | 8本平均の現在値と2本前値を比較し、方向一致を要求 |
| 出来高 | 初動足出来高 ÷ 直前20本平均出来高 >= 1.0 |
| 確認 | 次の1本で初動終値を同方向へ更新し、足色も同方向 |
| 始値方向 | 確認足終値が当日始値からLONGは+1.6%以上、SHORTは-1.6%以下 |
| 実体 | 確認足の絶対実体率 >= 0.275% |
| 確認失敗 | pendingを破棄した後、同じ確認足を新しい初動候補として再評価 |
| SL / TP | SL 0.8%、TP 1.1%。同一1分足内で両方成立時はSL優先 |
| 最大保有 | 5分到達足では保持し、5分超過後の次足始値で決済 |
| 板読み早期利確 | 現行実エンジンの処理を維持 |
| 共通ATRゲート | 直近7本ATR率 >= 0.12%を`enterPosition`で要求 |
| 新方式非発火時 | 10:31以降、既存の朝初動SHORTと後場反転SHORTだけを予備利用 |
| 停止する既存経路 | 候補A監査時の後場反転LONG |

### 数値化した板条件

板は**初動ブレイク足**で判定する。候補Aの入口では汎用`boardReadingScore`を使用せず、保存板のBPR、`marketOrderDirection`、`signal`を直接比較する。これにより、板スコアの履歴依存要素が変わっても候補Aの入口定義は変化しない。

| 方向 | 許可条件 | 拒否条件 |
|---|---|---|
| LONG | BPR >= 0.80 | BPR < 0.80、成行方向`SELL`、`sell_pressure`、`large_sell_wall` |
| SHORT | BPR <= 1.20 | BPR > 1.20、成行方向`BUY`、`buy_pressure`、`large_buy_wall` |
| 板欠損 | 許可 | 中立として通過する |

`server/fixtures/taiyoCandidateA.expected.ts`には、価格・足色・MA・出来高まで通過した後ではなく、**初動条件を満たした時点で板だけにより拒否された全18候補**を固定している。これらは次足確認前の初動であるため、「除外された完成取引7件」と解釈してはいけない。過去の独立再生で言及された「価格条件だけの23件との差7件」は、同じ状態遷移・板判定時点の結果ではなく、今回の実エンジン監査では再現しなかった。

## データとfixture

`server/fixtures/taiyoCandidateA.audit.fixture.json`はKABUステーション由来の保存`rt_candles`だけから生成した。全46日を複製せず、全21取引を入口から出口まで再生する21区間と、取引がない日にも存在した板拒否を再現する3区間を収録している。

| 項目 | 内容 |
|---|---|
| 区間数 | 24区間（取引21、板拒否専用3） |
| 1分足 | 2,202本 |
| 行形式 | 時刻、OHLCV、同時点boardSnapshot |
| 重複処理 | 同一日・同一時刻は最大ID |
| 未来情報 | 不使用。各区間は先頭保存足から期待決済足または拒否確認時刻まで |
| SHA-256 | `1e22dd9017c19e6be28461d089496a91d39270d4f4d1704d8257cee564b8c972` |

fixtureはDBなしで第三者が再生できる。元DBとの完全照合は、別の任意実行テストが46保存日・14,719足を読み、同じ21取引・18板拒否初動へ一致することを確認する。

## 再監査コマンド

DB不要の標準監査は次のコマンドで実行する。

```bash
pnpm vitest run \
  server/taiyoCandidateA.spec.test.ts \
  server/taiyoCandidateA.auditReplay.test.ts
```

この実行は数値境界、全21取引、18板拒否初動、確認失敗後の同一足再検出、通常モード非干渉、候補Aでの板読み早期利確維持を検証する。

保存DBへ接続できる環境では、次のコマンドでfixture期待値と元KABUデータを照合する。

```bash
TAIYO_CANDIDATE_A_SOURCE_AUDIT=1 \
  pnpm vitest run server/taiyoCandidateA.sourceAudit.test.ts
```

fixtureを元DBから再生成する場合は次のコマンドを使用する。`DATABASE_URL`が必要であり、生成後はGit差分とSHA-256を必ず確認する。

```bash
node scripts/generate-taiyo-candidate-a-fixture.mjs \
  > server/fixtures/taiyoCandidateA.audit.fixture.json
```

## 非本番保証

候補Aの実エンジン分岐は既定値`false`で、アプリAPI、UI、環境変数、スケジュールから有効化する経路を持たない。切替関数は`VITEST=true`のテストプロセス以外では例外を返す。通常モードで同じ2026年8月28日保存足を再生しても候補A理由が一度も発火しないことを恒久テストで確認する。

現在の6976通常運用は従来どおり、朝初動SHORT、後場反転LONG、後場反転SHORTの3方式である。候補Aの期待取引はアプリDB、通常シグナル履歴、日次レポートへ保存されない。

## 限界と注意事項

この結果は保存済み46日の同一標本から選定・固定したもので、独立した将来検証ではない。条件数が多く、標本21件と小さいため過学習リスクがある。手数料、金利、スリッページ、板数量に対する約定不能は反映していない。100株固定・証拠金上限なしのシグナル品質であり、7銘柄・元金300万円・可変株数・資金競合を含む実運用影響とは分離して評価する必要がある。

## References

| 参照 | 内容 |
|---|---|
| [`server/taiyoCandidateA.ts`](../server/taiyoCandidateA.ts) | 数値化した候補A仕様と純粋判定関数 |
| [`server/realtimeSimEngine.ts`](../server/realtimeSimEngine.ts) | Vitest専用の休眠分岐、実エンジン建玉・出口 |
| [`server/fixtures/taiyoCandidateA.expected.ts`](../server/fixtures/taiyoCandidateA.expected.ts) | 全21取引・18板拒否初動・集計期待値 |
| [`server/fixtures/taiyoCandidateA.audit.fixture.json`](../server/fixtures/taiyoCandidateA.audit.fixture.json) | DB不要のKABU由来2,202足fixture |
| [`server/taiyoCandidateA.spec.test.ts`](../server/taiyoCandidateA.spec.test.ts) | 仕様境界テスト |
| [`server/taiyoCandidateA.auditReplay.test.ts`](../server/taiyoCandidateA.auditReplay.test.ts) | DB不要の実エンジン回帰 |
| [`server/taiyoCandidateA.sourceAudit.test.ts`](../server/taiyoCandidateA.sourceAudit.test.ts) | DBあり46日ソース監査 |
