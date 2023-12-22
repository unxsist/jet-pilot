import { Kubernetes } from "@/services/Kubernetes";

export function SwitchContext(
  setContext: (context: string) => void,
  setNamespace: (namespace: string) => void
) {
  const contextCache = {
    contexts: [] as string[],
  };
  const namespaceCache = {} as { [key: string]: string[] };

  Kubernetes.getContexts().then((contexts) => {
    contextCache["contexts"] = contexts;

    contexts.map((context) => {
      Kubernetes.getNamespaces(context)
        .then((namespaces) => {
          namespaceCache[context] = namespaces.map(
            (namespace) => namespace.metadata?.name || ""
          );
        })
        .catch((err) => {
          namespaceCache[context] = [];
        });
    });
  });

  return {
    id: "switch-context",
    name: "Switch context",
    description: "Switch between contexts and namespaces",
    commands: async () => {
      return contextCache["contexts"].map((context) => {
        return {
          name: context,
          commands: async () => {
            if (namespaceCache[context].length === 0) {
              return [
                {
                  name: "No namespaces found",
                  execute: () => {},
                },
              ];
            }

            return namespaceCache[context].map((namespace) => {
              return {
                name: namespace,
                execute: () => {
                  setContext(context);
                  setNamespace(namespace);
                },
              };
            });
          },
        };
      });
    },
  };
}
