import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { statusTextClass } from "@/components/ui/status";
import { formatDateTime } from "@/lib/utils";
import { mutedColumn, nameColumn, stateColumn } from "@/lib/operators/columns";
import { listInWords } from "@/lib/operators/format";
import {
  certificateExpiry,
  certificateNames,
  certificateState,
  renewalInWords,
} from "@/lib/operators/certManager";

/* cert-manager Certificates: state, expiry in words, issuer, domains. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => certificateState(row)),
  {
    id: "Expires",
    header: "Expires",
    accessorFn: (row) => certificateExpiry(row)?.at ?? 0,
    cell: ({ row }) => certificateExpiry(row.original)?.short ?? "",
    enableGlobalFilter: false,
    meta: {
      class: (row) => {
        const expiry = certificateExpiry(row);
        return `tabular-nums ${expiry ? statusTextClass[expiry.tone] : ""}`;
      },
      title: (row) => {
        const expiry = certificateExpiry(row);
        if (!expiry) return undefined;
        return [formatDateTime(new Date(expiry.at)), renewalInWords(row)]
          .filter(Boolean)
          .join(" · ");
      },
    },
  },
  mutedColumn("Issuer", (row) => row.spec?.issuerRef?.name),
  mutedColumn("Domains", (row) => listInWords(certificateNames(row), 1)),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
