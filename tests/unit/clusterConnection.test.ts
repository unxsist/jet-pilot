import { describe, expect, it } from "vitest";
import { connectionEntries, connectionLine, connectionProblem, proxyHost, type TunnelState } from "@/lib/clusters/connection";
import { resolveCluster, updateRecords, type ClusterRecord } from "@/lib/clusters/meta";

describe("connection settings", () => {
  it("are stored with the cluster's other metadata and cleared with Direct", () => {
    let records: ClusterRecord[] = [];
    records = updateRecords(records, "prod", "/k/config", {
      connection: { mode: "ssh", host: "ops@bastion.example.com", port: 2222 },
    });
    expect(resolveCluster(records, "prod", "/k/config").connection).toEqual({
      mode: "ssh",
      host: "ops@bastion.example.com",
      port: 2222,
    });
    expect(connectionEntries(records)).toEqual([
      { kubeConfig: "/k/config", context: "prod", connection: { mode: "ssh", host: "ops@bastion.example.com", port: 2222 } },
    ]);
    records = updateRecords(records, "prod", "/k/config", { connection: undefined });
    expect(records).toEqual([]);
    expect(connectionEntries([{ kubeConfig: "", context: "dev", alias: "Dev" }])).toEqual([]);
  });

  it("explain what's wrong in a sentence", () => {
    expect(connectionProblem(undefined)).toBeNull();
    expect(connectionProblem({ mode: "proxy", url: "socks5://proxy.corp:1080" })).toBeNull();
    expect(connectionProblem({ mode: "proxy", url: "http://user:pw@proxy.corp:3128" })).toBeNull();
    expect(connectionProblem({ mode: "proxy", url: "" })).toBe(
      "Enter the proxy's URL, for example socks5://proxy.example.com:1080."
    );
    expect(connectionProblem({ mode: "proxy", url: "proxy.corp:3128" })).toBe(
      "Start with the kind of proxy: socks5://proxy.corp:3128 or http://proxy.corp:3128."
    );
    expect(connectionProblem({ mode: "proxy", url: "http://not a url" })).toBe(
      '"http://not a url" isn\'t a URL. Start it with socks5://, http:// or https://.'
    );
    expect(connectionProblem({ mode: "proxy", url: "socks4://p:1080" })).toBe("Use a socks5://, http:// or https:// proxy.");

    expect(connectionProblem({ mode: "ssh", host: "ops@bastion", port: 22, identityFile: "~/.ssh/b", jump: "edge" })).toBeNull();
    expect(connectionProblem({ mode: "ssh", host: " " })).toBe("Enter the jump host, for example user@bastion.example.com.");
    expect(connectionProblem({ mode: "ssh", host: "-oProxyCommand=x" })).toBe('"-oProxyCommand=x" isn\'t a host name.');
    expect(connectionProblem({ mode: "ssh", host: "a b" })).toBe('"a b" isn\'t a host name.');
    expect(connectionProblem({ mode: "ssh", host: "b", port: 70000 })).toBe("The SSH port is a number from 1 to 65535.");
    expect(connectionProblem({ mode: "ssh", host: "b", port: Number("x") })).toBe("The SSH port is a number from 1 to 65535.");
    expect(connectionProblem({ mode: "ssh", host: "b", jump: "-J" })).toBe('"-J" isn\'t a jump host.');
    expect(connectionProblem({ mode: "ssh", host: "b", identityFile: "-F/etc" })).toBe('"-F/etc" isn\'t a file.');
  });

  it("show proxies without credentials", () => {
    expect(proxyHost("http://user:secret@proxy.corp:3128")).toBe("proxy.corp:3128");
    expect(proxyHost("socks5://10.0.0.5")).toBe("10.0.0.5");
  });
});

describe("the hub's connection line", () => {
  const ssh = { mode: "ssh" as const, host: "ops@bastion.example.com" };

  it("stays away for direct clusters, unless the kubeconfig sets a proxy", () => {
    expect(connectionLine({ mode: "direct" })).toBeNull();
    expect(connectionLine(null)).toBeNull();
    expect(connectionLine({ mode: "direct", kubeconfigProxy: "proxy.corp:3128" })).toEqual({
      title: "proxy.corp:3128",
      detail: "Proxy set in the kubeconfig",
      tone: "muted",
      retry: false,
    });
  });

  it("follows the tunnel", () => {
    const line = (tunnel: TunnelState | null) => connectionLine({ mode: "ssh", via: "bastion.example.com", tunnel }, ssh);
    expect(line(null)).toMatchObject({
      title: "bastion.example.com",
      detail: "SSH jump host · opens when you use the cluster",
      tone: "muted",
    });
    expect(line({ state: "connecting" })).toMatchObject({ detail: "SSH jump host · connecting…", tone: "warning" });
    expect(line({ state: "connected", since: 1 })).toEqual({
      title: "bastion.example.com",
      detail: "SSH jump host · connected",
      tone: "success",
      retry: false,
    });
    expect(line({ state: "retrying", error: "bastion.example.com didn't answer", attempt: 2 })).toMatchObject({
      detail: "Reconnecting: bastion.example.com didn't answer",
      retry: false,
    });
    expect(line({ state: "failed", error: "SSH asked for a password; add your key to ssh-agent" })).toEqual({
      title: "bastion.example.com",
      detail: "SSH asked for a password; add your key to ssh-agent",
      tone: "destructive",
      retry: true,
    });
  });

  it("names the proxy before the backend answers", () => {
    expect(connectionLine(null, ssh)).toMatchObject({ title: "bastion.example.com" });
    expect(connectionLine(null, { mode: "proxy", url: "socks5://u:p@proxy.corp:1080" })).toEqual({
      title: "proxy.corp:1080",
      detail: "SOCKS5 proxy",
      tone: "muted",
      retry: false,
    });
  });
});
