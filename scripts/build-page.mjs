// Bundles the in-page script (src/page/index.ts) into a single IIFE string.
// The server injects dist/page.js into every frame it inspects.
import { build } from "esbuild";

await build({
  entryPoints: ["src/page/index.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outfile: "dist/page.js",
  minify: false,
  legalComments: "none",
});
console.log("built dist/page.js");
