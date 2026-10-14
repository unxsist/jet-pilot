import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn } from "@/lib/operators/columns";
import { gatewayClassState } from "@/lib/operators/gatewayApi";

/* Gateway API GatewayClasses: accepted, and which controller implements it. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => gatewayClassState(row)),
  mutedColumn("Controller", (row) => row.spec?.controllerName),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
