from garmin_dashboard import transform


def test_sleep_row_parses_stages_score_and_local_times():
    raw = {
        "dailySleepDTO": {
            "sleepTimeSeconds": 27000,
            "deepSleepSeconds": 5400,
            "lightSleepSeconds": 16200,
            "remSleepSeconds": 5400,
            "awakeSleepSeconds": 600,
            "sleepScores": {"overall": {"value": 88}},
            # 2026-09-30 23:30 and 2026-10-01 07:15, local wall time
            "sleepStartTimestampLocal": 1790811000000,
            "sleepEndTimestampLocal": 1790838900000,
        },
        "avgOvernightHrv": 101.0,
    }
    row = transform.sleep_row("2026-10-01", raw)
    assert row == {
        "date": "2026-10-01",
        "sleep_hours": 7.5,
        "sleep_score": 88,
        "deep_hours": 1.5,
        "light_hours": 4.5,
        "rem_hours": 1.5,
        "awake_min": 10,
        "hrv_ms": 101.0,
        "bedtime": "23:30",
        "wake_time": "07:15",
    }


def test_sleep_row_returns_none_without_sleep():
    assert transform.sleep_row("2026-10-18", {"dailySleepDTO": {"sleepTimeSeconds": None}}) is None
    assert transform.sleep_row("2026-10-18", {}) is None


def test_sleep_row_tolerates_missing_fields():
    row = transform.sleep_row("2026-10-01", {"dailySleepDTO": {"sleepTimeSeconds": 3600}})
    assert row["sleep_hours"] == 1.0
    assert row["sleep_score"] == "" and row["hrv_ms"] == "" and row["bedtime"] == ""


def test_daily_row_drops_negative_stress():
    row = transform.daily_row("2026-10-01", {"totalSteps": 9000, "activeKilocalories": 200, "averageStressLevel": -1})
    assert row["steps"] == 9000 and row["stress_avg"] == ""
    assert transform.daily_row("2026-10-01", {}) is None


def test_intensity_counts_vigorous_twice_and_sorts():
    rows = transform.intensity_rows(
        [
            {"calendarDate": "2026-09-28", "moderateValue": 15, "vigorousValue": 7, "weeklyGoal": 150},
            {"calendarDate": "2026-09-21", "moderateValue": None, "vigorousValue": 7},
        ]
    )
    assert [r["week_start"] for r in rows] == ["2026-09-21", "2026-09-28"]
    assert rows[1]["total_min"] == 29
    assert rows[0]["total_min"] == 14 and rows[0]["goal_min"] == 150


def test_status_rows_flattens_nested_responses():
    rows = transform.status_rows(
        {"fitnessAge": 18.2, "chronologicalAge": 22, "components": {"rhr": {"value": 40}}},
        {
            "mostRecentTrainingStatus": {
                "latestTrainingStatusData": {
                    "123": {
                        "trainingStatusFeedbackPhrase": "DETRAINING_1",
                        "acuteTrainingLoadDTO": {"dailyTrainingLoadAcute": 0, "dailyTrainingLoadChronic": 219},
                    }
                }
            }
        },
        {"time5K": 1388, "time10K": 3051, "timeHalfMarathon": 7005, "timeMarathon": 15903},
        "2026-10-03",
    )
    status = {r["metric"]: r["value"] for r in rows}
    assert status["fitness_age"] == 18
    assert status["resting_hr"] == 40
    assert status["training_status"] == "Detraining"
    assert status["chronic_load"] == 219
    assert status["race_5k"] == "23:08"
    assert status["race_half"] == "1:56:45"
    assert status["vigorous_min_week"] == ""
