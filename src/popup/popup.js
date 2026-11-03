(() => {
  // Same dictionary the in-page surfaces use (src/shared/i18n.js is loaded
  // before this file), so the popup and ChatGPT's panels always agree.
  const I18N = globalThis.QelvynoxI18n || null;
  const T = (key, vars) => (I18N ? I18N.t(key, vars) : key);

  document.addEventListener("DOMContentLoaded", () => {
    const versionEl = document.getElementById("headerVersion");
    if (versionEl) {
      const manifestVersion = chrome.runtime.getManifest().version;
      versionEl.textContent = `v${manifestVersion}`;
    }

    const toggleEnabled = document.getElementById("toggleEnabled");
    const toggleAutoScrollLoad = document.getElementById("toggleAutoScrollLoad");
    const toggleFloatingButton = document.getElementById("toggleFloatingButton");
    const toggleOutline = document.getElementById("toggleOutline");
    const toggleSearch = document.getElementById("toggleSearch");
    const toggleLocalArchive = document.getElementById("toggleLocalArchive");

    const messageLimitInput = document.getElementById("messageLimit");
    const msgLimitDec = document.getElementById("msgLimitDec");
    const msgLimitInc = document.getElementById("msgLimitInc");

    const refreshBtn = document.getElementById("refreshBtn");
    const saveBar = document.getElementById("saveBar");
    const exportBtn = document.getElementById("exportCurrentBtn");
    const openSettingsBtn = document.getElementById("openSettingsBtn");
    const launcherHint = document.getElementById("launcherHint");
    const langZhBtn = document.getElementById("langZh");
    const langEnBtn = document.getElementById("langEn");

    const SETTINGS_KEY = "qelvynox_settings";

    const DEFAULT_SETTINGS = {
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

    let initialSettings = null;
    let currentLanguage = DEFAULT_SETTINGS.language;
    // The "open a ChatGPT tab first" warning is set outside the translation
    // pass, so a language switch must not silently restore the normal hint.
    let hintIsOffline = false;

    // The popup is only a launcher: the real control panel is the in-page
    // modal (Speed Booster style), which the content script opens on request.
    function sendToActiveTab(message) {
      return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          if (!tab || tab.id == null) {
            resolve({ ok: false, reason: "no-tab" });
            return;
          }
          const url = tab.url || "";
          const isChatGPT = url.startsWith("https://chatgpt.com/") || url.startsWith("https://chat.openai.com/");
          if (!isChatGPT) {
            resolve({ ok: false, reason: "not-chatgpt" });
            return;
          }
          chrome.tabs.sendMessage(tab.id, message, (resp) => {
            if (chrome.runtime.lastError || !resp || resp.ok === false) {
              resolve({ ok: false, reason: "no-connection" });
              return;
            }
            resolve({ ok: true });
          });
        });
      });
    }

    function hintNotOnChatGPT() {
      if (!launcherHint) return;
      hintIsOffline = true;
      launcherHint.textContent = T("popup.launcherOffline");
      launcherHint.classList.add("hint-warn");
    }

    function setLanguageButtons(lang) {
      [langZhBtn, langEnBtn].forEach((btn) => {
        if (!btn) return;
        const on = btn.dataset.lang === lang;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", String(on));
      });
    }

    // Translates the popup's own markup and keeps the two language buttons
    // honest. Callable again after a switch: nothing reloads, nothing is lost.
    function applyLanguage() {
      if (I18N) {
        currentLanguage = I18N.normalize(currentLanguage);
        I18N.setLang(currentLanguage);
        I18N.applyTo(document, { titleKey: "popup.title" });
      }
      setLanguageButtons(currentLanguage);
      if (hintIsOffline) hintNotOnChatGPT();
    }

    if (openSettingsBtn) {
      openSettingsBtn.addEventListener("click", async () => {
        const res = await sendToActiveTab({ type: "QELVYNOX_OPEN_SETTINGS" });
        if (res.ok) {
          window.close();
        } else {
          hintNotOnChatGPT();
        }
      });
    }

    function getCurrentSettings() {
      return {
        language: currentLanguage,
        enabled: toggleEnabled ? toggleEnabled.checked : true,
        liveAutoTrim: toggleLiveAutoTrimValue(),
        messageLimit: parseInt(messageLimitInput?.value, 10) || 15,
        loadBatchSize: parseInt(loadBatchSizeInputValue(), 10) || 5,
        continuationTurns: parseInt(continuationTurnsValue(), 10) || 10,
        enableAutoScrollLoad: toggleAutoScrollLoad ? toggleAutoScrollLoad.checked : true,
        enableFloatingButton: toggleFloatingButton ? toggleFloatingButton.checked : true,
        enableOutline: toggleOutline ? toggleOutline.checked : true,
        enableSearch: toggleSearch ? toggleSearch.checked : true,
        enableLocalArchive: toggleLocalArchive ? toggleLocalArchive.checked : true,
        disableNotifications: false
      };
    }

    // Values that only live in the in-page settings panel keep their stored
    // value when the popup saves - the popup must never reset them.
    let passthrough = { ...DEFAULT_SETTINGS };
    function toggleLiveAutoTrimValue() {
      return passthrough.liveAutoTrim === true;
    }
    function loadBatchSizeInputValue() {
      return passthrough.loadBatchSize;
    }
    function continuationTurnsValue() {
      return passthrough.continuationTurns;
    }

    function saveSettings() {
      const settings = getCurrentSettings();
      chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      syncTabSettings(settings);
      checkDirty();
    }

    function checkDirty() {
      if (!initialSettings || !saveBar) return;
      const current = getCurrentSettings();
      const isDirty = JSON.stringify(current) !== JSON.stringify(initialSettings);
      if (isDirty) {
        saveBar.classList.remove("hidden");
      } else {
        saveBar.classList.add("hidden");
      }
    }

    function syncTabSettings(settings) {
      chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] }, (tabs) => {
        (tabs || []).forEach((tab) => {
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: "syncSettings", settings }).catch(() => {});
          }
        });
      });
    }

    // Load initial settings
    chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
      const s = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
      passthrough = s;
      currentLanguage = s.language || DEFAULT_SETTINGS.language;
      applyLanguage();
      if (toggleEnabled) toggleEnabled.checked = s.enabled;
      if (messageLimitInput) messageLimitInput.value = s.messageLimit;

      if (toggleAutoScrollLoad) toggleAutoScrollLoad.checked = s.enableAutoScrollLoad !== false;
      if (toggleFloatingButton) toggleFloatingButton.checked = s.enableFloatingButton !== false;
      if (toggleOutline) toggleOutline.checked = s.enableOutline !== false;
      if (toggleSearch) toggleSearch.checked = s.enableSearch !== false;
      if (toggleLocalArchive) toggleLocalArchive.checked = s.enableLocalArchive !== false;

      initialSettings = getCurrentSettings();
    });

    [toggleEnabled, toggleAutoScrollLoad, toggleFloatingButton, toggleOutline, toggleSearch, toggleLocalArchive].forEach((el) => {
      if (el) el.addEventListener("change", () => saveSettings());
    });

    [langZhBtn, langEnBtn].forEach((btn) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        const next = btn.dataset.lang === "en" ? "en" : "zh-CN";
        if (next === currentLanguage) return;
        currentLanguage = next;
        // Immediate, like the in-page panel: the popup repaints itself and the
        // open ChatGPT tabs repaint theirs, so no reload is ever needed.
        applyLanguage();
        const settings = getCurrentSettings();
        chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        syncTabSettings(settings);
        initialSettings = settings;
        if (saveBar) saveBar.classList.add("hidden");
      });
    });

    if (messageLimitInput) {
      messageLimitInput.addEventListener("change", () => {
        let val = parseInt(messageLimitInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 100) val = 100;
        messageLimitInput.value = val;
        saveSettings();
      });
    }

    if (msgLimitDec) {
      msgLimitDec.addEventListener("click", () => {
        let val = parseInt(messageLimitInput.value, 10) || 15;
        val = Math.max(1, val - 1);
        messageLimitInput.value = val;
        saveSettings();
      });
    }

    if (msgLimitInc) {
      msgLimitInc.addEventListener("click", () => {
        let val = parseInt(messageLimitInput.value, 10) || 15;
        val = Math.min(100, val + 1);
        messageLimitInput.value = val;
        saveSettings();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        const settings = getCurrentSettings();
        chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        syncTabSettings(settings);
        initialSettings = settings;
        if (saveBar) saveBar.classList.add("hidden");
        refreshBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span>' + T("popup.savedBtn") + "</span>";
        refreshBtn.disabled = true;
        setTimeout(() => {
          window.close();
        }, 500);
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        const res = await sendToActiveTab({ type: "exportChat" });
        if (res.ok) {
          window.close();
        } else {
          hintNotOnChatGPT();
        }
      });
    }

    const exportBackupBtn = document.getElementById("exportBackupBtn");
    const importBackupBtn = document.getElementById("importBackupBtn");
    const importBackupFileInput = document.getElementById("importBackupFileInput");

    if (exportBackupBtn) {
      exportBackupBtn.addEventListener("click", () => {
        // The archive can be hundreds of MB: never pull it into memory just
        // to throw it away - backups cover settings and saved replies.
        const collectBackupItems = (done) => {
          const local = chrome.storage.local;
          if (typeof local.getKeys === "function") {
            local.getKeys().then((keys) => {
              local.get((keys || []).filter((k) => !k.startsWith("qelvynox_archive_")), done);
            }).catch(() => local.get(null, done));
          } else {
            local.get(null, done);
          }
        };
        collectBackupItems((items) => {
          const backup = {
            app: "Qelvynox",
            version: chrome.runtime.getManifest()?.version || "1.0.0",
            exportedAt: new Date().toISOString(),
            settings: items.qelvynox_settings || DEFAULT_SETTINGS,
            bookmarks: {}
          };
          Object.keys(items || {}).forEach((key) => {
            if (key.startsWith("qelvynox_bookmarks_")) {
              backup.bookmarks[key] = items[key];
            }
          });
          const jsonStr = JSON.stringify(backup, null, 2);
          const blob = new Blob([jsonStr], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const dateStr = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `qelvynox-backup-${dateStr}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        });
      });
    }

    if (importBackupBtn && importBackupFileInput) {
      importBackupBtn.addEventListener("click", () => {
        importBackupFileInput.value = "";
        importBackupFileInput.click();
      });

      importBackupFileInput.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = JSON.parse(evt.target.result);
            // An older backup may still carry `folders`; it is ignored, because
            // the sidebar organizer it belonged to has been removed.
            if (!data || (data.app !== "Qelvynox" && !data.bookmarks && !data.settings)) {
              alert(T("backup.invalid"));
              return;
            }
            const toSet = {};
            if (data.settings && typeof data.settings === "object") {
              toSet[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, ...data.settings };
            }
            if (data.bookmarks && typeof data.bookmarks === "object") {
              Object.keys(data.bookmarks).forEach((k) => {
                if (k.startsWith("qelvynox_bookmarks_")) {
                  toSet[k] = data.bookmarks[k];
                }
              });
            }
            chrome.storage.local.set(toSet, () => {
              chrome.tabs.query({}, (tabs) => {
                tabs.forEach((tab) => {
                  if (tab.url && (tab.url.includes("chatgpt.com") || tab.url.includes("chat.openai.com"))) {
                    chrome.tabs.sendMessage(tab.id, { type: "syncSettings", settings: toSet[SETTINGS_KEY] || DEFAULT_SETTINGS }).catch(() => {});
                  }
                });
              });
              alert(T("backup.restored"));
              window.location.reload();
            });
          } catch (err) {
            alert(T("backup.parseFailedWith", { message: err.message }));
          }
        };
        reader.readAsText(file);
      });
    }
  });
})();
