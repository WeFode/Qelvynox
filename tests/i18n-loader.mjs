/**
 * Test helper: loads the real src/shared/i18n.js.
 *
 * Every extension file that renders text now goes through T()/I18N, so a vm
 * context that runs a grabbed function has to have the dictionary installed
 * first. I18N_BOOT is meant to be prepended to whatever a suite already runs:
 *
 *   vm.runInContext(I18N_BOOT + grab("renderOutlineList", contentSrc), ctx);
 *
 * Suites that assert on wording use the default language (zh-CN), so the
 * Chinese strings they were written against still come out of the dictionary.
 * Pass a language to loadDictionary() to assert on the other one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const i18nSrc = fs.readFileSync(path.join(REPO, "src/shared/i18n.js"), "utf8");

// The module publishes itself on globalThis; the extension files read it
// through two aliases, and a sliced-out vm context needs both plus the
// document-language helper the exporters use.
export const I18N_BOOT = `${i18nSrc}
globalThis.T = (key, vars) => globalThis.QelvynoxI18n.t(key, vars);
globalThis.I18N = globalThis.QelvynoxI18n;
globalThis.htmlLang = () => globalThis.QelvynoxI18n.lang();
`;

/** An isolated dictionary instance, for parity and rendering assertions. */
export function loadDictionary(lang) {
  const sandbox = {};
  new Function("globalThis", i18nSrc)(sandbox);
  const api = sandbox.QelvynoxI18n;
  if (!api) throw new Error("src/shared/i18n.js did not define QelvynoxI18n");
  if (lang) api.setLang(lang);
  return api;
}
