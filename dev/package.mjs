// Builds the Chrome Web Store upload archive: only what the extension loads.
//
//   node dev/package.mjs            -> qelvynox-<version>.zip
//
// Zero dependencies, and the zip is written with the same STORE + CRC32 method
// the extension's own .docx writer uses, so there is no build tool to install.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// Everything the manifest references, plus the license. logo.png is the source
// artwork for the icon set, not something the extension reads at runtime.
const FILES = [
  "manifest.json",
  "LICENSE",
  "src/shared/i18n.js",
  "src/background/background.js",
  "src/content/archive.js",
  "src/content/index.js",
  "src/content/settings.css",
  "src/page/mainWorld.js",
  "src/popup/popup.css",
  "src/popup/popup.html",
  "src/popup/popup.js"
];

// A manifest that names `default_locale` is only valid with every locale
// folder present, so they are collected from disk rather than listed by hand:
// a new language must not be able to ship without its messages.json.
if (manifest.default_locale) {
  for (const locale of fs.readdirSync(path.join(ROOT, "_locales"), { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    FILES.push(`_locales/${locale.name}/messages.json`);
  }
}

for (const size of ["16", "32", "48", "128", "512"]) {
  FILES.push(`icons/icon${size}.png`);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v) => [v & 255, (v >> 8) & 255];
const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

const entries = [];
const central = [];
let offset = 0;

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`missing ${rel}`);
    process.exit(1);
  }
  const data = fs.readFileSync(abs);
  const name = Buffer.from(rel.split(path.sep).join("/"), "utf8");
  const crc = crc32(data);
  const header = Buffer.from([
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
    ...u16(0), ...u16(0),
    ...u32(crc), ...u32(data.length), ...u32(data.length),
    ...u16(name.length), ...u16(0)
  ]);
  entries.push(header, name, data);

  central.push(Buffer.from([
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
    ...u16(0), ...u16(0),
    ...u32(crc), ...u32(data.length), ...u32(data.length),
    ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(offset)
  ]), name);

  offset += header.length + name.length + data.length;
}

const centralStart = offset;
const centralBuf = Buffer.concat(central);
const end = Buffer.from([
  ...u32(0x06054b50), ...u16(0), ...u16(0),
  ...u16(FILES.length), ...u16(FILES.length),
  ...u32(centralBuf.length), ...u32(centralStart), ...u16(0)
]);

const outName = `qelvynox-${manifest.version}.zip`;
const out = path.join(ROOT, outName);
fs.writeFileSync(out, Buffer.concat([...entries, centralBuf, end]));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${outName}  ${kb(fs.statSync(out).size)}  (${FILES.length} files)`);
console.log(`  code+css ${kb(FILES.filter((f) => /\.(js|css|html)$/.test(f))
  .reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0))}`);
console.log("  excluded: dev/, tests/, screenshots/, docs/, README*, CHANGELOG, icons/logo.png, *.png posters");
