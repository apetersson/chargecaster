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

FEATURE_SCHEMA_VERSION = "v1_price_total_1"
DEFAULT_TOTAL_PRICE_EUR_PER_KWH = 0.22
MIN_TOTAL_PRICE_EUR_PER_KWH = 0.04
MAX_TOTAL_PRICE_EUR_PER_KWH = 0.65
VIENNA_TIME_ZONE = "Europe/Vienna"

AUSTRIA_WEATHER_POINTS = [
    (48.2082, 16.3738),
    (48.3069, 14.2858),
    (47.0707, 15.4395),
    (47.8095, 13.0550),
    (47.2692, 11.4041),
    (46.6247, 14.3053),
]

AUSTRIA_SOLAR_POINTS = [
    (48.2082, 16.3738, 1.0, 35.0, 180.0),
    (48.3069, 14.2858, 1.0, 35.0, 180.0),
    (47.0707, 15.4395, 1.0, 35.0, 180.0),
    (47.8095, 13.0550, 1.0, 35.0, 180.0),
    (47.2692, 11.4041, 1.0, 35.0, 180.0),
    (46.6247, 14.3053, 1.0, 35.0, 180.0),
]

MODEL_PARAMS = {
    "loss_function": "RMSE",
    "eval_metric": "MAE",
    "iterations": 160,
    "depth": 6,
    "learning_rate": 0.05,
    "l2_leaf_reg": 12.0,
    "random_seed": 42,
    "verbose": False,
    "allow_writing_files": False,
}


@dataclass
class HistoricalPriceHour:
    hour_utc: str
    dt_utc: datetime
    local_hour: int
    weekday: int
    month: int
    season: int
    total_price_eur_per_kwh: float
    solar_proxy_w: float
    cloud_cover: float | None
    wind_speed_10m: float | None
    precipitation_mm: float | None
    valid_target: bool


@dataclass
class FuturePriceContext:
    hour_utc: str
    dt_utc: datetime
    local_hour: int
    weekday: int
    month: int
    season: int
    solar_proxy_w: float
    cloud_cover: float | None
    wind_speed_10m: float | None
    precipitation_mm: float | None


def log_progress(message: str) -> None:
    print(f"[price-forecast] {message}", file=sys.stderr, flush=True)


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


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round((len(ordered) - 1) * ratio)))]


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


def to_local_parts(dt_utc: datetime, tz_name: str = VIENNA_TIME_ZONE) -> tuple[int, int, int]:
    local_dt = dt_utc.astimezone(ZoneInfo(tz_name))
    return local_dt.hour, local_dt.weekday(), local_dt.month


def load_hourly_history(db_path: str) -> list[HistoricalPriceHour]:
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    history_rows = connection.execute("SELECT payload FROM history ORDER BY timestamp ASC").fetchall()

    grouped: dict[str, dict[str, float | int]] = {}
    for row in history_rows:
        payload = json.loads(row["payload"])
        timestamp = payload.get("timestamp")
        price = payload.get("price_eur_per_kwh")
        if not isinstance(timestamp, str) or not isinstance(price, (int, float)):
            continue
        dt = parse_iso(timestamp)
        hour_utc = iso_utc(dt)
        bucket = grouped.setdefault(hour_utc, {"price_sum": 0.0, "price_count": 0})
        bucket["price_sum"] += float(price)
        bucket["price_count"] += 1

    if not grouped:
        connection.close()
        return []

    min_hour = min(grouped.keys())
    max_hour = max(grouped.keys())

    weather_rows = connection.execute(
        """
        SELECT hour_utc, latitude, longitude, temperature_2m, cloud_cover, wind_speed_10m, precipitation_mm
        FROM weather_hourly_cache
        WHERE hour_utc >= ? AND hour_utc <= ?
        ORDER BY hour_utc ASC
        """,
        (min_hour, max_hour),
    ).fetchall()
    solar_rows = connection.execute(
        """
        SELECT hour_utc, latitude, longitude, kwp, tilt, azimuth, expected_power_w
        FROM solar_proxy_hourly_cache
        WHERE hour_utc >= ? AND hour_utc <= ?
        ORDER BY hour_utc ASC
        """,
        (min_hour, max_hour),
    ).fetchall()
    connection.close()

    weather_map = aggregate_weather_rows(weather_rows)
    solar_map = aggregate_solar_rows(solar_rows)

    rows: list[HistoricalPriceHour] = []
    for hour_utc in sorted(grouped.keys()):
        bucket = grouped[hour_utc]
        dt_utc = parse_iso(hour_utc)
        local_hour, weekday, month = to_local_parts(dt_utc)
        weather = weather_map.get(hour_utc, {})
        total_price = (
            float(bucket["price_sum"]) / int(bucket["price_count"])
            if int(bucket["price_count"]) > 0
            else DEFAULT_TOTAL_PRICE_EUR_PER_KWH
        )
        rows.append(HistoricalPriceHour(
            hour_utc=hour_utc,
            dt_utc=dt_utc,
            local_hour=local_hour,
            weekday=weekday,
            month=month,
            season=season_from_month(month),
            total_price_eur_per_kwh=clamp(total_price, MIN_TOTAL_PRICE_EUR_PER_KWH, MAX_TOTAL_PRICE_EUR_PER_KWH),
            solar_proxy_w=float(solar_map.get(hour_utc, 0.0) or 0.0),
            cloud_cover=weather.get("cloud_cover"),
            wind_speed_10m=weather.get("wind_speed_10m"),
            precipitation_mm=weather.get("precipitation_mm"),
            valid_target=int(bucket["price_count"]) >= 1,
        ))
    return rows


def aggregate_weather_rows(rows: list[sqlite3.Row]) -> dict[str, dict[str, float | None]]:
    allowed = {(round(lat, 4), round(lon, 4)) for lat, lon in AUSTRIA_WEATHER_POINTS}
    grouped: dict[str, dict[str, float]] = {}
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        key = (round(float(row["latitude"]), 4), round(float(row["longitude"]), 4))
        if key not in allowed:
            continue
        hour_utc = str(row["hour_utc"])
        grouped.setdefault(hour_utc, {"cloud_cover": 0.0, "wind_speed_10m": 0.0, "precipitation_mm": 0.0})
        counts.setdefault(hour_utc, {"cloud_cover": 0, "wind_speed_10m": 0, "precipitation_mm": 0})
        if row["cloud_cover"] is not None:
            grouped[hour_utc]["cloud_cover"] += float(row["cloud_cover"])
            counts[hour_utc]["cloud_cover"] += 1
        if row["wind_speed_10m"] is not None:
            grouped[hour_utc]["wind_speed_10m"] += float(row["wind_speed_10m"])
            counts[hour_utc]["wind_speed_10m"] += 1
        if row["precipitation_mm"] is not None:
            grouped[hour_utc]["precipitation_mm"] += float(row["precipitation_mm"])
            counts[hour_utc]["precipitation_mm"] += 1
    result: dict[str, dict[str, float | None]] = {}
    for hour_utc, values in grouped.items():
        result[hour_utc] = {
            field: (values[field] / counts[hour_utc][field]) if counts[hour_utc][field] > 0 else None
            for field in ("cloud_cover", "wind_speed_10m", "precipitation_mm")
        }
    return result


def aggregate_solar_rows(rows: list[sqlite3.Row]) -> dict[str, float]:
    allowed = {
        (round(lat, 4), round(lon, 4), round(kwp, 3), round(tilt, 3), round(azimuth, 3))
        for lat, lon, kwp, tilt, azimuth in AUSTRIA_SOLAR_POINTS
    }
    grouped: dict[str, tuple[float, int]] = {}
    for row in rows:
        key = (
            round(float(row["latitude"]), 4),
            round(float(row["longitude"]), 4),
            round(float(row["kwp"]), 3),
            round(float(row["tilt"]), 3),
            round(float(row["azimuth"]), 3),
        )
        if key not in allowed or row["expected_power_w"] is None:
            continue
        hour_utc = str(row["hour_utc"])
        total, count = grouped.get(hour_utc, (0.0, 0))
        grouped[hour_utc] = (total + float(row["expected_power_w"]), count + 1)
    return {
        hour_utc: total / count
        for hour_utc, (total, count) in grouped.items()
        if count > 0
    }


def build_baselines(rows: list[HistoricalPriceHour]) -> dict[str, Any]:
    now_ms = datetime.now(tz=timezone.utc).timestamp() * 1000.0
    hour_week = build_weighted_average_map(rows, lambda row: f"{row.weekday}:{row.local_hour}", now_ms)
    season_hour = build_weighted_average_map(rows, lambda row: f"{row.season}:{row.local_hour}", now_ms)
    hour_only: dict[int, float] = {}
    for hour in range(24):
        subset = [row for row in rows if row.local_hour == hour]
        if subset:
            hour_only[hour] = weighted_average(subset, now_ms)
    return {"hour_week": hour_week, "season_hour": season_hour, "hour_only": hour_only}


def build_weighted_average_map(rows: list[HistoricalPriceHour], key_fn, now_ms: float) -> dict[str, float]:
    totals: dict[str, tuple[float, float]] = {}
    for row in rows:
        key = key_fn(row)
        age_days = max(0.0, (now_ms - row.dt_utc.timestamp() * 1000.0) / 86_400_000.0)
        weight = math.exp(-age_days / 35.0)
        weighted, total = totals.get(key, (0.0, 0.0))
        totals[key] = (weighted + row.total_price_eur_per_kwh * weight, total + weight)
    return {key: weighted / total for key, (weighted, total) in totals.items() if total > 0}


def weighted_average(rows: list[HistoricalPriceHour], now_ms: float) -> float:
    weighted_sum = 0.0
    total_weight = 0.0
    for row in rows:
        age_days = max(0.0, (now_ms - row.dt_utc.timestamp() * 1000.0) / 86_400_000.0)
        weight = math.exp(-age_days / 35.0)
        weighted_sum += row.total_price_eur_per_kwh * weight
        total_weight += weight
    return weighted_sum / total_weight if total_weight > 0 else DEFAULT_TOTAL_PRICE_EUR_PER_KWH


def predict_baseline_total_price(context: HistoricalPriceHour | FuturePriceContext, baselines: dict[str, Any], fallback: float) -> float:
    hour_week = baselines["hour_week"].get(f"{context.weekday}:{context.local_hour}")
    season_hour = baselines["season_hour"].get(f"{context.season}:{context.local_hour}")
    hour_only = baselines["hour_only"].get(context.local_hour)
    if hour_week is not None and season_hour is not None and hour_only is not None:
        return hour_week * 0.58 + season_hour * 0.24 + hour_only * 0.18
    if hour_week is not None and hour_only is not None:
        return hour_week * 0.72 + hour_only * 0.28
    if season_hour is not None and hour_only is not None:
        return season_hour * 0.65 + hour_only * 0.35
    return hour_week or season_hour or hour_only or fallback


def compute_weather_adjustment(context: HistoricalPriceHour | FuturePriceContext) -> float:
    solar_norm = clamp(context.solar_proxy_w / 850.0, 0.0, 1.4)
    wind_norm = clamp((context.wind_speed_10m or 0.0) / 18.0, 0.0, 1.3)
    cloud_norm = clamp((context.cloud_cover or 0.0) / 100.0, 0.0, 1.0)
    precipitation_norm = clamp((context.precipitation_mm or 0.0) / 3.0, 0.0, 1.2)
    is_weekday = 0 <= context.weekday <= 4
    morning_peak = 0.008 if is_weekday and 7 <= context.local_hour <= 9 else 0.0
    evening_peak = 0.018 if is_weekday and 17 <= context.local_hour <= 20 else 0.0
    midday_dip = -0.01 if 10 <= context.local_hour <= 15 else 0.0
    solar_adjustment = -0.03 * solar_norm
    wind_adjustment = -0.012 * wind_norm
    cloud_adjustment = 0.004 * cloud_norm if solar_norm > 0.2 else 0.0
    precipitation_adjustment = 0.003 * precipitation_norm
    weekend_adjustment = -0.004 if context.weekday >= 5 and 11 <= context.local_hour <= 15 else 0.0
    return solar_adjustment + wind_adjustment + cloud_adjustment + precipitation_adjustment + morning_peak + evening_peak + midday_dip + weekend_adjustment


def offset_hour_iso(hour_utc: str, offset_hours: int) -> str:
    return iso_utc(parse_iso(hour_utc) + timedelta(hours=offset_hours))


def build_heuristic_total_price_series(history: list[HistoricalPriceHour], contexts: list[FuturePriceContext]) -> list[float]:
    baselines = build_baselines(history)
    history_by_hour = {row.hour_utc: row.total_price_eur_per_kwh for row in history}
    recent_mean = average([row.total_price_eur_per_kwh for row in history[-24:]]) or DEFAULT_TOTAL_PRICE_EUR_PER_KWH
    predicted_by_hour: dict[str, float] = {}
    previous_total = history[-1].total_price_eur_per_kwh if history else DEFAULT_TOTAL_PRICE_EUR_PER_KWH
    totals: list[float] = []

    for context in contexts:
        baseline = predict_baseline_total_price(context, baselines, recent_mean)
        lag24 = predicted_by_hour.get(offset_hour_iso(context.hour_utc, -24), history_by_hour.get(offset_hour_iso(context.hour_utc, -24)))
        lag168 = history_by_hour.get(offset_hour_iso(context.hour_utc, -168))
        weather_adjustment = compute_weather_adjustment(context)
        recency_adjustment = clamp((recent_mean - baseline) * 0.18, -0.03, 0.03)

        total_price = baseline * 0.6
        total_price += (lag24 if lag24 is not None else baseline) * (0.22 if lag24 is not None else 0.0)
        total_price += (lag168 if lag168 is not None else baseline) * (0.1 if lag168 is not None else 0.0)
        total_price += previous_total * 0.08
        total_price += weather_adjustment + recency_adjustment
        total_price = total_price * 0.84 + previous_total * 0.16
        total_price = clamp(total_price, MIN_TOTAL_PRICE_EUR_PER_KWH, MAX_TOTAL_PRICE_EUR_PER_KWH)

        totals.append(total_price)
        predicted_by_hour[context.hour_utc] = total_price
        previous_total = total_price

    return totals


def build_feature_row(
    context: HistoricalPriceHour | FuturePriceContext,
    heuristic: float,
    previous_total: float,
    lag24: float,
    lag48: float,
    lag168: float,
    recent_mean24: float,
    recent_mean168: float,
    index: int,
) -> list[float]:
    return [
        float(context.local_hour),
        float(context.weekday),
        float(context.month),
        float(context.season),
        math.sin((context.local_hour / 24.0) * math.pi * 2.0),
        math.cos((context.local_hour / 24.0) * math.pi * 2.0),
        math.sin((context.weekday / 7.0) * math.pi * 2.0),
        math.cos((context.weekday / 7.0) * math.pi * 2.0),
        heuristic,
        previous_total,
        lag24,
        lag48,
        lag168,
        recent_mean24,
        recent_mean168,
        context.solar_proxy_w,
        context.cloud_cover if context.cloud_cover is not None else -1.0,
        context.wind_speed_10m if context.wind_speed_10m is not None else -1.0,
        context.precipitation_mm if context.precipitation_mm is not None else -1.0,
        float(index),
    ]


def build_training_samples(train_rows: list[HistoricalPriceHour]) -> tuple[list[list[float]], list[float], list[float]]:
    rows = [row for row in train_rows if row.valid_target]
    if len(rows) < 8:
        return [], [], []

    baselines = build_baselines(rows)
    history_by_hour: dict[str, float] = {}
    rolling_totals: list[float] = []
    features: list[list[float]] = []
    targets: list[float] = []
    sample_weights: list[float] = []
    price_values = [row.total_price_eur_per_kwh for row in rows]
    high_price_threshold = percentile(price_values, 0.75)

    for index, row in enumerate(rows):
        if len(rolling_totals) < 24:
            history_by_hour[row.hour_utc] = row.total_price_eur_per_kwh
            rolling_totals.append(row.total_price_eur_per_kwh)
            continue

        recent_mean24 = average(rolling_totals[-24:]) or DEFAULT_TOTAL_PRICE_EUR_PER_KWH
        recent_mean168 = average(rolling_totals[-168:]) or recent_mean24
        baseline = predict_baseline_total_price(row, baselines, recent_mean24)
        lag24 = history_by_hour.get(offset_hour_iso(row.hour_utc, -24), baseline)
        lag48 = history_by_hour.get(offset_hour_iso(row.hour_utc, -48), lag24)
        lag168 = history_by_hour.get(offset_hour_iso(row.hour_utc, -168), lag48)
        weather_adjustment = compute_weather_adjustment(row)
        recency_adjustment = clamp((recent_mean24 - baseline) * 0.18, -0.03, 0.03)
        heuristic = baseline * 0.6 + lag24 * 0.22 + lag168 * 0.1 + rolling_totals[-1] * 0.08 + weather_adjustment + recency_adjustment
        heuristic = heuristic * 0.84 + rolling_totals[-1] * 0.16
        heuristic = clamp(heuristic, MIN_TOTAL_PRICE_EUR_PER_KWH, MAX_TOTAL_PRICE_EUR_PER_KWH)

        features.append(build_feature_row(
            row,
            heuristic,
            rolling_totals[-1],
            lag24,
            lag48,
            lag168,
            recent_mean24,
            recent_mean168,
            index,
        ))
        targets.append(row.total_price_eur_per_kwh)

        weight = 1.0
        if row.total_price_eur_per_kwh >= high_price_threshold:
            weight += 0.5
        if 6 <= row.local_hour <= 9 or 17 <= row.local_hour <= 21:
            weight += 0.2
        if row.solar_proxy_w >= 300.0:
            weight += 0.15
        sample_weights.append(weight)

        history_by_hour[row.hour_utc] = row.total_price_eur_per_kwh
        rolling_totals.append(row.total_price_eur_per_kwh)

    return features, targets, sample_weights


def sequential_model_predict(model: CatBoostRegressor, history_rows: list[HistoricalPriceHour], eval_rows: list[HistoricalPriceHour]) -> list[float]:
    contexts = [historical_to_context(row) for row in eval_rows]
    heuristics = build_heuristic_total_price_series(history_rows, contexts)
    history_by_hour = {row.hour_utc: row.total_price_eur_per_kwh for row in history_rows}
    predicted_by_hour: dict[str, float] = {}
    recent_mean24 = average([row.total_price_eur_per_kwh for row in history_rows[-24:]]) or DEFAULT_TOTAL_PRICE_EUR_PER_KWH
    recent_mean168 = average([row.total_price_eur_per_kwh for row in history_rows[-168:]]) or recent_mean24
    previous_total = history_rows[-1].total_price_eur_per_kwh if history_rows else DEFAULT_TOTAL_PRICE_EUR_PER_KWH
    predictions: list[float] = []

    for index, context in enumerate(contexts):
        heuristic = heuristics[index] if index < len(heuristics) else previous_total
        lag24 = predicted_by_hour.get(offset_hour_iso(context.hour_utc, -24), history_by_hour.get(offset_hour_iso(context.hour_utc, -24), heuristic))
        lag48 = history_by_hour.get(offset_hour_iso(context.hour_utc, -48), lag24)
        lag168 = history_by_hour.get(offset_hour_iso(context.hour_utc, -168), lag48)
        features = build_feature_row(
            context,
            heuristic,
            previous_total,
            lag24,
            lag48,
            lag168,
            recent_mean24,
            recent_mean168,
            index,
        )
        prediction = float(model.predict([features])[0])
        prediction = clamp(prediction, MIN_TOTAL_PRICE_EUR_PER_KWH, MAX_TOTAL_PRICE_EUR_PER_KWH)
        predictions.append(prediction)
        predicted_by_hour[context.hour_utc] = prediction
        previous_total = prediction
    return predictions


def sequential_heuristic_predict(history_rows: list[HistoricalPriceHour], eval_rows: list[HistoricalPriceHour]) -> list[float]:
    contexts = [historical_to_context(row) for row in eval_rows]
    return build_heuristic_total_price_series(history_rows, contexts)


def historical_to_context(row: HistoricalPriceHour) -> FuturePriceContext:
    return FuturePriceContext(
        hour_utc=row.hour_utc,
        dt_utc=row.dt_utc,
        local_hour=row.local_hour,
        weekday=row.weekday,
        month=row.month,
        season=row.season,
        solar_proxy_w=row.solar_proxy_w,
        cloud_cover=row.cloud_cover,
        wind_speed_10m=row.wind_speed_10m,
        precipitation_mm=row.precipitation_mm,
    )


def evaluate_active_model(model_path: str, history_rows: list[HistoricalPriceHour], folds: list[tuple[list[HistoricalPriceHour], list[HistoricalPriceHour]]]) -> dict[str, float] | None:
    if not Path(model_path).exists():
        return None
    model = CatBoostRegressor()
    model.load_model(model_path)
    actuals: list[float] = []
    predictions: list[float] = []
    for train_rows, eval_rows in folds:
        fold_predictions = sequential_model_predict(model, train_rows, eval_rows)
        actuals.extend(row.total_price_eur_per_kwh for row in eval_rows)
        predictions.extend(fold_predictions)
    return compute_metrics(actuals, predictions)


def build_walk_forward_folds(rows: list[HistoricalPriceHour]) -> list[tuple[list[HistoricalPriceHour], list[HistoricalPriceHour]]]:
    valid_rows = [row for row in rows if row.valid_target]
    folds: list[tuple[list[HistoricalPriceHour], list[HistoricalPriceHour]]] = []
    if not valid_rows:
        return folds
    start_time = valid_rows[0].dt_utc + timedelta(days=28)
    final_time = valid_rows[-1].dt_utc
    cutoff = start_time
    while cutoff + timedelta(hours=24) <= final_time:
        train_rows = [row for row in valid_rows if row.dt_utc < cutoff]
        eval_rows = [row for row in valid_rows if cutoff <= row.dt_utc < cutoff + timedelta(hours=24)]
        if len(train_rows) >= 24 * 28 and len(eval_rows) >= 12:
            folds.append((train_rows, eval_rows))
        cutoff += timedelta(hours=24)
    return folds


def train_and_evaluate(db_path: str, config_path: str, output_dir: str, verbose: bool = False) -> dict[str, Any]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    if verbose:
        log_progress(f"Loading config from {config_path}")
    _config = load_config(config_path)
    if verbose:
        log_progress(f"Loading hourly history from {db_path}")
    rows = load_hourly_history(db_path)
    valid_rows = [row for row in rows if row.valid_target]
    if verbose:
        log_progress(f"Loaded {len(rows)} hourly rows ({len(valid_rows)} valid targets)")
    folds = build_walk_forward_folds(rows)
    if verbose:
        log_progress(f"Built {len(folds)} walk-forward folds")

    actuals: list[float] = []
    model_predictions: list[float] = []
    heuristic_predictions: list[float] = []

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
        fold_heuristic_predictions = sequential_heuristic_predict(train_rows, eval_rows)
        actuals.extend(row.total_price_eur_per_kwh for row in eval_rows)
        model_predictions.extend(fold_model_predictions)
        heuristic_predictions.extend(fold_heuristic_predictions)

    model_metrics = compute_metrics(actuals, model_predictions)
    heuristic_metrics = compute_metrics(actuals, heuristic_predictions)
    model_metrics["mae_vs_heuristic_improvement_ratio"] = (
        (heuristic_metrics["mae"] - model_metrics["mae"]) / heuristic_metrics["mae"]
        if heuristic_metrics["mae"] > 0
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
        "heuristic": heuristic_metrics,
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
        "trained_at": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "training_window": training_window,
        "history_row_count": len(rows),
        "hourly_row_count": len(valid_rows),
        "metrics_summary": model_metrics,
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
        }, indent=2))
    if verbose:
        log_progress(
            "Training complete "
            f"(mae={model_metrics['mae']:.5f}, heuristic_mae={heuristic_metrics['mae']:.5f}, "
            f"folds={len(folds)})",
        )

    return {
        "manifest": manifest,
        "metrics": metrics_payload,
        "rows": rows,
        "folds": folds,
    }
