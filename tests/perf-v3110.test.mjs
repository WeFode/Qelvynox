/**
 * v3.11.0 smoothness / main-thread hygiene.
 *
 * The page must be able to go idle: our own DOM writes must not re-trigger
 * our observer, per-tick work must not force layout, and gesture handlers
 * must not re-query the whole document on every event.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(REPO, "src/page/mainWorld.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/** Extract a function's source (same helper as export.test.mjs). */
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

/* ---------------- 1. Observer ignores Qelvynox's own DOM writes ---------------- */
console.log("--- PART 1: MutationObserver self-mutation filter ---");

{
  const ctx = { OWNED_ATTR: "data-qelvynox", OWNED_SELECTOR: "[data-qelvynox]" };
  vm.createContext(ctx);
  vm.runInContext(grab("isOwnMutation", contentSrc) + "\nglobalThis.own = isOwnMutation;", ctx);

  const owned = { nodeType: 1, hasAttribute: (a) => a === "data-qelvynox" };
  const foreign = { nodeType: 1, hasAttribute: () => false };
  const textNode = { nodeType: 3 };
  const insideOurs = { nodeType: 1, closest: () => ({}) };
  const chatgptEl = { nodeType: 1, closest: () => null };

  check("mutation inside a Qelvynox node is ignored",
    ctx.own({ target: insideOurs, addedNodes: [textNode], removedNodes: [] }) === true);
  check("appending a Qelvynox node to body is ignored",
    ctx.own({ target: chatgptEl, addedNodes: [owned], removedNodes: [] }) === true);
  check("removing a Qelvynox node is ignored",
    ctx.own({ target: chatgptEl, addedNodes: [], removedNodes: [owned] }) === true);
  check("ChatGPT adding a message is NOT ignored",
    ctx.own({ target: chatgptEl, addedNodes: [foreign], removedNodes: [] }) === false);
  check("mixed batch (ours + ChatGPT's) is NOT ignored",
    ctx.own({ target: chatgptEl, addedNodes: [owned, foreign], removedNodes: [] }) === false);
  check("attribute-only record on a ChatGPT node is NOT ignored",
    ctx.own({ target: chatgptEl, addedNodes: [], removedNodes: [] }) === false);
}

check("observer callback filters records through isOwnMutation before scheduling",
  contentSrc.includes("if (!isOwnMutation(records[i])) { relevant = true; break; }") &&
  contentSrc.includes("if (!relevant) return;"));

check("streaming detection moved out of the raw observer callback into the debounced tick",
  contentSrc.includes("function runObserverTick()") &&
  contentSrc.includes("const isStreaming = isStreamingNow();") &&
  !/new MutationObserver\(\(records\) => \{[^}]*isStreamingNow/.test(contentSrc));

check("background tabs skip the render pass and catch up on visibilitychange",
  contentSrc.includes("if (document.hidden) {") &&
  contentSrc.includes("tickPendingWhileHidden = true;") &&
  contentSrc.includes('document.addEventListener("visibilitychange"'));

const ownedIds = [
  "qelvynox-floating-pill", "qelvynox-scroll-loader", "qelvynox-scroll-sentinel",
  "qelvynox-floating-dock", "qelvynox-outline-popover", "qelvynox-bookmarks-popover",
  "qelvynox-search-overlay", "qelvynox-export-modal"
];
for (const id of ownedIds) {
  const re = new RegExp(`markOwned\\(document\\.createElement\\("(?:div|button|style)"\\)\\);\\s*\\n\\s*\\w+\\.id = "${id}"`);
  check(`#${id} is marked as Qelvynox-owned`, re.test(contentSrc));
}
check("toast, styles, bookmark buttons and top-bar Export are marked owned",
  contentSrc.includes('const t = markOwned(document.createElement("div"));\n    t.className = "qelvynox-toast";') &&
  contentSrc.includes('const style = markOwned(document.createElement("style"));') &&
  contentSrc.includes('const btn = markOwned(document.createElement("button"));\n      btn.className = `qelvynox-bookmark-btn') &&
  contentSrc.includes('try { btn.setAttribute("data-qelvynox", "1"); } catch {}'));

/* ---------------- 2. Hidden-turn count cache ---------------- */
console.log("\n--- PART 2: hidden-turn count cache ---");

{
  let queries = 0;
  // No conversation scope resolved: the count falls back to the document, which
  // is what a single-chat page does.
  const ctx = {
    document: { querySelectorAll: () => { queries++; return { length: 7 }; } },
    getConversationRoot: () => null
  };
  vm.createContext(ctx);
  vm.runInContext(
    "let domHiddenCountCache = null;\n" +
    grab("invalidateHiddenCount", contentSrc) + "\n" +
    grab("getDomHiddenCount", contentSrc) + "\n" +
    "globalThis.get = getDomHiddenCount; globalThis.inv = invalidateHiddenCount;",
    ctx
  );
  check("first read queries the DOM", ctx.get() === 7 && queries === 1, `${queries}`);
  ctx.get(); ctx.get(); ctx.get();
  check("repeated reads do not re-query", queries === 1, `${queries}`);
  ctx.inv();
  ctx.get();
  check("invalidation forces exactly one fresh query", queries === 2, `${queries}`);
}

check("no hot path still counts hidden turns with a live querySelectorAll",
  (contentSrc.match(/querySelectorAll\("\.qelvynox-dom-hidden"\)/g) || []).length === 2);

check("gesture handlers (wheel/touch/key) coalesce into one check per frame",
  contentSrc.includes("function scheduleGestureCheck()") &&
  contentSrc.includes("if (e.deltaY < 0) {") &&
  contentSrc.includes("markUserScrollIntent();") &&
  contentSrc.includes("requestAnimationFrame(run)"));

check("wheel listener is registered once (window only, no duplicate on document)",
  !contentSrc.includes('document.addEventListener("wheel"') &&
  !contentSrc.includes('document.removeEventListener("wheel"'));

/* ---------------- 3. hide/show write only on change ---------------- */
console.log("\n--- PART 3: idempotent hide/show ---");

{
  let inv = 0;
  const ctx = { invalidateHiddenCount: () => { inv++; } };
  vm.createContext(ctx);
  vm.runInContext(grab("hideTurnEl", contentSrc) + "\n" + grab("showTurnEl", contentSrc) +
    "\nglobalThis.hide = hideTurnEl; globalThis.show = showTurnEl;", ctx);

  const mk = () => {
    const classes = new Set();
    const style = { display: "", setProperty(k, v) { style[k] = v; }, removeProperty(k) { style[k] = ""; } };
    let writes = 0;
    return {
      writes: () => writes,
      classList: {
        add: (c) => { writes++; classes.add(c); },
        remove: (c) => { writes++; classes.delete(c); },
        contains: (c) => classes.has(c)
      },
      style
    };
  };

  const el = mk();
  ctx.hide(el); ctx.hide(el); ctx.hide(el);
  check("hiding an already-hidden turn writes nothing", el.writes() === 1 && inv === 1, `writes=${el.writes()} inv=${inv}`);
  ctx.show(el); ctx.show(el);
  check("showing an already-visible turn writes nothing", el.writes() === 2 && inv === 2, `writes=${el.writes()} inv=${inv}`);
  const fresh = mk();
  ctx.show(fresh);
  check("show on a never-hidden turn is a no-op", fresh.writes() === 0 && inv === 2);
}

/* ---------------- 4. Context meter removed (it was the layout-heavy path) ---------------- */
console.log("\n--- PART 4: context meter removed ---");

{
  // The meter used to walk every turn reading text on each observer tick; it
  // is gone in 3.16.0, so the whole class of cost disappears with it.
  check("no token/context estimator remains in the content script",
    !/function computeContextUsage/.test(contentSrc) &&
    !/contextStats|estimatedTokens|contextUsedPct/.test(contentSrc));
  check("no message-count estimator remains",
    !/function computeMessageCountStatus/.test(contentSrc) &&
    !/messageCountWarningThreshold/.test(contentSrc));
  const dockSrc = contentSrc.slice(
    contentSrc.indexOf("function renderFloatingDock()"),
    contentSrc.indexOf("function updateOutlineBadge()")
  );
  check("the dock render reads no text and forces no layout",
    !/innerText|textContent|getComputedStyle/.test(dockSrc), dockSrc.length + " chars");
}

/* ---------------- 5. Top-bar Export re-check is throttled ---------------- */
console.log("\n--- PART 5: top-bar Export placement re-check ---");

check("existing Export button skips the Share lookup within the throttle window",
  contentSrc.includes("now - (injectTopbarExportButton.lastCheck || 0) < 2000) return;"));

/* ---------------- 6. The sidebar organizer is gone ---------------- */
console.log("\n--- PART 6: the removed folder feature stays removed ---");

check("no folder render pass, storage key, switch or signature is left in the page script",
  !contentSrc.includes("renderSidebarFolders") &&
  !contentSrc.includes("qelvynox-sidebar-folders") &&
  !contentSrc.includes("enableFolders") &&
  !contentSrc.includes("lastFoldersSignature") &&
  !contentSrc.includes("openFolderIds"));
check("the sidebar folder rows and their icons are gone with the feature",
  !contentSrc.includes("qelvynox-folder-arrow") &&
  !contentSrc.includes("qelvynox-add-folder-btn"));

/* ---------------- 7. Scroll container cache ---------------- */
console.log("\n--- PART 7: scroll container cache ---");

{
  let lookups = 0;
  const real = { isConnected: true, id: "real" };
  const ctx = {
    cachedScrollContainer: null,
    findChatScrollContainer: () => { lookups++; return { el: real, cacheable: true }; }
  };
  vm.createContext(ctx);
  vm.runInContext(grab("getChatScrollContainer", contentSrc) + "\nglobalThis.get = getChatScrollContainer;", ctx);
  ctx.get(); ctx.get(); ctx.get();
  check("connected container is resolved once and reused", lookups === 1 && ctx.get() === real, `${lookups}`);
  real.isConnected = false;
  ctx.get();
  check("a detached container (React remount) is re-resolved", lookups === 2, `${lookups}`);
}

{
  let lookups = 0;
  const ctx = {
    cachedScrollContainer: null,
    findChatScrollContainer: () => { lookups++; return { el: { isConnected: true }, cacheable: false }; }
  };
  vm.createContext(ctx);
  vm.runInContext(grab("getChatScrollContainer", contentSrc) + "\nglobalThis.get = getChatScrollContainer;", ctx);
  ctx.get(); ctx.get();
  check("generic fallbacks (main/documentElement) are never cached", lookups === 2, `${lookups}`);
}

/* ---------------- 8. mainWorld: fetch wrapper overhead ---------------- */
console.log("\n--- PART 8: mainWorld fetch wrapper ---");

{
  let gets = 0;
  let now = 1000;
  const ctx = {
    STORAGE_CONFIG_KEY: "qelvynox_config",
    DEFAULT_CONFIG: { enabled: true, messageLimit: 15, enableAutoScrollLoad: false, liveAutoTrim: false },
    CONFIG_CACHE_TTL_MS: 1000,
    cachedConfig: null,
    cachedConfigAt: 0,
    localStorage: { getItem: () => { gets++; return JSON.stringify({ enabled: true, messageLimit: 3 }); } },
    Date: { now: () => now },
    JSON, Math
  };
  vm.createContext(ctx);
  vm.runInContext(grab("getActiveConfig", mainSrc) + "\nglobalThis.cfg = getActiveConfig;", ctx);
  const a = ctx.cfg(); ctx.cfg(); ctx.cfg();
  check("config is parsed once per TTL window", gets === 1 && a.messageLimit === 3, `${gets}`);
  now += 1500;
  ctx.cfg();
  check("config is re-read after the TTL expires", gets === 2, `${gets}`);
}

{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab("extractMessagesFromMapping", mainSrc) + "\nglobalThis.ex = extractMessagesFromMapping;", ctx);
  const mapping = {
    root: { id: "root", parent: null, children: ["a"] },
    a: { id: "a", parent: "root", message: { id: "a" } },
    b: { id: "b", parent: "a", message: { id: "b" } },
    c: { id: "c", parent: "b", message: { id: "c" } }
  };
  const out = ctx.ex(mapping, "c").map((m) => m.id).join(",");
  check("mapping chain is still oldest-first after the push/reverse change", out === "a,b,c", out);
  check("mapping walk no longer uses quadratic unshift", !/messages\.unshift\(/.test(grab("extractMessagesFromMapping", mainSrc)));
}

{
  const ctx = { Headers, Response, Object, JSON };
  vm.createContext(ctx);
  vm.runInContext(grab("buildJsonResponse", mainSrc) + "\nglobalThis.build = buildJsonResponse;", ctx);
  const original = new Response("{}", {
    status: 200,
    headers: { "content-length": "2", "content-encoding": "br", "x-keep": "yes", "content-type": "text/plain" }
  });
  const built = ctx.build(original, { ok: 1, messages: [] });
  const body = await built.text();
  check("rewritten response drops stale transfer headers instead of setting them to \"undefined\"",
    built.headers.get("content-encoding") === null &&
    built.headers.get("content-length") !== "undefined" &&
    built.headers.get("content-encoding") !== "undefined");
  check("rewritten response keeps other headers and sets JSON content-type",
    built.headers.get("x-keep") === "yes" && /application\/json/.test(built.headers.get("content-type") || ""));
  check("rewritten response body is the new JSON", body === JSON.stringify({ ok: 1, messages: [] }), body);
  check("both interceptor branches use the shared builder",
    (mainSrc.match(/return buildJsonResponse\(response, data\);/g) || []).length === 2 &&
    !mainSrc.includes('"content-length": undefined'));
}

const totalPassed = results.filter((r) => r.pass).length;
console.log(`\n================ ${totalPassed}/${results.length} passed ================`);
process.exit(totalPassed === results.length ? 0 : 1);
