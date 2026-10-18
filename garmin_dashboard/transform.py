"""Pure functions that turn raw Garmin Connect API responses into flat CSV rows.

Nothing in this module talks to the network, so it can be unit tested with
small fixture dictionaries (see tests/test_transform.py).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

SLEEP_FIELDS = [
    "date",
    "sleep_hours",
    "sleep_score",
    "deep_hours",
    "light_hours",
    "rem_hours",
    "awake_min",
    "hrv_ms",
    "bedtime",
    "wake_time",
]
DAILY_FIELDS = ["date", "steps", "active_kcal", "resting_hr", "stress_avg"]
INTENSITY_FIELDS = ["week_start", "moderate_min", "vigorous_min", "total_min", "goal_min"]
STATUS_FIELDS = ["metric", "value"]


def _get(data: Any, *path: str, default: Any = None) -> Any:
    """Walk nested dictionaries safely: _get(d, "a", "b") == d["a"]["b"] or default."""
    for key in path:
        if not isinstance(data, dict) or key not in data or data[key] is None:
            return default
        data = data[key]
    return data


def _hours(seconds: Any) -> float | str:
    return round(seconds / 3600, 2) if isinstance(seconds, (int, float)) else ""


def _local_clock(ms: Any) -> str:
    """Garmin's *TimestampLocal fields are epoch milliseconds in local wall time."""
    if not isinstance(ms, (int, float)):
        return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%M")


def sleep_row(date: str, raw: dict[str, Any]) -> dict[str, Any] | None:
    """One night of sleep. Returns None when the watch recorded no sleep."""
    dto = _get(raw, "dailySleepDTO", default={})
    total = dto.get("sleepTimeSeconds")
    if not total:
        return None
    awake = dto.get("awakeSleepSeconds")
    return {
        "date": date,
        "sleep_hours": _hours(total),
        "sleep_score": _get(dto, "sleepScores", "overall", "value", default=""),
        "deep_hours": _hours(dto.get("deepSleepSeconds")),
        "light_hours": _hours(dto.get("lightSleepSeconds")),
        "rem_hours": _hours(dto.get("remSleepSeconds")),
        "awake_min": round(awake / 60) if isinstance(awake, (int, float)) else "",
        "hrv_ms": _get(raw, "avgOvernightHrv", default=""),
        "bedtime": _local_clock(dto.get("sleepStartTimestampLocal")),
        "wake_time": _local_clock(dto.get("sleepEndTimestampLocal")),
    }


def daily_row(date: str, raw: dict[str, Any]) -> dict[str, Any] | None:
    """Steps, calories, resting heart rate and stress for one day."""
    steps = raw.get("totalSteps") if isinstance(raw, dict) else None
    if steps is None:
        return None
    stress = raw.get("averageStressLevel")
    return {
        "date": date,
        "steps": steps,
        "active_kcal": raw.get("activeKilocalories") or 0,
        "resting_hr": raw.get("restingHeartRate") or "",
        # Garmin uses negative values to mean "not enough data".
        "stress_avg": stress if isinstance(stress, (int, float)) and stress >= 0 else "",
    }


def intensity_rows(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Weekly intensity minutes. Garmin counts vigorous minutes twice toward the goal."""
    rows = []
    for week in raw or []:
        moderate = week.get("moderateValue") or 0
        vigorous = week.get("vigorousValue") or 0
        rows.append(
            {
                "week_start": week.get("calendarDate", ""),
                "moderate_min": moderate,
                "vigorous_min": vigorous,
                "total_min": moderate + 2 * vigorous,
                "goal_min": week.get("weeklyGoal") or 150,
            }
        )
    return sorted(rows, key=lambda r: r["week_start"])


def _clock(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return ""
    s = round(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _training_status(raw: dict[str, Any]) -> tuple[str, Any, Any]:
    """Pull the feedback phrase and acute/chronic load out of the nested response."""
    latest = _get(raw, "mostRecentTrainingStatus", "latestTrainingStatusData", default={})
    for device in latest.values() if isinstance(latest, dict) else []:
        phrase = device.get("trainingStatusFeedbackPhrase") or ""
        load = device.get("acuteTrainingLoadDTO") or {}
        status = phrase.split("_")[0].title() if phrase else ""
        return status, load.get("dailyTrainingLoadAcute", ""), load.get("dailyTrainingLoadChronic", "")
    return "", "", ""


def status_rows(
    fitness_age: dict[str, Any],
    training_status: dict[str, Any],
    race_predictions: dict[str, Any],
    last_sync: str,
) -> list[dict[str, Any]]:
    """A small key/value table of point-in-time metrics."""
    status, acute, chronic = _training_status(training_status)
    fa = fitness_age.get("fitnessAge")
    metrics = {
        "fitness_age": round(fa) if isinstance(fa, (int, float)) else "",
        "chronological_age": fitness_age.get("chronologicalAge", ""),
        "resting_hr": _get(fitness_age, "components", "rhr", "value", default=""),
        "vigorous_min_week": _get(fitness_age, "components", "vigorousMinutesAvg", "value", default=""),
        "training_status": status,
        "acute_load": acute,
        "chronic_load": chronic,
        "race_5k": _clock(race_predictions.get("time5K")),
        "race_10k": _clock(race_predictions.get("time10K")),
        "race_half": _clock(race_predictions.get("timeHalfMarathon")),
        "race_marathon": _clock(race_predictions.get("timeMarathon")),
        "last_sync": last_sync,
    }
    return [{"metric": k, "value": v} for k, v in metrics.items()]
