/*
 * Example actions in Settings › Actions › Examples: added to the actions
 * folder with one click (never installed by default), then theirs to edit.
 * Each shows one part of the format.
 */
export interface ActionExample {
  /** File name in the actions folder. */
  file: string;
  text: string;
}

export const ACTION_EXAMPLES: readonly ActionExample[] = [
  {
    file: "open-in-grafana.yaml",
    text: `name: Open in Grafana
description: The pod's dashboard, filtered by namespace and app
icon: chart-line
scope:
  kinds: [Pod]
run:
  # Values are URL-encoded. Point this at your own Grafana.
  open: https://grafana.example.com/d/k8s-pod?var-namespace={{namespace}}&var-pod={{name}}&var-app={{labels.app | default "all"}}
`,
  },
  {
    file: "tail-with-stern.yaml",
    text: `name: Tail logs with stern
description: Every pod of the workload, in a terminal tab
icon: scroll-text
scope:
  kinds: [Deployment, StatefulSet, DaemonSet]
run:
  # Needs stern (https://github.com/stern/stern) on your PATH.
  command: stern {{kind | lower}}/{{name}} --context {{context}} --namespace {{namespace}} --tail 50
`,
  },
  {
    file: "copy-image.yaml",
    text: `name: Copy image
description: The container's image reference
icon: copy
scope:
  kinds: [Pod, Deployment, StatefulSet, DaemonSet]
run:
  # {{image}} asks for the container when there are several.
  copy: "{{image}}"
`,
  },
  {
    file: "port-forward-and-open.yaml",
    text: `name: Port-forward and open
description: Forwards a local port to the service and opens it in your browser
icon: cable
scope:
  kinds: [Service]
inputs:
  - name: port
    label: Service port
    default: "80"
  - name: local
    label: Local port
    default: "8080"
run:
  # macOS and Linux. Close the terminal tab to stop forwarding.
  command: >-
    (sleep 2; open http://localhost:{{input.local}} 2>/dev/null || xdg-open http://localhost:{{input.local}}) &
    kubectl port-forward service/{{name}} {{input.local}}:{{input.port}} --context {{context}} --namespace {{namespace}}
`,
  },
  {
    file: "restart-deployment.yaml",
    text: `name: Restart deployment
description: Replaces its pods one by one (kubectl rollout restart)
icon: rotate-ccw
scope:
  kinds: [Deployment]
  multiple: true
run:
  kubectl: rollout restart deployment/{{name}}
  in: background
confirm: Restart {{name}}? Its pods are replaced one by one.
mutates: true
`,
  },
  {
    file: "describe-in-terminal.yaml",
    text: `name: Describe in terminal
description: kubectl describe, in a terminal tab
icon: terminal
scope:
  kinds: "*"
run:
  kubectl: describe {{kind}} {{name}}
`,
  },
  {
    file: "psql.yaml",
    text: `name: Open psql
description: A psql session in the database container
icon: database
scope:
  kinds: [Pod, StatefulSet]
  labels: app.kubernetes.io/name in (postgresql, postgres)
inputs:
  - name: user
    label: User
    default: postgres
run:
  exec: psql -U {{input.user}}
`,
  },
  {
    file: "open-argo-cd-app.yaml",
    text: `name: Open the Argo CD app
description: The application that deploys this object
icon: git-branch
scope:
  labels: app.kubernetes.io/instance
run:
  # Point this at your own Argo CD.
  open: https://argocd.example.com/applications/argocd/{{labels['app.kubernetes.io/instance']}}
`,
  },
];
