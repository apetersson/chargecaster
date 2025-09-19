#!/usr/bin/env python3
"""Scheduler loop invoking the one-off evaluator periodically."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import core
import evaluate_once


TRUE_SET = {"1", "true", "t", "yes", "y"}


def main() -> None:
    config_env = os.environ.get("BATTERYCTL_CONFIG", "config.yaml")
    config_path = Path(config_env).expanduser().resolve()
    run_once_flag = os.environ.get("BATTERYCTL_ONCE", "").lower() in TRUE_SET
    banner = "=" * 60
    print(banner, flush=True)
    print("[INFO] batteryctl scheduler starting", flush=True)
    print(f"[INFO] config: {config_path}", flush=True)
    print(f"[INFO] oneshot mode: {run_once_flag}", flush=True)
    print(banner, flush=True)

    while True:
        try:
            result = evaluate_once.run_once(config_path, dry_run=False)
            snapshot_path = result.get("snapshot_path")
            if snapshot_path:
                print(f"[INFO] snapshot path: {snapshot_path}", flush=True)
            print(json.dumps(result), flush=True)
            interval_seconds = max(60, int(result.get("interval_seconds", 300)))
            log_record = result.get("log_record")
            state_path = result.get("state_path")
            if log_record and state_path:
                try:
                    core.append_state_record(state_path, log_record)
                except Exception as exc:  # pylint: disable=broad-except
                    print(f"[WARN] state save failed: {exc}", flush=True)
        except Exception as exc:  # pylint: disable=broad-except
            print(f"[ERR] evaluation failure: {exc}", flush=True)
            try:
                cfg = core.load_cfg(config_path)
                interval_seconds = max(60, int(cfg.get("logic", {}).get("interval_seconds", 300) or 300))
            except Exception:
                interval_seconds = 300
        if run_once_flag:
            break
        now = time.time()
        sleep_seconds = interval_seconds - (now % interval_seconds)
        if sleep_seconds <= 0:
            sleep_seconds += interval_seconds
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    main()
