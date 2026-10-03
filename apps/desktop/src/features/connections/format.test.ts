import { describe, expect, it } from "vitest";

import { actorLabel, cellText, chunkFingerprint, dbTarget, hostAddress, latestRuns, stampLine, toTsv } from "./format";
import { hostKeyProblem } from "./hosts/useHostTest";
import { initialTerminalState, parseServerMessage, terminalReducer } from "./terminal/protocol";
import type { DeployRun, Host } from "./types";

describe("display helpers", () => {
  it("formats host and database targets", () => {
    expect(hostAddress({ username: "deploy", hostname: "web1", port: 22 })).toBe("deploy@web1");
    expect(hostAddress({ username: "deploy", hostname: "web1", port: 2222 })).toBe("deploy@web1:2222");
    expect(dbTarget({ kind: "postgres", host: "db", port: 5432, database: "orders", username: "ro" })).toBe("ro@db:5432/orders");
    expect(dbTarget({ kind: "sqlite", host: null, port: null, database: "~/dev.sqlite3", username: null })).toBe("~/dev.sqlite3");
  });

  it("renders result cells and TSV", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(toTsv(["id", "not"], [[1, "a\tb"], [2, null]])).toBe("id\tnot\n1\ta b\n2\t");
  });

  it("chunks fingerprints for reading aloud", () => {
    expect(chunkFingerprint("SHA256:abcdefgh12")).toEqual(["SHA256:", "abcd", "efgh", "12"]);
  });

  it("labels actors and stamps live log lines like stored ones (UTC)", () => {
    expect(actorLabel("user")).toBe("Siz");
    expect(actorLabel("agent:ses_2")).toBe("Ajan · ses_2");
    expect(stampLine("2026-10-03T08:01:02.123Z", "ok")).toBe("[08:01:02] ok");
  });

  it("finds the latest run per profile", () => {
    const runs = [{ id: "3", profile_id: "a" }, { id: "2", profile_id: "b" }, { id: "1", profile_id: "a" }] as DeployRun[];
    expect([...latestRuns(runs).values()].map((r) => r.id)).toEqual(["3", "2"]);
  });
});

describe("host key problems", () => {
  const host = { id: "h", hostname: "web1", port: 22 } as Host;
  it("extracts unknown / changed keys from a failed test", () => {
    const p = hostKeyProblem(host, { ok: false, message: "x", latency_ms: null, server_version: null, uname: null, error_code: "host_key_changed", details: { fingerprint: "SHA256:x", key_type: "ssh-ed25519", port: 2222 } });
    expect(p).toMatchObject({ code: "host_key_changed", fingerprint: "SHA256:x", keyType: "ssh-ed25519", hostname: "web1", port: 2222 });
    expect(hostKeyProblem(host, { ok: false, message: "x", latency_ms: null, server_version: null, uname: null, error_code: "unavailable", details: {} })).toBeNull();
  });
});

describe("terminal protocol", () => {
  it("parses server frames defensively", () => {
    expect(parseServerMessage('{"kind":"status","state":"waiting_approval","approval_id":"apr_1"}')).toEqual({ kind: "status", state: "waiting_approval", approval_id: "apr_1" });
    expect(parseServerMessage('{"kind":"exit","code":0}')).toEqual({ kind: "exit", code: 0 });
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage('{"kind":"status","state":"weird"}')).toBeNull();
  });

  it("walks approval → open → exit, and keeps the outcome when the socket closes after", () => {
    let s = terminalReducer(initialTerminalState, { kind: "status", state: "waiting_approval", approval_id: "apr_1" });
    expect(s).toMatchObject({ phase: "waiting_approval", approvalId: "apr_1" });
    s = terminalReducer(s, { kind: "status", state: "open" });
    expect(s.phase).toBe("open");
    s = terminalReducer(s, { kind: "exit", code: 130 });
    expect(s).toMatchObject({ phase: "closed", exitCode: 130 });
    expect(terminalReducer(s, { kind: "socket_closed", message: "x" })).toBe(s);
  });

  it("reports a lost connection and an approval denial", () => {
    expect(terminalReducer({ ...initialTerminalState, phase: "open" }, { kind: "socket_closed", message: "Bağlantı koptu." })).toMatchObject({ phase: "error", errorCode: "socket_closed" });
    expect(terminalReducer(initialTerminalState, { kind: "error", message: "Onay reddedildi.", code: "approval_denied" })).toMatchObject({ phase: "error", errorCode: "approval_denied" });
  });
});
