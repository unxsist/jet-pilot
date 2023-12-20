import { Command } from "@/command-palette";

export function SwitchContext(
  setContext: (context: string) => void,
  setNamespace: (namespace: string) => void
) {
  return {
    id: "switch-context",
    name: "Switch context",
    description: "Switch between contexts and namespaces",
    commands: async () => {
      return [
        {
          name: "sre-eks-production-1 - all",
          execute: () => {
            setContext("sre-eks-production-1");
            setNamespace("all");
          },
        },
        {
          name: "sre-eks-production-1 - backoffice-platform",
          execute: () => {
            setContext("sre-eks-production-1");
            setNamespace("backoffice-platform");
          },
        },
        {
          name: "sre-eks-staging-1 - tms",
          execute: () => {
            setContext("sre-eks-staging-1");
            setNamespace("tms");
          },
        },
      ];
    },
  } as Command;
}
