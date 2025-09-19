#!/usr/bin/env python3
"""Connectivity checker for batteryctl dependencies.

Performs read-only checks against EVCC, the configured price source and
Fronius using the shared core utilities. No writes are issued to the
inverter.
"""
import argparse
import json
import sys
from pathlib import Path

import requests
import yaml

import core


def load_cfg(path: Path) -> dict:
    with path.open("r") as handle:
        return yaml.safe_load(handle)


def check_fronius(cfg: dict) -> tuple[str, str]:
    fr_cfg = cfg.get("fronius", {})
    host = (fr_cfg.get("host") or "").rstrip("/")
    path = fr_cfg.get("batteries_path") or ""
    if not host or not path:
        return "error", "fronius host or batteries_path missing"

    url = f"{host}{path}"
    try:
        response = core._fronius_digest_request(  # noqa: SLF001
            "GET",
            url,
            fr_cfg.get("user", ""),
            fr_cfg.get("password", ""),
            timeout=int(fr_cfg.get("timeout_s", 6) or 6),
            verify=fr_cfg.get("verify_tls", False),
        )
    except requests.RequestException as exc:
        return "error", f"request failed: {exc}"
    except ValueError as exc:
        return "error", str(exc)

    if response.status_code == 200:
        detail = ""
        try:
            body = response.json()
            keys = ", ".join(list(body.keys())[:3]) if isinstance(body, dict) else type(body).__name__
            detail = f"http 200 (json keys: {keys})"
        except ValueError:
            detail = f"http 200 ({len(response.text)} bytes)"
        return "ok", detail

    if response.status_code == 405:
        return "ok", "reachable (GET not allowed, credentials accepted)"

    if response.status_code == 401:
        return "error", "unauthorized (check credentials)"

    return "error", f"http {response.status_code}: {response.text[:120]}"


def check_evcc(cfg: dict) -> tuple[str, str]:
    evcc_cfg = cfg.get("evcc", {})
    if not evcc_cfg.get("enabled", False):
        return "skipped", "evcc disabled in config"

    base_url = (evcc_cfg.get("base_url") or "").rstrip("/")
    if not base_url:
        return "error", "evcc base_url missing"

    try:
        state = core.get_evcc_state(base_url)
    except Exception as exc:  # pylint: disable=broad-except
        return "error", f"state fetch failed: {exc}"

    soc = state.get("battery_soc")
    pv = state.get("pv_power")
    grid = state.get("grid_power")
    return "ok", f"state reachable (soc={soc}, pv={pv}, grid={grid})"


def check_price(cfg: dict) -> tuple[str, str]:
    price_cfg = cfg.get("price", {})
    source = price_cfg.get("source")

    if source == "awattar":
        hours = int(price_cfg.get("hours_ahead", 24) or 24)
        try:
            slots = core.get_awattar_prices(hours)
        except Exception as exc:  # pylint: disable=broad-except
            return "error", f"awattar fetch failed: {exc}"
        return "ok", f"awattar reachable ({len(slots)} slots)"

    if source == "evcc":
        evcc_cfg = cfg.get("evcc", {})
        base_url = (evcc_cfg.get("base_url") or "").rstrip("/")
        if not base_url:
            return "error", "evcc base_url missing for price retrieval"
        try:
            price = core.get_evcc_price(base_url)
        except Exception as exc:  # pylint: disable=broad-except
            return "error", f"evcc tariff fetch failed: {exc}"
        if price is None:
            return "error", "evcc tariff endpoint returned no price"
        return "ok", f"evcc tariff reachable (price={price})"

    return "skipped", f"price source '{source}' not checked"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        default="config.yaml",
        type=Path,
        help="Path to the batteryctl configuration file.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output with indentation.",
    )
    args = parser.parse_args()

    if not args.config.exists():
        print(f"Config file not found: {args.config}", file=sys.stderr)
        return 2

    cfg = load_cfg(args.config)

    checks = {
        "fronius": check_fronius(cfg),
        "evcc": check_evcc(cfg),
        "price": check_price(cfg),
    }

    output = {name: {"status": status, "detail": detail} for name, (status, detail) in checks.items()}
    if args.pretty:
        print(json.dumps(output, indent=2))
    else:
        print(json.dumps(output))

    failures = [status for status, _ in checks.values() if status == "error"]
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
