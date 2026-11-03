// Dev-only static server for the UI harness: node dev/serve.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };
const HARNESS = path.join(ROOT, "dev", "ui-harness.html");

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  // /c/<id> is the harness too, just with a conversation id in the path: that
  // is what the local archive and the bookmarks key themselves off, so without
  // this route those two features can never be eyeballed locally.
  const file = /^\/c\//.test(urlPath) ? HARNESS : path.join(ROOT, urlPath);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": (TYPES[path.extname(file)] || "application/octet-stream") + "; charset=utf-8" });
    res.end(data);
  });
}).listen(8123, () => console.log("harness on http://127.0.0.1:8123 (or /c/demo-chat for archive + bookmarks)"));
