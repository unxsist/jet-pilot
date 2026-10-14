import type { ColumnDef } from "@tanstack/vue-table";
import { ageColumn } from "./age";
import { mutedColumn, nameColumn, stateColumn } from "@/lib/operators/columns";
import { certificateRequestState } from "@/lib/operators/certManager";

/* cert-manager CertificateRequests: state, the certificate, the issuer. */
export const columns: ColumnDef<any>[] = [
  nameColumn,
  stateColumn((row) => certificateRequestState(row)),
  mutedColumn(
    "Certificate",
    (row) => row.metadata?.annotations?.["cert-manager.io/certificate-name"]
  ),
  mutedColumn("Issuer", (row) => row.spec?.issuerRef?.name),
  ageColumn<any>((row) => row.metadata?.creationTimestamp),
];
