// Measures one Claude Code session from its transcript: context, time, token usage.
// Usage: node scripts/measure-session.mjs <session.jsonl> [--from <ISO time>] [--to <ISO time>]
// Subagent transcripts (<session>/subagents/*.jsonl) are counted too, shown separately.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Weights relative to an uncached input token (Anthropic pricing ratios, the same for all current models):
// cache write 5 min ×1.25, cache write 1 h ×2, cache read ×0.1, output ×5.
const W = { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 };

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !/^\d{4}-/.test(a));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Date.parse(args[i + 1]) : undefined;
};
const from = opt("from");
const to = opt("to");
if (!file) {
  console.error("usage: node scripts/measure-session.mjs <session.jsonl> [--from ISO] [--to ISO]");
  process.exit(1);
}

function entries(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.timestamp && (!from || Date.parse(e.timestamp) >= from) && (!to || Date.parse(e.timestamp) <= to));
}

function measure(list) {
  const tokens = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, thinking: 0 };
  const models = new Set();
  const requests = new Set();
  let peak = 0;
  let last = 0;
  const pending = new Map(); // tool_use id → { name, t }
  const tools = new Map(); // name → { calls, ms, chars, images }
  let userWait = 0;
  let lastAssistant;
  let images = 0;

  for (const e of list) {
    const t = Date.parse(e.timestamp);
    const m = e.message;
    if (e.type === "assistant" && m?.usage) {
      lastAssistant = t;
      // Streaming writes several entries per request with the same usage: count each request once.
      const key = e.requestId ?? m.id;
      if (!requests.has(key)) {
        requests.add(key);
        const u = m.usage;
        models.add(m.model);
        const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - w1h;
        tokens.input += u.input_tokens ?? 0;
        tokens.write5m += w5m;
        tokens.write1h += w1h;
        tokens.read += u.cache_read_input_tokens ?? 0;
        tokens.output += u.output_tokens ?? 0;
        tokens.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
        last = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        peak = Math.max(peak, last);
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "tool_use") pending.set(b.id, { name: b.name, t });
      }
    }
    if (e.type === "user" && Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        const s = tools.get(p.name) ?? { calls: 0, ms: 0, chars: 0, images: 0 };
        s.calls++;
        s.ms += t - p.t;
        const parts = Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }];
        for (const c of parts) {
          if (c.type === "image") (s.images++, images++);
          else s.chars += (c.text ?? "").length;
        }
        tools.set(p.name, s);
      }
    }
    // A typed user message after the model finished: the time in between is the human, not the task.
    // The CLI writes it as a string, the VS Code extension as a list of text blocks.
    const typed =
      typeof m?.content === "string" ||
      (Array.isArray(m?.content) && m.content.some((b) => b.type === "text") && !m.content.some((b) => b.type === "tool_result"));
    if (e.type === "user" && !e.isMeta && !e.isCompactSummary && typed && lastAssistant !== undefined) {
      userWait += t - lastAssistant;
    }
  }
  const times = list.map((e) => Date.parse(e.timestamp));
  const wall = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const toolMs = [...tools.values()].reduce((a, s) => a + s.ms, 0);
  const weighted =
    tokens.input * W.input + tokens.write5m * W.write5m + tokens.write1h * W.write1h + tokens.read * W.read + tokens.output * W.output;
  return { models, requests: requests.size, tokens, weighted, peak, last, wall, userWait, toolMs, tools, images };
}

const n = (x) => Math.round(x).toLocaleString("en-US").replace(/,/g, " ");
const sec = (ms) => `${(ms / 1000).toFixed(0)} s`;

function report(title, r) {
  console.log(`\n## ${title}`);
  console.log(`model: ${[...r.models].join(", ")}; requests: ${r.requests}`);
  console.log(`context: peak ${n(r.peak)}, last ${n(r.last)}`);
  const t = r.tokens;
  console.log(
    `tokens: input ${n(t.input)} · cache write 5m ${n(t.write5m)} · cache write 1h ${n(t.write1h)} · cache read ${n(t.read)} · output ${n(t.output)} (thinking ${n(t.thinking)})`,
  );
  console.log(`weighted (input-token equivalents): ${n(r.weighted)}`);
  const model = r.wall - r.userWait - r.toolMs;
  console.log(`time: ${sec(r.wall)} wall, ${sec(r.wall - r.userWait)} without waiting for the user = model ${sec(model)} + tools ${sec(r.toolMs)}`);
  console.log(`images in tool results: ${r.images}`);
  console.log("tool                                 calls   time    chars  images");
  for (const [name, s] of [...r.tools].sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`${name.padEnd(36)} ${String(s.calls).padStart(5)} ${sec(s.ms).padStart(6)} ${n(s.chars).padStart(8)} ${String(s.images).padStart(7)}`);
  }
}

const main = measure(entries(file));
report(`session ${basename(file)}`, main);

const subDir = join(dirname(file), basename(file, ".jsonl"), "subagents");
if (existsSync(subDir)) {
  const subs = readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
  if (subs.length) {
    const sub = measure(subs.flatMap((f) => entries(join(subDir, f))));
    report(`subagents (${subs.length})`, sub);
    console.log(`\n## total weighted: ${n(main.weighted + sub.weighted)}`);
  }
}
