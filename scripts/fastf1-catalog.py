#!/usr/bin/env python3
"""Build the independent FastF1 meeting/session catalog.

The catalog deliberately uses source-local numeric keys.  They are not
OpenF1 identifiers and are only used to address FastF1 entries in the UI.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=2018)
    parser.add_argument("--end", type=int, default=2026)
    parser.add_argument("--output", default="fastf1-meetings.json")
    return parser.parse_args()


def iso(value):
    if value is None:
        return None
    try:
        import pandas as pd

        stamp = pd.Timestamp(value)
        if pd.isna(stamp):
            return None
        if stamp.tzinfo is None:
            stamp = stamp.tz_localize("UTC")
        else:
            stamp = stamp.tz_convert("UTC")
        return stamp.isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def clean(value):
    if value is None:
        return None
    try:
        import pandas as pd

        if pd.isna(value):
            return None
    except Exception:
        pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value.item() if hasattr(value, "item") else value


def session_code(name):
    return {
        "Practice 1": "FP1",
        "Practice 2": "FP2",
        "Practice 3": "FP3",
        "Qualifying": "Q",
        "Sprint Shootout": "SQ",
        "Sprint Qualifying": "SQ",
        "Sprint": "S",
        "Race": "R",
    }.get(str(name), str(name))


def main():
    args = parse_args()
    try:
        import fastf1
    except Exception as exc:
        raise SystemExit(f"FastF1 未安装：{exc}")

    fastf1.set_log_level("ERROR")
    meetings = []
    seasons = []
    for year in range(args.start, args.end + 1):
        try:
            schedule = fastf1.get_event_schedule(year, include_testing=False)
        except Exception as exc:
            print(f"跳过 {year}：{exc}")
            continue
        season_rows = []
        for _, row in schedule.iterrows():
            round_number = clean(row.get("RoundNumber"))
            if round_number is None:
                continue
            round_number = int(round_number)
            meeting_key = year * 1000 + round_number
            sessions = []
            for index in range(1, 6):
                name = clean(row.get(f"Session{index}"))
                if not name:
                    continue
                # Keep the application naming stable across FastF1 versions.
                display_name = "Sprint Qualifying" if name == "Sprint Shootout" else str(name)
                session_key = meeting_key * 10 + index
                session_date = iso(row.get(f"Session{index}DateUtc") or row.get(f"Session{index}Date"))
                session_type = "Practice" if display_name.startswith("Practice") else "Qualifying" if display_name in {"Qualifying", "Sprint Qualifying"} else "Race" if display_name in {"Sprint", "Race"} else "Testing"
                sessions.append({
                    "meeting_key": meeting_key,
                    "session_key": session_key,
                    "session_type": session_type,
                    "session_name": display_name,
                    "fastf1_session_name": str(name),
                    "fastf1_session_code": session_code(name),
                    "date_start": session_date,
                    "date_end": session_date,
                    "country_name": clean(row.get("Country")),
                    "location": clean(row.get("Location")),
                    "meeting_name": clean(row.get("EventName")),
                    "year": year,
                    "round": round_number,
                    "is_cancelled": False,
                })
            meeting = {
                "meeting_key": meeting_key,
                "meeting_name": clean(row.get("EventName")),
                "meeting_official_name": clean(row.get("OfficialEventName")),
                "location": clean(row.get("Location")),
                "country_name": clean(row.get("Country")),
                "date_start": iso(row.get("EventDate")),
                "date_end": iso(row.get("EventDate")),
                "year": year,
                "round": round_number,
                "is_cancelled": False,
                "source": "fastf1",
                "sessions": sessions,
            }
            season_rows.append(meeting)
        if season_rows:
            seasons.append(year)
            meetings.extend(season_rows)

    output = {
        "version": "20260902-fastf1-catalog-v1",
        "provider": "FastF1",
        "seasons": seasons,
        "meetings": meetings,
    }
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = Path(__file__).resolve().parents[1] / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"生成 {len(meetings)} 个分站、{sum(len(row['sessions']) for row in meetings)} 个节点：{output_path}")


if __name__ == "__main__":
    main()
