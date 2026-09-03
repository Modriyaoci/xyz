#!/usr/bin/env python3
"""Read one FastF1 session and emit the application's source feed shape."""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import secrets
import re
import socket
import struct
import sys
import time
from datetime import timedelta
from pathlib import Path


MINI_SECTOR_COUNT = 28
STATUS_RED = 0
STATUS_YELLOW = 2048
STATUS_GREEN = 2049
STATUS_PURPLE = 2051
STATUS_BLUE = 2064


def output(value: dict, exit_code: int = 0) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


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
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return value


def seconds(value):
    value = clean(value)
    if value is None:
        return None
    if hasattr(value, "total_seconds"):
        return float(value.total_seconds())
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def iso(value, base=None):
    if value is None:
        return None
    try:
        import pandas as pd

        if isinstance(value, (timedelta, pd.Timedelta)) and base is not None:
            stamp = pd.Timestamp(base) + value
        else:
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


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--session-name", default="Race")
    parser.add_argument("--fastf1-session-name")
    parser.add_argument("--session-code")
    parser.add_argument("--meeting-key", type=int, required=True)
    parser.add_argument("--session-key", type=int, required=True)
    return parser.parse_args()


def _skip_dns_name(packet, offset):
    while offset < len(packet):
        length = packet[offset]
        if length & 0xC0:
            return offset + 2
        offset += 1
        if length == 0:
            return offset
        offset += length
    raise ValueError("invalid DNS response")


def _public_ipv4_addresses(hostname):
    """Resolve A records without using macOS proxy/TUN synthetic DNS."""
    transaction_id = secrets.randbits(16)
    labels = hostname.rstrip(".").split(".")
    question = b"".join(bytes((len(label),)) + label.encode("ascii") for label in labels) + b"\0"
    query = struct.pack("!HHHHHH", transaction_id, 0x0100, 1, 0, 0, 0) + question + struct.pack("!HH", 1, 1)
    for resolver in ("1.1.1.1", "8.8.8.8"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.settimeout(2)
                client.sendto(query, (resolver, 53))
                packet, _ = client.recvfrom(4096)
            response_id, flags, questions, answers, _, _ = struct.unpack("!HHHHHH", packet[:12])
            if response_id != transaction_id or flags & 0x000F:
                continue
            offset = 12
            for _ in range(questions):
                offset = _skip_dns_name(packet, offset) + 4
            addresses = []
            for _ in range(answers):
                offset = _skip_dns_name(packet, offset)
                record_type, record_class, _, length = struct.unpack("!HHIH", packet[offset:offset + 10])
                offset += 10
                value = packet[offset:offset + length]
                offset += length
                if record_type == 1 and record_class == 1 and length == 4:
                    addresses.append(socket.inet_ntoa(value))
            if addresses:
                return list(dict.fromkeys(addresses))
        except (OSError, struct.error, ValueError):
            continue
    return []


def prepare_fastf1_archive_network():
    """Keep archive requests working behind proxies that return synthetic DNS."""
    hosts = ("livetiming.formula1.com", "livetiming-mirror.fastf1.dev")
    for key in ("NO_PROXY", "no_proxy"):
        current = [item.strip() for item in os.environ.get(key, "").split(",") if item.strip()]
        known = {item.lower() for item in current}
        current.extend(host for host in hosts if host.lower() not in known)
        os.environ[key] = ",".join(current)

    mirror = "livetiming-mirror.fastf1.dev"
    original_getaddrinfo = socket.getaddrinfo
    try:
        current_addresses = {
            item[4][0]
            for item in original_getaddrinfo(mirror, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
        }
    except OSError:
        current_addresses = set()
    synthetic_network = ipaddress.ip_network("198.18.0.0/15")
    has_synthetic_dns = any(
        ipaddress.ip_address(address) in synthetic_network
        for address in current_addresses
        if address
    )
    if current_addresses and not has_synthetic_dns:
        return
    public_addresses = _public_ipv4_addresses(mirror)
    if not public_addresses:
        return

    def public_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        if host != mirror:
            return original_getaddrinfo(host, port, family, type, proto, flags)
        resolved = []
        for address in public_addresses:
            resolved.extend(original_getaddrinfo(address, port, family, type, proto, flags))
        return resolved

    socket.getaddrinfo = public_getaddrinfo


def load_complete_session(fastf1, args, session_name, session_code):
    """Retry because FastF1 logs many archive failures without raising them."""
    failures = []
    for attempt in range(3):
        session = fastf1.get_session(args.year, args.event, session_name or session_code)
        try:
            session.load(telemetry=False, laps=True, weather=True, messages=True)
            missing = []
            for attribute in ("laps", "weather_data", "race_control_messages"):
                try:
                    getattr(session, attribute)
                except Exception as exc:
                    missing.append(f"{attribute}:{type(exc).__name__}")
            if not missing:
                return session
            failures = missing
        except Exception as exc:
            failures = [f"session:{type(exc).__name__}:{exc}"]
        if attempt < 2:
            time.sleep(attempt + 1)
    raise RuntimeError(", ".join(failures) or "required session feeds unavailable")


def status_flags(status):
    text = str(status or "").strip().lower()
    return {
        "dnf": any(token in text for token in ("retired", "did not finish", "not classified")),
        "dns": any(token in text for token in ("did not start", "dns", "withdrawn")),
        "dsq": any(token in text for token in ("disqualified", "dsq")),
    }


def result_time(row, name):
    if name in {"Qualifying", "Sprint Qualifying"}:
        return [seconds(row.get("Q1")), seconds(row.get("Q2")), seconds(row.get("Q3"))]
    return seconds(row.get("Time"))


def result_gap(row, name):
    """FastF1's race Time is the gap to the winner for non-winning cars."""
    if name not in {"Race", "Sprint"}:
        return None
    position = clean(row.get("Position"))
    try:
        if int(float(position)) == 1:
            return None
    except (TypeError, ValueError):
        return None
    value = clean(row.get("Time"))
    parsed = seconds(value)
    if parsed is not None:
        return parsed
    if value is not None:
        return str(value).strip()
    lap_status = re.search(r"\b(\d+)\s+laps?\b", str(row.get("Status") or ""), re.IGNORECASE)
    return f"{int(lap_status.group(1))}L" if lap_status else None


def session_frame(session, attribute, pandas, warning_field, warnings):
    """Read one FastF1 frame without discarding the other usable feeds."""
    try:
        value = getattr(session, attribute)
    except Exception as exc:
        warnings.append(f"{warning_field}:{type(exc).__name__}")
        return pandas.DataFrame()
    if value is None:
        warnings.append(f"{warning_field}:unavailable")
        return pandas.DataFrame()
    return value


def telemetry_frame(lap):
    """Return a clean relative-distance/time frame for one FastF1 lap."""
    try:
        frame = lap.get_telemetry()
    except Exception:
        return None
    if frame is None or frame.empty or "RelativeDistance" not in frame or "SessionTime" not in frame:
        return None
    try:
        import pandas as pd

        values = pd.DataFrame({
            "distance": pd.to_numeric(frame["RelativeDistance"], errors="coerce"),
            "time": frame["SessionTime"].map(seconds),
        }).dropna()
        values = values[(values["distance"] >= 0) & (values["distance"] <= 1.05)]
        values = values.sort_values("distance").drop_duplicates("distance")
        if len(values) < 3 or float(values["distance"].max()) < 0.95:
            return None
        return values
    except Exception:
        return None


def mini_sector_times(lap, lap_row):
    """Split one lap into equal-distance mini sectors and return S1/S2/S3."""
    frame = telemetry_frame(lap)
    if frame is None:
        return None
    import numpy as np

    distance = frame["distance"].to_numpy(dtype=float)
    time = frame["time"].to_numpy(dtype=float)
    boundaries = np.linspace(0.0, 1.0, MINI_SECTOR_COUNT + 1)
    stamps = np.interp(boundaries, distance, time)
    durations = np.diff(stamps)
    if len(durations) != MINI_SECTOR_COUNT or np.any(~np.isfinite(durations)) or np.any(durations <= 0):
        return None

    lap_start = seconds(lap_row.get("LapStartTime"))
    sector_stamps = [seconds(lap_row.get(f"Sector{index}SessionTime")) for index in (1, 2)]
    if lap_start is not None and all(value is not None for value in sector_stamps):
        sector_distances = [float(np.interp(value - lap_start, time, distance)) for value in sector_stamps]
    else:
        sector_distances = [8 / MINI_SECTOR_COUNT, 20 / MINI_SECTOR_COUNT]
    sector_distances = [max(0.0, min(1.0, value)) for value in sector_distances]
    if not 0 < sector_distances[0] < sector_distances[1] < 1:
        sector_distances = [8 / MINI_SECTOR_COUNT, 20 / MINI_SECTOR_COUNT]

    groups = [[], [], []]
    for index, duration in enumerate(durations):
        midpoint = (boundaries[index] + boundaries[index + 1]) / 2
        sector = 0 if midpoint < sector_distances[0] else 1 if midpoint < sector_distances[1] else 2
        groups[sector].append(float(duration))
    return groups


def flatten_mini_sector_times(groups):
    if not groups or any(not isinstance(group, list) for group in groups):
        return None
    values = [value for group in groups for value in group]
    return values if len(values) == MINI_SECTOR_COUNT and all(value is not None for value in values) else None


def mini_sector_statuses(current, personal, overall, previous, pit_lap=False):
    if not current:
        return None
    values = flatten_mini_sector_times(current)
    if values is None:
        return None
    personal_values = flatten_mini_sector_times(personal) or [None] * MINI_SECTOR_COUNT
    overall_values = flatten_mini_sector_times(overall) or [None] * MINI_SECTOR_COUNT
    previous_values = flatten_mini_sector_times(previous) or [None] * MINI_SECTOR_COUNT
    statuses = []
    for index, value in enumerate(values):
        if pit_lap:
            status = STATUS_BLUE
        elif overall_values[index] is not None and value <= overall_values[index] + 0.001:
            status = STATUS_PURPLE
        elif personal_values[index] is not None and value <= personal_values[index] + 0.001:
            status = STATUS_GREEN
        elif previous_values[index] is not None and value - previous_values[index] >= 1.0:
            status = STATUS_RED
        else:
            status = STATUS_YELLOW
        statuses.append(status)
    counts = [len(group) for group in current]
    offset = 0
    result = []
    for count in counts:
        result.append(statuses[offset:offset + count])
        offset += count
    return result


def main():
    args = parse_args()
    prepare_fastf1_archive_network()
    try:
        import pandas as pd
        import fastf1
    except Exception as exc:
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

    session_name = args.fastf1_session_name or args.session_name
    session_code = args.session_code or {
        "Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3",
        "Qualifying": "Q", "Sprint Qualifying": "SQ", "Sprint": "S", "Race": "R",
    }.get(args.session_name, args.session_name)
    try:
        session = load_complete_session(fastf1, args, session_name, session_code)
    except Exception as exc:
        output({"ok": False, "error": f"FastF1 读取失败：{exc}"}, 2)

    # FastF1 does not expose OpenF1's mini-sector status directly. Deriving it
    # requires loading the full car/position telemetry feed, which exceeds the
    # 512 MB Render free-instance limit for many races. Keep that optional on
    # Render while preserving it for local or larger deployments.
    telemetry_available = False
    telemetry_enabled = os.environ.get(
        "FASTF1_MINI_SECTORS",
        "0" if os.environ.get("RENDER", "").lower() == "true" else "1",
    ).strip().lower() not in {"0", "false", "no", "off"}
    if telemetry_enabled:
        try:
            session._load_telemetry()
            telemetry_available = bool(getattr(session, "_car_data", {}) or getattr(session, "_pos_data", {}))
        except Exception:
            pass

    base = pd.Timestamp(session.date)
    if base.tzinfo is None:
        base = base.tz_localize("UTC")
    else:
        base = base.tz_convert("UTC")
    display_name = "Sprint Qualifying" if args.session_name == "Sprint Shootout" else args.session_name
    sync_warnings = []
    results = session_frame(session, "results", pd, "session_result", sync_warnings)
    laps = session_frame(session, "laps", pd, "laps", sync_warnings)
    drivers = []
    session_results = []
    known_cars = set()
    winner_laps = None
    if display_name in {"Race", "Sprint"}:
        race_laps = [seconds(row.get("Laps")) for _, row in results.iterrows()]
        race_laps = [value for value in race_laps if value is not None]
        winner_laps = max(race_laps) if race_laps else None
    for _, row in results.iterrows():
        car = clean(row.get("DriverNumber"))
        try:
            car = int(float(car))
        except (TypeError, ValueError):
            continue
        known_cars.add(car)
        status = status_flags(row.get("Status"))
        number_of_laps = clean(row.get("Laps"))
        gap_to_leader = result_gap(row, display_name)
        current_laps = seconds(number_of_laps)
        if gap_to_leader is None and winner_laps is not None and current_laps is not None and clean(row.get("Position")) is not None and not status["dns"] and not status["dsq"]:
            lap_deficit = max(0, int(round(winner_laps - current_laps)))
            if lap_deficit:
                gap_to_leader = f"{lap_deficit}L"
        drivers.append({
            "meeting_key": args.meeting_key, "session_key": args.session_key,
            "driver_number": car,
            "name_acronym": clean(row.get("Abbreviation")),
            "full_name": clean(row.get("FullName")),
            "first_name": clean(row.get("FirstName")), "last_name": clean(row.get("LastName")),
            "team_name": clean(row.get("TeamName")), "team_color": clean(row.get("TeamColor")),
            "country_code": clean(row.get("CountryCode")),
            "headshot_url": clean(row.get("HeadshotUrl")),
        })
        session_results.append({
            "meeting_key": args.meeting_key, "session_key": args.session_key,
            "driver_number": car,
            "position": clean(row.get("Position")),
            "duration": result_time(row, display_name),
            "gap_to_leader": gap_to_leader,
            "number_of_laps": number_of_laps,
            "points": clean(row.get("Points")),
            "last_lap_duration": None, "best_lap_duration": None,
            "dnf": status["dnf"], "dns": status["dns"], "dsq": status["dsq"],
            "status": clean(row.get("Status")),
        })

    lap_rows = []
    pit_rows = []
    position_rows = []
    stints_by_car = {}
    lap_sources = {}
    lap_payloads_by_car = {}
    max_offset = pd.Timedelta(0)
    for lap_index, row in laps.iterrows():
        car = clean(row.get("DriverNumber"))
        try:
            car = int(float(car))
        except (TypeError, ValueError):
            continue
        known_cars.add(car)
        start_offset = row.get("LapStartTime")
        date_start = iso(start_offset, base)
        if date_start and start_offset is not None and not pd.isna(start_offset):
            max_offset = max(max_offset, pd.Timedelta(start_offset))
        lap_number = clean(row.get("LapNumber"))
        lap_number = int(float(lap_number)) if lap_number is not None else None
        lap = {
            "meeting_key": args.meeting_key, "session_key": args.session_key,
            "driver_number": car, "lap_number": lap_number,
            "date_start": date_start or iso(row.get("Time"), base),
            "lap_duration": seconds(row.get("LapTime")),
            "duration_sector_1": seconds(row.get("Sector1Time")),
            "duration_sector_2": seconds(row.get("Sector2Time")),
            "duration_sector_3": seconds(row.get("Sector3Time")),
            "segments_sector_1": [], "segments_sector_2": [], "segments_sector_3": [],
            "is_pit_out_lap": clean(row.get("PitOutTime")) is not None,
            "is_pit_in_lap": clean(row.get("PitInTime")) is not None,
            "is_accurate": bool(clean(row.get("IsAccurate")) or False),
            "track_status": clean(row.get("TrackStatus")),
            "position": clean(row.get("Position")),
            "compound": clean(row.get("Compound")),
        }
        lap_rows.append(lap)
        lap_payloads_by_car.setdefault(car, []).append(lap)
        if lap_number is not None:
            try:
                lap_sources[(car, lap_number)] = (laps.loc[[lap_index]], row)
            except Exception:
                pass
        if lap["position"] is not None:
            position_rows.append({"meeting_key": args.meeting_key, "session_key": args.session_key, "driver_number": car, "position": lap["position"], "date": lap["date_start"]})
        pit_in = row.get("PitInTime")
        pit_date = iso(pit_in, base)
        if pit_date:
            pit_rows.append({"meeting_key": args.meeting_key, "session_key": args.session_key, "driver_number": car, "lap_number": lap_number, "date": pit_date, "pit_duration": None, "lane_duration": None, "stop_duration": None})
        stint = clean(row.get("Stint"))
        compound = clean(row.get("Compound"))
        if stint is not None and compound:
            stint_number = int(float(stint))
            stints_by_car.setdefault(car, {}).setdefault(stint_number, {"lap_start": lap_number, "lap_end": lap_number, "compound": str(compound).upper()})
            entry = stints_by_car[car][stint_number]
            if lap_number is not None:
                entry["lap_start"] = lap_number if entry["lap_start"] is None else min(entry["lap_start"], lap_number)
                entry["lap_end"] = lap_number if entry["lap_end"] is None else max(entry["lap_end"], lap_number)

    for row in session_results:
        car = row["driver_number"]
        valid = [lap for lap in lap_rows if lap["driver_number"] == car and lap["lap_duration"] is not None]
        if valid:
            row["last_lap_duration"] = valid[-1]["lap_duration"]
            row["best_lap_duration"] = min(lap["lap_duration"] for lap in valid)
            if row["number_of_laps"] is None:
                row["number_of_laps"] = max((lap["lap_number"] or 0 for lap in valid), default=None)

    # FastF1 does not expose OpenF1's mini-sector arrays.  Where car/position
    # telemetry is available, derive 28 equal-distance mini sectors for the
    # latest lap and classify each one against the driver's best and the
    # session-wide best.  Sessions without telemetry keep empty arrays.
    if telemetry_available:
        source_groups_by_car = {}
        for car, payloads in lap_payloads_by_car.items():
            valid_payloads = [
                lap for lap in payloads
                if lap.get("lap_number") is not None
                and lap.get("lap_duration") is not None
                and not lap.get("is_pit_out_lap")
            ]
            valid_payloads.sort(key=lambda lap: (lap.get("lap_number", 0), lap.get("date_start") or ""))
            if not valid_payloads:
                continue
            fastest = min(valid_payloads, key=lambda lap: lap.get("lap_duration"))
            fastest_source = lap_sources.get((car, fastest.get("lap_number")))
            fastest_groups = mini_sector_times(*fastest_source) if fastest_source else None
            if fastest_groups is None:
                continue
            source_groups_by_car[car] = fastest_groups

        overall_values = []
        for index in range(MINI_SECTOR_COUNT):
            candidates = []
            for groups in source_groups_by_car.values():
                values = flatten_mini_sector_times(groups)
                if values is not None and values[index] is not None:
                    candidates.append(values[index])
            overall_values.append(min(candidates) if candidates else None)
        overall_groups = [overall_values] if all(value is not None for value in overall_values) else None

        for car, payloads in lap_payloads_by_car.items():
            valid_payloads = [
                lap for lap in payloads
                if lap.get("lap_number") is not None
                and lap.get("lap_duration") is not None
                and not lap.get("is_pit_out_lap")
            ]
            valid_payloads.sort(key=lambda lap: (lap.get("lap_number", 0), lap.get("date_start") or ""))
            if not valid_payloads:
                continue
            current = valid_payloads[-1]
            previous = valid_payloads[-2] if len(valid_payloads) > 1 else None
            fastest = min(valid_payloads, key=lambda lap: lap.get("lap_duration"))
            current_source = lap_sources.get((car, current.get("lap_number")))
            previous_source = lap_sources.get((car, previous.get("lap_number"))) if previous else None
            fastest_source = lap_sources.get((car, fastest.get("lap_number")))
            current_times = mini_sector_times(*current_source) if current_source else None
            previous_times = mini_sector_times(*previous_source) if previous_source else None
            fastest_times = mini_sector_times(*fastest_source) if fastest_source else None
            statuses = mini_sector_statuses(
                current_times,
                fastest_times,
                overall_groups,
                previous_times,
                pit_lap=bool(current.get("is_pit_out_lap") or current.get("is_pit_in_lap")),
            )
            if statuses:
                current["segments_sector_1"], current["segments_sector_2"], current["segments_sector_3"] = statuses

    stint_rows = []
    for car, values in stints_by_car.items():
        for number, item in sorted(values.items()):
            stint_rows.append({"meeting_key": args.meeting_key, "session_key": args.session_key, "driver_number": car, "stint_number": number, **item})

    weather_rows = []
    try:
        weather = session.weather_data
        for _, row in weather.iterrows():
            weather_rows.append({
                "meeting_key": args.meeting_key, "session_key": args.session_key,
                "date": iso(row.get("Time"), base),
                "air_temperature": clean(row.get("AirTemp")), "track_temperature": clean(row.get("TrackTemp")),
                "humidity": clean(row.get("Humidity")), "pressure": clean(row.get("Pressure")),
                "wind_speed": clean(row.get("WindSpeed")), "wind_direction": clean(row.get("WindDirection")),
                "rainfall": bool(clean(row.get("Rainfall")) or False),
            })
    except Exception as exc:
        sync_warnings.append(f"weather:{type(exc).__name__}")

    messages = []
    try:
        control = session.race_control_messages
        for _, row in control.iterrows():
            date = iso(row.get("Time"), base)
            text = str(clean(row.get("Message")) or "").strip()
            if not text:
                continue
            messages.append({
                "meeting_key": args.meeting_key, "session_key": args.session_key,
                "date": date, "utc": int(pd.Timestamp(date).timestamp()) if date else None,
                "lap_number": clean(row.get("Lap")), "message": text,
                "category": clean(row.get("Category")), "flag": clean(row.get("Flag")),
            })
    except Exception as exc:
        sync_warnings.append(f"race_control:{type(exc).__name__}")

    # FastF1 does not expose OpenF1's qualifying_phase field.  Add explicit
    # phase markers so the existing Q1/Q2/Q3 view can filter qualifying laps.
    if display_name in {"Qualifying", "Sprint Qualifying"}:
        for phase, offset in ((1, 0), (2, 18 * 60), (3, 36 * 60)):
            stamp = iso(pd.Timedelta(seconds=offset), base)
            messages.append({"meeting_key": args.meeting_key, "session_key": args.session_key, "date": stamp, "utc": int(pd.Timestamp(stamp).timestamp()), "lap_number": None, "message": "SESSION STARTED", "category": "Session", "qualifying_phase": phase})
        end_stamp = iso(pd.Timedelta(seconds=54 * 60), base)
        messages.append({"meeting_key": args.meeting_key, "session_key": args.session_key, "date": end_stamp, "utc": int(pd.Timestamp(end_stamp).timestamp()), "lap_number": None, "message": "SESSION FINISHED", "category": "Session", "qualifying_phase": 3})
    offsets = [max_offset]
    if weather_rows:
        offsets.append(max(pd.Timestamp(row["date"]) - base for row in weather_rows))
    if messages:
        offsets.append(max(pd.Timestamp(row["date"]) - base for row in messages if row.get("date")))
    end = base + max(offsets or [pd.Timedelta(minutes=1)])
    if end <= base:
        end = base + pd.Timedelta(minutes=1)
    session_payload = {
        "meeting_key": args.meeting_key, "session_key": args.session_key,
        "session_name": display_name,
        "session_type": "Practice" if display_name.startswith("Practice") else "Qualifying" if display_name in {"Qualifying", "Sprint Qualifying"} else "Race" if display_name in {"Race", "Sprint"} else "Testing",
        "date_start": iso(base), "date_end": iso(end),
        "meeting_name": getattr(getattr(session, "event", None), "EventName", args.event),
        "country_name": clean(getattr(getattr(session, "event", None), "Country", None)),
        "location": clean(getattr(getattr(session, "event", None), "Location", None)),
        "year": args.year, "is_cancelled": False,
        "mini_sectors_source": "FastF1 telemetry" if telemetry_available else "disabled-memory-limit" if not telemetry_enabled else "unavailable",
    }
    payload = {
        "ok": True, "source": "fastf1", "provider_version": getattr(fastf1, "__version__", None),
        "meeting": {"meeting_key": args.meeting_key, "meeting_name": session_payload["meeting_name"], "country_name": session_payload["country_name"], "location": session_payload["location"], "year": args.year},
        "session": session_payload, "drivers": drivers, "session_result": session_results,
        "laps": lap_rows, "pit": pit_rows, "position": position_rows, "intervals": [],
        "stints": stint_rows, "race_control": messages, "weather": weather_rows,
        "counts": {"drivers": len(drivers), "session_result": len(session_results), "laps": len(lap_rows), "pit": len(pit_rows), "stints": len(stint_rows), "weather": len(weather_rows), "race_control": len(messages)},
    }
    if sync_warnings:
        payload["sync_warnings"] = list(dict.fromkeys(sync_warnings))
    output(payload)


if __name__ == "__main__":
    main()
