# Contributing to Qelvynox

Thank you for your interest in contributing to Qelvynox! We welcome contributions from developers, designers, and enthusiasts worldwide.

There is no build step and no dependency to install: the extension is plain
Manifest V3 source, and the test runner uses only Node's standard library.

---

## Before you write code

```bash
node tests/run.mjs     # 11 suites, 543 assertions - must be green on your branch too
node dev/serve.mjs     # http://127.0.0.1:8123/c/demo-chat - the real UI, both themes, both languages
```

`dev/ui-harness.html` stubs `chrome.*`, loads the actual `src/shared/i18n.js`,
`src/content/archive.js` and `src/content/index.js` plus `src/content/settings.css`,
and renders a ChatGPT-shaped conversation. Use it to see what you changed instead of
trusting that it compiled. `node dev/shots.mjs` regenerates the store screenshots from
that same harness.

Two rules the codebase is built around, and the tests exist to keep them:

- **Never remove or replace a node React owns.** Hide its wrapper and recalculate the
  virtualizer rail instead; the alternative is a `NotFoundError` crash for the user.
- **Tag every node you inject** with `markOwned()`. The observer's self-mutation filter
  relies on it; untagged writes make the extension re-trigger itself forever.
- **No wording in the extension files.** Every string a user can read lives in
  `src/shared/i18n.js` as one key in *both* tables, and is rendered through `T()`;
  the popup tags its markup with `data-i18n`. `tests/i18n-language.test.mjs` fails a
  branch that hardcodes a Chinese or English literal (the only exception is matching
  ChatGPT's own translated controls, which needs `/* i18n-ignore */`). The store name,
  summary and tooltip are a separate layer and live in `_locales/<locale>/messages.json`.

---

## How to Contribute

1. **Fork the Repository** to your own GitHub account.
2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/your-username/qelvynox.git
   ```
3. **Create a new branch** for your feature or bugfix:
   ```bash
   git checkout -b feature/amazing-feature
   ```
4. **Make your changes**, run `node tests/run.mjs`, and load the folder unpacked at
   `chrome://extensions` to check it on a real conversation.
5. **Add or update a test** for anything a user could notice. A check that names the
   behaviour ("an already-open navigator is re-read, not torn down") outlives a check
   that names the markup.
6. **Commit and push**, then open a Pull Request that explains the *why*.

Chinese is the default interface language and stays that way until the user says
otherwise; never key the UI off `navigator.language`. Use line icons rather than emoji
in any injected surface, and give every icon-only control a visible focus ring.

---

## Code of Conduct & Principles
- Keep the extension 100% private, local-only, and free of any telemetry.
- Stay free and complete: no paid tier, no trial badge, no upsell screen, no ads.
- Never invent a number the user cannot verify - a partial count is labelled partial.
- Respect all users and maintain clean, readable code.
