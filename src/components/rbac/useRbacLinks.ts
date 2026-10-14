import { useRouter } from "vue-router";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { formatResourceKind, injectStrict } from "@/lib/utils";
import { subjectKey, type RbacSubject } from "@/lib/rbac";

const ResourcePanel = defineAsyncComponent(() => import("@/views/panels/Resource.vue"));

/**
 * Where RBAC names lead: objects open in the side panel, subjects in the
 * access review's Subjects tab (on the context they were found in).
 */
export function useRbacLinks() {
  const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);
  const router = useRouter();

  const openObject = (object: { kind?: string; metadata?: { name?: string } }) =>
    setSidePanelComponent({
      title: `${object.kind}: ${object.metadata?.name}`,
      icon: formatResourceKind(object.kind ?? "").toLowerCase(),
      component: ResourcePanel,
      props: { resource: object },
    });

  const openSubject = (subject: RbacSubject, context?: string) =>
    router.push({
      name: "AccessReview",
      query: { tab: "subjects", subject: subjectKey(subject), ...(context ? { context } : {}) },
    });

  return { openObject, openSubject };
}
