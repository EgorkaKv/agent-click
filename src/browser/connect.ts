import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

const ACTIVE_PORT_FILE = "DevToolsActivePort";
const TIMED_OUT = Symbol("timed-out");

/** Candidate User Data directories, in priority order. */
export function defaultUserDataDirs(): string[] {
  const override = process.env.AGENT_CLICK_USER_DATA_DIR;
  if (override) return [override];

  const home = homedir();
  switch (process.platform) {
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return [
        join(local, "BraveSoftware", "Brave-Browser", "User Data"),
        join(local, "Google", "Chrome", "User Data"),
      ];
    }
    case "darwin": {
      const base = join(home, "Library", "Application Support");
      return [join(base, "BraveSoftware", "Brave-Browser"), join(base, "Google", "Chrome")];
    }
    default: {
      const base = process.env.XDG_CONFIG_HOME || join(home, ".config");
      return [join(base, "BraveSoftware", "Brave-Browser"), join(base, "google-chrome")];
    }
  }
}

/**
 * Reads `<userDataDir>/DevToolsActivePort`: line 1 is the port, line 2 is the
 * browser websocket path. Returns null if the file is missing or malformed.
 */
export function readDevToolsActivePort(userDataDir: string): { port: number; path: string } | null {
  let text: string;
  try {
    text = readFileSync(join(userDataDir, ACTIVE_PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number((portLine ?? "").trim());
  const path = (pathLine ?? "").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith("/")) return null;
  return { port, path };
}

/** True unless the port is definitely closed (ECONNREFUSED). Other outcomes are left to puppeteer. */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(err.code !== "ECONNREFUSED");
    });
  });
}

/**
 * Connects to the user's running browser through its remote debugging endpoint.
 * The browser shows an "Allow" prompt on each new connection, so this can take a while.
 */
export async function connectBrowser(opts: { userDataDir?: string; timeoutMs?: number } = {}): Promise<Browser> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const dirs = opts.userDataDir ? [opts.userDataDir] : defaultUserDataDirs();

  let found: { dir: string; port: number; path: string } | undefined;
  for (const dir of dirs) {
    const info = readDevToolsActivePort(dir);
    if (info) {
      found = { dir, ...info };
      break;
    }
  }
  if (!found) {
    throw new Error(
      `No ${ACTIVE_PORT_FILE} file found in: ${dirs.join(", ")}. ` +
        `Open brave://inspect/#remote-debugging in the browser and enable ` +
        `"Allow remote debugging for this browser instance", then retry.`,
    );
  }

  const file = join(found.dir, ACTIVE_PORT_FILE);
  if (!(await isPortOpen(found.port))) {
    throw new Error(
      `Nothing listens on 127.0.0.1:${found.port} (${file} is stale): the browser is probably not running. ` +
        `Start the browser, enable remote debugging at brave://inspect/#remote-debugging, then retry.`,
    );
  }

  const endpoint = `ws://127.0.0.1:${found.port}${found.path}`;
  const connecting = puppeteer.connect({
    browserWSEndpoint: endpoint,
    defaultViewport: null,
    protocolTimeout: 30_000,
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const result = await Promise.race([connecting, timeout]);
    if (result === TIMED_OUT) {
      // If the handshake completes late, drop that connection instead of leaking it.
      connecting.then((b) => b.disconnect()).catch(() => {});
      throw new Error(
        `Timed out after ${timeoutMs} ms connecting to the browser. ` +
          `Approve the remote debugging prompt (Allow) in the browser window and retry.`,
      );
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Timed out after")) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to the browser at ${endpoint}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
