"""
kabu STATION® API 板情報＋1分足中継スクリプト
=============================================

【動作環境】
- Windows PC（kabuステーション®が起動していること）
- Python 3.8以上
- 必要ライブラリ: pip install requests websocket-client

【使い方】
1. kabuステーション®を起動する
2. このスクリプトをWindowsのコマンドプロンプトで実行:
   python kabu_board_relay.py

【動作の流れ】
kabuステーション® (localhost:18080)
    ↓ WebSocket で板情報をリアルタイム受信（プッシュ型）
    ↓ REST API で1分足OHLCVを1分ごとにポーリング（プル型）
このスクリプト（Windows）
    ↓ HTTP POST でクラウドWebアプリに転送
クラウドWebアプリ（stockalert-mwf5hf9f.manus.space）
    ↓ 板情報キャッシュ + 1分足シグナル判定 + 架空取引記録
ブラウザ画面に表示
"""

import json
import hashlib
import os
import time
import threading
import uuid
import requests
import websocket
import logging
from datetime import datetime, timezone, timedelta
from relay_delivery_spool import RelayDeliverySpool, RelaySpoolCollisionError

# ===== 設定 =====

# kabuステーション® APIの設定
# 検証環境: 18081、本番環境: 18080
KABU_API_PORT = 18081  # 検証環境
KABU_API_BASE = f"http://localhost:{KABU_API_PORT}/kabusapi"

# kabu STATION APIパスワード（kabuステーションのAPIシステム設定で設定したもの）
KABU_API_PASSWORD = "YOUR_API_PASSWORD_HERE"  # ← ここに設定したパスワードを入力

# 監視する銘柄コード（証券コード）
# 現在のシステムで使用している銘柄
WATCH_SYMBOLS = [
    {"Symbol": "6976", "Exchange": 1},  # 太陽誘電（東証プライム）
    {"Symbol": "6981", "Exchange": 1},  # 村田製作所（東証プライム）
    {"Symbol": "3778", "Exchange": 1},  # さくらインターネット（東証プライム）
    {"Symbol": "3436", "Exchange": 1},  # SUMCO（東証プライム）
    {"Symbol": "6600", "Exchange": 1},  # キオクシアHD（東証プライム）
]

# 銘柄コードのリスト（1分足取得用）
SYMBOL_CODES = [s["Symbol"] for s in WATCH_SYMBOLS]

# クラウドWebアプリのURL
CLOUD_BASE_URL = "https://stockalert-mwf5hf9f.manus.space"
CLOUD_BOARD_URL = f"{CLOUD_BASE_URL}/api/trpc/trading.pushOrderBook"
CLOUD_CANDLE_URL = f"{CLOUD_BASE_URL}/api/trpc/trading.pushCandle"
CLOUD_CANDLE_WITH_BOARD_URL = f"{CLOUD_BASE_URL}/api/trpc/trading.pushCandleWithBoard"
CLOUD_MARKET_CONTEXT_URL = f"{CLOUD_BASE_URL}/api/trpc/trading.pushMarketContext"
# Windowsで実際に配備したファイルを確認した後だけ設定する。クラウド側で推測しない。
RELAY_VERSION = "kabu-board-relay-v6.0-durable-fifo"
RELAY_SOURCE_TREE_HASH = os.environ.get("STOCK_ALERT_RELAY_SOURCE_TREE_HASH", "unavailable")
RELAY_SPOOL_PATH = os.environ.get("STOCK_ALERT_RELAY_SPOOL_PATH", "kabu_relay_candle_outbox.sqlite3")
CANDLE_DELIVERY_MAX_BACKOFF_SECONDS = 30

# 選択器専用の市場環境。通常銘柄・売買engineへは送らない。
# 現物指数の登録可否に依存しないよう、公式APIで直近限月を解決できる日経225miniを使う。
MARKET_REFERENCE_FUTURE_CODE = "NK225mini"
MARKET_REFERENCE_EXCHANGE = 2  # 日通し。場中判定では09:00以降だけを使用する。

# 板情報の送信間隔（秒）- 同じ銘柄を連続送信しないためのレート制限
SEND_INTERVAL_SEC = 0.5

# 1分足のポーリング間隔（秒）- 毎分0秒から15秒後に取得
CANDLE_POLL_INTERVAL_SEC = 60

# 取引時間（JST）
MARKET_OPEN_TIME = "09:00"
MARKET_CLOSE_TIME = "15:30"
MARKET_CONTEXT_OPEN_TIME = "08:45"
MARKET_CONTEXT_CLOSE_TIME = "15:45"

# ===== ログ設定 =====
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("kabu_relay.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# ===== グローバル変数 =====
api_token = None
token_lock = threading.Lock()
last_send_time = {}  # 銘柄ごとの最終送信時刻

# 1分足の前回取得時刻（銘柄ごと）
# cloudが200応答を返すまで「送信済み」とは扱わない。
last_candle_time = {}  # symbol_time -> acknowledged epoch seconds

# 前向き監査: 同じ送信イベントの再試行では同じIDを再利用する。
relay_session_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
event_seq = 0
event_seq_lock = threading.Lock()
event_metadata_by_key = {}
# 1分足の累積OHLCV（銘柄ごと、1分間の集計用）
candle_accum = {}
# WebSocketで確定した実測minute bucket。HTTP送信workerとは分離し、scheduler遅延時も
# 古い未spool化bucketからFIFOで回収する。REST現在値による過去足の捏造は禁止する。
finalized_candle_buckets = {}
relay_gap_logged = set()
MAX_FINALIZED_CANDLE_BUCKETS_PER_SYMBOL = 480
candle_accum_lock = threading.RLock()
latest_board_by_symbol = {}
latest_board_lock = threading.RLock()
relay_spool = RelayDeliverySpool(RELAY_SPOOL_PATH)
candle_delivery_wakeup = threading.Event()
candle_delivery_thread_started = False
candle_delivery_thread_lock = threading.Lock()
market_context_reference = None
market_context_accum = None
last_market_context_time = {}


# ===== 日時ユーティリティ =====

JST = timezone(timedelta(hours=9))

def now_jst() -> datetime:
    """現在のJST時刻を返す"""
    return datetime.now(JST)

def today_jst_str() -> str:
    """今日のJST日付を YYYY-MM-DD 形式で返す"""
    return now_jst().strftime("%Y-%m-%d")

def current_minute_jst() -> str:
    """現在のJST時刻を HH:MM 形式で返す"""
    return now_jst().strftime("%H:%M")

def is_market_open() -> bool:
    """取引時間中かどうかを判定する"""
    t = current_minute_jst()
    return ("09:00" <= t <= "11:30") or ("12:30" <= t <= MARKET_CLOSE_TIME)

def is_regular_candle_minute(candle_time: str) -> bool:
    """昼休み・寄り前・引け後を架空の1分足として出力しない。"""
    return ("09:00" <= candle_time <= "11:29") or ("12:30" <= candle_time <= "15:24")
def is_market_context_open() -> bool:
    """日経225miniの日中立会時間かどうかを判定する。"""
    t = current_minute_jst()
    return MARKET_CONTEXT_OPEN_TIME <= t <= MARKET_CONTEXT_CLOSE_TIME

def candle_provenance(candle_time: str, value_source: str, tick_count=None,
                      first_tick_at_ms=None, last_tick_at_ms=None, fallback_reason=None) -> dict:
    """監査専用の生成元を、OHLC値を変更せずpayloadへ付与する。"""
    assembled_at_ms = int(time.time() * 1000)
    try:
        start = datetime.strptime(today_jst_str() + " " + candle_time, "%Y-%m-%d %H:%M").replace(tzinfo=JST)
        end = start + timedelta(minutes=1)
        bar_start = start.isoformat()
        bar_end = end.isoformat()
    except Exception:
        bar_start = None
        bar_end = None
    return {
        "relayVersion": RELAY_VERSION,
        "relaySourceTreeHash": RELAY_SOURCE_TREE_HASH,
        "rawCandleTime": candle_time,
        "barStartJst": bar_start,
        "barEndJst": bar_end,
        "valueSource": value_source,
        "tickCount": tick_count,
        "firstTickAtMs": first_tick_at_ms,
        "lastTickAtMs": last_tick_at_ms,
        "fallbackReason": fallback_reason,
        "isNoTrade": False if value_source == "ws_aggregated" else "unknown",
        "clockHealth": {
            "timezone": "JST",
            "ntpOffsetMs": None,
            "monotonicAnomaly": False,
            "websocketConnected": True,
            "websocketLastReceivedAtMs": last_tick_at_ms,
        },
        "relayAssembledAtMs": assembled_at_ms,
    }


# ===== APIトークン管理 =====

def get_api_token() -> str | None:
    """APIトークンを取得する"""
    try:
        response = requests.post(
            f"{KABU_API_BASE}/token",
            json={"APIPassword": KABU_API_PASSWORD},
            timeout=10,
        )
        if response.status_code == 200:
            token = response.json().get("Token")
            logger.info(f"APIトークン取得成功: {token[:8]}...")
            return token
        else:
            logger.error(f"APIトークン取得失敗: {response.status_code} {response.text}")
            return None
    except Exception as e:
        logger.error(f"APIトークン取得エラー: {e}")
        return None


def get_current_token() -> str | None:
    """スレッドセーフにトークンを取得する"""
    with token_lock:
        return api_token


# ===== 板情報（WebSocketプッシュ型） =====

def resolve_market_context_reference(token: str) -> dict | None:
    """日経225miniの直近限月を起動時に解決し、限月交代を固定コード化しない。"""
    try:
        response = requests.get(
            f"{KABU_API_BASE}/symbolname/future",
            params={"FutureCode": MARKET_REFERENCE_FUTURE_CODE, "DerivMonth": 0},
            headers={"X-API-KEY": token},
            timeout=10,
        )
        if response.status_code != 200:
            logger.error(f"市場環境銘柄コード取得失敗: {response.status_code} {response.text[:200]}")
            return None
        symbol = str(response.json().get("Symbol", ""))
        if not symbol:
            logger.error("市場環境銘柄コード取得失敗: Symbolなし")
            return None
        detail_response = requests.get(
            f"{KABU_API_BASE}/symbol/{symbol}@{MARKET_REFERENCE_EXCHANGE}",
            params={"addinfo": "true"},
            headers={"X-API-KEY": token},
            timeout=10,
        )
        detail = detail_response.json() if detail_response.status_code == 200 else {}
        raw_contract_month = detail.get("DerivMonth")
        contract_month = str(raw_contract_month) if raw_contract_month is not None else None
        if contract_month and contract_month.isdigit() and len(contract_month) == 6:
            contract_month = contract_month[:4] + "/" + contract_month[4:]
        if contract_month and (len(contract_month) != 7 or contract_month[4] != "/"):
            contract_month = None
        return {
            "Symbol": symbol,
            "Exchange": MARKET_REFERENCE_EXCHANGE,
            "instrumentKey": "nikkei225_mini_front",
            "productType": "future",
            "marketSession": "day_night",
            "contractMonth": contract_month,
            "symbolName": detail.get("SymbolName") or response.json().get("SymbolName") or "日経225mini",
        }
    except Exception as e:
        logger.error(f"市場環境銘柄コード取得エラー: {e}")
        return None


def register_push_symbols(token: str) -> bool:
    """板情報のプッシュ配信を登録する"""
    try:
        symbols = list(WATCH_SYMBOLS)
        if market_context_reference:
            symbols.append({
                "Symbol": market_context_reference["Symbol"],
                "Exchange": market_context_reference["Exchange"],
            })
        response = requests.put(
            f"{KABU_API_BASE}/register",
            headers={"X-API-KEY": token},
            json={"Symbols": symbols},
            timeout=10,
        )
        if response.status_code == 200:
            logger.info(f"通常{len(WATCH_SYMBOLS)}銘柄＋市場環境{1 if market_context_reference else 0}銘柄のPUSH配信を登録しました")
            return True
        else:
            logger.error(f"プッシュ配信登録失敗: {response.status_code} {response.text}")
            return False
    except Exception as e:
        logger.error(f"プッシュ配信登録エラー: {e}")
        return False


def parse_board_data(raw: dict) -> dict | None:
    """kabu STATION APIの板データをWebアプリ用に変換する"""
    try:
        symbol = str(raw.get("Symbol", ""))
        if not symbol:
            return None

        # 売気配（Sell1〜Sell10）を変換
        asks = []
        for i in range(1, 11):
            sell = raw.get(f"Sell{i}", {})
            if isinstance(sell, dict):
                price = sell.get("Price", 0)
                qty = sell.get("Qty", 0)
            else:
                price = raw.get(f"Sell{i}Price", 0)
                qty = raw.get(f"Sell{i}Qty", 0)
            if price and price > 0:
                asks.append({"price": float(price), "qty": int(qty)})

        # 買気配（Buy1〜Buy10）を変換
        bids = []
        for i in range(1, 11):
            buy = raw.get(f"Buy{i}", {})
            if isinstance(buy, dict):
                price = buy.get("Price", 0)
                qty = buy.get("Qty", 0)
            else:
                price = raw.get(f"Buy{i}Price", 0)
                qty = raw.get(f"Buy{i}Qty", 0)
            if price and price > 0:
                bids.append({"price": float(price), "qty": int(qty)})

        return {
            "symbol": symbol,
            "symbolName": str(raw.get("SymbolName", symbol)),
            "currentPrice": float(raw.get("CurrentPrice", 0)),
            "currentPriceTime": str(raw.get("CurrentPriceTime", "")),
            "asks": asks,
            "bids": bids,
            "marketOrderSellQty": int(raw.get("MarketOrderSellQty", 0)),
            "marketOrderBuyQty": int(raw.get("MarketOrderBuyQty", 0)),
            "overSellQty": int(raw.get("OverSellQty", 0)),
            "underBuyQty": int(raw.get("UnderBuyQty", 0)),
            "vwap": float(raw.get("VWAP", 0)),
        }
    except Exception as e:
        logger.error(f"板データ変換エラー: {e}")
        return None


def send_board_to_cloud(board_data: dict) -> bool:
    """板情報をクラウドWebアプリに送信する"""
    symbol = board_data.get("symbol", "")

    # レート制限チェック
    now = time.time()
    if symbol in last_send_time:
        elapsed = now - last_send_time[symbol]
        if elapsed < SEND_INTERVAL_SEC:
            return True  # スキップ（エラーではない）

    try:
        # tRPC形式でPOST送信
        response = requests.post(
            CLOUD_BOARD_URL,
            json={"json": board_data},
            headers={"Content-Type": "application/json"},
            timeout=5,
        )
        if response.status_code == 200:
            last_send_time[symbol] = now
            logger.debug(f"板情報送信成功: {symbol} 現値={board_data.get('currentPrice')}")
            return True
        else:
            logger.warning(f"板情報送信失敗: {symbol} {response.status_code}")
            return False
    except Exception as e:
        logger.error(f"板情報送信エラー: {symbol} {e}")
        return False


def on_message(ws, message):
    """WebSocketからメッセージを受信したとき"""
    try:
        raw = json.loads(message)
        if market_context_reference and str(raw.get("Symbol", "")) == market_context_reference["Symbol"]:
            update_market_context_accum(raw)
            return
        board_data = parse_board_data(raw)
        if board_data:
            with latest_board_lock:
                latest_board_by_symbol[board_data["symbol"]] = board_data
            # 別スレッドで非同期送信（WebSocketをブロックしない）
            threading.Thread(
                target=send_board_to_cloud,
                args=(board_data,),
                daemon=True,
            ).start()

            # 板情報から現在値を取得して1分足累積データを更新
            symbol = board_data.get("symbol", "")
            price = board_data.get("currentPrice", 0)
            if symbol and price > 0:
                update_candle_accum(symbol, price)

    except json.JSONDecodeError:
        pass  # 非JSONメッセージは無視


def on_error(ws, error):
    """WebSocketエラー"""
    logger.error(f"WebSocketエラー: {error}")


def on_close(ws, close_status_code, close_msg):
    """WebSocket切断"""
    logger.warning(f"WebSocket切断: {close_status_code} {close_msg}")


def on_open(ws):
    """WebSocket接続確立"""
    logger.info("WebSocket接続確立 - 板情報の受信を開始します")


def start_websocket(token: str):
    """WebSocketで板情報をリアルタイム受信する"""
    ws_url = f"ws://localhost:{KABU_API_PORT}/kabusapi/websocket"

    ws = websocket.WebSocketApp(
        ws_url,
        header={"X-API-KEY": token},
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )

    logger.info(f"WebSocket接続中: {ws_url}")
    ws.run_forever(ping_interval=30, ping_timeout=10)


# ===== 1分足OHLCV（WebSocket板情報から集計） =====

def update_candle_accum(symbol: str, price: float):
    """
    板情報の現在値から1分足OHLCVを累積する。
    毎分0秒になったら前の分の足を確定して送信する。
    """
    current_minute = current_minute_jst()
    tick_at_ms = int(time.time() * 1000)
    with candle_accum_lock:
        if symbol not in candle_accum:
            candle_accum[symbol] = {
                "open": price, "high": price, "low": price, "close": price,
                "volume": 0, "minute": current_minute, "tradeDate": today_jst_str(), "tickCount": 1,
                "firstTickAtMs": tick_at_ms, "lastTickAtMs": tick_at_ms,
            }
            return
        accum = candle_accum[symbol]
        if accum["minute"] != current_minute:
            # WebSocket callbackは送信を開始せず、確定bucketを銘柄ごとの複数minute bufferへ残す。
            # 次のtickが来ないminuteはOHLCを推測せず、polling側でgapとして監査する。
            if is_regular_candle_minute(accum["minute"]):
                buckets = finalized_candle_buckets.setdefault(symbol, {})
                buckets[(accum.get("tradeDate") or today_jst_str(), accum["minute"])] = dict(accum)
                while len(buckets) > MAX_FINALIZED_CANDLE_BUCKETS_PER_SYMBOL:
                    oldest = sorted(buckets)[0]
                    logger.error("確定1分足buffer上限。未spool実測bucketを明示gapとして破棄: %s %s", symbol, oldest)
                    del buckets[oldest]
            candle_accum[symbol] = {
                "open": price, "high": price, "low": price, "close": price,
                "volume": 0, "minute": current_minute, "tradeDate": today_jst_str(), "tickCount": 1,
                "firstTickAtMs": tick_at_ms, "lastTickAtMs": tick_at_ms,
            }
        else:
            accum["high"] = max(accum["high"], price)
            accum["low"] = min(accum["low"], price)
            accum["close"] = price
            accum["tickCount"] = int(accum.get("tickCount", 0)) + 1
            accum["lastTickAtMs"] = tick_at_ms


def update_market_context_accum(raw: dict):
    """日経225miniのPUSHを市場環境専用1分足へ集約する。"""
    global market_context_accum
    price = float(raw.get("CurrentPrice", 0) or 0)
    if price <= 0 or not market_context_reference:
        return
    current_minute = current_minute_jst()
    observed_at_ms = int(time.time() * 1000)
    if market_context_accum and market_context_accum["minute"] != current_minute:
        previous = market_context_accum
        candle = {
            "instrumentKey": market_context_reference["instrumentKey"],
            "providerSymbol": market_context_reference["Symbol"],
            "productType": market_context_reference["productType"],
            "contractMonth": market_context_reference.get("contractMonth"),
            "marketSession": market_context_reference["marketSession"],
            "tradeDate": today_jst_str(),
            "candleTime": previous["minute"],
            "open": previous["open"],
            "high": previous["high"],
            "low": previous["low"],
            "close": previous["close"],
            "volume": None,
            "previousClose": previous.get("previousClose"),
            "observedAtMs": previous["observedAtMs"],
            "valueSource": "ws_aggregated",
        }
        threading.Thread(target=send_market_context_to_cloud, args=(candle,), daemon=True).start()
        market_context_accum = None
    if market_context_accum is None:
        market_context_accum = {
            "minute": current_minute,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "previousClose": float(raw.get("PreviousClose", 0) or 0) or None,
            "observedAtMs": observed_at_ms,
            "valueSource": "rest_fallback",
        }
    else:
        market_context_accum["high"] = max(market_context_accum["high"], price)
        market_context_accum["low"] = min(market_context_accum["low"], price)
        market_context_accum["close"] = price
        market_context_accum["observedAtMs"] = observed_at_ms
        if market_context_accum.get("previousClose") is None:
            market_context_accum["previousClose"] = float(raw.get("PreviousClose", 0) or 0) or None


def send_market_context_to_cloud(candle_data: dict) -> bool:
    """市場環境専用endpointへ送り、通常pushCandleを決して呼ばない。"""
    key = f"{candle_data.get('instrumentKey')}_{candle_data.get('tradeDate')}_{candle_data.get('candleTime')}"
    if key in last_market_context_time:
        return True
    payload = {**candle_data}
    audit_key = "market_" + key
    with event_seq_lock:
        global event_seq
        metadata = event_metadata_by_key.get(audit_key)
        if metadata is None:
            event_seq += 1
            canonical = json.dumps(candle_data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            metadata = {
                "sourceEventId": f"{relay_session_id}:market:{event_seq}",
                "relaySessionId": relay_session_id,
                "eventSeq": event_seq,
                "payloadHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            }
            event_metadata_by_key[audit_key] = metadata
    payload.update(metadata)
    payload["relaySentAtMs"] = int(time.time() * 1000)
    try:
        response = requests.post(
            CLOUD_MARKET_CONTEXT_URL,
            json={"json": payload},
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if response.status_code == 200:
            last_market_context_time[key] = time.time()
            logger.info(f"市場環境1分足送信成功: {candle_data.get('candleTime')} C={candle_data.get('close')}")
            return True
        logger.warning(f"市場環境1分足送信失敗: {response.status_code} {response.text[:200]}")
        return False
    except Exception as e:
        logger.error(f"市場環境1分足送信エラー: {e}")
        return False


def fetch_market_context_from_api(token: str, candle_time: str) -> dict | None:
    """PUSH欠損時に1回だけRESTで補完する。"""
    if not market_context_reference:
        return None
    try:
        response = requests.get(
            f"{KABU_API_BASE}/board/{market_context_reference['Symbol']}@{MARKET_REFERENCE_EXCHANGE}",
            headers={"X-API-KEY": token},
            timeout=5,
        )
        if response.status_code != 200:
            return None
        raw = response.json()
        price = float(raw.get("CurrentPrice", 0) or 0)
        if price <= 0:
            return None
        observed_at_ms = int(time.time() * 1000)
        return {
            "instrumentKey": market_context_reference["instrumentKey"],
            "providerSymbol": market_context_reference["Symbol"],
            "productType": market_context_reference["productType"],
            "contractMonth": market_context_reference.get("contractMonth"),
            "marketSession": market_context_reference["marketSession"],
            "tradeDate": today_jst_str(),
            "candleTime": candle_time,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": None,
            "previousClose": float(raw.get("PreviousClose", 0) or 0) or None,
            "observedAtMs": observed_at_ms,
        }
    except Exception as e:
        logger.error(f"市場環境REST補完エラー: {e}")
        return None


def fetch_candle_from_api(symbol: str, token: str) -> dict | None:
    """
    kabu STATION APIの /kabusapi/board エンドポイントから現在の板情報を取得し、
    1分足として使用する（WebSocket補完用）。
    """
    try:
        response = requests.get(
            f"{KABU_API_BASE}/board/{symbol}@1",  # @1 = 東証プライム
            headers={"X-API-KEY": token},
            timeout=5,
        )
        if response.status_code == 200:
            data = response.json()
            price = float(data.get("CurrentPrice", 0))
            if price > 0:
                return {
                    "symbol": symbol,
                    "tradeDate": today_jst_str(),
                    "candleTime": current_minute_jst(),
                    "open": price,
                    "high": price,
                    "low": price,
                    "close": price,
                    "volume": int(data.get("TradingVolume", 0)),
                }
        return None
    except Exception as e:
        logger.error(f"板情報REST取得エラー: {symbol} {e}")
        return None


def _ensure_candle_delivery_worker():
    """WebSocket/polling producerとHTTP送信を分離し、workerは一つだけにする。"""
    global candle_delivery_thread_started
    with candle_delivery_thread_lock:
        if candle_delivery_thread_started:
            return
        candle_delivery_thread_started = True
        threading.Thread(target=_candle_delivery_loop, daemon=True, name="candle-delivery-fifo").start()


def _candle_delivery_loop():
    """HTTP 200 ACKまでFIFO先頭を保持し、後続イベントを追い越させない。"""
    while True:
        item = relay_spool.head()
        if item is None:
            candle_delivery_wakeup.wait(timeout=1.0)
            candle_delivery_wakeup.clear()
            continue
        now_ms = int(time.time() * 1000)
        if item.retry_after_ms is not None and item.retry_after_ms > now_ms:
            candle_delivery_wakeup.wait(timeout=min((item.retry_after_ms - now_ms) / 1000.0, 1.0))
            candle_delivery_wakeup.clear()
            continue
        attempted = relay_spool.record_attempt(item.source_event_id)
        payload = {**attempted.payload, "relaySentAtMs": int(time.time() * 1000)}
        try:
            board = payload.pop("board", None)
            # Existing pushOrderBook cache is refreshed immediately before the
            # normal pushCandle endpoint.  This preserves the no-OrderBridge
            # source-event path while failing closed when board refresh fails.
            if board and not send_board_to_cloud(board):
                raise RuntimeError("board_cache_unacknowledged")
            response = requests.post(
                CLOUD_CANDLE_URL,
                json={"json": payload},
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
            if response.status_code != 200:
                raise RuntimeError(f"http_{response.status_code}")
            relay_spool.mark_delivered(attempted.source_event_id)
            last_candle_time[f"{attempted.symbol}_{attempted.trade_date}_{attempted.candle_time}"] = time.time()
            logger.info("1分足ACK: %s %s seq=%s attempts=%s", attempted.symbol, attempted.candle_time, attempted.event_seq, attempted.attempt_count)
        except Exception as error:
            retry_seconds = min(CANDLE_DELIVERY_MAX_BACKOFF_SECONDS, 2 ** min(attempted.attempt_count, 5))
            relay_spool.mark_failed(attempted.source_event_id, str(error), int(time.time() * 1000) + retry_seconds * 1000)
            logger.warning("1分足未ACK。FIFO先頭を再送: %s %s seq=%s retry=%ss error=%s", attempted.symbol, attempted.candle_time, attempted.event_seq, retry_seconds, str(error)[:160])


def send_candle_to_cloud(candle_data: dict, board_data: dict | None = None) -> bool:
    """送信ではなく耐久outboxへの保存を完了条件にする。"""
    symbol = candle_data.get("symbol", "")
    candle_time = candle_data.get("candleTime", "")

    # 重複送信チェック（同じ銘柄・同じ分は1回だけ送信）
    key = f"{symbol}_{candle_data.get('tradeDate', '')}_{candle_time}"
    if key in last_candle_time:
        return True  # 既に送信済み

    payload = {**candle_data}
    if board_data:
        payload["board"] = board_data
    audit_key = candle_data.get("tradeDate", "") + "_" + key
    with event_seq_lock:
        global event_seq
        metadata = event_metadata_by_key.get(audit_key)
        if metadata is None:
            event_seq += 1
            received_at_ms = int(time.time() * 1000)
            canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            metadata = {
                "sourceEventId": relay_session_id + ":" + str(event_seq),
                "relaySessionId": relay_session_id,
                "eventSeq": event_seq,
                "payloadHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                "relayReceivedAtMs": received_at_ms,
            }
            event_metadata_by_key[audit_key] = metadata
    payload.update(metadata)
    try:
        item, inserted = relay_spool.enqueue(payload)
        _ensure_candle_delivery_worker()
        candle_delivery_wakeup.set()
        logger.info("1分足outbox%s: %s %s seq=%s source=%s", "追加" if inserted else "再利用", symbol, candle_time, item.event_seq, item.source_event_id)
        return True
    except RelaySpoolCollisionError as error:
        logger.error("1分足outbox衝突。内容が異なる再送を拒否: %s", str(error))
        return False
    except Exception as error:
        logger.error(f"1分足outbox保存エラー: {symbol} {candle_time} {error}")
        return False


def candle_polling_loop():
    """
    1分ごとに全銘柄の1分足を送信するポーリングループ。
    WebSocketの板情報から累積したOHLCVを毎分送信する補完機能。
    板情報が届いていない銘柄はREST APIで取得する。
    """
    logger.info("1分足ポーリングループ開始")

    while True:
        try:
            now = now_jst()
            current_min = now.strftime("%H:%M")

            # 取引時間外はスキップ
            if not is_market_open():
                time.sleep(30)
                continue

            # 毎分15秒後に実行（前の分の足が確定してから送信）
            # 例: 09:01:15 に 09:01 の足を送信
            seconds = now.second
            if seconds < 15:
                time.sleep(15 - seconds)
                continue

            # 前の分の時刻を計算。schedulerが遅延しても下のfinalized bufferを全件FIFO回収する。
            prev_minute_dt = now - timedelta(minutes=1)
            prev_minute = prev_minute_dt.strftime("%H:%M")
            trade_date = prev_minute_dt.strftime("%Y-%m-%d")

            # 全銘柄のWebSocket確定済み1分足を耐久outboxへ保存する。過去minuteを
            # REST現在値で合成せず、実測bucketだけをspoolへ渡す。
            for symbol in SYMBOL_CODES:
                with candle_accum_lock:
                    buckets = finalized_candle_buckets.get(symbol, {})
                    finalized = [(key, dict(buckets[key])) for key in sorted(buckets)]
                for (bucket_trade_date, bucket_minute), accum in finalized:
                    key = f"{symbol}_{bucket_trade_date}_{bucket_minute}"
                    if key in last_candle_time:
                        with candle_accum_lock:
                            finalized_candle_buckets.get(symbol, {}).pop((bucket_trade_date, bucket_minute), None)
                        continue
                    candle = {
                        "symbol": symbol,
                        "tradeDate": bucket_trade_date,
                        "candleTime": bucket_minute,
                        "open": accum["open"],
                        "high": accum["high"],
                        "low": accum["low"],
                        "close": accum["close"],
                        "volume": accum["volume"],
                        "provenance": candle_provenance(
                            prev_minute, "ws_aggregated", accum.get("tickCount"),
                            accum.get("firstTickAtMs"), accum.get("lastTickAtMs"),
                        ),
                    }
                    with latest_board_lock:
                        board = latest_board_by_symbol.get(symbol)
                    if send_candle_to_cloud(candle, board):
                        with candle_accum_lock:
                            finalized_candle_buckets.get(symbol, {}).pop((bucket_trade_date, bucket_minute), None)

                # 15秒を過ぎても直前minuteに実測bucketが無ければ、値を捏造せずgapを一度だけ記録する。
                gap_key = f"{symbol}_{trade_date}_{prev_minute}"
                if is_regular_candle_minute(prev_minute) and gap_key not in relay_gap_logged:
                    with candle_accum_lock:
                        has_finalized = (trade_date, prev_minute) in finalized_candle_buckets.get(symbol, {})
                    if not has_finalized and f"{symbol}_{prev_minute}" not in last_candle_time:
                        relay_gap_logged.add(gap_key)
                        logger.warning("1分足実測bucket欠損（OHLC非生成）: %s %s %s", symbol, trade_date, prev_minute)

            # 次の分まで待機（次の分の15秒後まで）
            now2 = now_jst()
            next_send = now2.replace(second=15, microsecond=0) + timedelta(minutes=1)
            wait_sec = (next_send - now2).total_seconds()
            if wait_sec > 0:
                time.sleep(min(wait_sec, 60))

        except Exception as e:
            logger.error(f"1分足ポーリングエラー: {e}")
            time.sleep(10)


def market_context_polling_loop():
    """通常銘柄とは別スレッドで、日経225miniを毎分1件まで補完送信する。"""
    logger.info("市場環境1分足ポーリングループ開始")
    while True:
        try:
            now = now_jst()
            if not is_market_context_open() or not market_context_reference:
                time.sleep(15)
                continue
            if now.second < 15:
                time.sleep(15 - now.second)
                continue
            prev_minute = (now - timedelta(minutes=1)).strftime("%H:%M")
            key = f"nikkei225_mini_front_{today_jst_str()}_{prev_minute}"
            if key not in last_market_context_time:
                candle = None
                if market_context_accum and market_context_accum.get("minute") == prev_minute:
                    candle = {
                        "instrumentKey": market_context_reference["instrumentKey"],
                        "providerSymbol": market_context_reference["Symbol"],
                        "productType": market_context_reference["productType"],
                        "contractMonth": market_context_reference.get("contractMonth"),
                        "marketSession": market_context_reference["marketSession"],
                        "tradeDate": today_jst_str(),
                        "candleTime": prev_minute,
                        "open": market_context_accum["open"],
                        "high": market_context_accum["high"],
                        "low": market_context_accum["low"],
                        "close": market_context_accum["close"],
                        "volume": None,
                        "previousClose": market_context_accum.get("previousClose"),
                        "observedAtMs": market_context_accum["observedAtMs"],
                        "valueSource": "ws_aggregated",
                    }
                if candle is None:
                    token = get_current_token()
                    candle = fetch_market_context_from_api(token, prev_minute) if token else None
                if candle:
                    send_market_context_to_cloud(candle)
            now2 = now_jst()
            next_send = now2.replace(second=15, microsecond=0) + timedelta(minutes=1)
            time.sleep(max(1, min((next_send - now2).total_seconds(), 60)))
        except Exception as e:
            logger.error(f"市場環境1分足ポーリングエラー: {e}")
            time.sleep(10)


def main():
    """メイン処理"""
    global api_token, market_context_reference
    logger.info("=" * 60)
    logger.info("kabu STATION® API 板情報＋1分足中継スクリプト %s 起動", RELAY_VERSION)
    logger.info("provenance: relayVersion=%s / relaySourceTreeHash=%s", RELAY_VERSION, RELAY_SOURCE_TREE_HASH)
    logger.info("delivery: SQLite FIFO outbox / HTTP 200 ACK only / no candle leapfrogging")
    logger.info("delivery: WS aggregated / REST fallback provenance is explicit; lunch synthetic candles are disabled")
    logger.info(f"監視銘柄: {SYMBOL_CODES}")
    logger.info(f"板情報送信先: {CLOUD_BOARD_URL}")
    logger.info(f"1分足送信先: {CLOUD_CANDLE_URL}")
    logger.info(f"市場環境送信先: {CLOUD_MARKET_CONTEXT_URL}")
    logger.info("=" * 60)

    _ensure_candle_delivery_worker()
    logger.info("1分足FIFO送信worker起動完了: spool=%s", os.path.abspath(RELAY_SPOOL_PATH))
    # 1分足ポーリングスレッドを起動
    candle_thread = threading.Thread(target=candle_polling_loop, daemon=True)
    candle_thread.start()
    logger.info("1分足ポーリングスレッド起動完了")

    market_context_thread = threading.Thread(target=market_context_polling_loop, daemon=True)
    market_context_thread.start()
    logger.info("市場環境ポーリングスレッド起動完了")

    while True:
        # Step 1: APIトークンを取得
        logger.info("APIトークンを取得中...")
        token = get_api_token()
        if not token:
            logger.error("トークン取得失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        with token_lock:
            api_token = token

        # Step 2: 市場環境用の直近限月を解決（失敗時も通常10銘柄は継続）
        market_context_reference = resolve_market_context_reference(token)
        if market_context_reference:
            logger.info(
                f"市場環境銘柄: {market_context_reference['symbolName']} "
                f"({market_context_reference['Symbol']}, {market_context_reference.get('contractMonth')})"
            )
        else:
            logger.warning("市場環境銘柄を解決できません。通常銘柄だけで継続します")

        # Step 3: プッシュ配信を登録
        if not register_push_symbols(token):
            logger.error("プッシュ配信登録失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        # Step 4: WebSocketで板情報を受信（切断されるまでブロック）
        logger.info("板情報の受信を開始します...")
        start_websocket(token)

        # WebSocketが切断された場合、10秒後に再接続
        logger.warning("WebSocket切断。10秒後に再接続します...")
        time.sleep(10)


if __name__ == "__main__":
    main()
