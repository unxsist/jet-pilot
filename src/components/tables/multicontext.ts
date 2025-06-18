export const multiContextColumns = [
  {
    id: "context",
    meta: {
      showOnMultipleClusters: true,
    },
    accessorKey: "metadata.context",
    header: "Context",
  },
  {
    id: "namespace",
    meta: {
      showOnMultipleClusters: true,
      showOnMultipleNamespaces: true,
    },
    accessorKey: "metadata.namespace",
    header: "Namespace",
  },
];
