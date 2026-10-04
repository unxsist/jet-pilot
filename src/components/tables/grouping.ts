/*
 * Group-by for resource tables: rows grouped by namespace / context / node /
 * owner under collapsible headers with counts. Works on the already sorted
 * and filtered rows; rows keep their order inside a group.
 */

export interface GroupOption {
  id: string;
  label: string;
  get: (row: any) => string | null | undefined;
}

export const GROUP_OPTIONS: GroupOption[] = [
  {
    id: "namespace",
    label: "Namespace",
    get: (row) => row?.metadata?.namespace ?? row?.namespace,
  },
  {
    id: "context",
    label: "Context",
    get: (row) => row?.metadata?.context,
  },
  {
    id: "node",
    label: "Node",
    get: (row) => row?.spec?.nodeName,
  },
  {
    id: "owner",
    label: "Owner",
    get: (row) => {
      const owner =
        row?.metadata?.ownerReferences?.find?.(
          (ref: { controller?: boolean }) => ref?.controller
        ) ?? row?.metadata?.ownerReferences?.[0];
      return owner ? `${owner.kind}/${owner.name}` : null;
    },
  },
];

export const groupOption = (id: string | null | undefined) =>
  GROUP_OPTIONS.find((option) => option.id === id) ?? null;

/**
 * Group options that make sense for the data: at least one of the sampled
 * rows has a value (nodes have no namespace, only pods have a node, ...).
 */
export function availableGroupOptions(
  rows: readonly unknown[],
  sample = 200
): GroupOption[] {
  const sampled = rows.slice(0, sample);
  return GROUP_OPTIONS.filter((option) =>
    sampled.some((row) => {
      const value = option.get(row);
      return value !== null && value !== undefined && value !== "";
    })
  );
}

export type DisplayItem<R> =
  | { type: "row"; id: string; row: R }
  | {
      type: "group";
      id: string;
      key: string;
      label: string;
      count: number;
      collapsed: boolean;
    };

export const NO_GROUP_LABEL = "(none)";

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Flat list for the virtualiser: without grouping one item per row, with
 * grouping a header per group (sorted by name, "(none)" last) followed by
 * its rows unless collapsed.
 */
export function buildDisplayItems<R extends { id: string; original: unknown }>(
  rows: readonly R[],
  group: GroupOption | null,
  collapsed: ReadonlySet<string>
): DisplayItem<R>[] {
  if (!group) {
    return rows.map((row) => ({ type: "row", id: row.id, row }));
  }

  const groups = new Map<string, R[]>();
  for (const row of rows) {
    const key = group.get(row.original) || "";
    let members = groups.get(key);
    if (!members) {
      members = [];
      groups.set(key, members);
    }
    members.push(row);
  }

  const keys = [...groups.keys()].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : collator.compare(a, b)
  );

  const items: DisplayItem<R>[] = [];
  for (const key of keys) {
    const members = groups.get(key)!;
    const isCollapsed = collapsed.has(key);
    items.push({
      type: "group",
      id: `group:${key}`,
      key,
      label: key || NO_GROUP_LABEL,
      count: members.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (const row of members) {
        items.push({ type: "row", id: row.id, row });
      }
    }
  }
  return items;
}
