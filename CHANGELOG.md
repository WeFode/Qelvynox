# Changelog

All notable changes to **Qelvynox** are documented here. Releases numbered 3.x and
below shipped under the name **TurboGPT**; the internal 4.0.0 build was renumbered
to **1.0.0** for the first public release, so the store shows a clean starting
version instead of a borrowed history.

## v1.0.0 — Qelvynox, first public release

The rename, the two bugs people actually hit, and the pass that turned a working
toolkit into something worth publishing.

### Brand
- 🏷️ **TurboGPT is now Qelvynox.** Every identifier moved with the name — CSS
  classes, element ids, message types, storage keys, the injected `data-*` tag.
- 🔁 **Nothing is lost on upgrade.** `turbogpt_config`, `turbogpt_folders`,
  `turbogpt_bookmarks_*` and `turbogpt_settings` are copied to their new keys on
  first load, and legacy keys are never deleted (chatgpt.com's localStorage is
  shared with the page, so an older build in another profile keeps working). The
  local archive is deliberately not copied: it is a cache that refills itself
  from ChatGPT on the next visit.
- 🎨 **New identity.** Icons rebuilt from the supplied `icons/logo.png` at
  16/32/48/128/512, with the black canvas punched out into an anti-aliased
  rounded alpha mask, plus a 440×280 store promo tile. The in-page brand mark is
  now a `Q` ring-and-tail instead of the old lightning bolt.
- 🎨 **One brand accent.** The mark's periwinkle orbit became a single token
  (`--qg-brand` / `--su-brand`) used only where a surface has to say "this is
  live": the row you are reading, the pinned button, the badge, the match
  counter, the focus ring. Everything else stays neutral so the toolkit does not
  fight ChatGPT's canvas.

### Language
- 🌐 **The interface ships in Chinese *and* English.** Every string the user can
  read moved out of the extension files and into one dictionary
  (`src/shared/i18n.js`) with a parallel table per language, so a switch cannot
  leave one panel behind in the other language. The picker lives in
  设置 → 通用 → 界面语言 and at the top of the toolbar popup, applies immediately
  with no reload, and is remembered.
- 🀄 **Chinese is the default, on purpose.** The language is a stored setting, not
  a guess from `navigator.language`, so the interface does not change when you
  travel with your browser profile. An unusable value falls back to Chinese.
- 🧾 **Exported files follow the interface.** Word / PDF / Markdown / TXT / JSON
  labels and the continuation prompt are generated in the chosen language; your
  conversation text is never translated.
- 🔤 **English gets real plurals.** `{n?turn|turns}` resolves per count, so
  "Load 1 earlier turn" and "Load 5 earlier turns" are both correct while the
  Chinese table stays unmarked.
- 🏷️ **Store listing and the browser's own extension UI** are localised through
  `_locales/zh_CN` + `_locales/en` with `default_locale: "zh_CN"`; the manifest now
  resolves `name`, `description` and the toolbar tooltip from `__MSG_*__`.

### Fixed
- 🧭 **The navigator, the bookmarks panel and an open search now update live.**
  They used to be rendered only when opened, so a fourth reply stayed out of the
  navigator — and out of an open search — until you closed and reopened the
  panel. Everything that reads the conversation is now refreshed from the one
  debounced observer tick, guarded by a content signature so an idle panel costs
  nothing.
- 🔍 **Search follows a streaming answer.** The bar used to refuse to repaint
  mid-stream; it now repaints throttled (900 ms) and never yanks the scroll
  position away from the reader.
- 🧱 **The dock stopped rebuilding itself.** A new reply used to recreate every
  dock button just to change one digit in the badge, dropping the pinned look,
  the hover state and keyboard focus. The signature now describes which buttons
  *exist*; the count is patched in place.
- 🔁 **Re-hovering an open popover no longer flickers.** The panel was removed and
  re-appended on every `mouseenter`, replaying the entry animation and scrolling
  the list back to the top. An already-open panel is refreshed in place and keeps
  its scroll position.
- 📋 **The bookmarks list is idempotent.** The observer tick re-rendering an open
  panel used to append the whole list underneath the first copy.
- ➖ **A background repaint no longer inflates the reveal reservation.** Every
  search refresh added 2 to `manuallyUnhiddenTurnsCount`, quietly loosening the
  turn limit until the whole history came back.
- 📤 **Exports no longer lose loose text.** `domToBlocks` walked only *element*
  children, so a message written as `sentence <b>bold</b> sentence` exported the
  single bold word and dropped every sentence around it. Containers are now
  walked in document order, with bare text nodes joining the inline run.
- 🌗 **The last media query is gone.** The top-bar Export button and the load pill
  were still themed by `prefers-color-scheme`, which can disagree with ChatGPT's
  own toggle; both now follow the page.
- 🖨️ **Toasts wrap and stack.** `white-space: nowrap` used to cut a long Chinese
  notice off at the window edge, and two notices shared one offset and read as
  one garbled line.

### Polish
- ♿ Keyboard and screen-reader support across the floating UI: focus rings on
  every icon-only control, navigator rows are tab-stops with `Enter`/`Space`,
  `role`/`aria-label`/`aria-live` on the popovers, the search bar and toasts.
- 🎬 `prefers-reduced-motion` honoured by the dock, popovers, search, export
  window, settings panel and popup.
- ⌨️ The search bar states its own shortcuts (`Enter` / `Shift+Enter` / `Esc`)
  instead of hiding them until a keyword failed; the hint line doubles as the
  no-match notice so the bar keeps one height.
- 📐 Popovers clamp to the viewport (`max-width: calc(100vw - 92px)`) and get a
  thin themed scrollbar instead of 15 px of OS chrome.
- 🈳 The popup follows the browser theme instead of always rendering white.
- 🗂 Sidebar folder rows use line icons; the pictographic waste-basket and the
  text-glyph chevrons are gone.
- 📊 A "no data yet" count no longer borrows the green of a real loaded count.
- 🪟 The load pill updates its label in place instead of removing and re-inserting
  itself at the top of the conversation.

### Release
- 🔐 Permissions reduced to `storage` + `unlimitedStorage`. `tabs` and `activeTab`
  are dropped: the ChatGPT host permissions already expose `tab.url`, and settings
  reach other tabs through `chrome.storage.onChanged` anyway. No browsing-history
  access in the listing.
- 📄 Added `docs/privacy.md` (English plus a Chinese summary), `docs/store-listing.md`
  (both item languages, with the permission justifications, the single-purpose
  statement and the publish checklist) and `dev/package.mjs` for the upload archive.
- 🧪 New suite `tests/live-update.test.mjs` pins the live-refresh rules, the
  migration, the manifest and the design system; `tests/i18n-language.test.mjs` pins
  the dictionary (parity, no hardcoded wording, defaults, plurals, the switch
  repaint and both export languages); the export suite pins the loose-text fix.
  **11 suites / 543 assertions.**
- 📸 `dev/shots.mjs` regenerates every store screenshot from the real UI in
  headless Chrome at 1280×800 — the pictures are the product, not a mockup.

---

## Earlier releases (as TurboGPT)

### v3.17.0
The last three surfaces caught up with the design system, and two got radically
simpler: the export window moved onto the shared neutral tokens with line icons
and `Esc`; the navigator became a headerless hover popover that follows the
viewport; bookmarks moved to their own dock button with a `本对话 / 全部` switch;
search became one command bar painted through the Custom Highlight API instead of
a result list that rewrote the page.

### v3.16.0
Redesigned around the in-page settings panel. The control surface moved from the
toolbar popup into ChatGPT itself (feature list left, detail page right), every
switch applies immediately, and the dock's outline button became a position map.
Removed the token/context estimator and the message-count alert — a percentage
derived from character counts invited decisions people should not make on a
guess. No commercial layer at all. Chinese throughout.

### v3.15.0
Archive saves write only the messages that changed (a 756-message chat went from
~138 MB written during one history fill to a few KB per reply). Page captures trust
only server-confirmed ids, so a question and its answer can never merge. Newest
turns come from one throttled GET of ChatGPT's own opening request. Full-history
search reads the local archive instead of walking the server for 30 seconds.

### v3.14.x
Windowed DOM rendering for very long chats, plus two hotfixes: older turn nodes are
never physically removed while React owns them (that was the "ChatGPT hit a snag"
crash), and the auto-load loop no longer treats the sentinel's first visibility as a
user scroll.

### v3.13.0
Live-verified against a real account. Backwards pagination now uses the endpoint
ChatGPT actually pages from (`/messages?before=…`), which fixes full-conversation
export and history loading stopping after one page. Added the background history
fill, image archiving through the file endpoint, and citation-token stripping in
exports.

### v3.12.0
Local conversation archive, on by default: the payload ChatGPT already loads is
copied to `chrome.storage.local`, images are saved as bytes, and two instant
exports (self-contained HTML, text-only Markdown) never touch the network.

### v3.11.0
Smoothness overhaul. Qelvynox's own DOM writes were re-triggering its observer in a
permanent 350 ms loop; owned nodes are now tagged and filtered out, forced layout
per tick removed, scroll and wheel handlers coalesced to one check per frame, and
background tabs go quiet.

### v3.5 – v3.10
Whole-conversation export and the continuation prompt; export extraction moved from
`innerText` to a DOM walk so code fences, links, lists and tables survive; the real
conversation counter with honest partial-count states; a pagination contract learned
from ChatGPT's own request rather than guessed; temporary-chat support; the top-bar
Export button.

### v3.2 – v3.4
Selective export with genuine `.docx` generation; full dark mode for the floating
surfaces; XSS hardening and the removal of Bearer-token interception; polling replaced
by a debounced `MutationObserver`; the sidebar folder organizer.
