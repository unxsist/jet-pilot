import type { InjectionKey, Ref } from "vue";

/**
 * View state shared by the graph's node / edge components (provided by the
 * resource graph view). Node components read it instead of receiving it in
 * their data, so highlighting never rebuilds the vue-flow node list.
 */
export interface GraphViewState {
  /** Selected node id. */
  selected: Ref<string | null>;
  /** Hovered node id. */
  hovered: Ref<string | null>;
  /** Neighbourhood of the selection: everything else is dimmed. */
  lit: Ref<{ nodes: Set<string>; edges: Set<string> } | null>;
  /** Problems mode: healthy nodes are dimmed. */
  problems: Ref<boolean>;
  /** Search matches: other nodes are dimmed (null = no search). */
  matches: Ref<Set<string> | null>;
  /** Expanded workloads (their pods are shown as nodes). */
  expanded: Ref<Set<string>>;
  /** Workloads whose old ReplicaSets are shown. */
  history: Ref<Set<string>>;
  /** Nodes added by the last refresh (fade in). */
  entering: Ref<Set<string>>;
  /** Zoomed far out: cards show less detail. */
  far: Ref<boolean>;
  /** Zoomed out to an overview: cards are health blocks, groups titles. */
  overview: Ref<boolean>;
  toggleExpanded: (id: string) => void;
  toggleHistory: (id: string) => void;
}

export const GraphViewStateKey: InjectionKey<GraphViewState> =
  Symbol("GraphViewState");
