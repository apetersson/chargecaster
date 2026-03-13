from __future__ import annotations

import argparse
import json
from pathlib import Path

from load_forecast_lib import train_and_evaluate


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Chargecaster load forecast model.")
    parser.add_argument("--config", required=True, help="Path to config YAML")
    parser.add_argument("--db", required=True, help="Path to backend.sqlite")
    parser.add_argument("--output-dir", required=True, help="Artifact output directory")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress logging")
    args = parser.parse_args()

    result = train_and_evaluate(args.db, args.config, args.output_dir, verbose=not args.quiet)
    summary = {
        "model_version": result["manifest"]["model_version"],
        "mae": result["metrics"]["model"]["mae"],
        "rmse": result["metrics"]["model"]["rmse"],
        "hybrid_mae": result["metrics"]["hybrid"]["mae"],
        "fold_count": result["metrics"]["fold_count"],
        "output_dir": str(Path(args.output_dir).resolve()),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
