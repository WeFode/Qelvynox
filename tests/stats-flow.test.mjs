/**
 * Qelvynox stats-flow + temporary-chat harness.
 * Extracts the REAL settings-modal count logic and the REAL content-script
 * helpers from source and exercises them. Zero dependencies.
 *
 * The context-window/token estimate and the message-count alert were removed
 * in 3.16.0 - this suite also guards that they do not creep back into the
 * popup or the stats payload.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { I18N_BOOT } from "./i18n-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const popupSrc = fs.readFileSync(path.join(root, "src/popup/popup.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(root, "src/content/index.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/* -------- settings-modal count logic, extracted verbatim -------- */

// The in-page panel is the only place turn numbers are shown now; it renders
// a plain loaded/total ratio from the server-verified status.
function makeCounts() {
  const ctx = {
    lastStatus: {},
    statusReceived: false,
    Number, Math, String, Object, console
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab("qgstChatCounts", contentSrc)}`, ctx);
  return {
    compute(stats, received = true) {
      for (const k of Object.keys(ctx.lastStatus)) delete ctx.lastStatus[k];
      Object.assign(ctx.lastStatus, stats || {});
      ctx.statusReceived = received;
      return vm.runInContext(`qgstChatCounts()`, ctx);
    }
  };
}

function grab(name, src) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function makeContent({ href, domUserTurns = 0, title = "" }) {
  const ctx = {
    window: { location: { href, pathname: new URL(href).pathname } },
    document: {
      title,
      querySelectorAll: (sel) =>
        sel.includes('author-role="user"') ? new Array(domUserTurns).fill({}) : []
    },
    URL, Date, Math, String, Number, console
  };
  vm.createContext(ctx);
  const code = [
    grab("getConversationId", contentSrc),
    grab("isTemporaryChat", contentSrc),
    grab("countDomUserTurns", contentSrc),
    grab("timestampSlug", contentSrc),
    grab("cleanTitle", contentSrc),
    grab("sanitizeFilename", contentSrc),
    grab("extractConversationContent", contentSrc).replace(
      /const turns = [^;]+;/,
      "const turns = [];"
    ),
    `globalThis.api = { getConversationId, isTemporaryChat, countDomUserTurns, cleanTitle, sanitizeFilename };`
  ].join("\n");
  vm.runInContext(code, ctx);
  return ctx.api;
}

/* ------------------------------- tests -------------------------------- */

console.log("--- PART A: loaded/total counts (no estimates) ---");
const counts = makeCounts();

// 1. stats present + matching id
let r = counts.compute({ visibleTurns: 2, totalTurns: 703, countState: "complete" });
check("1. real stats render as 2 / 703", r.visible === 2 && r.total === 703, `${r.visible}/${r.total}`);
check("1. percentage only for a usable total", r.pct === 0 && r.allLoaded === false, `${r.pct}`);

// 2. content script: stats present but page id not extractable -> must NOT be stale
const cNoId = makeContent({ href: "https://chatgpt.com/", domUserTurns: 5 });
const pageId = cNoId.getConversationId();
const statusId = "abc-123";
const definitelyStale = !!pageId && !!statusId && pageId !== statusId;
check("2. missing page id is NOT treated as a mismatch", definitelyStale === false, `pageId=${pageId}`);

// 3. stats undefined -> initializing, never 0/0
r = counts.compute(undefined, false);
check("3. no stats -> no data, not 0", r.hasData === false && r.visible === null, `${r.visible}`);

r = counts.compute({ countState: "initializing" }, false);
check("3b. explicit unavailable -> not 0/0", r.hasData === false && r.visible === null);

// the exact live failure: content replied with nothing usable
r = counts.compute({ visibleTurns: undefined, totalTurns: undefined, countState: undefined });
check("3c. LIVE BUG: undefined fields never become 0 / 0",
  !(r.visible === 0 && r.total === 0), `${r.visible}/${r.total}`);

// 4. genuinely empty conversation
r = counts.compute({ visibleTurns: 0, totalTurns: 0, countState: "complete" });
check("4. true empty chat may show 0 / 0", r.hasData && r.visible === 0 && r.total === 0, `${r.visible}/${r.total}`);

// counting / partial / error states
r = counts.compute({ visibleTurns: 2, totalTurns: 0, countState: "counting" });
check("5. counting -> total unknown", r.visible === 2 && r.total === null && r.totalKnown === false);
r = counts.compute({ visibleTurns: 2, totalTurns: 315, countState: "partial" });
check("5b. partial -> total not claimed", r.total === null && r.totalKnown === false);

// the live 2 / 5+ case: reasons
r = counts.compute({ visibleTurns: 2, totalTurns: 5, countState: "partial", countFailureReason: "pagination-contract-unknown" });
check("5b-i. unexplained partial keeps the total unknown", r.total === null);
r = counts.compute({ visibleTurns: 1, totalTurns: 5, countState: "partial", countFailureReason: "no-progress" });
check("5b-iv. no-progress shows exact total and pct",
  r.visible === 1 && r.total === 5 && r.pct === 20 && r.allLoaded === false, `${r.visible}/${r.total} ${r.pct}%`);
r = counts.compute({ visibleTurns: 1, totalTurns: 5, countState: "partial", countFailureReason: "empty-page" });
check("5b-v. empty-page shows exact total", r.total === 5 && r.pct === 20);
r = counts.compute({ visibleTurns: 2, totalTurns: null, countState: "error" });
check("5c. error -> total unknown", r.total === null && r.visible === 2);
r = counts.compute({ visibleTurns: 9, totalTurns: 9, countState: "complete" });
check("5d. fully loaded says so", r.allLoaded === true && r.pct === 100);
r = counts.compute({ visibleTurns: 2, totalTurns: 703, countState: "switching" });
check("6. chat switch -> no previous numbers", r.hasData === false && r.visible === null);

console.log("\n--- PART A2: estimates removed from popup and stats ---");
check("popup no longer renders a context meter",
  !/renderStats|contextStats|contextUsedPct|statContextUsed/.test(popupSrc));
check("popup has no message-count threshold",
  !/messageCountWarningThreshold|messageCountThreshold/.test(popupSrc));
check("content script no longer computes token/context estimates",
  !/computeContextUsage|computeMessageCountStatus|contextStats/.test(contentSrc));
check("content stats response carries no context payload",
  !/contextStats:/.test(contentSrc));
check("background defaults have no count threshold",
  !/messageCountWarningThreshold/.test(fs.readFileSync(path.join(root, "src/background/background.js"), "utf8")));

console.log("\n--- PART A3: popup is a launcher ---");
{
  const sent = [];
  const elements = {};
  const ids = [
    "headerVersion", "toggleEnabled", "toggleAutoScrollLoad", "toggleFloatingButton",
    "toggleOutline", "toggleSearch", "toggleLocalArchive",
    "messageLimit", "msgLimitDec", "msgLimitInc", "refreshBtn", "saveBar",
    "exportCurrentBtn", "openSettingsBtn", "launcherHint", "exportBackupBtn",
    "importBackupBtn", "importBackupFileInput", "langZh", "langEn"
  ];
  for (const id of ids) {
    elements[id] = {
      id, checked: false, value: "", textContent: "", style: {}, attrs: {},
      // The language buttons are read through dataset.lang, and every labelled
      // control can have its aria/title rewritten by the translation pass.
      dataset: id.startsWith("lang") ? { lang: id === "langEn" ? "en" : "zh-CN" } : {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attrs[name] = value; },
      listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      click() { (this.listeners.click || []).forEach((f) => f({ target: this })); }
    };
  }
  const sets = [];
  const ctx = {
    document: {
      addEventListener(_event, handler) { handler(); },
      getElementById(id) { return elements[id] || null; },
      // The dictionary's popup pass walks [data-i18n]; an empty result is the
      // honest stand-in for markup this stub does not build.
      querySelectorAll() { return []; },
      documentElement: { setAttribute() {} },
      title: "",
      createElement() { return { style: {}, click() {}, remove() {} }; },
      body: { appendChild() {} }
    },
    window: { close() {} },
    Blob: function () {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.0.0" }), lastError: null },
      storage: { local: {
        get(key, callback) { callback(typeof key === "object" ? key : {}); },
        getKeys: () => Promise.resolve([]),
        set(obj) { sets.push(obj); }
      } },
      tabs: {
        query(_q, callback) { callback([{ id: 1, url: "https://chatgpt.com/c/test" }]); },
        // Real chrome.tabs.sendMessage returns a Promise, and the popup chains
        // .catch() onto it - a bare stub would break the save path.
        sendMessage(_id, message, callback) { sent.push(message); if (callback) callback({ ok: true }); return Promise.resolve({ ok: true }); }
      }
    },
    alert() {}, console
  };
  vm.createContext(ctx);
  vm.runInContext(`${I18N_BOOT}\n${popupSrc}`, ctx);
  elements.openSettingsBtn.click();
  const opened = sent.some((m) => m && m.type === "QELVYNOX_OPEN_SETTINGS");
  check("popup's main button asks the tab to open the settings modal", opened,
    sent.map((m) => m && m.type).join(","));
  elements.exportCurrentBtn.click();
  check("popup export shortcut still targets the existing handler",
    sent.some((m) => m && m.type === "exportChat"));

  // Any quick switch write must carry the language through, or saving a toggle
  // would silently reset the interface to the default.
  (elements.toggleEnabled.listeners.change || []).forEach((fn) => fn());
  const saved = sets.map((s) => s.qelvynox_settings).filter(Boolean).pop();
  check("a popup switch write keeps the language setting instead of dropping it",
    !!saved && saved.language === "zh-CN" && saved.enableFolders === undefined,
    saved ? `language=${saved.language}` : "no write captured");
}

console.log("\n--- PART B: temporary chat ---");

// 8. detection
const temp = makeContent({ href: "https://chatgpt.com/?temporary-chat=true", domUserTurns: 18, title: "ChatGPT" });
check("8. ?temporary-chat=true detected", temp.isTemporaryChat() === true);
const normal = makeContent({ href: "https://chatgpt.com/c/aaaa-bbbb", domUserTurns: 4, title: "My chat - ChatGPT" });
check("8b. normal chat not flagged temporary", normal.isTemporaryChat() === false);
const tricky = makeContent({ href: "https://chatgpt.com/c/x?temporary-chat=false", domUserTurns: 1, title: "x" });
check("8c. temporary-chat=false not flagged", tricky.isTemporaryChat() === false);

// 9. export without conversationId
check("9. temporary chat has no conversationId", temp.getConversationId() === null);
let exportOk = true, exportErr = "";
try {
  const t = temp.cleanTitle();
  const f = temp.sanitizeFilename(t);
  check("10. filename fallback without title", /^ChatGPT-Temporary-\d{4}-\d{2}-\d{2}-\d{4}$/.test(f), f);
} catch (e) { exportOk = false; exportErr = e.message; }
check("9b. export path does not crash without conversationId", exportOk, exportErr);

check("10b. normal chat keeps its real title", normal.cleanTitle() === "My chat", normal.cleanTitle());

// 12. local-only counter semantics
check("12. DOM turn count available for temporary chat", temp.countDomUserTurns() === 18);
r = counts.compute({ visibleTurns: 2, totalTurns: 18, countState: "local-only" });
check("12b. temporary renders 2 / 18", r.visible === 2 && r.total === 18 && r.pct === 11, `${r.visible}/${r.total}`);
check("12c. a local-only total is still a real number, never a percentage claim",
  r.allLoaded === false);

// scope identity isolation
const scopeSrc = `
${grab("getConversationId", contentSrc)}
${grab("isTemporaryChat", contentSrc)}
let temporarySessionId = null;
${grab("getStatsScopeId", contentSrc)}
globalThis.scope = () => getStatsScopeId();
globalThis.resetTemp = () => { temporarySessionId = null; };
`;
function scopeCtx(href) {
  const ctx = { window: { location: { href, pathname: new URL(href).pathname } }, URL, Date, Math, String, console };
  vm.createContext(ctx); vm.runInContext(scopeSrc, ctx); return ctx;
}
const s1 = scopeCtx("https://chatgpt.com/?temporary-chat=true");
const idA = s1.scope();
s1.resetTemp();
const idB = s1.scope();
check("7. two temporary chats get different scope ids", idA !== idB, `${idA} vs ${idB}`);
check("7b. temporary scope id is namespaced", idA.startsWith("temporary:"), idA);
const s2 = scopeCtx("https://chatgpt.com/c/real-id-123");
check("7c. normal chat scope = conversation id", s2.scope() === "real-id-123", s2.scope());

console.log("\n--- PART C: top-bar Export button ---");

/* Tiny DOM good enough for the injector's selector/insert logic. */
function makeDom({ withShare = true, withUserTurn = true, shareAttr = 'data-testid="share-chat-button"' } = {}) {
  let idSeq = 0;
  const mk = (tag, attrs = {}) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, attrs,
      id: attrs.id || "", className: attrs.class || "", textContent: attrs.text || "",
      innerHTML: "", listeners: {}, _uid: ++idSeq,
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentNode = el;
        const i = el.children.indexOf(ref);
        el.children.splice(i === -1 ? el.children.length : i, 0, c);
        return c;
      },
      remove() {
        if (!el.parentNode) return;
        const i = el.parentNode.children.indexOf(el);
        if (i !== -1) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      },
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k]; },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      click() { (el.listeners.click || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {} })); },
      closest() { return null; },
      querySelector() { return null; }
    };
    return el;
  };

  const all = [];
  const root = mk("body");
  const header = mk("header");
  root.appendChild(header);
  all.push(header);
  let share = null;
  if (withShare) {
    share = mk("button", { [shareAttr.split("=")[0]]: shareAttr.split("=")[1].replace(/"/g, ""), text: "Share" });
    header.appendChild(share);
    all.push(share);
  }
  if (withUserTurn) {
    const turn = mk("div", { "data-message-author-role": "user" });
    root.appendChild(turn);
    all.push(turn);
  }

  const walk = (n, out = []) => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
  const matches = (el, sel) => {
    if (sel.startsWith("#")) return el.id === sel.slice(1);
    const attr = /^\[([^\]=*]+)(?:\*?=)?"?([^"\]]*)"?(?:\s+i)?\]$/.exec(sel);
    if (attr) {
      const v = el.attrs[attr[1]];
      if (v === undefined) return false;
      return attr[2] === "" || (sel.includes("*=") ? String(v).toLowerCase().includes(attr[2].toLowerCase()) : v === attr[2]);
    }
    const tagAttr = /^(\w+)\[([^\]*=]+)\*?="?([^"\]]*)"?(?:\s+i)?\]$/.exec(sel);
    if (tagAttr) {
      return el.tagName === tagAttr[1].toUpperCase() &&
        String(el.attrs[tagAttr[2]] ?? "").toLowerCase().includes(tagAttr[3].toLowerCase());
    }
    return false;
  };

  const document = {
    body: root,
    getElementById: (id) => walk(root).find((n) => n.id === id) || null,
    querySelector: (sel) => {
      for (const part of sel.split(",").map((s) => s.trim())) {
        const hit = walk(root).find((n) => matches(n, part) || (part === "header" && n.tagName === "HEADER"));
        if (hit) return hit;
      }
      return null;
    },
    querySelectorAll: (sel) => walk(root).filter((n) => sel.split(",").some((p) => matches(n, p.trim()))),
    createElement: (t) => mk(t),
    head: mk("head")
  };
  return { document, root, header, share, walk };
}

function makeInjector(dom) {
  let exportCalls = 0;
  const ctx = {
    document: dom.document,
    appSettings: { enabled: true },
    // The top-bar label comes from the dictionary and is escaped on the way
    // into innerHTML, like every other interpolated string.
    esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]),
    openExportModal: () => { exportCalls++; },
    console
  };
  vm.createContext(ctx);
  vm.runInContext([
    I18N_BOOT,
    'const TOPBAR_EXPORT_ID = "qelvynox-export-topbar";',
    grab("findShareButton", contentSrc),
    grab("findTopbarFallbackContainer", contentSrc),
    grab("buildTopbarExportButton", contentSrc),
    grab("injectTopbarExportButton", contentSrc),
    "globalThis.inject = injectTopbarExportButton;"
  ].join("\n"), ctx);
  return { inject: () => ctx.inject(), exportCalls: () => exportCalls, ctx };
}

// 9. Share present -> Export inserted immediately before it
let dom = makeDom();
let inj = makeInjector(dom);
inj.inject();
let btn = dom.document.getElementById("qelvynox-export-topbar");
check("9. Export button injected when Share exists", !!btn);
check("9b. placed as [Export][Share] in Share's container",
  !!btn && btn.parentNode === dom.share.parentNode &&
  dom.header.children.indexOf(btn) < dom.header.children.indexOf(dom.share),
  btn ? `idx ${dom.header.children.indexOf(btn)} vs share ${dom.header.children.indexOf(dom.share)}` : "n/a");

const zhDom = makeDom({ shareAttr: 'aria-label="分享对话"' });
zhDom.share.textContent = "分享";
makeInjector(zhDom).inject();
const zhBtn = zhDom.document.getElementById("qelvynox-export-topbar");
check("9c. export button finds the Chinese Share control",
  !!zhBtn && zhBtn.parentNode === zhDom.share.parentNode &&
  zhDom.header.children.indexOf(zhBtn) < zhDom.header.children.indexOf(zhDom.share));

// 10. re-render -> no duplicates
inj.inject(); inj.inject(); inj.inject();
const dupes = dom.walk(dom.root).filter((n) => n.id === "qelvynox-export-topbar").length;
check("10. repeated injection never duplicates the button", dupes === 1, `found ${dupes}`);

// 13. Share missing -> falls back to header container, no crash
let dom2 = makeDom({ withShare: false });
let inj2 = makeInjector(dom2);
let threw = "";
try { inj2.inject(); } catch (e) { threw = e.message; }
check("13. no crash when Share is absent", !threw, threw);
const fb = dom2.document.getElementById("qelvynox-export-topbar");
check("13b. falls back to a top-bar container (not over messages)", !!fb && fb.parentNode === dom2.header);

// 12. temporary chat (no Share, has turns) -> button still appears
check("12d. button present in temporary-chat-like DOM", !!fb);

// 11. SPA switch: button removed by React re-render -> re-injected
fb.remove();
inj2.inject();
check("11. re-injected after being torn out by a re-render",
  !!dom2.document.getElementById("qelvynox-export-topbar"));

// empty chat -> stays out of the way
let dom3 = makeDom({ withUserTurn: false });
let inj3 = makeInjector(dom3);
inj3.inject();
check("13c. no button in an empty chat", !dom3.document.getElementById("qelvynox-export-topbar"));

// 14. click -> calls existing export path exactly once
dom.document.getElementById("qelvynox-export-topbar").click();
check("14. click invokes existing openExportModal exactly once", inj.exportCalls() === 1, `${inj.exportCalls()}`);

// 15. counter partial -> export button unaffected (no counter coupling at all)
const injectorSrc = grab("injectTopbarExportButton", contentSrc) + grab("buildTopbarExportButton", contentSrc);
check("15. Export button code never reads counter state",
  !/lastStatus|countState|totalTurns|countComplete/.test(injectorSrc));

const failed = results.filter((x) => !x.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
