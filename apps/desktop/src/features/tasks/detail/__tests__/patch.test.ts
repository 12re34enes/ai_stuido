import { buildFileTree, flattenTree, patchToTexts } from "../patch";
import type { FileDiff } from "../types";

const file = (path: string, over: Partial<FileDiff> = {}): FileDiff => ({ path, old_path: null, status: "modified", additions: 1, deletions: 0, patch: null, ...over });

describe("patchToTexts", () => {
  it("rebuilds both sides of a hunk", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " export { a, b };",
      "",
    ].join("\n");
    expect(patchToTexts(patch)).toEqual({
      original: "const a = 1;\nconst b = 2;\nexport { a, b };",
      modified: "const a = 1;\nconst b = 3;\nexport { a, b };",
      hunks: ["@@ -1,3 +1,3 @@"],
    });
  });

  it("separates hunks with an aligned marker line and skips no-newline notes", () => {
    const patch = ["@@ -10,2 +10,2 @@ function x()", "-a", "+b", "\\ No newline at end of file", "@@ -40 +40,2 @@", " c", "+d"].join("\n");
    const t = patchToTexts(patch);
    expect(t.original.split("\n")).toEqual(["⋯ satır 10 · function x()", "a", "⋯ satır 40", "c"]);
    expect(t.modified.split("\n")).toEqual(["⋯ satır 10 · function x()", "b", "⋯ satır 40", "c", "d"]);
  });

  it("returns empty texts for binary files", () => {
    expect(patchToTexts(null)).toEqual({ original: "", modified: "", hunks: [] });
  });
});

describe("buildFileTree", () => {
  it("groups by directory, collapses single-child chains and sorts dirs first", () => {
    const tree = buildFileTree([
      file("apps/web/src/ui/LimitBar.tsx", { additions: 10, deletions: 2 }),
      file("apps/web/src/ui/limits.ts", { additions: 3 }),
      file("README.md", { additions: 1 }),
      file("apps/web/src/lib/api.ts", { additions: 4, deletions: 4 }),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["apps/web/src", "README.md"]);
    const src = tree[0]!;
    expect(src.type === "dir" && src.children.map((c) => c.name)).toEqual(["lib", "ui"]);
    expect(src.type === "dir" && [src.additions, src.deletions]).toEqual([17, 6]);
    expect(flattenTree(tree).map((f) => f.path)).toEqual([
      "apps/web/src/lib/api.ts",
      "apps/web/src/ui/LimitBar.tsx",
      "apps/web/src/ui/limits.ts",
      "README.md",
    ]);
  });
});
