/*
 * Kubernetes-style versions as the upgrade checks compare them: only the
 * minor matters ("v1.31.4-eks-2d5f260" is 1.31). Pure.
 */

/** "v1.31.4-eks-2d5f260" → "1.31"; null when it isn't a version. */
export function minorOf(version: string | null | undefined): string | null {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

/** Negative when `a` is older than `b` ("1.9" < "1.10"). */
export function compareMinor(a: string, b: string): number {
  const [x0 = 0, x1 = 0] = a.split(".").map(Number);
  const [y0 = 0, y1 = 0] = b.split(".").map(Number);
  return x0 - y0 || x1 - y1;
}

/** "1.31" + 2 → "1.33". */
export function addMinors(minor: string, count: number): string {
  const [major = 1, rest = 0] = minor.split(".").map(Number);
  return `${major}.${rest + count}`;
}

/** Minors from `a` up to `b` ("1.31" → "1.33": 2); negative when `b` is older. */
export function minorsBetween(a: string, b: string): number {
  const [x0 = 0, x1 = 0] = a.split(".").map(Number);
  const [y0 = 0, y1 = 0] = b.split(".").map(Number);
  return x0 === y0 ? y1 - x1 : (y0 - x0) * 100;
}

/** "1.15.1" from an image tag or chart version ("v1.15.1", "1.15.1-alpine"); null without one. */
export function versionOf(text: string | null | undefined): string | null {
  const match = /v?(\d+\.\d+(?:\.\d+)?)/.exec(String(text ?? ""));
  return match ? match[1]! : null;
}
