#!/usr/bin/env python3
"""Read FastF1 pit-in events and emit the application's pit feed shape.

The Node service uses this script only after OpenF1 has no pit records.  The
script deliberately emits compact pit rows rather than a full FastF1 session
so the result can also be bundled for the static GitHub Pages build.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import timedelta
from pathlib import Path


def output(value: dict, exit_code: int = 0) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def number(value):
    try:
        if value is None:
            return None
        if hasattr(value, "total_seconds"):
            return float(value.total_seconds())
        return float(value)
    except (TypeError, ValueError):
        return None


def timestamp_for(session_start, pit_in, pd):
    if pit_in is None or pd.isna(pit_in):
        return None
    try:
        if isinstance(pit_in, pd.Timedelta):
            value = pd.Timestamp(session_start) + pit_in
        else:
            value = pd.Timestamp(pit_in)
        if value.tzinfo is None:
            value = value.tz_localize("UTC")
        return value.isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return None


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--session-name", default="Race")
    parser.add_argument("--session-key", type=int, required=True)
    return parser.parse_args()


def bypass_proxy_for_fastf1_archive():
    """Keep local system proxies from being rejected by F1's CloudFront."""
    hosts = ("livetiming.formula1.com", "livetiming-mirror.fastf1.dev")
    for key in ("NO_PROXY", "no_proxy"):
        current = [item.strip() for item in os.environ.get(key, "").split(",") if item.strip()]
        known = {item.lower() for item in current}
        current.extend(host for host in hosts if host.lower() not in known)
        os.environ[key] = ",".join(current)


def main():
    args = parse_args()
    bypass_proxy_for_fastf1_archive()
    try:
        import pandas as pd
        import fastf1
    except Exception as exc:  # pragma: no cover - exercised on unconfigured hosts
        output({"ok": False, "error": f"FastF1 未安装：{exc}"}, 2)

    try:
        fastf1.set_log_level("ERROR")
    except Exception:
        pass
    cache_dir = os.environ.get("FASTF1_CACHE_DIR")
    if cache_dir:
        try:
            Path(cache_dir).mkdir(parents=True, exist_ok=True)
            fastf1.Cache.enable_cache(cache_dir)
        except Exception as exc:
            output({"ok": False, "error": f"FastF1 缓存目录不可用：{exc}"}, 2)

    session_code = {"Race": "R", "Sprint": "S"}.get(args.session_name, args.session_name)
    try:
        session = fastf1.get_session(args.year, args.event, session_code)
        session.load(telemetry=False, laps=True, weather=False, messages=False)
    except Exception as exc:
        output({"ok": False, "error": f"FastF1 读取失败：{exc}"}, 2)

    session_start = pd.Timestamp(session.date)
    pit_rows = []
    counts = {}
    try:
        laps = session.laps if session.laps is not None else pd.DataFrame()
    except Exception as exc:
        output({"ok": False, "error": f"FastF1 圈数据不可用：{exc}"}, 2)
    for _, row in laps.iterrows():
        pit_in = row.get("PitInTime")
        if pit_in is None or pd.isna(pit_in):
            continue
        raw_driver = row.get("DriverNumber")
        try:
            driver_number = int(float(raw_driver))
        except (TypeError, ValueError):
            continue
        if driver_number <= 0:
            continue
        raw_lap = row.get("LapNumber")
        try:
            lap_number = int(float(raw_lap)) if not pd.isna(raw_lap) else None
        except (TypeError, ValueError):
            lap_number = None
        date = timestamp_for(session_start, pit_in, pd)
        if not date:
            continue
        pit_rows.append(
            {
                "date": date,
                "session_key": args.session_key,
                "driver_number": driver_number,
                "lap_number": lap_number,
                "pit_duration": None,
                "lane_duration": None,
                "stop_duration": None,
            }
        )
        key = str(driver_number)
        counts[key] = counts.get(key, 0) + 1

    pit_rows.sort(key=lambda item: (item["date"], item["driver_number"], item["lap_number"] or 0))
    output(
        {
            "ok": True,
            "source": "fastf1",
            "provider_version": getattr(fastf1, "__version__", None),
            "year": args.year,
            "event": getattr(getattr(session, "event", None), "EventName", args.event),
            "session_name": args.session_name,
            "session_key": args.session_key,
            "pit": pit_rows,
            "counts": counts,
        }
    )


if __name__ == "__main__":
    main()
