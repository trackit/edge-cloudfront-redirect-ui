import { execFileSync } from "node:child_process";

/**
 * Release notes for a tag, grouped from the squash-merge subjects on `dev`.
 *
 * GitHub's own generated notes group by PR label, and nothing here is labelled.
 * The subjects already say what each change is — `feat(console): …`,
 * `(CF-27) Feat/geolocation condition (#47)` — so they are grouped by that
 * instead, and a PR needs nothing extra to land in the right section.
 *
 * Usage: node .github/scripts/release-notes.mjs v1.0.0 > notes.md
 * Needs the full history and tags (`fetch-depth: 0`).
 */

const tag = process.argv[2];
if (!tag) {
  console.error("usage: release-notes.mjs <tag>");
  process.exit(1);
}

const git = (args, stderr = "inherit") =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", stderr],
  }).trim();

/**
 * The release before this one, or undefined for the first. A final release
 * skips pre-releases, so v1.1.0's notes cover everything since v1.0.0 rather
 * than only what changed after v1.1.0-rc.1.
 */
const previousTag = (() => {
  const exclude = tag.includes("-") ? [] : ["--exclude", "*-*"];
  try {
    // Silenced: on the first release this fails by design ("No names found").
    return git(
      [
        "describe",
        "--tags",
        "--abbrev=0",
        "--match",
        "v*",
        ...exclude,
        `${tag}^`,
      ],
      "ignore",
    );
  } catch {
    return undefined;
  }
})();

const range = previousTag ? `${previousTag}..${tag}` : tag;
const subjects = git(["log", "--format=%s", "--no-merges", range])
  .split("\n")
  .filter(Boolean);

// First match wins, so the order matters: a `(CF-xx) Fix/…` title is a fix even
// though it also carries a ticket key.
const SECTIONS = [
  ["Features", /^(\(CF-\d+\) )?feat\b/i],
  ["Fixes", /^(\(CF-\d+\) )?fix\b/i],
  ["Docs", /^(\(CF-\d+\) )?docs\b/i],
  ["Maintenance", /^(\(CF-\d+\) )?(chore|ci|build|refactor|test)\b/i],
];

const grouped = new Map([
  ...SECTIONS.map(([name]) => [name, []]),
  ["Other", []],
]);
for (const subject of subjects) {
  const section = SECTIONS.find(([, pattern]) => pattern.test(subject));
  grouped.get(section ? section[0] : "Other").push(subject);
}

const lines = [];
for (const [name, items] of grouped) {
  if (items.length === 0) continue;
  lines.push(`## ${name}`, "", ...items.map((s) => `- ${s}`), "");
}

const repo = process.env["GITHUB_REPOSITORY"];
if (previousTag && repo) {
  lines.push(
    `**Full changelog:** https://github.com/${repo}/compare/${previousTag}...${tag}`,
  );
}

process.stdout.write(`${lines.join("\n").trim()}\n`);
