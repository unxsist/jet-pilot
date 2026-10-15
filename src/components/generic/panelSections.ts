import type { InjectionKey } from "vue";

/**
 * Provided by a panel's Accordion: lets a section open itself (e.g. Edit
 * on a folded Labels section).
 */
export const PanelSectionsKey: InjectionKey<{ open: (value: string) => void }> = Symbol("PanelSections");
