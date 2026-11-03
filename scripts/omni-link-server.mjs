// Explicit Node HTTPS host for the existing link handler. Never started by web builds/cron.
import { registerHooks } from "node:module";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/"))
      return next(pathToFileURL(resolve(root, "src", specifier.slice(2) + ".ts")).href, context);
    if (
      specifier.startsWith("./") &&
      context.parentURL?.endsWith(".ts") &&
      !specifier.endsWith(".ts")
    )
      return next(new URL(specifier + ".ts", context.parentURL).href, context);
    return next(specifier, context);
  },
});
const { handleOmniLink, linkConfig } = await import("../src/lib/omni-session.server.ts");
const { protocolRunnerAvailable } = await import("../src/lib/omni-session-runner.server.ts");
export function createLinkServer(tls, origin, handler = handleOmniLink) {
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw Error("HTTPS origin required");
  let inflight = 0;
  const server = createServer({ ...tls, minVersion: "TLSv1.2" }, async (req, res) => {
    const expected = new URL(base);
    if (expected.port === "0") expected.port = String(server.address().port);
    if (
      req.headers.host !== expected.host ||
      req.url !== "/api/public/omni/link" ||
      req.method !== "POST"
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (inflight >= 32) {
      res.writeHead(429);
      res.end();
      return;
    }
    inflight++;
    try {
      const request = new Request(expected.origin + req.url, {
        method: "POST",
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: "half",
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      res.writeHead(503, { "Cache-Control": "no-store" });
      res.end('{"error":"link_unavailable"}');
    } finally {
      inflight--;
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return server;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!linkConfig() || !protocolRunnerAvailable())
      throw Error("Scoped configuration and explicit Node runner opt-in required");
    const cert = await readFile(process.env["OMNI_LINK_TLS_CERT_FILE"]);
    const key = await readFile(process.env["OMNI_LINK_TLS_KEY_FILE"]);
    const origin = process.env["JACKBOY_LINK_ORIGIN"];
    const port = Number(new URL(origin).port || 443);
    const server = createLinkServer({ cert, key }, origin);
    server.listen(port, process.env["OMNI_LINK_BIND_ADDRESS"] || "127.0.0.1", () =>
      console.log("Scoped OMNI link HTTPS listener started"),
    );
    server.on("error", () => {
      console.error("OMNI link listener failed");
      process.exitCode = 1;
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
  } catch {
    console.error("OMNI link startup refused; check approved configuration and TLS files");
    process.exitCode = 1;
  }
}
