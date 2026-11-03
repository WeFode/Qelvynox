# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x     | :white_check_mark: |
| 3.x (as TurboGPT) | :warning: only while the source is still published |
| < 3.0   | :x: |

Qelvynox is distributed as readable source: there is no build step, no bundler and
no third-party dependency, so the code you install is the code in this repository.

## Reporting a vulnerability

Open a **private security advisory** on GitHub rather than a public issue, so a fix
can land before the problem is discoverable by anyone reading the issue list.

Please include what you found, which surface it affects and how to reproduce it.
Expect a reply within a week and a fix or a written explanation shortly after.

## What this extension is designed not to do

- **No telemetry, analytics or crash reporting.** There is no code path that sends
  anything anywhere except OpenAI's own hosts.
- **Session reuse.** Conversation requests may reuse ChatGPT request headers and browser credentials for OpenAI services. The extension does not intentionally persist or log credentials.
- **No remote code.** Every script ships inside the package; nothing is fetched and
  evaluated at runtime. This is also why no `chrome.scripting` or dynamic-import
  permission is requested.
- **No broad host access.** Content scripts are limited to `chatgpt.com` and
  `chat.openai.com`; the one extra host permission (`*.oaiusercontent.com`) is used
  only to read image bytes, over HTTPS, and the service worker rejects the request
  unless it came from this extension's own scripts.
- **No DOM injection into chat content.** Search highlights are painted with the
  Custom Highlight API, and the speed booster hides wrappers rather than removing
  nodes React owns.
- **Escaped exports.** Every message string written into an exported HTML, DOCX or
  PDF document is escaped first, and image data URLs are validated against the
  base64 alphabet before they are embedded.

## Hardening notes for contributors

- Keep the `data-qelvynox` ownership tag on every injected node: the observer's
  self-mutation filter depends on it, and without it the extension re-triggers
  itself in a permanent loop.
- Any new `innerHTML` must take only literals plus `esc()`-ed values; user content
  goes through `textContent`.
- Never add a permission without a matching justification in
  [docs/store-listing.md](docs/store-listing.md).
