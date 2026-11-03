/**
 * One conversation per pane.
 *
 * The bug this suite exists for: ChatGPT can keep a second conversation mounted
 * beside the current one (compare / split view), and every turn marker repeats
 * per pane. Turn discovery was document-wide, so the navigator indexed both
 * chats and kept growing as the user opened more conversations, and the speed
 * limiter folded turns in the pane the reader was not looking at - which is what
 * made the page appear to split two conversations onto one screen.
 *
 * A small tree-accurate DOM double is used on purpose: the scoping rule is
 * structural, so it has to be tested against real containment, not stubs that
 * answer "yes" to everything.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = src.indexOf("(", start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  i = src.indexOf("{", i);
  let braces = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") braces++;
    else if (src[i] === "}" && --braces === 0) break;
  }
  return src.slice(start, i + 1);
}

/* ---------------- a tree-accurate DOM double ---------------- */

const ATTR_SEL = /^\[([\w-]+)(?:([~^|$*]?=)"([^"]*)")?\]$/;

function matchesSimple(node, selector) {
  const sel = selector.trim();
  // Descendant prefixes ("main [role=...]") are ignored: the last simple
  // selector is what distinguishes the nodes this suite builds.
  const last = sel.split(/\s+/).filter(Boolean).pop() || "";
  if (last.startsWith(".")) return node.classSet.has(last.slice(1));
  if (!last.startsWith("[")) return node.tagName === last.toUpperCase();
  const m = ATTR_SEL.exec(last);
  if (!m) return false;
  const value = node.getAttribute(m[1]);
  if (value === null) return false;
  if (!m[2]) return true;
  if (m[2] === "=") return value === m[3];
  if (m[2] === "^=") return value.startsWith(m[3]);
  if (m[2] === "$=") return value.endsWith(m[3]);
  if (m[2] === "*=") return value.includes(m[3]);
  return false;
}

function el(tag = "div", attrs = {}, rect = null) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attrs: { ...attrs },
    children: [],
    parentElement: null,
    rect,
    isConnected: true,
    classSet: new Set(String(attrs.class || "").split(" ").filter(Boolean)),
    text: attrs.text || "",
    getAttribute: (name) => (name in node.attrs ? node.attrs[name] : null),
    setAttribute: (name, value) => { node.attrs[name] = String(value); },
    getBoundingClientRect: () => node.rect ||
      { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  };
  node.descendants = () => {
    const out = [];
    (function walk(n) { n.children.forEach((c) => { out.push(c); walk(c); }); })(node);
    return out;
  };
  node.contains = (other) => !!other && (other === node || node.descendants().includes(other));
  node.matches = (sel) => String(sel).split(",").some((part) => matchesSimple(node, part));
  node.closest = (sel) => {
    let n = node;
    while (n) { if (n.matches(sel)) return n; n = n.parentElement; }
    return null;
  };
  node.querySelectorAll = (sel) => node.descendants().filter((d) => d.matches(sel));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.appendChild = (child) => { child.parentElement = node; node.children.push(child); return child; };
  node.classList = {
    add: (c) => node.classSet.add(c),
    remove: (c) => node.classSet.delete(c),
    contains: (c) => node.classSet.has(c),
    toggle: (c, on) => { if (on) node.classSet.add(c); else node.classSet.delete(c); }
  };
  node.style = {
    display: "", height: "",
    setProperty(name, value) { this[name] = value; },
    removeProperty(name) { this[name] = ""; }
  };
  return node;
}

const VIEWPORT = { width: 1200, height: 900 };

function visibleRect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** pane > rail > wrapper > [data-turn-key] > user bubble, like the app renderer. */
function buildConversation(listRoot, keys, textPrefix) {
  return keys.map((key, i) => {
    const wrapper = el("div");
    const turn = el("div", { "data-turn-key": key });
    turn.appendChild(el("div", { "data-user-message-bubble": "true", text: `${textPrefix} ${i + 1}` }));
    wrapper.appendChild(turn);
    listRoot.appendChild(wrapper);
    return turn;
  });
}

function buildPage({ secondPane, secondVisible = false }) {
  const body = el("body", {}, visibleRect(0, 0, VIEWPORT.width, VIEWPORT.height));
  const main = body.appendChild(el("main", {}, visibleRect(0, 0, VIEWPORT.width, VIEWPORT.height)));
  const row = main.appendChild(el("div", { class: "flex-row" }, visibleRect(0, 0, VIEWPORT.width, VIEWPORT.height)));

  const paneA = row.appendChild(el("div", { class: "thread-scroll-container" }, visibleRect(0, 0, 600, 900)));
  const railA = paneA.appendChild(el("div", { class: "relative shrink-0" }));
  const turnsA = buildConversation(railA, ["turn-1", "turn-2", "turn-3"], "问题");

  let paneB = null;
  let railB = null;
  let turnsB = [];
  if (secondPane) {
    // A collapsed rect is how a pane ChatGPT keeps mounted but hidden reads.
    paneB = row.appendChild(el("div", { class: "thread-scroll-container" },
      secondVisible ? visibleRect(600, 0, 600, 900) : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }));
    railB = paneB.appendChild(el("div", { class: "relative shrink-0" }));
    turnsB = buildConversation(railB, ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"], "另一个对话");
  }

  const document2 = {
    body,
    documentElement: body,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel)
  };
  return { document: document2, body, main, row, paneA, railA, turnsA, paneB, railB, turnsB };
}

function runOn(page, settings = { enabled: true, messageLimit: 1, liveAutoTrim: false }) {
  const ctx = {
    document: page.document,
    window: { innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height },
    CHATGPT_APP_TURN_SELECTOR: "[data-turn-key]",
    USER_MESSAGE_SELECTOR: '[data-message-author-role="user"], [data-user-message-bubble], [data-content-search-unit-key$=":user"]',
    ASSISTANT_MESSAGE_SELECTOR: '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"], [data-content-search-unit-key$=":assistant"]',
    appSettings: { ...settings },
    manuallyUnhiddenTurnsCount: 0,
    initialEnforcementDone: false,
    syncAppVirtualizerRails() {},
    updateOutlineBadge() {},
    Array, Math, Set, Number, String, Boolean, JSON, console
  };
  vm.createContext(ctx);
  vm.runInContext([
    // The module-level state these functions close over.
    "let domHiddenCountCache = null;",
    "let paneCache = null;",
    grab("isUserTurn"),
    grab("isAppTurn"),
    grab("getTurnForMessageElement"),
    grab("getMessageElements"),
    grab("getUserMessageElements"),
    grab("getTurnItemContainer"),
    grab("hideTurnEl"),
    grab("showTurnEl"),
    grab("hideAppTurn"),
    grab("invalidateHiddenCount"),
    grab("getDomHiddenCount"),
    grab("collectTurnNodes"),
    grab("deepestTurnContainer"),
    grab("childrenWithTurns"),
    grab("findPaneGroups"),
    grab("visibleAreaOf"),
    grab("getConversationTurns"),
    grab("getConversationRoot"),
    grab("resetConversationPane"),
    grab("getAllConversationTurns"),
    grab("enforceDomTurnLimit"),
    "globalThis.api = { getAllConversationTurns, getUserMessageElements, getConversationRoot, resetConversationPane, enforceDomTurnLimit, getDomHiddenCount, invalidateHiddenCount };"
  ].join("\n"), ctx);
  return ctx.api;
}

/* ---------------- 1. two conversations mounted at once ---------------- */
console.log("--- PART 1: a second pane must not join the index ---");

{
  const page = buildPage({ secondPane: true, secondVisible: false });
  const api = runOn(page);
  const turns = api.getAllConversationTurns();
  check("turn discovery is scoped to the conversation on screen",
    turns.length === 3, `turns=${turns.length}`);
  check("the navigator's source list is one chat, not the sum of every pane",
    api.getUserMessageElements().length === 3,
    `questions=${api.getUserMessageElements().length}`);
  check("the scope is the visible pane itself",
    api.getConversationRoot() === page.paneA);
  check("opening another conversation replaces the index instead of growing it",
    api.getAllConversationTurns().every((t) => page.turnsA.includes(t)));
}

/* ---------------- 2. the limiter must not touch the other pane ---------- */
console.log("\n--- PART 2: folding turns stays inside the active conversation ---");

{
  const page = buildPage({ secondPane: true, secondVisible: false });
  const api = runOn(page);
  api.invalidateHiddenCount();
  api.enforceDomTurnLimit({ force: true });

  const hiddenInA = page.turnsA.filter((t) => t.classList.contains("qelvynox-dom-hidden") ||
    t.parentElement.classList.contains("qelvynox-dom-hidden")).length;
  const hiddenInB = page.turnsB.filter((t) => t.classList.contains("qelvynox-dom-hidden") ||
    t.parentElement.classList.contains("qelvynox-dom-hidden")).length;

  check("the active chat is trimmed to the limit", hiddenInA === 2, `hidden=${hiddenInA}`);
  check("the other conversation is left exactly as ChatGPT rendered it",
    hiddenInB === 0, `hidden in the inactive pane=${hiddenInB}`);
  check("the folded-turn count only reports this conversation",
    api.getDomHiddenCount() === 2, `count=${api.getDomHiddenCount()}`);
}

/* ---------------- 3. switching to the other pane ---------------------- */
console.log("\n--- PART 3: the reader moves to the other conversation ---");

{
  const page = buildPage({ secondPane: true, secondVisible: false });
  const api = runOn(page);
  check("before the switch the first chat is the scope",
    api.getAllConversationTurns().length === 3);

  // ChatGPT shows the second conversation and collapses the first one.
  page.paneA.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  page.paneB.rect = visibleRect(0, 0, 1200, 900);
  // No navigation reset: visibility alone can change with the same DOM.

  const nowTurns = api.getAllConversationTurns();
  check("after the switch the index is the other conversation only",
    nowTurns.length === 5 && nowTurns.every((t) => page.turnsB.includes(t)),
    `turns=${nowTurns.length}`);
  check("the questions shown are the ones of the conversation in view",
    api.getUserMessageElements().length === 5);
  check("the scope moved with the reader", api.getConversationRoot() === page.paneB);
}

/* A one-turn conversation next to another one-turn conversation. */
{
  const page = buildPage({ secondPane: true, secondVisible: false });
  page.railA.children.splice(1);
  page.railB.children.splice(1);
  const api = runOn(page);
  check("one-turn panes do not get merged", api.getUserMessageElements().length === 1);
  page.paneA.rect = visibleRect(0, 0, 0, 0);
  page.paneB.rect = visibleRect(0, 0, 1200, 900);
  check("one-turn pane switch follows visibility without a reset",
    api.getAllConversationTurns()[0] === page.turnsB[0]);
}

/* React can replace a middle turn without changing the first, last or count. */
{
  const page = buildPage({ secondPane: false });
  const api = runOn(page);
  api.getAllConversationTurns();
  const replacement = el("div");
  const newTurn = el("div", { "data-turn-key": "replacement" });
  newTurn.appendChild(el("div", { "data-user-message-bubble": "true", text: "新问题" }));
  replacement.appendChild(newTurn);
  replacement.parentElement = page.railA;
  page.railA.children[1] = replacement;
  check("replacing a middle turn invalidates the cache with the same count and endpoints",
    api.getAllConversationTurns()[1] === newTurn);
}

/* ---------------- 4. a single conversation is never mistaken ------------ */
console.log("\n--- PART 4: one conversation, any length, stays whole ---");

{
  const page = buildPage({ secondPane: false });
  const api = runOn(page);
  check("a short chat keeps all of its turns", api.getAllConversationTurns().length === 3);

  const long = buildPage({ secondPane: false });
  // Same shape, 12 turns: the rail has one child per turn, which must never be
  // read as twelve panes.
  const rail = long.turnsA[0].parentElement.parentElement;
  buildConversation(rail, Array.from({ length: 9 }, (_, i) => `turn-${i + 4}`), "问题");
  const longApi = runOn(long);
  check("a 12-turn chat is one conversation, not 12 panes",
    longApi.getAllConversationTurns().length === 12,
    `turns=${longApi.getAllConversationTurns().length}`);
  check("the scope of a single chat is the node holding every turn",
    longApi.getConversationRoot() === rail);
}

/* ---------------- 5. the rules that keep it honest -------------------- */
console.log("\n--- PART 5: wiring ---");

check("every turn reader goes through the scoped lookup",
  !/function (getUserMessageElements|countDomUserTurns|countHiddenUserTurns|getFirstVisibleConversationTurn|syncAppVirtualizerRails|collectRangesIn|renderOutlineList)\([\s\S]{0,400}?document\.querySelectorAll\(CHATGPT_APP_TURN_SELECTOR/.test(src) &&
  src.includes("function getAllConversationTurns() {\n    return getConversationTurns();"));
check("navigating to another chat drops the previous conversation's scope",
  src.includes("resetConversationPane();") &&
  /function checkNavigation\(\)[\s\S]*?resetConversationPane\(\);/.test(src));
check("a chat switch also un-pins the panels, so no button claims a missing panel",
  /function checkNavigation\(\)[\s\S]*?outlinePopover\.forceClose\(\);\s*bookmarksPopover\.forceClose\(\);/.test(src));
check("the hidden-turn count is read from the active conversation only",
  /function getDomHiddenCount\(\)[\s\S]*?const scope = root && typeof root\.querySelectorAll === "function" \? root : document;/.test(src));
check("the scroll container is resolved inside the active pane first",
  /function findChatScrollContainer\(\)[\s\S]*?const pane = getConversationRoot\(\);/.test(src));
check("cache validates all turn identities and never freezes multiple panes",
  src.includes("!paneCache.multiple") && src.includes("paneCache.all.every"));

const failed = results.filter((r) => !r.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
