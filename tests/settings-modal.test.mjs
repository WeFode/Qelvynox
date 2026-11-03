/**
 * v1.0.0 - In-page settings modal (Speed Booster style, shadcn look).
 *
 * PART 1 asserts the product rules statically (no estimates, no paid tier,
 * one entry point, wording only from the dictionary, CSS shipped).
 * PART 2 runs the REAL page-render functions from src/content/index.js in a
 * vm with stubbed state and checks the produced markup.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { I18N_BOOT, loadDictionary } from "./i18n-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const zhDict = loadDictionary("zh-CN");
const enDict = loadDictionary("en");

const contentSrc = fs.readFileSync(path.join(root, "src/content/index.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "src/popup/popup.js"), "utf8");
const settingsCss = fs.readFileSync(path.join(root, "src/content/settings.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/* ---------------- PART 1: product rules ---------------- */
console.log("--- PART 1: product rules ---");

check("the settings modal exists in the content script",
  contentSrc.includes("function openSettingsModal(") && contentSrc.includes("function closeSettingsModal("));

check("modal markup is a sidebar + detail panel (Speed Booster layout)",
  contentSrc.includes('class="qgst-sidebar"') && contentSrc.includes('class="qgst-content"') &&
  contentSrc.includes('class="qgst-panel"'));

check("every feature has a page, none is behind a paid tier",
  ["speed", "search", "navigator", "export", "archive", "backup", "general", "about"]
    .every((id) => contentSrc.includes(`id: "${id}"`)));
check("the removed folder page is not offered again",
  !contentSrc.includes('id: "folders"') && !contentSrc.includes("qgstFoldersPage"));

const commercialHits = (contentSrc + popupHtml + popupJs).match(/PRO TRIAL|Upgrade to|Buy me a beer|Get PRO|升级专业版|付费购买/g);
check("no commercial surface anywhere in the shipped UI",
  !commercialHits, commercialHits ? commercialHits.join(",") : "clean");

check("settings.css is injected through the manifest (no inline style blob)",
  manifest.content_scripts.some((cs) => (cs.css || []).includes("src/content/settings.css")));

check("settings.css is fully namespaced so ChatGPT's own styles cannot clash",
  settingsCss.split("}").every((block) => {
    const sel = block.split("{")[0];
    return !sel.trim() || /\.qgst-|^@|^:root|from|to/.test(sel.trim());
  }));

check("the modal uses shadcn design tokens (neutral palette, 1px borders, radius vars)",
  settingsCss.includes("--qg-border: #e4e4e7") &&
  settingsCss.includes("--qg-muted: #71717a") &&
  settingsCss.includes(".qgst-root.qelvynox-dark") &&
  /border: 1px solid var\(--qg-border\)/.test(settingsCss));

check("theme follows ChatGPT (data-theme/class), not only the OS",
  contentSrc.includes('root.getAttribute("data-theme")') &&
  contentSrc.includes("classList.toggle(\"qelvynox-dark\", isDarkTheme())"));

check("the dock's gear is the in-page entry point and stays available when the booster is off",
  contentSrc.includes('id="qelvynox-dock-settings"') &&
  !/dockVisible/.test(contentSrc.slice(
    contentSrc.indexOf("function renderFloatingDock()"),
    contentSrc.indexOf("function updateOutlineBadge()")
  )));

check("the popup is a launcher that asks the page to open the modal",
  popupJs.includes('"QELVYNOX_OPEN_SETTINGS"') && popupHtml.includes('id="openSettingsBtn"'));

check("the launcher's button is wired to that request (not a dead control)",
  /openSettingsBtn[\s\S]{0,400}?QELVYNOX_OPEN_SETTINGS/.test(popupJs) &&
  /function sendToActiveTab\(/.test(popupJs));

check("closing routes: overlay, close button and Escape",
  contentSrc.includes('data-close="1"') && contentSrc.includes('data-action="close"') &&
  contentSrc.includes('e.key === "Escape"'));

check("the panel sits above the dock so its own controls stay clickable",
  /\.qgst-root\s*\{[\s\S]*?z-index: 20000/.test(settingsCss));

check("no removed estimator is referenced by the modal",
  !/computeContextUsage|computeMessageCountStatus|contextUsedPct|messageCountWarningThreshold/.test(contentSrc));

check("the navigator lists questions without numbering them '第几轮'",
  !contentSrc.includes("qelvynox-toc-num") &&
  !/textContent = `#\$\{idx/.test(contentSrc) &&
  contentSrc.includes("qelvynox-toc-role"));

check("the dock's outline button doubles as a viewport-position bar map",
  contentSrc.includes('class="qelvynox-dock-bars"') &&
  contentSrc.includes("function computeDockViewportIndex(") &&
  contentSrc.includes("function updateDockViewportIndicator(") &&
  contentSrc.includes("scheduleDockViewportIndicator") &&
  /DOCK_INDICATOR_MS = \d{3,}/.test(contentSrc));

check("the modal's wording comes from the dictionary, in both languages",
  ["settings.nav.speed", "settings.nav.navigator", "settings.nav.archive", "settings.nav.backup",
    "settings.modeRecent", "settings.allLoaded", "settings.exportOpenBtn", "settings.nav.general"]
    .every((key) => contentSrc.includes(`"${key}"`) &&
      zhDict.t(key).length > 0 && enDict.t(key).length > 0 && enDict.t(key) !== key));

/* ---------------- PART 2: real page renderers ---------------- */
console.log("\n--- PART 2: settings pages render ---");

const sliceStart = contentSrc.indexOf("  const QGST_ICONS = {");
const sliceEnd = contentSrc.indexOf("  function renderAllTools() {");
check("the settings-modal block can be located in the source",
  sliceStart > 0 && sliceEnd > sliceStart);

const modalSrc = contentSrc.slice(sliceStart, sliceEnd);

// A data-action with no branch in the dispatcher is a silently dead button;
// the browser harness caught exactly that with the close button once.
const renderedActions = new Set();
for (const m of modalSrc.matchAll(/data-action="([a-z-]+)"/g)) renderedActions.add(m[1]);
const handledActions = new Set();
for (const m of modalSrc.matchAll(/action === "([a-z-]+)"/g)) handledActions.add(m[1]);
const unhandled = Array.from(renderedActions).filter((a) => !handledActions.has(a));
check("every data-action rendered by the panel is handled by the dispatcher",
  unhandled.length === 0 && renderedActions.size >= 6,
  unhandled.length ? `unhandled: ${unhandled.join(", ")}` : `${renderedActions.size} actions wired`);

function makeModal(settings, status = {}, received = true) {
  const ctx = {
    appSettings: {
      enabled: true,
      messageLimit: 15,
      loadBatchSize: 5,
      continuationTurns: 10,
      enableAutoScrollLoad: true,
      enableFloatingButton: true,
      enableOutline: true,
      enableSearch: true,
      enableLocalArchive: true,
      liveAutoTrim: false,
      disableNotifications: false,
      ...settings
    },
    lastStatus: status,
    statusReceived: received,
    esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]),
    cleanTitle: () => "浏览器插件优化卡顿",
    chrome: { runtime: { getManifest: () => ({ version: "1.0.0" }), getURL: (p) => `chrome-extension://x/${p}` } },
    Number, Math, String, Object, Array, JSON, Boolean, RegExp, Error,
    console
  };
  vm.createContext(ctx);
  vm.runInContext(`${I18N_BOOT}\n${modalSrc}\nglobalThis.__setPage = (p) => { qgstPage = p; };`, ctx);
  return { ctx, html: (page) => { ctx.__setPage(page); return ctx.qgstPageHtml(); } };
}

const modal = makeModal({}, { visibleTurns: 30, totalTurns: 30, countState: "complete" });

const speed = modal.html("speed");
check("speed page: master switch + loading-mode radios",
  speed.includes('data-setting="enabled"') && speed.includes('data-load-mode="recent"') &&
  speed.includes('data-load-mode="default"') && speed.includes('data-load-mode="all"'));
check("speed page: no paid-tier marker on the 'load everything' option",
  !/PRO|升级|付费/.test(speed), "clean");
check("speed page: steppers for batch and continuation",
  speed.includes('data-target="loadBatchSize"') && speed.includes('data-target="continuationTurns"'));
check("speed page: quiet-mode switch exists",
  speed.includes('data-setting="disableNotifications"'));

const chat = modal.html("speed");
check("current chat card shows a plain loaded/total ratio",
  /30<\/span><span class="qgst-chat-num-total">\/ 30/.test(chat) && chat.includes("已全部加载"),
  chat.match(/qgst-chat-num[^<]*<[^>]*>[^<]*/) ? "rendered" : "missing");

const noData = makeModal({}, {}, false).html("speed");
check("without server data the card never invents a 0/0",
  noData.includes("等待对话数据") && !/qgst-chat-num">0</.test(noData));
check("and the empty track is muted, not a green '0% loaded' bar",
  noData.includes("qgst-progress-fill qgst-progress-muted") &&
  !modal.html("speed").includes("qgst-progress-muted"));

const partial = makeModal({}, { visibleTurns: 2, totalTurns: 400, countState: "partial" }).html("speed");
check("a partial count is labelled, not presented as complete",
  partial.includes("部分历史未统计") && !partial.includes("已全部加载"));

const search = modal.html("search");
check("search page documents the shortcut and owns its switch",
  search.includes('data-setting="enableSearch"') && search.includes("qgst-kbd"));

const nav = modal.html("navigator");
check("navigator page owns the outline switch",
  nav.includes('data-setting="enableOutline"') && nav.includes("收藏"));

check("the removed folders page is not reachable: an unknown page falls back to speed",
  modal.html("folders").includes('data-setting="enabled"') &&
  !modal.html("folders").includes("enableFolders"));

const archive = modal.html("archive");
check("archive page owns the switch, stats line and delete action",
  archive.includes('data-setting="enableLocalArchive"') &&
  archive.includes("qelvynox-qgst-archive-stats") &&
  archive.includes('data-action="archive-clear"'));

const exportPage = modal.html("export");
check("export page opens the existing export window",
  exportPage.includes('data-action="export-open"') && exportPage.includes("选择消息并导出"));
check("export page also offers the whole-conversation and continuation entries directly",
  exportPage.includes('data-action="export-full-md"') && exportPage.includes('data-action="export-continuation"') &&
  exportPage.includes("完整对话（.md）") && exportPage.includes("续聊提示词"));
check("those entries route through the export window (progress + honest failures), not a copy",
  modalSrc.includes('openExportModal("#qelvynox-export-full-md")') &&
  modalSrc.includes('openExportModal("#qelvynox-export-continuation")') &&
  contentSrc.includes("if (autoAction) {") &&
  !modalSrc.includes("requestFullConversation("));

const backup = modal.html("backup");
check("backup page has export and import actions",
  backup.includes('data-action="backup-export"') && backup.includes('data-action="backup-import"'));

const about = modal.html("about");
check("about page discloses network requests and the version",
  about.includes("历史和图片请求会连接 OpenAI 服务") && about.includes("1.0.0") && !about.includes("qgst-switch"));

// Disabled features must flip their switches so the sidebar dots can follow.
const off = makeModal({ enabled: false }).html("speed");
const searchOff = makeModal({ enableSearch: false }).html("search");
check("switches reflect stored state (unchecked when the feature is off)",
  !/data-setting="enabled"[^>]*checked/.test(off) &&
  !/data-setting="enableSearch"[^>]*checked/.test(searchOff),
  `${/data-setting="enabled"[^>]*>/.exec(off)?.[0] || "n/a"}`);

// The load-mode radio must map onto the existing storage semantics only.
check("the three modes map to enabled + messageLimit only (no new magic)",
  modalSrc.includes('messageLimit: 100') &&
  modalSrc.includes('qgstSaveSettings({ enabled: false })') &&
  /mode === "recent"/.test(modalSrc));

check("writes go through chrome.storage.local so every tab syncs",
  modalSrc.includes("chrome.storage.local.set({ [SETTINGS_KEY]: appSettings })") &&
  modalSrc.includes("localStorage.setItem(CONFIG_KEY"));

/* ---------------- PART 3: floating surfaces redesigned to shadcn ---------------- */
console.log("\n--- PART 3: popovers / search / export redesign ---");

check("navigator, bookmarks, search and export share the neutral surface tokens",
  contentSrc.includes("--su-bg: #ffffff") &&
  contentSrc.includes("--su-border: #e4e4e7") &&
  contentSrc.includes("--su-pop:") &&
  contentSrc.includes(".qelvynox-outline-popover.qelvynox-dark") &&
  contentSrc.includes(".qelvynox-bookmarks-popover.qelvynox-dark") &&
  contentSrc.includes(".qelvynox-search-overlay.qelvynox-dark") &&
  contentSrc.includes(".qelvynox-modal-overlay.qelvynox-dark"));

check("no legacy indigo/violet wash survives in the content script",
  !/#a5b4fc|#7e22ce|#3b0764|#818cf8|#6366f1|#4f46e5|#4338ca|#c7d2fe|#e0e7ff|#eef2ff|#312e81|#1e1b4b/.test(contentSrc));

check("the floating surfaces are no longer themed by a media query",
  !/\.qelvynox-outline-popover \{[^}]*background: #1e293b/.test(contentSrc) &&
  !/\.qelvynox-search-overlay \{\s*background: #1e293b/.test(contentSrc) &&
  !/\.qelvynox-modal-box \{ background: #1e293b/.test(contentSrc));

check("surfaces are created with the current theme and re-synced live",
  contentSrc.includes('"qelvynox-outline-popover" + (isDarkTheme() ? " qelvynox-dark" : "")') &&
  contentSrc.includes('"qelvynox-bookmarks-popover" + (isDarkTheme() ? " qelvynox-dark" : "")') &&
  contentSrc.includes('"qelvynox-search-overlay" + (isDarkTheme() ? " qelvynox-dark" : "")') &&
  contentSrc.includes('"qelvynox-modal-overlay" + (isDarkTheme() ? " qelvynox-dark" : "")') &&
  contentSrc.includes("function syncSurfaceTheme()") &&
  /function syncSurfaceTheme\(\)[\s\S]{0,300}"qelvynox-export-modal"/.test(contentSrc));

check("the brand logo is inline SVG (a chrome-extension <img> is CSP-blocked)",
  contentSrc.includes('class="qgst-logo">${QGST_ICONS.logo}') &&
  !contentSrc.includes('getURL("icons') &&
  QGST_ICONS_hasLogo(contentSrc));
function QGST_ICONS_hasLogo(src) { return /logo:\s*'<svg/.test(src); }

check("the modal close binds a direct listener as well as the delegated one",
  /closeBtn\) closeBtn\.addEventListener\("click"[\s\S]*closeSettingsModal\(\)/.test(contentSrc) &&
  /overlayEl\) overlayEl\.addEventListener\("click"[\s\S]*closeSettingsModal\(\)/.test(contentSrc));

const popSrc = contentSrc.slice(
  contentSrc.indexOf("  function openOutlinePopover()"),
  contentSrc.indexOf("  // 3. Response Bookmarks")
);
const exportSrc = contentSrc.slice(
  contentSrc.indexOf("  const exportIcon = ("),
  contentSrc.indexOf("  // 7. Local conversation archive")
);

check("the navigator popover has no header, no tab strip and no close button",
  popSrc.length > 500 &&
  !popSrc.includes("qelvynox-drawer-header") && !popSrc.includes("qelvynox-drawer-tab") &&
  !popSrc.includes("qelvynox-drawer-close") && !contentSrc.includes("qelvynox-outline-drawer"));

check("the popovers open on hover and stay open while the pointer is inside",
  contentSrc.includes("const POPOVER_OPEN_MS = ") &&
  contentSrc.includes("const POPOVER_CLOSE_MS = ") &&
  contentSrc.includes('addEventListener("mouseenter"') &&
  contentSrc.includes('addEventListener("mouseleave"') &&
  contentSrc.includes("outlinePopover.armOpen") && contentSrc.includes("bookmarksPopover.armOpen"));

// A headerless panel has no close button, so Escape must be its exit.
check("Escape dismisses a pinned popover (it has no close button to click)",
  /else if \(e\.key === "Escape"\)[\s\S]{0,200}outlinePopover\.forceClose\(\)[\s\S]{0,60}bookmarksPopover\.forceClose\(\)/.test(contentSrc));

check("only the selective formats follow the checkboxes",
  contentSrc.includes('.qelvynox-export-option-btn:not(.qelvynox-local-btn):not(.qelvynox-full-btn)') &&
  contentSrc.includes('id="qelvynox-export-full-md"') &&
  /class="qelvynox-export-option-btn qelvynox-full-btn" id="qelvynox-export-full-md"/.test(contentSrc));

check("the navigator follows the viewport: the centre turn owns the active row",
  contentSrc.includes("function findCenterTurn()") &&
  contentSrc.includes("function markActiveTocItem(") &&
  contentSrc.includes("qelvynox-toc-active") &&
  /function updateDockViewportIndicator\(\)[\s\S]{0,400}markActiveTocItem\(center\)/.test(contentSrc));

check("bookmarks live on their own dock button, scoped 本对话 / 全部",
  contentSrc.includes('id="qelvynox-dock-bookmarks"') &&
  contentSrc.includes("qelvynox-bm-scope-current") && contentSrc.includes("qelvynox-bm-scope-all"));

check("the export window and the popovers use line icons, not emoji",
  exportSrc.length > 1000 && !/\p{Extended_Pictographic}/u.test(exportSrc) &&
  !/\p{Extended_Pictographic}/u.test(popSrc));

check("the export window closes from the glyph, the overlay and Escape",
  exportSrc.includes('addEventListener("click", closeExportModal)') &&
  /if \(e\.target === modal\) closeExportModal\(\)/.test(exportSrc) &&
  exportSrc.includes('e.key !== "Escape"') &&
  exportSrc.includes("document.removeEventListener(\"keydown\", exportModalKeyHandler, true)"));

check("search is one command bar: no scope pill, no result list, no preview card",
  !contentSrc.includes("qelvynox-search-mode-pill") &&
  !contentSrc.includes("qelvynox-search-results-panel") &&
  !contentSrc.includes("qelvynox-preview-card") &&
  !contentSrc.includes("searchMode"));

check("search highlights through the Custom Highlight API and never edits the host DOM",
  contentSrc.includes("::highlight(qelvynox-search)") &&
  contentSrc.includes("CSS.highlights.set(SEARCH_HL_ALL") &&
  contentSrc.includes("CSS.highlights.delete(SEARCH_HL_ALL)") &&
  !contentSrc.includes('class="qelvynox-search-mark"') &&
  !/search[\s\S]{0,400}<mark/.test(contentSrc.slice(contentSrc.indexOf("  // 4. In-Chat Search"),
    contentSrc.indexOf("  // 5. Modern Pure Chat Exporter"))));

const failed = results.filter((x) => !x.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
