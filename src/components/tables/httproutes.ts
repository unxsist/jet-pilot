import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn, textColumn } from "@/lib/operators/columns";
import { listInWords } from "@/lib/operators/format";
import { routeBackendNames, routeParents, routeState } from "@/lib/operators/gatewayApi";

/* Gateway API routes (HTTPRoute, GRPCRoute): state, hostnames, gateways, backends. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => routeState(row)),
  textColumn("Hostnames", (row) => listInWords(row.spec?.hostnames ?? [], 1)),
  mutedColumn("Gateway", (row) => listInWords([...new Set(routeParents(row).map((p) => p.name))], 1)),
  mutedColumn("Backends", (row) => listInWords(routeBackendNames(row), 2)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
