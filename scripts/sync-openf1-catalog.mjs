import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiBase = "https://api.openf1.org/v1";

async function fetchJson(endpoint) {
  const response = await fetch(`${apiBase}${endpoint}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenF1 ${response.status} for ${endpoint}`);
  return response.json();
}

const [meetings, sessions] = await Promise.all([fetchJson("/meetings"), fetchJson("/sessions")]);
const sessionsByMeeting = new Map();
for (const session of sessions) {
  const key = Number(session.meeting_key);
  if (!sessionsByMeeting.has(key)) sessionsByMeeting.set(key, []);
  sessionsByMeeting.get(key).push(session);
}

const meetingsByYear = new Map();
for (const meeting of meetings) {
  const year = Number(meeting.year);
  if (!meetingsByYear.has(year)) meetingsByYear.set(year, []);
  meetingsByYear.get(year).push(meeting);
}

const catalog = [];
for (const year of Array.from(meetingsByYear.keys()).sort((a, b) => a - b)) {
  let round = 0;
  const yearMeetings = meetingsByYear.get(year).slice().sort((a, b) => Date.parse(a.date_start || 0) - Date.parse(b.date_start || 0));
  for (const meeting of yearMeetings) {
    const testing = /testing/i.test(String(meeting.meeting_name || ""));
    if (!testing) round += 1;
    catalog.push({
      ...meeting,
      round: testing ? null : round,
      sessions: (sessionsByMeeting.get(Number(meeting.meeting_key)) || []).slice().sort((a, b) => Date.parse(a.date_start || 0) - Date.parse(b.date_start || 0)),
    });
  }
}

const payload = {
  captured_at: new Date().toISOString(),
  source: "OpenF1",
  seasons: Array.from(meetingsByYear.keys()).sort((a, b) => b - a),
  meetings: catalog,
};
const output = `${JSON.stringify(payload, null, 2)}\n`;
await Promise.all([
  fs.writeFile(path.join(root, "meetings-all.json"), output),
  fs.writeFile(path.join(root, "site", "meetings-all.json"), output),
]);
console.log(`Saved ${payload.seasons.length} seasons, ${catalog.length} meetings and ${sessions.length} sessions.`);
