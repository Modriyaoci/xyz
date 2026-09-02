import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliArgs = typeof process === "undefined" ? [] : process.argv;
const currentStandingsSeason = 2026;
const requestedYear = Number(cliArgs[2] || currentStandingsSeason);
const requestedTrigger = String(cliArgs[3] || "manual").toLowerCase();
const trigger = ["automatic", "historical"].includes(requestedTrigger) ? requestedTrigger : "manual";
const year = trigger === "historical" ? requestedYear : currentStandingsSeason;
const output = path.join(root, `official-standings-${year}.json`);
const baseUrl = "https://www.formula1.com";
const pages = {
  drivers: `${baseUrl}/en/results/${year}/drivers`,
  teams: `${baseUrl}/en/results/${year}/team`,
};
const requestTimeoutMs = 30000;
const maxAttempts = 3;
const retryDelayMs = 1000;

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function cleanText(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tableRows(html) {
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error("官网页面没有找到排名表");
  return [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => {
    const row = match[0];
    return [...row.matchAll(/<td\b[\s\S]*?<\/td>/gi)].map((cell) => cell[0]);
  }).filter((cells) => cells.length);
}

function linkUrl(cell) {
  const href = cell.match(/<a\b[^>]*href="([^"]+)"/i)?.[1];
  return href ? new URL(decodeEntities(href), baseUrl).href : null;
}

function parseDrivers(html) {
  return tableRows(html).map((cells) => {
    const code = cleanText(cells[1]).match(/\b([A-Z]{3})$/)?.[1] || null;
    const name = code ? cleanText(cells[1]).replace(new RegExp(`\\s+${code}$`), "") : cleanText(cells[1]);
    return {
      position: Number(cleanText(cells[0])) || null,
      name,
      code,
      nationality: cleanText(cells[2]),
      team: cleanText(cells[3]),
      points: Number(cleanText(cells[4])) || 0,
      url: linkUrl(cells[1]),
    };
  });
}

function parseTeams(html) {
  return tableRows(html).map((cells) => ({
    position: Number(cleanText(cells[0])) || null,
    name: cleanText(cells[1]),
    points: Number(cleanText(cells[2])) || 0,
    url: linkUrl(cells[1]),
  }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(url) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        headers: { accept: "text/html", "user-agent": "f1-postrace-data/1.0" },
        signal: controller.signal,
      });
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        if (error?.name === "AbortError") throw new Error(`官网请求超时（${requestTimeoutMs / 1000}秒）: ${url}`);
        throw error;
      }
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) return response.text();
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts - 1) throw new Error(`官网请求失败 ${response.status}: ${url}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    const serverDelay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
    await sleep(Math.min(10000, Math.max(retryDelayMs * (attempt + 1), serverDelay)));
  }
  throw new Error(`官网请求失败: ${url}`);
}

const driverHtml = await fetchPage(pages.drivers);
await sleep(retryDelayMs);
const teamHtml = await fetchPage(pages.teams);
const capturedAt = new Date().toISOString();
let previousSnapshot = {};
try {
  previousSnapshot = JSON.parse(await fs.readFile(output, "utf8"));
} catch { /* the first snapshot has no history to preserve */ }
const previousStatus = previousSnapshot.sync_status || {};
const snapshot = {
  season: year,
  captured_at: capturedAt,
  sync_status: {
    status: "success",
    trigger,
    attempted_at: capturedAt,
    last_success_at: capturedAt,
    last_automatic_at: trigger === "automatic" ? capturedAt : previousStatus.last_automatic_at || null,
    last_manual_at: trigger === "manual" ? capturedAt : previousStatus.last_manual_at || null,
  },
  source: pages,
  drivers: parseDrivers(driverHtml),
  teams: parseTeams(teamHtml),
};
if (!snapshot.drivers.length || !snapshot.teams.length) throw new Error("官网排名表为空，拒绝覆盖旧快照");
await fs.writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Saved ${output}: ${snapshot.drivers.length} drivers, ${snapshot.teams.length} teams`);
