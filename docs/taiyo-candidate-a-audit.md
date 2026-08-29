# 6976候補A「5本・5分ハイブリッド」再監査仕様

**作成者:** Manus AI  
**対象:** 6976 太陽誘電、候補A「5本・5分ハイブリッド」  
**状態:** 監査・シャドー候補専用、通常運用では無効、DRY_RUN維持

## 目的と再精査結論

この監査物は、候補Aを第三者がGitだけで再実行できる形へ固定する。候補Aは通常の6976売買経路へ切り替えておらず、Vitestから明示的に有効化した場合だけ`realtimeSimEngine.ts`の実エンジン入口・共通ATR・建玉・SL/TP・時間決済を通る。

コミット`802cd234`への第三者指摘を独立再検証した結果、**5分超過後の完成済み足の始値へ遡る処理は実運用で約定不能**というP0指摘は正しかった。Windows relayは前分の完成足を毎分15秒以降に送信するため、クラウドが受信時点で同じ足の始値へ約定を遡らせることはできない。そこで監査専用候補Aを、**エントリー足から5分以上となる最初の完成足を受信した時点で、その確定足終値を成行約定の近似値として決済する**因果的仕様へ変更した。これは約定値そのものではないため、0.05%・0.10%悪化を別テストで固定する。

全46保存日・14,719足を再生した新しい基準は、**21件・17勝4敗・勝率80.95%・100株換算+157,493.67円**である。取引数と勝敗は維持したが、旧`+163,706.67円`から**-6,213円**となった。単純に旧時間決済8件の価格だけを差し替えると影響を見落とす。新時間出口は8月6日の後続TPより先に+3,300円で決済し、8月19日の後続SLより先に-7,000円で決済するためである。

| 指標 | 因果的出口の固定期待値 |
|---|---:|
| 全保存日・1分足 | 46日・14,719足 |
| 全取引 | 21件 |
| 新方式 / 既存SHORT予備 | 16件 / 5件 |
| 勝敗・勝率 | 17勝4敗・80.95% |
| 100株換算損益 | +157,493.67円 |
| 因果的5分時間決済 | 10件・+18,800円 |
| 初動足の板拒否候補 | 19件（板欠損1件を含む） |
| 直近5完全日 | 3件・3勝0敗 |

## 第三者指摘の検証結果

| 指摘 | 判定 | 対応 |
|---|---|---|
| 完成済み次足の始値へ遡る5分決済 | **正しい** | 5分以上となる最初の確定足終値へ変更し、全46日を再計算 |
| Git fixtureが24区間だけ | **正しい** | 非発火日を含む全46日・14,719足へ拡張 |
| `802cd234`のSHA-256不一致 | **再現せず** | 同コミットのGit格納バイトと作業ツリーは文書値`1e22…c972`に一致。新fixtureは新SHAをテスト固定 |
| 候補A原案は板読み早期利確なし | **残存原案コードで確認** | 候補A primaryだけ板読み早期利確を無効化。過去21件には同決済0件 |
| 板欠損時許可は実運用リスク | **妥当な新安全方針** | `board_missing`で拒否。7月2日10:26のLONG初動1件が追加拒否、取引結果は不変 |
| 10:30初動の次足確認不能 | **正しい** | 初動は10:29まで、10:30は既存pendingの確認だけと明示 |
| 期待結果に決済理由なし | **正しい** | 全21件で`exitReason`を完全一致比較 |

## 固定仕様

新方式の初動は09:45から10:29までの確定1分足で判定し、10:30は**10:29初動の次足確認専用**とする。現足終値が直前5本の高値を上抜いた陽線をLONG、直前5本の安値を下抜いた陰線をSHORTとし、MA8の二本差分傾きが方向一致、現足出来高が直前20本平均の1.0倍以上であることを要求する。

| 項目 | 固定値・定義 |
|---|---|
| 初動時間 | 09:45〜10:29、両端を含む |
| 最終確認 | 10:30まで。10:30の新規初動は作らない |
| ブレイク | 初動足終値と直前5本の高値・安値を比較 |
| 足色 | LONGは陽線、SHORTは陰線 |
| MA | 8本平均の現在値と2本前値を比較し、方向一致を要求 |
| 出来高 | 初動足出来高 ÷ 直前20本平均出来高 >= 1.0 |
| 確認 | 次の1本で初動終値を同方向へ更新し、足色も同方向 |
| 始値方向 | 確認足終値が当日始値からLONGは+1.6%以上、SHORTは-1.6%以下 |
| 実体 | 確認足の絶対実体率 >= 0.275% |
| 確認失敗 | pending破棄後、同じ確認足を新しい初動候補として再評価 |
| SL / TP | SL 0.8%、TP 1.1%。同一1分足内で両方成立時はSL優先 |
| 最大保有 | エントリー足から5分以上となる最初の完成足の終値で決済近似 |
| 板読み早期利確 | 候補A primaryでは無効。TP・SL・時間決済に限定 |
| 共通ATRゲート | 直近7本ATR率 >= 0.12%を`enterPosition`で要求 |
| 新方式非発火時 | 10:31以降、既存の朝初動SHORTと後場反転SHORTだけを予備利用 |
| 停止する既存経路 | 候補A監査時の後場反転LONG |

### 数値化した板条件

板は**初動ブレイク足**で判定する。候補Aの入口では汎用`boardReadingScore`を使用せず、保存板のBPR、`marketOrderDirection`、`signal`を直接比較する。

| 方向 | 許可条件 | 拒否条件 |
|---|---|---|
| LONG | BPR >= 0.80 | BPR < 0.80、成行方向`SELL`、`sell_pressure`、`large_sell_wall` |
| SHORT | BPR <= 1.20 | BPR > 1.20、成行方向`BUY`、`buy_pressure`、`large_buy_wall` |
| 板欠損 | 不許可 | `board_missing`として記録し、その足ではpendingを作らない |

`server/fixtures/taiyoCandidateA.expected.ts`には、初動価格・足色・MA・出来高を通過した後に板だけで拒否された**全19候補**を固定する。内訳は旧18件に、板欠損拒否となった2026年7月2日10:26のLONG初動1件を加えたものである。これらは次足確認前の初動であり、「除外された完成取引」とは扱わない。

## データとfixture

`server/fixtures/taiyoCandidateA.audit.fixture.json`は、KABUステーション由来の保存`rt_candles`から、`tradeDate + candleTime`ごとに最大IDを採用して生成した。**取引日だけを切り出さず、非発火日を含む全46日・14,719足**を収録する。

| 項目 | 内容 |
|---|---|
| schemaVersion | 2 |
| 日数・1分足 | 46日・14,719足 |
| 行形式 | 時刻、OHLCV、候補Aが参照する同時点板3項目 |
| 板項目 | BPR、成行方向、signal。欠損は`null`を保持 |
| 重複処理 | 同一日・同一時刻は最大ID |
| 未来情報 | 不使用。全日を時刻順で実エンジンへ投入 |
| SHA-256 | `8ba72c0fbdb043135bf3c8677e82a2205a6b1f644c958e0d49ac7e6cda3c244e` |

SHA-256は文書記載だけでなく、`taiyoCandidateA.auditReplay.test.ts`が生バイトから計算し、恒久定数と一致することを検証する。fixtureの内容を変更すれば、期待ハッシュも意図的に更新しない限りテストは失敗する。

## 約定悪化

原案の安定性検証と同じく、各取引の100株損益から`entryPrice × adversePct`を一律控除する片道総悪化モデルを使用する。手数料・金利・実板数量は別途未反映である。

| 条件 | 勝敗・勝率 | 100株換算損益 |
|---|---:|---:|
| 因果的基準 | 17勝4敗・80.95% | +157,493.67円 |
| 0.05%悪化 | 16勝5敗・76.19% | +143,687.62円 |
| 0.10%悪化 | 15勝6敗・71.43% | +129,881.57円 |

0.10%悪化では採用目標75%を下回る。したがって、この候補は**監査・シャドー専用のまま**とし、LIVEや通常DRY_RUN入口へ有効化しない。

## 7銘柄統合・資金制約

保存KABU 93,072足を、`tradeDate`の後に**保存ID順**で処理した。元金300万円、信用3.3倍、使用率90%の既存上限、可変株数を変更していない。結果はDBソース監査テストへ固定した。

| シナリオ | 取引 | 勝敗 | 総損益 |
|---|---:|---:|---:|
| 現行6976 | 206件 | 154勝52敗 | +3,748,384円 |
| 候補A・因果的出口 | 205件 | 154勝51敗 | +3,698,761円 |
| 差 | -1件 | 勝ち±0・負け-1 | **-49,623円** |

候補Aでは6976単体の統合内損益が+126,499円から+193,959円へ+67,460円となった一方、資金が使われる時刻が変わり、285Aなど他銘柄の取引・株数が変化した。したがって、総損益-49,623円は候補Aの単独シグナル品質ではなく、**資金再配分を含むポートフォリオ影響**として分離して読む必要がある。

## 再監査コマンド

DB不要の標準監査は次のコマンドで実行する。全46日fixture、SHA、数値境界、全21取引と決済理由、19板拒否、確認失敗後の同足再検出、約定悪化、通常モード非干渉を検証する。

```bash
pnpm vitest run \
  server/taiyoCandidateA.spec.test.ts \
  server/taiyoCandidateA.auditReplay.test.ts
```

保存DBへ接続できる環境では、元KABU 14,719足との照合を実行する。

```bash
TAIYO_CANDIDATE_A_SOURCE_AUDIT=1 \
  pnpm vitest run server/taiyoCandidateA.sourceAudit.test.ts
```

7銘柄統合は、現行と候補を別プロセスで実行する。

```bash
TAIYO_CANDIDATE_A_PORTFOLIO_AUDIT=1 \
TAIYO_CANDIDATE_A_PORTFOLIO_SCENARIO=baseline \
  pnpm vitest run server/taiyoCandidateA.portfolioSourceAudit.test.ts

TAIYO_CANDIDATE_A_PORTFOLIO_AUDIT=1 \
TAIYO_CANDIDATE_A_PORTFOLIO_SCENARIO=candidate \
  pnpm vitest run server/taiyoCandidateA.portfolioSourceAudit.test.ts
```

fixture再生成には`DATABASE_URL`が必要である。生成後はGit差分とSHA-256を確認する。

```bash
node scripts/generate-taiyo-candidate-a-fixture.mjs \
  > server/fixtures/taiyoCandidateA.audit.fixture.json
```

## 非本番保証と限界

候補Aの実エンジン分岐は既定値`false`で、アプリAPI、UI、環境変数、スケジュールから有効化する経路を持たない。切替関数は`VITEST=true`のテストプロセス以外では例外を返す。現在の6976通常運用は従来どおり、朝初動SHORT、後場反転LONG、後場反転SHORTの3方式である。

確定足終値はクラウド受信後の成行約定価格そのものではなく、因果的な近似値である。実際の通信・注文遅延、板数量、手数料、金利は未反映である。また、同じ46日から条件選定と評価を行った21件の小標本であり、独立した将来検証ではない。7銘柄統合でも総損益は改善していないため、現段階の適切な位置づけは**本番未有効の監査・シャドー候補**である。

## References

| 参照 | 内容 |
|---|---|
| [`server/taiyoCandidateA.ts`](../server/taiyoCandidateA.ts) | 数値化した候補A仕様・板・時間境界の純粋関数 |
| [`server/realtimeSimEngine.ts`](../server/realtimeSimEngine.ts) | Vitest専用休眠分岐、実エンジン建玉・因果的出口 |
| [`server/fixtures/taiyoCandidateA.expected.ts`](../server/fixtures/taiyoCandidateA.expected.ts) | 全21取引・決済理由・19板拒否・集計・約定悪化・統合期待値 |
| [`server/fixtures/taiyoCandidateA.audit.fixture.json`](../server/fixtures/taiyoCandidateA.audit.fixture.json) | DB不要の全46日・14,719足fixture |
| [`server/taiyoCandidateA.spec.test.ts`](../server/taiyoCandidateA.spec.test.ts) | 数値・板・10:29/10:30境界テスト |
| [`server/taiyoCandidateA.auditReplay.test.ts`](../server/taiyoCandidateA.auditReplay.test.ts) | DB不要の全46日実エンジン回帰 |
| [`server/taiyoCandidateA.sourceAudit.test.ts`](../server/taiyoCandidateA.sourceAudit.test.ts) | DBあり46日ソース照合 |
| [`server/taiyoCandidateA.portfolioSourceAudit.test.ts`](../server/taiyoCandidateA.portfolioSourceAudit.test.ts) | DBあり7銘柄保存ID順・資金制約統合監査 |
