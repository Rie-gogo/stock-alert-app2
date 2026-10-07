from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from relay_delivery_spool import RelayDeliverySpool, RelaySpoolCollisionError  # noqa: E402


def payload(seq: int, *, source_event_id: str | None = None, close: float = 100.0) -> dict:
    event_id = source_event_id or f"session-a:{seq}"
    candle = {
        "symbol": "285A",
        "tradeDate": "2026-10-07",
        "candleTime": f"09:{seq:02d}",
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": 100,
        "provenance": {"valueSource": "ws_aggregated"},
    }
    payload_hash = hashlib.sha256(repr(sorted(candle.items())).encode("utf-8")).hexdigest()
    return {
        **candle,
        "sourceEventId": event_id,
        "relaySessionId": "session-a",
        "eventSeq": seq,
        "payloadHash": payload_hash,
        "relayReceivedAtMs": 1_790_000_000_000 + seq,
    }


class RelayDeliverySpoolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.now = 1_790_000_000_000
        self.spool = RelayDeliverySpool(
            os.path.join(self.temp.name, "outbox.sqlite3"),
            now_ms=lambda: self.now,
        )

    def tearDown(self) -> None:
        self.spool.close()
        self.temp.cleanup()

    def test_fifo_order_and_restart_recovery(self) -> None:
        first, inserted = self.spool.enqueue(payload(1))
        self.assertTrue(inserted)
        self.now += 1
        second, inserted = self.spool.enqueue(payload(2))
        self.assertTrue(inserted)
        self.assertEqual(self.spool.head().source_event_id, first.source_event_id)
        self.spool.record_attempt(first.source_event_id)
        self.spool.mark_failed(first.source_event_id, "timeout", self.now + 5_000)
        # Backoff never lets a later candle overtake the failed head.
        self.assertEqual(self.spool.head().source_event_id, first.source_event_id)
        self.spool.close()
        self.spool = RelayDeliverySpool(os.path.join(self.temp.name, "outbox.sqlite3"), now_ms=lambda: self.now)
        recovered = self.spool.head()
        self.assertIsNotNone(recovered)
        self.assertEqual(recovered.source_event_id, first.source_event_id)
        self.spool.mark_delivered(first.source_event_id)
        self.assertEqual(self.spool.head().source_event_id, second.source_event_id)

    def test_same_event_is_idempotent_but_conflict_fails_closed(self) -> None:
        original = payload(1)
        _, inserted = self.spool.enqueue(original)
        self.assertTrue(inserted)
        _, inserted_again = self.spool.enqueue(dict(original, relaySentAtMs=self.now + 10))
        self.assertFalse(inserted_again)
        collision = dict(original)
        collision["close"] = 101.0
        with self.assertRaises(RelaySpoolCollisionError):
            self.spool.enqueue(collision)

    def test_success_is_the_only_delivery_acknowledgement(self) -> None:
        event, _ = self.spool.enqueue(payload(1))
        self.spool.record_attempt(event.source_event_id)
        self.spool.mark_failed(event.source_event_id, "http_503", self.now + 1_000)
        stats = self.spool.stats()
        self.assertEqual(stats["pending"], 1)
        self.assertEqual(stats["delivered"], 0)
        self.spool.mark_delivered(event.source_event_id)
        stats = self.spool.stats()
        self.assertEqual(stats["pending"], 0)
        self.assertEqual(stats["delivered"], 1)


if __name__ == "__main__":
    unittest.main()
