// Turns the current page state into what the agent receives: text + optional marked screenshot.
import { diffSnapshots } from "../render/diff.js";
import { formatSnapshot } from "../render/format.js";
import { drawMarks, resizeForBudget } from "../render/marks.js";
import type { Snapshot, SnapshotDiff, SnapshotOptions } from "../types.js";
import type { Session } from "./session.js";
import { phase } from "./trace.js";

export type ImageMode = "auto" | "always" | "never";

/**
 * Screenshot width sent to the agent (D-14). The image is for layout; text and values come in the
 * element list. 960 keeps Ads Manager labels and table headers readable at ~0.55 of the 1280 cost.
 */
const IMAGE_WIDTH = 960;

export interface ToolOutput {
  text: string;
  image?: Buffer;
}

export class View {
  /** Last snapshot shown to the agent, per tab url-independent (reset on tab switch). */
  last?: Snapshot;
  private shownImage = false;

  constructor(private session: Session) {}

  reset(): void {
    this.last = undefined;
    this.shownImage = false;
  }

  async snapshot(opts?: SnapshotOptions): Promise<Snapshot> {
    return this.session.call("snapshot", opts ?? {});
  }

  /** Full look: settle state, element list, image by mode. Updates `last`. */
  async look(opts: SnapshotOptions & { image?: ImageMode; settled?: boolean; pendingRequests?: number } = {}): Promise<ToolOutput> {
    const { image = "auto", settled, pendingRequests, ...snapOpts } = opts;
    const snap = await this.snapshot(snapOpts);
    let pending = pendingRequests;
    if (pending === undefined) pending = (await this.session.current()).network.inflight();
    let text = formatSnapshot(snap, { pendingRequests: pending });
    if (settled === false && !text.includes("⏳")) text = text.replace("✓ settled", "⏳ not settled (timeout)");
    const diff = this.last ? diffSnapshots(this.last, snap) : undefined;
    const want = image === "always" || (image === "auto" && (!this.shownImage || !!diff?.significant));
    // A scoped or full look is not what the next act compares with: it would report everything
    // outside the scope as added, or everything off-screen as removed.
    if (snapOpts.scope === undefined && !snapOpts.full) this.last = snap;
    const shot = want ? await this.image(snap) : undefined;
    if (want && !shot) text += `\n${NO_SCREENSHOT}`;
    return { text: withEvents(text, this.session), image: shot };
  }

  /** Marked screenshot of the current viewport for the given snapshot. */
  async image(snap: Snapshot): Promise<Buffer | undefined> {
    const shot = await this.session.screenshot();
    if (!shot) return undefined;
    this.shownImage = true;
    // Boxes as of the frame, not of the snapshot: accordions and lists move while the frame is captured.
    const ids = new Set(snap.elements.map((e) => e.id));
    const fresh = await this.snapshot().catch(() => snap);
    const elements = fresh.elements.filter((e) => ids.has(e.id));
    return phase("marks", async () => {
      const { image, factor } = await resizeForBudget(shot.data, IMAGE_WIDTH);
      return drawMarks(image, elements, { scale: shot.dpr * factor });
    });
  }

  /** Decide whether a change deserves an automatic screenshot (D-6). */
  wantsImage(mode: ImageMode | boolean | undefined, diff: SnapshotDiff | undefined): boolean {
    if (mode === true || mode === "always") return true;
    if (mode === false || mode === "never") return false;
    return !this.shownImage || !!diff?.significant;
  }
}

export const NO_SCREENSHOT = "(no screenshot: the browser did not render a frame in time — is the window minimized?)";

export function withEvents(text: string, session: Session): string {
  const events = session.takeEvents();
  return events.length ? `${text}\n${events.map((e) => `! ${e}`).join("\n")}` : text;
}
