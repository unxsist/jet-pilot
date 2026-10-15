import { describe, expect, it } from "vitest";
import {
  chooseLocalPort,
  containerPortOptions,
  defaultPortOption,
  isHttpPort,
  portCandidates,
  portLabel,
  preferredLocalPort,
  servicePortOptions,
} from "@/lib/portForwardPorts";
import {
  forwardUrl,
  parsePortMemory,
  rememberPort,
  targetKey,
} from "@/lib/portForwardLocal";

describe("named ports", () => {
  it("labels ports with their names", () => {
    expect(portLabel("http", 8080)).toBe("http · 8080");
    expect(portLabel(undefined, 6379)).toBe("6379");
  });

  it("lists TCP container ports (protocol defaults to TCP)", () => {
    const options = containerPortOptions([
      {
        name: "api",
        ports: [
          { name: "http", containerPort: 8080, protocol: "TCP" },
          { name: "metrics", containerPort: 9090 },
          { name: "dns", containerPort: 53, protocol: "UDP" },
        ],
      },
      { name: "envoy", ports: [{ name: "admin", containerPort: 9901 }] },
    ]);
    expect(options.map((o) => `${o.container}/${o.name}:${o.port}`)).toEqual([
      "api/http:8080",
      "api/metrics:9090",
      "envoy/admin:9901",
    ]);
  });

  it("keeps a service port's target", () => {
    const [http] = servicePortOptions([
      { name: "http", port: 80, targetPort: "web" as any },
    ]);
    expect(http).toMatchObject({
      value: "80",
      port: 80,
      name: "http",
      targetPort: "web",
    });
  });

  it("prefers http and web over side ports", () => {
    const pick = (...names: (string | undefined)[]) =>
      defaultPortOption(
        names.map((name, i) => ({ value: String(i), port: 9000 + i, name }))
      )?.name;
    expect(pick("metrics", "admin", "http")).toBe("http");
    expect(pick("metrics", "web")).toBe("web");
    expect(pick("grpc", "https")).toBe("https");
    expect(pick("metrics", "grpc")).toBe("grpc");
    expect(pick("health", "metrics")).toBe("health");
    expect(
      defaultPortOption([
        { value: "a", port: 6379 },
        { value: "b", port: 8080 },
      ])?.port
    ).toBe(8080);
    expect(defaultPortOption([])).toBeUndefined();
  });

  it("tells HTTP ports from the rest", () => {
    expect(isHttpPort("http", 8080)).toBe(true);
    expect(isHttpPort("metrics", 9090)).toBe(true);
    expect(isHttpPort("pg", 5432)).toBe(false);
    expect(isHttpPort("grpc", 8080)).toBe(false);
    expect(isHttpPort(undefined, 3000)).toBe(true);
    expect(isHttpPort(undefined, 6379)).toBe(false);
  });
});

describe("local ports", () => {
  it("shifts privileged ports and keeps the rest", () => {
    expect(preferredLocalPort(80)).toBe(8080);
    expect(preferredLocalPort(443)).toBe(8443);
    expect(preferredLocalPort(5432)).toBe(5432);
  });

  it("checks the remembered port first, then the ones after it", () => {
    expect(portCandidates(80).slice(0, 3)).toEqual([8080, 8081, 8082]);
    expect(portCandidates(80, 9000).slice(0, 2)).toEqual([9000, 9001]);
    expect(portCandidates(65535)).toEqual([65535]);
  });

  it("uses the remote port when free and says nothing", () => {
    expect(chooseLocalPort(5432, undefined, [5432, 5433])).toEqual({
      port: 5432,
      note: null,
      tone: "muted",
    });
  });

  it("explains a shifted privileged port", () => {
    expect(chooseLocalPort(80, undefined, [8080]).note).toBe(
      "Ports below 1024 need admin rights, using 8080"
    );
  });

  it("reuses the remembered port", () => {
    expect(chooseLocalPort(80, 9000, [9000, 8080])).toEqual({
      port: 9000,
      note: "Same port as last time",
      tone: "muted",
    });
  });

  it("never moves silently", () => {
    expect(chooseLocalPort(80, 9000, [9002])).toEqual({
      port: 9002,
      note: "9000 is in use, using 9002",
      tone: "warning",
    });
    expect(chooseLocalPort(3000, undefined, [3001]).note).toBe(
      "3000 is in use, using 3001"
    );
    expect(chooseLocalPort(3000, undefined, [])).toEqual({
      port: 3000,
      note: "3000 is in use",
      tone: "warning",
    });
  });
});

describe("port memory", () => {
  const target = {
    context: "prod",
    namespace: "payments",
    objectType: "service",
    objectName: "payments-api",
    objectPort: 80,
  };

  it("keys by context, namespace, object and remote port", () => {
    expect(targetKey(target)).toBe("prod|payments|service/payments-api|80");
    expect(targetKey({ ...target, objectPort: 9090 })).not.toBe(
      targetKey(target)
    );
  });

  it("remembers the latest port and forgets the oldest", () => {
    let memory = rememberPort({}, "a", 8080);
    memory = rememberPort(memory, "b", 3000);
    memory = rememberPort(memory, "a", 8081);
    expect(Object.entries(memory)).toEqual([
      ["b", 3000],
      ["a", 8081],
    ]);

    let big = {};
    for (let i = 0; i < 205; i++) big = rememberPort(big, `k${i}`, 1000 + i);
    expect(Object.keys(big)).toHaveLength(200);
    expect(big).not.toHaveProperty("k0");
    expect(big).toHaveProperty("k204", 1204);
  });

  it("builds the local URL", () => {
    const pf = { address: "localhost", localPort: 8080, objectPort: 80, portName: "http" };
    expect(forwardUrl(pf)).toBe("http://localhost:8080");
    expect(forwardUrl({ ...pf, address: "0.0.0.0" })).toBe("http://localhost:8080");
    expect(forwardUrl({ ...pf, address: "::1" })).toBe("http://[::1]:8080");
    expect(forwardUrl({ ...pf, objectPort: 443, portName: "https", localPort: 8443 })).toBe(
      "https://localhost:8443"
    );
  });

  it("drops invalid stored ports", () => {
    expect(parsePortMemory({ a: 8080, b: 0, c: "80", d: 70000 })).toEqual({
      a: 8080,
    });
    expect(parsePortMemory(null)).toEqual({});
    expect(parsePortMemory([1])).toEqual({});
  });
});
