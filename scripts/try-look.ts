// Dev check: connect to the real browser, run look on the active tab, save text + marked screenshot.
// Usage: npx tsx scripts/try-look.ts <outDir>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Session } from "../src/core/session.js";
import { View } from "../src/core/view.js";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });
const session = new Session();
const view = new View(session);
const t0 = Date.now();
await session.current();
const t1 = Date.now();
const res = await view.look({ image: "always" });
const t2 = Date.now();
writeFileSync(join(out, "look.txt"), res.text);
if (res.image) writeFileSync(join(out, "look.jpg"), res.image);
console.log(`connect ${t1 - t0} ms, look ${t2 - t1} ms, text ${res.text.length} chars, image ${res.image?.length ?? 0} bytes`);
process.exit(0);
