// Bundles the in-page script (src/page/index.ts) into a single IIFE string.
// The server injects dist/page.js into every frame it inspects.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/page/index.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  write: false,
  minify: false,
  legalComments: "none",
});
// A tab keeps the script it got first; a new build must replace it, so the version is the content hash.
const code = result.outputFiles[0].text;
const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/page.js", code.replaceAll("__AGENT_CLICK_BUILD__", hash));
console.log(`built dist/page.js (${hash})`);
