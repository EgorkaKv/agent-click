import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { connectBrowser, defaultUserDataDirs, readDevToolsActivePort } from "../../src/browser/connect.js";
import { launchDebugBrowser } from "./support.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-click-conn-unit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("defaultUserDataDirs", () => {
  it("uses only AGENT_CLICK_USER_DATA_DIR when it is set", () => {
    vi.stubEnv("AGENT_CLICK_USER_DATA_DIR", "C:/custom/profile");
    expect(defaultUserDataDirs()).toEqual(["C:/custom/profile"]);
  });

  it("lists Brave before Chrome on Windows", () => {
    vi.stubEnv("AGENT_CLICK_USER_DATA_DIR", "");
    if (process.platform !== "win32") return;
    vi.stubEnv("LOCALAPPDATA", "C:/Users/x/AppData/Local");
    expect(defaultUserDataDirs()).toEqual([
      join("C:/Users/x/AppData/Local", "BraveSoftware", "Brave-Browser", "User Data"),
      join("C:/Users/x/AppData/Local", "Google", "Chrome", "User Data"),
    ]);
  });
});

describe("readDevToolsActivePort", () => {
  it("parses port and websocket path", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/abc-123\n");
    expect(readDevToolsActivePort(dir)).toEqual({ port: 9222, path: "/devtools/browser/abc-123" });
  });

  it("returns null for a missing or malformed file", () => {
    const dir = tempDir();
    expect(readDevToolsActivePort(dir)).toBeNull();
    writeFileSync(join(dir, "DevToolsActivePort"), "not-a-port\n/devtools/browser/x\n");
    expect(readDevToolsActivePort(dir)).toBeNull();
    writeFileSync(join(dir, "DevToolsActivePort"), "9222\nno-slash\n");
    expect(readDevToolsActivePort(dir)).toBeNull();
  });
});

describe("connectBrowser errors", () => {
  it("missing file tells the user to enable remote debugging", async () => {
    const dir = tempDir();
    await expect(connectBrowser({ userDataDir: dir })).rejects.toThrow(/brave:\/\/inspect\/#remote-debugging/);
  });

  it("stale file (nothing listening) says the browser is probably not running", async () => {
    const dir = tempDir();
    const closed = await new Promise<number>((resolve) => {
      const s: Server = createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(port));
      });
    });
    writeFileSync(join(dir, "DevToolsActivePort"), `${closed}\n/devtools/browser/stale\n`);
    await expect(connectBrowser({ userDataDir: dir })).rejects.toThrow(/not running|stale/);
  });

  it("timeout asks the user to approve the Allow prompt", async () => {
    const dir = tempDir();
    // Accepts TCP but never answers the websocket handshake, like a browser waiting for the Allow click.
    const hanging: Server = createServer(() => {});
    const port = await new Promise<number>((resolve) =>
      hanging.listen(0, "127.0.0.1", () => resolve((hanging.address() as AddressInfo).port)),
    );
    writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/hang\n`);
    try {
      const started = Date.now();
      await expect(connectBrowser({ userDataDir: dir, timeoutMs: 800 })).rejects.toThrow(/Allow/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      hanging.close();
    }
  });
});

describe("connectBrowser to a real debug-enabled browser", () => {
  it("reads DevToolsActivePort and connects", async () => {
    const debug = await launchDebugBrowser();
    try {
      expect(readDevToolsActivePort(debug.userDataDir)).not.toBeNull();
      const browser = await connectBrowser({ userDataDir: debug.userDataDir, timeoutMs: 20_000 });
      try {
        expect(await browser.version()).toMatch(/\//);
        const page = await browser.newPage();
        await page.setContent("<p>ok</p>");
        expect(await page.$eval("p", (p) => p.textContent)).toBe("ok");
        await page.close();
      } finally {
        browser.disconnect();
      }
    } finally {
      await debug.close();
    }
  }, 90_000);
});
