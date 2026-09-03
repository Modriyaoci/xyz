#!/usr/bin/env python3
"""Build the compact FastF1 pit fallback asset used by static pages."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--catalog", default="meetings-all.json")
    parser.add_argument("--output", default="fastf1-pit-fallback.json")
    parser.add_argument("--timeout", type=int, default=180, help="单个分站的最大读取秒数")
    return parser.parse_args()


def main():
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    helper = root / "scripts" / "fastf1-pit-fallback.py"
    catalog_path = Path(args.catalog)
    if not catalog_path.is_absolute():
        catalog_path = root / catalog_path
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    sessions = {}
    failures = []
    races = [
        (meeting, session)
        for meeting in payload.get("meetings", [])
        if int(meeting.get("year", 0)) == args.year
        for session in meeting.get("sessions", [])
        if session.get("session_name") == "Race"
        and session.get("session_key") is not None
        and not meeting.get("is_cancelled")
        and not session.get("is_cancelled")
    ]
    for meeting, session in races:
        key = int(session["session_key"])
        command = [
            sys.executable,
            str(helper),
            "--year",
            str(args.year),
            "--event",
            str(meeting.get("meeting_name") or session.get("meeting_name") or meeting.get("country_name") or ""),
            "--session-name",
            "Race",
            "--session-key",
            str(key),
        ]
        try:
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            failures.append({"session_key": key, "event": meeting.get("meeting_name"), "error": f"FastF1 超时（{args.timeout}秒）"})
            print(f"跳过 {meeting.get('meeting_name')} ({key})：{failures[-1]['error']}", file=sys.stderr)
            continue
        try:
            data = json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            data = {"ok": False, "error": result.stderr.strip() or "FastF1 返回格式无效"}
        if not data.get("ok"):
            failures.append({"session_key": key, "event": meeting.get("meeting_name"), "error": data.get("error") or result.stderr.strip()})
            print(f"跳过 {meeting.get('meeting_name')} ({key})：{failures[-1]['error']}", file=sys.stderr)
            continue
        sessions[str(key)] = {
            "source": "fastf1",
            "provider_version": data.get("provider_version"),
            "year": args.year,
            "event": data.get("event") or meeting.get("meeting_name"),
            "session_name": "Race",
            "pit": data.get("pit", []),
            "counts": data.get("counts", {}),
        }
        print(f"完成 {meeting.get('meeting_name')} ({key})：{len(data.get('pit', []))} 条进站记录", file=sys.stderr)

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = root / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "version": "20260902-fastf1-pit-fallback-v1",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "provider": "FastF1",
        "sessions": sessions,
        "failures": failures,
    }
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not sessions:
        raise SystemExit("没有生成任何 FastF1 进站数据")


if __name__ == "__main__":
    main()
