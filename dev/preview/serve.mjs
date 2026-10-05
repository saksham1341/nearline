// `npm run preview`: the real web client against a fake API, for UI work without deploying.
// Serves public/, injects dev/preview/mock-api.js into the app page, and rebuilds app.js on every change
// under apps/ or packages/. Reload the browser to see edits to HTML or CSS.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const publicDir = join(root, "public");
const mockPath = join(root, "dev/preview/mock-api.js");
const port = Number(process.env.PORT ?? 8788);

const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
};

const build = await esbuild.context({
  entryPoints: [join(root, "apps/web/main.ts")],
  bundle: true, format: "esm", target: "es2022", outfile: join(publicDir, "app.js"),
  logLevel: "info",
});
await build.watch();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/__preview/mock-api.js") return send(response, 200, types[".js"], await readFile(mockPath));

    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!extname(path) && !path.startsWith("/api/")) path += ".html";
    const file = normalize(join(publicDir, path));
    if (!file.startsWith(publicDir) || !(await stat(file).catch(() => null))?.isFile()) {
      return send(response, 404, types[".txt"], "Not found");
    }
    let body = await readFile(file);
    if (path === "/index.html") {
      body = Buffer.from(String(body).replace('<script type="module"', '<script src="/__preview/mock-api.js"></script>\n    <script type="module"'));
    }
    send(response, 200, types[extname(file)] ?? "application/octet-stream", body);
  } catch (error) {
    send(response, 500, types[".txt"], String(error));
  }
});

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

server.listen(port, () => {
  console.log(`\nNearline preview: http://localhost:${port}`);
  console.log(`  signed out:    http://localhost:${port}/#gate`);
  console.log(`  empty feed:    http://localhost:${port}/#empty`);
  console.log("  fake API, fixed location; posts, replies, likes, reposts and deletes work in memory.\n");
});
