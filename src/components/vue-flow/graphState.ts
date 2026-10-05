import { shallowRef, type InjectionKey, type Ref, type ShallowRef } from "vue";

/* Highlight flags of one card / edge (bits). */
export const FLAG_LIT = 1;
export const FLAG_MATCH = 2;
export const FLAG_SELECTED = 4;
export const FLAG_HOVER = 8;
export const FLAG_ENTER = 16;
export const FLAG_LEAVE = 32;

/**
 * Per-id highlight flags. A card or edge reads only its own flag, and
 * `apply()` touches only the ids whose flags changed: selecting an object
 * in a graph of thousands re-renders the few cards that changed, the
 * dimming of everything else is one class on the canvas (CSS).
 */
export class HighlightFlags {
  private refs = new Map<string, ShallowRef<number>>();
  private current = new Map<string, number>();

  /** The (reactive) flags of an id. */
  of(id: string): Ref<number> {
    let flag = this.refs.get(id);
    if (!flag) {
      flag = shallowRef(this.current.get(id) ?? 0);
      this.refs.set(id, flag);
    }
    return flag;
  }

  /** Replaces all flags; ids missing from `next` are cleared. */
  apply(next: Map<string, number>) {
    for (const id of this.current.keys()) {
      if (!next.has(id)) this.set(id, 0);
    }
    for (const [id, value] of next) this.set(id, value);
    this.current = next;
  }

  get(id: string): number {
    return this.current.get(id) ?? 0;
  }

  clear() {
    this.apply(new Map());
    this.refs.clear();
  }

  private set(id: string, value: number) {
    const flag = this.refs.get(id);
    if (flag && flag.value !== value) flag.value = value;
  }
}

/**
 * View state shared by the graph's node / edge components (provided by the
 * resource graph view). Node components read it instead of receiving it in
 * their data, so highlighting never rebuilds the vue-flow node list.
 */
export interface GraphViewState {
  /** Highlight flags per card / edge id. */
  flags: HighlightFlags;
  /** Expanded workloads (their pods are shown as nodes). */
  expanded: Ref<Set<string>>;
  /** Workloads whose old ReplicaSets are shown. */
  history: Ref<Set<string>>;
  toggleExpanded: (id: string) => void;
  toggleHistory: (id: string) => void;
}

export const GraphViewStateKey: InjectionKey<GraphViewState> =
  Symbol("GraphViewState");
