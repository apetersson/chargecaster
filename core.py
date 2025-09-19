"""Core utilities for batteryctl price-based decisions."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import math
import secrets
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests
import yaml
from requests.utils import parse_dict_header

DEFAULT_CONFIG = Path("config.yaml")
DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata"
SOC_STEPS = 100


def grid_fee(cfg: Dict[str, Any]) -> float:
    price_cfg = cfg.get("price", {}) if isinstance(cfg, dict) else {}
    value = price_cfg.get("grid_fee_eur_per_kwh")
    if value is None:
        value = price_cfg.get("network_tariff_eur_per_kwh")  # backwards compat
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def write_json_atomic(path: str | Path, payload: Dict[str, Any]) -> None:
    """Persist payload to ``path`` atomically, creating folders when required."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.with_suffix(target.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)
    tmp_path.replace(target)


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat()


def load_cfg(path: str | Path | None = None) -> Dict[str, Any]:
    cfg_path = Path(path or DEFAULT_CONFIG)
    with cfg_path.open("r") as handle:
        return yaml.safe_load(handle)


STATE_FIELDS = [
    "timestamp",
    "action",
    "target_soc",
    "reason",
    "price_snapshot",
    "soc",
    "applied",
]


def append_state_record(path: str | Path, record: Dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    file_exists = p.exists()

    if file_exists:
        try:
            with p.open("r", newline="") as handle:
                preview = handle.read(256)
            first_non_ws = next((c for c in preview if not c.isspace()), "")
            if first_non_ws in {"{", "["}:
                backup = p.with_suffix(p.suffix + ".bak")
                counter = 1
                while backup.exists():
                    backup = p.with_suffix(p.suffix + f".bak{counter}")
                    counter += 1
                p.rename(backup)
                file_exists = False
        except Exception:
            file_exists = p.exists()

    write_header = True
    if file_exists:
        try:
            write_header = p.stat().st_size == 0
            if not write_header:
                with p.open("r", newline="") as handle:
                    first_line = handle.readline().strip()
                write_header = not first_line.startswith("timestamp,")
        except Exception:
            write_header = True

    with p.open("a", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=STATE_FIELDS)
        if not file_exists or write_header:
            writer.writeheader()
        row = {}
        for field in STATE_FIELDS:
            value = record.get(field)
            if isinstance(value, bool):
                row[field] = "true" if value else "false"
            elif value is None:
                row[field] = ""
            else:
                row[field] = value
        writer.writerow(row)


def mins_since(iso_ts: Optional[str]) -> float:
    if not iso_ts:
        return 10**9
    try:
        ts = dt.datetime.fromisoformat(iso_ts)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=dt.timezone.utc)
        return (now() - ts).total_seconds() / 60.0
    except Exception:
        return 10**9


def _parse_timestamp(value: str | None) -> Optional[dt.datetime]:
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(value).astimezone(dt.timezone.utc)
    except Exception:
        return None


def _normalise_price_value(value: Any, unit: Optional[str] = None) -> Optional[float]:
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None

    if unit:
        unit_lower = str(unit).lower()
        if "mwh" in unit_lower:
            return price / 1000.0
        if "ct" in unit_lower or "cent" in unit_lower:
            return price / 100.0
    if price > 500.0:
        return price / 1000.0
    if price > 5.0:
        return price / 100.0
    return price


def normalize_price_slots(raw: Any) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]]
    if isinstance(raw, dict):
        if "result" in raw and isinstance(raw["result"], dict):
            raw = raw["result"]
        if isinstance(raw, dict):
            for key in ("tariffs", "prices", "slots", "data"):
                if key in raw and isinstance(raw[key], list):
                    raw = raw[key]
                    break
    if not isinstance(raw, list):
        return []

    slots_by_start: Dict[dt.datetime, Dict[str, Any]] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        start = _parse_timestamp(entry.get("start") or entry.get("from"))
        end = _parse_timestamp(entry.get("end") or entry.get("to"))
        price = _normalise_price_value(entry.get("price"), entry.get("unit"))
        if price is None:
            price = _normalise_price_value(entry.get("value"), entry.get("value_unit"))
        if start is None or price is None:
            continue
        if end is None:
            duration_hours = entry.get("duration_hours")
            duration_minutes = entry.get("duration_minutes")
            if duration_hours is not None:
                end = start + dt.timedelta(hours=float(duration_hours))
            elif duration_minutes is not None:
                end = start + dt.timedelta(minutes=float(duration_minutes))
            else:
                end = start + dt.timedelta(hours=1)
        if end <= start:
            continue
        duration_hours = (end - start).total_seconds() / 3600.0
        payload = {
            "start": start,
            "end": end,
            "duration_hours": duration_hours,
            "price": price,
        }
        existing = slots_by_start.get(start)
        if existing is None or price < existing["price"]:
            slots_by_start[start] = payload

    slots = sorted(slots_by_start.values(), key=lambda item: item["start"])
    return slots


def fetch_market_forecast(url: str | None, *, max_hours: float = 72.0) -> List[Dict[str, Any]]:
    endpoint = url or DEFAULT_MARKET_DATA_URL
    response = requests.get(endpoint, timeout=10)
    response.raise_for_status()
    payload = response.json()

    if isinstance(payload, dict):
        data = payload.get("data") or payload.get("items") or []
    elif isinstance(payload, list):
        data = payload
    else:
        return []

    current_time = now()
    horizon_end = current_time + dt.timedelta(hours=max_hours)
    raw_entries: List[Dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        start_ts = item.get("start_timestamp")
        price = item.get("marketprice")
        if start_ts is None or price is None:
            continue
        end_ts = item.get("end_timestamp")
        try:
            start = dt.datetime.fromtimestamp(float(start_ts) / 1000.0, tz=dt.timezone.utc)
        except (TypeError, ValueError):
            continue
        if end_ts is not None:
            try:
                end = dt.datetime.fromtimestamp(float(end_ts) / 1000.0, tz=dt.timezone.utc)
            except (TypeError, ValueError):
                end = start + dt.timedelta(hours=1)
        else:
            end = start + dt.timedelta(hours=float(item.get("duration_hours", 1)) or 1)
        if end <= current_time:
            continue
        if start >= horizon_end:
            continue
        raw_entries.append(
            {
                "start": start.isoformat(),
                "end": end.isoformat(),
                "price": price,
                "unit": item.get("unit"),
            }
        )

    return normalize_price_slots(raw_entries)


def get_evcc_state(base_url: str) -> Dict[str, Any]:
    response = requests.get(f"{base_url}/api/state", timeout=5)
    response.raise_for_status()
    payload = response.json()
    site = payload.get("site")

    def _extract(key: str) -> Optional[float]:
        if isinstance(site, dict) and site.get(key) is not None:
            return site.get(key)
        return payload.get(key)

    return {
        "battery_soc": _extract("batterySoc"),
        "pv_power": _extract("pvPower"),
        "grid_power": _extract("gridPower"),
        "raw": payload,
    }


def extract_forecast_from_state(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not isinstance(state, dict):
        return []
    forecast = state.get("forecast")
    if not forecast:
        return []

    candidates: List[Dict[str, Any]] = []
    sequences: List[Any] = []

    if isinstance(forecast, dict):
        for value in forecast.values():
            if isinstance(value, list):
                sequences.append(value)
    elif isinstance(forecast, list):
        sequences.append(forecast)

    for seq in sequences:
        for entry in seq:
            if not isinstance(entry, dict):
                continue
            start = entry.get("start") or entry.get("from")
            end = entry.get("end") or entry.get("to")
            price = entry.get("value")
            if price is None:
                price = entry.get("price")
            if start and price is not None:
                candidates.append({"start": start, "end": end, "price": float(price)})

    return candidates


def get_evcc_price(base_url: str, state: Optional[Dict[str, Any]] = None) -> Optional[float]:
    def _price_from_state(data: Dict[str, Any]) -> Optional[float]:
        for key in ("tariffGrid", "tariffPriceLoadpoints", "tariffPriceHome", "gridPrice"):
            if data.get(key) is not None:
                try:
                    return float(data[key])
                except (TypeError, ValueError):
                    continue
        forecast = data.get("forecast")
        if isinstance(forecast, dict):
            for seq in forecast.values():
                if isinstance(seq, list) and seq:
                    first = seq[0]
                    price = first.get("value") or first.get("price")
                    if price is not None:
                        try:
                            return float(price)
                        except (TypeError, ValueError):
                            continue
        return None

    if isinstance(state, dict):
        price = _price_from_state(state)
        if price is not None:
            return price

    try:
        response = requests.get(f"{base_url}/api/tariff", timeout=5)
        if response.status_code != 200:
            return None
        payload = response.json()
        slots = normalize_price_slots(payload)
        if not slots:
            return None
        current = slots[0]
        return float(current.get("price"))
    except Exception:
        return None


def get_evcc_tariff_forecast(base_url: str, *, min_hours: float = 8.0, max_hours: float = 72.0) -> List[Dict[str, Any]]:
    response = requests.get(f"{base_url}/api/tariff", timeout=8)
    response.raise_for_status()
    slots = normalize_price_slots(response.json())
    if not slots:
        return []
    horizon_end = now() + dt.timedelta(hours=max_hours)
    filtered: List[Dict[str, Any]] = []
    for slot in slots:
        if slot["end"] <= now():
            continue
        if slot["start"] >= horizon_end:
            break
        filtered.append(slot)
    if not filtered:
        return []
    covered_hours = sum(item["duration_hours"] for item in filtered)
    if covered_hours < min_hours:
        return filtered
    return filtered


def _fronius_digest_request(
    method: str,
    url: str,
    username: str,
    password: str,
    *,
    payload: Optional[Dict[str, Any]] = None,
    timeout: int = 6,
    verify: bool = False,
) -> requests.Response:
    session = requests.Session()
    headers = {"Accept": "application/json"}

    response = session.request(method, url, json=payload, headers=headers, timeout=timeout, verify=verify)
    if response.status_code != 401:
        return response

    challenge = response.headers.get("WWW-Authenticate") or response.headers.get("X-WWW-Authenticate")
    params = parse_dict_header(challenge) if challenge else {}
    if not params:
        return response

    realm = params.get("realm")
    nonce = params.get("nonce")
    qop = params.get("qop", "auth")
    algorithm = params.get("algorithm", "MD5") or "MD5"
    opaque = params.get("opaque")

    if not realm or not nonce:
        return response
    if algorithm.upper() != "MD5":
        raise ValueError(f"unsupported digest algorithm '{algorithm}'")

    qop_token = qop.split(",")[0].strip()
    parsed = urlparse(url)
    uri = parsed.path or "/"
    if parsed.query:
        uri = f"{uri}?{parsed.query}"

    nc = "00000001"
    cnonce = secrets.token_hex(8)
    hasher = hashlib.md5
    ha1 = hasher(f"{username}:{realm}:{password}".encode()).hexdigest()
    ha2 = hasher(f"{method.upper()}:{uri}".encode()).hexdigest()
    response_hash = hasher(f"{ha1}:{nonce}:{nc}:{cnonce}:{qop_token}:{ha2}".encode()).hexdigest()

    fields = [
        f'username="{username}"',
        f'realm="{realm}"',
        f'nonce="{nonce}"',
        f'uri="{uri}"',
        f'response="{response_hash}"',
        f'algorithm="{algorithm}"',
        f'qop={qop_token}',
        f'nc={nc}',
        f'cnonce="{cnonce}"',
    ]
    if opaque:
        fields.append(f'opaque="{opaque}"')

    headers["Authorization"] = "Digest " + ", ".join(fields)
    return session.request(method, url, json=payload, headers=headers, timeout=timeout, verify=verify)


def fronius_write(cfg: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    fr_cfg = cfg.get("fronius", {})
    host = (fr_cfg.get("host") or "").rstrip("/")
    path = fr_cfg.get("batteries_path") or ""
    url = f"{host}{path}"
    response = _fronius_digest_request(
        "POST",
        url,
        fr_cfg.get("user", ""),
        fr_cfg.get("password", ""),
        payload=payload,
        timeout=int(fr_cfg.get("timeout_s", 6) or 6),
        verify=fr_cfg.get("verify_tls", False),
    )
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return response.json()
    return {"status": response.status_code}


def simulate_optimal_schedule(
    cfg: Dict[str, Any],
    live_state: Dict[str, Any],
    slots: List[Dict[str, Any]],
    *,
    house_load_w: float = 1200.0,
) -> Dict[str, Any]:
    if not slots:
        raise ValueError("price forecast is empty")

    battery_cfg = cfg.get("battery", {})
    capacity_kwh = float(battery_cfg.get("capacity_kwh", 0))
    if capacity_kwh <= 0:
        raise ValueError("battery.capacity_kwh must be > 0")
    max_charge_w = float(battery_cfg.get("max_charge_power_w", 0))
    network_tariff = grid_fee(cfg)

    current_soc = live_state.get("battery_soc")
    if current_soc is None:
        current_soc = 50.0
    current_soc = max(0.0, min(100.0, float(current_soc)))

    percent_step = 100.0 / SOC_STEPS
    energy_per_step = capacity_kwh / SOC_STEPS

    total_duration = sum(slot["duration_hours"] for slot in slots)
    if total_duration <= 0:
        raise ValueError("price forecast has zero duration")

    avg_price = sum((slot["price"] + network_tariff) * slot["duration_hours"] for slot in slots) / total_duration

    num_states = SOC_STEPS + 1
    horizon = len(slots)
    dp = [[math.inf] * num_states for _ in range(horizon + 1)]
    policy = [[0] * num_states for _ in range(horizon)]

    for state in range(num_states):
        energy = state * energy_per_step
        dp[horizon][state] = -avg_price * energy

    for idx in range(horizon - 1, -1, -1):
        slot = slots[idx]
        duration = slot["duration_hours"]
        load_energy = (house_load_w / 1000.0) * duration
        charge_limit_kwh = (max_charge_w / 1000.0) * duration
        price_total = slot["price"] + network_tariff

        max_charge_steps = int(math.floor(charge_limit_kwh / energy_per_step + 1e-9))
        max_discharge_steps = int(math.floor(load_energy / energy_per_step + 1e-9))

        for state in range(num_states):
            best_cost = math.inf
            best_next = state

            up_limit = min(max_charge_steps, num_states - 1 - state)
            down_limit = min(max_discharge_steps, state)

            for delta in range(-down_limit, up_limit + 1):
                next_state = state + delta
                energy_change = delta * energy_per_step
                grid_energy = load_energy + energy_change
                if grid_energy < -1e-9:
                    continue
                slot_cost = price_total * max(grid_energy, 0.0)
                total_cost = slot_cost + dp[idx + 1][next_state]
                if total_cost < best_cost:
                    best_cost = total_cost
                    best_next = next_state

            if best_cost is math.inf:
                best_cost = dp[idx + 1][state]
                best_next = state

            dp[idx][state] = best_cost
            policy[idx][state] = best_next

    current_state = int(round(current_soc / percent_step))
    current_state = max(0, min(num_states - 1, current_state))

    path = [current_state]
    grid_energy_total = 0.0
    cost_total = 0.0
    state_iter = current_state
    trajectory: List[Dict[str, Any]] = []
    for idx, slot in enumerate(slots):
        next_state = policy[idx][state_iter]
        delta = next_state - state_iter
        energy_change = delta * energy_per_step
        load_energy = (house_load_w / 1000.0) * slot["duration_hours"]
        grid_energy = load_energy + energy_change
        grid_energy = max(grid_energy, 0.0)
        cost_total += (slot["price"] + network_tariff) * grid_energy
        grid_energy_total += grid_energy
        path.append(next_state)
        trajectory.append(
            {
                "slot_index": idx,
                "start": iso(slot["start"]),
                "end": iso(slot["end"]),
                "duration_hours": slot["duration_hours"],
                "soc_start_percent": state_iter * percent_step,
                "soc_end_percent": next_state * percent_step,
                "grid_energy_kwh": grid_energy,
                "price_eur_per_kwh": slot["price"] + network_tariff,
            }
        )
        state_iter = next_state

    final_energy = path[-1] * energy_per_step
    cost_total -= avg_price * final_energy

    next_state = path[1] if len(path) > 1 else path[0]
    recommended_target = path[-1] * percent_step

    return {
        "initial_soc_percent": current_state * percent_step,
        "next_step_soc_percent": next_state * percent_step,
        "recommended_soc_percent": recommended_target,
        "recommended_final_soc_percent": recommended_target,
        "simulation_runs": SOC_STEPS,
        "projected_cost_eur": cost_total,
        "projected_grid_energy_kwh": grid_energy_total,
        "average_price_eur_per_kwh": avg_price,
        "forecast_samples": len(slots),
        "forecast_hours": total_duration,
        "trajectory": trajectory,
        "price_floor_eur_per_kwh": min(slot["price"] + network_tariff for slot in slots),
        "price_ceiling_eur_per_kwh": max(slot["price"] + network_tariff for slot in slots),
        "timestamp": iso(now()),
    }
