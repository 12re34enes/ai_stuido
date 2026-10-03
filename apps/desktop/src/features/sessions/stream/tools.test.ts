import { parsePatch, patchTotals } from "../kit/patch";
import { revealStep } from "../kit/useSmoothText";
import { describeToolText, relPath, toolCommand, unwrapShell } from "./tools";

const call = (over: Record<string, unknown>) => ({ tool: "Bash", toolKind: "command" as const, input: {}, summary: null, result: null, ...over });

describe("describeTool", () => {
  it("follows the call state: running, done, failed", () => {
    const c = call({ input: { command: "pnpm test" } });
    expect(describeToolText(c)).toBe("pnpm test çalıştırılıyor");
    expect(describeToolText({ ...c, result: { output: "", isError: false, exitCode: 0, blobRef: null } })).toBe("pnpm test çalıştırıldı");
    expect(describeToolText({ ...c, result: { output: "", isError: true, exitCode: 1, blobRef: null } })).toBe("pnpm test başarısız oldu");
  });

  it("uses paths relative to the session cwd", () => {
    const c = call({
      tool: "Edit",
      toolKind: "file_edit",
      input: { file_path: "/repo/src/app.ts" },
      result: { output: "", isError: false, exitCode: null, blobRef: null },
    });
    expect(describeToolText(c, "/repo")).toBe("src/app.ts düzenlendi");
    expect(describeToolText({ ...c, tool: "Write" }, "/repo")).toBe("src/app.ts yazıldı");
  });

  it("handles Codex shell wrappers and patch changes", () => {
    expect(toolCommand({ toolKind: "command", input: { command: "bash -lc 'rg TODO src'" } })).toBe("rg TODO src");
    expect(toolCommand({ toolKind: "command", input: { command: ["bash", "-lc", "npm run lint"] } })).toBe("npm run lint");
    const patch = call({ tool: "apply_patch", toolKind: "file_edit", input: { changes: [{ path: "a.ts" }, { path: "b.ts" }] } });
    expect(describeToolText(patch)).toBe("a.ts +1 düzenleniyor");
  });

  it("names MCP and Studio tools and falls back to the adapter summary", () => {
    expect(describeToolText(call({ tool: "mcp__github__create_issue", toolKind: "mcp" }))).toBe("MCP github/create_issue çağrılıyor");
    expect(describeToolText(call({ tool: "mcp__aistudio__memory_read", toolKind: "studio" }))).toBe("Studio aracı memory_read çalışıyor");
    expect(describeToolText(call({ tool: "Mystery", toolKind: "other", summary: "Gizemli araç kullanılıyor" }))).toBe("Gizemli araç kullanılıyor");
  });

  it("relPath and unwrapShell", () => {
    expect(relPath("/a/b/c.ts", "/a/b/")).toBe("c.ts");
    expect(relPath("/x/c.ts", "/a")).toBe("/x/c.ts");
    expect(unwrapShell(`/bin/zsh -lc "echo hi"`)).toBe("echo hi");
    expect(unwrapShell("ls -la")).toBe("ls -la");
  });
});

describe("parsePatch", () => {
  it("splits a unified diff into original/modified with a gap between hunks", () => {
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      "@@ -20,2 +20,3 @@",
      " end();",
      "+more();",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const [f] = parsePatch(patch);
    expect(f).toMatchObject({ path: "src/a.ts", additions: 2, deletions: 1, empty: false });
    expect(f?.original.split("\n")).toEqual(["const a = 1;", "const b = 2;", "const c = 4;", "⋯", "end();"]);
    expect(f?.modified.split("\n")).toEqual(["const a = 1;", "const b = 3;", "const c = 4;", "⋯", "end();", "more();"]);
  });

  it("handles multi-file git patches, new files and renames", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/added.md b/added.md",
      "--- /dev/null",
      "+++ b/added.md",
      "@@ -0,0 +1,2 @@",
      "+# Başlık",
      "+metin",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files.map((f) => [f.path, f.oldPath])).toEqual([
      ["new.ts", "old.ts"],
      ["added.md", null],
    ]);
    expect(files[1]?.original).toBe("");
    expect(patchTotals(files)).toEqual({ additions: 3, deletions: 1 });
  });

  it("returns nothing for empty input and keeps a fallback path for bare hunks", () => {
    expect(parsePatch(null)).toEqual([]);
    expect(parsePatch("@@ -1 +1 @@\n-a\n+b", "x.ts")[0]?.path).toBe("x.ts");
  });
});

describe("revealStep", () => {
  it("reveals faster for larger backlogs and finishes quickly once final", () => {
    expect(revealStep(0, true)).toBe(0);
    expect(revealStep(3, true)).toBe(2);
    expect(revealStep(600, true)).toBe(100);
    expect(revealStep(5, false)).toBe(8);
    expect(revealStep(300, false)).toBe(100);
  });
});
