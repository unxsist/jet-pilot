import { describe, expect, test } from "vitest";
import { nextTick, watchEffect } from "vue";
import { focusedObjects, publishFocus, withdrawFocus } from "@/lib/customActions/focus";

/*
 * Regression test for the frozen list views: the publishing effect of a
 * table must not depend on the shared ref it writes. When it did, two
 * tables alive at once (a keep-alive route swap) invalidated each other
 * forever and the view never became interactive.
 */
describe("table focus", () => {
  test("two tables publishing alternately don't retrigger each other", async () => {
    const a = Symbol("a");
    const b = Symbol("b");
    let runsA = 0;
    let runsB = 0;
    const stopA = watchEffect(() => {
      runsA++;
      publishFocus(a, []);
    });
    const stopB = watchEffect(() => {
      runsB++;
      publishFocus(b, []);
    });
    await nextTick();
    await nextTick();
    stopA();
    stopB();
    expect(runsA).toBe(1);
    expect(runsB).toBe(1);
  });

  test("publishing the same objects again keeps the reference", async () => {
    const owner = Symbol("owner");
    const rows = [{ kind: "Pod", metadata: { name: "p" } }];
    publishFocus(owner, rows);
    const before = focusedObjects();
    publishFocus(owner, rows);
    expect(focusedObjects()).toBe(before);
  });

  test("only the owning table withdraws", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    publishFocus(a, [{ kind: "Pod", metadata: { name: "p" } }]);
    withdrawFocus(b);
    expect(focusedObjects().length).toBe(1);
    withdrawFocus(a);
    expect(focusedObjects().length).toBe(0);
  });
});
