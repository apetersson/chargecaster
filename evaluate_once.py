#!/usr/bin/env python3
"""One-off decision helper for batteryctl."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

import core


def str2bool(value: str) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"invalid boolean value: '{value}'")


def load_cfg(path: Path) -> Dict[str, Any]:
    with path.open("r") as handle:
        return yaml.safe_load(handle)


def capture_evcc(
    cfg: Dict[str, Any]
) -> tuple[Dict[str, Any], Optional[str], list[str], list[Dict[str, Any]], Optional[str]]:
    evcc_cfg = cfg.get("evcc", {})
    base_url = (evcc_cfg.get("base_url") or "").rstrip("/")
    evcc_enabled = evcc_cfg.get("enabled", False) and base_url

    messages: list[str] = []
    live: Dict[str, Any] = {}
    raw_state: Optional[Dict[str, Any]] = None
    network_tariff = core.grid_fee(cfg)

    if evcc_cfg.get("enabled", False) and not base_url:
        messages.append("evcc base_url missing")
    if not evcc_cfg.get("enabled", False):
        messages.append("evcc disabled in config")

    if evcc_enabled:
        try:
            state_info = core.get_evcc_state(base_url)
            raw_state = state_info.pop("raw", None)
            live = {k: state_info.get(k) for k in ("battery_soc", "pv_power", "grid_power") if state_info.get(k) is not None}
        except Exception as exc:  # pylint: disable=broad-except
            messages.append(f"state fetch failed: {exc}")

    forecast_slots = core.extract_forecast_from_state(raw_state or {})
    forecast = core.normalize_price_slots(forecast_slots)
    forecast_source = "evcc" if forecast else None
    if evcc_enabled and not forecast:
        messages.append("no forecast data present in EVCC state response")

    price_snapshot: Optional[str] = None
    if evcc_enabled:
        try:
            price_now = core.get_evcc_price(base_url, raw_state)
            if price_now is not None:
                price_snapshot = f"{price_now + network_tariff:.4f}"
        except Exception:
            pass

    market_cfg = cfg.get("market_data", {})
    market_enabled = bool(market_cfg.get("enabled", True))
    prefer_market = bool(market_cfg.get("prefer_market", True))
    market_label = market_cfg.get("source_label") or market_cfg.get("label") or "market_data"
    market_max_hours = float(market_cfg.get("max_hours", 72.0) or 72.0)
    market_failed = False

    if market_enabled:
        try:
            market_slots = core.fetch_market_forecast(market_cfg.get("url"), max_hours=market_max_hours)
            if market_slots:
                if prefer_market or not forecast:
                    forecast = market_slots
                    forecast_source = market_label
                if price_snapshot is None:
                    first_market_price = float(market_slots[0].get("price", 0.0))
                    price_snapshot = f"{first_market_price + network_tariff:.4f}"
            else:
                market_failed = True
        except Exception as exc:  # pylint: disable-broad-except
            messages.append(f"market data fetch failed: {exc}")
            market_failed = True

    if market_failed and evcc_enabled and forecast_source == "evcc":
        messages.append("market data unavailable, using EVCC forecast")

    return live, price_snapshot, messages, forecast, forecast_source



def run_once(config_path: Path, *, dry_run: bool = True) -> Dict[str, Any]:
    cfg = load_cfg(config_path)
    output: Dict[str, Any] = {
        "config": str(config_path),
        "dry_run": dry_run,
        "interval_seconds": int(cfg.get("logic", {}).get("interval_seconds", 300) or 300),
    }

    house_load_w = float(cfg.get("logic", {}).get("house_load_w", 1200))
    output["house_load_w"] = house_load_w

    live, price_snapshot, evcc_messages, forecast, forecast_source = capture_evcc(cfg)
    warnings: list[str] = list(evcc_messages)
    errors: list[str] = []

    if not forecast:
        base_url = cfg.get("evcc", {}).get("base_url") or "the configured EVCC endpoint"
        market_url = cfg.get("market_data", {}).get("url") or core.DEFAULT_MARKET_DATA_URL
        errors.append(
            "Unable to retrieve a price forecast from EVCC or market data endpoints. "
            f"Checked EVCC at {base_url} and market data at {market_url}."
        )
        simulation_result: Optional[Dict[str, Any]] = None
    else:
        print(
            json.dumps(
                {
                    "event": "simulation",
                    "phase": "start",
                    "data": {
                        "source": forecast_source,
                        "live_state": live,
                        "forecast_samples": len(forecast),
                        "config": {
                            "capacity_kwh": cfg.get("battery", {}).get("capacity_kwh"),
                            "max_charge_power_w": cfg.get("battery", {}).get("max_charge_power_w"),
                        "grid_fee_eur_per_kwh": cfg.get("price", {}).get("grid_fee_eur_per_kwh")
                        or cfg.get("price", {}).get("network_tariff_eur_per_kwh"),
                            "house_load_w": house_load_w,
                        },
                    },
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        try:
            simulation_result = core.simulate_optimal_schedule(cfg, live, forecast, house_load_w=house_load_w)
        except Exception as exc:  # pylint: disable=broad-except
            errors.append(f"simulation failed: {exc}")
            simulation_result = None

    state_cfg = cfg.get("state", {})
    state_path_value = state_cfg.get("path", "/data/state.csv")
    state_path = Path(state_path_value)
    if not state_path.is_absolute():
        state_path = (config_path.parent / state_path).resolve()

    hold_minutes = int(cfg.get("logic", {}).get("min_hold_minutes", 0) or 0)
    last_action = None
    minutes_since = 10**9
    last_target_soc = None

    current_soc = live.get("battery_soc") if live else None
    if current_soc is None and simulation_result is not None:
        current_soc = simulation_result.get("initial_soc_percent")
    if current_soc is None:
        current_soc = 50.0

    recommended_target = simulation_result.get("recommended_soc_percent") if simulation_result else None
    next_step_soc = simulation_result.get("next_step_soc_percent") if simulation_result else None

    desired_action: Optional[str] = None
    if simulation_result and recommended_target is not None:
        threshold = current_soc + 0.5
        desired_action = "manual" if recommended_target > threshold else "auto"

    hold_active = False

    applied = False
    write_response: Optional[Dict[str, Any]] = None
    hold_reason: Optional[str] = None
    log_record: Optional[Dict[str, Any]] = None

    if not dry_run and simulation_result and recommended_target is not None and desired_action is not None:
        auto_floor = int(cfg.get("battery", {}).get("auto_mode_floor_soc", 5))
        if hold_active:
            hold_reason = f"holding {desired_action} action for {minutes_since:.1f} min < {hold_minutes} min"
        elif desired_action == "manual":
            target_percent = int(round(recommended_target))
            if last_action == "manual" and last_target_soc is not None and int(round(last_target_soc)) == target_percent:
                hold_reason = "manual target unchanged"
            else:
                payload = {"BAT_M0_SOC_MIN": target_percent, "BAT_M0_SOC_MODE": "manual"}
                try:
                    write_response = core.fronius_write(cfg, payload)
                    decision_timestamp = core.iso(core.now())
                    log_record = {
                        "timestamp": decision_timestamp,
                        "action": "manual",
                        "target_soc": target_percent,
                        "reason": f"optimised target {target_percent}%",
                        "price_snapshot": price_snapshot,
                        "soc": current_soc,
                        "applied": True,
                    }
                    applied = True
                except Exception as exc:  # pylint: disable=broad-except
                    errors.append(f"fronius write failed: {exc}")
        elif desired_action == "auto" and last_action != "auto":
            payload = {"BAT_M0_SOC_MIN": auto_floor, "BAT_M0_SOC_MODE": "auto"}
            try:
                write_response = core.fronius_write(cfg, payload)
                decision_timestamp = core.iso(core.now())
                log_record = {
                    "timestamp": decision_timestamp,
                    "action": "auto",
                    "target_soc": auto_floor,
                    "reason": "revert to auto floor",
                    "price_snapshot": price_snapshot,
                    "soc": current_soc,
                    "applied": True,
                }
                applied = True
            except Exception as exc:  # pylint: disable-broad-except
                errors.append(f"fronius write failed: {exc}")

    if simulation_result:
        result_payload = dict(simulation_result)
        if forecast_source:
            result_payload.setdefault("source", forecast_source)
        print(
            json.dumps({"event": "simulation", "phase": "result", "data": result_payload}, ensure_ascii=False),
            flush=True,
        )
        output.update(result_payload)
    output.update(
        {
            "timestamp": simulation_result.get("timestamp") if simulation_result else core.iso(core.now()),
            "price_snapshot_eur_per_kwh": price_snapshot,
            "current_soc_percent": current_soc,
            "next_step_soc_percent": next_step_soc,
            "applied": applied,
            "write_response": write_response,
            "hold_active": hold_active,
            "hold_reason": hold_reason,
            "forecast_source": forecast_source,
            "warnings": warnings,
            "errors": errors,
            "log_record": log_record,
            "state_path": str(state_path),
        }
    )

    public_cfg = cfg.get("public", {})
    snapshot_path_value = public_cfg.get("snapshot_path", "/public/data/latest.json")
    if snapshot_path_value:
        snapshot_path = Path(snapshot_path_value)
        if not snapshot_path.is_absolute():
            snapshot_path = (config_path.parent / snapshot_path).resolve()
        snapshot_payload = {
            "timestamp": output["timestamp"],
            "interval_seconds": output["interval_seconds"],
            "house_load_w": output.get("house_load_w"),
            "current_soc_percent": output.get("current_soc_percent"),
            "next_step_soc_percent": output.get("next_step_soc_percent"),
            "recommended_soc_percent": output.get("recommended_soc_percent"),
            "recommended_final_soc_percent": output.get("recommended_final_soc_percent"),
            "price_snapshot_eur_per_kwh": output.get("price_snapshot_eur_per_kwh"),
            "projected_cost_eur": output.get("projected_cost_eur"),
            "projected_grid_energy_kwh": output.get("projected_grid_energy_kwh"),
            "forecast_hours": output.get("forecast_hours"),
            "forecast_samples": output.get("forecast_samples"),
            "trajectory": output.get("trajectory", []),
            "warnings": warnings,
            "errors": errors,
        }
        try:
            core.write_json_atomic(snapshot_path, snapshot_payload)
        except Exception as exc:  # pylint: disable=broad-except
            warning_msg = f"snapshot write failed: {exc}"
            warnings.append(warning_msg)
            output["warnings"] = warnings

    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.yaml", type=Path, help="Path to batteryctl config.yaml")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    parser.add_argument(
        "--dry-run", type=str2bool, nargs="?", const=True, default=True, help="Skip Fronius writes (default: true)"
    )
    args = parser.parse_args()

    if not args.config.exists():
        print(f"Config file not found: {args.config}", file=sys.stderr)
        return 2

    result = run_once(args.config, dry_run=args.dry_run)
    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if not args.dry_run and result.get("log_record") and result.get("state_path"):
        try:
            core.append_state_record(result["state_path"], result["log_record"])
        except Exception as exc:  # pylint: disable=broad-except
            print(json.dumps({"warning": f"state save failed: {exc}"}), flush=True)

    return 1 if result["errors"] and not args.dry_run else 0


if __name__ == "__main__":
    sys.exit(main())
