#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOURNAL="$ROOT_DIR/drizzle/meta/_journal.json"
DATABASE_NAME="${MIGRATION_TEST_DATABASE_NAME:-stock_alert_migration_test}"
MYSQL_BIN="${MYSQL_BIN:-mariadb}"

if [[ -n "${MIGRATION_TEST_DATABASE_URL:-}" ]]; then
  MYSQL_ARGS=("${MIGRATION_TEST_DATABASE_URL}")
elif [[ -n "${MIGRATION_TEST_SOCKET:-}" ]]; then
  MYSQL_ARGS=(-uroot "--socket=${MIGRATION_TEST_SOCKET}")
else
  echo "Set MIGRATION_TEST_DATABASE_URL or MIGRATION_TEST_SOCKET." >&2
  exit 2
fi

if [[ "$DATABASE_NAME" != stock_alert_migration_test* ]]; then
  echo "Refusing to recreate non-test database: $DATABASE_NAME" >&2
  exit 2
fi

"$MYSQL_BIN" "${MYSQL_ARGS[@]}" -e \
  "DROP DATABASE IF EXISTS \`$DATABASE_NAME\`; CREATE DATABASE \`$DATABASE_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

mapfile -t TAGS < <(grep '"tag"' "$JOURNAL" | sed -E 's/.*"tag": "([^"]+)".*/\1/')
for tag in "${TAGS[@]}"; do
  migration="$ROOT_DIR/drizzle/${tag}.sql"
  echo "Applying $tag"
  "$MYSQL_BIN" "${MYSQL_ARGS[@]}" "$DATABASE_NAME" < "$migration"
done

repair_table_count=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('rt_candidate_virtual_repair_archive','rt_candidate_virtual_repair_runs','rt_candidate_virtual_repair_stage');")
exit_reason_column_count=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='rt_signal_candidate_trades' AND column_name IN ('exit_reason_code','exit_reason_detail');")
repair_unique_count=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('rt_candidate_virtual_repair_archive_identity','rt_candidate_virtual_repair_run_identity','rt_candidate_virtual_repair_stage_identity') AND constraint_type='UNIQUE';")
delivery_table_count=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('rt_report_delivery_controls','rt_eod_execution_controls');")
delivery_column_count=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='rt_report_delivery_controls' AND column_name IN ('rt_report_delivery_status','send_started_at','payload_hash','lease_owner','lease_expires_at');")
delivery_unique_count=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('rt_report_delivery_identity','rt_eod_execution_identity') AND constraint_type='UNIQUE';")

if [[ "$repair_table_count" != "3" ]]; then
  echo "Expected 3 repair tables, got $repair_table_count" >&2
  exit 1
fi
if [[ "$exit_reason_column_count" != "2" ]]; then
  echo "Expected 2 exit reason columns, got $exit_reason_column_count" >&2
  exit 1
fi
if [[ "$repair_unique_count" != "3" ]]; then
  echo "Expected 3 repair unique constraints, got $repair_unique_count" >&2
  exit 1
fi
if [[ "$delivery_table_count" != "2" || "$delivery_column_count" != "5" || "$delivery_unique_count" != "2" ]]; then
  echo "Delivery/EOD control schema assertion failed: tables=$delivery_table_count columns=$delivery_column_count unique=$delivery_unique_count" >&2
  exit 1
fi

backfill_ok=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "INSERT INTO rt_signal_candidate_trades (virtual_engine_version, candidate_id, entry_source_event_id, trade_date, symbol, route_id, rt_signal_candidate_trade_side, entry_candle_time, entry_price, shares, sl_pct, tp_pct, max_holding_minutes, state_json, completed, exit_reason) VALUES ('migration-test', 999999, 'migration-test-entry', '2099-01-01', '5803', 'highFadeBreakShort', 'short', '09:00', 10000, 100, 0.6, 1.5, 30, JSON_OBJECT(), true, 'signal_reversal:長い日本語詳細'); UPDATE rt_signal_candidate_trades SET exit_reason_code = LEFT(SUBSTRING_INDEX(exit_reason, ':', 1), 64), exit_reason_detail = CASE WHEN LOCATE(':', exit_reason) > 0 THEN SUBSTRING(exit_reason, LOCATE(':', exit_reason) + 1) ELSE NULL END WHERE entry_source_event_id='migration-test-entry'; SELECT IF(exit_reason_code='signal_reversal' AND exit_reason_detail='長い日本語詳細', 1, 0) FROM rt_signal_candidate_trades WHERE entry_source_event_id='migration-test-entry';")
if [[ "$backfill_ok" != "1" ]]; then
  echo "Exit reason backfill assertion failed: $backfill_ok" >&2
  exit 1
fi

# DBレベルで2つのclaimを同時実行し、同じ日・同じ報告を1行だけが取得することを確認する。
"$MYSQL_BIN" "${MYSQL_ARGS[@]}" "$DATABASE_NAME" -e \
  "INSERT INTO rt_report_delivery_controls (trade_date, report_kind, rt_report_delivery_status) VALUES ('2099-01-02','rt-daily-report','pending');"
tmp_a=$(mktemp)
tmp_b=$(mktemp)
trap 'rm -f "$tmp_a" "$tmp_b"' EXIT
("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "UPDATE rt_report_delivery_controls SET rt_report_delivery_status='claimed', lease_owner='owner-a', lease_expires_at=DATE_ADD(NOW(), INTERVAL 2 MINUTE), attempt_count=attempt_count+1 WHERE trade_date='2099-01-02' AND report_kind='rt-daily-report' AND rt_report_delivery_status='pending'; SELECT ROW_COUNT();" > "$tmp_a") &
pid_a=$!
("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "UPDATE rt_report_delivery_controls SET rt_report_delivery_status='claimed', lease_owner='owner-b', lease_expires_at=DATE_ADD(NOW(), INTERVAL 2 MINUTE), attempt_count=attempt_count+1 WHERE trade_date='2099-01-02' AND report_kind='rt-daily-report' AND rt_report_delivery_status='pending'; SELECT ROW_COUNT();" > "$tmp_b") &
pid_b=$!
wait "$pid_a" "$pid_b"
claim_total=$(( $(tail -n 1 "$tmp_a") + $(tail -n 1 "$tmp_b") ))
claim_state=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT CONCAT(rt_report_delivery_status,':',attempt_count,':',IF(lease_owner IN ('owner-a','owner-b'),1,0)) FROM rt_report_delivery_controls WHERE trade_date='2099-01-02' AND report_kind='rt-daily-report';")
if [[ "$claim_total" != "1" || "$claim_state" != "claimed:1:1" ]]; then
  echo "Concurrent delivery claim assertion failed: claimed=$claim_total state=$claim_state" >&2
  exit 1
fi

# sending開始後にlease切れした結果は自動再送せずunknownへ隔離する。
unknown_state=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "UPDATE rt_report_delivery_controls SET rt_report_delivery_status='sending', send_started_at=NOW(), lease_expires_at=DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE trade_date='2099-01-02'; UPDATE rt_report_delivery_controls SET rt_report_delivery_status='unknown', lease_owner=NULL, lease_expires_at=NULL WHERE trade_date='2099-01-02' AND rt_report_delivery_status='sending' AND lease_expires_at < NOW(); SELECT rt_report_delivery_status FROM rt_report_delivery_controls WHERE trade_date='2099-01-02';")
if [[ "$unknown_state" != "unknown" ]]; then
  echo "Expired sending isolation assertion failed: $unknown_state" >&2
  exit 1
fi

"$MYSQL_BIN" "${MYSQL_ARGS[@]}" "$DATABASE_NAME" -e \
  "INSERT INTO rt_eod_execution_controls (trade_date, execution_kind, rt_eod_execution_status) VALUES ('2099-01-02','rt-daily-force-close','pending');"
("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "UPDATE rt_eod_execution_controls SET rt_eod_execution_status='processing', lease_owner='eod-a', lease_expires_at=DATE_ADD(NOW(), INTERVAL 2 MINUTE), attempt_count=attempt_count+1 WHERE trade_date='2099-01-02' AND execution_kind='rt-daily-force-close' AND rt_eod_execution_status='pending'; SELECT ROW_COUNT();" > "$tmp_a") &
pid_a=$!
("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "UPDATE rt_eod_execution_controls SET rt_eod_execution_status='processing', lease_owner='eod-b', lease_expires_at=DATE_ADD(NOW(), INTERVAL 2 MINUTE), attempt_count=attempt_count+1 WHERE trade_date='2099-01-02' AND execution_kind='rt-daily-force-close' AND rt_eod_execution_status='pending'; SELECT ROW_COUNT();" > "$tmp_b") &
pid_b=$!
wait "$pid_a" "$pid_b"
eod_claim_total=$(( $(tail -n 1 "$tmp_a") + $(tail -n 1 "$tmp_b") ))
eod_claim_state=$("$MYSQL_BIN" "${MYSQL_ARGS[@]}" --batch --skip-column-names "$DATABASE_NAME" -e \
  "SELECT CONCAT(rt_eod_execution_status,':',attempt_count,':',IF(lease_owner IN ('eod-a','eod-b'),1,0)) FROM rt_eod_execution_controls WHERE trade_date='2099-01-02' AND execution_kind='rt-daily-force-close';")
if [[ "$eod_claim_total" != "1" || "$eod_claim_state" != "processing:1:1" ]]; then
  echo "Concurrent EOD claim assertion failed: claimed=$eod_claim_total state=$eod_claim_state" >&2
  exit 1
fi

echo "Empty database migration test passed through ${TAGS[-1]}."
