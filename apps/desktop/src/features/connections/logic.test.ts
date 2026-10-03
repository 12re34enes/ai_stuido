import { describe, expect, it } from "vitest";

import {
  connectionInvalidations,
  connectionsRouteKey,
  deployFormDefaults,
  deployPayload,
  deploySummary,
  groupByEnvironment,
  parseKeyValues,
  parsePort,
  parseStatusCodes,
  policyExpectation,
  tokenPageUrl,
  validateDb,
  validateDeploy,
  validateGitAccount,
  validateHost,
  type DbFormValues,
  type HostFormValues,
} from "./logic";

const host: HostFormValues = {
  name: "web-1",
  hostname: "10.0.0.12",
  port: "22",
  username: "deploy",
  auth: "key",
  keyPath: "~/.ssh/id_ed25519",
  jumpHostId: "",
  environment: "test",
  permission: "read",
  patterns: "",
};

describe("host validation", () => {
  it("accepts a valid host", () => {
    expect(validateHost(host)).toEqual({});
  });

  it("reports Turkish errors per field", () => {
    const e = validateHost({ ...host, name: " ", hostname: "web 1", port: "70000", username: "kötü kullanıcı", keyPath: "" });
    expect(e.name).toBe("Bir ad girin.");
    expect(e.hostname).toMatch(/Adres/);
    expect(e.port).toBe("Port 1 ile 65535 arasında olmalı.");
    expect(e.username).toMatch(/geçersiz/);
    expect(e.keyPath).toMatch(/Anahtar/);
  });

  it("requires a password only for password auth without a stored one", () => {
    expect(validateHost({ ...host, auth: "password" }, { passwordProvided: false }).password).toBe("Parola gerekli.");
    expect(validateHost({ ...host, auth: "password" }, { passwordProvided: true }).password).toBeUndefined();
    expect(validateHost({ ...host, auth: "agent", keyPath: "" })).toEqual({});
  });
});

describe("database validation", () => {
  const db: DbFormValues = { name: "orders", kind: "postgres", host: "db.internal", port: "", database: "orders", username: "", viaHostId: "", environment: "production", permission: "read", patterns: "" };
  it("needs a host for server databases and a path for SQLite", () => {
    expect(validateDb(db)).toEqual({});
    expect(validateDb({ ...db, host: "" }).host).toBe("Sunucu adresi gerekli.");
    expect(validateDb({ ...db, kind: "sqlite", host: "", database: "" }).database).toMatch(/SQLite/);
    expect(validateDb({ ...db, kind: "redis", database: "abc" }).database).toMatch(/sayı/);
  });
});

describe("policy preview (mirrors remote/policy.py for users)", () => {
  it("lets reads through, in a read-only transaction on production or at read level", () => {
    expect(policyExpectation("production", "full", "read")).toMatchObject({ action: "allow", key: "allowReadTx" });
    expect(policyExpectation("test", "read", "read")).toMatchObject({ action: "allow", key: "allowReadTx" });
    expect(policyExpectation("test", "full", "read")).toMatchObject({ action: "allow", key: "allowRead" });
  });

  it("always asks for approval for production writes, whatever the level", () => {
    for (const level of ["read", "limited", "full"] as const) {
      expect(policyExpectation("production", level, "write")).toMatchObject({ action: "approve", key: "approveProduction", tone: "danger" });
      expect(policyExpectation("production", level, "unknown").action).toBe("approve");
    }
  });

  it("treats unknown as write elsewhere: read → approval, limited → patterns, full → allowed", () => {
    expect(policyExpectation("test", "read", "unknown").key).toBe("approveRead");
    expect(policyExpectation("local", "limited", "write").action).toBe("maybe");
    expect(policyExpectation("local", "full", "write")).toMatchObject({ action: "allow", key: "allowWrite" });
  });
});

describe("parsing helpers", () => {
  it("parses KEY=value lines with line-numbered errors", () => {
    expect(parseKeyValues("A=1\n# yorum\n\nB = iki")).toEqual({ values: { A: "1", B: "iki" }, error: null });
    expect(parseKeyValues("A=1\nbozuk").error).toBe("2. satır ANAHTAR=değer biçiminde olmalı.");
  });

  it("parses status codes and ports", () => {
    expect(parseStatusCodes("200, 204")).toEqual({ codes: [200, 204], error: null });
    expect(parseStatusCodes("")).toEqual({ codes: null, error: null });
    expect(parseStatusCodes("2xx").error).toMatch(/Geçersiz/);
    expect(parsePort("")).toEqual({ port: null, error: null });
    expect(parsePort("0").error).toBeTruthy();
  });
});

describe("deploy profiles", () => {
  const base = deployFormDefaults();

  it("validates per kind", () => {
    expect(validateDeploy({ ...base, name: "x", kind: "ci" }).repoId).toBeTruthy();
    const ssh = validateDeploy({ ...base, name: "x", kind: "ssh", strategy: "rolling", batchSize: "0" });
    expect(ssh.hostIds).toBeTruthy();
    expect(ssh.script).toBeTruthy();
    expect(ssh.batchSize).toBeTruthy();
    expect(validateDeploy({ ...base, name: "x", kind: "command", command: "make deploy", healthKind: "url", healthUrl: "ftp://x" }).healthUrl).toBeTruthy();
    expect(validateDeploy({ ...base, name: "x", kind: "command", command: "make deploy", rollbackEnabled: true }).rollback).toBeTruthy();
  });

  it("builds config, health check and rollback payloads", () => {
    const v = { ...base, name: "web", kind: "ssh" as const, hostIds: ["h1", "h2"], script: "deploy.sh", strategy: "rolling" as const, batchSize: "2", timeout: "600", healthKind: "url" as const, healthUrl: "https://x.com/healthz", healthExpect: "200", rollbackEnabled: true, rollbackScript: "rollback.sh" };
    expect(validateDeploy(v)).toEqual({});
    expect(deployPayload(v)).toEqual({
      config: { host_ids: ["h1", "h2"], script: "deploy.sh", strategy: "rolling", batch_size: 2, cwd: null, timeout_s: 600 },
      health_check: { url: "https://x.com/healthz", expect_status: [200] },
      rollback: { host_ids: ["h1", "h2"], script: "rollback.sh", strategy: "rolling", cwd: null },
    });
  });

  it("round-trips a stored profile into form values", () => {
    const p = { name: "api", kind: "ci" as const, environment: "test" as const, config: { repo_id: "repo_1", workflow: "deploy.yml", variables: { ENV: "staging" } }, health_check: { command: "curl -f x", host_id: "h1" }, rollback: null };
    const v = deployFormDefaults(p);
    expect(v).toMatchObject({ repoId: "repo_1", workflow: "deploy.yml", variables: "ENV=staging", healthKind: "command", healthHostId: "h1", rollbackEnabled: false });
    expect(deployPayload(v).config).toEqual({ repo_id: "repo_1", workflow: "deploy.yml", variables: { ENV: "staging" } });
    expect(deploySummary(p)).toBe("deploy.yml · repo_1");
  });
});

describe("git accounts", () => {
  it("validates the server and token", () => {
    expect(validateGitAccount({ kind: "gitlab", selfHosted: true, server: "gitlab.sirket.com", token: "", name: "" })).toEqual({
      server: "Sunucu adresi https:// ile başlamalı.",
      token: "Belirteci yapıştırın.",
    });
  });

  it("links to the token page with scopes preselected", () => {
    expect(tokenPageUrl("github")).toContain("github.com/settings/tokens/new?scopes=repo,workflow,read:org");
    expect(tokenPageUrl("gitlab", "https://gitlab.sirket.com/")).toBe(
      "https://gitlab.sirket.com/-/user_settings/personal_access_tokens?name=AI%20Studio&scopes=api,read_repository,write_repository",
    );
  });
});

describe("grouping, routing and live events", () => {
  it("puts production first and sorts by name (Turkish collation)", () => {
    const groups = groupByEnvironment([
      { environment: "test" as const, name: "b" },
      { environment: "production" as const, name: "şirket" },
      { environment: "production" as const, name: "çekirdek" },
    ]);
    expect(groups.map((g) => g.environment)).toEqual(["production", "test"]);
    expect(groups[0]?.items.map((i) => i.name)).toEqual(["çekirdek", "şirket"]);
  });

  it("keys tab pages together and detail pages apart", () => {
    expect(connectionsRouteKey("/connections")).toBe("home");
    expect(connectionsRouteKey("/connections/audit")).toBe("home");
    expect(connectionsRouteKey("/connections/hosts/h1")).toBe("hosts/h1");
    expect(connectionsRouteKey("/connections/hosts/h1/terminal")).toBe("hosts/h1/terminal");
  });

  it("maps events to the lists they invalidate, ignoring ephemeral log lines", () => {
    const keys = connectionInvalidations([
      { id: 1, type: "remote.host.created", payload: {} },
      { id: 2, type: "db.query", payload: {} },
      { id: 3, type: "deploy.succeeded", payload: { deploy_id: "dr_1" } },
      { id: 0, type: "deploy.log", payload: { deploy_id: "dr_1", line: "x" } },
      { id: 4, type: "git.account_added", payload: {} },
    ]);
    expect(keys).toEqual([
      ["connections", "hosts"],
      ["connections", "audit"],
      ["connections", "deploy", "runs"],
      ["connections", "deploy", "run", "dr_1"],
      ["connections", "git"],
    ]);
  });
});
