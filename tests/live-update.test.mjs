/**
 * v1.0.0 - Live surfaces, rebrand migration and release manifest.
 *
 * The bug this suite exists for: a panel that reads the conversation was only
 * ever rendered when it was opened, so a fourth reply stayed out of the
 * navigator and out of an open search until the user closed and reopened the
 * panel. Everything that reads the live DOM now has to be refreshed from the
 * observer tick, in place, without disturbing the reader.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const settingsCss = fs.readFileSync(path.join(REPO, "src/content/settings.css"), "utf8");
const popupCss = fs.readFileSync(path.join(REPO, "src/popup/popup.css"), "utf8");
const backgroundSrc = fs.readFileSync(path.join(REPO, "src/background/background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));

// `__MSG_x__` in the manifest is resolved by Chrome from _locales, so the
// listing checks have to read the same files rather than the raw manifest.
const LOCALES = ["zh_CN", "en"];
const localeMessages = Object.fromEntries(LOCALES.map((code) => [
  code, JSON.parse(fs.readFileSync(path.join(REPO, `_locales/${code}/messages.json`), "utf8"))
]));
const nameOf = (code) => localeMessages[code].extName.message;
const descOf = (code) => localeMessages[code].extDescription.message;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/** Extract a function's source (same helper as perf-v3110.test.mjs). */
function grab(name, src) {
  const s = src.indexOf(`function ${name}(`);
  if (s === -1) throw new Error(`missing ${name}`);
  let i = src.indexOf("(", s), p = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") p++;
    else if (src[i] === ")") { p--; if (!p) break; }
  }
  let d = 0;
  i = src.indexOf("{", i);
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (!d) break; }
  }
  return src.slice(s, i + 1);
}

/* ---------------- 1. the navigator's change detection ---------------- */
console.log("--- PART 1: outlineSignature ---");

{
  const ctx = { getMessageIdFromElement: (el) => el.id || null, Math, String };
  vm.createContext(ctx);
  vm.runInContext(grab("outlineSignature", contentSrc) + "\nglobalThis.sig = outlineSignature;", ctx);

  const three = [
    { id: "u1", textContent: "第一个问题" },
    { id: "u2", textContent: "第二个问题" },
    { id: "u3", textContent: "第三个问题" }
  ];
  const base = ctx.sig(three, 0);
  check("same questions, same state -> same signature", ctx.sig(three.slice(), 0) === base);

  const four = three.concat([{ id: "u4", textContent: "第四个问题" }]);
  check("a fourth question changes the signature", ctx.sig(four, 0) !== base);

  const edited = three.slice(0, 2).concat([{ id: "u3", textContent: "第三个问题被改写了" }]);
  check("an edited question changes the signature without changing the count",
    ctx.sig(edited, 0) !== base);

  check("a turn being folded away changes the signature", ctx.sig(three, 1) !== base);
  const sameLength = three.slice();
  sameLength[0] = { id: "u1", textContent: "另一条问题" };
  check("same-length edits to older questions change the signature", ctx.sig(sameLength, 0) !== base);
}

/* ---------------- 2. an open panel refreshes in place ---------------- */
console.log("\n--- PART 2: popovers refresh instead of being rebuilt ---");

const openOutline = grab("openOutlinePopover", contentSrc);
const openBookmarks = grab("openBookmarksPopover", contentSrc);

check("an already-open navigator is re-read, not torn down and re-added",
  /if \(existing\) \{\s*renderOutlineList\(existing\.querySelector/.test(openOutline) &&
  !openOutline.includes("if (existing) existing.remove();"));

check("an already-open bookmarks panel is re-read too",
  /if \(existing\) \{\s*renderBookmarksList\(existing\.querySelector/.test(openBookmarks) &&
  !openBookmarks.includes("if (existing) existing.remove();"));

const renderBookmarks = grab("renderBookmarksList", contentSrc);
check("the bookmarks list is idempotent: it clears before it appends",
  renderBookmarks.includes('listEl.textContent = "";') &&
  /const sig = `\$\{bookmarksScope\}/.test(renderBookmarks) &&
  renderBookmarks.includes("if (listEl.dataset.sig === sig) return;"));

check("switching the bookmarks scope repaints the list, not the whole panel",
  /const setScope = \(scope\) => \{[\s\S]*?renderBookmarksList\(list\);/.test(openBookmarks));

check("a deleted bookmark re-renders the list in place",
  /syncAllBookmarkButtons\(\);\s*renderBookmarksList\(listEl\);/.test(contentSrc));

check("a rebuilt outline keeps the reader's scroll position",
  grab("renderOutlineList", contentSrc).includes("const keepScroll = listEl.scrollTop;"));

/* ---------------- 3. the dock stops rebuilding itself ---------------- */
console.log("\n--- PART 3: the dock survives a new reply ---");

const dockFn = contentSrc.slice(contentSrc.indexOf("function renderFloatingDock()"),
  contentSrc.indexOf("  // The turn sitting nearest the middle"));
check("the dock signature describes which buttons exist, not how many questions there are",
  /const signature = `\$\{appSettings\.enabled\}\|\$\{appSettings\.enableSearch\}\|\$\{appSettings\.enableOutline\}\|\$\{appSettings\.enableBookmarks !== false\}`;/.test(dockFn));
check("a count-only change patches the badge instead of recreating the buttons",
  /if \(dock\.dataset\.sig === signature\) \{[\s\S]{0,120}?updateOutlineBadge\(\);[\s\S]{0,40}?return;[\s\S]{0,20}?\}/.test(dockFn));

/* ---------------- 4. the observer tick keeps everything live ---------- */
console.log("\n--- PART 4: observer tick ---");

const tick = grab("runObserverTick", contentSrc);
check("the tick refreshes every open conversation-reading surface",
  tick.includes("refreshLiveSurfaces();") &&
  /function refreshLiveSurfaces\(\)[\s\S]{0,400}#qelvynox-outline-popover[\s\S]*#qelvynox-bookmarks-popover/.test(contentSrc));
check("the tick repaints the open search bar while an answer is streaming",
  /if \(searchActive && searchRefresh\) \{[\s\S]*?!isStreaming \|\| now - lastLiveSearchRefresh >= SEARCH_LIVE_MS/.test(tick));
check("the live search repaint is throttled, not per-mutation",
  /const SEARCH_LIVE_MS = \d{3,};/.test(contentSrc));
check("a background repaint never reserves turns for the limiter",
  /if \(options\.scroll !== false\) \{\s*if \(!isTurnVisible\(match\.turn\)\) manuallyUnhiddenTurnsCount \+= 2;/.test(contentSrc));

/* ---------------- 5. rebrand migration + retired feature cleanup ------- */
console.log("\n--- PART 5: TurboGPT -> Qelvynox migration, folder data retired ---");

{
  const store = new Map([
    ["turbogpt_config", '{"enabled":false}'],
    ["turbogpt_folders", '[{"id":"f1","name":"工作"}]'],
    ["turbogpt_bookmarks_abc", '[{"id":"m1"}]'],
    ["qelvynox_folders", '[{"id":"keep"}]']
  ]);
  const ctx = {
    LEGACY_PREFIX: "turbogpt_",
    CONFIG_KEY: "qelvynox_config",
    EXTRA_KEY: "qelvynox_extra_turns",
    RETIRED_FOLDER_KEYS: ["qelvynox_folders", "turbogpt_folders"],
    BOOKMARKS_PREFIX: "qelvynox_bookmarks_",
    localStorage: {
      get length() { return store.size; },
      key: (i) => Array.from(store.keys())[i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k)
    }
  };
  vm.createContext(ctx);
  vm.runInContext(grab("migrateLegacyKeys", contentSrc) + "\nmigrateLegacyKeys();", ctx);

  check("legacy page config is copied to the new key", store.get("qelvynox_config") === '{"enabled":false}');
  check("legacy bookmarks are copied under the new prefix", store.get("qelvynox_bookmarks_abc") === '[{"id":"m1"}]');
  check("retired folder data is preserved without restoring the feature",
    store.has("qelvynox_folders") && store.has("turbogpt_folders"));
  check("the legacy keys still in use are left alone (chatgpt.com storage is shared with the page)",
    store.has("turbogpt_config") && store.has("turbogpt_bookmarks_abc"));
  check("migration runs before anything reads the settings",
    contentSrc.indexOf("migrateLegacyKeys();") < contentSrc.indexOf("function loadSettings()"));
}

{
  const stored = { turbogpt_settings: { enabled: false, messageLimit: 3 } };
  let written = null;
  let installed = null;
  const ctx = {
    chrome: {
      runtime: {
        onInstalled: { addListener: (fn) => { installed = fn; } },
        onMessage: { addListener: () => {} },
        getManifest: () => ({ version: "1.0.0" }),
        id: "ext"
      },
      storage: {
        local: {
          get: (keys, cb) => cb(Object.fromEntries(keys.map((k) => [k, stored[k]]))),
          set: (obj) => { written = obj; }
        }
      }
    },
    console, fetch, URL, btoa, Uint8Array, ArrayBuffer, Promise, Object, JSON, String, Math
  };
  vm.createContext(ctx);
  vm.runInContext(backgroundSrc, ctx);
  installed();
  check("the service worker adopts the legacy settings object",
    written && written.qelvynox_settings && written.qelvynox_settings.enabled === false &&
    written.qelvynox_settings.messageLimit === 3);
  check("and still fills in keys a legacy object never had",
    written && written.qelvynox_settings && written.qelvynox_settings.enableLocalArchive === true);
}

const legacyLines = contentSrc.split("\n").filter((l) => /turbogpt/i.test(l));
check("TurboGPT survives only as the migration prefix, a comment or the retired-key cleanup",
  legacyLines.length > 0 &&
  legacyLines.every((l) => /^\s*(\/\/|\*)/.test(l) || l.includes("LEGACY_PREFIX") ||
    l.includes("RETIRED_FOLDER_KEYS")) &&
  !/turbogpt/i.test(settingsCss + popupCss + JSON.stringify(manifest)),
  legacyLines.map((l) => l.trim()).join(" | ").slice(0, 160));

/* ---------------- 6. release manifest ---------------- */
console.log("\n--- PART 6: store listing / manifest ---");

check("the item is named Qelvynox, in every locale, for a first store release",
  manifest.name === "__MSG_extName__" && manifest.short_name === "Qelvynox" && manifest.version === "1.0.0" &&
  LOCALES.every((code) => nameOf(code).startsWith("Qelvynox")));
check("the default locale is Chinese, matching the extension's default UI language",
  manifest.default_locale === "zh_CN" && nameOf("zh_CN").includes("加速"));
check("both locale entries fit the store's 75 / 132 character limits",
  LOCALES.every((code) => nameOf(code).length <= 75 && descOf(code).length <= 132),
  LOCALES.map((c) => `${c}: ${nameOf(c).length}/${descOf(c).length}`).join(" "));
check("name, description and toolbar tooltip all resolve through messages.json",
  manifest.description === "__MSG_extDescription__" &&
  manifest.action.default_title === "__MSG_actionTitle__" &&
  LOCALES.every((code) => localeMessages[code].actionTitle.message.length <= 132));
// A `__MSG_key__` that no locale defines makes Chrome refuse to load the
// unpacked extension at all, so this is checked before the zip is built.
const msgKeys = JSON.stringify(manifest).match(/__MSG_([A-Za-z0-9_]+)__/g) || [];
check("every __MSG_*__ in the manifest is defined in every locale",
  msgKeys.length > 0 &&
  msgKeys.every((raw) => LOCALES.every((code) => !!localeMessages[code][raw.slice(6, -2)])),
  `${msgKeys.length} references`);
check("no browsing-history permission: host permissions already cover the tab lookup",
  !manifest.permissions.includes("tabs") && !manifest.permissions.includes("activeTab"),
  manifest.permissions.join(", "));
check("the cross-tab settings sync still has a path when the popup saves",
  contentSrc.includes("chrome.storage.onChanged.addListener"));
check("the icon set ships a store-size 512 and the action keeps 16/32/48/128",
  manifest.icons["512"] === "icons/icon512.png" &&
  ["16", "32", "48", "128"].every((s) => manifest.action.default_icon[s] === `icons/icon${s}.png`));
check("every icon the manifest names actually exists in the package",
  [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]
    .every((p) => fs.existsSync(path.join(REPO, p))));

/* ---------------- 7. brand tokens, focus, motion ---------------- */
console.log("\n--- PART 7: design system ---");

check("the brand accent is one token pair, not a recoloured theme",
  contentSrc.includes("--su-brand: #4f5fd8") && contentSrc.includes("--su-brand: #9db0ff") &&
  settingsCss.includes("--qg-brand: #4f5fd8") && settingsCss.includes("--qg-brand: #9db0ff"));
check("the legacy indigo/violet washes and the stray blue switch are gone",
  !/#a5b4fc|#7e22ce|#3b0764|#818cf8|#6366f1|#4f46e5|#4338ca|#c7d2fe|#e0e7ff|#eef2ff|#312e81|#1e1b4b/.test(contentSrc) &&
  !/#3b82f6/.test(settingsCss));
check("every icon-only control has a visible focus ring",
  contentSrc.includes(".qelvynox-dock-btn:focus-visible") &&
  contentSrc.includes(".qelvynox-toc-item:focus-visible") &&
  contentSrc.includes(".qelvynox-search-btn:focus-visible") &&
  settingsCss.includes(".qgst-nav-item:focus-visible") &&
  popupCss.includes(".btn:focus-visible"));
check("motion can be reduced everywhere the toolkit animates",
  contentSrc.includes("@media (prefers-reduced-motion: reduce)") &&
  settingsCss.includes("@media (prefers-reduced-motion: reduce)") &&
  popupCss.includes("@media (prefers-reduced-motion: reduce)"));
check("the navigator rows are reachable by keyboard, not hover-only",
  grab("renderOutlineList", contentSrc).includes("item.tabIndex = 0;") &&
  /item\.addEventListener\("keydown", \(e\) => \{\s*if \(e\.key === "Enter" \|\| e\.key === " "\)/.test(contentSrc));
check("the search bar states its own shortcuts instead of hiding them",
  contentSrc.includes("HINT_LEGEND") && contentSrc.includes('class="qelvynox-kbd"'));
check("the load pill is themed by the page, not by the OS media query",
  contentSrc.includes('.qelvynox-floating-pill.qelvynox-dark') &&
  !/@media \(prefers-color-scheme: dark\) \{\s*\.qelvynox-floating-pill/.test(contentSrc) &&
  contentSrc.includes('"qelvynox-floating-pill",'));
check("the popup follows the browser theme instead of always being white",
  /@media \(prefers-color-scheme: dark\) \{\s*:root \{/.test(popupCss));
check("no pictographic glyph is used as an icon in the injected styles",
  !/\p{Extended_Pictographic}/u.test(contentSrc.slice(contentSrc.indexOf("  function injectStyles()"),
    contentSrc.indexOf("      /* Export window"))));
check("the sidebar folder block is gone from the injected styles",
  !contentSrc.includes(".qelvynox-sidebar-folders") && !contentSrc.includes(".qelvynox-folder-item"));
check("the top-bar Export button no longer needs a media query",
  !/@media \(prefers-color-scheme: dark\) \{\s*\.qelvynox-topbar-export/.test(contentSrc) &&
  contentSrc.includes(".qelvynox-topbar-export svg { pointer-events: none; }"));

const failed = results.filter((x) => !x.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
