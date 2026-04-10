from __future__ import annotations

import json
import math
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from typing import Any
from zoneinfo import ZoneInfo

import catboost
import yaml
from catboost import CatBoostRegressor

DEFAULT_HOUSE_LOAD_W = 2200.0
MIN_HOUSE_LOAD_W = 150.0
MAX_HOUSE_LOAD_W = 15000.0
MAX_NEIGHBORS = 24
TARGET_MODE_ABSOLUTE = "absolute_house_power_v1"
TARGET_MODE_BASELINE_DELTA = "baseline_delta_v1"
TARGET_MODE_BASELINE_RATIO = "baseline_ratio_v1"
MODEL_TARGET_MODE = TARGET_MODE_BASELINE_RATIO
BASELINE_TARGET_FLOOR_W = 250.0
MIN_BASELINE_RATIO = 0.2
MAX_BASELINE_RATIO = 3.0
SHAPE_CALIBRATION_BLEND = 1.0
MAX_SHAPE_STD_RATIO = 1.095


def load_feature_contract() -> dict[str, Any]:
    contract_path = Path(__file__).with_name("load_forecast_feature_contract.json")
    with open(contract_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


FEATURE_CONTRACT = load_feature_contract()
FEATURE_SCHEMA_VERSION = str(FEATURE_CONTRACT["feature_schema_version"])
FEATURE_NAMES = [str(value) for value in FEATURE_CONTRACT["feature_names"]]


@dataclass
class HistoricalHour:
    hour_utc: str
    dt_utc: datetime
    local_hour: int
    weekday: int
    week_of_year: int
    month: int
    season: int
    home_power_w: float
    solar_power_w: float
    forecast_solar_w: float
    price_eur_per_kwh: float
    temperature_2m: float | None
    cloud_cover: float | None
    wind_speed_10m: float | None
    precipitation_mm: float | None
    valid_target: bool


@dataclass
class LoadHistorySummary:
    history_forecast_solar_hours: int
    solar_proxy_hours: int
    realized_solar_fallback_hours: int
    total_hours: int


MODEL_PARAMS = {
    "loss_function": "RMSE",
    "eval_metric": "MAE",
    "iterations": 70,
    "depth": 6,
    "learning_rate": 0.05,
    "l2_leaf_reg": 15.0,
    "random_seed": 42,
    "verbose": False,
    "allow_writing_files": False,
}


def log_progress(message: str) -> None:
    print(f"[load-forecast] {message}", file=sys.stderr, flush=True)


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def floor_to_utc_hour(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def iso_utc(value: datetime) -> str:
    return floor_to_utc_hour(value).isoformat().replace("+00:00", "Z")


def season_from_month(month: int) -> int:
    if month in (12, 1, 2):
        return 0
    if month in (3, 4, 5):
        return 1
    if month in (6, 7, 8):
        return 2
    return 3


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def average(values: list[float]) -> float | None:
    if not values:
        return None
    return mean(values)


def normalized_distance(left: float | None, right: float | None, scale: float) -> float:
    if left is None or right is None or scale <= 0:
        return 0.15
    return min(2.0, abs(left - right) / scale)


def circular_hour_distance(left: int, right: int) -> int:
    delta = abs(left - right)
    return min(delta, 24 - delta)


def is_weekend(weekday: int) -> bool:
    return weekday in (5, 6)


def weighted_average(rows: list[HistoricalHour], now_ms: float) -> float:
    weighted_sum = 0.0
    total_weight = 0.0
    for row in rows:
        age_days = max(0.0, (now_ms - row.dt_utc.timestamp() * 1000.0) / 86_400_000.0)
        weight = math.exp(-age_days / 45.0)
        weighted_sum += row.home_power_w * weight
        total_weight += weight
    return weighted_sum / total_weight if total_weight > 0 else DEFAULT_HOUSE_LOAD_W


def compute_metrics(actuals: list[float], predictions: list[float]) -> dict[str, float]:
    absolute = [abs(a - p) for a, p in zip(actuals, predictions)]
    squared = [(a - p) ** 2 for a, p in zip(actuals, predictions)]
    ordered = sorted(absolute)
    if not ordered:
        return {"mae": 0.0, "rmse": 0.0, "p50_absolute_error": 0.0, "p90_absolute_error": 0.0}
    return {
        "mae": sum(absolute) / len(absolute),
        "rmse": math.sqrt(sum(squared) / len(squared)),
        "p50_absolute_error": ordered[min(len(ordered) - 1, int(round((len(ordered) - 1) * 0.5)))],
        "p90_absolute_error": ordered[min(len(ordered) - 1, int(round((len(ordered) - 1) * 0.9)))],
    }


def load_config(config_path: str) -> dict[str, Any]:
    with open(config_path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def load_hourly_history_details(db_path: str, config: dict[str, Any]) -> tuple[list[HistoricalHour], LoadHistorySummary]:
    tz_name = ((config.get("location") or {}).get("timezone")) or "UTC"
    tz = ZoneInfo(tz_name)
    latitude = (config.get("location") or {}).get("latitude")
    longitude = (config.get("location") or {}).get("longitude")
    solar_arrays = config.get("solar") or []

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    history_rows = connection.execute("SELECT timestamp, payload FROM history ORDER BY timestamp ASC").fetchall()
    grouped: dict[str, dict[str, float | int]] = {}
    for row in history_rows:
        payload = json.loads(row["payload"])
        timestamp = payload.get("timestamp")
        home_power_w = payload.get("home_power_w")
        if not isinstance(timestamp, str) or not isinstance(home_power_w, (int, float)):
            continue
        dt = parse_iso(timestamp)
        hour_utc = iso_utc(dt)
        bucket = grouped.setdefault(hour_utc, {
            "home_sum": 0.0,
            "home_count": 0,
            "solar_sum": 0.0,
            "solar_count": 0,
            "forecast_solar_sum": 0.0,
            "forecast_solar_count": 0,
            "price_sum": 0.0,
            "price_count": 0,
        })
        bucket["home_sum"] += float(home_power_w)
        bucket["home_count"] += 1
        solar_power_w = payload.get("solar_power_w")
        if isinstance(solar_power_w, (int, float)):
            bucket["solar_sum"] += max(0.0, float(solar_power_w))
            bucket["solar_count"] += 1
        forecast_solar_power_w = payload.get("solar_forecast_power_w")
        if isinstance(forecast_solar_power_w, (int, float)):
            bucket["forecast_solar_sum"] += max(0.0, float(forecast_solar_power_w))
            bucket["forecast_solar_count"] += 1
        price = payload.get("price_eur_per_kwh")
        if isinstance(price, (int, float)):
            bucket["price_sum"] += float(price)
            bucket["price_count"] += 1

    weather_map: dict[str, sqlite3.Row] = {}
    if isinstance(latitude, (int, float)) and isinstance(longitude, (int, float)) and grouped:
        min_hour = min(grouped.keys())
        max_hour = max(grouped.keys())
        weather_rows = connection.execute(
            """
            SELECT hour_utc, temperature_2m, cloud_cover, wind_speed_10m, precipitation_mm
            FROM weather_hourly_cache
            WHERE latitude = ?
              AND longitude = ?
              AND hour_utc >= ?
              AND hour_utc <= ?
            ORDER BY hour_utc ASC
            """,
            (float(latitude), float(longitude), min_hour, max_hour),
        ).fetchall()
        weather_map = {str(row["hour_utc"]): row for row in weather_rows}

    solar_proxy_by_hour: dict[str, float] = {}
    if grouped and isinstance(latitude, (int, float)) and isinstance(longitude, (int, float)):
        min_hour = min(grouped.keys())
        max_hour = max(grouped.keys())
        for array in solar_arrays:
            kwp = array.get("kwp")
            tilt = array.get("dec")
            azimuth = array.get("az")
            if not isinstance(kwp, (int, float)) or not isinstance(tilt, (int, float)) or not isinstance(azimuth, (int, float)):
                continue
            proxy_rows = connection.execute(
                """
                SELECT hour_utc, expected_power_w
                FROM solar_proxy_hourly_cache
                WHERE latitude = ?
                  AND longitude = ?
                  AND kwp = ?
                  AND tilt = ?
                  AND azimuth = ?
                  AND hour_utc >= ?
                  AND hour_utc <= ?
                ORDER BY hour_utc ASC
                """,
                (float(latitude), float(longitude), float(kwp), float(tilt), float(azimuth), min_hour, max_hour),
            ).fetchall()
            for row in proxy_rows:
                if row["expected_power_w"] is None:
                    continue
                key = str(row["hour_utc"])
                solar_proxy_by_hour[key] = solar_proxy_by_hour.get(key, 0.0) + max(0.0, float(row["expected_power_w"]))
    connection.close()

    hours: list[HistoricalHour] = []
    history_forecast_solar_hours = 0
    solar_proxy_hours = 0
    realized_solar_fallback_hours = 0
    for hour_utc in sorted(grouped.keys()):
        bucket = grouped[hour_utc]
        dt_utc = parse_iso(hour_utc)
        local_dt = dt_utc.astimezone(tz)
        weather = weather_map.get(hour_utc)
        home_count = int(bucket["home_count"])
        actual_solar = (float(bucket["solar_sum"]) / int(bucket["solar_count"])) if int(bucket["solar_count"]) > 0 else 0.0
        history_forecast_solar = (float(bucket["forecast_solar_sum"]) / int(bucket["forecast_solar_count"])) if int(bucket["forecast_solar_count"]) > 0 else None
        proxy_solar = solar_proxy_by_hour.get(hour_utc)
        if history_forecast_solar is not None:
            forecast_solar_w = history_forecast_solar
            history_forecast_solar_hours += 1
        elif proxy_solar is not None:
            forecast_solar_w = proxy_solar
            solar_proxy_hours += 1
        else:
            forecast_solar_w = actual_solar
            realized_solar_fallback_hours += 1
        hours.append(HistoricalHour(
            hour_utc=hour_utc,
            dt_utc=dt_utc,
            local_hour=local_dt.hour,
            weekday=local_dt.weekday(),
            week_of_year=int(local_dt.strftime("%V")),
            month=local_dt.month,
            season=season_from_month(local_dt.month),
            home_power_w=(float(bucket["home_sum"]) / home_count) if home_count > 0 else DEFAULT_HOUSE_LOAD_W,
            solar_power_w=actual_solar,
            forecast_solar_w=forecast_solar_w,
            price_eur_per_kwh=(float(bucket["price_sum"]) / int(bucket["price_count"])) if int(bucket["price_count"]) > 0 else 0.0,
            temperature_2m=float(weather["temperature_2m"]) if weather and weather["temperature_2m"] is not None else None,
            cloud_cover=float(weather["cloud_cover"]) if weather and weather["cloud_cover"] is not None else None,
            wind_speed_10m=float(weather["wind_speed_10m"]) if weather and weather["wind_speed_10m"] is not None else None,
            precipitation_mm=float(weather["precipitation_mm"]) if weather and weather["precipitation_mm"] is not None else None,
            valid_target=home_count >= 6,
        ))
    return hours, LoadHistorySummary(
        history_forecast_solar_hours=history_forecast_solar_hours,
        solar_proxy_hours=solar_proxy_hours,
        realized_solar_fallback_hours=realized_solar_fallback_hours,
        total_hours=len(hours),
    )


def load_hourly_history(db_path: str, config: dict[str, Any]) -> list[HistoricalHour]:
    rows, _summary = load_hourly_history_details(db_path, config)
    return rows


def build_baselines(rows: list[HistoricalHour]) -> dict[str, Any]:
    now_ms = datetime.now(tz=timezone.utc).timestamp() * 1000.0
    hour_week = build_weighted_average_map(rows, lambda row: f"{row.weekday}:{row.local_hour}", now_ms)
    season_hour = build_weighted_average_map(rows, lambda row: f"{row.season}:{row.local_hour}", now_ms)
    hour_only: dict[int, float] = {}
    for hour in range(24):
        subset = [row for row in rows if row.local_hour == hour]
        if subset:
            hour_only[hour] = weighted_average(subset, now_ms)
    return {"hour_week": hour_week, "season_hour": season_hour, "hour_only": hour_only}


def build_weighted_average_map(rows: list[HistoricalHour], key_fn, now_ms: float) -> dict[str, float]:
    totals: dict[str, tuple[float, float]] = {}
    for row in rows:
        key = key_fn(row)
        age_days = max(0.0, (now_ms - row.dt_utc.timestamp() * 1000.0) / 86_400_000.0)
        weight = math.exp(-age_days / 45.0)
        weighted, total = totals.get(key, (0.0, 0.0))
        totals[key] = (weighted + row.home_power_w * weight, total + weight)
    return {key: weighted / total for key, (weighted, total) in totals.items() if total > 0}


def predict_baseline_house_power(row: HistoricalHour | dict[str, Any], baselines: dict[str, Any]) -> float:
    hour_week = baselines["hour_week"].get(f"{row.weekday}:{row.local_hour}")
    season_hour = baselines["season_hour"].get(f"{row.season}:{row.local_hour}")
    hour_only = baselines["hour_only"].get(row.local_hour)
    if hour_week is not None and season_hour is not None and hour_only is not None:
        return hour_week * 0.55 + season_hour * 0.25 + hour_only * 0.2
    if hour_week is not None and hour_only is not None:
        return hour_week * 0.7 + hour_only * 0.3
    if season_hour is not None and hour_only is not None:
        return season_hour * 0.6 + hour_only * 0.4
    return hour_week or season_hour or hour_only or DEFAULT_HOUSE_LOAD_W


def baseline_target_denominator(baseline_house_power: float) -> float:
    return max(BASELINE_TARGET_FLOOR_W, baseline_house_power)


def decode_target_prediction(raw_prediction: float, baseline_house_power: float, target_mode: str) -> float:
    if target_mode == TARGET_MODE_ABSOLUTE:
        return raw_prediction
    if target_mode == TARGET_MODE_BASELINE_DELTA:
        return baseline_house_power + raw_prediction
    if target_mode == TARGET_MODE_BASELINE_RATIO:
        ratio = clamp(raw_prediction, MIN_BASELINE_RATIO, MAX_BASELINE_RATIO)
        return baseline_house_power * ratio
    return raw_prediction


def build_recent_shape_reference(history_rows: list[HistoricalHour], eval_rows: list[HistoricalHour]) -> list[float] | None:
    if not history_rows or not eval_rows:
        return None
    recent_end = history_rows[-1].dt_utc
    recent_start = recent_end - timedelta(days=7)
    recent_rows = [row for row in history_rows if row.valid_target and row.dt_utc > recent_start]
    if len(recent_rows) < 24 * 3:
        return None
    by_hour: dict[int, list[float]] = {}
    for row in recent_rows:
        by_hour.setdefault(row.local_hour, []).append(row.home_power_w)
    reference: list[float] = []
    for row in eval_rows:
        samples = by_hour.get(row.local_hour)
        if not samples:
            return None
        reference.append(average(samples) or row.home_power_w)
    return reference


def calibrate_shape_profile(predictions: list[float], reference_values: list[float] | None) -> list[float]:
    if reference_values is None or len(predictions) != len(reference_values) or len(predictions) < 4:
        return predictions
    ordered_indices = sorted(range(len(predictions)), key=lambda index: predictions[index])
    sorted_reference = sorted(reference_values)
    calibrated = list(predictions)
    for rank, index in enumerate(ordered_indices):
        mapped = sorted_reference[rank]
        calibrated[index] = clamp(
            predictions[index] * (1.0 - SHAPE_CALIBRATION_BLEND) + mapped * SHAPE_CALIBRATION_BLEND,
            MIN_HOUSE_LOAD_W,
            MAX_HOUSE_LOAD_W,
        )
    reference_std = population_std(reference_values)
    calibrated_std = population_std(calibrated)
    if reference_std > 0.0 and calibrated_std > reference_std * MAX_SHAPE_STD_RATIO:
        target_std = reference_std * MAX_SHAPE_STD_RATIO
        center = average(calibrated) or DEFAULT_HOUSE_LOAD_W
        scale = target_std / calibrated_std
        calibrated = [
            clamp(center + (value - center) * scale, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W)
            for value in calibrated
        ]
    return calibrated


def population_std(values: list[float]) -> float:
    if not values:
        return 0.0
    avg = average(values) or 0.0
    return math.sqrt(sum((value - avg) ** 2 for value in values) / len(values))


def predict_from_neighbors(rows: list[HistoricalHour], context: HistoricalHour, lag1: float, lag3: float) -> tuple[float, float]:
    if not rows:
        return DEFAULT_HOUSE_LOAD_W, 0.0
    target_ms = context.dt_utc.timestamp() * 1000.0
    ranked: list[tuple[HistoricalHour, float]] = []
    for row in rows:
        age_days = max(0.0, (target_ms - row.dt_utc.timestamp() * 1000.0) / 86_400_000.0)
        hour_distance = circular_hour_distance(row.local_hour, context.local_hour) / 12.0
        weekday_penalty = 0.0 if row.weekday == context.weekday else (0.2 if is_weekend(row.weekday) == is_weekend(context.weekday) else 0.45)
        season_penalty = 0.0 if row.season == context.season else 0.3
        temperature_penalty = normalized_distance(row.temperature_2m, context.temperature_2m, 12.0)
        cloud_penalty = normalized_distance(row.cloud_cover, context.cloud_cover, 60.0)
        wind_penalty = normalized_distance(row.wind_speed_10m, context.wind_speed_10m, 12.0)
        precipitation_penalty = normalized_distance(row.precipitation_mm, context.precipitation_mm, 3.0)
        solar_penalty = normalized_distance(row.solar_power_w, context.solar_power_w, 2500.0)
        price_penalty = normalized_distance(row.price_eur_per_kwh, context.price_eur_per_kwh, 0.12)
        lag_penalty = normalized_distance(row.home_power_w, lag1, 2500.0) * 0.3 + normalized_distance(row.home_power_w, lag3, 2500.0) * 0.2
        distance = hour_distance + weekday_penalty + season_penalty + temperature_penalty + cloud_penalty + wind_penalty + precipitation_penalty + solar_penalty + price_penalty + lag_penalty
        recency_weight = math.exp(-age_days / 75.0)
        weight = recency_weight / (1.0 + distance)
        ranked.append((row, weight))
    ranked = [entry for entry in sorted(ranked, key=lambda item: item[1], reverse=True)[:MAX_NEIGHBORS] if entry[1] > 0]
    total_weight = sum(weight for _, weight in ranked)
    if total_weight <= 0:
        return DEFAULT_HOUSE_LOAD_W, 0.0
    value = sum(row.home_power_w * weight for row, weight in ranked) / total_weight
    confidence = clamp(total_weight / 6.0, 0.0, 1.0)
    return value, confidence


def compute_recent_bias(rows: list[HistoricalHour], baselines: dict[str, Any]) -> float:
    recent = rows[-3:]
    if not recent:
        return 0.0
    deltas = [row.home_power_w - predict_baseline_house_power(row, baselines) for row in recent]
    return average(deltas) or 0.0


def build_future_price_stats(rows: list[HistoricalHour]) -> list[tuple[float, float, float]]:
    stats: list[tuple[float, float, float]] = []
    for index, row in enumerate(rows):
        next_6h = [candidate.price_eur_per_kwh for candidate in rows[index:index + 6]]
        next_24h = [candidate.price_eur_per_kwh for candidate in rows[index:index + 24]]
        sorted_24h = sorted(next_24h)
        if len(sorted_24h) <= 1:
            percentile_value = 0.5
        else:
            first_ge = next((idx for idx, value in enumerate(sorted_24h) if value >= row.price_eur_per_kwh), -1)
            percentile_value = first_ge / (len(sorted_24h) - 1) if first_ge >= 0 else 0.5
        stats.append((
            average(next_6h) or row.price_eur_per_kwh,
            percentile_value,
            1.0 if percentile_value >= 0.75 else 0.0,
        ))
    return stats


def build_future_solar_stats(rows: list[HistoricalHour]) -> list[tuple[float, float]]:
    stats: list[tuple[float, float]] = []
    for index, row in enumerate(rows):
        next_3h = [candidate.forecast_solar_w for candidate in rows[index:index + 3]]
        next_6h = [candidate.forecast_solar_w for candidate in rows[index:index + 6]]
        stats.append((
            average(next_3h) or row.forecast_solar_w,
            average(next_6h) or row.forecast_solar_w,
        ))
    return stats


def build_feature_vector(
    context: HistoricalHour,
    evaluation_rows: list[HistoricalHour],
    index: int,
    rolling_homes: list[float],
    history_by_hour: dict[str, float],
    future_price_stats: list[tuple[float, float, float]],
    future_solar_stats: list[tuple[float, float]],
) -> list[float]:
    lag_prev_hour = rolling_homes[-1] if rolling_homes else DEFAULT_HOUSE_LOAD_W
    lag_mean_3 = average(rolling_homes[-3:]) or lag_prev_hour
    lag_mean_6 = average(rolling_homes[-6:]) or lag_mean_3
    prev_day_key = iso_utc(context.dt_utc - timedelta(hours=24))
    prev_week_key = iso_utc(context.dt_utc - timedelta(days=7))
    same_hour_prev_day = history_by_hour.get(prev_day_key)
    same_hour_prev_week = history_by_hour.get(prev_week_key)
    price_next_6h_mean, price_next_24h_percentile, price_next_24h_top_quartile = future_price_stats[index]
    solar_next_3h_mean, solar_next_6h_mean = future_solar_stats[index]
    return [
        float(context.local_hour),
        float(context.weekday),
        1.0 if is_weekend(context.weekday) else 0.0,
        float(context.week_of_year),
        float(context.month),
        float(context.season),
        context.temperature_2m or 0.0,
        context.cloud_cover or 0.0,
        context.wind_speed_10m or 0.0,
        context.precipitation_mm or 0.0,
        context.forecast_solar_w,
        solar_next_3h_mean,
        solar_next_6h_mean,
        context.price_eur_per_kwh,
        price_next_6h_mean,
        price_next_24h_percentile,
        price_next_24h_top_quartile,
        lag_prev_hour,
        lag_mean_3,
        lag_mean_6,
        same_hour_prev_day or 0.0,
        same_hour_prev_week or 0.0,
        1.0 if same_hour_prev_day is None else 0.0,
        1.0 if same_hour_prev_week is None else 0.0,
    ]


def build_training_samples(train_rows: list[HistoricalHour]) -> tuple[list[list[float]], list[float], list[float]]:
    rows = [row for row in train_rows if row.valid_target]
    history_by_hour = {row.hour_utc: row.home_power_w for row in train_rows}
    baselines = build_baselines(train_rows)
    features: list[list[float]] = []
    targets: list[float] = []
    sample_weights: list[float] = []
    rolling_homes: list[float] = []
    future_price_stats = build_future_price_stats(rows)
    future_solar_stats = build_future_solar_stats(rows)
    prices = sorted(row.price_eur_per_kwh for row in rows)
    price_threshold = percentile(prices, 0.75) if prices else 0.0
    for index, row in enumerate(rows):
        features.append(build_feature_vector(row, rows, index, rolling_homes, history_by_hour, future_price_stats, future_solar_stats))
        baseline_house_power = predict_baseline_house_power(row, baselines)
        if MODEL_TARGET_MODE == TARGET_MODE_BASELINE_DELTA:
            targets.append(row.home_power_w - baseline_house_power)
        elif MODEL_TARGET_MODE == TARGET_MODE_BASELINE_RATIO:
            targets.append(row.home_power_w / baseline_target_denominator(baseline_house_power))
        else:
            targets.append(row.home_power_w)
        economic_weight = 1.0
        if row.solar_power_w < 250.0:
            economic_weight += 0.35
        if row.price_eur_per_kwh >= price_threshold:
            economic_weight += 0.35
        if row.local_hour in (6, 7, 8, 17, 18, 19, 20, 21):
            economic_weight += 0.15
        sample_weights.append(economic_weight)
        rolling_homes.append(row.home_power_w)
    return features, targets, sample_weights


def sequential_model_predict(
    model: CatBoostRegressor,
    history_rows: list[HistoricalHour],
    eval_rows: list[HistoricalHour],
    target_mode: str = MODEL_TARGET_MODE,
) -> list[float]:
    history_by_hour = {row.hour_utc: row.home_power_w for row in history_rows}
    baselines = build_baselines(history_rows)
    rolling_homes = [row.home_power_w for row in history_rows[-8:]] or [DEFAULT_HOUSE_LOAD_W]
    future_price_stats = build_future_price_stats(eval_rows)
    future_solar_stats = build_future_solar_stats(eval_rows)
    predictions: list[float] = []
    for index, row in enumerate(eval_rows):
        features = build_feature_vector(row, eval_rows, index, rolling_homes, history_by_hour, future_price_stats, future_solar_stats)
        raw_prediction = float(model.predict([features])[0])
        baseline_house_power = predict_baseline_house_power(row, baselines)
        prediction = decode_target_prediction(raw_prediction, baseline_house_power, target_mode)
        prediction = clamp(prediction, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W)
        predictions.append(prediction)
        rolling_homes.append(prediction)
        if len(rolling_homes) > 8:
            rolling_homes.pop(0)
    reference_values = build_recent_shape_reference(history_rows, eval_rows)
    return calibrate_shape_profile(predictions, reference_values)


def sequential_hybrid_predict(history_rows: list[HistoricalHour], eval_rows: list[HistoricalHour]) -> list[float]:
    baselines = build_baselines(history_rows)
    recent_bias = compute_recent_bias(history_rows, baselines)
    rolling_homes = [row.home_power_w for row in history_rows[-6:]] or [DEFAULT_HOUSE_LOAD_W]
    predictions: list[float] = []
    for row in eval_rows:
        baseline = predict_baseline_house_power(row, baselines)
        lag1 = rolling_homes[-1] if rolling_homes else baseline
        lag3 = average(rolling_homes[-3:]) or lag1
        neighbor_value, _confidence = predict_from_neighbors(history_rows, row, lag1, lag3)
        prediction = baseline * 0.5 + neighbor_value * 0.35 + lag3 * 0.15 + recent_bias * 0.4
        prediction = clamp(prediction, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W)
        predictions.append(prediction)
        rolling_homes.append(prediction)
        if len(rolling_homes) > 6:
            rolling_homes.pop(0)
    return predictions


def sequential_hour_of_week_predict(history_rows: list[HistoricalHour], eval_rows: list[HistoricalHour]) -> list[float]:
    baselines = build_baselines(history_rows)
    return [predict_baseline_house_power(row, baselines) for row in eval_rows]


def load_model_target_mode(model_path: str) -> str:
    manifest_path = Path(model_path).with_name("manifest.json")
    if not manifest_path.exists():
        return TARGET_MODE_ABSOLUTE
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        target_mode = manifest.get("target_mode")
        return str(target_mode) if isinstance(target_mode, str) and target_mode else TARGET_MODE_ABSOLUTE
    except Exception:
        return TARGET_MODE_ABSOLUTE


def evaluate_active_model(model_path: str, history_rows: list[HistoricalHour], folds: list[tuple[list[HistoricalHour], list[HistoricalHour]]]) -> dict[str, float] | None:
    if not Path(model_path).exists():
        return None
    model = CatBoostRegressor()
    model.load_model(model_path)
    target_mode = load_model_target_mode(model_path)
    actuals: list[float] = []
    predictions: list[float] = []
    economic_errors: list[float] = []
    for train_rows, eval_rows in folds:
        fold_predictions = sequential_model_predict(model, train_rows, eval_rows, target_mode=target_mode)
        actuals.extend(row.home_power_w for row in eval_rows)
        predictions.extend(fold_predictions)
        economic_errors.extend(
            abs(row.home_power_w - pred)
            for row, pred in zip(eval_rows, fold_predictions)
            if row.solar_power_w >= 500.0 or row.price_eur_per_kwh >= top_quartile_threshold(eval_rows, row.price_eur_per_kwh)
        )
    metrics = compute_metrics(actuals, predictions)
    metrics["p90_economic_hours_absolute_error"] = percentile(economic_errors, 0.9)
    return metrics


def top_quartile_threshold(rows: list[HistoricalHour], current_price: float) -> float:
    prices = sorted(row.price_eur_per_kwh for row in rows[:24])
    if not prices:
        return current_price
    return prices[min(len(prices) - 1, int(round((len(prices) - 1) * 0.75)))]


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round((len(ordered) - 1) * ratio)))]


def build_walk_forward_folds(rows: list[HistoricalHour]) -> list[tuple[list[HistoricalHour], list[HistoricalHour]]]:
    valid_rows = [row for row in rows if row.valid_target]
    folds: list[tuple[list[HistoricalHour], list[HistoricalHour]]] = []
    if not valid_rows:
        return folds
    start_time = valid_rows[0].dt_utc + timedelta(days=42)
    final_time = valid_rows[-1].dt_utc
    cutoff = start_time
    while cutoff + timedelta(hours=24) <= final_time:
        train_rows = [row for row in valid_rows if row.dt_utc < cutoff]
        eval_rows = [row for row in valid_rows if cutoff <= row.dt_utc < cutoff + timedelta(hours=24)]
        if len(train_rows) >= 24 * 42 and len(eval_rows) >= 12:
            folds.append((train_rows, eval_rows))
        cutoff += timedelta(hours=24)
    return folds


def train_and_evaluate(db_path: str, config_path: str, output_dir: str, verbose: bool = False) -> dict[str, Any]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    if verbose:
        log_progress(f"Loading config from {config_path}")
    config = load_config(config_path)
    if verbose:
        log_progress(f"Loading hourly history from {db_path}")
    rows, history_summary = load_hourly_history_details(db_path, config)
    valid_rows = [row for row in rows if row.valid_target]
    if verbose:
        log_progress(f"Loaded {len(rows)} hourly rows ({len(valid_rows)} valid targets)")
    folds = build_walk_forward_folds(rows)
    if verbose:
        log_progress(f"Built {len(folds)} walk-forward folds")
    actuals: list[float] = []
    model_predictions: list[float] = []
    flat_predictions: list[float] = []
    hour_week_predictions: list[float] = []
    hybrid_predictions: list[float] = []
    economic_errors_model: list[float] = []
    economic_errors_hybrid: list[float] = []
    for fold_index, (train_rows, eval_rows) in enumerate(folds, start=1):
        train_x, train_y, train_weights = build_training_samples(train_rows)
        if not train_x or not train_y:
            continue
        if verbose and (fold_index == 1 or fold_index == len(folds) or fold_index % 10 == 0):
            log_progress(
                "Evaluating fold "
                f"{fold_index}/{len(folds)} "
                f"(train_hours={len(train_rows)}, eval_hours={len(eval_rows)}, samples={len(train_x)})",
            )
        model = CatBoostRegressor(**MODEL_PARAMS)
        model.fit(train_x, train_y, sample_weight=train_weights)
        fold_model_predictions = sequential_model_predict(model, train_rows, eval_rows)
        fold_hour_week_predictions = sequential_hour_of_week_predict(train_rows, eval_rows)
        fold_hybrid_predictions = sequential_hybrid_predict(train_rows, eval_rows)
        for row, model_prediction, hour_week_prediction, hybrid_prediction in zip(
            eval_rows,
            fold_model_predictions,
            fold_hour_week_predictions,
            fold_hybrid_predictions,
        ):
            actuals.append(row.home_power_w)
            model_predictions.append(model_prediction)
            flat_predictions.append(DEFAULT_HOUSE_LOAD_W)
            hybrid_predictions.append(hybrid_prediction)
            hour_week_predictions.append(hour_week_prediction)
            if row.solar_power_w >= 500.0 or row.price_eur_per_kwh >= top_quartile_threshold(eval_rows, row.price_eur_per_kwh):
                economic_errors_model.append(abs(row.home_power_w - model_prediction))
                economic_errors_hybrid.append(abs(row.home_power_w - hybrid_prediction))

    model_metrics = compute_metrics(actuals, model_predictions)
    flat_metrics = compute_metrics(actuals, flat_predictions)
    hour_week_metrics = compute_metrics(actuals, hour_week_predictions)
    hybrid_metrics = compute_metrics(actuals, hybrid_predictions)
    model_metrics["p90_economic_hours_absolute_error"] = percentile(economic_errors_model, 0.9)
    hybrid_metrics["p90_economic_hours_absolute_error"] = percentile(economic_errors_hybrid, 0.9)
    model_metrics["mae_vs_hybrid_improvement_ratio"] = (
        (hybrid_metrics["mae"] - model_metrics["mae"]) / hybrid_metrics["mae"]
        if hybrid_metrics["mae"] > 0
        else 0.0
    )

    train_x_all, train_y_all, train_weights_all = build_training_samples(valid_rows)
    if verbose:
        log_progress(f"Training final model on {len(train_x_all)} samples")
    model = CatBoostRegressor(**MODEL_PARAMS)
    model.fit(train_x_all, train_y_all, sample_weight=train_weights_all)

    model_path = output_path / "model.cbm"
    if verbose:
        log_progress(f"Saving model artifact to {model_path}")
    model.save_model(str(model_path))

    active_metrics = evaluate_active_model(str(output_path.parent / "current" / "model.cbm"), rows, folds)
    metrics_payload = {
        "model": model_metrics,
        "flat_2200": flat_metrics,
        "hour_of_week": hour_week_metrics,
        "hybrid": hybrid_metrics,
        "active_model": active_metrics,
        "fold_count": len(folds),
    }

    training_window = {
        "start": valid_rows[0].hour_utc if valid_rows else "",
        "end": valid_rows[-1].hour_utc if valid_rows else "",
    }
    manifest = {
        "model_type": "catboost",
        "model_version": output_path.name,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "feature_count": len(FEATURE_NAMES),
        "feature_names": FEATURE_NAMES,
        "target_mode": MODEL_TARGET_MODE,
        "trained_at": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "training_window": training_window,
        "history_row_count": len(rows),
        "hourly_row_count": len(valid_rows),
        "metrics_summary": model_metrics,
        "training_data_summary": {
            "forward_feature_coverage": {
                "history_forecast_solar_ratio": (history_summary.history_forecast_solar_hours / history_summary.total_hours) if history_summary.total_hours > 0 else 0.0,
                "solar_proxy_ratio": (history_summary.solar_proxy_hours / history_summary.total_hours) if history_summary.total_hours > 0 else 0.0,
                "realized_solar_fallback_ratio": (history_summary.realized_solar_fallback_hours / history_summary.total_hours) if history_summary.total_hours > 0 else 0.0,
            }
        },
        "walk_forward_metrics": {
            "model_mae": model_metrics["mae"],
            "model_rmse": model_metrics["rmse"],
            "model_p90_absolute_error": model_metrics["p90_absolute_error"],
            "hybrid_mae": hybrid_metrics["mae"],
            "hybrid_p90_economic_hours_absolute_error": hybrid_metrics["p90_economic_hours_absolute_error"],
        },
        "replay_metrics": {},
        "promotion_decision": "pending_evaluation",
        "catboost_version": getattr(catboost, "__version__", "unknown"),
    }
    with open(output_path / "manifest.json", "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    with open(output_path / "metrics.json", "w", encoding="utf-8") as handle:
        json.dump(metrics_payload, handle, indent=2)
    with open(output_path / "training.log", "w", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "history_row_count": len(rows),
            "hourly_row_count": len(valid_rows),
            "fold_count": len(folds),
            "trained_at": manifest["trained_at"],
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "feature_names": FEATURE_NAMES,
        }, indent=2))
    if verbose:
        log_progress(
            "Training complete "
            f"(mae={model_metrics['mae']:.2f}, hybrid_mae={hybrid_metrics['mae']:.2f}, "
            f"folds={len(folds)})",
        )

    return {
        "manifest": manifest,
        "metrics": metrics_payload,
        "rows": rows,
        "folds": folds,
    }
