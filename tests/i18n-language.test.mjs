/**
 * Bilingual interface (中文 / English) - the language layer.
 *
 * What this suite exists to protect:
 *  - both language tables are complete and parallel, so a switch can never
 *    print a raw key or leave one panel in the other language;
 *  - no interface string is hardcoded in the extension files any more (the
 *    only Chinese left in them matches ChatGPT's own translated controls);
 *  - the default is Chinese, and an unknown value falls back to it rather
 *    than to the browser's locale;
 *  - switching repaints every surface without a reload.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, I18N_BOOT, i18nSrc, loadDictionary } from "./i18n-loader.mjs";

const contentSrc = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const archiveSrc = fs.readFileSync(path.join(REPO, "src/content/archive.js"), "utf8");
const popupJs = fs.readFileSync(path.join(REPO, "src/popup/popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(REPO, "src/popup/popup.html"), "utf8");
const backgroundSrc = fs.readFileSync(path.join(REPO, "src/background/background.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

const zh = loadDictionary("zh-CN");
const en = loadDictionary("en");
// Chinese is recognised by its ideographs *and* its punctuation: a value that
// is only "（.md）" away from English still has to live in the Chinese table.
const HAN = /[\u3000-\u303f\u4e00-\u9fff\uff01-\uff5e]/;

/** The key list of one table, read out of the source, not the parsed object. */
function tableKeys(startMarker, endMarker) {
  const from = i18nSrc.indexOf(startMarker);
  const to = endMarker ? i18nSrc.indexOf(endMarker) : i18nSrc.length;
  if (from < 0 || to < from) throw new Error(`table ${startMarker} not found`);
  // A dotted name is what makes a string-id, so the table headers themselves
  // ("zh-CN", "en") are not counted as entries.
  return [...i18nSrc.slice(from, to).matchAll(/^\s*"([\w.-]+)":/gm)]
    .map((m) => m[1]).filter((k) => k.includes("."));
}

/* ---------------- 1. the two tables are parallel ---------------- */
console.log("--- PART 1: dictionary parity ---");

const zhKeys = zh.keys("zh-CN");
const enKeys = en.keys("en");
check("both languages define exactly the same keys",
  zhKeys.length === enKeys.length && zhKeys.every((k) => enKeys.includes(k)),
  `zh ${zhKeys.length} / en ${enKeys.length}`);
check("no table entry is empty except the sentence separator",
  zhKeys.every((k) => k === "sent.sep" || zh.t(k).length > 0) &&
  enKeys.every((k) => k === "sent.sep" || (en.t(k).length > 0 && en.t(k) !== k)));
check("a key missing from both tables reads as the key, never as nothing",
  zh.t("nope.not-a-string") === "nope.not-a-string");

// A duplicated key inside a literal silently overwrites the first one, so each
// table is counted from the source as well as from the parsed object.
const zhTableKeys = tableKeys('"zh-CN": {', '"en": {');
const enTableKeys = tableKeys('"en": {', "  };");
const duplicateHits = (list) => list.filter((k, i) => list.indexOf(k) !== i);
check("no key is declared twice in either table",
  duplicateHits(zhTableKeys).length === 0 && duplicateHits(enTableKeys).length === 0 &&
  zhTableKeys.length === zhKeys.length && enTableKeys.length === enKeys.length,
  `${duplicateHits(zhTableKeys).concat(duplicateHits(enTableKeys)).join(", ") || "clean"} `
  );
/* ---------------- 2. no leaked language in the wrong table -------------- */
console.log("\n--- PART 2: each table is written in its own language ---");

// "中文" is the name of the Chinese option and is written in Chinese on
// purpose, in both tables - a language picker that calls it "Chinese" is
// harder to find for the person who needs it.
const enWithHan = enKeys.filter((k) => HAN.test(en.t(k)) && k !== "settings.langZh");
check("the English table carries no Chinese text or full-width punctuation",
  enWithHan.length === 0, enWithHan.join(", "));
const zhNeutral = zhKeys.filter((k) => !HAN.test(zh.t(k)) && k !== "sent.sep");
check("the Chinese table is Chinese, except for strings identical in both languages",
  zhNeutral.every((k) => zh.t(k) === en.t(k)),
  `${zhNeutral.filter((k) => zh.t(k) !== en.t(k)).join(", ") || "none"} | counted: ${zhNeutral.join(",")}`.slice(0, 200));
// An ideographic space in an English sentence reads as a typesetting mistake,
// and the shortcut list used to be padded with one.
check("no English string is spaced with CJK punctuation",
  enKeys.every((k) => !/[\u3000\u3001\u3002\uff00-\uff60]/.test(en.t(k))) &&
  !contentSrc.includes("\u3000"));

/* ---------------- 3. nothing is hardcoded in the extension -------------- */
console.log("\n--- PART 3: the interface has no inline wording ---");

const hanLines = (src) => src.split("\n").filter((l) =>
  HAN.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !l.includes("i18n-ignore"));
check("index.js renders only dictionary text",
  hanLines(contentSrc).length === 0, hanLines(contentSrc).map((l) => l.trim()).join(" | ").slice(0, 160));
check("archive.js renders only dictionary text",
  hanLines(archiveSrc).length === 0, hanLines(archiveSrc).map((l) => l.trim()).join(" | ").slice(0, 160));
check("popup.js and background.js hold no wording of their own",
  hanLines(popupJs).length === 0 && hanLines(backgroundSrc).length === 0,
  hanLines(popupJs).map((l) => l.trim()).join(" | ").slice(0, 160));

// A typo in a key is invisible until the panel is opened, so every reference
// is resolved against both tables here.
const referenced = new Set();
for (const src of [contentSrc, archiveSrc, popupJs]) {
  for (const m of src.matchAll(/\bT\(\s*"([\w.-]+)"/g)) referenced.add(m[1]);
}
for (const m of popupHtml.matchAll(/data-i18n(?:-title|-aria)?="([\w.-]+)"/g)) referenced.add(m[1]);
const declared = new Set(zhKeys);
const unknownKeys = [...referenced].filter((k) => !declared.has(k));
check("every key the code and the popup markup ask for exists in the dictionary",
  unknownKeys.length === 0 && referenced.size > 150, unknownKeys.join(", ") || `${referenced.size} keys referenced`);
// The one place a key is assembled at runtime: failure ids.
const reasonIds = contentSrc.slice(contentSrc.indexOf("const REASON_KEYS"), contentSrc.indexOf("function failureReasonLabel"));
const unknownReasons = [...reasonIds.matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
  .filter((id) => !declared.has(`reason.${id}`));
check("every failure id has a label in both languages",
  unknownReasons.length === 0, unknownReasons.join(", ") || `${reasonIds.match(/"[a-z-]+"/g).length} ids`);
check("a failure id reads as a sentence, not as a key",
  zh.t("reason.no-progress") === "服务器未返回更早的消息" &&
  en.t("reason.no-progress") === "the server returned no earlier messages");

/* ---------------- 4. default and fallbacks ---------------- */
console.log("\n--- PART 4: Chinese is the default, on purpose ---");

check("a fresh dictionary is Chinese", loadDictionary().lang() === "zh-CN");
check("an unusable value normalises to Chinese rather than to English",
  loadDictionary().normalize("de") === "zh-CN" && loadDictionary().normalize("") === "zh-CN" &&
  loadDictionary().normalize(undefined) === "zh-CN");
check("regional tags map to the language we ship",
  zh.normalize("zh-TW") === "zh-CN" && en.normalize("en-GB") === "en" && en.normalize("EN") === "en");
check("the stored setting is Chinese by default in every script",
  contentSrc.includes('language: "zh-CN"') && popupJs.includes('language: "zh-CN"') &&
  backgroundSrc.includes('language: "zh-CN"'));
check("the language is never guessed from the browser",
  !/navigator\.language/.test(contentSrc) && !/navigator\.language/.test(popupJs) &&
  /Only a hint for the settings page; never applied automatically./.test(i18nSrc));

/* ---------------- 5. interpolation and plurals ---------------- */
console.log("\n--- PART 5: placeholders and English plurals ---");

check("counts interpolate into both languages",
  zh.t("pill.loadMore", { n: 3 }) === "加载 3 轮较早内容" &&
  en.t("pill.loadMore", { n: 3 }) === "Load 3 earlier turns");
check("English picks the singular form at one, Chinese is unaffected",
  en.t("pill.loadMore", { n: 1 }) === "Load 1 earlier turn" &&
  zh.t("pill.loadMore", { n: 1 }) === "加载 1 轮较早内容");
check("a marker-free placeholder still works",
  en.t("export.selectedCount", { n: 12 }) === "12 messages selected" &&
  zh.t("export.selectedCount", { n: 12 }) === "已选择 12 条消息");
check("an unknown placeholder is left alone instead of becoming undefined",
  en.t("pill.loadMore") === "Load {n} earlier {n?turn|turns}");

/* ---------------- 6. exports follow the interface ---------------- */
console.log("\n--- PART 6: generated files speak the chosen language ---");

function exportMarkdown(lang) {
  const ctx = { chrome: { storage: { local: { get: (k, cb) => cb({}), set: () => {}, remove: (k, cb) => cb && cb() } } }, URL, console };
  vm.createContext(ctx);
  vm.runInContext(`${I18N_BOOT}\n${lang === "en" ? 'QelvynoxI18n.setLang("en");\n' : ""}${archiveSrc}`, ctx);
  const A = ctx.QelvynoxArchive;
  return A.buildMarkdownExport({
    conversationId: "c1", title: "T", reachedStart: true, updatedAt: 1,
    messages: [{ id: "1", role: "User", text: "hello", images: [] }, { id: "2", role: "ChatGPT", text: "hi", images: [{ key: "k" }] }]
  }, { exportedAt: "DATE" });
}
const zhMd = exportMarkdown("zh-CN");
const enMd = exportMarkdown("en");
check("the archive Markdown export uses Chinese labels by default",
  zhMd.includes("### 你：") && zhMd.includes("导出时间：DATE") && !HAN.test(enMd));
check("…and English labels once the interface is English",
  enMd.includes("### You:") && enMd.includes("Exported: DATE") &&
  enMd.includes("[Image 1: included in the HTML export]"));

/* ---------------- 7. switching is a re-render, not a reload -------------- */
console.log("\n--- PART 7: the switch repaints everything ---");

check("the setting is applied before anything is rebuilt",
  /function qgstSaveSettings\(patch\) \{\s*appSettings = \{ \.\.\.appSettings, \.\.\.patch \};\s*applyLanguage\(\);/.test(contentSrc) &&
  /function loadSettings\(\)[\s\S]*?applyLanguage\(\);\s*if \(resolveSettingsReady\)[\s\S]*?renderAllTools\(\);/.test(contentSrc));
check("the language control is wired: data-action has a dispatcher branch",
  contentSrc.includes('action === "lang-zh" || action === "lang-en"') &&
  /changeLanguage\(action === "lang-zh" \? "zh-CN" : "en"\)/.test(contentSrc));
check("switching persists, repaints the live surfaces and rebuilds the panel",
  /function changeLanguage\(next\)[\s\S]*?qgstSaveSettings\(\{ language: value \}\);[\s\S]*?refreshLanguageSurfaces\(\);[\s\S]*?closeSettingsModal\(\);\s*openSettingsModal\(\);/.test(contentSrc));
const refreshBody = contentSrc.slice(contentSrc.indexOf("function refreshLanguageSurfaces()"), contentSrc.indexOf("function changeLanguage("));
check("an open panel is re-read in place, not closed under the user",
  /if \(outlineList\) \{\s*delete outlineList\.dataset\.sig;\s*renderOutlineList\(outlineList\);/.test(refreshBody) &&
  /delete bookmarksList\.dataset\.sig;\s*renderBookmarksList\(bookmarksList\);/.test(refreshBody) &&
  /bookmarksPopover\.querySelectorAll\("\.qelvynox-seg-item"\)/.test(refreshBody));
check("the repaint never destroys a panel the user pinned (and so never leaves its button lying)",
  !refreshBody.includes("closeOutlinePopover()") && !refreshBody.includes("closeBookmarksPopover()") &&
  !refreshBody.includes("togglePin()") && refreshBody.length > 400,
  `${refreshBody.length} chars in the refresh body`);
check("an open search bar keeps its keyword across a language switch",
  /const keepQuery = searchInput \? searchInput\.value : "";[\s\S]*?fresh\.value = keepQuery;\s*fresh\.dispatchEvent\(new Event\("input"\)\);/.test(contentSrc));
check("a language change from the popup or another tab repaints too",
  (contentSrc.match(/if \(\w+\.language !== previousLanguage\) refreshLanguageSurfaces\(\);/g) || []).length === 2);
check("the general page offers both languages and marks the active one",
  contentSrc.includes("function qgstGeneralPage()") &&
  contentSrc.includes('option("lang-zh"') && contentSrc.includes('option("lang-en"') &&
  contentSrc.includes('aria-pressed="${on}"'));
check("our own surfaces declare their language, and the host page's is left alone",
  /function applySurfaceLang\(\)[\s\S]*?el\.setAttribute\("lang", lang\)/.test(contentSrc) &&
  (contentSrc.match(/applySurfaceLang\(\);/g) || []).length === 2 &&
  !/documentElement\.setAttribute\("lang"/.test(contentSrc));

/* ---------------- 8. popup ---------------- */
console.log("\n--- PART 8: the popup shares the one dictionary ---");

check("the popup loads the dictionary before its own script",
  popupHtml.includes('src="../shared/i18n.js"') &&
  popupHtml.indexOf('src="../shared/i18n.js"') < popupHtml.indexOf('src="popup.js"'));
check("the popup has a language switch that says which one is active",
  popupHtml.includes('id="langZh"') && popupHtml.includes('id="langEn"') &&
  popupHtml.includes('data-lang="zh-CN"') && popupHtml.includes('data-lang="en"'));
check("every visible popup string is tagged for translation",
  popupHtml.split("\n").filter((l) => HAN.test(l) && !/^\s*(\/\/|\*|<!--)/.test(l.trim()) &&
    !l.includes("data-i18n") && !l.includes("data-lang=")).length === 0,
  popupHtml.split("\n").filter((l) => HAN.test(l) && !l.includes("data-i18n") &&
    !l.includes("data-lang=") && !/<!--|^\s*\*/.test(l.trim())).map((l) => l.trim()).join(" | ").slice(0, 160));
check("the popup saves the language instead of dropping it on the floor",
  /getCurrentSettings\(\) \{\s*return \{\s*language: currentLanguage,/.test(popupJs) &&
  /chrome\.storage\.local\.set\(\{ \[SETTINGS_KEY\]: settings \}\);\s*syncTabSettings\(settings\);/.test(popupJs));
check("icons are never overwritten by a translation (labels sit in their own span)",
  /<span data-i18n="popup\.openSettings">/.test(popupHtml) &&
  /<span data-i18n="popup\.exportPickBtn">/.test(popupHtml));

const failed = results.filter((x) => !x.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
