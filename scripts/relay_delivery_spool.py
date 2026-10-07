"""Durable FIFO outbox for KABU candle delivery.

This module deliberately has no KABU Station or cloud credentials.  The relay
stores a canonical candle payload before attempting HTTP delivery, then one
worker retries that immutable payload in FIFO order.  A successful cloud
response is the only condition that marks an event delivered.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import sqlite3
import threading
import time
from typing import Any, Callable


class RelaySpoolCollisionError(RuntimeError):
    """A source_event_id was reused with different immutable candle content."""


@dataclass(frozen=True)
class RelaySpoolItem:
    source_event_id: str
    relay_session_id: str
    event_seq: int
    symbol: str
    trade_date: str
    candle_time: str
    payload_hash: str
    payload: dict[str, Any]
    created_at_ms: int
    attempt_count: int
    retry_after_ms: int | None


class RelayDeliverySpool:
    """SQLite-backed FIFO delivery queue, safe across relay restarts."""

    def __init__(self, path: str, *, now_ms: Callable[[], int] | None = None):
        self.path = path
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._lock = threading.RLock()
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS candle_delivery_spool (
                  source_event_id TEXT PRIMARY KEY,
                  relay_session_id TEXT NOT NULL,
                  event_seq INTEGER NOT NULL,
                  symbol TEXT NOT NULL,
                  trade_date TEXT NOT NULL,
                  candle_time TEXT NOT NULL,
                  payload_hash TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at_ms INTEGER NOT NULL,
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  last_attempt_at_ms INTEGER,
                  retry_after_ms INTEGER,
                  delivered_at_ms INTEGER,
                  last_error TEXT
                )
                """
            )
            self._connection.execute(
                """
                CREATE INDEX IF NOT EXISTS candle_delivery_spool_head
                ON candle_delivery_spool(delivered_at_ms, created_at_ms, relay_session_id, event_seq)
                """
            )

    @staticmethod
    def _canonical(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def enqueue(self, payload: dict[str, Any]) -> tuple[RelaySpoolItem, bool]:
        """Store an immutable event. Returns (item, inserted).

        Re-enqueueing the same source_event_id and identical immutable payload
        is idempotent. A payload mismatch is deliberately fail-closed.
        """
        required = (
            "sourceEventId", "relaySessionId", "eventSeq", "symbol", "tradeDate",
            "candleTime", "payloadHash",
        )
        missing = [name for name in required if payload.get(name) in (None, "")]
        if missing:
            raise ValueError(f"relay_spool_missing_metadata:{','.join(missing)}")
        immutable_payload = {
            key: value for key, value in payload.items()
            if key != "relaySentAtMs"
        }
        encoded = self._canonical(immutable_payload)
        source_event_id = str(immutable_payload["sourceEventId"])
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT * FROM candle_delivery_spool WHERE source_event_id = ?",
                (source_event_id,),
            ).fetchone()
            if row is not None:
                if row["payload_json"] != encoded or row["payload_hash"] != str(immutable_payload["payloadHash"]):
                    raise RelaySpoolCollisionError(
                        f"relay_spool_source_event_payload_mismatch:{source_event_id}"
                    )
                return self._row_to_item(row), False
            now = self._now_ms()
            self._connection.execute(
                """
                INSERT INTO candle_delivery_spool (
                  source_event_id, relay_session_id, event_seq, symbol, trade_date,
                  candle_time, payload_hash, payload_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_event_id,
                    str(immutable_payload["relaySessionId"]),
                    int(immutable_payload["eventSeq"]),
                    str(immutable_payload["symbol"]),
                    str(immutable_payload["tradeDate"]),
                    str(immutable_payload["candleTime"]),
                    str(immutable_payload["payloadHash"]),
                    encoded,
                    now,
                ),
            )
            created = self._connection.execute(
                "SELECT * FROM candle_delivery_spool WHERE source_event_id = ?",
                (source_event_id,),
            ).fetchone()
            assert created is not None
            return self._row_to_item(created), True

    def head(self) -> RelaySpoolItem | None:
        """Return the oldest undelivered event without allowing leapfrogging."""
        with self._lock:
            row = self._connection.execute(
                """
                SELECT * FROM candle_delivery_spool
                WHERE delivered_at_ms IS NULL
                ORDER BY created_at_ms, relay_session_id, event_seq
                LIMIT 1
                """
            ).fetchone()
            return self._row_to_item(row) if row is not None else None

    def record_attempt(self, source_event_id: str) -> RelaySpoolItem:
        with self._lock, self._connection:
            now = self._now_ms()
            self._connection.execute(
                """
                UPDATE candle_delivery_spool
                SET attempt_count = attempt_count + 1, last_attempt_at_ms = ?
                WHERE source_event_id = ? AND delivered_at_ms IS NULL
                """,
                (now, source_event_id),
            )
            row = self._connection.execute(
                "SELECT * FROM candle_delivery_spool WHERE source_event_id = ?",
                (source_event_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"relay_spool_event_missing:{source_event_id}")
            return self._row_to_item(row)

    def mark_delivered(self, source_event_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE candle_delivery_spool
                SET delivered_at_ms = ?, retry_after_ms = NULL, last_error = NULL
                WHERE source_event_id = ?
                """,
                (self._now_ms(), source_event_id),
            )

    def mark_failed(self, source_event_id: str, error: str, retry_after_ms: int) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE candle_delivery_spool
                SET last_error = ?, retry_after_ms = ?
                WHERE source_event_id = ? AND delivered_at_ms IS NULL
                """,
                (error[:500], retry_after_ms, source_event_id),
            )

    def stats(self) -> dict[str, int | None]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT
                  SUM(CASE WHEN delivered_at_ms IS NULL THEN 1 ELSE 0 END) AS pending,
                  SUM(CASE WHEN delivered_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
                  MIN(CASE WHEN delivered_at_ms IS NULL THEN created_at_ms ELSE NULL END) AS oldest_pending_at_ms,
                  MAX(CASE WHEN delivered_at_ms IS NULL THEN attempt_count ELSE 0 END) AS max_pending_attempt_count
                FROM candle_delivery_spool
                """
            ).fetchone()
            now = self._now_ms()
            oldest = int(row["oldest_pending_at_ms"]) if row and row["oldest_pending_at_ms"] is not None else None
            return {
                "pending": int(row["pending"] or 0) if row else 0,
                "delivered": int(row["delivered"] or 0) if row else 0,
                "oldestPendingAgeMs": max(0, now - oldest) if oldest is not None else None,
                "maxPendingAttemptCount": int(row["max_pending_attempt_count"] or 0) if row else 0,
            }

    @staticmethod
    def _row_to_item(row: sqlite3.Row) -> RelaySpoolItem:
        return RelaySpoolItem(
            source_event_id=str(row["source_event_id"]),
            relay_session_id=str(row["relay_session_id"]),
            event_seq=int(row["event_seq"]),
            symbol=str(row["symbol"]),
            trade_date=str(row["trade_date"]),
            candle_time=str(row["candle_time"]),
            payload_hash=str(row["payload_hash"]),
            payload=json.loads(str(row["payload_json"])),
            created_at_ms=int(row["created_at_ms"]),
            attempt_count=int(row["attempt_count"]),
            retry_after_ms=int(row["retry_after_ms"]) if row["retry_after_ms"] is not None else None,
        )
