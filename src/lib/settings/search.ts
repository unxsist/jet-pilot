/*
 * Settings search: every preference plus the bespoke sections (theme
 * library, kubeconfig files, tools...), fuzzy-matched on labels, keywords,
 * keys and descriptions. `@modified` narrows to changed preferences.
 */
import Fuse from "fuse.js";
import { CATEGORIES, type SettingCategory, type SettingSection } from "./categories";
import { SETTINGS } from "./registry";
import { isModified } from "./store";
import type { SettingDefinition } from "./types";

export type SearchHit =
  | { kind: "setting"; def: SettingDefinition; category: SettingCategory; section: SettingSection }
  | { kind: "section"; category: SettingCategory; section: SettingSection };

interface Entry {
  hit: SearchHit;
  label: string;
  keywords: string[];
  key: string;
  description: string;
  options: string[];
  context: string;
}

const entries = (): Entry[] => {
  const list: Entry[] = [];
  for (const category of CATEGORIES) {
    for (const section of category.sections) {
      if (section.component) {
        list.push({
          hit: { kind: "section", category, section },
          label: section.title,
          keywords: section.keywords ?? [],
          key: "",
          description: section.description ?? "",
          options: [],
          context: category.title,
        });
      }
    }
  }
  for (const def of SETTINGS) {
    const category = CATEGORIES.find((c) => c.id === def.category);
    const section = category?.sections.find((s) => s.id === def.section);
    if (!category || !section) continue;
    list.push({
      hit: { kind: "setting", def, category, section },
      label: def.label,
      keywords: def.keywords ?? [],
      key: def.key,
      description: def.description ?? "",
      options: def.type === "enum" ? def.options.map((option) => option.label) : [],
      context: `${category.title} ${section.title}`,
    });
  }
  return list;
};

let index: { fuse: Fuse<Entry>; list: Entry[] } | null = null;
const getIndex = () => {
  if (!index) {
    const list = entries();
    index = {
      list,
      fuse: new Fuse(list, {
        threshold: 0.2,
        ignoreLocation: true,
        keys: [
          { name: "label", weight: 3 },
          { name: "keywords", weight: 2 },
          { name: "key", weight: 2 },
          { name: "description", weight: 1 },
          { name: "options", weight: 1 },
          { name: "context", weight: 0.5 },
        ],
      }),
    };
  }
  return index;
};

export interface SearchQuery {
  text: string;
  modifiedOnly: boolean;
}

export function parseSearchQuery(query: string): SearchQuery {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const modifiedOnly = tokens.some((token) => token.toLowerCase() === "@modified");
  const text = tokens.filter((token) => token.toLowerCase() !== "@modified").join(" ");
  return { text, modifiedOnly };
}

/** Matches for `query`, best first (`settings` for `@modified`). */
export function searchSettings(query: string, settings?: unknown): SearchHit[] {
  const { text, modifiedOnly } = parseSearchQuery(query);
  const { fuse, list } = getIndex();
  let hits = text ? fuse.search(text).map((result) => result.item.hit) : list.map((entry) => entry.hit);
  if (modifiedOnly) {
    hits = hits.filter((hit) => hit.kind === "setting" && settings !== undefined && isModified(settings, hit.def));
  } else if (!text) {
    return [];
  }
  return hits;
}
