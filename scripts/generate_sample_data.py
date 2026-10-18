"""Generate realistic but fake data in the same format as garmin_dashboard.fetch.

The public demo on GitHub Pages runs on this data, so no real health data
ever needs to be committed. The output is deterministic (fixed seed).

Usage:
    python scripts/generate_sample_data.py            # writes docs/sample/
    python scripts/generate_sample_data.py --check    # fails if docs/sample/ is out of date
"""

from __future__ import annotations

import argparse
import csv
import io
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from garmin_dashboard import transform  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "docs" / "sample"
END = date(2026, 10, 4)
DAYS = 30


def _clock(hours: float) -> str:
    minutes = round(hours * 60) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def build() -> dict[str, tuple[list[str], list[dict]]]:
    rnd = random.Random(2026)
    dates = [END - timedelta(days=i) for i in range(DAYS - 1, -1, -1)]

    sleep, daily = [], []
    for i, d in enumerate(dates):
        bed = 23.6 + rnd.uniform(-0.6, 1.8)  # 23:00 to 01:25
        hours = max(4.8, min(9.9, rnd.gauss(7.7, 0.9)))
        deep = hours * rnd.uniform(0.12, 0.28)
        rem = hours * rnd.uniform(0.08, 0.26)
        score = round(max(50, min(96, 60 + (hours - 5) * 7 + rnd.gauss(0, 4))))
        sleep.append(
            {
                "date": d.isoformat(),
                "sleep_hours": round(hours, 2),
                "sleep_score": score,
                "deep_hours": round(deep, 2),
                "light_hours": round(hours - deep - rem, 2),
                "rem_hours": round(rem, 2),
                "awake_min": rnd.randint(0, 55),
                "hrv_ms": round(rnd.gauss(98, 6)),
                "bedtime": _clock(bed),
                "wake_time": _clock(bed + hours + rnd.uniform(0.05, 0.6)),
            }
        )
        trend = 10500 - i * 90  # slowly fewer steps
        steps = max(900, round(rnd.gauss(trend, 3000)))
        daily.append(
            {
                "date": d.isoformat(),
                "steps": steps,
                "active_kcal": round(steps * rnd.uniform(0.012, 0.03)),
                "resting_hr": round(rnd.gauss(41, 1.5)),
                "stress_avg": round(max(8, rnd.gauss(18 - i * 0.15, 4))),
            }
        )

    first_monday = END - timedelta(days=END.weekday() + 7 * 6)
    intensity = []
    for w in range(7):
        moderate, vigorous = rnd.randint(0, 32), rnd.randint(0, 8)
        intensity.append(
            {
                "week_start": (first_monday + timedelta(weeks=w)).isoformat(),
                "moderate_min": moderate,
                "vigorous_min": vigorous,
                "total_min": moderate + 2 * vigorous,
                "goal_min": 150,
            }
        )

    status = [
        {"metric": k, "value": v}
        for k, v in {
            "fitness_age": 19,
            "chronological_age": 23,
            "resting_hr": 41,
            "vigorous_min_week": 4.1,
            "training_status": "Detraining",
            "acute_load": 12,
            "chronic_load": 205,
            "race_5k": "23:20",
            "race_10k": "51:05",
            "race_half": "1:57:30",
            "race_marathon": "4:26:10",
            "last_sync": END.isoformat(),
        }.items()
    ]

    return {
        "sleep.csv": (transform.SLEEP_FIELDS, sleep),
        "daily.csv": (transform.DAILY_FIELDS, daily),
        "intensity.csv": (transform.INTENSITY_FIELDS, intensity),
        "status.csv": (transform.STATUS_FIELDS, status),
    }


def render(fields: list[str], rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="only verify the committed files")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    stale = []
    for name, (fields, rows) in build().items():
        text = render(fields, rows)
        path = OUT / name
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(name)
        else:
            path.write_text(text, encoding="utf-8")
            print(f"wrote {path}")
    if stale:
        print("Out of date: " + ", ".join(stale) + ". Run scripts/generate_sample_data.py", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
