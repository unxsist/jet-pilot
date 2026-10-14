import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import {
  countColumn,
  monoColumn,
  nameColumn,
  stateColumn,
  textColumn,
} from "@/lib/operators/columns";
import {
  attachedRoutes,
  gatewayAddresses,
  gatewayState,
  listenersInWords,
} from "@/lib/operators/gatewayApi";

/* Gateway API Gateways: state, listeners, address, attached routes. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => gatewayState(row)),
  textColumn("Listeners", (row) => listenersInWords(row)),
  monoColumn("Address", (row) => gatewayAddresses(row)[0]),
  countColumn("Routes", (row) => (row.status?.listeners ? attachedRoutes(row) : undefined)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
