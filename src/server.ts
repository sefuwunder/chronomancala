// chronomancala static server — zero dependencies.
import { join, extname } from "path";

const PORT = Number(process.env.PORT || 3021);
const root = join(import.meta.dir, "..", "public");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    let p = new URL(req.url).pathname;
    if (p === "/") p = "/index.html";
    if (p.includes("..")) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(root, p));
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": types[extname(p)] || "application/octet-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`chronomancala on http://127.0.0.1:${PORT}`);
