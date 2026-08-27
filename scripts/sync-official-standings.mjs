import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliArgs = typeof process === "undefined" ? [] : process.argv;
const year = Number(cliArgs[2] || new Date().getUTCFullYear());
const output = path.join(root, `official-standings-${year}.json`);
const baseUrl = "https://www.formula1.com";
const pages = {
  drivers: `${baseUrl}/en/results/${year}/drivers`,
  teams: `${baseUrl}/en/results/${year}/team`,
};

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

async function fetchPage(url) {
  const response = await fetch(url, { headers: { accept: "text/html", "user-agent": "f1-postrace-data/1.0" } });
  if (!response.ok) throw new Error(`官网请求失败 ${response.status}: ${url}`);
  return response.text();
}

const [driverHtml, teamHtml] = await Promise.all([fetchPage(pages.drivers), fetchPage(pages.teams)]);
const snapshot = {
  season: year,
  captured_at: new Date().toISOString(),
  source: pages,
  drivers: parseDrivers(driverHtml),
  teams: parseTeams(teamHtml),
};
if (!snapshot.drivers.length || !snapshot.teams.length) throw new Error("官网排名表为空，拒绝覆盖旧快照");
await fs.writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Saved ${output}: ${snapshot.drivers.length} drivers, ${snapshot.teams.length} teams`);
