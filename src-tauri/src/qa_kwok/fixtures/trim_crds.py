"""Minimal copies of the real GitOps CRDs for the kwok QA (qa_kwok/api.rs).

The storage version only, no descriptions, `status` and source details
(Helm, Kustomize, plugins) as free-form objects. `spec` and Argo CD's
`operation` keep their real schema, so pruning and validation of what JET
Pilot patches behave like on a real cluster.

    curl -sLo argo-application.yaml https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/crds/application-crd.yaml
    curl -sLo flux-kustomization.yaml https://raw.githubusercontent.com/fluxcd/kustomize-controller/main/config/crd/bases/kustomize.toolkit.fluxcd.io_kustomizations.yaml
    curl -sLo flux-gitrepository.yaml https://raw.githubusercontent.com/fluxcd/source-controller/main/config/crd/bases/source.toolkit.fluxcd.io_gitrepositories.yaml
    curl -sLo flux-helmrelease.yaml https://raw.githubusercontent.com/fluxcd/helm-controller/main/config/crd/bases/helm.toolkit.fluxcd.io_helmreleases.yaml
    python3 trim_crds.py <this directory>
"""
import sys
import yaml

FILES = {
    "argo-application.yaml": "argo-application.crd.yaml",
    "flux-kustomization.yaml": "flux-kustomization.crd.yaml",
    "flux-gitrepository.yaml": "flux-gitrepository.crd.yaml",
    "flux-helmrelease.yaml": "flux-helmrelease.crd.yaml",
}

# Source details are not what JET Pilot patches.
FREE_FORM = {"helm", "kustomize", "directory", "plugin", "postRenderers"}
ANY_OBJECT = {"type": "object", "x-kubernetes-preserve-unknown-fields": True}


def strip(node, free=False):
    if isinstance(node, dict):
        if free and node.get("type") == "object":
            return ANY_OBJECT
        return {
            k: strip(v) if k != "properties" else {name: strip(sub, name in FREE_FORM) for name, sub in v.items()}
            for k, v in node.items()
            if k != "description"
        }
    if isinstance(node, list):
        return [strip(v) for v in node]
    return node


out_dir = sys.argv[1]
for source, target in FILES.items():
    crd = yaml.safe_load(open(source))
    crd["metadata"] = {"name": crd["metadata"]["name"]}
    crd["spec"]["versions"] = [v for v in crd["spec"]["versions"] if v.get("storage")]
    for version in crd["spec"]["versions"]:
        version.pop("additionalPrinterColumns", None)
        schema = version["schema"]["openAPIV3Schema"]
        if "status" in schema.get("properties", {}):
            schema["properties"]["status"] = ANY_OBJECT
        version["schema"]["openAPIV3Schema"] = strip(schema)
    with open(f"{out_dir}/{target}", "w") as f:
        f.write(f"# Trimmed from the upstream CRD by trim_crds.py.\n")
        yaml.safe_dump(crd, f, sort_keys=False, width=1000)
