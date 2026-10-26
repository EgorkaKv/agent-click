// Turns the current page state into what the agent receives: text + optional marked screenshot.
import { diffSnapshots } from "../render/diff.js";
import { formatSnapshot } from "../render/format.js";
import { drawMarks, resizeForBudget } from "../render/marks.js";
import type { Snapshot, SnapshotDiff, SnapshotOptions } from "../types.js";
import type { Session } from "./session.js";

export type ImageMode = "auto" | "always" | "never";

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
    this.last = snap;
    return { text: withEvents(text, this.session), image: want ? await this.image(snap) : undefined };
  }

  /** Marked screenshot of the current viewport for the given snapshot. */
  async image(snap: Snapshot): Promise<Buffer | undefined> {
    const shot = await this.session.screenshot();
    if (!shot) return undefined;
    const { image, factor } = await resizeForBudget(shot.data, 1280);
    this.shownImage = true;
    return drawMarks(image, snap.elements, { scale: shot.dpr * factor });
  }

  /** Decide whether a change deserves an automatic screenshot (D-6). */
  wantsImage(mode: ImageMode | boolean | undefined, diff: SnapshotDiff | undefined): boolean {
    if (mode === true || mode === "always") return true;
    if (mode === false || mode === "never") return false;
    return !this.shownImage || !!diff?.significant;
  }
}

export function withEvents(text: string, session: Session): string {
  const events = session.takeEvents();
  return events.length ? `${text}\n${events.map((e) => `! ${e}`).join("\n")}` : text;
}
