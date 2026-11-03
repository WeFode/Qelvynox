/**
 * Qelvynox - Content Script & In-Page Productivity Suite
 * 100% Original, Clean Architecture
 */

(() => {
  const SETTINGS_KEY = "qelvynox_settings";
  const CONFIG_KEY = "qelvynox_config";
  const EXTRA_KEY = "qelvynox_extra_turns";
  const BOOKMARKS_PREFIX = "qelvynox_bookmarks_";
  const CACHED_STATS_KEY = "qelvynox_cached_stats";
  const SCROLL_RESTORE_KEY = "qelvynox_restore_scroll";

  // Qelvynox shipped first as TurboGPT, and the rename moved every identifier
  // with it. An existing install would otherwise open on default settings with
  // no bookmarks, so the old keys are copied forward once.
  // They are never deleted: chatgpt.com's localStorage is shared with the page
  // itself, so an older build still running in another profile keeps working.
  // The local archive is deliberately not copied - it is a cache that refills
  // itself from ChatGPT on the next visit, and moving hundreds of megabytes
  // through storage on first load would freeze the page for it.
  const LEGACY_PREFIX = "turbogpt_";

  function migrateLegacyKeys() {
    const renames = [
      [LEGACY_PREFIX + "config", CONFIG_KEY],
      [LEGACY_PREFIX + "extra_turns", EXTRA_KEY]
    ];
    try {
      const bmPrefix = LEGACY_PREFIX + "bookmarks_";
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(bmPrefix)) {
          renames.push([key, BOOKMARKS_PREFIX + key.slice(bmPrefix.length)]);
        }
      }
      // Collected first: writing inside the loop would shift the index that
      // localStorage.key() walks over.
      renames.forEach(([from, to]) => {
        const raw = localStorage.getItem(from);
        if (raw !== null && localStorage.getItem(to) === null) localStorage.setItem(to, raw);
      });
    } catch {}
  }

  migrateLegacyKeys();

  let appSettings = {
    // Default Chinese, and it stays the default even in an English browser:
    // the language is a user choice, not a locale sniff. `_locales/` handles
    // the browser's own extension UI.
    language: "zh-CN",
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
    disableNotifications: false
  };

  // Resolves once the stored settings are known (or after a short timeout),
  // so nothing that depends on a user switch - the local archive - runs on
  // defaults the user may have turned off.
  let resolveSettingsReady = null;
  const settingsReady = new Promise((resolve) => {
    resolveSettingsReady = resolve;
    setTimeout(resolve, 3000);
  });

  const STATUS_SESSION_KEY = "qelvynox_last_status";

  // Debug only. Ids/counts/state names - never message content or headers.
  const DEBUG_STATS = false;

  let lastStatus = {
    totalMessages: 0,
    renderedMessages: 0,
    hasOlderMessages: false,
    visibleTurns: 0,
    totalTurns: 0,
    countState: "idle",
    countComplete: false
  };
  // False until mainWorld has actually reported something. Without this, an
  // absent status is indistinguishable from a real empty conversation.
  let statusReceived = false;

  // ---------- Utilities ----------

  // Every string the user reads lives in src/shared/i18n.js under two keys
  // per language, so switching the language is a re-render rather than a
  // reload. The reference is taken once because the module is loaded before
  // this file in the same isolated world.
  const I18N = globalThis.QelvynoxI18n || null;
  const T = (key, vars) => (I18N ? I18N.t(key, vars) : key);
  const applyLanguage = () => {
    if (I18N) I18N.setLang(appSettings.language || I18N.fallback);
  };
  // Documents we generate carry the same language as the interface that made
  // them, so an English settings panel never writes a Chinese <html lang>.
  const htmlLang = () => (I18N ? I18N.lang() : "zh-CN");

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);

  const safeEscape = (val) =>
    (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(val) : String(val).replace(/["\\]/g, "\\$&"));

  function safeJsonParse(raw, fallback) {
    try {
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  function getConversationId() {
    const match = window.location.pathname.match(/\/c\/([^/]+)/);
    return match ? match[1] : null;
  }

  // A temporary chat has no /c/<id> and is not persisted server-side.
  function isTemporaryChat() {
    try {
      if (new URL(window.location.href).searchParams.get("temporary-chat") === "true") return true;
    } catch {}
    return false;
  }

  // Identity used to keep stats/reset boundaries correct in BOTH modes.
  // Temporary chats get a session-local identity so one temporary chat can
  // never inherit another one's numbers, and a normal chat can never inherit
  // a temporary one's.
  let temporarySessionId = null;
  function getStatsScopeId() {
    if (isTemporaryChat()) {
      if (!temporarySessionId) {
        temporarySessionId = `temporary:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      return temporarySessionId;
    }
    temporarySessionId = null;
    return getConversationId();
  }

  // ChatGPT's newer "app" renderer no longer exposes the old
  // data-testid/data-message-author-role markers.  It groups each exchange in
  // [data-turn-key], puts the user bubble under [data-user-message-bubble],
  // and labels search units with a :user/:assistant suffix.  Keep these
  // selectors in one compatibility layer so turn limiting, stats and the
  // navigator all agree about what a turn is.
  const CHATGPT_APP_TURN_SELECTOR = '[data-turn-key]';
  const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-user-message-bubble], [data-content-search-unit-key$=":user"]';
  const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"], [data-content-search-unit-key$=":assistant"]';

  function isUserTurn(turn) {
    if (!turn) return false;
    if (turn.getAttribute?.('data-message-author-role') === 'user') return true;
    if (turn.matches?.(USER_MESSAGE_SELECTOR)) return true;
    return !!turn.querySelector?.(USER_MESSAGE_SELECTOR);
  }

  function isAssistantTurn(turn) {
    if (!turn) return false;
    if (turn.getAttribute?.('data-message-author-role') === 'assistant') return true;
    if (turn.matches?.(ASSISTANT_MESSAGE_SELECTOR)) return true;
    return !!turn.querySelector?.(ASSISTANT_MESSAGE_SELECTOR);
  }

  function getTurnForMessageElement(el) {
    if (!el) return null;
    return el.closest?.(CHATGPT_APP_TURN_SELECTOR) ||
           el.closest?.('[data-testid^="conversation-turn"]') ||
           el.closest?.('[class*="conversation-turn"]') ||
           el.closest?.('article') ||
           el.closest?.('.qelvynox-dom-hidden') ||
           el;
  }

  function isAppTurn(turn) {
    return !!turn && (
      turn.matches?.(CHATGPT_APP_TURN_SELECTOR) ||
      turn.getAttribute?.("data-turn-key") != null
    );
  }

  function getMessageElements(selector) {
    const out = [];
    for (const turn of getAllConversationTurns()) {
      const el = turn.matches?.(selector) ? turn : turn.querySelector?.(selector);
      if (el && !out.includes(el)) out.push(el);
    }
    return out;
  }

  function getUserMessageElements() {
    return getMessageElements(USER_MESSAGE_SELECTOR);
  }

  function getAssistantMessageElements() {
    return getMessageElements(ASSISTANT_MESSAGE_SELECTOR);
  }

  function getMessageIdFromElement(el) {
    if (!el) return null;
    const direct = el.getAttribute?.("data-message-id");
    if (direct) return direct;
    const host = el.closest?.("[data-chatgpt-search-message-ids]");
    const ids = host?.getAttribute?.("data-chatgpt-search-message-ids");
    if (ids) return ids.trim().split(/\s+/)[0] || null;
    return el.closest?.("[data-turn-key]")?.getAttribute?.("data-turn-key") || null;
  }

  function isTurnHidden(turn) {
    if (!turn) return false;
    const container = getTurnItemContainer(turn);
    return [turn, container].some((el) =>
      !!el && (el.classList?.contains("qelvynox-dom-hidden") || el.style?.display === "none")
    );
  }

  function isTurnVisible(turn) {
    if (!turn || isTurnHidden(turn)) return false;
    const container = getTurnItemContainer(turn);
    return ![turn, container].some((el) =>
      !!el?.parentElement && (el.parentElement.classList?.contains("qelvynox-dom-hidden") || el.parentElement.style?.display === "none")
    );
  }

  function getFirstVisibleConversationTurn() {
    const turns = getAllConversationTurns();
    return turns.find(isTurnVisible) || turns[0] || null;
  }

  function countHiddenUserTurns() {
    return getAllConversationTurns().filter((turn) => isUserTurn(turn) && isTurnHidden(turn)).length;
  }

  function countDomUserTurns() {
    if (typeof getAllConversationTurns === "function" && typeof isUserTurn === "function") {
      return getAllConversationTurns().filter(isUserTurn).length;
    }
    return document.querySelectorAll('[data-message-author-role="user"]').length;
  }

  // Every Qelvynox-owned node carries this attribute so the MutationObserver
  // can tell our own DOM writes apart from ChatGPT's. Without it, each of our
  // renders re-triggered the observer, which re-ran the renders: a permanent
  // 350ms loop that never let the page go idle.
  const OWNED_ATTR = "data-qelvynox";
  const OWNED_SELECTOR = "[data-qelvynox]";
  function markOwned(el) {
    try { el.setAttribute(OWNED_ATTR, "1"); } catch {}
    return el;
  }

  function timestampSlug() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // ChatGPT drives its theme through <html data-theme|class>; the system
  // preference is only a fallback for pages we cannot read.
  function isDarkTheme() {
    try {
      const root = document.documentElement;
      const theme = (root.getAttribute("data-theme") || "").toLowerCase();
      if (theme.includes("dark")) return true;
      if (theme.includes("light")) return false;
      if (root.classList?.contains("dark")) return true;
    } catch {}
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch {
      return false;
    }
  }

  function cleanTitle() {
    const raw = document.title.replace(/\s*-\s*ChatGPT.*$/i, "").trim();
    // Temporary chats usually carry no real title (document.title stays the
    // bare app name) - never let that fail or genericise the export filename.
    if (isTemporaryChat() && (!raw || /^chatgpt$/i.test(raw))) {
      return `ChatGPT-Temporary-${timestampSlug()}`;
    }
    if (raw) return raw;
    return T("app.chatTitleFallback");
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "chatgpt-export";
  }

  function toast(message, durationMs = 2400) {
    // "Hide loading notifications" suppresses the informational toasts that
    // accompany background loading (hydration, archive, counts) - the user
    // asked for a quiet chat.
    if (appSettings.disableNotifications) return;
    const t = markOwned(document.createElement("div"));
    t.className = "qelvynox-toast";
    t.setAttribute("role", "status");
    t.textContent = message;
    // Stack rather than pile up: "loaded 5 turns" and "archive saved" are a
    // normal pair to produce, and two notices at one offset read as one
    // garbled line.
    const live = document.querySelectorAll(".qelvynox-toast").length;
    if (live) t.style.bottom = `calc(28px + ${live * 48}px)`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), durationMs);
  }

  // One key per failure id, so a stopped export reads as a sentence in the
  // user's language. An id that has no entry is shown raw rather than as
  // "unknown": an unlisted reason is a bug worth seeing.
  const REASON_KEYS = new Set([
    "pagination-contract-unknown", "no-backward-cursor", "no-progress", "duplicate-cursor",
    "empty-page", "missing-page-info", "schema", "parse", "network", "max-pages", "bad-url",
    "idless-user-record", "cancelled", "timeout", "bridge-unavailable", "no-conversation",
    "unsupported-client", "unexpected", "no-messages", "unknown"
  ]);

  function failureReasonLabel(reason) {
    if (/^http-429$/.test(reason)) return T("reason.rate-limited");
    if (/^http-\d+$/.test(reason)) return T("reason.http-failed", { code: reason.slice(5) });
    if (reason && REASON_KEYS.has(reason)) return T(`reason.${reason}`);
    return reason || T("reason.unknown");
  }

  // Load and sync settings
  function loadSettings() {
    try {
      const syncRaw = localStorage.getItem(CONFIG_KEY);
      if (syncRaw) {
        const parsed = JSON.parse(syncRaw);
        if (parsed.messageLimit) appSettings.messageLimit = parsed.messageLimit;
        if (parsed.enabled !== undefined) appSettings.enabled = parsed.enabled;
        if (parsed.liveAutoTrim !== undefined) appSettings.liveAutoTrim = parsed.liveAutoTrim;
        if (parsed.enableAutoScrollLoad !== undefined) appSettings.enableAutoScrollLoad = parsed.enableAutoScrollLoad;
      }
    } catch {}

    try {
      // The legacy key is a fallback, not a second source of truth: whichever
      // one wins is written straight back so the next load only ever reads the
      // current name.
      chrome.storage.local.get([SETTINGS_KEY, LEGACY_PREFIX + "settings"], (res) => {
        const stored = (res && res[SETTINGS_KEY]) || (res && res[LEGACY_PREFIX + "settings"]);
        if (stored) {
          appSettings = { ...appSettings, ...stored };
          if (!res[SETTINGS_KEY]) {
            try { chrome.storage.local.set({ [SETTINGS_KEY]: appSettings }); } catch {}
          }
        }
        try {
          localStorage.setItem(CONFIG_KEY, JSON.stringify({
            enabled: appSettings.enabled,
            messageLimit: appSettings.messageLimit,
            enableAutoScrollLoad: appSettings.enableAutoScrollLoad,
            liveAutoTrim: appSettings.liveAutoTrim === true
          }));
        } catch {}
        applyLanguage();
        if (resolveSettingsReady) resolveSettingsReady();
        renderAllTools();
      });
    } catch {
      applyLanguage();
      if (resolveSettingsReady) resolveSettingsReady();
      renderAllTools();
    }
    restoreScrollIfPending();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[SETTINGS_KEY]) {
        const newSettings = changes[SETTINGS_KEY].newValue;
        if (newSettings) {
          const previousLanguage = appSettings.language;
          appSettings = { ...appSettings, ...newSettings };
          try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify({
              enabled: appSettings.enabled,
              messageLimit: appSettings.messageLimit,
              enableAutoScrollLoad: appSettings.enableAutoScrollLoad,
              liveAutoTrim: appSettings.liveAutoTrim === true
            }));
            localStorage.removeItem(EXTRA_KEY);
          } catch {}
          manuallyUnhiddenTurnsCount = 0;
          resetRenderCaches();
          applyLanguage();
          renderAllTools();
          enforceDomTurnLimit({ force: true });
          // The language is the one setting that changes text everywhere rather
          // than behaviour, so the surfaces that cache their own wording have
          // to be repainted too - from the popup or another tab as well.
          if (newSettings.language !== previousLanguage) refreshLanguageSurfaces();
        }
      }
    });
  } catch {}

  let hydrationNoticeShown = false;

  function adoptStatus(payload, source) {
    if (!payload || typeof payload !== "object") return false;
    lastStatus = payload;
    statusReceived = true;

    // "Load older" ran but could not reach the start - say so once, rather
    // than silently showing fewer turns than the user asked for.
    if (!hydrationNoticeShown && payload.hydratedPages > 0 && payload.hydrationFailureReason) {
      hydrationNoticeShown = true;
      toast(T("toast.hydrationStopped", {
        pages: payload.hydratedPages,
        why: failureReasonLabel(payload.hydrationFailureReason)
      }));
    }
    if (DEBUG_STATS) {
      try {
        console.debug("[Qelvynox Stats Debug] content", {
          source,
          receivedConversationId: payload.conversationId,
          currentPageConversationId: getConversationId(),
          visibleTurns: payload.visibleTurns,
          totalTurns: payload.totalTurns,
          countState: payload.countState,
          accepted: true
        });
      } catch {}
    }
    try {
      chrome.storage.local.set({ [CACHED_STATS_KEY]: { url: window.location.href, stats: payload } });
    } catch {}
    renderFloatingLoadButton();
    updateOutlineBadge();
    setupAutoScrollLoader();
    return true;
  }

  // Listen to messages from popup and mainWorld
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    if (e.data && e.data.type === "qelvynox-full-export") {
      const waiters = fullExportWaiters;
      fullExportWaiters = [];
      waiters.forEach((w) => { if (!w.done) { w.done = true; w.resolve(e.data.payload || {}); } });
      return;
    }
    if (e.data && e.data.type === "qelvynox-archive-snapshot") {
      archiveIngestSnapshot(e.data.payload);
      return;
    }
    if (e.data && e.data.type === "qelvynox-archive-backfill-done") {
      archiveOnBackfillDone(e.data.payload);
      return;
    }
    if (e.data && e.data.type === "qelvynox-archive-refresh-done") {
      archiveOnRefreshDone(e.data.payload);
      return;
    }
    if (e.data && e.data.type === "qelvynox-reply-finished") {
      archiveOnReplyFinished();
      return;
    }
    if (e.data && e.data.type === "qelvynox-resolved-image") {
      const waiter = imageResolveWaiters.get(e.data.requestId);
      if (waiter) {
        imageResolveWaiters.delete(e.data.requestId);
        waiter(e.data.url || null);
      }
      return;
    }
    if (e.data && e.data.type === "qelvynox-full-export-progress") {
      const el = document.getElementById("qelvynox-full-progress");
      if (el && e.data.payload) {
        el.textContent = T("toast.progressFetch", { pages: e.data.payload.pages, turns: e.data.payload.turns });
      }
      return;
    }

    if (e.data && e.data.type === "qelvynox-status") {
      try {
        sessionStorage.setItem(STATUS_SESSION_KEY, JSON.stringify(e.data.payload));
      } catch {}
      adoptStatus(e.data.payload, "postMessage");
    }
  });

  // mainWorld broadcasts at document_start; this script starts at
  // document_idle, so the first broadcast can be missed entirely. Recover it
  // from the session mirror, and ask mainWorld to re-send.
  function recoverStatus() {
    if (!statusReceived) {
      let mirrored = null;
      try {
        mirrored = safeJsonParse(sessionStorage.getItem(STATUS_SESSION_KEY), null);
      } catch {}
      if (mirrored && mirrored.url === window.location.href) {
        adoptStatus(mirrored, "sessionStorage");
      }
    }
    try {
      window.postMessage({ type: "qelvynox-request-status" }, "*");
      // The archive snapshot of the first page load was posted before this
      // script existed; ask for it again.
      window.postMessage({ type: "qelvynox-request-archive-snapshot" }, "*");
    } catch {}
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "getStats") {
      // Temporary chats have no server-side history to page through: report
      // what is known locally, explicitly labelled as such.
      const hiddenUserTurns = countHiddenUserTurns();

      if (isTemporaryChat()) {
        const localTurns = countDomUserTurns();
        const baseVisible = Number.isFinite(lastStatus.visibleTurns) && statusReceived
          ? lastStatus.visibleTurns
          : localTurns;
        const visible = appSettings.enabled && hiddenUserTurns > 0
          ? Math.max(1, baseVisible - hiddenUserTurns)
          : baseVisible;
        sendResponse({
          available: true,
          visibleTurns: visible,
          totalTurns: localTurns,
          countState: "local-only",
          countComplete: false,
          totalMessages: lastStatus.totalMessages,
          renderedMessages: lastStatus.renderedMessages,
          hasOlderMessages: lastStatus.hasOlderMessages
        });
        return true;
      }

      // Reject a previous conversation's numbers ONLY when both ids exist and
      // genuinely differ. A missing id is "not known yet", never a mismatch -
      // treating it as one is what turned real stats into 0 / 0.
      const pageId = getConversationId();
      const statusId = lastStatus.conversationId;
      const definitelyStale = !!pageId && !!statusId && pageId !== statusId;

      if (!statusReceived || definitelyStale) {
        if (DEBUG_STATS) {
          try {
            console.debug("[Qelvynox Stats Debug] content", {
              receivedConversationId: statusId,
              currentPageConversationId: pageId,
              accepted: false,
              rejectionReason: !statusReceived ? "no-status-yet" : "conversation-mismatch"
            });
          } catch {}
        }
        // Not "zero turns" - "not known yet". The popup must not render this
        // as a real total.
        sendResponse({
          available: false,
          countState: definitelyStale ? "switching" : "initializing"
        });
        recoverStatus();
        return true;
      }

      const reportedVisible = (appSettings.enabled && hiddenUserTurns > 0 && Number.isFinite(lastStatus.visibleTurns))
        ? Math.max(1, lastStatus.visibleTurns - hiddenUserTurns)
        : lastStatus.visibleTurns;

      sendResponse({
        available: true,
        totalMessages: lastStatus.totalMessages,
        renderedMessages: lastStatus.renderedMessages,
        hasOlderMessages: lastStatus.hasOlderMessages,
        visibleTurns: reportedVisible,
        totalTurns: lastStatus.totalTurns,
        countState: lastStatus.countState,
        countComplete: lastStatus.countComplete,
        countFailureReason: lastStatus.countFailureReason,
        countContractSource: lastStatus.countContractSource
      });
      return true;
    }
    if (request.type === "syncSettings") {
      const previousLanguage = appSettings.language;
      appSettings = { ...appSettings, ...request.settings };
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({
          enabled: appSettings.enabled,
          messageLimit: appSettings.messageLimit,
          enableAutoScrollLoad: appSettings.enableAutoScrollLoad,
          liveAutoTrim: appSettings.liveAutoTrim === true
        }));
        localStorage.removeItem(EXTRA_KEY);
      } catch {}
      manuallyUnhiddenTurnsCount = 0;
      initialEnforcementDone = false;
      resetRenderCaches();
      applyLanguage();
      renderAllTools();
      enforceDomTurnLimit({ force: true });
      if (appSettings.language !== previousLanguage) refreshLanguageSurfaces();
      return true;
    }
    if (request.type === "exportChat") {
      openExportModal();
      sendResponse({ ok: true });
      return true;
    }
    if (request.type === "QELVYNOX_OPEN_SETTINGS") {
      openSettingsModal(request.page);
      sendResponse({ ok: true });
      return true;
    }
  });

  // Inject CSS Styles
  function injectStyles() {
    if (document.getElementById("qelvynox-styles")) return;
    const style = markOwned(document.createElement("style"));
    style.id = "qelvynox-styles";
    style.textContent = `
      .qelvynox-floating-pill {
        position: relative;
        z-index: 10;
        margin: 16px auto 20px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(113, 113, 122, 0.25);
        box-shadow: 0 4px 16px -2px rgba(113, 113, 122, 0.15), 0 2px 6px rgba(0,0,0,0.04);
        padding: 6px 14px;
        border-radius: 9999px;
        width: fit-content;
        animation: qelvynoxFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
      }
      .qelvynox-floating-pill.qelvynox-dark {
        background: rgba(33, 33, 33, 0.94);
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.4);
      }
      /* Inverted primary so the pill stays readable on a dark canvas. Themed by
         a class on the pill itself, not by the OS: ChatGPT's own toggle can
         disagree with prefers-color-scheme, and then the pill is unreadable. */
      .qelvynox-floating-pill.qelvynox-dark .qelvynox-pill-btn {
        background: #fafafa;
        color: #18181b !important;
      }
      .qelvynox-floating-pill.qelvynox-dark .qelvynox-pill-badge { background: rgba(24, 24, 27, 0.18); }
      .qelvynox-floating-pill.qelvynox-dark .qelvynox-pill-all { color: #a1a1aa; }
      .qelvynox-floating-pill.qelvynox-dark .qelvynox-pill-all:hover { background: rgba(255, 255, 255, 0.08); }
      .qelvynox-pill-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        background: #18181b;
        color: #ffffff !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 700;
        border: none;
        border-radius: 9999px;
        padding: 5px 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .qelvynox-pill-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(113, 113, 122, 0.4);
      }
      .qelvynox-pill-badge {
        background: rgba(255, 255, 255, 0.25);
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 9999px;
      }
      .qelvynox-pill-all {
        color: #71717a;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        background: transparent;
        border: none;
        padding: 4px 6px;
        border-radius: 6px;
        transition: all 0.15s;
      }
      .qelvynox-pill-all:hover {
        background: rgba(113, 113, 122, 0.1);
        text-decoration: underline;
      }

      /* Floating Outline & Tools Dock - shadcn style vertical capsule */
      .qelvynox-floating-dock {
        --qg-dock-bg: #ffffff;
        --qg-dock-fg: #18181b;
        --qg-dock-muted: #71717a;
        --qg-dock-border: #e4e4e7;
        --qg-dock-hover: #f4f4f5;
        --qg-dock-accent: #18181b;
        --qg-dock-brand: #4f5fd8;
        --qg-dock-brand-line: rgba(79, 95, 216, 0.45);
        position: fixed;
        right: 16px;
        bottom: 96px;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 6px;
        background: var(--qg-dock-bg);
        border: 1px solid var(--qg-dock-border);
        border-radius: 9999px;
        box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.02);
        user-select: none;
        /* Resting state is deliberately a little quiet: the dock lives on top
           of a conversation the user is reading, and full contrast on five
           icons competes with it. Hover or keyboard focus brings it up. */
        opacity: 0.9;
        transition: opacity 0.18s ease, box-shadow 0.18s ease;
      }
      .qelvynox-floating-dock:hover,
      .qelvynox-floating-dock:focus-within { opacity: 1; }
      .qelvynox-floating-dock.qelvynox-dark {
        --qg-dock-bg: #212121;
        --qg-dock-fg: #ededed;
        --qg-dock-muted: #a1a1aa;
        --qg-dock-border: #3f3f46;
        --qg-dock-hover: #2f2f33;
        --qg-dock-accent: #fafafa;
        --qg-dock-brand: #9db0ff;
        --qg-dock-brand-line: rgba(157, 176, 255, 0.45);
        box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.6);
      }
      .qelvynox-dock-btn {
        width: 36px;
        height: 36px;
        border-radius: 9999px;
        background: transparent;
        border: none;
        color: var(--qg-dock-fg);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease;
        position: relative;
      }
      .qelvynox-dock-btn:hover {
        background: var(--qg-dock-hover);
      }
      /* Nothing in the dock is reachable by Tab without this: every control in
         the panel is icon-only, so the ring has to carry the whole label. */
      .qelvynox-dock-btn:focus-visible {
        outline: 2px solid var(--qg-dock-brand);
        outline-offset: -2px;
      }
      /* A pinned popover (clicked open) keeps its trigger visibly pressed -
         hover alone must never look like a stuck state. */
      .qelvynox-dock-btn.qelvynox-dock-btn-active {
        background: var(--qg-dock-hover);
        box-shadow: inset 0 0 0 1px var(--qg-dock-brand-line);
        color: var(--qg-dock-brand);
      }
      .qelvynox-dock-btn svg { pointer-events: none; }
      .qelvynox-dock-sep {
        width: 20px;
        height: 1px;
        margin: 4px 0;
        background: var(--qg-dock-border);
        flex: none;
      }
      .qelvynox-dock-badge {
        position: absolute;
        top: 1px;
        right: -1px;
        min-width: 15px;
        text-align: center;
        background: var(--qg-dock-brand);
        color: #ffffff;
        font-size: 9.5px;
        font-weight: 700;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        padding: 2.5px 4px;
        border-radius: 9999px;
        /* The chip sits on the dock's own white, so it needs a ring of the
           dock colour to read as a badge instead of a smudge. */
        box-shadow: 0 0 0 2px var(--qg-dock-bg);
        pointer-events: none;
      }
      .qelvynox-floating-dock.qelvynox-dark .qelvynox-dock-badge { color: #12141c; }
      /* The outline button's bars double as a "where am I in this chat" map:
         four bars, the one covering the viewport's centre is drawn longer. */
      .qelvynox-dock-bars {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 3px;
        width: 17px;
      }
      .qelvynox-dock-bars i {
        display: block;
        height: 2px;
        width: 11px;
        border-radius: 2px;
        background: var(--qg-dock-muted);
        opacity: 0.45;
        transition: width 0.2s ease, opacity 0.2s ease;
      }
      .qelvynox-dock-bars i.qelvynox-bar-active {
        width: 17px;
        opacity: 1;
        background: var(--qg-dock-accent);
      }

      /* Shared neutral surface tokens for every injected floating surface
         (navigator / bookmarks popovers, search bar, export window) - the same
         ramp the settings modal uses. Dark is a class on the surface root,
         driven by ChatGPT's own theme, never a media query that can disagree
         with the page. */
      .qelvynox-outline-popover,
      .qelvynox-bookmarks-popover,
      .qelvynox-search-overlay,
      .qelvynox-modal-overlay {
        --su-bg: #ffffff;
        --su-fg: #09090b;
        --su-muted: #71717a;
        --su-muted-bg: #f4f4f5;
        --su-border: #e4e4e7;
        --su-hover: #fafafa;
        --su-accent: #18181b;
        --su-ring: rgba(113, 113, 122, 0.22);
        --su-pop: 0 16px 40px -12px rgba(0, 0, 0, 0.22);
        --su-success: #15803d;
        --su-success-bg: #f0fdf4;
        --su-success-border: #bbf7d0;
        /* The one colour that is ours: the periwinkle orbit of the mark, used
           only where the surface has to say "this is live" - the row you are
           reading, the pinned button, the match counter. Everything else stays
           neutral so the toolkit does not fight ChatGPT's own canvas. */
        --su-brand: #4f5fd8;
        --su-brand-soft: rgba(79, 95, 216, 0.10);
        --su-brand-line: rgba(79, 95, 216, 0.35);
      }
      .qelvynox-outline-popover.qelvynox-dark,
      .qelvynox-bookmarks-popover.qelvynox-dark,
      .qelvynox-search-overlay.qelvynox-dark,
      .qelvynox-modal-overlay.qelvynox-dark {
        --su-bg: #212121;
        --su-fg: #ededed;
        --su-muted: #a1a1aa;
        --su-muted-bg: #27272a;
        --su-border: #3f3f46;
        --su-hover: #2f2f33;
        --su-accent: #fafafa;
        --su-ring: rgba(161, 161, 170, 0.3);
        --su-pop: 0 18px 44px -12px rgba(0, 0, 0, 0.7);
        --su-success: #86efac;
        --su-success-bg: #052e16;
        --su-success-border: #14532d;
        --su-brand: #9db0ff;
        --su-brand-soft: rgba(157, 176, 255, 0.13);
        --su-brand-line: rgba(157, 176, 255, 0.40);
      }

      /* Dock-anchored popovers (navigator / bookmarks). Deliberately headerless:
         the dock button already says what the panel holds, so what is left on
         screen is only the list. */
      .qelvynox-outline-popover,
      .qelvynox-bookmarks-popover {
        position: fixed;
        right: 60px;
        bottom: 96px;
        width: 300px;
        /* A narrow window (or a phone-size ChatGPT) used to clip the panel off
           the left edge, leaving a list that could not be read or scrolled. */
        max-width: calc(100vw - 92px);
        max-height: min(62vh, 560px);
        background: var(--su-bg);
        color: var(--su-fg);
        border: 1px solid var(--su-border);
        border-radius: 14px;
        box-shadow: var(--su-pop);
        z-index: 10001;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: qelvynoxPopIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
      }
      /* The dock sits 16px from the edge while the panel stops at 60px, so the
         pointer crosses bare page between them. This transparent bridge belongs
         to the panel: moving over it never counts as leaving. */
      .qelvynox-outline-popover::after,
      .qelvynox-bookmarks-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        right: -18px;
        width: 18px;
      }
      .qelvynox-pop-seg {
        display: flex;
        flex: none;
        gap: 2px;
        margin: 8px 8px 0;
        padding: 3px;
        background: var(--su-muted-bg);
        border: 1px solid var(--su-border);
        border-radius: 10px;
      }
      .qelvynox-seg-item {
        flex: 1;
        text-align: center;
        font-size: 12px;
        font-weight: 500;
        padding: 4px 8px;
        border-radius: 7px;
        border: none;
        background: transparent;
        color: var(--su-muted);
        cursor: pointer;
        transition: background-color 0.15s, color 0.15s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .qelvynox-seg-item:hover { color: var(--su-fg); }
      .qelvynox-seg-item:focus-visible { outline: 2px solid var(--su-brand); outline-offset: 1px; }
      .qelvynox-seg-item.active {
        background: var(--su-bg);
        color: var(--su-fg);
        font-weight: 600;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      }
      .qelvynox-pop-list {
        padding: 6px;
        overflow-y: auto;
        overscroll-behavior: contain;
        display: flex;
        flex-direction: column;
        gap: 2px;
        /* The default scrollbar is 15px of OS chrome inside a 300px panel;
           thin and themed keeps the list reading as one surface. */
        scrollbar-width: thin;
        scrollbar-color: var(--su-border) transparent;
      }
      .qelvynox-pop-list::-webkit-scrollbar { width: 8px; }
      .qelvynox-pop-list::-webkit-scrollbar-thumb {
        background: var(--su-border);
        border-radius: 9999px;
        border: 2px solid var(--su-bg);
      }
      .qelvynox-pop-list::-webkit-scrollbar-thumb:hover { background: var(--su-muted); }
      .qelvynox-pop-empty {
        padding: 20px 12px;
        text-align: center;
        font-size: 12px;
        line-height: 1.65;
        color: var(--su-muted);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 7px;
      }
      .qelvynox-pop-empty svg { opacity: 0.5; }
      .qelvynox-toc-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 9px;
        border: 1px solid transparent;
        border-radius: 9px;
        background: transparent;
        font-size: 12.5px;
        line-height: 1.45;
        color: var(--su-fg);
        cursor: pointer;
        transition: background-color 0.14s ease, border-color 0.14s ease;
      }
      .qelvynox-toc-item:hover { background: var(--su-hover); }
      .qelvynox-toc-item:focus-visible {
        outline: 2px solid var(--su-brand);
        outline-offset: -2px;
        background: var(--su-hover);
      }
      /* The row the viewport is actually reading - kept in step while scrolling
         so the panel works as a position map, not just a jump list. */
      .qelvynox-toc-item.qelvynox-toc-active {
        background: var(--su-brand-soft);
        border-color: var(--su-brand-line);
      }
      .qelvynox-toc-item.qelvynox-toc-active .qelvynox-toc-role { color: var(--su-brand); }
      /* Role marker, not a turn number: "第几轮" was removed as a metering
         claim, but the list still has to say whose message each row is. */
      .qelvynox-toc-role {
        flex: none;
        font-size: 10px;
        font-weight: 600;
        color: var(--su-muted);
        transition: color 0.14s ease;
      }
      .qelvynox-toc-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .qelvynox-toc-item.qelvynox-toc-hidden {
        border-left: 2px dashed var(--su-muted);
        color: var(--su-muted);
      }
      .qelvynox-toc-hidden-tag {
        flex: none;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 9999px;
        background: var(--su-muted-bg);
        color: var(--su-muted);
      }
      .qelvynox-bm-star {
        flex: none;
        display: inline-flex;
        color: var(--su-muted);
      }
      .qelvynox-bm-star.active { color: #eab308; }
      .qelvynox-pop-meta {
        flex: none;
        font-size: 10.5px;
        color: var(--su-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* A cross-chat bookmark needs a second line for the conversation. */
      .qelvynox-toc-item.qelvynox-toc-col {
        align-items: stretch;
        flex-direction: column;
        gap: 3px;
      }
      .qelvynox-toc-line {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .qelvynox-pop-del {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--su-muted);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.14s ease, background-color 0.14s ease;
      }
      .qelvynox-toc-item:hover .qelvynox-pop-del { opacity: 1; }
      .qelvynox-pop-del:hover { background: var(--su-muted-bg); color: var(--su-fg); }
      .qelvynox-pop-del svg { pointer-events: none; }

      /* Hidden turns by limit enforcer */
      .qelvynox-dom-hidden {
        display: none !important;
      }
      /* Search: one command bar. Typing highlights the match in place - there
         is no result list, no scope switch and no preview window any more. */
      .qelvynox-search-overlay {
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10002;
        background: var(--su-bg);
        color: var(--su-fg);
        border: 1px solid var(--su-border);
        border-radius: 14px;
        box-shadow: var(--su-pop);
        padding: 9px 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        animation: qelvynoxDropIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        width: 460px;
        max-width: 92vw;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
      }
      .qelvynox-search-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        color: var(--su-muted);
      }
      .qelvynox-search-bar-row > svg { flex: none; pointer-events: none; }
      .qelvynox-search-input {
        border: none;
        outline: none;
        font-size: 13px;
        font-weight: 500;
        color: var(--su-fg);
        flex: 1;
        background: transparent;
        min-width: 0;
        font-family: inherit;
      }
      .qelvynox-search-input::placeholder { color: var(--su-muted); }
      /* The bar is the only focus target in the app that a user types into, so
         it has to look armed: the ring is the brand colour while it is empty,
         and turns green the moment the keyword has hits. */
      .qelvynox-search-overlay:focus-within { border-color: var(--su-brand); }
      .qelvynox-search-overlay.qelvynox-search-has-match .qelvynox-search-count {
        color: var(--su-brand);
      }
      .qelvynox-search-count {
        font-size: 11px;
        font-weight: 600;
        color: var(--su-muted);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .qelvynox-search-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        min-width: 28px;
        height: 28px;
        background: var(--su-bg);
        border: 1px solid var(--su-border);
        border-radius: 8px;
        padding: 0 8px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        color: var(--su-fg);
        transition: background-color 0.15s, border-color 0.15s, color 0.15s;
      }
      .qelvynox-search-btn:hover { background: var(--su-hover); border-color: var(--su-muted); }
      .qelvynox-search-btn:active { transform: translateY(1px); }
      .qelvynox-search-btn:focus-visible { outline: 2px solid var(--su-brand); outline-offset: 1px; }
      .qelvynox-search-btn svg { pointer-events: none; }
      .qelvynox-search-hint {
        font-size: 11px;
        line-height: 1.5;
        color: var(--su-muted);
        padding-inline-start: 24px;
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .qelvynox-search-hint > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .qelvynox-search-hint .qelvynox-kbd {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px;
        padding: 1px 5px;
        border: 1px solid var(--su-border);
        border-bottom-width: 2px;
        border-radius: 5px;
        background: var(--su-muted-bg);
        color: var(--su-muted);
        font-style: normal;
      }

      /* In-place keyword highlight. The Custom Highlight API paints ranges
         without touching the host tree, so React never finds its DOM rewritten
         underneath it. The colours are theme-agnostic (a marker pen reads on
         both ramps) because ::highlight() cannot see custom properties. */
      ::highlight(qelvynox-search) { background-color: rgba(250, 204, 21, 0.4); }
      ::highlight(qelvynox-search-active) {
        background-color: rgba(234, 88, 12, 0.85);
        color: #ffffff;
      }

      /* Turn Highlight Animation */
      @keyframes qelvynoxHighlightPulse {
        0% { outline: 3px solid #71717a; box-shadow: 0 0 20px rgba(113, 113, 122, 0.6); }
        70% { outline: 3px solid #71717a; box-shadow: 0 0 20px rgba(113, 113, 122, 0.6); }
        100% { outline: 3px solid transparent; box-shadow: none; }
      }
      .qelvynox-highlight-turn {
        animation: qelvynoxHighlightPulse 2.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
        border-radius: 12px;
      }
      /* Bookmark Button (回复旁的星形收藏) */
      .qelvynox-bookmark-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 4px 6px;
        border-radius: 6px;
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .qelvynox-bookmark-btn:hover {
        color: #eab308;
        background: rgba(234, 179, 8, 0.1);
      }
      .qelvynox-bookmark-btn.active {
        color: #eab308;
      }

      /* Export window - same token ramp as the settings panel and the popovers:
         1px borders, one radius scale, no hardcoded slate colours. */
      .qelvynox-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        z-index: 20000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: qelvynoxFade 0.18s ease;
      }
      .qelvynox-modal-box {
        background: var(--su-bg);
        color: var(--su-fg);
        border: 1px solid var(--su-border);
        border-radius: 16px;
        box-shadow: var(--su-pop);
        width: 520px;
        max-width: 92vw;
        max-height: 86vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        animation: qelvynoxPopIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
      }
      .qelvynox-modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--su-border);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex: none;
      }
      .qelvynox-modal-headtext {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .qelvynox-modal-title {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--su-fg);
      }
      .qelvynox-modal-sub {
        font-size: 12px;
        color: var(--su-muted);
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
      }
      .qelvynox-modal-body {
        padding: 16px 20px 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-y: auto;
      }
      /* Bare glyph button (window close, row delete). The svg must never become
         the click target: ChatGPT's own handlers can eat it. */
      .qelvynox-icon-btn {
        flex: none;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        border: none;
        background: transparent;
        color: var(--su-muted);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background-color 0.15s, color 0.15s;
      }
      .qelvynox-icon-btn:hover { background: var(--su-muted-bg); color: var(--su-fg); }
      .qelvynox-icon-btn:focus-visible { outline: 2px solid var(--su-ring); outline-offset: 2px; }
      .qelvynox-icon-btn svg { pointer-events: none; }
      .qelvynox-export-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .qelvynox-export-section-title {
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.01em;
        color: var(--su-muted);
      }
      .qelvynox-export-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 180px;
        overflow-y: auto;
      }
      .qelvynox-select-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        background: var(--su-hover);
        border: 1px solid var(--su-border);
        border-radius: 10px;
        font-size: 12px;
        color: var(--su-fg);
        cursor: pointer;
        transition: background-color 0.15s, border-color 0.15s;
      }
      .qelvynox-select-row:hover {
        background: var(--su-muted-bg);
        border-color: var(--su-muted);
      }
      .qelvynox-select-row input { accent-color: var(--su-accent); flex: none; }
      .qelvynox-select-role {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 9999px;
        border: 1px solid var(--su-border);
        white-space: nowrap;
        flex: none;
      }
      .qelvynox-select-role.user { background: var(--su-muted-bg); color: var(--su-muted); }
      .qelvynox-select-role.chatgpt {
        background: var(--su-success-bg);
        border-color: var(--su-success-border);
        color: var(--su-success);
      }
      .qelvynox-select-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .qelvynox-export-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .qelvynox-export-grid-single { grid-template-columns: minmax(0, 1fr); }
      .qelvynox-export-option-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: var(--su-bg);
        border: 1px solid var(--su-border);
        border-radius: 10px;
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
        font-size: 12.5px;
        color: var(--su-fg);
        text-align: left;
        transition: background-color 0.15s, border-color 0.15s;
      }
      .qelvynox-export-option-btn svg { flex: none; pointer-events: none; color: var(--su-muted); }
      .qelvynox-export-option-btn > span:first-of-type {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .qelvynox-export-option-btn:hover:not(:disabled) {
        background: var(--su-hover);
        border-color: var(--su-muted);
      }
      .qelvynox-export-option-btn:focus-visible { outline: 2px solid var(--su-ring); outline-offset: 2px; }
      .qelvynox-export-option-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .qelvynox-export-tail {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: 11px;
        font-weight: 400;
        color: var(--su-muted);
      }
      .qelvynox-export-tail svg { width: 12px; height: 12px; }
      .qelvynox-link-btn {
        background: none;
        border: none;
        color: var(--su-muted);
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        padding: 0;
      }
      .qelvynox-link-btn:hover { color: var(--su-fg); text-decoration: underline; }
      @media (max-width: 520px) {
        .qelvynox-export-grid { grid-template-columns: minmax(0, 1fr); }
      }

      /* Top-bar Export button (beside ChatGPT's Share) */
      .qelvynox-topbar-export {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 36px;
        padding: 0 12px;
        margin: 0 6px;
        /* A mid grey works on either canvas, so this button - the one control
           that lives inside ChatGPT's own header and inherits its colours - no
           longer needs a media query that can disagree with the page theme. */
        border: 1px solid rgba(128, 128, 140, 0.38);
        border-radius: 9999px;
        background: transparent;
        color: inherit;
        font-size: 14px;
        font-weight: 500;
        font-family: inherit;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .qelvynox-topbar-export:hover {
        background: rgba(128, 128, 140, 0.16);
        border-color: rgba(128, 128, 140, 0.6);
      }
      .qelvynox-topbar-export:focus-visible {
        outline: 2px solid rgba(128, 128, 140, 0.85);
        outline-offset: 2px;
      }
      .qelvynox-topbar-export svg { pointer-events: none; }
      @media (max-width: 640px) {
        .qelvynox-topbar-export span { display: none; }
        .qelvynox-topbar-export { padding: 0 10px; }
      }

      /* Cards inside the export window. The local-archive one is the offline
         fast path, so it carries the success tint; the server one stays plain. */
      .qelvynox-export-card {
        border: 1px solid var(--su-border);
        background: var(--su-hover);
        border-radius: 12px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .qelvynox-export-card.qelvynox-local-archive-box {
        border-color: var(--su-success-border);
        background: var(--su-success-bg);
      }
      .qelvynox-export-card-head {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--su-fg);
      }
      .qelvynox-export-card-head svg { flex: none; pointer-events: none; color: var(--su-muted); }
      .qelvynox-local-archive-box .qelvynox-export-card-head,
      .qelvynox-local-archive-box .qelvynox-export-card-head svg { color: var(--su-success); }
      .qelvynox-export-card-hint {
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--su-muted);
      }

      /* Toast */
      .qelvynox-toast {
        position: fixed;
        bottom: 28px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 30000;
        display: flex;
        align-items: center;
        gap: 8px;
        /* nowrap meant a long Chinese notice was simply cut off at the edge of
           the window - the one message that needed reading was the one that
           could not be read. */
        max-width: min(92vw, 560px);
        background: rgba(15, 18, 30, 0.94);
        color: #eef1fa;
        border: 1px solid rgba(255, 255, 255, 0.10);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1.5;
        text-align: center;
        padding: 9px 16px;
        border-radius: 9999px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        animation: qelvynoxDropIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: none;
      }
      .qelvynox-toast::before {
        content: "";
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #9db0ff;
      }

      /* ===== Dark mode =====
         Nothing here needs a media query any more: every surface we create -
         including the one that lives inside ChatGPT's header - is themed by
         .qelvynox-dark on its own root or by a canvas-neutral colour. */

      @keyframes qelvynoxFadeIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      /* The pill and the toast are centred with translateX(-50%). Reusing
         qelvynoxFadeIn on them replaced that transform for the length of the
         animation, so both slid in from the wrong place and snapped over. */
      @keyframes qelvynoxDropIn {
        from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes qelvynoxFade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes qelvynoxPopIn {
        from { opacity: 0; transform: translateY(8px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes qelvynoxSpin {
        to { transform: rotate(360deg); }
      }
      /* Motion is decoration here, never information: anyone who asked the OS
         for reduced motion gets the same surfaces without the travel. */
      @media (prefers-reduced-motion: reduce) {
        .qelvynox-outline-popover,
        .qelvynox-bookmarks-popover,
        .qelvynox-search-overlay,
        .qelvynox-modal-overlay,
        .qelvynox-modal-box,
        .qelvynox-floating-pill,
        .qelvynox-toast { animation: none; }
        .qelvynox-floating-dock { opacity: 1; }
        .qelvynox-highlight-turn { animation-duration: 0.5s; }
        .qelvynox-scroll-spinner { animation-duration: 1.8s; }
      }
      .qelvynox-scroll-loader {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        margin: 12px auto;
        padding: 8px 18px;
        /* Sits inside the conversation, so it inherits the page's own text
           colour and uses a translucent neutral fill: one rule that reads
           correctly on either ramp, with no media query to disagree. */
        background: rgba(127, 127, 140, 0.14);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid rgba(127, 127, 140, 0.26);
        border-radius: 9999px;
        color: inherit;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.2px;
        width: fit-content;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.10);
        transition: opacity 0.2s ease, transform 0.2s ease;
        z-index: 40;
        pointer-events: none;
      }
      .qelvynox-scroll-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(127, 127, 140, 0.35);
        border-top-color: currentColor;
        border-radius: 50%;
        animation: qelvynoxSpin 0.65s linear infinite;
      }
      .qelvynox-scroll-sentinel {
        height: 1px;
        width: 100%;
        opacity: 0;
        pointer-events: none;
        margin: 0;
        padding: 0;
      }
    `;
    document.head.appendChild(style);
  }

  // Resilient element queries (Self-Healing Selectors)
  //
  // The real container is looked up once and reused until React replaces it
  // (isConnected turns false). It used to be re-resolved - four attribute
  // substring selectors plus a getComputedStyle walk - on every wheel event.
  let cachedScrollContainer = null;

  function findChatScrollContainer() {
    // The scroller of the conversation being read, not the first one in the
    // document: with a second pane mounted, the document-wide lookup returns
    // whichever pane React happened to render first.
    const pane = getConversationRoot();
    const inPane = pane ? (pane.closest?.('[class*="thread-scroll-container"]') ||
                            pane.querySelector?.('[class*="thread-scroll-container"]')) : null;
    // New ChatGPT app renderer: the conversation root lives inside a
    // thread-scroll-container.  Check it before the generic overflow-y-auto
    // fallback, which otherwise tends to select the sidebar scroll area.
    const appScroll = inPane || document.querySelector('[class*="thread-scroll-container"]') ||
                      document.querySelector('[data-thread-find-target="conversation"]')?.closest('[class*="overflow-y-auto"]');
    if (appScroll) return { el: appScroll, cacheable: true };

    const modernRoot = document.querySelector('[class*="group/scroll-root"]') ||
                       document.querySelector('.group\\/scroll-root') ||
                       document.querySelector('main [class*="react-scroll-to-bottom"]') ||
                       document.querySelector('div[class*="overflow-y-auto"]');
    if (modernRoot) return { el: modernRoot, cacheable: true };

    const firstTurn = getConversationTurns()[0] ||
                      document.querySelector('[data-testid^="conversation-turn-"], [data-testid^="conversation-turn"], article');
    if (firstTurn) {
      let curr = firstTurn.parentElement;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        try {
          const style = window.getComputedStyle(curr);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            return { el: curr, cacheable: true };
          }
        } catch {}
        curr = curr.parentElement;
      }
    }

    // Generic fallbacks are always "connected", so they are never cached -
    // the next call gets another chance to find the real container.
    const fallback = document.querySelector('main [role="presentation"]') ||
                     document.querySelector('main') ||
                     document.documentElement;
    return { el: fallback, cacheable: false };
  }

  function getChatScrollContainer() {
    if (cachedScrollContainer && cachedScrollContainer.isConnected) return cachedScrollContainer;
    cachedScrollContainer = null;
    const found = findChatScrollContainer();
    if (found.cacheable) cachedScrollContainer = found.el;
    return found.el;
  }

  // Hidden-turn count, cached between DOM writes. It is read from gesture
  // handlers (wheel/scroll/touch) and every render pass; a querySelectorAll
  // over the whole document there was measurable on long chats.
  let domHiddenCountCache = null;
  function invalidateHiddenCount() { domHiddenCountCache = null; }
  function getDomHiddenCount() {
    if (domHiddenCountCache === null) {
      // Counted inside the active conversation only: a second mounted pane
      // would otherwise report its folded turns as this chat's.
      const root = getConversationRoot();
      const scope = root && typeof root.querySelectorAll === "function" ? root : document;
      domHiddenCountCache = scope.querySelectorAll(".qelvynox-dom-hidden").length;
    }
    return domHiddenCountCache;
  }

  // Class/style writes only when the state actually changes: unconditional
  // writes on every tick invalidated style for every turn, even idle ones.
  function hideTurnEl(el) {
    if (!el || el.classList.contains("qelvynox-dom-hidden")) return false;
    el.classList.add("qelvynox-dom-hidden");
    el.style.setProperty("display", "none", "important");
    invalidateHiddenCount();
    return true;
  }
  function showTurnEl(el) {
    if (!el) return false;
    let changed = false;
    if (el.classList.contains("qelvynox-dom-hidden")) {
      el.classList.remove("qelvynox-dom-hidden");
      changed = true;
    }
    if (el.style.display === "none") {
      el.style.removeProperty("display");
      changed = true;
    }
    if (changed) invalidateHiddenCount();
    return changed;
  }

  function collectTurnNodes() {
    const appTurns = Array.from(document.querySelectorAll(CHATGPT_APP_TURN_SELECTOR));
    if (appTurns.length > 0) return appTurns;

    let turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
    if (turns.length > 0) return turns;

    turns = Array.from(document.querySelectorAll('article'));
    if (turns.length > 0) return turns;

    const roles = Array.from(document.querySelectorAll('[data-message-author-role], [data-message-id]'));
    if (roles.length > 0) {
      const parentTurns = new Set();
      roles.forEach((r) => {
        const parent = r.closest('article') || r.closest('[class*="conversation-turn"]') || r.closest('[data-testid^="conversation-turn"]') || r.parentElement;
        if (parent) parentTurns.add(parent);
      });
      if (parentTurns.size > 0) return Array.from(parentTurns);
    }

    return Array.from(document.querySelectorAll('main div[class*="agent-turn"], main div[class*="user-turn"], div[class*="group/conversation-turn"]'));
  }

  // One page, two conversations
  //
  // ChatGPT can keep a second conversation mounted beside the current one (the
  // compare / split view), and every turn marker repeats per pane. A
  // document-wide query then reads two conversations as one list: the navigator
  // index kept growing past the questions that exist, and the limiter hid turns
  // in the pane the reader was not even looking at - which is what made the page
  // look like two chats had been split onto one screen. So turn discovery is
  // scoped to the ONE pane that is actually on screen.
  //
  // The split is found structurally, never by guessing class names: from the
  // node that holds every turn, descend while one child holds them all, and stop
  // where the turns split into groups that each hold a conversation. In a single
  // chat the descent bottoms out at the turn list - one child per turn - and
  // nothing is scoped away, so no turn wrapper is ever mistaken for a pane.
  let paneCache = null;

  function resetConversationPane() { paneCache = null; }

  /** The deepest ancestor that still contains every turn node. */
  function deepestTurnContainer(turns) {
    let node = turns[0] && turns[0].parentElement;
    while (node && typeof node.contains === "function") {
      if (turns.every((turn) => node.contains(turn))) return node;
      node = node.parentElement;
    }
    return null;
  }

  function childrenWithTurns(el, turns) {
    const kids = el && el.children ? Array.from(el.children) : [];
    return kids
      .map((kid) => ({ pane: kid, turns: kid && typeof kid.contains === "function"
        ? turns.filter((turn) => kid.contains(turn)) : [] }))
      .filter((group) => group.turns.length > 0);
  }

  /**
   * The children that each hold a whole conversation, or null when the turns
   * are all in one. Descending from the node that holds every turn, a single
   * conversation bottoms out at the turn list - one child per turn - while a
   * split view splits into groups that hold many turns each. "At least twice as
   * many turns as groups" tells those two apart without naming any class.
   */
  function findPaneGroups(container, turns) {
    // ChatGPT's scroll containers provide a reliable boundary even when one
    // of the conversations has only one turn (the structural heuristic below
    // cannot distinguish that case from two ordinary turn wrappers).
    const panes = new Map();
    for (const turn of turns) {
      const pane = turn.closest && turn.closest(".thread-scroll-container");
      if (!pane) { panes.clear(); break; }
      if (!panes.has(pane)) panes.set(pane, []);
      panes.get(pane).push(turn);
    }
    if (panes.size > 1) return Array.from(panes, ([pane, members]) => ({ pane, turns: members }));
    let node = container;
    while (node) {
      const groups = childrenWithTurns(node, turns);
      if (groups.length === 1) { node = groups[0].pane; continue; }
      if (groups.length > 1 && turns.length >= groups.length * 2) return groups;
      return null;
    }
    return null;
  }

  /** How much of the element the reader can actually see, in px². */
  function visibleAreaOf(el) {
    try {
      const rect = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (!rect || rect.width <= 0 || rect.height <= 0) return 0;
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight || 0);
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth || 0);
      return bottom > top && right > left ? (bottom - top) * (right - left) : 0;
    } catch {
      return 0;
    }
  }

  function getConversationTurns() {
    const all = collectTurnNodes();
    if (all.length === 0) {
      paneCache = null;
      return all;
    }
    // The scope only changes when the turn set changes; a streaming reply keeps
    // the first node, the last node and the count identical, so the walk above
    // is not repeated on every observer tick.
    const first = all[0];
    const last = all[all.length - 1];
    if (paneCache && !paneCache.multiple && paneCache.all.length === all.length &&
        paneCache.all.every((turn, i) => turn === all[i])) {
      return paneCache.turns;
    }

    let scoped = all;
    let root = null;
    let multiple = false;
    const container = deepestTurnContainer(all);
    if (container) {
      root = container;
      const groups = findPaneGroups(container, all);
      if (groups) {
        multiple = true;
        let bestTurns = null;
        let bestPane = null;
        let bestScore = -1;
        for (const group of groups) {
          // Visible area decides which conversation the reader is in; with no
          // layout to measure (a detached tree, a test double) the pane holding
          // the newest turn wins.
          const score = visibleAreaOf(group.pane) + (group.pane.contains(last) ? 0.5 : 0);
          if (score > bestScore) { bestScore = score; bestTurns = group.turns; bestPane = group.pane; }
        }
        if (bestTurns && bestTurns.length) { scoped = bestTurns; root = bestPane; }
      }
    }

    paneCache = { turns: scoped, all, first, last, root, multiple };
    return scoped;
  }

  /** The element holding the conversation the toolkit is currently working on. */
  function getConversationRoot() {
    return paneCache ? paneCache.root : null;
  }

  function getAllConversationTurns() {
    return getConversationTurns();
  }

  function getTurnItemContainer(turn) {
    // In ChatGPT's current app renderer each turn sits inside a tiny wrapper
    // (usually height ~= 1px) inside a fixed-height virtualizer rail. Hide the
    // wrapper, not just the data-turn-key node, so its layout contribution is
    // removed before the rail is recalculated.
    if (isAppTurn(turn)) {
      const wrapper = turn.parentElement;
      if (wrapper && wrapper.parentElement?.classList?.contains("flex") && wrapper.style?.height) {
        return wrapper;
      }
    }
    if (turn.parentElement && turn.parentElement.parentElement?.classList?.contains("qMYqUG_convSearchResultHighlightRoot")) {
      return turn.parentElement;
    }
    return turn;
  }

  // React owns the current app renderer's turn nodes. Never remove or replace
  // them: React may still hold the original sibling references and will throw
  // NotFoundError during its next commit if one disappears underneath it.
  // Hiding the wrapper keeps React's tree intact while the rail recalculation
  // below removes the black layout gap.
  function hideAppTurn(turn) {
    if (!isAppTurn(turn)) return false;
    const container = getTurnItemContainer(turn);
    return hideTurnEl(container);
  }

  function findAppVirtualizerRail(turn) {
    if (!isAppTurn(turn)) return null;
    let current = turn.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.classList?.contains("relative") &&
          current.classList?.contains("shrink-0") &&
          current.style?.height) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function syncAppVirtualizerRails() {
    const rails = new Set();
    for (const turn of getAllConversationTurns()) {
      const rail = findAppVirtualizerRail(turn);
      if (rail) rails.add(rail);
    }
    if (!rails.size) return;

    const scrollEl = getChatScrollContainer();
    const anchor = getFirstVisibleConversationTurn();
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;

    for (const rail of rails) {
      const content = rail.firstElementChild;
      if (!content) continue;
      const naturalHeight = content.scrollHeight;
      if (!Number.isFinite(naturalHeight) || naturalHeight <= 0) continue;
      const nextHeight = String(Math.ceil(naturalHeight * 10) / 10) + "px";
      if (rail.style.height !== nextHeight) rail.style.height = nextHeight;
    }

    // Keep the currently readable turn at the same viewport position after
    // the fixed virtualizer rail collapses or expands.
    if (anchor && scrollEl && anchorTop != null) {
      const diff = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(diff) > 1) {
        markProgrammaticScroll();
        scrollEl.scrollBy({ top: diff, behavior: "instant" });
      }
    }
  }

  // Active DOM Turn Enforcer:
  // Enforces visible message limit (e.g. 2). When liveAutoTrim is false,
  // limits are enforced on page load/refresh or chat navigation only, so ongoing
  // chat sessions do not abruptly hide new messages under the user's eyes.
  let manuallyUnhiddenTurnsCount = 0;
  let initialEnforcementDone = false;

  function enforceDomTurnLimit(options = {}) {
    const isLiveUpdate = options.live === true;
    if (isLiveUpdate && !appSettings.liveAutoTrim && initialEnforcementDone) {
      updateOutlineBadge();
      return;
    }

    if (!appSettings.enabled) {
      let changed = false;
      if (getDomHiddenCount() > 0) {
        document.querySelectorAll(".qelvynox-dom-hidden").forEach((el) => {
          changed = showTurnEl(el) || changed;
        });
        const root = document.querySelector(".qMYqUG_convSearchResultHighlightRoot");
        if (root) Array.from(root.children).forEach((el) => {
          changed = showTurnEl(el) || changed;
        });
        invalidateHiddenCount();
      }
      if (changed) syncAppVirtualizerRails();
      updateOutlineBadge();
      return;
    }

    if (appSettings.liveAutoTrim) {
      manuallyUnhiddenTurnsCount = 0;
    }

    const turns = getAllConversationTurns();
    if (turns.length === 0) return;

    const userTurns = [];
    turns.forEach((turn, idx) => {
      if (isUserTurn(turn)) {
        userTurns.push(idx);
      }
    });

    const effectiveLimit = appSettings.liveAutoTrim
      ? Math.max(1, appSettings.messageLimit || 15)
      : Math.max(1, (appSettings.messageLimit || 15) + manuallyUnhiddenTurnsCount);

    // Each conversation exchange starts with a user prompt.
    // Preserving the last N user prompts guarantees the user's question is never hidden
    // from the visible conversation round.
    let cutoffIdx = 0;
    if (userTurns.length > 0) {
      cutoffIdx = userTurns.length > effectiveLimit ? userTurns[userTurns.length - effectiveLimit] : 0;
    } else {
      const exchangeLimit = effectiveLimit * 2;
      cutoffIdx = turns.length > exchangeLimit ? turns.length - exchangeLimit : 0;
    }

    if (cutoffIdx > 0) {
      let changed = false;
      turns.forEach((turn, idx) => {
        const container = getTurnItemContainer(turn);
        if (idx < cutoffIdx) {
          if (isAppTurn(turn)) {
            // Keep React's managed nodes in place. Hiding their wrapper gives
            // us the render window without invalidating React's fiber tree.
            changed = hideAppTurn(turn) || changed;
          } else {
            changed = hideTurnEl(turn) || changed;
            if (container !== turn) changed = hideTurnEl(container) || changed;
          }
        } else {
          changed = showTurnEl(turn) || changed;
          if (container !== turn) changed = showTurnEl(container) || changed;
        }
      });

      // Handle ChatGPT virtualizer spacers inside .qMYqUG_convSearchResultHighlightRoot
      const root = document.querySelector(".qMYqUG_convSearchResultHighlightRoot");
      if (root) {
        const children = Array.from(root.children);
        const firstVisibleIdx = children.findIndex((c) =>
          !c.classList.contains("qelvynox-dom-hidden") &&
          c.querySelector('[data-testid^="conversation-turn"]:not(.qelvynox-dom-hidden)')
        );
        if (firstVisibleIdx > 0) {
          children.forEach((c, i) => {
            const isSpacer = c.classList.contains("h-[var(--last-known-height,var(--estimated-turn-height,50vh))]") ||
                             c.getAttribute("style")?.includes("turn-height") ||
                             c.className.includes("min-h-") ||
                             c.getAttribute("data-turn-id-container") === "client-created-root";
            if (i < firstVisibleIdx && !isSpacer && !c.querySelector('[data-testid^="conversation-turn"]:not(.qelvynox-dom-hidden)')) {
              hideTurnEl(c);
            }
          });
        }
      }
      if (changed) syncAppVirtualizerRails();
    } else if (getDomHiddenCount() > 0) {
      let changed = false;
      turns.forEach((turn) => {
        const container = getTurnItemContainer(turn);
        changed = showTurnEl(turn) || changed;
        if (container !== turn) changed = showTurnEl(container) || changed;
      });
      const root = document.querySelector(".qMYqUG_convSearchResultHighlightRoot");
      if (root) Array.from(root.children).forEach((el) => {
        changed = showTurnEl(el) || changed;
      });
      if (changed) syncAppVirtualizerRails();
    }
    initialEnforcementDone = true;
    invalidateHiddenCount();
    updateOutlineBadge();
  }

  // 1. Floating Load Button
  let lastPillSignature = null;

  function hasOlderTurnsToLoad() {
    const domHiddenTurns = getDomHiddenCount();
    if (domHiddenTurns > 0) return true;

    if (Number.isFinite(lastStatus.totalTurns) && Number.isFinite(lastStatus.visibleTurns)) {
      if (lastStatus.totalTurns > (lastStatus.visibleTurns + manuallyUnhiddenTurnsCount)) return true;
    }

    if (lastStatus.serverHasOlder === true || lastStatus.hasOlderMessages === true) return true;

    const legacyHiddenRecords = Math.max(
      0,
      (lastStatus.totalMessages || 0) - (lastStatus.renderedMessages || 0)
    );
    if (legacyHiddenRecords > 0) return true;

    const backendDiff = Math.max(
      0,
      (lastStatus.totalBackendRecords || 0) - (lastStatus.loadedBackendRecords || lastStatus.visibleBackendRecords || 0)
    );
    if (backendDiff > 0) return true;

    return false;
  }

  function renderFloatingLoadButton(force = false) {
    const existingPill = document.getElementById("qelvynox-floating-pill");

    const domHiddenTurns = getDomHiddenCount();

    // When Auto-Load on Scroll is active:
    // As long as turns are hidden in DOM, keep pill hidden so scroll-up handles it seamlessly.
    // If all DOM turns are unhidden and server has older turns, reveal pill for manual server-fetch.
    if (!appSettings.enabled || appSettings.enableFloatingButton === false ||
        (appSettings.enableAutoScrollLoad !== false && domHiddenTurns > 0)) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      if (appSettings.enabled && appSettings.enableAutoScrollLoad !== false) {
        setupAutoScrollLoader();
      }
      return;
    }

    // The conversation start has been reached: nothing older exists on server and no DOM turns hidden.
    if (lastStatus.reachedConversationStart === true && !lastStatus.serverHasOlder &&
        domHiddenTurns === 0) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const olderExists = hasOlderTurnsToLoad();

    if (!olderExists) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const hiddenUserTurnsCount = countHiddenUserTurns();
    const hiddenTurns =
      hiddenUserTurnsCount > 0
        ? hiddenUserTurnsCount
        : (domHiddenTurns > 0
          ? Math.ceil(domHiddenTurns / 2)
          : (lastStatus.countState === "complete" &&
             Number.isFinite(lastStatus.totalTurns) &&
             Number.isFinite(lastStatus.visibleTurns)
              ? Math.max(0, lastStatus.totalTurns - lastStatus.visibleTurns)
              : null));

    const batchSize = Math.max(1, appSettings.loadBatchSize || 5);
    const loadCount = hiddenTurns !== null ? Math.min(hiddenTurns, batchSize) : batchSize;
    if (loadCount <= 0 && domHiddenTurns === 0) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const signature = `${hiddenTurns}|${loadCount}|${olderExists}|${domHiddenTurns}|${lastStatus.countState}`;
    if (!force && existingPill && existingPill.dataset.sig === signature) return;

    const pillMarkup = `
      <button class="qelvynox-pill-btn" id="qelvynox-load-batch-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
        <span>${esc(T("pill.loadMore", { n: loadCount }))}</span>
        ${hiddenTurns !== null ? `<span class="qelvynox-pill-badge">${esc(T("pill.remaining", { n: hiddenTurns }))}</span>` : ""}
      </button>
      <button class="qelvynox-pill-all" id="qelvynox-load-all-action">${esc(T("pill.loadAll"))}</button>
    `;

    // Update in place when the pill is already on screen. Removing and
    // re-inserting it replayed the entry animation and moved the element, which
    // read as a flicker at the top of the chat every time the remaining-turn
    // count ticked down while older history was being revealed.
    let pill = existingPill;
    if (pill) {
      pill.innerHTML = pillMarkup;
      pill.dataset.sig = signature;
    } else {
      const chatContainer = getChatScrollContainer();
      if (!chatContainer) return;
      pill = markOwned(document.createElement("div"));
      pill.id = "qelvynox-floating-pill";
      pill.className = "qelvynox-floating-pill" + (isDarkTheme() ? " qelvynox-dark" : "");
      pill.dataset.sig = signature;
      pill.innerHTML = pillMarkup;

      const firstVisibleTurn = getFirstVisibleConversationTurn() ||
                               chatContainer.querySelector('[data-testid^="conversation-turn-"]') ||
                               chatContainer.firstElementChild;
      const targetTurn = firstVisibleTurn ? getTurnItemContainer(firstVisibleTurn) : null;
      if (targetTurn && targetTurn.parentNode) {
        targetTurn.parentNode.insertBefore(pill, targetTurn);
      } else if (firstVisibleTurn && firstVisibleTurn.parentNode) {
        firstVisibleTurn.parentNode.insertBefore(pill, firstVisibleTurn);
      } else {
        chatContainer.prepend(pill);
      }
    }

    pill.querySelector("#qelvynox-load-batch-action").addEventListener("click", () => {
      if (unhideOlderBatch({ fromScroll: false })) return;

      stashScrollPosition();
      const currentExtra = safeJsonParse(localStorage.getItem(EXTRA_KEY), {}).extra || 0;
      localStorage.setItem(EXTRA_KEY, JSON.stringify({ url: window.location.href, extra: currentExtra + batchSize }));
      window.location.reload();
    });

    pill.querySelector("#qelvynox-load-all-action").addEventListener("click", () => {
      manuallyUnhiddenTurnsCount = 99999;
      enforceDomTurnLimit({ force: true });
      renderFloatingLoadButton(true);
      removeAutoScrollLoader();
      if (lastStatus.serverHasOlder === true) {
        stashScrollPosition();
        localStorage.setItem(EXTRA_KEY, JSON.stringify({ url: window.location.href, extra: 9999 }));
        window.location.reload();
      }
    });
  }

  // 1a. Auto-Load Older Turns on Scroll Up (Zero Reload Lazy Loading)
  let isAutoLoadingBatch = false;
  let scrollIntersectionObserver = null;
  let scrollContainerWithListener = null;
  let scrollListenerCallback = null;
  let wheelListenerCallback = null;
  let touchStartCallback = null;
  let touchMoveCallback = null;
  let keyListenerCallback = null;
  let lastScrollTopPos = 0;
  let touchStartY = 0;
  // The sentinel is visible on the initial trimmed layout. It is not proof
  // that the user scrolled, otherwise the observer can fetch old pages in a
  // loop while the limiter hides each new batch again.
  let userScrollIntent = false;

  function markUserScrollIntent() {
    userScrollIntent = true;
  }

  function consumeUserScrollIntent() {
    const intent = userScrollIntent;
    userScrollIntent = false;
    return intent;
  }

  let programmaticScrollUntil = 0;
  function markProgrammaticScroll() {
    programmaticScrollUntil = Date.now() + 750;
    userScrollIntent = false;
  }

  function isProgrammaticScroll() {
    return Date.now() < programmaticScrollUntil;
  }

  function showScrollLoader() {
    let loader = document.getElementById("qelvynox-scroll-loader");
    if (!loader) {
      loader = markOwned(document.createElement("div"));
      loader.id = "qelvynox-scroll-loader";
      loader.className = "qelvynox-scroll-loader";
      loader.innerHTML = `
        <div class="qelvynox-scroll-spinner"></div>
        <span>${esc(T("loader.loadingOlder"))}</span>
      `;
    }
    loader.style.opacity = "1";
    loader.style.transform = "translateY(0)";
    const chatContainer = getChatScrollContainer();
    const firstVisible = getFirstVisibleConversationTurn() ||
                         (chatContainer ? chatContainer.querySelector('[data-testid^="conversation-turn-"]') : null) ||
                         (chatContainer ? chatContainer.firstElementChild : null);
    const target = firstVisible ? getTurnItemContainer(firstVisible) : null;
    if (target && target.parentNode) {
      target.parentNode.insertBefore(loader, target);
    } else if (chatContainer) {
      chatContainer.prepend(loader);
    }
  }

  function hideScrollLoader() {
    const loader = document.getElementById("qelvynox-scroll-loader");
    if (loader) {
      loader.style.opacity = "0";
      loader.style.transform = "translateY(-4px)";
      setTimeout(() => {
        if (loader && loader.parentNode) loader.remove();
      }, 180);
    }
  }

  function unhideOlderBatch(options = {}) {
    if (isAutoLoadingBatch) return false;
    if (options.fromScroll && !consumeUserScrollIntent()) return false;
    const batchSize = Math.max(1, appSettings.loadBatchSize || 5);

    if (getDomHiddenCount() > 0) {
      isAutoLoadingBatch = true;
      if (options.fromScroll) {
        showScrollLoader();
      }

      const chatContainer = getChatScrollContainer();
      const anchor = getFirstVisibleConversationTurn();
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;

      const performUnhide = () => {
        manuallyUnhiddenTurnsCount += batchSize;
        enforceDomTurnLimit({ force: true });
        renderFloatingLoadButton(true);

        if (anchor && chatContainer) {
          const newTop = anchor.getBoundingClientRect().top;
          const diff = newTop - anchorTop;
          if (Math.abs(diff) > 1) {
            markProgrammaticScroll();
            chatContainer.scrollBy({ top: diff, behavior: "instant" });
          }
        }

        hideScrollLoader();
        setTimeout(() => {
          isAutoLoadingBatch = false;
          setupAutoScrollLoader();
        }, 250);
      };

      if (options.fromScroll) {
        setTimeout(performUnhide, 200);
      } else {
        performUnhide();
      }
      return true;
    }

    // When scrolling up, NEVER reload the browser automatically!
    if (options.fromScroll) {
      if (hasOlderTurnsToLoad()) {
        isAutoLoadingBatch = true;
        showScrollLoader();
        manuallyUnhiddenTurnsCount += batchSize;
        enforceDomTurnLimit({ force: true });
        renderFloatingLoadButton(true);

        const chatContainer = getChatScrollContainer();
        if (chatContainer && chatContainer.scrollTop <= 10 && chatContainer.scrollHeight > chatContainer.clientHeight) {
          markProgrammaticScroll();
          chatContainer.scrollBy({ top: 30, behavior: "instant" });
        }

        setTimeout(() => {
          hideScrollLoader();
          isAutoLoadingBatch = false;
          setupAutoScrollLoader();
        }, 250);
        return true;
      }

      removeAutoScrollLoader();
      return false;
    }

    // Manual load button fallback: when no turns are hidden in DOM and user explicitly clicks Load
    if (hasOlderTurnsToLoad()) {
      isAutoLoadingBatch = true;
      showScrollLoader();
      stashScrollPosition();
      const currentExtra = safeJsonParse(localStorage.getItem(EXTRA_KEY), {}).extra || 0;
      localStorage.setItem(EXTRA_KEY, JSON.stringify({ url: window.location.href, extra: currentExtra + batchSize }));
      setTimeout(() => {
        window.location.reload();
      }, 200);
      return true;
    }

    return false;
  }

  function getEffectiveScrollTop() {
    const container = getChatScrollContainer();
    const cst = container ? container.scrollTop : 0;
    const wst = window.scrollY || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0);
    return Math.max(cst, wst);
  }

  function setupAutoScrollLoader() {
    if (!appSettings.enabled || appSettings.enableAutoScrollLoad === false || appSettings.liveAutoTrim === true) {
      removeAutoScrollLoader();
      return;
    }

    if (!hasOlderTurnsToLoad()) {
      removeAutoScrollLoader();
      return;
    }

    const chatContainer = getChatScrollContainer();

    // Sentinel for intersection observation
    if (chatContainer) {
      const firstVisible = getFirstVisibleConversationTurn() ||
                           chatContainer.querySelector('[data-testid^="conversation-turn-"]') ||
                           chatContainer.firstElementChild;
      if (firstVisible) {
        const targetContainer = getTurnItemContainer(firstVisible) || firstVisible;
        let sentinel = document.getElementById("qelvynox-scroll-sentinel");
        if (!sentinel) {
          sentinel = markOwned(document.createElement("div"));
          sentinel.id = "qelvynox-scroll-sentinel";
          sentinel.className = "qelvynox-scroll-sentinel";
          sentinel.setAttribute("aria-hidden", "true");
        }
        if (targetContainer.parentNode && targetContainer.previousElementSibling !== sentinel) {
          targetContainer.parentNode.insertBefore(sentinel, targetContainer);
        }
        if (!scrollIntersectionObserver || sentinel.dataset.observed !== "true") {
          if (scrollIntersectionObserver) scrollIntersectionObserver.disconnect();
          scrollIntersectionObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              const domHidden = getDomHiddenCount();
              const currentST = chatContainer ? chatContainer.scrollTop : getEffectiveScrollTop();
              const distanceFromBottom = chatContainer ? (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) : 0;
                if (entry.isIntersecting && !isAutoLoadingBatch &&
                  userScrollIntent &&
                  domHidden > 0 &&
                  currentST <= 150 && distanceFromBottom > 100) {
                unhideOlderBatch({ fromScroll: true });
              }
            }
          }, {
            root: null,
            rootMargin: "50px 0px 0px 0px",
            threshold: 0
          });
          scrollIntersectionObserver.observe(sentinel);
          sentinel.dataset.observed = "true";
        }
      }
    }

    // 1. Wheel listener: catches upward mouse wheel / trackpad scroll even when scrollTop is 0 (e.g. Visible Messages = 1)
    // Registered once, on window only (the duplicate document listener ran
    // every handler twice), and the actual check is coalesced to one per
    // animation frame - wheel events arrive far faster than frames.
    if (!wheelListenerCallback) {
      wheelListenerCallback = (e) => {
        if (e.deltaY < 0) {
          markUserScrollIntent();
          scheduleGestureCheck();
        }
      };
      window.addEventListener("wheel", wheelListenerCallback, { capture: true, passive: true });
    }

    // 2. Touch listeners: catches mobile/tablet swipe down
    if (!touchStartCallback) {
      touchStartCallback = (e) => {
        touchStartY = e.touches[0]?.clientY || 0;
      };
      touchMoveCallback = (e) => {
        const currentY = e.touches[0]?.clientY || 0;
        if (currentY - touchStartY > 35) {
          markUserScrollIntent();
          scheduleGestureCheck();
        }
      };
      window.addEventListener("touchstart", touchStartCallback, { capture: true, passive: true });
      window.addEventListener("touchmove", touchMoveCallback, { capture: true, passive: true });
    }

    // 3. Keyboard listener: catches PageUp or Ctrl+ArrowUp at the top
    if (!keyListenerCallback) {
      keyListenerCallback = (e) => {
        if (e.key === "PageUp" || (e.key === "ArrowUp" && (e.ctrlKey || e.metaKey))) {
          markUserScrollIntent();
          scheduleGestureCheck();
        }
      };
      window.addEventListener("keydown", keyListenerCallback, { passive: true });
    }

    // 4. Scroll listener on chat container (catches scrollbar drag / momentum scrolling up)
    if (chatContainer && chatContainer !== scrollContainerWithListener) {
      if (scrollContainerWithListener && scrollListenerCallback) {
        scrollContainerWithListener.removeEventListener("scroll", scrollListenerCallback);
      }
      scrollContainerWithListener = chatContainer;
      lastScrollTopPos = chatContainer.scrollTop || 0;
      scrollListenerCallback = () => {
        const currentST = chatContainer.scrollTop || 0;
        const isUp = currentST < lastScrollTopPos;
        lastScrollTopPos = currentST;
        scheduleDockViewportIndicator();
        if (isProgrammaticScroll()) return;
        if (isUp && currentST <= 150 && !isAutoLoadingBatch) {
          const domHidden = getDomHiddenCount();
          if (domHidden > 0) {
            markUserScrollIntent();
            unhideOlderBatch({ fromScroll: true });
          }
        }
      };
      chatContainer.addEventListener("scroll", scrollListenerCallback, { passive: true });
    }
  }

  // One gesture check per frame, whatever the input rate.
  let gestureCheckScheduled = false;
  function scheduleGestureCheck() {
    if (gestureCheckScheduled) return;
    if (!appSettings.enabled || appSettings.enableAutoScrollLoad === false || isAutoLoadingBatch) return;
    gestureCheckScheduled = true;
    const run = () => {
      gestureCheckScheduled = false;
      if (!appSettings.enabled || appSettings.enableAutoScrollLoad === false || isAutoLoadingBatch) return;
      const st = getEffectiveScrollTop();
      const domHidden = getDomHiddenCount();
      if (st <= 150 && domHidden > 0) {
        unhideOlderBatch({ fromScroll: true });
      } else {
        consumeUserScrollIntent();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function removeAutoScrollLoader() {
    userScrollIntent = false;
    if (scrollIntersectionObserver) {
      scrollIntersectionObserver.disconnect();
      scrollIntersectionObserver = null;
    }
    if (scrollContainerWithListener && scrollListenerCallback) {
      scrollContainerWithListener.removeEventListener("scroll", scrollListenerCallback);
      scrollContainerWithListener = null;
      scrollListenerCallback = null;
    }
    if (wheelListenerCallback) {
      window.removeEventListener("wheel", wheelListenerCallback, { capture: true });
      wheelListenerCallback = null;
    }
    if (touchStartCallback) {
      window.removeEventListener("touchstart", touchStartCallback, { capture: true });
      window.removeEventListener("touchmove", touchMoveCallback, { capture: true });
      touchStartCallback = null;
      touchMoveCallback = null;
    }
    if (keyListenerCallback) {
      window.removeEventListener("keydown", keyListenerCallback);
      keyListenerCallback = null;
    }
    const sentinel = document.getElementById("qelvynox-scroll-sentinel");
    if (sentinel) sentinel.remove();
    hideScrollLoader();
  }

  // 1b. Top-bar Export button (sits beside ChatGPT's own Share button)
  const TOPBAR_EXPORT_ID = "qelvynox-export-topbar";

  // Ordered by how stable each hook is: test ids first, then ARIA, then
  // visible text (which is language-dependent and only a last resort).
  // The non-English literals below match ChatGPT's OWN translated interface -
  // they are lookups against the host page, never strings we render, so they
  // stay whatever the user's ChatGPT language is.
  function findShareButton() {
    const selectors = [
      '[data-testid="share-chat-button"]',
      '[data-testid*="share" i]',
      'button[aria-label*="Share" i]',
      'button[aria-label*="分享"]', /* i18n-ignore host-page selector */
      'button[aria-label*="مشاركة"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest(`#${TOPBAR_EXPORT_ID}`)) return el;
    }
    const buttons = Array.from(document.querySelectorAll("main button, header button"));
    return buttons.find((b) => /^(share|分享|مشاركة)$/i.test((b.textContent || "").trim())) || null; /* i18n-ignore host-page text */
  }

  function findTopbarFallbackContainer() {
    return document.querySelector("main .sticky .flex.items-center.gap-2") ||
           document.querySelector("#page-header") ||
           document.querySelector("main header") ||
           document.querySelector("header");
  }

  function buildTopbarExportButton() {
    const btn = document.createElement("button");
    try { btn.setAttribute("data-qelvynox", "1"); } catch {}
    btn.id = TOPBAR_EXPORT_ID;
    btn.className = "qelvynox-topbar-export";
    btn.type = "button";
    btn.title = T("topbar.exportTitle");
    btn.setAttribute("aria-label", T("topbar.exportTitle"));
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>${esc(T("topbar.export"))}</span>
    `;
    // Export never depends on the counter: it reads the live DOM directly.
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExportModal();
    });
    return btn;
  }

  function injectTopbarExportButton() {
    if (!appSettings.enabled) {
      const stale = document.getElementById(TOPBAR_EXPORT_ID);
      if (stale) stale.remove();
      return;
    }

    const existing = document.getElementById(TOPBAR_EXPORT_ID);

    if (existing) {
      // Already placed - re-verify its position at most every couple of
      // seconds. Looking the Share button up (several attribute-substring
      // selectors, then a text scan of every button) on every tick was
      // pure waste while nothing had moved.
      const now = Date.now();
      if (existing.parentNode && now - (injectTopbarExportButton.lastCheck || 0) < 2000) return;
      injectTopbarExportButton.lastCheck = now;
      const share = findShareButton();
      // React re-renders must not duplicate it.
      if (!share || existing.parentNode === share.parentNode) return;
      existing.remove();
    }

    const share = findShareButton();

    // Nothing to export yet (empty/new chat) - stay out of the way.
    const hasUserMessages = typeof countDomUserTurns === "function"
      ? countDomUserTurns() > 0
      : !!document.querySelector('[data-message-author-role="user"]');
    if (!hasUserMessages) return;

    const btn = buildTopbarExportButton();

    if (share && share.parentNode) {
      // [ Export ] [ Share ]
      share.parentNode.insertBefore(btn, share);
      return;
    }

    // Share may not exist yet, or at all (some temporary chats). Fall back to
    // the nearest top-bar actions container - never floating over messages.
    const container = findTopbarFallbackContainer();
    if (container) container.appendChild(btn);
    // If neither exists we simply retry on the next observer tick.
  }

  function stashScrollPosition() {
    try {
      const scrollEl = getChatScrollContainer();
      const firstVis = getFirstVisibleConversationTurn();
      const firstVisId = firstVis?.getAttribute("data-testid") || firstVis?.id || null;
      sessionStorage.setItem(SCROLL_RESTORE_KEY, JSON.stringify({
        url: window.location.href,
        y: window.scrollY,
        containerScrollTop: scrollEl ? scrollEl.scrollTop : 0,
        firstVisId
      }));
    } catch {}
  }

  function restoreScrollIfPending() {
    let pending = null;
    try {
      pending = safeJsonParse(sessionStorage.getItem(SCROLL_RESTORE_KEY), null);
    } catch {}
    if (!pending || pending.url !== window.location.href) return;
    sessionStorage.removeItem(SCROLL_RESTORE_KEY);
    const { y = 0, containerScrollTop = 0, firstVisId } = pending;
    const attempt = (tries) => {
      const scrollEl = getChatScrollContainer();
      if (firstVisId) {
        const target = document.querySelector(`[data-testid="${safeEscape(firstVisId)}"]`);
        if (target) {
          target.scrollIntoView({ block: "start", behavior: "instant" });
          return;
        }
      }
      if (scrollEl && containerScrollTop > 0) {
        scrollEl.scrollTop = containerScrollTop;
      }
      if (y > 0) {
        window.scrollTo(0, Math.min(y, document.body.scrollHeight));
      }
      if (tries > 0 && !firstVisId) {
        setTimeout(() => attempt(tries - 1), 250);
      }
    };
    setTimeout(() => attempt(8), 350);
  }

  // 2. Chat Outline (dialogue navigator)
  //
  // The navigator and the bookmarks list are dock-anchored popovers that open
  // on hover: no header, no tab strip, no close button - the dock icon already
  // says what each panel holds. Clicking pins one open so keyboard and touch
  // users (and anyone who wants to keep reading while moving the mouse) are
  // not left chasing a panel that disappears.
  let bookmarksScope = "current";

  const POPOVER_OPEN_MS = 120;
  const POPOVER_CLOSE_MS = 260;

  function createHoverPopover({ open, close }) {
    let openTimer = null;
    let closeTimer = null;
    let pinned = false;
    const cancel = () => {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    };
    const armOpen = () => {
      cancel();
      if (pinned) { open(); return; }
      openTimer = setTimeout(() => { openTimer = null; open(); }, POPOVER_OPEN_MS);
    };
    const armClose = () => {
      cancel();
      if (pinned) return;
      closeTimer = setTimeout(() => { closeTimer = null; close(); }, POPOVER_CLOSE_MS);
    };
    return {
      armOpen,
      armClose,
      isPinned: () => pinned,
      togglePin() {
        cancel();
        pinned = !pinned;
        if (pinned) open(); else close();
        return pinned;
      },
      forceClose() {
        cancel();
        pinned = false;
        close();
      },
      // The panel is rebuilt on every open, so its listeners come with it.
      bindPanel(panel) {
        panel.addEventListener("mouseenter", cancel);
        panel.addEventListener("mouseleave", armClose);
      }
    };
  }

  function setDockPinned(btn, pinned) {
    if (!btn) return;
    btn.classList.toggle("qelvynox-dock-btn-active", pinned);
    try { btn.setAttribute("aria-pressed", pinned ? "true" : "false"); } catch {}
  }

  function renderFloatingDock() {
    let dock = document.getElementById("qelvynox-floating-dock");
    // The dock is always present: the settings gear lives in it, and the
    // settings modal is the only in-page place where the booster itself can
    // be switched back on. Hiding it while disabled would lock the user out.
    const allUser = getUserMessageElements();
    const visibleUser = allUser.filter((el) => isTurnVisible(getTurnForMessageElement(el)));
    const userCount = visibleUser.length < allUser.length ? `${visibleUser.length}` : `${allUser.length}`;
    // Which buttons exist at all - and deliberately not the question count.
    // Rebuilding the dock for one new digit recreated every button, so the
    // pinned look, the hover state and the keyboard focus all disappeared the
    // moment a reply arrived.
    const signature = `${appSettings.enabled}|${appSettings.enableSearch}|${appSettings.enableOutline}|${appSettings.enableBookmarks !== false}`;

    if (!dock) {
      dock = markOwned(document.createElement("div"));
      dock.id = "qelvynox-floating-dock";
      dock.className = "qelvynox-floating-dock";
      document.body.appendChild(dock);
    }
    dock.classList.toggle("qelvynox-dark", isDarkTheme());
    if (qgstRoot) qgstApplyTheme();

    if (dock.dataset.sig === signature) {
      // Count-only change: patch the badge where it stands.
      updateOutlineBadge();
      return;
    }

    dock.dataset.sig = signature;
    dock.style.display = "flex";

    dock.innerHTML = `
      ${appSettings.enableSearch !== false ? `
        <button class="qelvynox-dock-btn" id="qelvynox-dock-search" title="${esc(T("dock.searchTitle"))}" aria-label="${esc(T("dock.search"))}">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>
      ` : ""}
      <button class="qelvynox-dock-btn" id="qelvynox-dock-export" title="${esc(T("dock.export"))}" aria-label="${esc(T("dock.export"))}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      </button>
      ${appSettings.enableOutline !== false ? `
        <button class="qelvynox-dock-btn" id="qelvynox-dock-outline" title="${esc(T("dock.outline"))}" aria-label="${esc(T("dock.outline"))}" aria-expanded="false">
          <span class="qelvynox-dock-bars"><i></i><i></i><i></i><i></i></span>
          <span class="qelvynox-dock-badge" title="${esc(T("dock.badgeShown", { visible: visibleUser.length, total: allUser.length }))}">${userCount}</span>
        </button>
      ` : ""}
      ${appSettings.enableBookmarks !== false ? `
        <button class="qelvynox-dock-btn" id="qelvynox-dock-bookmarks" title="${esc(T("dock.bookmarks"))}" aria-label="${esc(T("dock.bookmarks"))}" aria-expanded="false">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        </button>
      ` : ""}
      <div class="qelvynox-dock-sep"></div>
      <button class="qelvynox-dock-btn" id="qelvynox-dock-settings" title="${esc(T("dock.settings"))}" aria-label="${esc(T("dock.settings"))}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
    `;

    const searchBtn = dock.querySelector("#qelvynox-dock-search");
    if (searchBtn) searchBtn.addEventListener("click", toggleSearchOverlay);

    const exportBtn = dock.querySelector("#qelvynox-dock-export");
    if (exportBtn) exportBtn.addEventListener("click", () => openExportModal());

    const outlineBtn = dock.querySelector("#qelvynox-dock-outline");
    if (outlineBtn) {
      setDockPinned(outlineBtn, outlinePopover.isPinned());
      outlineBtn.addEventListener("mouseenter", outlinePopover.armOpen);
      outlineBtn.addEventListener("mouseleave", outlinePopover.armClose);
      outlineBtn.addEventListener("focus", outlinePopover.armOpen);
      outlineBtn.addEventListener("click", () => setDockPinned(outlineBtn, outlinePopover.togglePin()));
    }

    const bookmarksBtn = dock.querySelector("#qelvynox-dock-bookmarks");
    if (bookmarksBtn) {
      setDockPinned(bookmarksBtn, bookmarksPopover.isPinned());
      bookmarksBtn.addEventListener("mouseenter", bookmarksPopover.armOpen);
      bookmarksBtn.addEventListener("mouseleave", bookmarksPopover.armClose);
      bookmarksBtn.addEventListener("focus", bookmarksPopover.armOpen);
      bookmarksBtn.addEventListener("click", () => setDockPinned(bookmarksBtn, bookmarksPopover.togglePin()));
    }

    const settingsBtn = dock.querySelector("#qelvynox-dock-settings");
    if (settingsBtn) settingsBtn.addEventListener("click", () => openSettingsModal());

    updateDockViewportIndicator();
  }

  // The turn sitting nearest the middle of the viewport. Geometry only
  // (getBoundingClientRect), so it never forces a text read - and it drives
  // both the dock's bar map and the navigator's active row.
  function findCenterTurn() {
    const visible = getAllConversationTurns().filter(isTurnVisible);
    if (visible.length < 2) return visible[0] || null;
    const container = getChatScrollContainer();
    const cRect = container && container.getBoundingClientRect
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight || 0 };
    const mid = (cRect.top + cRect.bottom) / 2;
    let best = visible[0];
    let bestDist = Infinity;
    for (const el of visible) {
      if (typeof el.getBoundingClientRect !== "function") continue;
      const r = el.getBoundingClientRect();
      const dist = Math.abs((r.top + r.bottom) / 2 - mid);
      if (dist < bestDist) { bestDist = dist; best = el; }
    }
    return best;
  }

  // Which quarter of the conversation the viewport is reading, marked on the
  // dock's navigator button - the same cue the reference design uses for its
  // table-of-contents entry.
  function computeDockViewportIndex(centerTurn) {
    const visible = getAllConversationTurns().filter(isTurnVisible);
    if (visible.length < 2) return 0;
    const pos = centerTurn ? visible.indexOf(centerTurn) : -1;
    if (pos < 0) return 0;
    return Math.min(3, Math.floor((pos / visible.length) * 4));
  }

  function updateDockViewportIndicator() {
    const center = findCenterTurn();
    const bars = document.querySelectorAll("#qelvynox-dock-outline .qelvynox-dock-bars i");
    if (bars.length) {
      const active = computeDockViewportIndex(center);
      bars.forEach((bar, i) => bar.classList.toggle("qelvynox-bar-active", i === active));
    }
    markActiveTocItem(center);
  }

  // Scrolling fires far faster than anything needs repainting, and measuring
  // means reading turn geometry. Throttle to a few updates a second - this
  // extension has been burned before by per-frame layout work.
  const DOCK_INDICATOR_MS = 300;
  let dockIndicatorPending = null;
  function scheduleDockViewportIndicator() {
    const now = Date.now();
    if (!dockIndicatorPending || now - dockIndicatorPending.last >= DOCK_INDICATOR_MS) {
      dockIndicatorPending = { last: now };
      updateDockViewportIndicator();
      return;
    }
    // Trailing edge: the last position before the user stops must still land.
    if (dockIndicatorPending.timer) return;
    dockIndicatorPending.timer = setTimeout(() => {
      const state = dockIndicatorPending;
      dockIndicatorPending = null;
      if (state) { state.last = Date.now(); updateDockViewportIndicator(); }
    }, DOCK_INDICATOR_MS);
  }

  try {
    window.addEventListener("scroll", scheduleDockViewportIndicator, { passive: true, capture: true });
    window.addEventListener("resize", scheduleDockViewportIndicator, { passive: true });
  } catch {}

  // ChatGPT flips its own theme on <html> (data-theme / class) without any
  // event to hook. Watching that node is the only way our surfaces - which
  // are class-driven, not media-query-driven - stay in step with it.
  try {
    const themeObserver = new MutationObserver(() => {
      syncSurfaceTheme();
      qgstApplyTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"]
    });
  } catch {}

  // Keep every live floating surface (dock, popovers, search, export window) on
  // the same theme as ChatGPT; they are class-driven, not media-query-driven.
  function syncSurfaceTheme() {
    const dark = isDarkTheme();
    [
      "qelvynox-floating-dock",
      "qelvynox-floating-pill",
      "qelvynox-outline-popover",
      "qelvynox-bookmarks-popover",
      "qelvynox-search-overlay",
      "qelvynox-export-modal"
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("qelvynox-dark", dark);
    });
  }

  function updateOutlineBadge() {
    const badge = document.querySelector(".qelvynox-dock-badge");
    if (badge) {
      const allUser = getUserMessageElements();
      const visibleUser = allUser.filter((el) => isTurnVisible(getTurnForMessageElement(el)));
      badge.textContent = visibleUser.length < allUser.length ? `${visibleUser.length}` : `${allUser.length}`;
      badge.title = T("dock.badgeShown", { visible: visibleUser.length, total: allUser.length });
    }
  }

  function highlightTurn(el) {
    let curr = el;
    while (curr && curr !== document.body) {
      showTurnEl(curr);
      curr = curr.parentElement;
    }
    const parentTurn = getTurnForMessageElement(el) || el;
    showTurnEl(parentTurn);
    if (parentTurn.parentElement) showTurnEl(parentTurn.parentElement);

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    parentTurn.classList.add("qelvynox-highlight-turn");
    setTimeout(() => parentTurn.classList.remove("qelvynox-highlight-turn"), 2300);
    updateOutlineBadge();
  }

  function setDockExpanded(id, expanded) {
    const btn = document.getElementById(id);
    if (!btn) return;
    try { btn.setAttribute("aria-expanded", expanded ? "true" : "false"); } catch {}
    // Closing by hover-leave or Escape also clears the pinned look and the
    // pressed state - otherwise the button keeps claiming a panel that is gone.
    if (!expanded) setDockPinned(btn, false);
  }

  // Rows are keyed by the turn they point at, so the active row can follow the
  // viewport (a message bubble and its turn are different nodes).
  let outlineTurnNodes = [];

  function openOutlinePopover() {
    const existing = document.getElementById("qelvynox-outline-popover");
    // Already on screen - pinned, or the pointer came back before the close
    // timer fired. Refresh the rows in place: removing and re-adding the panel
    // replayed the pop-in animation and scrolled the list back to the top on
    // every pass, which read as the navigator "not updating".
    if (existing) {
      renderOutlineList(existing.querySelector("#qelvynox-outline-list"));
      return;
    }

    const pop = markOwned(document.createElement("div"));
    pop.id = "qelvynox-outline-popover";
    pop.className = "qelvynox-outline-popover" + (isDarkTheme() ? " qelvynox-dark" : "");
    pop.innerHTML = `<div class="qelvynox-pop-list" id="qelvynox-outline-list"></div>`;
    document.body.appendChild(pop);
    outlinePopover.bindPanel(pop);
    setDockExpanded("qelvynox-dock-outline", true);
    renderOutlineList(pop.querySelector("#qelvynox-outline-list"));
  }

  function closeOutlinePopover() {
    const el = document.getElementById("qelvynox-outline-popover");
    if (el) el.remove();
    setDockExpanded("qelvynox-dock-outline", false);
  }

  // Cheap identity for the list: how many questions there are, how many are
  // folded away, and what the most recent ones actually are. A count alone was
  // not enough - an edited prompt or a regenerated answer keeps the total the
  // same while the text behind the row changes.
  function outlineSignature(userTurns, hidden) {
    let sig = `${userTurns.length}|${hidden}`;
    for (let i = 0; i < userTurns.length; i++) {
      const el = userTurns[i];
      sig += JSON.stringify([getMessageIdFromElement(el) || "", (el.textContent || "").trim().slice(0, 75)]);
    }
    return sig;
  }

  function renderOutlineList(listEl) {
    if (!listEl) return;
    const userTurns = getUserMessageElements();
    const hidden = userTurns.map((el) => isTurnVisible(getTurnForMessageElement(el) || el) ? "0" : "1").join("");
    // Hover re-opens the panel constantly; rebuilding the whole list on every
    // pass would flicker and throw away the scroll position.
    const sig = outlineSignature(userTurns, hidden);
    if (listEl.dataset.sig === sig && listEl.childElementCount > 0) {
      markActiveTocItem(findCenterTurn());
      return;
    }
    listEl.dataset.sig = sig;
    const keepScroll = listEl.scrollTop;
    listEl.textContent = "";
    outlineTurnNodes = userTurns.map((turn) => getTurnForMessageElement(turn) || turn);

    if (!userTurns.length) {
      const empty = document.createElement("div");
      empty.className = "qelvynox-pop-empty";
      empty.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h7"></path></svg>';
      const line = document.createElement("span");
      line.textContent = T("outline.empty");
      empty.appendChild(line);
      listEl.appendChild(empty);
      return;
    }

    listEl.setAttribute("role", "list");
    listEl.setAttribute("aria-label", T("outline.listAria"));

    userTurns.forEach((turn, idx) => {
      const isHidden = !isTurnVisible(outlineTurnNodes[idx]);
      const item = document.createElement("div");
      item.className = "qelvynox-toc-item" + (isHidden ? " qelvynox-toc-hidden" : "");
      item.dataset.tocIdx = String(idx);
      // The panel is opened by hover, but it is used by keyboard too: without a
      // tab stop and an Enter handler the whole navigator is mouse-only.
      item.tabIndex = 0;
      item.setAttribute("role", "listitem");

      const role = document.createElement("span");
      role.className = "qelvynox-toc-role";
      role.textContent = T("role.you");

      const label = document.createElement("span");
      label.className = "qelvynox-toc-text";
      const text = turn.textContent.trim().slice(0, 75) || T("outline.questionFallback");
      label.textContent = text;

      item.append(role, label);

      if (isHidden) {
        const tag = document.createElement("span");
        tag.className = "qelvynox-toc-hidden-tag";
        tag.textContent = T("outline.hidden");
        item.appendChild(tag);
      }
      item.setAttribute("aria-label", `${text}${isHidden ? T("outline.hiddenAria") : ""}`);

      const go = () => {
        // Reserve the revealed turns so the limit enforcer does not fold them
        // back up the moment the jump lands.
        if (isHidden) manuallyUnhiddenTurnsCount += 2;
        highlightTurn(turn);
        outlinePopover.forceClose();
      };
      item.addEventListener("click", go);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      listEl.appendChild(item);
    });
    // A live chat grows at the bottom, so the rows above the reader must stay
    // exactly where they were; the active-row pass may then nudge the list.
    listEl.scrollTop = keepScroll;
    markActiveTocItem(findCenterTurn());
  }

  // The row for the turn nearest the viewport centre is marked and kept in
  // sight, so the panel reads as a position map while scrolling.
  function markActiveTocItem(centerTurn) {
    const list = document.querySelector("#qelvynox-outline-popover .qelvynox-pop-list");
    if (!list || !centerTurn || !outlineTurnNodes.length) return;
    const turns = getAllConversationTurns();
    const order = new Map();
    turns.forEach((turn, i) => order.set(turn, i));
    const centerPos = order.get(centerTurn);
    if (centerPos === undefined) return;
    // An assistant reply belongs to the question above it, so the active row is
    // the last question at or before the centre. Matching the centre turn
    // literally would blank the list whenever the middle of the screen is on a
    // reply - which is most of the time on a real chat.
    let idx = -1;
    for (let i = 0; i < outlineTurnNodes.length; i++) {
      const pos = order.get(outlineTurnNodes[i]);
      if (pos !== undefined && pos <= centerPos) idx = i;
    }
    const rows = list.querySelectorAll(".qelvynox-toc-item");
    let hit = null;
    if (idx >= 0) {
      rows.forEach((row) => {
        if (!hit && Number(row.dataset.tocIdx) === idx) hit = row;
      });
    }
    rows.forEach((row) => row.classList.toggle("qelvynox-toc-active", row === hit));
    if (!hit) return;
    // Scroll the list itself: scrollIntoView would also move the page under the
    // panel the user is hovering.
    const lr = list.getBoundingClientRect();
    const rr = hit.getBoundingClientRect();
    if (rr.top < lr.top || rr.bottom > lr.bottom) {
      list.scrollTop += (rr.top - lr.top) - lr.height / 2 + rr.height / 2;
    }
  }

  const BM_STAR_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
  const BM_X_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  function openBookmarksPopover() {
    const existing = document.getElementById("qelvynox-bookmarks-popover");
    // Same in-place refresh as the navigator: a panel that is already open is
    // re-read, never torn down and rebuilt.
    if (existing) {
      renderBookmarksList(existing.querySelector("#qelvynox-bookmarks-list"));
      return;
    }

    const pop = markOwned(document.createElement("div"));
    pop.id = "qelvynox-bookmarks-popover";
    pop.className = "qelvynox-bookmarks-popover" + (isDarkTheme() ? " qelvynox-dark" : "");
    pop.innerHTML = `
      <div class="qelvynox-pop-seg">
        <button type="button" class="qelvynox-seg-item ${bookmarksScope === "current" ? "active" : ""}" id="qelvynox-bm-scope-current" aria-pressed="${bookmarksScope === "current"}">${esc(T("bookmarks.scopeCurrent"))}</button>
        <button type="button" class="qelvynox-seg-item ${bookmarksScope === "all" ? "active" : ""}" id="qelvynox-bm-scope-all" aria-pressed="${bookmarksScope === "all"}">${esc(T("bookmarks.scopeAll"))}</button>
      </div>
      <div class="qelvynox-pop-list" id="qelvynox-bookmarks-list"></div>
    `;
    document.body.appendChild(pop);
    bookmarksPopover.bindPanel(pop);
    setDockExpanded("qelvynox-dock-bookmarks", true);

    const list = pop.querySelector("#qelvynox-bookmarks-list");
    const segCurrent = pop.querySelector("#qelvynox-bm-scope-current");
    const segAll = pop.querySelector("#qelvynox-bm-scope-all");
    // Switching scope repaints the list only. Re-opening the whole panel used
    // to lose the scroll position and re-run the entry animation.
    const setScope = (scope) => {
      if (bookmarksScope === scope) return;
      bookmarksScope = scope;
      segCurrent.classList.toggle("active", scope === "current");
      segAll.classList.toggle("active", scope === "all");
      segCurrent.setAttribute("aria-pressed", String(scope === "current"));
      segAll.setAttribute("aria-pressed", String(scope === "all"));
      renderBookmarksList(list);
    };
    segCurrent.addEventListener("click", () => setScope("current"));
    segAll.addEventListener("click", () => setScope("all"));
    renderBookmarksList(list);
  }

  function closeBookmarksPopover() {
    const el = document.getElementById("qelvynox-bookmarks-popover");
    if (el) el.remove();
    setDockExpanded("qelvynox-dock-bookmarks", false);
  }

  function collectAllBookmarks() {
    const all = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(BOOKMARKS_PREFIX)) continue;
      const cid = key.replace(BOOKMARKS_PREFIX, "");
      safeJsonParse(localStorage.getItem(key), []).forEach((b) => {
        all.push({ ...b, convId: cid, storageKey: key });
      });
    }
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return all;
  }

  function renderBookmarksList(listEl) {
    if (!listEl) return;
    const convId = getConversationId();
    const currentKey = convId ? BOOKMARKS_PREFIX + convId : null;
    const items = bookmarksScope === "all"
      ? collectAllBookmarks()
      : (currentKey ? safeJsonParse(localStorage.getItem(currentKey), []) : []);

    // Idempotent by design: the observer tick re-renders an open panel, and a
    // second call used to append the whole list underneath the first one.
    const sig = `${bookmarksScope}|${items.map((b) => b.id).join(",")}`;
    if (listEl.dataset.sig === sig) return;
    listEl.dataset.sig = sig;
    const keepScroll = listEl.scrollTop;
    listEl.textContent = "";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "qelvynox-pop-empty";
      empty.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
      const line = document.createElement("span");
      line.textContent = bookmarksScope === "all"
        ? T("bookmarks.emptyAll")
        : T("bookmarks.emptyCurrent");
      empty.appendChild(line);
      listEl.appendChild(empty);
      return;
    }

    items.forEach((bm) => {
      const item = document.createElement("div");
      item.className = "qelvynox-toc-item" + (bookmarksScope === "all" ? " qelvynox-toc-col" : "");

      const line = document.createElement("div");
      line.className = "qelvynox-toc-line";

      const star = document.createElement("span");
      star.className = "qelvynox-bm-star active";
      star.innerHTML = BM_STAR_SVG;

      const snippet = document.createElement("span");
      snippet.className = "qelvynox-toc-text";
      snippet.textContent = bm.snippet || T("bookmarks.snippetFallback");

      const del = document.createElement("button");
      del.type = "button";
      del.className = "qelvynox-pop-del";
      del.setAttribute("aria-label", T("bookmarks.delete"));
      del.title = T("bookmarks.delete");
      del.innerHTML = BM_X_SVG;

      line.append(star, snippet, del);
      item.appendChild(line);

      if (bookmarksScope === "all") {
        const meta = document.createElement("div");
        meta.className = "qelvynox-pop-meta";
        meta.textContent = T("bookmarks.chatPrefix") + (bm.title || bm.convId || T("bookmarks.unknownChat"));
        item.appendChild(meta);
      }

      item.addEventListener("click", (e) => {
        if (del.contains && e.target && del.contains(e.target)) return;
        if (bm.convId && bm.convId !== convId) {
          window.open("/c/" + bm.convId, "_blank");
          return;
        }
        jumpToBookmarkedMessage(bm);
      });

      del.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = bm.storageKey || currentKey;
        if (!key) return;
        const fresh = safeJsonParse(localStorage.getItem(key), []);
        const at = fresh.findIndex((f) => f.id === bm.id);
        if (at >= 0) {
          fresh.splice(at, 1);
          localStorage.setItem(key, JSON.stringify(fresh));
        }
        // The popover is our own DOM, so removing a pin never wakes the
        // observer - update the in-page star and the list from here instead.
        syncAllBookmarkButtons();
        renderBookmarksList(listEl);
      });

      listEl.appendChild(item);
    });
    listEl.scrollTop = Math.min(keepScroll, listEl.scrollHeight);
  }

  function jumpToBookmarkedMessage(bm) {
    const targetEl = bm.id ? document.querySelector(`[data-message-id="${safeEscape(bm.id)}"]`) : null;
    if (!targetEl) {
      toast(T("bookmarks.notLoaded"));
      return;
    }
    showTurnEl(targetEl);
    const wrapper = targetEl.closest ? targetEl.closest(".qelvynox-dom-hidden") : null;
    if (wrapper) showTurnEl(wrapper);
    highlightTurn(targetEl);
    bookmarksPopover.forceClose();
  }

  const outlinePopover = createHoverPopover({
    open: openOutlinePopover,
    close: closeOutlinePopover
  });
  const bookmarksPopover = createHoverPopover({
    open: openBookmarksPopover,
    close: closeBookmarksPopover
  });

  // Keeps an injected star's look and tooltip in step with stored bookmarks:
  // the bookmarks popover can delete a pin without a reload, and a stale gold
  // star would claim a bookmark that no longer exists.
  function syncBookmarkBtn(btn, bookmarks) {
    const id = btn.dataset.qgBmId;
    const on = !!id && bookmarks.some((b) => b.id === id);
    if (btn.classList.contains("active") !== on) btn.classList.toggle("active", on);
    const svg = btn.querySelector("svg");
    if (svg) {
      const fill = on ? "#eab308" : "none";
      const stroke = on ? "#eab308" : "currentColor";
      if (svg.getAttribute("fill") !== fill) svg.setAttribute("fill", fill);
      if (svg.getAttribute("stroke") !== stroke) svg.setAttribute("stroke", stroke);
    }
    const title = on ? T("bookmarks.saved") : T("bookmarks.saveThis");
    if (btn.title !== title) btn.title = title;
    return on;
  }

  function syncAllBookmarkButtons() {
    const convId = getConversationId();
    if (!convId) return;
    const bookmarks = safeJsonParse(localStorage.getItem(BOOKMARKS_PREFIX + convId), []);
    const sig = bookmarks.map((b) => b.id).join("|");
    document.querySelectorAll(".qelvynox-bookmark-btn").forEach((btn) => {
      syncBookmarkBtn(btn, bookmarks);
      btn.dataset.qgBmSig = sig;
    });
  }

  // 3. Response Bookmarks
  function injectBookmarkButtons() {
    if (!appSettings.enabled || appSettings.enableBookmarks === false) return;

    const assistantTurns = getAssistantMessageElements();
    const convId = getConversationId();
    if (!convId) return;

    const bookmarksKey = BOOKMARKS_PREFIX + convId;
    const bookmarks = safeJsonParse(localStorage.getItem(bookmarksKey), []);
    const bmSig = bookmarks.map((b) => b.id).join("|");

    assistantTurns.forEach((astTurn) => {
      const known = astTurn.querySelector(".qelvynox-bookmark-btn");
      if (known) {
        // Only re-read the button when the stored set actually changed, so the
        // per-tick pass stays a single attribute compare.
        if (known.dataset.qgBmSig !== bmSig) {
          syncBookmarkBtn(known, bookmarks);
          known.dataset.qgBmSig = bmSig;
        }
        return;
      }

      const actionsRow = astTurn.querySelector('div[class*="mt-"] div[class*="flex"], [class*="text-token-text-secondary"]');
      const container = actionsRow || astTurn;

      const msgId = astTurn.getAttribute("data-message-id") || Math.random().toString(36).slice(2);
      const isBookmarked = bookmarks.some(b => b.id === msgId);

      const btn = markOwned(document.createElement("button"));
      btn.className = `qelvynox-bookmark-btn ${isBookmarked ? 'active' : ''}`;
      btn.dataset.qgBmId = msgId;
      btn.dataset.qgBmSig = bmSig;
      btn.title = isBookmarked ? T("bookmarks.saved") : T("bookmarks.saveThis");
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${isBookmarked ? '#eab308' : 'none'}" stroke="${isBookmarked ? '#eab308' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        let bms = safeJsonParse(localStorage.getItem(bookmarksKey), []);
        const existIdx = bms.findIndex(b => b.id === msgId);
        if (existIdx >= 0) {
          bms.splice(existIdx, 1);
        } else {
          const snippet = astTurn.textContent.trim().slice(0, 80) || T("bookmarks.aiReplyFallback");
          bms.push({ id: msgId, snippet, timestamp: Date.now(), title: cleanTitle() });
        }
        localStorage.setItem(bookmarksKey, JSON.stringify(bms));
        btn.dataset.qgBmSig = bms.map((b) => b.id).join("|");
        syncBookmarkBtn(btn, bms);
        renderFloatingDock();
      });

      container.appendChild(btn);
    });
  }

  // 4. In-Chat Search (Alt + F)
  //
  // One keyword, painted in place: type and every occurrence in the
  // conversation gets highlighted, the first one is scrolled into view, Enter
  // walks the rest. The scope is everything loaded into the page - including
  // the turns the booster folded away, which are revealed on the way in.
  // There is no scope switch, no result list and no preview window.
  let searchActive = false;
  let searchMatches = [];
  let currentMatchIdx = 0;
  // Set while the bar is open so a page re-render can repaint the ranges.
  let searchRefresh = null;

  const SEARCH_HL_ALL = "qelvynox-search";
  const SEARCH_HL_ACTIVE = "qelvynox-search-active";

  function highlightApiSupported() {
    return typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";
  }

  function clearSearchHighlights() {
    if (!highlightApiSupported()) return;
    try {
      CSS.highlights.delete(SEARCH_HL_ALL);
      CSS.highlights.delete(SEARCH_HL_ACTIVE);
    } catch {}
  }

  // Every occurrence of `q` (already lower-cased) inside one turn, as live
  // ranges over its text nodes. Qelvynox's own UI is skipped so a keyword can
  // never match a panel label instead of the conversation.
  function collectRangesIn(turn, q) {
    const out = [];
    if (!turn || typeof document.createTreeWalker !== "function" || typeof Range !== "function") return out;
    const walker = document.createTreeWalker(turn, 4 /* SHOW_TEXT */, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent && parent.closest && parent.closest(OWNED_SELECTOR)) return 3; // REJECT
        return 1; // ACCEPT
      }
    });
    let node = walker.nextNode();
    while (node) {
      const hay = (node.nodeValue || "").toLowerCase();
      let at = hay.indexOf(q);
      while (at !== -1) {
        const range = document.createRange();
        try {
          range.setStart(node, at);
          range.setEnd(node, Math.min(node.length, at + q.length));
          out.push(range);
        } catch {}
        at = hay.indexOf(q, at + q.length);
      }
      node = walker.nextNode();
    }
    return out;
  }

  function collectTurnMatches(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const matches = [];
    getAllConversationTurns().forEach((turn) => {
      collectRangesIn(turn, q).forEach((range) => matches.push({ turn, range }));
    });
    return matches;
  }

  function toggleSearchOverlay() {
    searchActive = !searchActive;
    const existing = document.getElementById("qelvynox-search-overlay");
    if (existing) existing.remove();
    clearSearchHighlights();
    searchRefresh = null;
    searchMatches = [];
    currentMatchIdx = 0;
    if (!searchActive) return;

    const overlay = markOwned(document.createElement("div"));
    overlay.id = "qelvynox-search-overlay";
    overlay.className = "qelvynox-search-overlay" + (isDarkTheme() ? " qelvynox-dark" : "");
    overlay.innerHTML = `
      <div class="qelvynox-search-bar-row">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="qelvynox-search-input" id="qelvynox-search-input" placeholder="${esc(T("search.placeholder"))}" autocomplete="off" spellcheck="false" aria-label="${esc(T("search.inputAria"))}" aria-describedby="qelvynox-search-hint" autofocus />
        <span id="qelvynox-search-count" class="qelvynox-search-count" aria-live="polite">0 / 0</span>
        <button class="qelvynox-search-btn" id="qelvynox-search-prev" title="${esc(T("search.prevTitle"))}" aria-label="${esc(T("search.prev"))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <button class="qelvynox-search-btn" id="qelvynox-search-next" title="${esc(T("search.nextTitle"))}" aria-label="${esc(T("search.next"))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <button class="qelvynox-search-btn" id="qelvynox-search-close" title="${esc(T("search.closeTitle"))}" aria-label="${esc(T("search.close"))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="qelvynox-search-hint" id="qelvynox-search-hint"></div>
    `;

    document.body.appendChild(overlay);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", T("search.overlayAria"));

    const input = overlay.querySelector("#qelvynox-search-input");
    const countEl = overlay.querySelector("#qelvynox-search-count");
    const hintEl = overlay.querySelector("#qelvynox-search-hint");

    // The bar always carries its own legend: a user who opened it with the
    // mouse has no idea that Enter walks the matches, and a hint that only
    // appears once the keyword fails teaches nothing. It doubles as the
    // no-match notice, which keeps the bar one height instead of two.
    const HINT_LEGEND =
      '<span><i class="qelvynox-kbd">Enter</i>' + T("search.hintNext") + "</span>" +
      '<span><i class="qelvynox-kbd">Shift+Enter</i>' + T("search.hintPrev") + "</span>" +
      '<span><i class="qelvynox-kbd">Esc</i>' + T("search.close") + "</span>";
    const setCount = (text, hasMatch) => {
      countEl.textContent = text;
      overlay.classList.toggle("qelvynox-search-has-match", hasMatch);
    };
    hintEl.innerHTML = HINT_LEGEND;

    function paintAllRanges() {
      if (!highlightApiSupported()) return;
      try {
        CSS.highlights.set(SEARCH_HL_ALL, new Highlight(...searchMatches.map((m) => m.range)));
      } catch {}
    }

    function jumpToMatch(idx, options = {}) {
      if (!searchMatches.length) return;
      currentMatchIdx = (idx + searchMatches.length) % searchMatches.length;
      const match = searchMatches[currentMatchIdx];
      countEl.textContent = `${currentMatchIdx + 1} / ${searchMatches.length}`;
      if (highlightApiSupported()) {
        try { CSS.highlights.set(SEARCH_HL_ACTIVE, new Highlight(match.range)); } catch {}
      }
      // Reserve a revealed turn so the limit enforcer does not fold it straight
      // back up; without the Highlight API the pulse outline is the only cue.
      // Only for a real jump: a background repaint must not inflate the
      // reservation every time the page mutates.
      if (options.scroll !== false) {
        if (!isTurnVisible(match.turn)) manuallyUnhiddenTurnsCount += 2;
        highlightTurn(match.turn);
      }
    }

    function runSearch() {
      const q = input.value.trim();
      searchMatches = collectTurnMatches(q);
      if (!q) {
        setCount("0 / 0", false);
        hintEl.innerHTML = HINT_LEGEND;
        clearSearchHighlights();
        return;
      }
      if (!searchMatches.length) {
        // Clear both groups: leaving the previous active range painted would
        // contradict the "0 / 0" the counter just started showing.
        setCount("0 / 0", false);
        clearSearchHighlights();
        hintEl.textContent = hasOlderTurnsToLoad()
          ? T("search.noMatchLoading")
          : T("search.noMatch");
        return;
      }
      setCount(`1 / ${searchMatches.length}`, true);
      hintEl.innerHTML = HINT_LEGEND;
      paintAllRanges();
      jumpToMatch(0);
    }

    // ChatGPT re-rendered the page - or answered while the bar was open:
    // re-collect the ranges (the old ones point at detached nodes now) without
    // yanking the scroll position away from under the reader.
    searchRefresh = (options = {}) => {
      const q = input.value.trim();
      if (!q) return;
      searchMatches = collectTurnMatches(q);
      if (!searchMatches.length) {
        setCount("0 / 0", false);
        clearSearchHighlights();
        // Mid-stream the sentence is rewritten many times a second, so a
        // "nothing found" line flashing over a keyword that was matching a
        // moment ago is noise. Only a settled repaint is allowed to say it.
        if (!options.live) {
          hintEl.textContent = hasOlderTurnsToLoad()
            ? T("search.noMatchLoading")
            : T("search.noMatch");
        }
        return;
      }
      setCount(`${Math.min(currentMatchIdx, searchMatches.length - 1) + 1} / ${searchMatches.length}`, true);
      hintEl.innerHTML = HINT_LEGEND;
      paintAllRanges();
      jumpToMatch(Math.min(currentMatchIdx, searchMatches.length - 1), { scroll: false });
    };

    let inputDebounce = null;
    input.addEventListener("input", () => {
      clearTimeout(inputDebounce);
      inputDebounce = setTimeout(runSearch, 120);
    });

    overlay.querySelector("#qelvynox-search-next").addEventListener("click", () => jumpToMatch(currentMatchIdx + 1));
    overlay.querySelector("#qelvynox-search-prev").addEventListener("click", () => jumpToMatch(currentMatchIdx - 1));
    overlay.querySelector("#qelvynox-search-close").addEventListener("click", closeSearchOverlay);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        jumpToMatch(e.shiftKey ? currentMatchIdx - 1 : currentMatchIdx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        jumpToMatch(currentMatchIdx - 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSearchOverlay();
      }
    });

    // The bar must also close when the focus is elsewhere (a click on the page
    // moves it away from the input, so the input's own keydown never fires).
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeSearchOverlay(); }
    });

    input.focus();
  }

  function closeSearchOverlay() {
    searchActive = false;
    const el = document.getElementById("qelvynox-search-overlay");
    if (el) el.remove();
    clearSearchHighlights();
    searchRefresh = null;
    searchMatches = [];
    currentMatchIdx = 0;
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "f" || e.key === "F" || e.code === "KeyF")) {
      e.preventDefault();
      if (appSettings.enableSearch === false) return;
      toggleSearchOverlay();
    } else if (e.key === "Escape") {
      // A pinned popover has no close button by design, so Escape is its exit.
      outlinePopover.forceClose();
      bookmarksPopover.forceClose();
    }
  });

  // 5. Modern Pure Chat Exporter (selective + real DOCX)

  // --- Structured extraction -------------------------------------------
  //
  // innerText flattens everything: a rendered <pre><code> loses its fences,
  // links lose their href, tables and lists lose their shape. So the whole
  // export pipeline (and the .docx monospace path, which splits on ``` ) was
  // working on text that could never contain the markers it looked for.
  // We walk the DOM instead and rebuild real markdown.

  // ChatGPT's own UI chrome that must never end up inside an export.
  const EXPORT_SKIP = 'button,[role="button"],svg,form,select,textarea,.sr-only,[aria-hidden="true"]';

  function isSkippable(el) {
    return el.matches && el.matches(EXPORT_SKIP);
  }

  // One child of an inline run, rendered to markdown. Pulled out of
  // inlineMarkdown so domToBlocks can walk a mixed text/element container
  // without re-implementing (and drifting from) the wrapper rules.
  function inlineChild(child) {
    if (child.nodeType === 3) return child.nodeValue;
    if (child.nodeType !== 1 || isSkippable(child)) return "";

    const tag = child.tagName.toLowerCase();
    const inner = inlineMarkdown(child);
    if (tag === "br") return "\n";
    if (!inner.trim()) return "";

    if (tag === "code") return `\`${inner}\``;
    if (tag === "a") {
      const href = child.getAttribute("href") || "";
      return href ? `[${inner}](${href})` : inner;
    }
    if (tag === "strong" || tag === "b") return `**${inner}**`;
    if (tag === "em" || tag === "i") return `*${inner}*`;
    if (tag === "del" || tag === "s") return `~~${inner}~~`;
    return inner;
  }

  function inlineMarkdown(node) {
    let out = "";
    node.childNodes.forEach((child) => { out += inlineChild(child); });
    return out;
  }

  function tableToBlock(table) {
    const rows = [];
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = [];
      tr.querySelectorAll("th,td").forEach((cell) => {
        cells.push(inlineMarkdown(cell).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "));
      });
      if (cells.length) rows.push(cells);
    });
    return rows.length ? { type: "table", rows } : null;
  }

  function domToBlocks(root) {
    const blocks = [];

    const isBlockEl = (el) =>
      /^(pre|h[1-6]|ul|ol|table|blockquote|hr|p|div)$/.test(el.tagName.toLowerCase());

    // Children in document order: block children recurse, inline children and
    // bare text nodes join the paragraph around them. Walking only the element
    // children used to drop every loose text node, so an answer written as
    // "answer: <b>because</b> …" exported the single bold word and lost every
    // sentence next to it.
    const walkChildren = (el) => {
      let inline = "";
      const flush = () => {
        const text = inline.trim();
        if (text) blocks.push({ type: "text", text });
        inline = "";
      };
      Array.from(el.childNodes).forEach((node) => {
        if (node.nodeType === 1 && !isSkippable(node) && isBlockEl(node)) {
          flush();
          visit(node);
          return;
        }
        inline += inlineChild(node);
      });
      flush();
    };

    const visit = (el) => {
      if (el.nodeType !== 1 || isSkippable(el)) return;
      const tag = el.tagName.toLowerCase();

      if (tag === "pre") {
        const codeEl = el.querySelector("code") || el;
        const cls = codeEl.getAttribute("class") || "";
        const langMatch = /language-([\w+#.-]+)/.exec(cls);
        // textContent, not innerText: the language label and copy button that
        // ChatGPT renders above the code are separate elements.
        const text = (codeEl.textContent || "").replace(/\n+$/, "");
        if (text.trim()) blocks.push({ type: "code", lang: langMatch ? langMatch[1] : "", text });
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        const text = inlineMarkdown(el).trim();
        if (text) blocks.push({ type: "heading", level: Number(tag[1]), text });
        return;
      }
      if (tag === "ul" || tag === "ol") {
        const items = [];
        Array.from(el.children).forEach((li) => {
          if (li.tagName && li.tagName.toLowerCase() === "li" && !isSkippable(li)) {
            const text = inlineMarkdown(li).trim();
            if (text) items.push(text);
          }
        });
        if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
        return;
      }
      if (tag === "table") {
        const block = tableToBlock(el);
        if (block) blocks.push(block);
        return;
      }
      if (tag === "blockquote") {
        const text = inlineMarkdown(el).trim();
        if (text) blocks.push({ type: "quote", text });
        return;
      }
      if (tag === "hr") { blocks.push({ type: "divider" }); return; }

      walkChildren(el);
    };

    walkChildren(root);

    // User prompts are usually a single plain-text node with no structure.
    if (blocks.length === 0) {
      const fallback = (root.innerText || "").trim();
      if (fallback) blocks.push({ type: "text", text: fallback });
    }
    return blocks;
  }

  function blocksToMarkdown(blocks) {
    return blocks.map((b) => {
      switch (b.type) {
        case "heading": return `${"#".repeat(b.level)} ${b.text}`;
        case "code": return `\`\`\`${b.lang || ""}\n${b.text}\n\`\`\``;
        case "list":
          return b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join("\n");
        case "table": {
          const [head, ...rest] = b.rows;
          const sep = head.map(() => "---");
          return [head, sep, ...rest].map((r) => `| ${r.join(" | ")} |`).join("\n");
        }
        case "quote": return b.text.split("\n").map((l) => `> ${l}`).join("\n");
        case "divider": return "---";
        default: return b.text;
      }
    }).join("\n\n").trim();
  }

  function messageFromElement(el, role) {
    const blocks = domToBlocks(el);
    return { role, blocks, text: blocksToMarkdown(blocks) };
  }

  function extractConversationContent() {
    const turns = getAllConversationTurns();
    const messages = [];

    turns.forEach((turn) => {
      const userEl = turn.matches?.(USER_MESSAGE_SELECTOR) ? turn : turn.querySelector?.(USER_MESSAGE_SELECTOR);
      const astEl = turn.matches?.(ASSISTANT_MESSAGE_SELECTOR) ? turn : turn.querySelector?.(ASSISTANT_MESSAGE_SELECTOR);

      if (userEl) messages.push(messageFromElement(userEl, "User"));
      if (astEl) messages.push(messageFromElement(astEl, "ChatGPT"));
    });

    return { title: cleanTitle(), messages: messages.filter((m) => m.text) };
  }

  // --- Full conversation via the API (not limited by what is on screen) ---

  let fullExportWaiters = [];

  function requestFullConversation(timeoutMs = 610000) {
    return new Promise((resolve) => {
      const waiter = { resolve, done: false };
      fullExportWaiters.push(waiter);
      setTimeout(() => {
        if (!waiter.done) { waiter.done = true; resolve({ error: "timeout" }); }
      }, timeoutMs);
      try {
        window.postMessage({ type: "qelvynox-request-full-export" }, "*");
      } catch {
        waiter.done = true;
        resolve({ error: "bridge-unavailable" });
      }
    });
  }

  function conversationToMarkdown(title, messages, meta) {
    const roleLine = (role) => `### ${T(role === "User" ? "role.you" : "role.chatgpt")}${T("role.colon")}`;
    let md = `# ${title}\n\n`;
    md += `*${T("export.exportedAt", { time: new Date().toLocaleString() })}*  \n`;
    md += `*${T("export.messagesCount", { n: messages.length })}`;
    if (meta && meta.complete === false) md += T("export.incompleteSuffix", { why: meta.failureReason || T("export.unknownReason") });
    md += `*\n\n---\n\n`;
    messages.forEach((m) => { md += `${roleLine(m.role)}\n\n${m.text}\n\n`; });
    return md;
  }

  // A block the user pastes as the first message of a fresh chat so the model
  // picks up where the maxed-out conversation stopped.
  function buildContinuationPrompt(title, messages, turnCount) {
    const wanted = Math.max(1, turnCount || 10);
    // A "turn" is a user message plus whatever followed it.
    const userIdx = [];
    messages.forEach((m, i) => { if (m.role === "User") userIdx.push(i); });
    const start = userIdx.length > wanted ? userIdx[userIdx.length - wanted] : 0;
    const tail = messages.slice(start);

    let out = `${T("export.continuationIntro", { title })}\n\n`;
    out += T("export.continuationBody", { n: Math.min(wanted, userIdx.length) }) + T("sent.sep");
    out += `${T("export.continuationRule")}\n\n`;
    out += `---\n\n`;
    tail.forEach((m) => { out += `### ${T(m.role === "User" ? "role.you" : "role.chatgpt")}${T("role.colon")}\n\n${m.text}\n\n`; });
    out += `---\n\n${T("export.continuationTail")}\n`;
    return out;
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- Minimal ZIP (store, no compression) for genuine .docx output ---

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255];
    const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

    files.forEach((f) => {
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const nameB = enc.encode(f.name);
      const crc = crc32(data);
      const local = new Uint8Array([
        0x50, 0x4B, 0x03, 0x04,
        ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameB.length), ...u16(0)
      ]);
      chunks.push(local, nameB, data);
      central.push({ nameB, crc, size: data.length, offset });
      offset += local.length + nameB.length + data.length;
    });

    const centralStart = offset;
    let centralSize = 0;
    central.forEach((c) => {
      const rec = new Uint8Array([
        0x50, 0x4B, 0x01, 0x02,
        ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(c.crc), ...u32(c.size), ...u32(c.size),
        ...u16(c.nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(c.offset)
      ]);
      chunks.push(rec, c.nameB);
      centralSize += rec.length + c.nameB.length;
    });

    chunks.push(new Uint8Array([
      0x50, 0x4B, 0x05, 0x06,
      ...u16(0), ...u16(0),
      ...u16(central.length), ...u16(central.length),
      ...u32(centralSize), ...u32(centralStart),
      ...u16(0)
    ]));

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach((c) => { out.set(c, pos); pos += c.length; });
    return out;
  }

  // --- OOXML builders ---

  const xmlEsc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function docxParagraph(text, { bold = false, color = "1E293B", size = 22, mono = false, shaded = false, spacingBefore = 0 } = {}) {
    const pPr =
      `${shaded ? '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/><w:spacing w:before="' + spacingBefore + '" w:after="20"/></w:pPr>' :
       (spacingBefore ? `<w:pPr><w:spacing w:before="${spacingBefore}" w:after="20"/></w:pPr>` : "")}`;
    const monoFonts = mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : "";
    const boldTag = bold ? "<w:b/>" : "";
    const rPr = `<w:rPr>${monoFonts}${boldTag}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr>`;
    const runs = String(text ?? "").split("\n").map((line, i) =>
      (i > 0 ? "<w:r><w:br/></w:r>" : "") + `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`
    ).join("");
    return `<w:p>${pPr}${runs}</w:p>`;
  }

  function splitCodeSegments(text) {
    // Splits on ``` fences -> [{code:false,text},{code:true,text},...]
    const parts = String(text ?? "").split("```");
    return parts.map((seg, i) => ({
      code: i % 2 === 1,
      text: i % 2 === 1 ? seg.replace(/^[a-zA-Z0-9+#-]*\r?\n/, "") : seg
    })).filter(s => s.text.length > 0);
  }

  function buildDocx(title, messages) {
    let body = "";

    body += docxParagraph(title, { bold: true, color: "4338CA", size: 36 });
    body += docxParagraph(T("export.exportedAt", { time: new Date().toLocaleString() }), { color: "64748B", size: 18, spacingBefore: 40 });

    messages.forEach((m) => {
      const roleColor = m.role === "User" ? "4F46E5" : "047857";
      body += docxParagraph(`${T(m.role === "User" ? "role.you" : "role.chatgpt")}${T("role.colon")}`, { bold: true, color: roleColor, size: 24, spacingBefore: 160 });
      splitCodeSegments(m.text).forEach((seg) => {
        seg.code
          ? seg.text.split("\n").forEach(line => { body += docxParagraph(line, { mono: true, shaded: true, size: 19, color: "0F172A" }); })
          : (body += docxParagraph(seg.text, { size: 22, color: "1E293B" }));
      });
    });

    const documentXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

    const contentTypes =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

    return makeZip([
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rels },
      { name: "word/document.xml", data: documentXml }
    ]);
  }

  // Lucide-style line icons for the export window. Inline SVG on purpose: a
  // chrome-extension:// <img> is blocked by ChatGPT's own CSP.
  const exportIcon = (paths, size = 15) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  const EXPORT_ICONS = {
    x: exportIcon('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 16),
    archive: exportIcon('<rect x="2" y="4" width="20" height="5" rx="1"></rect><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"></path><path d="M10 13h4"></path>', 14),
    image: exportIcon('<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>'),
    fileText: exportIcon('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v5h5"></path><path d="M16 13H8"></path><path d="M16 17H8"></path>'),
    book: exportIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>', 14),
    link: exportIcon('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>'),
    printer: exportIcon('<polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect>'),
    code: exportIcon('<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>'),
    list: exportIcon('<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>'),
    braces: exportIcon('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"></path><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"></path>'),
    chevronRight: exportIcon('<polyline points="9 18 15 12 9 6"></polyline>', 13)
  };

  let exportModalKeyHandler = null;

  // One way out of the window for every caller: the Escape listener must not
  // outlive the node it was bound for.
  function closeExportModal() {
    const el = document.getElementById("qelvynox-export-modal");
    if (el) el.remove();
    if (exportModalKeyHandler) {
      document.removeEventListener("keydown", exportModalKeyHandler, true);
      exportModalKeyHandler = null;
    }
  }

  function openExportModal(autoAction) {
    closeExportModal();

    const extracted = extractConversationContent();
    const title = extracted.title;
    // Starts as what is rendered; replaced by the local archive once it is
    // loaded and holds more (ChatGPT only renders the turns near the
    // viewport, so the screen is a small slice of a long chat).
    let messages = extracted.messages;

    const modal = markOwned(document.createElement("div"));
    modal.id = "qelvynox-export-modal";
    modal.className = "qelvynox-modal-overlay" + (isDarkTheme() ? " qelvynox-dark" : "");

    modal.innerHTML = `
      <div class="qelvynox-modal-box">
        <div class="qelvynox-modal-header">
          <div class="qelvynox-modal-headtext">
            <span class="qelvynox-modal-title">${esc(T("exportModal.title"))}</span>
            <span class="qelvynox-modal-sub">
              <span>“${esc(title)}”</span>
              <span aria-hidden="true">·</span>
              <span id="qelvynox-export-count"></span>
              <button type="button" class="qelvynox-link-btn" id="qelvynox-select-all">${esc(T("exportModal.selectAll"))}</button>
              <span aria-hidden="true">·</span>
              <button type="button" class="qelvynox-link-btn" id="qelvynox-select-none">${esc(T("exportModal.selectNone"))}</button>
            </span>
          </div>
          <button type="button" id="qelvynox-modal-close" class="qelvynox-icon-btn" title="${esc(T("search.closeTitle"))}" aria-label="${esc(T("search.close"))}">${EXPORT_ICONS.x}</button>
        </div>
        <div class="qelvynox-modal-body">
          <div class="qelvynox-export-section">
            <div class="qelvynox-export-section-title">${esc(T("exportModal.pickSection"))}</div>
            <div class="qelvynox-export-card-hint" id="qelvynox-export-source" style="display:none;"></div>
            <div class="qelvynox-export-list" id="qelvynox-export-list"></div>
          </div>
          <div class="qelvynox-export-card qelvynox-local-archive-box">
            <div class="qelvynox-export-card-head">${EXPORT_ICONS.archive}${esc(T("exportModal.archiveCard"))}</div>
            <div class="qelvynox-export-card-hint" id="qelvynox-local-archive-info">${esc(T("exportModal.archiveChecking"))}</div>
            <div class="qelvynox-export-grid">
              <button type="button" class="qelvynox-export-option-btn qelvynox-local-btn" id="qelvynox-export-local-html" disabled>${EXPORT_ICONS.image}<span>${esc(T("exportModal.htmlImages"))}</span></button>
              <button type="button" class="qelvynox-export-option-btn qelvynox-local-btn" id="qelvynox-export-local-md" disabled>${EXPORT_ICONS.fileText}<span>${esc(T("exportModal.markdownText"))}</span></button>
            </div>
          </div>
          <div class="qelvynox-export-card">
            <div class="qelvynox-export-card-head">${EXPORT_ICONS.book}${esc(T("exportModal.serverCard"))}</div>
            <div class="qelvynox-export-card-hint">${esc(T("exportModal.serverHint"))}</div>
            <div class="qelvynox-export-grid qelvynox-export-grid-single">
              <button type="button" class="qelvynox-export-option-btn qelvynox-full-btn" id="qelvynox-export-full-md">${EXPORT_ICONS.link}<span>${esc(T("exportModal.fullMd"))}</span><span class="qelvynox-export-tail">${esc(T("exportModal.actionFetch"))} ${EXPORT_ICONS.chevronRight}</span></button>
              <button type="button" class="qelvynox-export-option-btn qelvynox-full-btn" id="qelvynox-export-continuation">${EXPORT_ICONS.link}<span>${esc(T("exportModal.continuation", { n: esc(String(appSettings.continuationTurns || 10)) }))}</span><span class="qelvynox-export-tail">${esc(T("exportModal.actionCopy"))} ${EXPORT_ICONS.chevronRight}</span></button>
            </div>
            <div class="qelvynox-export-card-hint" id="qelvynox-full-progress"></div>
          </div>
          <div class="qelvynox-export-section">
            <div class="qelvynox-export-section-title">${esc(T("exportModal.selectedSection"))}</div>
            <div class="qelvynox-export-grid">
              <button type="button" class="qelvynox-export-option-btn" id="qelvynox-export-word">${EXPORT_ICONS.fileText}<span>${esc(T("exportModal.word"))}</span></button>
              <button type="button" class="qelvynox-export-option-btn" id="qelvynox-export-pdf">${EXPORT_ICONS.printer}<span>${esc(T("exportModal.pdf"))}</span></button>
              <button type="button" class="qelvynox-export-option-btn" id="qelvynox-export-md">${EXPORT_ICONS.code}<span>${esc(T("exportModal.md"))}</span></button>
              <button type="button" class="qelvynox-export-option-btn" id="qelvynox-export-txt">${EXPORT_ICONS.list}<span>${esc(T("exportModal.txt"))}</span></button>
              <button type="button" class="qelvynox-export-option-btn" id="qelvynox-export-json">${EXPORT_ICONS.braces}<span>${esc(T("exportModal.json"))}</span></button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close must work from all three affordances - overlay, glyph and Escape -
    // and each of them has to unbind the document listener.
    modal.addEventListener("click", (e) => { if (e.target === modal) closeExportModal(); });
    modal.querySelector("#qelvynox-modal-close").addEventListener("click", closeExportModal);
    exportModalKeyHandler = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeExportModal();
    };
    document.addEventListener("keydown", exportModalKeyHandler, true);

    // Build selectable message rows safely (no innerHTML for user content)
    const listEl = modal.querySelector("#qelvynox-export-list");
    let checkboxes = [];

    function renderRows() {
    listEl.textContent = "";
    checkboxes = [];
    messages.forEach((m, idx) => {
      const row = document.createElement("label");
      row.className = "qelvynox-select-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.idx = String(idx);

      const role = document.createElement("span");
      role.className = `qelvynox-select-role ${m.role === "User" ? "user" : "chatgpt"}`;
      role.textContent = m.role === "User" ? T("role.you") : T("role.gptShort");

      const textSpan = document.createElement("span");
      textSpan.className = "qelvynox-select-text";
      textSpan.textContent = m.text.slice(0, 100) || T("export.emptyMessage");

      row.append(cb, role, textSpan);
      listEl.appendChild(row);
      cb.addEventListener("change", updateExportState);
      checkboxes.push(cb);
    });
    }
    renderRows();

    function selectedMessages() {
      const picked = messages.filter((_, i) => checkboxes[i]?.checked);
      return picked;
    }

    function updateExportState() {
      const n = selectedMessages().length;
      modal.querySelector("#qelvynox-export-count").textContent = T("export.selectedCount", { n });
      // Only the selective formats care about the tickboxes; the local-archive
      // and whole-conversation actions never do.
      modal.querySelectorAll('.qelvynox-export-option-btn:not(.qelvynox-local-btn):not(.qelvynox-full-btn)').forEach((b) => { b.disabled = n === 0; });
    }

    modal.querySelector("#qelvynox-select-all").addEventListener("click", () => {
      checkboxes.forEach(cb => { cb.checked = true; });
      updateExportState();
    });
    modal.querySelector("#qelvynox-select-none").addEventListener("click", () => {
      checkboxes.forEach(cb => { cb.checked = false; });
      updateExportState();
    });
    updateExportState();

    const fileBase = () => sanitizeFilename(title);

    modal.querySelector("#qelvynox-export-md").addEventListener("click", () => {
      const msgs = selectedMessages();
      let md = `# ${title}\n*${T("export.exportedAt", { time: new Date().toLocaleString() })}*\n\n---\n\n`;
      msgs.forEach(m => { md += `### ${T(m.role === "User" ? "role.you" : "role.chatgpt")}${T("role.colon")}\n${m.text}\n\n`; });
      downloadBlob(md, `${fileBase()}.md`, "text/markdown;charset=utf-8");
      closeExportModal();
    });

    modal.querySelector("#qelvynox-export-txt").addEventListener("click", () => {
      const msgs = selectedMessages();
      let txt = `${title}\n${T("export.exportedAt", { time: new Date().toLocaleString() })}\n\n========================================\n\n`;
      msgs.forEach(m => { txt += `[${T(m.role === "User" ? "role.you" : "role.chatgpt")}]\n${m.text}\n\n----------------------------------------\n\n`; });
      downloadBlob(txt, `${fileBase()}.txt`, "text/plain;charset=utf-8");
      closeExportModal();
    });

    modal.querySelector("#qelvynox-export-json").addEventListener("click", () => {
      const msgs = selectedMessages();
      const json = JSON.stringify({ title, exportedAt: new Date().toISOString(), messages: msgs.map(({ fromArchive, ...m }) => m) }, null, 2);
      downloadBlob(json, `${fileBase()}.json`, "application/json;charset=utf-8");
      closeExportModal();
    });

    modal.querySelector("#qelvynox-export-word").addEventListener("click", () => {
      const msgs = selectedMessages();
      const docxBytes = buildDocx(title, msgs);
      downloadBlob(docxBytes, `${fileBase()}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      closeExportModal();
    });

    // --- Whole-conversation actions (server-sourced) ---

    const progressEl = () => modal.querySelector("#qelvynox-full-progress");

    async function withFullConversation(button, run) {
      const original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span>${esc(T("export.fetchingFull"))}</span>`;
      if (progressEl()) progressEl().textContent = T("export.connecting");

      const result = await requestFullConversation();

      button.disabled = false;
      button.innerHTML = original;

      if (!result || result.error || !Array.isArray(result.messages) || result.messages.length === 0) {
        const why = failureReasonLabel(result?.error || "no-messages");
        if (progressEl()) progressEl().textContent = T("export.fetchFailed", { why });
        toast(T("export.cannotFull", { why }));
        return;
      }
      if (result.complete === false) {
        toast(T("export.onlyMessages", { n: result.messages.length, why: failureReasonLabel(result.failureReason) }));
      }
      if (progressEl()) {
        progressEl().textContent =
          T("export.pagesResult", { pages: result.pagesFetched + 1, messages: result.messages.length }) +
          (result.complete === false ? T("export.completeNo") : T("export.completeYes"));
      }
      run(result);
    }

    modal.querySelector("#qelvynox-export-full-md").addEventListener("click", (ev) => {
      withFullConversation(ev.currentTarget, (result) => {
        const md = conversationToMarkdown(title, result.messages, result);
        downloadBlob(md, `${fileBase()}-full.md`, "text/markdown;charset=utf-8");
      });
    });

    modal.querySelector("#qelvynox-export-continuation").addEventListener("click", async (ev) => {
      const button = ev.currentTarget;
      // The prompt only needs the last N turns, and the local archive always
      // holds the newest turns: no multi-minute server walk needed.
      const turnsWanted = Math.max(1, appSettings.continuationTurns || 10);
      await archiveSyncLatestIfNeeded();
      const local = await getArchiveForCurrentChat();
      if (local) {
        const msgs = archiveExportMessages(local);
        const users = msgs.filter((m) => m.role === "User").length;
        if (local.reachedStart || users >= turnsWanted) {
          const prompt = buildContinuationPrompt(title, msgs, turnsWanted);
          try {
            await navigator.clipboard.writeText(prompt);
            toast(T("export.continuationFromArchive"));
          } catch {
            downloadBlob(prompt, `${fileBase()}-continuation.md`, "text/markdown;charset=utf-8");
            toast(T("export.clipboardFallback"));
          }
          return;
        }
      }
      withFullConversation(button, async (result) => {
        const prompt = buildContinuationPrompt(title, result.messages, appSettings.continuationTurns || 10);
        try {
          await navigator.clipboard.writeText(prompt);
          toast(T("export.continuationCopied"));
        } catch {
          downloadBlob(prompt, `${fileBase()}-continuation.md`, "text/markdown;charset=utf-8");
          toast(T("export.clipboardFallback"));
        }
      });
    });

    // Opened straight onto one of its own actions (from the settings panel's
    // "完整对话" buttons): everything still runs through this window, so the
    // progress line and the honest failure reasons are never bypassed.
    if (autoAction) {
      const target = modal.querySelector(autoAction);
      if (target) setTimeout(() => target.click(), 0);
    }

    initLocalArchiveExport(modal, title, fileBase, (a) => {
      const archived = archiveExportMessages(a).map((m) => ({ ...m, fromArchive: true }));
      if (archived.length <= messages.length) return;
      const onScreen = messages.length;
      messages = archived;
      renderRows();
      updateExportState();
      const src = modal.querySelector("#qelvynox-export-source");
      if (src) {
        src.textContent = T("export.archiveListed", { n: archived.length, onScreen }) +
          (a.reachedStart ? "" : T("export.olderStillSaving"));
        src.style.display = "block";
      }
    });

    modal.querySelector("#qelvynox-export-pdf").addEventListener("click", () => {
      const msgs = selectedMessages();
      closeExportModal();
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        toast(T("export.popupBlocked"));
        return;
      }
      let html = `
        <html lang="${htmlLang()}">
        <head>
          <meta charset="utf-8">
          <title>${esc(title)}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 30px; color: #1e293b; line-height: 1.6; }
            h1 { color: #3f3f46; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
            .turn { margin-bottom: 24px; padding: 14px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0; }
            .role { font-weight: 800; font-size: 13px; color: #71717a; margin-bottom: 6px; }
            .content { white-space: pre-wrap; font-size: 13px; word-break: break-word; }
            code { font-family: Consolas, Menlo, monospace; background: #fafafa; padding: 2px 4px; border-radius: 4px; }
            pre { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; overflow-x: auto; }
            pre code { background: none; padding: 0; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
            table { border-collapse: collapse; font-size: 12px; margin: 8px 0; }
            blockquote { border-left: 3px solid #d4d4d8; margin: 8px 0; padding-left: 10px; color: #475569; }
            .md { font-size: 13px; word-break: break-word; }
            .md > :first-child { margin-top: 0; }
          </style>
        </head>
        <body>
          <h1>${esc(title)}</h1>
          <p style="color:#64748b;font-size:12px;">${esc(T("export.exportedAt", { time: new Date().toLocaleString() }))}</p>
      `;
      msgs.forEach(m => {
        // Render real <pre><code> so the monospace/shaded styling above
        // actually applies instead of being dead CSS over flattened text.
        const bodyHtml = Array.isArray(m.blocks) && m.blocks.length
          ? m.blocks.map((b) => {
              if (b.type === "code") {
                return `<pre><code>${esc(b.text)}</code></pre>`;
              }
              if (b.type === "heading") return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
              if (b.type === "list") {
                const tag = b.ordered ? "ol" : "ul";
                return `<${tag}>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>`;
              }
              if (b.type === "table") {
                return `<table border="1" cellspacing="0" cellpadding="4">${
                  b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")
                }</table>`;
              }
              if (b.type === "quote") return `<blockquote>${esc(b.text)}</blockquote>`;
              if (b.type === "divider") return "<hr>";
              return `<div class="content">${esc(b.text)}</div>`;
            }).join("")
          : (m.fromArchive && Archive
            ? `<div class="md" dir="auto">${Archive.renderMarkdown(m.text)}</div>`
            : `<div class="content">${esc(m.text)}</div>`);
        html += `<div class="turn"><div class="role">${esc(T(m.role === "User" ? "role.you" : "role.chatgpt"))}</div>${bodyHtml}</div>`;
      });
      html += `<script>window.onload = () => { window.print(); };<\/script></body></html>`;
      printWindow.document.write(html);
      printWindow.document.close();
    });
  }

  // 7. Local conversation archive
  //
  // See src/content/archive.js for the model. This part feeds it: server
  // snapshots from mainWorld, finished messages and images from the page,
  // and missing images through ChatGPT's own file endpoint. All archive
  // work is serialised through one promise chain so an async storage load
  // can never interleave with a concurrent update and lose a message.

  const Archive = globalThis.QelvynoxArchive || null;
  const ARCHIVE_SAVE_DEBOUNCE_MS = 1200;
  const ARCHIVE_LIVE_WINDOW = 6;
  const ARCHIVE_RESOLVE_DELAY_MS = 4000;
  const ARCHIVE_RESOLVE_SPACING_MS = 600;
  const ARCHIVE_RESOLVE_MAX_PER_PASS = 40;

  const archiveState = {
    convId: null,
    archive: null,
    dirty: false,
    saveTimer: null,
    resolveTimer: null,
    domSig: new Map(),
    seenImages: new Set(),
    attemptedResolve: new Set(),
    // When the newest page last came from the server, and when a reply last
    // finished; an export syncs first only if a reply is newer.
    latestSnapshot: { convId: null, at: 0 },
    streamEnd: { convId: null, at: 0 }
  };
  let archiveChain = Promise.resolve();
  const imageResolveWaiters = new Map();
  let imageResolveSeq = 0;

  function archiveEnabled() {
    return !!Archive && appSettings.enableLocalArchive !== false;
  }

  function archiveRun(task) {
    const next = archiveChain.then(task).catch(() => {});
    archiveChain = next;
    return next;
  }

  async function archiveFlushNow() {
    if (archiveState.saveTimer) {
      clearTimeout(archiveState.saveTimer);
      archiveState.saveTimer = null;
    }
    if (!archiveState.archive || !archiveState.dirty) return;
    archiveState.dirty = false;
    await Archive.saveConversation(archiveState.archive);
  }

  function archiveMarkDirty() {
    archiveState.dirty = true;
    if (archiveState.saveTimer) clearTimeout(archiveState.saveTimer);
    archiveState.saveTimer = setTimeout(() => archiveRun(archiveFlushNow), ARCHIVE_SAVE_DEBOUNCE_MS);
  }

  // Must only be called from inside archiveRun().
  async function archiveEnsure(convId) {
    if (archiveState.convId === convId && archiveState.archive) return archiveState.archive;
    await archiveFlushNow();
    archiveState.convId = convId;
    archiveState.domSig = new Map();
    archiveState.archive = (await Archive.loadConversation(convId)) || Archive.emptyArchive(convId);
    return archiveState.archive;
  }

  function archiveIngestSnapshot(payload) {
    if (!archiveEnabled() || !payload || !payload.conversationId || !Array.isArray(payload.messages)) return;
    archiveRun(async () => {
      await settingsReady;
      if (!archiveEnabled()) return;
      const a = await archiveEnsure(payload.conversationId);
      a.messages = Archive.mergeMessages(a.messages, payload.messages, { complete: payload.complete === true });
      if (payload.title) a.title = payload.title;
      a.lastServerSyncAt = Date.now();
      if (payload.complete === true) {
        a.serverComplete = true;
        a.reachedStart = true;
      }
      Archive.updateHistoryCursor(a, payload);
      // Pages that carry the chat title are newest pages (opening request,
      // refresh, full export); older history pages are posted without it.
      if (payload.title !== null && payload.title !== undefined) {
        archiveState.latestSnapshot = { convId: payload.conversationId, at: Date.now() };
      }
      archiveState.dirty = true;
      await archiveFlushNow();
      archiveScheduleResolve(payload.conversationId);
      archiveScheduleBackfill(payload.conversationId);
    });
  }

  // History fill: ask mainWorld to walk older pages from the oldest one
  // saved. Throttled there (one page per 1.5s); here it is started at most
  // once at a time per chat, a few seconds after the chat settles, and
  // stopped for the session on any server refusal.
  const ARCHIVE_BACKFILL_DELAY_MS = 6000;
  const ARCHIVE_BACKFILL_PAGES_PER_RUN = 40;
  const backfillState = { timer: null, running: null, stoppedFor: new Set() };

  function archiveScheduleBackfill(convId) {
    if (backfillState.timer) clearTimeout(backfillState.timer);
    backfillState.timer = setTimeout(() => {
      backfillState.timer = null;
      const a = archiveState.convId === convId ? archiveState.archive : null;
      if (!archiveEnabled() || !a || a.reachedStart || !a.oldestCursor) return;
      if (backfillState.running === convId || backfillState.stoppedFor.has(convId)) return;
      if (getConversationId() !== convId) return;
      backfillState.running = convId;
      try {
        window.postMessage({
          type: "qelvynox-archive-backfill",
          conversationId: convId,
          before: a.oldestCursor,
          maxPages: ARCHIVE_BACKFILL_PAGES_PER_RUN
        }, "*");
      } catch {
        backfillState.running = null;
      }
    }, ARCHIVE_BACKFILL_DELAY_MS);
  }

  function archiveOnBackfillDone(result) {
    if (!result || !result.conversationId) return;
    if (backfillState.running === result.conversationId) backfillState.running = null;
    if (result.error && result.error !== "walk-in-flight") {
      // Refused, rate-limited or navigated away: keep what was saved and
      // resume on the next visit, never hammer the server.
      backfillState.stoppedFor.add(result.conversationId);
      return;
    }
    if (result.more || result.error === "walk-in-flight") {
      // Queued behind the pages still being ingested.
      archiveRun(async () => { archiveScheduleBackfill(result.conversationId); });
    }
  }

  let archiveCaptureScheduled = false;
  function scheduleArchiveCapture() {
    if (!archiveEnabled() || archiveCaptureScheduled) return;
    archiveCaptureScheduled = true;
    const run = () => {
      archiveCaptureScheduled = false;
      archiveCaptureLive();
    };
    // Idle time only: archiving must never compete with typing or scrolling.
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 250);
  }

  function collectDomImages() {
    const out = [];
    const imgs = document.querySelectorAll('[data-turn-key] img, [data-testid^="conversation-turn"] img, article img');
    imgs.forEach((img) => {
      if (img.closest(OWNED_SELECTOR)) return;
      // Not loaded yet (lazy or inside a hidden turn): picked up later, or
      // through the file endpoint.
      if (!img.complete || !img.naturalWidth) return;
      // Avatars, favicons, icons.
      if (img.naturalWidth < 64 && img.naturalHeight < 64) return;
      const src = img.currentSrc || img.src;
      if (!src || /^data:image\/svg/i.test(src)) return;
      const key = Archive.imageKeyForUrl(src);
      if (!key || archiveState.seenImages.has(key)) return;
      const turn = getTurnForMessageElement(img);
      const holder = img.closest("[data-message-id], [data-chatgpt-search-message-ids]") ||
        (turn ? turn.querySelector("[data-message-id], [data-chatgpt-search-message-ids]") : null);
      const messageId = getMessageIdFromElement(holder || turn);
      if (!messageId) return;
      const roleNode = img.closest("[data-message-author-role], [data-content-search-unit-key], [data-user-message-bubble], [data-markdown-text-style]") || holder || turn;
      const roleAttr = roleNode?.getAttribute?.("data-message-author-role") || "";
      const searchKey = roleNode?.getAttribute?.("data-content-search-unit-key") || "";
      const role = roleAttr || (/:user$/.test(searchKey) || roleNode?.matches?.("[data-user-message-bubble]") ? "user" : "assistant");
      out.push({
        key,
        src,
        messageId,
        direct: holder?.getAttribute?.("data-message-id") === messageId,
        role,
        width: img.naturalWidth,
        height: img.naturalHeight
      });
    });
    return out;
  }

  /**
   * Which page-captured messages may be written to the archive.
   * - An id read for both a question and its reply in one pass is ambiguous.
   * - An id the server already confirmed must keep its role.
   * - An id that is not the element's own data-message-id (a search
   *   attribute or turn key) is trusted only for a server-confirmed message.
   */
  function archiveTrustedUpdates(updates, knownRole) {
    const batchRole = new Map();
    for (const u of updates) {
      const r = batchRole.get(u.message.id);
      batchRole.set(u.message.id, r && r !== u.message.role ? "conflict" : u.message.role);
    }
    return updates.filter((u) => {
      const id = u.message.id;
      const known = knownRole.get(id);
      if (batchRole.get(id) === "conflict") return false;
      if (known && known !== u.message.role) return false;
      if (!known && !u.direct) return false;
      return true;
    });
  }

  /**
   * Capture finished messages from the page. By default only the newest few
   * (the ones that can be new since the last server snapshot); `all` walks
   * every message element, used right before a local export.
   */
  function archiveCaptureLive(opts = {}) {
    if (!archiveEnabled()) return Promise.resolve();
    const convId = getConversationId();
    if (!convId || isTemporaryChat()) return Promise.resolve();
    if (isStreamingNow()) return Promise.resolve();

    const els = [];
    for (const turn of getAllConversationTurns()) {
      const userEl = turn.matches?.(USER_MESSAGE_SELECTOR) ? turn : turn.querySelector?.(USER_MESSAGE_SELECTOR);
      const astEl = turn.matches?.(ASSISTANT_MESSAGE_SELECTOR) ? turn : turn.querySelector?.(ASSISTANT_MESSAGE_SELECTOR);
      if (userEl && !userEl.closest(OWNED_SELECTOR)) els.push({ el: userEl, role: "user" });
      if (astEl && !astEl.closest(OWNED_SELECTOR)) els.push({ el: astEl, role: "assistant" });
    }
    const start = opts.all ? 0 : Math.max(0, els.length - ARCHIVE_LIVE_WINDOW);
    const updates = [];
    const sameConv = archiveState.convId === convId;
    for (let i = start; i < els.length; i++) {
      const item = els[i];
      const el = item.el;
      const id = getMessageIdFromElement(el);
      if (!id) continue;
      // Cheap change detector: rebuilding markdown for unchanged messages on
      // every tick would be wasted work.
      const sig = (el.textContent || "").length;
      if (sameConv && archiveState.domSig.get(id) === sig) continue;
      const msg = messageFromElement(el, item.role === "user" ? "User" : "ChatGPT");
      if (!msg.text) continue;
      updates.push({
        direct: el.getAttribute?.("data-message-id") === id,
        sig,
        pos: {
          prevId: i > 0 ? getMessageIdFromElement(els[i - 1].el) : null,
          nextId: i + 1 < els.length ? getMessageIdFromElement(els[i + 1].el) : null
        },
        message: { id, role: msg.role, text: msg.text, origin: "dom", capturedAt: Date.now(), images: [] }
      });
    }
    const images = collectDomImages();
    if (updates.length === 0 && images.length === 0) return Promise.resolve();
    images.forEach((im) => archiveState.seenImages.add(im.key));

    return archiveRun(async () => {
      await settingsReady;
      if (!archiveEnabled()) return;
      const a = await archiveEnsure(convId);
      // Only a message's own data-message-id is known to be the server id.
      // The current renderer may expose ids only through search attributes
      // or the turn key, which a question and its reply can share; trusting
      // those would merge the two, flip a role, or add a duplicate. Such ids
      // are used only for messages the server already confirmed with the
      // same role; anything else comes from the latest-page refresh.
      const knownRole = new Map(a.messages.map((m) => [m.id, m.role]));
      for (const u of updates) archiveState.domSig.set(u.message.id, u.sig);
      const trusted = archiveTrustedUpdates(updates, knownRole);
      for (const u of trusted) a.messages = Archive.upsertMessage(a.messages, u.message, u.pos);
      if (trusted.length) archiveMarkDirty();
      for (const im of images) {
        const known = knownRole.get(im.messageId);
        const role = im.role === "user" ? "User" : "ChatGPT";
        if ((known && known !== role) || (!known && !im.direct)) {
          // Retry on a later tick, once the refresh has confirmed the id.
          archiveState.seenImages.delete(im.key);
          continue;
        }
        const ref = { key: im.key, width: im.width, height: im.height };
        if (!(await Archive.hasImage(im.key))) {
          const data = await fetchImageAsDataUrl(im.src);
          if (!data) { archiveState.seenImages.delete(im.key); continue; }
          const rec = await Archive.saveImage(im.key, {
            dataUrl: data.dataUrl, mime: data.mime, width: im.width, height: im.height, source: "page"
          });
          if (!rec) continue;
          ref.hash = rec.hash;
        }
        a.messages = Archive.attachImage(a.messages, im.messageId, ref, { role: im.role });
        archiveMarkDirty();
      }
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      try {
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      } catch {
        resolve(null);
      }
    });
  }

  async function fetchImageAsDataUrl(src) {
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
      return { dataUrl: src, mime: src.slice(5, src.indexOf(";")) };
    }
    // Same-origin and blob: images are readable straight from the page.
    try {
      const u = new URL(src, window.location.href);
      if (u.protocol === "blob:" || u.origin === window.location.origin) {
        const res = await fetch(u.href, { credentials: "include" });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 0 && blob.size <= Archive.MAX_IMAGE_BYTES) {
            const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
            const mime = Archive.sniffImageMime(head) || (/^image\//.test(blob.type) ? blob.type : null);
            if (mime) {
              const dataUrl = await blobToDataUrl(blob.type === mime ? blob : new Blob([blob], { type: mime }));
              if (dataUrl) return { dataUrl, mime };
            }
          }
        }
        if (u.protocol === "blob:") return null;
      }
    } catch {}
    // Cross-origin file hosts: fetched by the service worker.
    try {
      const resp = await chrome.runtime.sendMessage({ type: "QELVYNOX_FETCH_IMAGE", url: src });
      if (resp && resp.dataUrl) return resp;
    } catch {}
    return null;
  }

  function requestImageUrl(pointer, conversationId) {
    return new Promise((resolve) => {
      const requestId = `img-${Date.now()}-${++imageResolveSeq}`;
      const timer = setTimeout(() => {
        imageResolveWaiters.delete(requestId);
        resolve(null);
      }, 15000);
      imageResolveWaiters.set(requestId, (url) => { clearTimeout(timer); resolve(url); });
      try {
        window.postMessage({ type: "qelvynox-resolve-image", requestId, pointer, conversationId }, "*");
      } catch {
        clearTimeout(timer);
        imageResolveWaiters.delete(requestId);
        resolve(null);
      }
    });
  }

  function archiveScheduleResolve(convId) {
    if (archiveState.resolveTimer) clearTimeout(archiveState.resolveTimer);
    // Give the page a head start: images it renders are captured for free.
    archiveState.resolveTimer = setTimeout(() => {
      archiveState.resolveTimer = null;
      archiveResolveMissing(convId);
    }, ARCHIVE_RESOLVE_DELAY_MS);
  }

  // Runs outside the archive chain (it waits on the network); each result
  // re-enters the chain only for the quick attach-and-save step.
  async function archiveResolveMissing(convId) {
    if (!archiveEnabled() || archiveState.convId !== convId || !archiveState.archive) return;
    const pending = [];
    for (const m of archiveState.archive.messages) {
      for (const im of m.images || []) {
        if (!im.pointer || archiveState.attemptedResolve.has(im.key)) continue;
        pending.push({ messageId: m.id, ref: im });
      }
    }
    let done = 0;
    for (const item of pending) {
      if (done >= ARCHIVE_RESOLVE_MAX_PER_PASS) break;
      if (archiveState.convId !== convId) return;
      archiveState.attemptedResolve.add(item.ref.key);
      if (await Archive.hasImage(item.ref.key)) continue;
      done++;
      const url = await requestImageUrl(item.ref.pointer, convId);
      const data = url ? await fetchImageAsDataUrl(url) : null;
      if (data) {
        await archiveRun(async () => {
          const rec = await Archive.saveImage(item.ref.key, {
            dataUrl: data.dataUrl, mime: data.mime,
            width: item.ref.width || null, height: item.ref.height || null, source: "file-endpoint"
          });
          if (!rec || archiveState.convId !== convId) return;
          archiveState.archive.messages = Archive.attachImage(
            archiveState.archive.messages, item.messageId, { ...item.ref, hash: rec.hash }
          );
          archiveMarkDirty();
        });
      }
      await new Promise((r) => setTimeout(r, ARCHIVE_RESOLVE_SPACING_MS));
    }
  }

  // Export modal: the local archive section.
  // ---- Archive helpers shared by search, continuation and export ----

  async function getArchiveForCurrentChat() {
    if (!archiveEnabled()) return null;
    const convId = getConversationId();
    if (!convId || isTemporaryChat()) return null;
    let a = null;
    await archiveRun(async () => {
      await settingsReady;
      if (!archiveEnabled()) return;
      a = await archiveEnsure(convId);
    });
    return a && Array.isArray(a.messages) && a.messages.length ? a : null;
  }

  function archiveExportMessages(a) {
    const out = [];
    for (const m of (a && a.messages) || []) {
      const text = Archive.cleanChatText(m.text || "").trim();
      if (text) out.push({ role: m.role === "User" ? "User" : "ChatGPT", text });
    }
    return out;
  }

  const refreshWaiters = new Map();
  let refreshSeq = 0;
  let refreshTimer = null;

  function archiveRequestRefresh(convId, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const requestId = `rf-${Date.now()}-${++refreshSeq}`;
      const timer = setTimeout(() => {
        refreshWaiters.delete(requestId);
        resolve({ error: "timeout" });
      }, timeoutMs);
      refreshWaiters.set(requestId, (payload) => { clearTimeout(timer); resolve(payload || {}); });
      try {
        window.postMessage({ type: "qelvynox-archive-refresh", requestId, conversationId: convId }, "*");
      } catch {
        clearTimeout(timer);
        refreshWaiters.delete(requestId);
        resolve({ error: "bridge" });
      }
    });
  }

  function archiveOnRefreshDone(payload) {
    if (!payload || !payload.requestId) return;
    const waiter = refreshWaiters.get(payload.requestId);
    if (!waiter) return;
    refreshWaiters.delete(payload.requestId);
    // The snapshot was posted before this reply: resolve only once it has
    // been merged and saved.
    archiveRun(async () => {}).then(() => waiter(payload));
  }

  function archiveScheduleRefresh(convId, delayMs, retriesLeft = 3) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (!archiveEnabled() || getConversationId() !== convId) return;
      const r = await archiveRequestRefresh(convId, 20000);
      if (r && (r.error === "throttled" || r.error === "busy") && retriesLeft > 0) {
        archiveScheduleRefresh(convId, 9000, retriesLeft - 1);
      }
    }, delayMs);
  }

  // A reply finished (seen in the page, or the send stream ended): fetch
  // the newest page so the archive gets the real ids and the model's text.
  function archiveOnReplyFinished() {
    const convId = getConversationId();
    if (!archiveEnabled() || !convId || isTemporaryChat()) return;
    archiveState.streamEnd = { convId, at: Date.now() };
    archiveScheduleRefresh(convId, 2500);
  }

  async function archiveSyncLatestIfNeeded(timeoutMs = 10000) {
    const convId = getConversationId();
    if (!archiveEnabled() || !convId || isTemporaryChat()) return;
    const ended = archiveState.streamEnd.convId === convId ? archiveState.streamEnd.at : 0;
    const synced = archiveState.latestSnapshot.convId === convId ? archiveState.latestSnapshot.at : 0;
    if (ended <= synced) return;
    await archiveRequestRefresh(convId, timeoutMs);
  }

  function initLocalArchiveExport(modal, title, fileBase, onLoaded = null) {
    const info = modal.querySelector("#qelvynox-local-archive-info");
    const htmlBtn = modal.querySelector("#qelvynox-export-local-html");
    const mdBtn = modal.querySelector("#qelvynox-export-local-md");
    if (!info || !htmlBtn || !mdBtn) return;

    const convId = getConversationId();
    const setState = (text, enabled) => {
      info.textContent = text;
      htmlBtn.disabled = !enabled;
      mdBtn.disabled = !enabled;
    };

    if (!Archive) { setState(T("archive.unavailable"), false); return; }
    if (!archiveEnabled()) { setState(T("archive.disabled"), false); return; }
    if (!convId || isTemporaryChat()) { setState(T("archive.temporary"), false); return; }

    // Latest on-screen messages first, so the export includes what you see.
    const loadFresh = async () => {
      await archiveSyncLatestIfNeeded();
      await archiveCaptureLive({ all: true });
      await archiveRun(archiveFlushNow);
      return Archive.loadConversation(convId);
    };

    const describe = (a) => {
      const msgs = a.messages.filter((m) => m.text || (m.images && m.images.length)).length;
      const imgs = Archive.countImages(a);
      const when = a.updatedAt ? new Date(a.updatedAt).toLocaleString() : T("archive.unknownTime");
      const history = a.reachedStart ? T("archive.historyFull") : T("archive.historyPartial");
      return T("archive.describe", { messages: msgs, images: imgs, when, history });
    };

    loadFresh().then((a) => {
      if (!a || a.messages.length === 0) {
        setState(T("archive.noneForChat"), false);
        return;
      }
      setState(describe(a), true);
      if (onLoaded) {
        try { onLoaded(a); } catch {}
      }
    }).catch(() => setState(T("archive.readFailed"), false));

    const bestTitle = (a) => (!I18N || !I18N.isChatTitleFallback(title) ? title : (a.title || title));

    mdBtn.addEventListener("click", async () => {
      const a = await loadFresh();
      if (!a || a.messages.length === 0) { toast(T("archive.nothing")); return; }
      const md = Archive.buildMarkdownExport(a, { title: bestTitle(a) });
      downloadBlob(md, `${fileBase()}-archive.md`, "text/markdown;charset=utf-8");
      toast(T("archive.exported"));
    });

    htmlBtn.addEventListener("click", async () => {
      htmlBtn.disabled = true;
      const original = htmlBtn.innerHTML;
      htmlBtn.innerHTML = `<span>${esc(T("archive.generatingHtml"))}</span>`;
      try {
        const a = await loadFresh();
        if (!a || a.messages.length === 0) { toast(T("archive.nothing")); return; }
        const keys = [];
        a.messages.forEach((m) => (m.images || []).forEach((im) => keys.push(im.key)));
        const images = await Archive.loadImages(keys);
        const html = Archive.buildHtmlExport(a, images, { title: bestTitle(a) });
        downloadBlob(html, `${fileBase()}-archive.html`, "text/html;charset=utf-8");
        toast(T("archive.exportedWithImages", { n: images.size }));
      } finally {
        htmlBtn.disabled = false;
        htmlBtn.innerHTML = original;
      }
    });
  }

  function resetRenderCaches() {
    lastPillSignature = null;
    cachedScrollContainer = null;
    resetConversationPane();
    invalidateHiddenCount();
    const dock = document.getElementById("qelvynox-floating-dock");
    if (dock) delete dock.dataset.sig;
  }

  // A language switch changes text, not behaviour, so every surface that was
  // built once has to be repainted. The pill and the dock already rebuild
  // through resetRenderCaches() + renderAllTools(); this covers
  // the surfaces that keep their nodes on screen and cache wording inside them.
  //
  // An open panel is re-read in place rather than closed and reopened: closing
  // one the user pinned would leave its dock button claiming a panel that is no
  // longer there. The search bar has no pinned state, so it is rebuilt - and
  // keeps its keyword, because losing a typed query would read as a bug caused
  // by the switch.
  function refreshLanguageSurfaces() {
    const outlineList = document.querySelector("#qelvynox-outline-popover #qelvynox-outline-list");
    const bookmarksPopover = document.getElementById("qelvynox-bookmarks-popover");
    const bookmarksList = bookmarksPopover
      ? bookmarksPopover.querySelector("#qelvynox-bookmarks-list")
      : null;
    const searchInput = document.getElementById("qelvynox-search-input");
    const searchWasOpen = !!searchInput;
    const keepQuery = searchInput ? searchInput.value : "";

    if (outlineList) {
      delete outlineList.dataset.sig;
      renderOutlineList(outlineList);
    }
    if (bookmarksList) {
      // The scope switch is static markup from when the panel was built, so it
      // needs its own pass; the rows come from the re-read below.
      bookmarksPopover.querySelectorAll(".qelvynox-seg-item").forEach((button) => {
        button.textContent = T(button.id === "qelvynox-bm-scope-current"
          ? "bookmarks.scopeCurrent"
          : "bookmarks.scopeAll");
      });
      delete bookmarksList.dataset.sig;
      renderBookmarksList(bookmarksList);
    }

    const topbar = document.getElementById(TOPBAR_EXPORT_ID);
    if (topbar) {
      topbar.title = T("topbar.exportTitle");
      topbar.setAttribute("aria-label", T("topbar.exportTitle"));
      const label = topbar.querySelector("span");
      if (label) label.textContent = T("topbar.export");
    }
    // Star tooltips come from the stored state, so re-sync them in place.
    syncAllBookmarkButtons();

    if (searchWasOpen) {
      toggleSearchOverlay();
      const fresh = document.getElementById("qelvynox-search-input");
      if (fresh && keepQuery) {
        fresh.value = keepQuery;
        fresh.dispatchEvent(new Event("input"));
      }
    }
    if (document.getElementById("qelvynox-export-modal")) {
      closeExportModal();
      openExportModal();
    }
    applySurfaceLang();
  }

  // Every surface we own declares the language it is written in, so a screen
  // reader pronounces it correctly after a switch. The host page's <html lang>
  // belongs to ChatGPT and is never touched.
  function applySurfaceLang() {
    const lang = htmlLang();
    [
      "qelvynox-floating-dock",
      "qelvynox-floating-pill",
      "qelvynox-outline-popover",
      "qelvynox-bookmarks-popover",
      "qelvynox-search-overlay",
      "qelvynox-export-modal",
      "qelvynox-settings-modal",
      TOPBAR_EXPORT_ID
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.getAttribute("lang") !== lang) el.setAttribute("lang", lang);
    });
  }

  function changeLanguage(next) {
    const value = I18N ? I18N.normalize(next) : "zh-CN";
    if (value === (appSettings.language || "zh-CN")) return;
    // Persist + apply first: renderAllTools() inside has to build with the new
    // language already active, or the repaint writes the old wording again.
    qgstSaveSettings({ language: value });
    refreshLanguageSurfaces();
    const root = qgstEl();
    if (root) {
      closeSettingsModal();
      openSettingsModal();
      qgstUpdateNavDots();
    }
  }

  // ---------- In-page settings modal (Speed Booster style) ----------
  //
  // One centered panel with a feature list on the left and a detail page on
  // the right. It is the only place settings are edited in-page; writes go to
  // chrome.storage.local and reach mainWorld through the existing
  // storage.onChanged -> localStorage config mirror, so nothing needs a
  // reload. There is deliberately no paid tier, badge or promotion anywhere.
  const QGST_ICONS = {
    zap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
    list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
    download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    archive: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"></rect><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"></path><line x1="10" y1="13" x2="14" y2="13"></line></svg>',
    backup: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
    check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    upload: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
    // Inline brand mark: an <img> pointing at chrome-extension:// is blocked
    // by ChatGPT's content-security-policy, so the logo ships as SVG. The tail
    // crosses the ring and stops just outside it - a long handle reads as a
    // magnifying glass, not as a Q.
    logo: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11.2" r="6.8" stroke-width="2.4"></circle><path d="M14.2 14.4 17.9 18.1" stroke-width="2.8"></path></svg>'
  };

  // Names are dictionary keys, read at render time: the panel is rebuilt on a
  // language switch, and a name resolved once at load would freeze the old
  // language into the sidebar.
  const QGST_NAV = [
    { id: "speed", nameKey: "settings.nav.speed", icon: "zap", setting: "enabled" },
    { id: "search", nameKey: "settings.nav.search", icon: "search", setting: "enableSearch" },
    { id: "navigator", nameKey: "settings.nav.navigator", icon: "list", setting: "enableOutline" },
    { id: "export", nameKey: "settings.nav.export", icon: "download", setting: null },
    { id: "archive", nameKey: "settings.nav.archive", icon: "archive", setting: "enableLocalArchive" },
    { id: "backup", nameKey: "settings.nav.backup", icon: "backup", setting: null },
    { id: "general", nameKey: "settings.nav.general", icon: "globe", setting: null },
    { id: "about", nameKey: "settings.nav.about", icon: "info", setting: null }
  ];

  let qgstRoot = null;
  let qgstPage = "speed";

  function qgstSwitchHtml(key, label) {
    return `<input type="checkbox" class="qgst-switch" data-setting="${key}" aria-label="${esc(label || T("settings.switchFallback"))}" ${appSettings[key] !== false ? "checked" : ""} />`;
  }

  function qgstStepperHtml(dataAttr, value, min, max, label) {
    return `
      <div class="qgst-stepper">
        <button type="button" class="qgst-step-btn" data-step="-1" data-target="${dataAttr}" aria-label="${esc(T("settings.stepDecrease", { label: esc(label) }))}">\u2212</button>
        <input type="number" class="qgst-step-input" data-target="${dataAttr}" data-min="${min}" data-max="${max}" value="${esc(String(value))}" aria-label="${esc(label)}" />
        <button type="button" class="qgst-step-btn" data-step="1" data-target="${dataAttr}" aria-label="${esc(T("settings.stepIncrease", { label: esc(label) }))}">+</button>
      </div>
    `;
  }

  function qgstClamp(value, min, max, fallback) {
    let v = parseInt(value, 10);
    if (!Number.isFinite(v)) v = fallback;
    return Math.max(min, Math.min(max, v));
  }

  function qgstLoadMode() {
    if (appSettings.enabled === false) return "default";
    return (appSettings.messageLimit || 15) >= 60 ? "all" : "recent";
  }

  function qgstSaveSettings(patch) {
    appSettings = { ...appSettings, ...patch };
    applyLanguage();
    try {
      chrome.storage.local.set({ [SETTINGS_KEY]: appSettings });
    } catch {}
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        enabled: appSettings.enabled,
        messageLimit: appSettings.messageLimit,
        enableAutoScrollLoad: appSettings.enableAutoScrollLoad,
        liveAutoTrim: appSettings.liveAutoTrim === true
      }));
    } catch {}
    resetRenderCaches();
    renderAllTools();
    enforceDomTurnLimit({ force: true });
  }

  function qgstUpdateNavDots() {
    const root = qgstEl();
    if (!root) return;
    root.querySelectorAll(".qgst-nav-item").forEach((item) => {
      const entry = QGST_NAV.find((n) => n.id === item.dataset.page);
      const dot = item.querySelector(".qgst-dot");
      if (!entry || !dot) return;
      const on = entry.setting ? appSettings[entry.setting] !== false : true;
      dot.classList.toggle("on", on);
      item.title = `${T(entry.nameKey)} - ${on ? T("settings.navOn") : T("settings.navOff")}`;
    });
  }

  function qgstRenderContent(root) {
    const content = root.querySelector(".qgst-content");
    if (!content) return;
    content.innerHTML = qgstPageHtml();
    if (qgstPage === "archive") qgstRefreshArchiveStats(content);
  }

  function qgstEl() {
    // Always resolve against the live DOM: the cached reference can point at
    // a node that was replaced (a settings write re-renders the dock, an SPA
    // navigation can rebuild the body), and closing a detached element would
    // leave the visible modal stuck on screen.
    const live = document.getElementById("qelvynox-settings-modal");
    if (live && live !== qgstRoot) qgstRoot = live;
    return live;
  }

  function openSettingsModal(startPage) {
    if (startPage && QGST_NAV.some((n) => n.id === startPage)) qgstPage = startPage;
    const existing = qgstEl();
    if (existing) {
      qgstRenderContent(existing);
      qgstUpdateNavDots();
      return;
    }

    const root = markOwned(document.createElement("div"));
    root.id = "qelvynox-settings-modal";
    root.className = "qgst-root";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", T("settings.modalAria"));

    root.innerHTML = `
      <div class="qgst-overlay" data-close="1"></div>
      <div class="qgst-panel">
        <div class="qgst-header">
          <div class="qgst-logo">${QGST_ICONS.logo}</div>
          <div>
            <div class="qgst-title">Qelvynox <span class="qgst-badge">v${esc(qgstVersion())}</span></div>
            <p class="qgst-subtitle">${esc(T("app.brandSubtitle"))}</p>
          </div>
          <div class="qgst-header-spacer"></div>
          <button type="button" class="qgst-close" data-action="close" aria-label="${esc(T("settings.close"))}">${QGST_ICONS.close}</button>
        </div>
        <div class="qgst-body">
          <aside class="qgst-sidebar">
            <div class="qgst-nav-label">${esc(T("settings.navLabel"))}</div>
            ${QGST_NAV.map((n) => `
              <button type="button" class="qgst-nav-item ${n.id === qgstPage ? "qgst-active" : ""}" data-page="${n.id}">
                ${QGST_ICONS[n.icon] || ""}
                <span class="qgst-nav-name">${esc(T(n.nameKey))}</span>
                <span class="qgst-dot ${n.setting ? (appSettings[n.setting] !== false ? "on" : "") : "on"}"></span>
              </button>
            `).join("")}
            <div class="qgst-sidebar-foot">
              ${QGST_ICONS.lock}
              <span><strong>${esc(T("settings.footStrong"))}</strong><br />${esc(T("settings.footText"))}</span>
            </div>
          </aside>
          <div class="qgst-content"></div>
        </div>
      </div>
      <input type="file" accept=".json,application/json" data-role="backup-file" style="display:none;" />
    `;

    document.body.appendChild(root);
    qgstRoot = root;
    qgstApplyTheme();
    qgstRenderContent(root);

    // Close must work even if a delegated handler is ever intercepted by the
    // host page, so bind the two dismiss affordances directly as well. They
    // are idempotent with the delegated [data-close]/[data-action=close].
    const closeBtn = root.querySelector(".qgst-close");
    if (closeBtn) closeBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); closeSettingsModal(); });
    const overlayEl = root.querySelector(".qgst-overlay");
    if (overlayEl) overlayEl.addEventListener("click", () => closeSettingsModal());

    root.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("[data-close]")) { closeSettingsModal(); return; }

      const nav = t.closest(".qgst-nav-item");
      if (nav) {
        qgstPage = nav.dataset.page;
        root.querySelectorAll(".qgst-nav-item").forEach((x) => x.classList.toggle("qgst-active", x === nav));
        qgstRenderContent(root);
        return;
      }

      const radio = t.closest("[data-load-mode]");
      if (radio) {
        const mode = radio.dataset.loadMode;
        // Persist first, then repaint from the stored state - reading the new
        // mode off the old value would leave the wrong card highlighted.
        if (mode === "recent") qgstSaveSettings({ enabled: true, messageLimit: Math.min(appSettings.messageLimit || 15, 30) });
        else if (mode === "all") qgstSaveSettings({ enabled: true, messageLimit: 100 });
        else qgstSaveSettings({ enabled: false });
        qgstRenderContent(root);
        qgstUpdateNavDots();
        return;
      }

      const step = t.closest(".qgst-step-btn");
      if (step) {
        const key = step.dataset.target;
        const input = root.querySelector(`.qgst-step-input[data-target="${key}"]`);
        if (!input) return;
        const cfg = QGST_STEPPERS[key];
        const next = qgstClamp((parseInt(input.value, 10) || cfg.value) + Number(step.dataset.step) * cfg.step, cfg.min, cfg.max, cfg.value);
        qgstSaveSettings({ [key]: next });
        input.value = next;
        if (key === "messageLimit") qgstRenderContent(root);
        return;
      }

      const action = t.closest("[data-action]");
      if (action) qgstHandleAction(action.dataset.action, root);
    });

    root.addEventListener("change", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const sw = t.closest(".qgst-switch[data-setting]");
      if (sw) {
        qgstSaveSettings({ [sw.dataset.setting]: sw.checked });
        qgstUpdateNavDots();
        if (["enabled", "messageLimit"].includes(sw.dataset.setting)) qgstRenderContent(root);
        return;
      }
      const input = t.closest(".qgst-step-input[data-target]");
      if (input) {
        const cfg = QGST_STEPPERS[input.dataset.target];
        // An unmapped target means a wiring mistake; clamping it to [1,1] is
        // how a setting silently gets destroyed, so refuse instead.
        if (!cfg) return;
        const v = qgstClamp(input.value, cfg.min, cfg.max, cfg.value);
        qgstSaveSettings({ [cfg.key]: v });
        input.value = v;
      }
    });

    const fileInput = root.querySelector('[data-role="backup-file"]');
    if (fileInput) fileInput.addEventListener("change", (e) => qgstImportBackup(e.target));

    document.addEventListener("keydown", qgstKeyHandler, true);
  }

  function qgstKeyHandler(e) {
    if (e.key === "Escape" && qgstEl()) {
      e.stopPropagation();
      closeSettingsModal();
    }
  }

  function closeSettingsModal() {
    document.removeEventListener("keydown", qgstKeyHandler, true);
    const live = qgstEl();
    if (live) live.remove();
    if (qgstRoot) qgstRoot.remove();
    qgstRoot = null;
  }

  function qgstApplyTheme() {
    const root = qgstEl();
    if (root) root.classList.toggle("qelvynox-dark", isDarkTheme());
  }

  function qgstVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "1.0.0";
    }
  }

  function qgstHandleAction(action, root) {
    if (action === "close") {
      closeSettingsModal();
    } else if (action === "export-open") {
      closeSettingsModal();
      openExportModal();
    } else if (action === "export-full-md") {
      // Reuse the export window's own progress-reporting, failure-honest
      // server path rather than keeping a second copy of it here.
      closeSettingsModal();
      openExportModal("#qelvynox-export-full-md");
    } else if (action === "export-continuation") {
      closeSettingsModal();
      openExportModal("#qelvynox-export-continuation");
    } else if (action === "archive-clear") {
      const btn = root.querySelector('[data-action="archive-clear"]');
      const api = globalThis.QelvynoxArchive;
      if (!api || typeof api.clearAll !== "function") return;
      if (!confirm(T("archive.confirmClear"))) return;
      if (btn) btn.disabled = true;
      api.clearAll().then(() => {
        if (btn) btn.disabled = false;
        qgstRefreshArchiveStats(root);
      });
    } else if (action === "backup-export") {
      qgstExportBackup();
    } else if (action === "backup-import") {
      const input = root.querySelector('[data-role="backup-file"]');
      if (input) { input.value = ""; input.click(); }
    } else if (action === "lang-zh" || action === "lang-en") {
      // The panel itself is rebuilt by the caller: its own header, sidebar and
      // detail page are the largest block of text that has to change language.
      changeLanguage(action === "lang-zh" ? "zh-CN" : "en");
    }
  }

  // Steppers on the detail pages: storage key, bounds and step size.
  const QGST_STEPPERS = {
    messageLimit: { key: "messageLimit", min: 1, max: 100, step: 1, value: 15 },
    loadBatchSize: { key: "loadBatchSize", min: 1, max: 50, step: 1, value: 5 },
    continuationTurns: { key: "continuationTurns", min: 1, max: 100, step: 1, value: 10 }
  };

  function qgstPageHtml() {
    switch (qgstPage) {
      case "search": return qgstSearchPage();
      case "navigator": return qgstNavigatorPage();
      case "export": return qgstExportPage();
      case "archive": return qgstArchivePage();
      case "backup": return qgstBackupPage();
      case "general": return qgstGeneralPage();
      case "about": return qgstAboutPage();
      default: return qgstSpeedPage();
    }
  }

  function qgstFormatBytes(n) {
    if (!Number.isFinite(n)) return "";
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // The "current chat" numbers come from the same server-verified turn count
  // the rest of the extension uses - a plain loaded/total ratio, never an
  // estimate. Missing fields stay null: "not known yet" is never rendered as
  // a real zero.
  function qgstChatCounts() {
    const visible = Number.isFinite(lastStatus.visibleTurns) ? lastStatus.visibleTurns : null;
    const total = Number.isFinite(lastStatus.totalTurns) ? lastStatus.totalTurns : null;
    const state = lastStatus.countState || (statusReceived ? "idle" : "initializing");
    const hasData = statusReceived && visible !== null && state !== "switching";
    const totalKnown = hasData && total !== null && state !== "counting" && state !== "partial" && state !== "stale";
    const exactPartial = state === "partial" &&
      (lastStatus.countFailureReason === "no-progress" || lastStatus.countFailureReason === "empty-page") &&
      total !== null && total > 0;
    const usable = totalKnown || exactPartial;
    return {
      hasData,
      state,
      visible: hasData ? visible : null,
      total: usable ? total : null,
      totalKnown: usable,
      pct: usable && total > 0 ? Math.min(100, Math.max(0, Math.round((visible / total) * 100))) : 0,
      allLoaded: !!usable && total > 0 && visible >= total
    };
  }

  function qgstCurrentChatHtml() {
    const c = qgstChatCounts();
    let countHtml;
    let badgeHtml;

    if (!c.hasData) {
      // A dash is not a number, so it must not borrow the green the real count
      // is drawn in: green means "this is how much you have loaded".
      countHtml = `<span class="qgst-chat-num qgst-chat-num-unknown">—</span><span class="qgst-chat-label">${esc(c.state === "switching" ? T("settings.switchingChat") : T("settings.waitingData"))}</span>`;
      badgeHtml = `<span class="qgst-badge">${esc(T("settings.notConnected"))}</span>`;
    } else {
      countHtml = `<span class="qgst-chat-num">${c.visible}</span><span class="qgst-chat-num-total">/ ${c.totalKnown ? c.total : "?"}</span><span class="qgst-chat-label">${esc(T("settings.turnsLoaded"))}</span>`;
      if (c.allLoaded) {
        badgeHtml = `<span class="qgst-badge qgst-badge-success">${QGST_ICONS.check} ${esc(T("settings.allLoaded"))}</span>`;
      } else if (c.totalKnown) {
        badgeHtml = `<span class="qgst-badge">${esc(T("settings.loadedPct", { pct: c.pct }))}</span>`;
      } else if (c.state === "counting") {
        badgeHtml = `<span class="qgst-badge">${esc(T("settings.counting"))}</span>`;
      } else {
        badgeHtml = `<span class="qgst-badge">${esc(T("settings.partialUncounted"))}</span>`;
      }
    }

    return `
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.currentChat"))}</div>
        <div class="qgst-chat-title">${esc(cleanTitle())}</div>
        <div class="qgst-chat-row">
          <div class="qgst-chat-count">
            ${countHtml}
            <div class="qgst-progress"><div class="qgst-progress-fill${c.hasData ? "" : " qgst-progress-muted"}" style="width:${c.pct}%;"></div></div>
          </div>
          ${badgeHtml}
        </div>
      </div>
    `;
  }

  function qgstSpeedPage() {
    const mode = qgstLoadMode();
    const radio = (id, title, desc) => `
      <button type="button" class="qgst-radio-card ${mode === id ? "qgst-active" : ""}" data-load-mode="${id}">
        <span class="qgst-radio"><span class="qgst-radio-dot"></span></span>
        <span>
          <div class="qgst-radio-title">${esc(title)}</div>
          <div class="qgst-radio-desc">${esc(desc)}</div>
        </span>
      </button>
    `;
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.zap}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.speedTitle"))}</h3>
            <p class="qgst-card-desc">${esc(T("settings.speedDesc"))}</p>
          </div>
          <div class="qgst-switch-wrap">${qgstSwitchHtml("enabled", T("settings.speedTitle"))}</div>
        </div>
      </div>
      ${qgstCurrentChatHtml()}
      <div class="qgst-section-title">${esc(T("settings.loadModeSection"))}</div>
      ${radio("recent", T("settings.modeRecent", { n: appSettings.messageLimit || 15 }), T("settings.modeRecentDesc"))}
      ${radio("default", T("settings.modeDefault"), T("settings.modeDefaultDesc"))}
      ${radio("all", T("settings.modeAll"), T("settings.modeAllDesc"))}
      <div class="qgst-card" style="margin-top:6px; padding: 2px 16px;">
        <div class="qgst-row">
          <div class="qgst-row-info">
            <div class="qgst-row-name">${esc(T("settings.batchName"))}</div>
            <div class="qgst-row-desc">${esc(T("settings.batchDesc"))}</div>
          </div>
          ${qgstStepperHtml("loadBatchSize", appSettings.loadBatchSize || 5, 1, 50, T("settings.batchName"))}
        </div>
        <div class="qgst-row">
          <div class="qgst-row-info">
            <div class="qgst-row-name">${esc(T("settings.contName"))}</div>
            <div class="qgst-row-desc">${esc(T("settings.contDesc"))}</div>
          </div>
          ${qgstStepperHtml("continuationTurns", appSettings.continuationTurns || 10, 1, 100, T("settings.contName"))}
        </div>
        <div class="qgst-row">
          <div class="qgst-row-info">
            <div class="qgst-row-name">${esc(T("settings.liveName"))}</div>
            <div class="qgst-row-desc">${esc(T("settings.liveDesc"))}</div>
          </div>
          ${qgstSwitchHtml("liveAutoTrim", T("settings.liveName"))}
        </div>
        <div class="qgst-row">
          <div class="qgst-row-info">
            <div class="qgst-row-name">${esc(T("settings.autoName"))}</div>
            <div class="qgst-row-desc">${esc(T("settings.autoDesc"))}</div>
          </div>
          ${qgstSwitchHtml("enableAutoScrollLoad", T("settings.autoName"))}
        </div>
        <div class="qgst-row">
          <div class="qgst-row-info">
            <div class="qgst-row-name">${esc(T("settings.pillName"))}</div>
            <div class="qgst-row-desc">${esc(T("settings.pillDesc"))}</div>
          </div>
          ${qgstSwitchHtml("enableFloatingButton", T("settings.pillName"))}
        </div>
        <div class="qgst-row">
          <div class="qgst-row-info">
            <div class="qgst-row-name">${esc(T("settings.quietName"))}</div>
            <div class="qgst-row-desc">${esc(T("settings.quietDesc"))}</div>
          </div>
          ${qgstSwitchHtml("disableNotifications", T("settings.quietName"))}
        </div>
      </div>
    `;
  }

  function qgstSearchPage() {
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.search}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.nav.search"))}</h3>
            <p class="qgst-card-desc">${T("settings.searchDesc")}</p>
          </div>
          <div class="qgst-switch-wrap">${qgstSwitchHtml("enableSearch", T("settings.nav.search"))}</div>
        </div>
      </div>
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.notes"))}</div>
        <ul class="qgst-list">
          <li>${QGST_ICONS.check}<span>${T("settings.searchNote1")}</span></li>
          <li>${QGST_ICONS.check}<span>${T("settings.searchNote2")}</span></li>
          <li>${QGST_ICONS.check}<span>${T("settings.searchNote3")}</span></li>
        </ul>
      </div>
    `;
  }

  function qgstNavigatorPage() {
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.list}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.nav.navigator"))}</h3>
            <p class="qgst-card-desc">${esc(T("settings.navigatorDesc"))}</p>
          </div>
          <div class="qgst-switch-wrap">${qgstSwitchHtml("enableOutline", T("settings.nav.navigator"))}</div>
        </div>
      </div>
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.notes"))}</div>
        <ul class="qgst-list">
          <li>${QGST_ICONS.check}<span>${T("settings.navigatorNote1")}</span></li>
          <li>${QGST_ICONS.check}<span>${T("settings.navigatorNote2")}</span></li>
          <li>${QGST_ICONS.check}<span>${T("settings.navigatorNote3")}</span></li>
        </ul>
      </div>
    `;
  }

  function qgstExportPage() {
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.download}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.nav.export"))}</h3>
            <p class="qgst-card-desc">${esc(T("settings.exportDesc"))}</p>
          </div>
        </div>
        <div class="qgst-btn-row" style="margin-top:14px;">
          <button type="button" class="qgst-btn qgst-btn-primary" data-action="export-open">${QGST_ICONS.download} ${esc(T("settings.exportOpenBtn"))}</button>
        </div>
      </div>
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.fullSection"))}</div>
        <p class="qgst-card-desc" style="margin-top:6px;">${esc(T("settings.exportFullDesc"))}</p>
        <div class="qgst-btn-row" style="margin-top:12px;">
          <button type="button" class="qgst-btn" data-action="export-full-md">${QGST_ICONS.download} ${esc(T("exportModal.fullMd"))}</button>
          <button type="button" class="qgst-btn" data-action="export-continuation">${esc(T("settings.copyContinuation", { n: esc(String(appSettings.continuationTurns || 10)) }))}</button>
        </div>
      </div>
    `;
  }

  function qgstArchivePage() {
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.archive}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.nav.archive"))}</h3>
            <p class="qgst-card-desc">${esc(T("settings.archiveDesc"))}</p>
          </div>
          <div class="qgst-switch-wrap">${qgstSwitchHtml("enableLocalArchive", T("settings.nav.archive"))}</div>
        </div>
      </div>
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.archiveDataSection"))}</div>
        <p class="qgst-meta" id="qelvynox-qgst-archive-stats" style="margin:8px 0 12px;">${esc(T("settings.archiveChecking"))}</p>
        <div class="qgst-btn-row">
          <button type="button" class="qgst-btn qgst-btn-destructive" data-action="archive-clear">${esc(T("settings.archiveClearBtn"))}</button>
        </div>
      </div>
    `;
  }

  function qgstRefreshArchiveStats(scope) {
    const el = (scope || document).querySelector("#qelvynox-qgst-archive-stats");
    if (!el) return;
    const api = globalThis.QelvynoxArchive;
    if (!api || typeof api.stats !== "function") {
      el.textContent = T("archive.settingsUnavailable");
      return;
    }
    api.stats().then((st) => {
      const size = st.bytes ? T("archive.statsSize", { size: qgstFormatBytes(st.bytes) }) : "";
      el.innerHTML = T("archive.stats", {
        conversations: esc(String(st.conversations || 0)),
        images: esc(String(st.images || 0)),
        size: esc(size)
      });
    }).catch(() => {
      el.textContent = T("archive.settingsReadFailed");
    });
  }

  function qgstBackupPage() {
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.backup}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.nav.backup"))}</h3>
            <p class="qgst-card-desc">${esc(T("settings.backupDesc"))}</p>
          </div>
        </div>
        <div class="qgst-btn-row" style="margin-top:14px;">
          <button type="button" class="qgst-btn" data-action="backup-export">${QGST_ICONS.download} ${esc(T("settings.backupExportBtn"))}</button>
          <button type="button" class="qgst-btn" data-action="backup-import">${QGST_ICONS.upload} ${esc(T("settings.backupImportBtn"))}</button>
        </div>
      </div>
    `;
  }

  function qgstGeneralPage() {
    const active = I18N ? I18N.lang() : "zh-CN";
    const option = (action, name, desc, on) => `
      <button type="button" class="qgst-radio-card ${on ? "qgst-active" : ""}" data-action="${action}" aria-pressed="${on}">
        <span class="qgst-radio"><span class="qgst-radio-dot"></span></span>
        <span>
          <div class="qgst-radio-title">${esc(name)}</div>
          <div class="qgst-radio-desc">${esc(desc)}</div>
        </span>
      </button>
    `;
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.globe}</div>
          <div>
            <h3 class="qgst-card-title">${esc(T("settings.generalTitle"))}</h3>
            <p class="qgst-card-desc">${esc(T("settings.langDesc"))}</p>
          </div>
        </div>
      </div>
      <div class="qgst-section-title">${esc(T("settings.langSection"))}</div>
      ${option("lang-zh", T("settings.langZh"), T("settings.langZhDesc"), active === "zh-CN")}
      ${option("lang-en", T("settings.langEn"), T("settings.langEnDesc"), active === "en")}
      <p class="qgst-meta" style="margin-top:12px;">${esc(T("settings.browserHint"))}</p>
    `;
  }

  function qgstAboutPage() {
    return `
      <div class="qgst-card">
        <div class="qgst-card-head">
          <div class="qgst-card-icon">${QGST_ICONS.info}</div>
          <div>
            <h3 class="qgst-card-title">Qelvynox <span class="qgst-badge">v${esc(qgstVersion())}</span></h3>
            <p class="qgst-card-desc">${esc(T("settings.aboutTagline"))}</p>
          </div>
        </div>
      </div>
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.privacySection"))}</div>
        <ul class="qgst-list" style="margin-top:10px;">
          <li>${QGST_ICONS.check}<span>${T("settings.privacyNote1")}</span></li>
          <li>${QGST_ICONS.check}<span>${T("settings.privacyNote2")}</span></li>
          <li>${QGST_ICONS.check}<span>${T("settings.privacyNote3")}</span></li>
        </ul>
      </div>
      <div class="qgst-card">
        <div class="qgst-section-title" style="margin-top:0;">${esc(T("settings.shortcutsSection"))}</div>
        <div class="qgst-meta" style="margin-top:10px;">
          <div class="qgst-shortcut"><strong>Alt + F</strong><span class="qgst-sc-desc">${esc(T("settings.shortcutSearch"))}</span></div>
          <div class="qgst-shortcut"><strong>Enter / Shift + Enter</strong><span class="qgst-sc-desc">${esc(T("settings.shortcutWalk"))}</span></div>
          <div class="qgst-shortcut"><strong>Esc</strong><span class="qgst-sc-desc">${esc(T("settings.shortcutClose"))}</span></div>
          <div class="qgst-shortcut"><strong>Tab</strong><span class="qgst-sc-desc">${esc(T("settings.shortcutTab"))}</span></div>
        </div>
      </div>
    `;
  }

  // ---- Backup / restore (shared with the browser popup's JSON format) ----

  function qgstCollectBackup(done) {
    const local = chrome.storage.local;
    if (typeof local.getKeys === "function") {
      local.getKeys().then((keys) => {
        local.get((keys || []).filter((k) => !k.startsWith("qelvynox_archive_")), done);
      }).catch(() => local.get(null, done));
    } else {
      local.get(null, done);
    }
  }

  function qgstExportBackup() {
    qgstCollectBackup((items) => {
      const backup = {
        app: "Qelvynox",
        version: qgstVersion(),
        exportedAt: new Date().toISOString(),
        settings: items.qelvynox_settings || appSettings,
        bookmarks: {}
      };
      Object.keys(items || {}).forEach((key) => {
        if (key.startsWith("qelvynox_bookmarks_")) backup.bookmarks[key] = items[key];
      });
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `qelvynox-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function qgstImportBackup(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data = null;
      try {
        data = JSON.parse(String(reader.result));
      } catch {
        toast(T("backup.parseFailed"));
        return;
      }
      // An older backup may still carry a `folders` array; it is ignored rather
      // than restored, because the organizer it belonged to no longer exists.
      if (!data || (data.app !== "Qelvynox" && !data.bookmarks && !data.settings)) {
        toast(T("backup.invalid"));
        return;
      }
      const toSet = {};
      if (data.settings && typeof data.settings === "object") toSet[SETTINGS_KEY] = { ...appSettings, ...data.settings };
      if (data.bookmarks && typeof data.bookmarks === "object") {
        Object.keys(data.bookmarks).forEach((k) => {
          if (k.startsWith(BOOKMARKS_PREFIX)) toSet[k] = data.bookmarks[k];
        });
      }
      chrome.storage.local.set(toSet, () => {
        toast(T("backup.restored"));
        if (toSet[SETTINGS_KEY]) {
          qgstSaveSettings(toSet[SETTINGS_KEY]);
          const root = qgstEl();
          if (root) {
            qgstRenderContent(root);
            qgstUpdateNavDots();
          }
        }
      });
    };
    reader.readAsText(file);
  }

  function renderAllTools() {
    injectStyles();
    enforceDomTurnLimit({ force: true });
    renderFloatingLoadButton(true);
    renderFloatingDock();
    injectTopbarExportButton();
    injectBookmarkButtons();
    setupAutoScrollLoader();
  }

  // SPA navigation: normal <-> temporary <-> another chat must never show the
  // previous chat's numbers.
  let lastScopeId = getStatsScopeId();
  let lastHref = window.location.href;

  function checkNavigation() {
    const href = window.location.href;
    if (href === lastHref) return;
    lastHref = href;
    manuallyUnhiddenTurnsCount = 0;
    initialEnforcementDone = false;
    cachedScrollContainer = null;
    // A different conversation is a different pane: never let the previous
    // chat's scope survive into the new one.
    resetConversationPane();
    // Another chat (or a temporary one) has nothing in common with the panel
    // that is currently on screen: drop it rather than show stale rows. This
    // also un-pins, because a panel that is gone must not leave its dock button
    // pressed - and the new chat must not inherit a pin the user set on the old
    // one, which is how the navigator index appeared to "stack up".
    outlinePopover.forceClose();
    bookmarksPopover.forceClose();
    closeSearchOverlay();
    invalidateHiddenCount();
    removeAutoScrollLoader();
    // A new temporary chat gets a fresh session identity.
    if (isTemporaryChat() && !href.includes("/c/")) temporarySessionId = null;
    const scopeId = getStatsScopeId();
    if (scopeId === lastScopeId) return;
    lastScopeId = scopeId;
    statusReceived = false;
    lastStatus = {
      totalMessages: 0,
      renderedMessages: 0,
      hasOlderMessages: false,
      visibleTurns: 0,
      totalTurns: 0,
      countState: "idle",
      countComplete: false
    };
    resetRenderCaches();
    // Force the top-bar button to be re-placed into the new view's top bar.
    const staleExport = document.getElementById(TOPBAR_EXPORT_ID);
    if (staleExport) staleExport.remove();
    recoverStatus();
  }

  // DOM Observer (replaces fixed-interval polling)
  //
  // The callback itself must stay trivially cheap: during streaming ChatGPT
  // emits mutation batches many times a second. All real work happens in one
  // debounced tick, and mutations caused by our own UI are ignored entirely
  // so the page can actually go idle between user actions.
  let wasStreaming = false;
  let moTimer = null;
  let tickPendingWhileHidden = false;

  function isOwnMutation(rec) {
    const t = rec.target;
    if (t && t.nodeType === 1 && typeof t.closest === "function" && t.closest(OWNED_SELECTOR)) return true;
    const added = rec.addedNodes;
    const removed = rec.removedNodes;
    if (added.length === 0 && removed.length === 0) return false;
    for (let i = 0; i < added.length; i++) {
      const n = added[i];
      if (!(n.nodeType === 1 && n.hasAttribute && n.hasAttribute(OWNED_ATTR))) return false;
    }
    for (let i = 0; i < removed.length; i++) {
      const n = removed[i];
      if (!(n.nodeType === 1 && n.hasAttribute && n.hasAttribute(OWNED_ATTR))) return false;
    }
    return true;
  }

  function isStreamingNow() {
    return !!document.querySelector('.result-streaming, [data-testid="stop-button"], button[aria-label*="Stop"]');
  }

  // Everything that reads the live conversation, refreshed from the one
  // debounced tick instead of only when a panel is opened. Each renderer exits
  // immediately when its content signature is unchanged, so an open navigator
  // costs nothing while nothing is happening - and picks up the fourth reply
  // the moment ChatGPT puts it in the page.
  function refreshLiveSurfaces() {
    const outlineList = document.querySelector("#qelvynox-outline-popover #qelvynox-outline-list");
    if (outlineList) renderOutlineList(outlineList);
    const bookmarksList = document.querySelector("#qelvynox-bookmarks-popover #qelvynox-bookmarks-list");
    if (bookmarksList) renderBookmarksList(bookmarksList);
  }

  // Streaming rewrites the answer many times a second; the open search bar
  // follows along at a fraction of that rate rather than not at all.
  const SEARCH_LIVE_MS = 900;
  let lastLiveSearchRefresh = 0;

  function runObserverTick() {
    moTimer = null;
    if (document.hidden) {
      // Nothing to paint for a background tab. Navigation state is still
      // tracked; the full pass runs once the tab is visible again.
      checkNavigation();
      tickPendingWhileHidden = true;
      return;
    }
    tickPendingWhileHidden = false;
    invalidateHiddenCount();
    checkNavigation();

    const isStreaming = isStreamingNow();
    if (wasStreaming && !isStreaming) {
      if (appSettings.enabled && appSettings.liveAutoTrim) {
        enforceDomTurnLimit({ live: true });
      }
      archiveOnReplyFinished();
    }
    wasStreaming = isStreaming;
    // A message is archived once it has finished streaming, never mid-way.
    if (!isStreaming) scheduleArchiveCapture();

    if (appSettings.enabled) {
      enforceDomTurnLimit({ live: true });
      renderFloatingLoadButton();
      injectBookmarkButtons();
      setupAutoScrollLoader();
    }
    // Runs regardless of `enabled` so it can also remove itself when the
    // booster is switched off. Cheap: exits early once already placed.
    injectTopbarExportButton();
    renderFloatingDock();
    refreshLiveSurfaces();
    applySurfaceLang();
    // A re-render detaches the text nodes the search ranges point at, and a
    // reply that lands while the bar is open is new search material: repaint
    // live, throttled, and never scroll the page out from under the reader.
    if (searchActive && searchRefresh) {
      const now = Date.now();
      if (!isStreaming || now - lastLiveSearchRefresh >= SEARCH_LIVE_MS) {
        lastLiveSearchRefresh = now;
        searchRefresh({ live: isStreaming });
      }
    }
  }

  const observer = new MutationObserver((records) => {
    if (moTimer) return;
    let relevant = false;
    for (let i = 0; i < records.length; i++) {
      if (!isOwnMutation(records[i])) { relevant = true; break; }
    }
    if (!relevant) return;
    moTimer = setTimeout(runObserverTick, 350);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Leaving the tab: write any pending archive change now.
      archiveRun(archiveFlushNow);
      return;
    }
    if (tickPendingWhileHidden && !moTimer) {
      moTimer = setTimeout(runObserverTick, 50);
    }
  });
  window.addEventListener("pagehide", () => { archiveRun(archiveFlushNow); });

  // Prompt submission listeners: trigger turn enforcement immediately when user sends a message
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && appSettings.enabled && appSettings.liveAutoTrim) {
      setTimeout(() => enforceDomTurnLimit({ live: true }), 120);
    }
  }, { capture: true, passive: true });

  document.addEventListener("click", (e) => {
    if (!appSettings.enabled || !appSettings.liveAutoTrim) return;
    const btn = e.target && e.target.closest ? e.target.closest('button[data-testid="send-button"], button[aria-label*="Send"], button[data-testid="fruitjuice-send-button"]') : null;
    if (btn) {
      setTimeout(() => enforceDomTurnLimit({ live: true }), 120);
    }
  }, { capture: true, passive: true });

  function startObserver() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      setTimeout(startObserver, 200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadSettings();
      startObserver();
      recoverStatus();
    });
  } else {
    loadSettings();
    startObserver();
    recoverStatus();
  }
})();
