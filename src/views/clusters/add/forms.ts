/* Form state of the add-cluster dialog. */
import type { ImportContext, ManualClusterSpec } from "@/lib/clusters/managed";

/** A context of a kubeconfig being imported. */
export interface ImportRow {
  context: ImportContext;
  include: boolean;
  name: string;
}

export interface ManualForm {
  name: string;
  server: string;
  ca: "system" | "pem" | "insecure";
  caPem: string;
  auth: "token" | "clientCert" | "none";
  token: string;
  certPem: string;
  keyPem: string;
  namespace: string;
}

export const emptyManualForm = (): ManualForm => ({
  name: "",
  server: "",
  ca: "system",
  caPem: "",
  auth: "token",
  token: "",
  certPem: "",
  keyPem: "",
  namespace: "",
});

export function toSpec(form: ManualForm): ManualClusterSpec {
  return {
    name: form.name.trim(),
    server: form.server.trim(),
    ca: form.ca === "pem" ? { kind: "pem", pem: form.caPem } : { kind: form.ca },
    auth:
      form.auth === "token"
        ? { kind: "token", token: form.token.trim() }
        : form.auth === "clientCert"
          ? { kind: "clientCert", certPem: form.certPem, keyPem: form.keyPem }
          : { kind: "none" },
    namespace: form.namespace.trim() || null,
  };
}
