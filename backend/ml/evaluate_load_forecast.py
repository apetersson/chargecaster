from __future__ import annotations

import argparse

from catboost import CatBoostRegressor

from load_forecast_lib import (
    DEFAULT_HOUSE_LOAD_W,
    build_walk_forward_folds,
    load_config,
    load_hourly_history,
    sequential_hybrid_predict,
    sequential_model_predict,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the Chargecaster load forecast model.")
    parser.add_argument("--config", required=True, help="Path to config YAML")
    parser.add_argument("--db", required=True, help="Path to backend.sqlite")
    parser.add_argument("--model", required=True, help="Path to model.cbm")
    args = parser.parse_args()

    config = load_config(args.config)
    rows = load_hourly_history(args.db, config)
    folds = build_walk_forward_folds(rows)
    model = CatBoostRegressor()
    model.load_model(args.model)

    print("timestamp\tactual\tflat_2200\thybrid\tcatboost\tabs_flat\tabs_hybrid\tabs_catboost")
    printed = 0
    for train_rows, eval_rows in folds[-2:]:
        model_predictions = sequential_model_predict(model, train_rows, eval_rows)
        hybrid_predictions = sequential_hybrid_predict(train_rows, eval_rows)
        for row, model_prediction, hybrid_prediction in zip(eval_rows, model_predictions, hybrid_predictions):
            print(
                f"{row.hour_utc}\t"
                f"{round(row.home_power_w)}\t"
                f"{round(DEFAULT_HOUSE_LOAD_W)}\t"
                f"{round(hybrid_prediction)}\t"
                f"{round(model_prediction)}\t"
                f"{round(abs(row.home_power_w - DEFAULT_HOUSE_LOAD_W))}\t"
                f"{round(abs(row.home_power_w - hybrid_prediction))}\t"
                f"{round(abs(row.home_power_w - model_prediction))}"
            )
            printed += 1
            if printed >= 24:
                return


if __name__ == "__main__":
    main()
