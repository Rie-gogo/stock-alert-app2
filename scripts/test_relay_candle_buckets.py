from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class RelayCandleBucketTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        os.environ["STOCK_ALERT_RELAY_SPOOL_PATH"] = str(Path(cls.temp.name) / "relay-test-outbox.sqlite3")
        sys.path.insert(0, str(Path(__file__).parent))
        # Windows relay runtimeには websocket-client を導入するが、CIの純粋bucket testは不要。
        sys.modules.setdefault("websocket", types.SimpleNamespace(WebSocketApp=object))
        global relay
        import kabu_board_relay as relay_module
        relay = relay_module

    @classmethod
    def tearDownClass(cls) -> None:
        relay.relay_spool.close()
        cls.temp.cleanup()

    def setUp(self) -> None:
        with relay.candle_accum_lock:
            relay.candle_accum.clear()
            relay.finalized_candle_buckets.clear()
            relay.relay_gap_logged.clear()

    def test_multiple_finalized_websocket_minutes_are_retained_fifo(self) -> None:
        with patch.object(relay, "current_minute_jst", side_effect=["09:00", "09:01", "09:02"]), patch.object(relay.time, "time", side_effect=[1_000.0, 1_060.0, 1_120.0]):
            relay.update_candle_accum("285A", 100.0)
            relay.update_candle_accum("285A", 101.0)
            relay.update_candle_accum("285A", 102.0)

        with relay.candle_accum_lock:
            retained = relay.finalized_candle_buckets["285A"]
            self.assertEqual([minute for _, minute in sorted(retained)], ["09:00", "09:01"])
            self.assertEqual(retained[sorted(retained)[0]]["close"], 100.0)
            self.assertEqual(retained[sorted(retained)[1]]["close"], 101.0)

    def test_missing_minute_never_creates_synthetic_ohlc(self) -> None:
        with patch.object(relay, "current_minute_jst", side_effect=["09:00", "09:02"]), patch.object(relay.time, "time", side_effect=[1_000.0, 1_120.0]):
            relay.update_candle_accum("285A", 100.0)
            relay.update_candle_accum("285A", 102.0)

        with relay.candle_accum_lock:
            retained_minutes = [minute for _, minute in sorted(relay.finalized_candle_buckets["285A"])]
        self.assertEqual(retained_minutes, ["09:00"])
        self.assertNotIn("09:01", retained_minutes)


if __name__ == "__main__":
    unittest.main()
