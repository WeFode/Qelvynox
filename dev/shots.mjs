// Store screenshots, generated from the real UI harness in headless Chrome.
//
//   node dev/shots.mjs
//
// The dev server is started and stopped by this script, so one command turns
// the current source into the exact PNGs the Chrome Web Store listing needs.
// Nothing here ships with the extension.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "screenshots");
const PROFILE = path.join(ROOT, "dev", ".chrome-profile");
const SIZE = "1280,800";

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("no Chrome/Edge found; set CHROME=<path to executable>");
  process.exit(1);
}

// name -> [shot, theme, extra query]. The set is the store listing: what the
// toolkit actually does, both ramps, nothing decorative. The search keyword is
// chosen so its first hit is inside the opening viewport - the shot has to show
// a painted match, not a counter.
const SHOTS = [
  ["release-1-navigator-light", "navigator", "light"],
  ["release-2-search-light", "search", "light", "q=MutationObserver"],
  ["release-3-bookmarks-light", "bookmarks", "light"],
  ["release-4-export-light", "export", "light"],
  ["release-5-settings-light", "settings", "light"],
  ["release-6-navigator-dark", "navigator", "dark"],
  ["release-7-search-dark", "search", "dark", "q=MutationObserver"],
  ["release-8-settings-dark", "settings", "dark"]
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 8123, path: "/dev/ui-harness.html", timeout: 800 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

fs.mkdirSync(OUT, { recursive: true });

let child = null;
if (!(await serverUp())) {
  child = spawn(process.execPath, [path.join(ROOT, "dev", "serve.mjs")], { stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await wait(120);
  if (!(await serverUp())) {
    console.error("the harness server did not come up on 127.0.0.1:8123");
    child.kill();
    process.exit(1);
  }
  console.log("started dev/serve.mjs on :8123");
} else {
  console.log("reusing the harness server already running on :8123");
}

fs.mkdirSync(PROFILE, { recursive: true });

let failed = 0;
for (const [name, shot, theme, extra] of SHOTS) {
  const file = path.join(OUT, `${name}.png`);
  const url = `http://127.0.0.1:8123/c/demo-chat?shot=${shot}&theme=${theme}${extra ? `&${extra}` : ""}`;
  const res = spawnSync(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${SIZE}`,
    "--virtual-time-budget=12000",
    `--user-data-dir=${PROFILE}`,
    `--screenshot=${file}`,
    url
  ], { stdio: "pipe", encoding: "utf8" });
  const ok = res.status === 0 && fs.existsSync(file);
  if (!ok) {
    failed++;
    console.log(`FAIL  ${name}  ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" / ")}`);
  } else {
    console.log(`OK    ${name}.png  ${fs.statSync(file).size} bytes`);
  }
}

fs.rmSync(PROFILE, { recursive: true, force: true });
if (child) child.kill();

console.log(failed ? `\n${failed} shot(s) failed.` : `\n${SHOTS.length} screenshots written to screenshots/`);
process.exit(failed ? 1 : 0);
