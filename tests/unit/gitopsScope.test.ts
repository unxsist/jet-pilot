import { describe, expect, test } from "vitest";
import { CONTROLLER_NAMESPACES, candidateNamespaces, resolveScopes, type AskList } from "@/lib/gitops/scope";
import { DELIVERY_KINDS, SOURCE_KINDS } from "@/lib/gitops/kinds";

const { Application, Kustomization } = DELIVERY_KINDS;
const { GitRepository } = SOURCE_KINDS;

/* Answers from a table: "<kind>" for cluster-wide, "<kind>/<namespace>" per namespace. */
const asker = (allowed: string[], unanswerable: string[] = []): AskList & { asked: string[] } => {
  const asked: string[] = [];
  const ask = async (kind: { kind: string }, namespace?: string) => {
    const key = namespace ? `${kind.kind}/${namespace}` : kind.kind;
    asked.push(key);
    if (unanswerable.includes(key)) return null;
    return allowed.includes(key);
  };
  return Object.assign(ask, { asked });
};

describe("GitOps scopes", () => {
  test("candidates: the selection, the controllers' namespaces and the cluster's", () => {
    expect(candidateNamespaces(["all"], null)).toEqual(CONTROLLER_NAMESPACES);
    expect(candidateNamespaces(["team-a", "argocd"], ["default", "team-b"])).toEqual([
      "team-a",
      "argocd",
      "argo-cd",
      "flux-system",
      "default",
      "team-b",
    ]);
    const many = Array.from({ length: 60 }, (_, i) => `ns-${i}`).concat("platform-gitops", "flux-apps");
    expect(candidateNamespaces([], many)).toEqual([...CONTROLLER_NAMESPACES, "platform-gitops", "flux-apps"]);
  });

  test("cluster-wide access lists everything, without looking further", async () => {
    const ask = asker(["Application", "Kustomization"]);
    let looked = false;
    const scopes = await resolveScopes([Application, Kustomization], ask, async () => {
      looked = true;
      return [];
    });
    expect(Object.fromEntries(scopes)).toEqual({ Application: "all", Kustomization: "all" });
    expect(looked).toBe(false);
  });

  test("namespaced access lists the readable namespaces only", async () => {
    // An assumed role that may read Applications in argocd, nothing cluster-wide.
    const ask = asker(["Application/argocd", "GitRepository/flux-system", "GitRepository/team-a"]);
    const scopes = await resolveScopes([Application, Kustomization, GitRepository], ask, async () => [
      "team-a",
      ...CONTROLLER_NAMESPACES,
    ]);
    expect(Object.fromEntries(scopes)).toEqual({
      Application: ["argocd"],
      Kustomization: [],
      GitRepository: ["team-a", "flux-system"],
    });
  });

  test("questions the API can't answer leave the listing to tell", async () => {
    const ask = asker([], ["Application", "Kustomization/team-a"]);
    const scopes = await resolveScopes([Application, Kustomization], ask, async () => ["team-a", "argocd"]);
    expect(Object.fromEntries(scopes)).toEqual({ Application: "all", Kustomization: ["team-a"] });
  });
});
