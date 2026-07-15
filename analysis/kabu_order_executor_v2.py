"""
kabu_order_executor_v2.py — 自動売買ローカル実行エンジン（安全機能強化版）

ローカルPC（Windows）で動作し、クラウドのorder_instructionsテーブルを
ポーリングして発注指示を取得・実行する。

v2 新機能（第1段階 安全機能5項目）:
  1. クラウド通信断時の新規エントリー停止
  2. 起動時の建玉同期（GET /positions）
  3. 発注後の約定確認（GET /orders）
  4. ローカル大引け強制決済（15:25〜15:29ループ）
  5. 建玉保有中の通信バックオフ短縮（30秒→2秒）

動作モード:
  - DRY_RUN = True (デフォルト): 実際の発注を行わず、ログに記録のみ
  - DRY_RUN = False: KABUステーションAPIに実際に発注する

本番移行手順:
  1. DRY_RUN = False に変更
  2. KABU_API_PASSWORD を設定
  3. KABUステーションを起動・ログイン済みにする
  4. 本スクリプトを起動

前提条件:
  - Python 3.11+ (C:\\Python314\\python.exe)
  - requests パッケージ (pip install requests)
  - KABUステーションが起動済み（本番時のみ）
  - クラウドアプリのURLが設定済み

起動方法:
  C:\\Python314\\python.exe kabu_order_executor_v2.py
"""

import requests
import time
import json
import sys
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ============================================================
# CONFIG
# ============================================================

# クラウドアプリのURL（tRPCエンドポイント）
CLOUD_APP_URL = "https://stockalert-ulxu9jpf.manus.space"
TRPC_BASE = f"{CLOUD_APP_URL}/api/trpc"

# KABUステーションAPI（ローカル）
KABU_API_URL = "http://localhost:18080/kabusapi"
KABU_API_URL_TEST = "http://localhost:18081/kabusapi"  # 検証用

# ドライランモード（True=実際の発注を行わない）
DRY_RUN = True

# KABUステーションAPIパスワード（トークン取得用）
KABU_API_PASSWORD = ""  # ← 本番時にここに設定

# ポーリング間隔（秒）
POLL_INTERVAL = 1.0

# 取引時間帯（JST）
TRADING_START = "08:55"
TRADING_END = "15:30"

# 日次損失上限（円）- ローカル側でも二重チェック
LOCAL_DAILY_LOSS_LIMIT = -100000

# ログファイルパス
LOG_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
LOG_FILE = LOG_DIR / f"executor_{datetime.now().strftime('%Y%m%d')}.log"

# --- v2 安全機能設定 ---

# クラウド通信断の閾値（秒）: この時間以上通信できなければ新規エントリー停止
CLOUD_DISCONNECT_THRESHOLD = 60

# kabu API通信断の閾値（秒）
KABU_API_DISCONNECT_THRESHOLD = 10

# 約定確認タイムアウト（秒）
ORDER_CONFIRM_TIMEOUT = 30

# 約定確認ポーリング間隔（秒）
ORDER_CONFIRM_INTERVAL = 1.0

# 大引け強制決済の開始時刻・終了時刻（JST）
FORCE_CLOSE_START = "15:25"
FORCE_CLOSE_END = "15:29"

# 大引け強制決済のチェック間隔（秒）
FORCE_CLOSE_CHECK_INTERVAL = 5

# 建玉保有中の通信エラー時バックオフ（秒）
BACKOFF_WITH_POSITIONS = 2
BACKOFF_WITHOUT_POSITIONS = 30

# ============================================================
# JST ヘルパー
# ============================================================

JST = timezone(timedelta(hours=9))


def now_jst() -> datetime:
    return datetime.now(JST)


def today_str() -> str:
    return now_jst().strftime("%Y-%m-%d")


# ============================================================
# ログ
# ============================================================

def log(msg: str, level: str = "INFO"):
    ts = now_jst().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ============================================================
# 通信状態トラッキング (v2)
# ============================================================

last_cloud_success_at: float = 0.0  # time.time() ベース
last_kabu_api_success_at: float = 0.0
local_emergency_stop: bool = False
local_emergency_stop_reason: str = ""


def is_cloud_connected() -> bool:
    """クラウドとの通信が正常か判定"""
    if last_cloud_success_at == 0:
        return False
    elapsed = time.time() - last_cloud_success_at
    return elapsed < CLOUD_DISCONNECT_THRESHOLD


def is_kabu_api_connected() -> bool:
    """kabu STATION APIとの通信が正常か判定"""
    if DRY_RUN:
        return True
    if last_kabu_api_success_at == 0:
        return False
    elapsed = time.time() - last_kabu_api_success_at
    return elapsed < KABU_API_DISCONNECT_THRESHOLD


def set_local_emergency_stop(reason: str):
    """ローカル緊急停止を設定"""
    global local_emergency_stop, local_emergency_stop_reason
    if not local_emergency_stop:
        local_emergency_stop = True
        local_emergency_stop_reason = reason
        log(f"⚠️ ローカル緊急停止発動: {reason}", "WARN")


def clear_local_emergency_stop():
    """ローカル緊急停止を解除"""
    global local_emergency_stop, local_emergency_stop_reason
    if local_emergency_stop:
        local_emergency_stop = False
        local_emergency_stop_reason = ""
        log("ローカル緊急停止解除")


# ============================================================
# クラウドAPI通信
# ============================================================

def trpc_query(procedure: str, input_data: dict) -> dict | None:
    """tRPC queryを呼び出す（GET）"""
    global last_cloud_success_at
    try:
        url = f"{TRPC_BASE}/{procedure}"
        # tRPC + superjson: inputを{"json": ...}でラップする
        params = {"input": json.dumps({"json": input_data})}
        resp = requests.get(url, params=params, timeout=10)
        if resp.status_code == 200:
            last_cloud_success_at = time.time()
            data = resp.json()
            # superjsonレスポンス: result.data.json が実データ
            result_data = data.get("result", {}).get("data", {})
            if isinstance(result_data, dict) and "json" in result_data:
                return result_data["json"]
            return result_data
        else:
            log(f"tRPC query失敗: {procedure} status={resp.status_code} body={resp.text[:200]}", "ERROR")
            return None
    except requests.exceptions.Timeout:
        log(f"tRPC queryタイムアウト: {procedure}", "WARN")
        return None
    except Exception as e:
        log(f"tRPC query例外: {procedure} - {e}", "ERROR")
        return None


def trpc_mutation(procedure: str, input_data: dict) -> dict | None:
    """tRPC mutationを呼び出す（POST）"""
    global last_cloud_success_at
    try:
        url = f"{TRPC_BASE}/{procedure}"
        # tRPC + superjson: {"json": input_data}でラップ
        resp = requests.post(url, json={"json": input_data}, timeout=10)
        if resp.status_code == 200:
            last_cloud_success_at = time.time()
            data = resp.json()
            result_data = data.get("result", {}).get("data", {})
            if isinstance(result_data, dict) and "json" in result_data:
                return result_data["json"]
            return result_data
        else:
            log(f"tRPC mutation失敗: {procedure} status={resp.status_code} body={resp.text[:200]}", "ERROR")
            return None
    except requests.exceptions.Timeout:
        log(f"tRPC mutationタイムアウト: {procedure}", "WARN")
        return None
    except Exception as e:
        log(f"tRPC mutation例外: {procedure} - {e}", "ERROR")
        return None


# ============================================================
# KABUステーションAPI
# ============================================================

kabu_token: str | None = None


def kabu_get_token() -> str | None:
    """KABUステーションAPIトークンを取得する"""
    global kabu_token, last_kabu_api_success_at
    if DRY_RUN:
        kabu_token = "DRY_RUN_TOKEN"
        last_kabu_api_success_at = time.time()
        return kabu_token

    try:
        resp = requests.post(
            f"{KABU_API_URL}/token",
            json={"APIPassword": KABU_API_PASSWORD},
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            kabu_token = data.get("Token")
            last_kabu_api_success_at = time.time()
            log(f"KABUトークン取得成功: {kabu_token[:8]}...")
            return kabu_token
        else:
            log(f"KABUトークン取得失敗: status={resp.status_code}", "ERROR")
            return None
    except Exception as e:
        log(f"KABUトークン取得例外: {e}", "ERROR")
        return None


def kabu_get_positions() -> list[dict]:
    """
    KABUステーションAPIから信用建玉一覧を取得する (v2)

    Returns:
        建玉リスト。各要素に ExecutionID, Symbol, Side, Qty, Price, LeavesQty, HoldQty 等
    """
    global last_kabu_api_success_at

    if DRY_RUN:
        log("  [DRY RUN] 建玉照会スキップ: 空リスト返却")
        last_kabu_api_success_at = time.time()
        return []

    if not kabu_token:
        log("建玉照会失敗: APIトークン未取得", "ERROR")
        return []

    try:
        resp = requests.get(
            f"{KABU_API_URL}/positions",
            params={"product": 2},  # 2=信用
            headers={"X-API-KEY": kabu_token},
            timeout=10,
        )
        if resp.status_code == 200:
            last_kabu_api_success_at = time.time()
            positions = resp.json()
            return positions if isinstance(positions, list) else []
        else:
            log(f"建玉照会HTTPエラー: status={resp.status_code}", "ERROR")
            return []
    except Exception as e:
        log(f"建玉照会例外: {e}", "ERROR")
        return []


def kabu_get_orders(order_id: str = None) -> list[dict]:
    """
    KABUステーションAPIから注文一覧を取得する (v2)

    Args:
        order_id: 特定のOrderIdで絞り込む場合に指定

    Returns:
        注文リスト
    """
    global last_kabu_api_success_at

    if DRY_RUN:
        last_kabu_api_success_at = time.time()
        return []

    if not kabu_token:
        return []

    try:
        params = {"product": 0}  # 0=全般
        resp = requests.get(
            f"{KABU_API_URL}/orders",
            params=params,
            headers={"X-API-KEY": kabu_token},
            timeout=10,
        )
        if resp.status_code == 200:
            last_kabu_api_success_at = time.time()
            orders = resp.json()
            if not isinstance(orders, list):
                return []
            if order_id:
                return [o for o in orders if o.get("ID") == order_id]
            return orders
        else:
            log(f"注文照会HTTPエラー: status={resp.status_code}", "ERROR")
            return []
    except Exception as e:
        log(f"注文照会例外: {e}", "ERROR")
        return []


def kabu_cancel_order(order_id: str) -> bool:
    """注文を取り消す"""
    global last_kabu_api_success_at

    if DRY_RUN:
        log(f"  [DRY RUN] 注文取消スキップ: OrderId={order_id}")
        last_kabu_api_success_at = time.time()
        return True

    if not kabu_token:
        return False

    try:
        resp = requests.put(
            f"{KABU_API_URL}/cancelorder",
            json={"OrderId": order_id},
            headers={"X-API-KEY": kabu_token},
            timeout=10,
        )
        if resp.status_code == 200:
            last_kabu_api_success_at = time.time()
            data = resp.json()
            if data.get("Result") == 0:
                log(f"  注文取消成功: OrderId={order_id}")
                return True
            else:
                log(f"  注文取消失敗: Result={data.get('Result')}", "ERROR")
                return False
        else:
            log(f"  注文取消HTTPエラー: status={resp.status_code}", "ERROR")
            return False
    except Exception as e:
        log(f"  注文取消例外: {e}", "ERROR")
        return False


def kabu_send_order(instruction: dict) -> dict:
    """
    KABUステーションAPIに発注する

    Returns:
        {"success": True, "orderId": "...", "message": "..."} or
        {"success": False, "orderId": None, "message": "エラー内容"}
    """
    global last_kabu_api_success_at

    if DRY_RUN:
        # ドライラン: 実際には発注しない
        log(f"  [DRY RUN] 発注スキップ: {instruction['symbol']} {instruction['oi_side']} "
            f"@{instruction['referencePrice']}円 ×{instruction['qty']}株")
        last_kabu_api_success_at = time.time()
        return {
            "success": True,
            "orderId": f"DRY_{now_jst().strftime('%H%M%S')}_{instruction['symbol']}",
            "message": "ドライラン: 実際の発注なし",
        }

    # 本番発注ロジック
    if not kabu_token:
        return {"success": False, "orderId": None, "message": "APIトークン未取得"}

    order_params = build_order_params(instruction)

    try:
        resp = requests.post(
            f"{KABU_API_URL}/sendorder",
            json=order_params,
            headers={"X-API-KEY": kabu_token},
            timeout=10,
        )
        if resp.status_code == 200:
            last_kabu_api_success_at = time.time()
            data = resp.json()
            if data.get("Result") == 0:
                order_id = data.get("OrderId", "")
                log(f"  発注受付成功: OrderId={order_id}")
                return {"success": True, "orderId": order_id, "message": "発注受付成功"}
            else:
                msg = f"API Result={data.get('Result')}"
                log(f"  発注失敗: {msg}", "ERROR")
                return {"success": False, "orderId": None, "message": msg}
        else:
            msg = f"HTTP {resp.status_code}: {resp.text[:100]}"
            log(f"  発注HTTPエラー: {msg}", "ERROR")
            return {"success": False, "orderId": None, "message": msg}
    except Exception as e:
        msg = f"発注例外: {e}"
        log(f"  {msg}", "ERROR")
        return {"success": False, "orderId": None, "message": msg}


def build_order_params(instruction: dict) -> dict:
    """
    order_instructionからKABUステーションAPI発注パラメータを構築する

    信用デイトレ（MarginTradeType=3）:
      - 新規: CashMargin=2, Side=買い"2"/売り"1"
      - 返済: CashMargin=3, Side=買い建玉返済"1"/売り建玉返済"2"
    """
    side = instruction["oi_side"]

    # Side と CashMargin の決定
    if side == "buy":
        api_side = "2"
        cash_margin = 2
    elif side == "short":
        api_side = "1"
        cash_margin = 2
    elif side == "sell":
        api_side = "1"
        cash_margin = 3
    elif side == "cover":
        api_side = "2"
        cash_margin = 3
    else:
        raise ValueError(f"Unknown side: {side}")

    params = {
        "Symbol": instruction["symbol"],
        "Exchange": 27,          # 東証+
        "SecurityType": 1,       # 株式
        "Side": api_side,
        "CashMargin": cash_margin,
        "MarginTradeType": 3,    # 一般信用（デイトレ）
        "DelivType": 2 if cash_margin == 3 else 0,
        "FundType": "11",
        "AccountType": 4,        # 特定口座
        "Qty": instruction["qty"],
        "FrontOrderType": 10,    # 成行
        "Price": 0,
        "ExpireDay": 0,
    }

    # 返済時は決済順序を指定（日付古い順・損益高い順）
    if cash_margin == 3:
        params["ClosePositionOrder"] = 0

    return params


# ============================================================
# 約定確認 (v2)
# ============================================================

def confirm_order_execution(order_id: str, expected_qty: int) -> dict:
    """
    発注後に約定を確認する (v2)

    GET /orders で注文状態を確認し、全約定を待つ。
    タイムアウト時は未約定として返す。

    Returns:
        {
            "filled": True/False,
            "cum_qty": int,        # 累計約定数量
            "avg_price": float,    # 平均約定価格
            "state": int,          # 注文状態
            "message": str,
        }
    """
    if DRY_RUN:
        return {
            "filled": True,
            "cum_qty": expected_qty,
            "avg_price": 0,  # ドライラン時は参照価格を使う
            "state": 5,
            "message": "ドライラン: 即約定と仮定",
        }

    start_time = time.time()
    last_state = 0
    last_cum_qty = 0

    while time.time() - start_time < ORDER_CONFIRM_TIMEOUT:
        orders = kabu_get_orders(order_id)
        if not orders:
            time.sleep(ORDER_CONFIRM_INTERVAL)
            continue

        order = orders[0]
        state = order.get("State", 0)
        cum_qty = order.get("CumQty", 0)
        order_qty = order.get("OrderQty", expected_qty)
        last_state = state
        last_cum_qty = cum_qty

        # 全約定確認
        if cum_qty >= order_qty:
            # 平均約定価格を計算（Detailsから）
            avg_price = _calc_avg_price(order)
            log(f"  約定確認完了: CumQty={cum_qty}/{order_qty} AvgPrice={avg_price:.1f}")
            return {
                "filled": True,
                "cum_qty": cum_qty,
                "avg_price": avg_price,
                "state": state,
                "message": "全約定確認",
            }

        # 注文が終了状態（取消・失効等）
        if state == 5 and cum_qty < order_qty:
            log(f"  注文終了（未全約定）: State=5, CumQty={cum_qty}/{order_qty}", "WARN")
            avg_price = _calc_avg_price(order) if cum_qty > 0 else 0
            return {
                "filled": cum_qty > 0,
                "cum_qty": cum_qty,
                "avg_price": avg_price,
                "state": state,
                "message": f"注文終了: 約定{cum_qty}/{order_qty}株",
            }

        time.sleep(ORDER_CONFIRM_INTERVAL)

    # タイムアウト
    log(f"  約定確認タイムアウト({ORDER_CONFIRM_TIMEOUT}秒): State={last_state}, CumQty={last_cum_qty}/{expected_qty}", "WARN")
    return {
        "filled": last_cum_qty >= expected_qty,
        "cum_qty": last_cum_qty,
        "avg_price": 0,
        "state": last_state,
        "message": f"タイムアウト: 約定{last_cum_qty}/{expected_qty}株",
    }


def _calc_avg_price(order: dict) -> float:
    """注文のDetailsから平均約定価格を計算"""
    details = order.get("Details", [])
    total_qty = 0
    total_value = 0.0
    for detail in details:
        # RecType=8 が約定
        if detail.get("RecType") == 8:
            qty = detail.get("Qty", 0)
            price = detail.get("Price", 0)
            if qty > 0 and price > 0:
                total_qty += qty
                total_value += qty * price
    if total_qty > 0:
        return total_value / total_qty
    # Detailsが取れない場合はorderのPriceを使用
    return float(order.get("Price", 0))


# ============================================================
# 起動時建玉同期 (v2)
# ============================================================

def sync_positions_on_startup() -> dict[str, dict]:
    """
    起動時にkabu STATION APIから実建玉を取得し、active_positionsを初期化する (v2)

    Returns:
        symbol -> position info のdict
    """
    positions = kabu_get_positions()
    synced: dict[str, dict] = {}

    if not positions:
        log("起動時建玉同期: 建玉なし（またはDRY RUN）")
        return synced

    for pos in positions:
        symbol = pos.get("Symbol", "")
        side_code = pos.get("Side", "")
        leaves_qty = pos.get("LeavesQty", 0)
        price = pos.get("Price", 0)
        hold_qty = pos.get("HoldQty", 0)

        if leaves_qty <= 0:
            continue

        # Side: "1"=売り建, "2"=買い建
        if side_code == "1":
            oi_side = "short"
        elif side_code == "2":
            oi_side = "buy"
        else:
            continue

        synced[symbol] = {
            "symbol": symbol,
            "oi_side": oi_side,
            "referencePrice": price,
            "qty": leaves_qty,
            "holdQty": hold_qty,
            "source": "startup_sync",
        }
        log(f"  建玉同期: {symbol} {oi_side} @{price}円 ×{leaves_qty}株 (拘束={hold_qty})")

    log(f"起動時建玉同期完了: {len(synced)}件")
    return synced


# ============================================================
# ローカル大引け強制決済 (v2)
# ============================================================

def local_force_close_loop():
    """
    15:25〜15:29にローカルから直接建玉を全返済する (v2)

    クラウドのforce_closeが来ていない場合のフェイルセーフ。
    建玉と未約定返済注文を照合し、返済注文がない建玉のみ成行返済する。
    """
    log("=" * 40)
    log("ローカル大引け強制決済ループ開始 (15:25〜15:29)")
    log("=" * 40)

    close_attempts = 0
    max_attempts = int((4 * 60) / FORCE_CLOSE_CHECK_INTERVAL)  # 4分間

    while close_attempts < max_attempts:
        current_time = now_jst().strftime("%H:%M")
        if current_time > FORCE_CLOSE_END:
            log("大引け強制決済: 15:29超過、ループ終了")
            break

        # 1. 実建玉を取得
        positions = kabu_get_positions()
        open_positions = [p for p in positions if p.get("LeavesQty", 0) > 0]

        if not open_positions:
            log("大引け強制決済: 建玉なし。完了。")
            break

        # 2. 未約定の返済注文を取得
        orders = kabu_get_orders()
        pending_close_orders: set[str] = set()
        for order in orders:
            # State: 1=待機, 2=処理中, 4=訂正取消送信中 → まだ有効
            state = order.get("State", 0)
            cash_margin = order.get("CashMargin", 0)
            symbol = order.get("Symbol", "")
            if state in (1, 2, 4) and cash_margin == 3:  # 信用返済で未約定
                pending_close_orders.add(symbol)

        # 3. 返済注文がなく建玉が残っている銘柄のみ成行返済
        for pos in open_positions:
            symbol = pos.get("Symbol", "")
            if symbol in pending_close_orders:
                log(f"  {symbol}: 既に返済注文中。スキップ。")
                continue

            side_code = pos.get("Side", "")
            leaves_qty = pos.get("LeavesQty", 0)

            if DRY_RUN:
                log(f"  [DRY RUN] 大引け強制決済: {symbol} Side={side_code} ×{leaves_qty}株")
            else:
                # 返済注文を発注
                close_instruction = {
                    "symbol": symbol,
                    "oi_side": "sell" if side_code == "2" else "cover",
                    "oi_instruction_type": "force_close",
                    "referencePrice": pos.get("CurrentPrice", pos.get("Price", 0)),
                    "qty": leaves_qty,
                }
                result = kabu_send_order(close_instruction)
                if result["success"]:
                    log(f"  大引け強制決済発注: {symbol} OrderId={result['orderId']}")
                else:
                    log(f"  大引け強制決済失敗: {symbol} - {result['message']}", "ERROR")

        close_attempts += 1
        time.sleep(FORCE_CLOSE_CHECK_INTERVAL)

    log("ローカル大引け強制決済ループ終了")


# ============================================================
# プリフライトチェック（発注前の検証）
# ============================================================

local_daily_pnl = 0
local_trade_count = 0
active_positions: dict[str, dict] = {}  # symbol -> instruction info


def preflight_check(instruction: dict) -> tuple[bool, str]:
    """
    発注前のチェック (v2 強化版)

    Returns:
        (passed: bool, reason: str)
    """
    global local_daily_pnl

    side = instruction["oi_side"]
    symbol = instruction["symbol"]
    instruction_type = instruction["oi_instruction_type"]

    # 1. ローカル緊急停止チェック
    if local_emergency_stop and instruction_type == "entry":
        return False, f"ローカル緊急停止中: {local_emergency_stop_reason}"

    # 2. クラウド通信断チェック (v2)
    if instruction_type == "entry" and not is_cloud_connected():
        elapsed = time.time() - last_cloud_success_at if last_cloud_success_at > 0 else 999
        return False, f"クラウド通信断({elapsed:.0f}秒): 新規エントリー停止"

    # 3. kabu API通信断チェック (v2)
    if not is_kabu_api_connected():
        elapsed = time.time() - last_kabu_api_success_at if last_kabu_api_success_at > 0 else 999
        return False, f"kabu API通信断({elapsed:.0f}秒)"

    # 4. 二重発注チェック
    if instruction_type == "entry" and symbol in active_positions:
        return False, f"二重発注防止: {symbol}に既存ポジションあり"

    # 5. 日次損失上限チェック（ローカル側）
    if instruction_type == "entry" and local_daily_pnl <= LOCAL_DAILY_LOSS_LIMIT:
        return False, f"日次損失上限到達(ローカル): {local_daily_pnl}円"

    # 6. KABUステーション接続チェック
    if not DRY_RUN and not kabu_token:
        return False, "KABUステーションAPIトークン未取得"

    # 7. 数量検証
    if instruction["qty"] <= 0 or instruction["qty"] > 1000:
        return False, f"異常な数量: {instruction['qty']}株"

    # 8. 指示鮮度チェック（entryのみ: 60秒以内か）
    if instruction_type == "entry":
        created_at = instruction.get("createdAt")
        if created_at:
            try:
                if isinstance(created_at, str):
                    created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                else:
                    created_dt = created_at
                age_seconds = (datetime.now(timezone.utc) - created_dt).total_seconds()
                if age_seconds > 60:
                    return False, f"指示期限切れ(ローカル判定): {age_seconds:.0f}秒経過"
            except Exception:
                pass

    # 9. 取引時間帯チェック
    current_time = now_jst().strftime("%H:%M")
    if current_time < TRADING_START or current_time > TRADING_END:
        if instruction_type == "entry":
            return False, f"取引時間外: {current_time}"
        # exit/force_closeは時間外でも許可

    # 10. 銘柄コード妥当性チェック
    if not symbol or len(symbol) < 4:
        return False, f"不正な銘柄コード: {symbol}"

    return True, "OK"


# ============================================================
# メイン処理
# ============================================================

def process_instruction(instruction: dict) -> None:
    """1つの発注指示を処理する (v2: 約定確認付き)"""
    global local_daily_pnl, local_trade_count

    instr_id = instruction["id"]
    symbol = instruction["symbol"]
    side = instruction["oi_side"]
    instruction_type = instruction["oi_instruction_type"]
    ref_price = instruction["referencePrice"]
    qty = instruction["qty"]
    reason = instruction.get("reason", "")[:60]

    log(f"指示受信: #{instr_id} {symbol} {side} {instruction_type} @{ref_price}円 ×{qty}株 ({reason})")

    # プリフライトチェック
    passed, check_reason = preflight_check(instruction)
    if not passed:
        log(f"  プリフライト不合格: {check_reason}", "WARN")
        trpc_mutation("trading.reportOrderExecution", {
            "instructionId": instr_id,
            "status": "failed",
            "errorMessage": f"プリフライト不合格: {check_reason}",
            "executorLog": {
                "preflightFailed": True,
                "reason": check_reason,
                "timestamp": now_jst().isoformat(),
                "dryRun": DRY_RUN,
            },
        })
        return

    # 発注実行
    log(f"  発注実行中... (DRY_RUN={DRY_RUN})")

    # 「sent」ステータスを報告
    trpc_mutation("trading.reportOrderExecution", {
        "instructionId": instr_id,
        "status": "sent",
        "executorLog": {
            "sentAt": now_jst().isoformat(),
            "dryRun": DRY_RUN,
        },
    })

    # KABUステーションAPIに発注
    result = kabu_send_order(instruction)

    if not result["success"]:
        log(f"  発注失敗: {result['message']}", "ERROR")
        trpc_mutation("trading.reportOrderExecution", {
            "instructionId": instr_id,
            "status": "failed",
            "errorMessage": result["message"],
            "executorLog": {
                "failedAt": now_jst().isoformat(),
                "dryRun": DRY_RUN,
                "message": result["message"],
            },
        })
        return

    # --- v2: 約定確認 ---
    order_id = result["orderId"]
    confirm_result = confirm_order_execution(order_id, qty)

    if not confirm_result["filled"]:
        # 全約定できなかった場合
        log(f"  約定未完了: {confirm_result['message']}", "WARN")
        # 未約定分があれば取消を試みる
        if not DRY_RUN and confirm_result["cum_qty"] < qty:
            kabu_cancel_order(order_id)

        if confirm_result["cum_qty"] == 0:
            # 1株も約定していない → 失敗として報告
            trpc_mutation("trading.reportOrderExecution", {
                "instructionId": instr_id,
                "status": "failed",
                "errorMessage": f"約定なし: {confirm_result['message']}",
                "executorLog": {
                    "failedAt": now_jst().isoformat(),
                    "dryRun": DRY_RUN,
                    "message": confirm_result["message"],
                    "orderId": order_id,
                },
            })
            return

    # 約定価格の決定
    if DRY_RUN:
        executed_price = float(ref_price)
    elif confirm_result["avg_price"] > 0:
        executed_price = confirm_result["avg_price"]
    else:
        executed_price = float(ref_price)

    executed_qty = confirm_result["cum_qty"] if not DRY_RUN else qty

    # PnL計算（決済時のみ）
    pnl = None
    if instruction_type in ("exit", "force_close") and symbol in active_positions:
        entry_info = active_positions[symbol]
        entry_price = float(entry_info["referencePrice"])
        entry_side = entry_info["oi_side"]
        if entry_side == "buy":
            pnl = int((executed_price - entry_price) * executed_qty)
        elif entry_side == "short":
            pnl = int((entry_price - executed_price) * executed_qty)
        local_daily_pnl += pnl if pnl else 0
        del active_positions[symbol]
        log(f"  決済完了: PnL={pnl:+d}円 (日次累計: {local_daily_pnl:+d}円)")
    elif instruction_type == "entry":
        active_positions[symbol] = instruction
        active_positions[symbol]["_executed_price"] = executed_price
        active_positions[symbol]["_order_id"] = order_id
        log(f"  エントリー完了: {symbol} {side} @{executed_price}円 (OrderId={order_id})")

    local_trade_count += 1

    trpc_mutation("trading.reportOrderExecution", {
        "instructionId": instr_id,
        "status": "executed",
        "kabuOrderId": order_id,
        "executedPrice": executed_price,
        "executedAt": now_jst().isoformat(),
        "pnl": pnl,
        "executorLog": {
            "executedAt": now_jst().isoformat(),
            "dryRun": DRY_RUN,
            "message": confirm_result["message"],
            "localDailyPnl": local_daily_pnl,
            "localTradeCount": local_trade_count,
            "cumQty": executed_qty,
            "avgPrice": executed_price,
            "orderId": order_id,
        },
    })


def main_loop():
    """メインポーリングループ (v2)"""
    global local_daily_pnl, local_trade_count, active_positions
    global last_cloud_success_at, last_kabu_api_success_at

    log("=" * 60)
    log(f"kabu_order_executor_v2.py 起動")
    log(f"  DRY_RUN: {DRY_RUN}")
    log(f"  CLOUD_APP_URL: {CLOUD_APP_URL}")
    log(f"  POLL_INTERVAL: {POLL_INTERVAL}秒")
    log(f"  TRADING_HOURS: {TRADING_START} - {TRADING_END}")
    log(f"  LOCAL_DAILY_LOSS_LIMIT: {LOCAL_DAILY_LOSS_LIMIT}円")
    log(f"  CLOUD_DISCONNECT_THRESHOLD: {CLOUD_DISCONNECT_THRESHOLD}秒")
    log(f"  ORDER_CONFIRM_TIMEOUT: {ORDER_CONFIRM_TIMEOUT}秒")
    log(f"  FORCE_CLOSE: {FORCE_CLOSE_START}〜{FORCE_CLOSE_END}")
    log(f"  LOG_FILE: {LOG_FILE}")
    log("=" * 60)

    # KABUステーションAPIトークン取得
    if not DRY_RUN:
        token = kabu_get_token()
        if not token:
            log("KABUステーションAPIトークン取得失敗。終了します。", "FATAL")
            sys.exit(1)
    else:
        kabu_get_token()  # DRY_RUN_TOKEN設定
        log("[DRY RUN] KABUステーションAPI接続スキップ")

    # --- v2: 起動時建玉同期 ---
    log("--- 起動時建玉同期 ---")
    active_positions = sync_positions_on_startup()

    # クラウド接続テスト
    trade_date = today_str()
    log(f"クラウド接続テスト... (tradeDate={trade_date})")
    test_result = trpc_query("trading.getAutoTradeStatus", {"tradeDate": trade_date})
    if test_result is None:
        log("クラウド接続失敗。URLを確認してください。", "FATAL")
        sys.exit(1)
    log(f"クラウド接続OK: tradingEnabled={test_result.get('tradingEnabled')}, "
        f"isDryRun={test_result.get('isDryRun')}")

    # メインループ
    consecutive_errors = 0
    last_status_log = time.time()
    force_close_executed = False

    while True:
        try:
            current_time = now_jst().strftime("%H:%M")
            trade_date = today_str()

            # --- v2: 大引け強制決済ループ (15:25〜15:29) ---
            if not force_close_executed and current_time >= FORCE_CLOSE_START and current_time <= FORCE_CLOSE_END:
                if active_positions:
                    log(f"建玉あり({len(active_positions)}件): ローカル大引け強制決済開始")
                    local_force_close_loop()
                    force_close_executed = True
                else:
                    log("大引け強制決済: 建玉なし。スキップ。")
                    force_close_executed = True

            # 取引時間外チェック
            if current_time < TRADING_START or current_time > TRADING_END:
                if current_time > TRADING_END:
                    log(f"取引時間終了 ({current_time})。本日の成績: PnL={local_daily_pnl:+d}円, 取引数={local_trade_count}")
                    break
                time.sleep(5)
                continue

            # pending指示をポーリング
            instructions = trpc_query("trading.getOrderInstructions", {"tradeDate": trade_date})

            if instructions is None:
                consecutive_errors += 1

                # --- v2: 建玉保有中はバックオフを短縮 ---
                if active_positions:
                    backoff = BACKOFF_WITH_POSITIONS
                else:
                    backoff = BACKOFF_WITHOUT_POSITIONS

                if consecutive_errors >= 5:
                    log(f"連続{consecutive_errors}回の通信エラー。{backoff}秒待機... "
                        f"(建玉={len(active_positions)}件)", "WARN")

                    # --- v2: 通信断が閾値超えたら新規エントリー停止 ---
                    if not is_cloud_connected():
                        elapsed = time.time() - last_cloud_success_at if last_cloud_success_at > 0 else 999
                        log(f"⚠️ クラウド通信断 {elapsed:.0f}秒: 新規エントリー停止中", "WARN")

                    time.sleep(backoff)
                    if consecutive_errors >= 30:
                        consecutive_errors = 0  # リセットして継続
                else:
                    time.sleep(POLL_INTERVAL)
                continue

            consecutive_errors = 0

            # 指示があれば処理
            if instructions:
                for instruction in instructions:
                    process_instruction(instruction)

            # 5分ごとにステータスログ
            if time.time() - last_status_log > 300:
                cloud_status = "OK" if is_cloud_connected() else "DISCONNECTED"
                kabu_status = "OK" if is_kabu_api_connected() else "DISCONNECTED"
                log(f"[STATUS] 稼働中 | PnL={local_daily_pnl:+d}円 | 取引数={local_trade_count} | "
                    f"ポジション={len(active_positions)}件 | Cloud={cloud_status} | "
                    f"KabuAPI={kabu_status} | 時刻={current_time}")
                last_status_log = time.time()

            time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            log("Ctrl+C検出。終了します。")
            break
        except Exception as e:
            log(f"メインループ例外: {e}", "ERROR")
            time.sleep(5)

    # 終了サマリー
    log("=" * 60)
    log(f"本日の最終成績:")
    log(f"  日次損益: {local_daily_pnl:+d}円")
    log(f"  取引回数: {local_trade_count}")
    log(f"  残ポジション: {len(active_positions)}件")
    if active_positions:
        for sym, pos in active_positions.items():
            log(f"    ⚠️ 未決済: {sym} {pos['oi_side']} @{pos['referencePrice']}円")
    log(f"  クラウド通信断回数: (last_success={last_cloud_success_at:.0f})")
    log("=" * 60)


# ============================================================
# エントリーポイント
# ============================================================

if __name__ == "__main__":
    try:
        main_loop()
    except Exception as e:
        log(f"致命的エラー: {e}", "FATAL")
        import traceback
        traceback.print_exc()
        sys.exit(1)
