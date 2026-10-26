import type { CDPSession } from "puppeteer-core";

export type MouseButton = "left" | "right" | "middle";

const BUTTON_NAMES: Record<MouseButton, { name: MouseButton; mask: number }> = {
  left: { name: "left", mask: 1 },
  right: { name: "right", mask: 2 },
  middle: { name: "middle", mask: 4 },
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type ModifierName = keyof typeof MODIFIER_BITS;

/** Physical modifier keys, pressed in this order and released in reverse. */
const MODIFIER_KEYS: Record<ModifierName, { key: string; code: string; vk: number }> = {
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
};

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  alt: "Alt",
  option: "Alt",
  ctrl: "Control",
  control: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  shift: "Shift",
};

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  /** Text inserted by the key (printable keys and Enter). */
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
}

const PUNCTUATION: Record<string, { code: string; vk: number }> = {
  ";": { code: "Semicolon", vk: 186 },
  "=": { code: "Equal", vk: 187 },
  ",": { code: "Comma", vk: 188 },
  "-": { code: "Minus", vk: 189 },
  ".": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 },
  "`": { code: "Backquote", vk: 192 },
  "[": { code: "BracketLeft", vk: 219 },
  "\\": { code: "Backslash", vk: 220 },
  "]": { code: "BracketRight", vk: 221 },
  "'": { code: "Quote", vk: 222 },
};

/** Resolves a single key name ("Enter", "a", "7", ".", "ж") to its definition. */
function resolveKey(name: string): KeyDef | null {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  if ([...name].length !== 1) return null;

  const lower = name.toLowerCase();
  if (/^[a-z]$/.test(lower)) {
    return { key: name, code: `Key${lower.toUpperCase()}`, vk: lower.toUpperCase().charCodeAt(0), text: name };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
  }
  const punct = PUNCTUATION[name];
  if (punct) return { key: name, code: punct.code, vk: punct.vk, text: name };
  // Any other single character (for example Cyrillic): typed as text, no physical code.
  return { key: name, code: "", vk: 0, text: name };
}

interface ParsedCombo {
  modifiers: ModifierName[];
  key: KeyDef;
}

/** Parses "Control+Shift+A", "Enter", "+" and similar. Throws on unknown keys. */
export function parseCombo(combo: string): ParsedCombo {
  // "+" alone and "Control++" name the plus key itself.
  let parts: string[];
  if (combo === "+") parts = ["+"];
  else if (combo.endsWith("++")) parts = [...combo.slice(0, -2).split("+").filter(Boolean), "+"];
  else parts = combo.split("+");

  const keyName = parts[parts.length - 1] ?? "";
  const modifiers: ModifierName[] = [];
  for (const raw of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[raw.toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier "${raw}" in key combo "${combo}"`);
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const key = resolveKey(keyName);
  if (!key || keyName === "") throw new Error(`Unknown key "${keyName}" in key combo "${combo}"`);
  return { modifiers, key };
}

function modifierMask(mods: Iterable<ModifierName>): number {
  let mask = 0;
  for (const m of mods) mask |= MODIFIER_BITS[m];
  return mask;
}

/** Trusted mouse click at a viewport point (CSS px). `clickCount: 2` sends a real double click. */
export async function click(
  cdp: CDPSession,
  point: { x: number; y: number },
  opts: { button?: MouseButton; clickCount?: 1 | 2 } = {},
): Promise<void> {
  const button = BUTTON_NAMES[opts.button ?? "left"];
  const clickCount = opts.clickCount ?? 1;
  const { x, y } = point;

  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  for (let count = 1; count <= clickCount; count++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: button.name,
      buttons: button.mask,
      clickCount: count,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: button.name,
      buttons: 0,
      clickCount: count,
    });
  }
}

export async function hover(cdp: CDPSession, point: { x: number; y: number }): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
}

/** Inserts text at the caret of the focused element (IME-style insertion, works for Cyrillic). */
export async function insertText(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

/**
 * Presses a key or key combo, e.g. "Enter", "Tab", "Control+A", "Shift+Tab", "Meta+Enter", "a".
 * Modifiers go down before the key and come up after it. Throws before sending anything if the
 * combo is not recognised.
 */
export async function press(cdp: CDPSession, combo: string): Promise<void> {
  const { modifiers, key } = parseCombo(combo);
  const shift = modifiers.includes("Shift");
  // Text is suppressed while Ctrl/Meta/Alt are held, as a real keyboard does for shortcuts.
  const hasShortcutModifier = modifiers.some((m) => m !== "Shift");
  const isLetter = /^[a-z]$/i.test(key.key);
  const keyName = shift && isLetter ? key.key.toUpperCase() : key.key;
  const text = hasShortcutModifier || key.text === undefined ? undefined : shift && isLetter ? keyName : key.text;

  // Each modifier is pressed with the bits of all modifiers down so far, and released with the rest.
  for (let i = 0; i < modifiers.length; i++) {
    await sendModifier(cdp, modifiers[i]!, "keyDown", modifierMask(modifiers.slice(0, i + 1)));
  }

  const keyBase = {
    key: keyName,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
    modifiers: modifierMask(modifiers),
  };
  if (text !== undefined) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...keyBase, text, unmodifiedText: text });
  } else {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyBase });
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...keyBase });

  for (let i = modifiers.length - 1; i >= 0; i--) {
    await sendModifier(cdp, modifiers[i]!, "keyUp", modifierMask(modifiers.slice(0, i)));
  }
}

async function sendModifier(cdp: CDPSession, mod: ModifierName, type: "keyDown" | "keyUp", modifiers: number): Promise<void> {
  const def = MODIFIER_KEYS[mod];
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk,
    modifiers,
  });
}

/** Makes the page behave as focused even when the browser window is in the background. */
export async function enableFocusEmulation(cdp: CDPSession): Promise<void> {
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
}
