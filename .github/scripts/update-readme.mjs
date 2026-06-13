import { readFile, writeFile } from "node:fs/promises";

const owner = process.env.PROFILE_OWNER || process.env.GITHUB_REPOSITORY_OWNER || "Tigranchick";
const token = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;
const timeZone = process.env.PROFILE_TIMEZONE || "Asia/Almaty";

if (!token) {
  throw new Error("GITHUB_TOKEN or GH_STATS_TOKEN is required");
}

const now = new Date();
const from = new Date(now);
from.setUTCDate(from.getUTCDate() - 365);

const query = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "Tigranchick-profile-telemetry",
  },
  body: JSON.stringify({
    query,
    variables: {
      login: owner,
      from: from.toISOString(),
      to: now.toISOString(),
    },
  }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(payload.errors.map((error) => error.message).join("; "));
}

const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;

if (!calendar) {
  throw new Error(`No contribution calendar returned for ${owner}`);
}

const days = calendar.weeks
  .flatMap((week) => week.contributionDays)
  .sort((left, right) => left.date.localeCompare(right.date));

function formatDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function statsFor(daysBack) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - daysBack + 1);
  const startKey = start.toISOString().slice(0, 10);

  const selected = days.filter((day) => day.date >= startKey);
  const contributions = selected.reduce((sum, day) => sum + day.contributionCount, 0);
  const activeDays = selected.filter((day) => day.contributionCount > 0).length;
  const peak = selected.reduce(
    (best, day) => (day.contributionCount > best.contributionCount ? day : best),
    { date: "-", contributionCount: 0 },
  );

  return {
    contributions,
    activeDays,
    peak: peak.contributionCount > 0 ? `${peak.contributionCount} (${peak.date})` : "0",
  };
}

const weekly = statsFor(7);
const monthly = statsFor(30);
const yearly = {
  contributions: calendar.totalContributions,
  activeDays: days.filter((day) => day.contributionCount > 0).length,
  peak: (() => {
    const peak = days.reduce(
      (best, day) => (day.contributionCount > best.contributionCount ? day : best),
      { date: "-", contributionCount: 0 },
    );
    return peak.contributionCount > 0 ? `${peak.contributionCount} (${peak.date})` : "0";
  })(),
};

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

const generated = [
  `GitHub activity snapshot · \`${formatDate(now)}\``,
  "",
  "| Window | Contributions | Active days | Peak day |",
  "| --- | ---: | ---: | --- |",
  `| Last 7 days | ${number(weekly.contributions)} | ${number(weekly.activeDays)} | ${weekly.peak} |`,
  `| Last 30 days | ${number(monthly.contributions)} | ${number(monthly.activeDays)} | ${monthly.peak} |`,
  `| Last 12 months | ${number(yearly.contributions)} | ${number(yearly.activeDays)} | ${yearly.peak} |`,
].join("\n");

const readmePath = new URL("../../README.md", import.meta.url);
const readme = await readFile(readmePath, "utf8");
const updated = readme.replace(
  /<!-- telemetry:start -->[\s\S]*?<!-- telemetry:end -->/,
  `<!-- telemetry:start -->\n${generated}\n<!-- telemetry:end -->`,
);

if (updated === readme) {
  console.log("Telemetry block is already up to date.");
} else {
  await writeFile(readmePath, updated);
  console.log("Telemetry block updated.");
}
