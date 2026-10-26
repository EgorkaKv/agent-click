// Stable element ids. Ids are never reused. An element keeps its id while it lives;
// when a node is re-created with the same fingerprint (React re-render, wizard step),
// the new node takes over the id of the dead one.

export interface Entry {
  ref: WeakRef<Element>;
  fp: string;
  /** Name the id was bound to, for roles where a name change means another object. */
  name?: string;
}

/**
 * Roles whose name identifies the object: a link, an option, a tab or a table cell that gets
 * another name now shows another object (React reuses the node for another row). Their old id
 * dies with the name. Fields and toggling buttons keep their id across name changes.
 */
export const OBJECT_ROLES = new Set([
  "link",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "row",
  "cell",
  "gridcell",
  "rowheader",
  "columnheader",
]);

/** The parts of a candidate that identify it for the registry. */
export interface Identity {
  el: Element;
  fp: string;
  role: string;
  name: string;
}

export class Registry {
  private next = 1;
  private readonly byEl = new WeakMap<Element, number>();
  private readonly byId = new Map<number, Entry>();

  entry(id: number): Entry | undefined {
    return this.byId.get(id);
  }

  isAliveId(id: number): boolean {
    const el = this.byId.get(id)?.ref.deref();
    return !!el && el.isConnected;
  }

  /** The id bound to el, if el is still the element that id points at. */
  boundId(el: Element): number | undefined {
    const id = this.byEl.get(el);
    if (id === undefined) return undefined;
    return this.byId.get(id)?.ref.deref() === el ? id : undefined;
  }

  isKnownAlive(el: Element): boolean {
    return this.boundId(el) !== undefined && el.isConnected;
  }

  /**
   * Id for a candidate: its own, a dead entry's with the same fingerprint, or a new one.
   * For an object role (OBJECT_ROLES) a changed name retires the own id: the number now
   * names another object, so the element gets a new one.
   */
  assign(c: Identity, dead: DeadPool): number {
    const { el, fp } = c;
    const obj = OBJECT_ROLES.has(c.role);
    const known = this.boundId(el);
    if (known !== undefined) {
      const entry = this.byId.get(known)!;
      if (!obj || entry.name === undefined || entry.name === c.name) {
        if (fp) entry.fp = fp;
        if (obj) entry.name = c.name;
        return known;
      }
      this.byId.delete(known);
    }
    const reused = dead.take(fp);
    if (reused !== undefined) {
      this.bind(reused, el, fp, obj ? c.name : undefined);
      return reused;
    }
    const id = this.next++;
    this.bind(id, el, fp, obj ? c.name : undefined);
    return id;
  }

  rebind(id: number, el: Element, fp: string): void {
    this.bind(id, el, fp);
  }

  private bind(id: number, el: Element, fp: string, name?: string): void {
    this.byEl.set(el, id);
    this.byId.set(id, { ref: new WeakRef(el), fp, name });
  }

  /** Dead entries grouped by fingerprint, oldest first. */
  deadPool(): DeadPool {
    const map = new Map<string, number[]>();
    for (const [id, e] of this.byId) {
      const el = e.ref.deref();
      if (el && el.isConnected) continue;
      const list = map.get(e.fp);
      if (list) list.push(id);
      else map.set(e.fp, [id]);
    }
    return new DeadPool(this, map);
  }
}

export class DeadPool {
  constructor(
    private readonly registry: Registry,
    private readonly map: Map<string, number[]>,
  ) {}

  /** Takes a dead id with this fingerprint that is still unused, or undefined. */
  take(fp: string): number | undefined {
    const list = this.map.get(fp);
    while (list && list.length > 0) {
      const id = list.shift()!;
      if (!this.registry.isAliveId(id)) return id;
    }
    return undefined;
  }
}

export const registry = new Registry();
