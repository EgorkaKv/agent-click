// Shared test support for test/browser/*: a local HTTP server for fixtures and API routes,
// a polling helper, and a separately launched Brave with --remote-debugging-port=0 for connect tests.
// Never touches the user's browser or profile.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { FIXTURES } from "../helpers/browser.js";

export const DEFAULT_BROWSER = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";

export interface FixtureServer {
  base: string;
  close: () => Promise<void>;
}

/**
 * Routes:
 *   GET  /page/<name>      test/fixtures/<name>
 *   POST /api/ok           200 {"ok":true}
 *   POST /api/conflict     409 JSON body
 *   GET  /api/items        200 []
 *   GET  /api/slow         200 after 800 ms
 *   GET  /api/slow500      200 after 500 ms
 *   ANY  /collect          204 after 800 ms (telemetry-like path)
 */
export function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const sendLater = (ms: number, status: number, body: string) => setTimeout(() => send(status, body), ms);

    if (req.method === "GET" && url.pathname.startsWith("/page/")) {
      const name = url.pathname.slice("/page/".length);
      const file = join(FIXTURES, name);
      if (!/^browser-[\w-]+\.html$/.test(name) || !existsSync(file)) return send(404, "not found", "text/plain");
      return send(200, readFileSync(file, "utf8"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/collect") return sendLater(800, 204, "");
    if (req.method === "POST" && url.pathname === "/api/ok") return send(200, '{"ok":true}');
    if (req.method === "POST" && url.pathname === "/api/conflict") {
      return send(409, '{"error":"version_conflict","detail":"item changed by another user"}');
    }
    if (req.method === "GET" && url.pathname === "/api/items") return send(200, "[]");
    if (req.method === "GET" && url.pathname === "/api/slow") return sendLater(800, 200, '{"slow":true}');
    if (req.method === "GET" && url.pathname === "/api/slow500") return sendLater(500, 200, '{"name":"slow"}');
    send(404, "not found", "text/plain");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Polls `check` until it returns true or the timeout passes. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, pollMs = 25): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Launches Brave on its own temp profile with remote debugging on a random port, as the user would expose it. */
export async function launchDebugBrowser(): Promise<{ userDataDir: string; close: () => Promise<void> }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "agent-click-connect-"));
  const exe = process.env.AGENT_CLICK_TEST_BROWSER ?? DEFAULT_BROWSER;
  const proc: ChildProcess = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const activePort = join(userDataDir, "DevToolsActivePort");
  await waitFor(() => existsSync(activePort), 30_000, 100);

  return {
    userDataDir,
    close: async () => {
      const exited = new Promise<void>((done) => {
        if (proc.exitCode !== null) return done();
        proc.once("exit", () => done());
      });
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Browser processes may still hold files for a moment on Windows; the temp dir is harmless.
      }
    },
  };
}
