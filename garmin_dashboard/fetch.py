"""Download your own Garmin Connect data and write it as CSV files for the dashboard.

Usage:
    python -m garmin_dashboard.fetch --days 30

Credentials are read from the GARMIN_EMAIL and GARMIN_PASSWORD environment
variables, or asked for interactively. They are never accepted as command
line arguments, because arguments end up in shell history and process lists.
After the first login the session tokens are stored in a private folder
(default ~/.garminconnect) so the password is not needed again.
"""

from __future__ import annotations

import argparse
import csv
import getpass
import logging
import os
import stat
import sys
import time
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from . import transform

log = logging.getLogger("garmin_dashboard")
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "docs" / "data"
DEFAULT_TOKENS = Path("~/.garminconnect").expanduser()
REQUEST_PAUSE_S = 0.4  # be polite to Garmin's API


def _private_dir(path: Path) -> Path:
    """Create a folder only the current user can read (tokens are secrets)."""
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        path.chmod(stat.S_IRWXU)
    return path


def login(tokenstore: Path) -> Garmin:
    _private_dir(tokenstore)
    has_tokens = any(tokenstore.iterdir())
    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")
    if not has_tokens:
        email = email or input("Garmin email: ").strip()
        password = password or getpass.getpass("Garmin password: ")
    client = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
    client.login(str(tokenstore))
    return client


def _safe(call: Callable[[], Any], what: str, default: Any) -> Any:
    """Run one API call; log and keep going if it fails, so one gap doesn't stop the run."""
    try:
        result = call()
        time.sleep(REQUEST_PAUSE_S)
        return result if result is not None else default
    except GarminConnectTooManyRequestsError:
        raise
    except (GarminConnectConnectionError, KeyError, ValueError, TypeError) as exc:
        log.warning("Skipped %s: %s", what, exc)
        return default


def _write_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    log.info("Wrote %d rows to %s", len(rows), path)


def fetch(client: Garmin, end: date, days: int, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    dates = [(end - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]

    sleep, daily = [], []
    for d in dates:
        log.info("Fetching %s", d)
        if row := transform.sleep_row(d, _safe(lambda d=d: client.get_sleep_data(d), f"sleep {d}", {})):
            sleep.append(row)
        if row := transform.daily_row(d, _safe(lambda d=d: client.get_stats(d), f"stats {d}", {})):
            daily.append(row)

    start = (end - timedelta(days=days + 6)).isoformat()
    intensity = transform.intensity_rows(
        _safe(lambda: client.get_weekly_intensity_minutes(start, end.isoformat()), "intensity", [])
    )

    races = _safe(client.get_race_predictions, "race predictions", {})
    if isinstance(races, list):
        races = races[-1] if races else {}
    data_until = max((r["date"] for r in daily if r["steps"]), default="")
    status = transform.status_rows(
        _safe(lambda: client.get_fitnessage_data(end.isoformat()), "fitness age", {}),
        _safe(lambda: client.get_training_status(end.isoformat()), "training status", {}),
        races,
        data_until,
    )

    _write_csv(out / "sleep.csv", transform.SLEEP_FIELDS, sleep)
    _write_csv(out / "daily.csv", transform.DAILY_FIELDS, daily)
    _write_csv(out / "intensity.csv", transform.INTENSITY_FIELDS, intensity)
    _write_csv(out / "status.csv", transform.STATUS_FIELDS, status)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=30, help="how many days back to fetch (default 30)")
    parser.add_argument(
        "--end", type=date.fromisoformat, default=date.today(), help="last day, YYYY-MM-DD (default today)"
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default docs/data, git-ignored)")
    parser.add_argument("--tokenstore", type=Path, default=DEFAULT_TOKENS, help="where session tokens are kept")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    if not 1 <= args.days <= 365:
        parser.error("--days must be between 1 and 365")
    try:
        client = login(args.tokenstore.expanduser())
        fetch(client, args.end, args.days, args.out)
    except GarminConnectAuthenticationError as exc:
        log.error("Login failed: %s", exc)
        return 1
    except GarminConnectTooManyRequestsError:
        log.error("Garmin is rate limiting this account. Wait a while and try again.")
        return 2
    log.info("Done. Open the dashboard with: python -m http.server -d docs 8000")
    return 0


if __name__ == "__main__":
    sys.exit(main())
