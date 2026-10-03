/**
 * Git output helpers for the changes panel: turn a unified patch into the two texts DiffView
 * compares, and a flat list of changed paths into a collapsible file tree.
 */
import type { FileDiff, FileStatus } from "./types";

export interface PatchTexts {
  original: string;
  modified: string;
  /** Hunk headers in order ("@@ -12,6 +12,8 @@ function x"). */
  hunks: string[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Rebuild both sides from a unified diff. Only the hunks are known, so the texts hold the hunks'
 * lines; consecutive hunks are separated by a "⋯ satır N" marker line on both sides so the
 * viewer lines them up and the reader sees where code was skipped.
 */
export function patchToTexts(patch: string | null | undefined): PatchTexts {
  const original: string[] = [];
  const modified: string[] = [];
  const hunks: string[] = [];
  if (!patch) return { original: "", modified: "", hunks };
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const m = HUNK.exec(raw);
    if (m) {
      inHunk = true;
      hunks.push(raw);
      const newStart = Number(m[3]);
      if (hunks.length > 1 || newStart > 1) {
        const marker = `⋯ satır ${newStart}${m[5]?.trim() ? ` · ${m[5].trim()}` : ""}`;
        original.push(marker);
        modified.push(marker);
      }
      continue;
    }
    if (!inHunk) continue; // diff --git / index / --- / +++ headers
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === "+") modified.push(body);
    else if (tag === "-") original.push(body);
    else if (tag === " " || raw === "") {
      original.push(body);
      modified.push(body);
    }
  }
  // A trailing empty context line comes from the patch's final newline.
  if (original[original.length - 1] === "" && modified[modified.length - 1] === "") {
    original.pop();
    modified.pop();
  }
  return { original: original.join("\n"), modified: modified.join("\n"), hunks };
}

// ----------------------------------------------------------------------------- file tree

export interface TreeFile {
  type: "file";
  name: string;
  path: string;
  file: FileDiff;
}

export interface TreeDir {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  additions: number;
  deletions: number;
}

export type TreeNode = TreeFile | TreeDir;

/** Group paths into directories (single-child chains collapse: "src/ui/flow"), dirs first, A→Z. */
export function buildFileTree(files: FileDiff[]): TreeNode[] {
  const root: TreeDir = { type: "dir", name: "", path: "", children: [], additions: 0, deletions: 0 };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let dir = root;
    dir.additions += f.additions;
    dir.deletions += f.deletions;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      const path = parts.slice(0, i + 1).join("/");
      let next = dir.children.find((c): c is TreeDir => c.type === "dir" && c.name === name);
      if (!next) {
        next = { type: "dir", name, path, children: [], additions: 0, deletions: 0 };
        dir.children.push(next);
      }
      next.additions += f.additions;
      next.deletions += f.deletions;
      dir = next;
    }
    dir.children.push({ type: "file", name: parts[parts.length - 1] ?? f.path, path: f.path, file: f });
  }
  const collapse = (node: TreeDir): TreeDir => {
    let cur = node;
    while (cur.children.length === 1 && cur.children[0]!.type === "dir") {
      const only = cur.children[0] as TreeDir;
      cur = { ...only, name: cur.name ? `${cur.name}/${only.name}` : only.name };
    }
    return { ...cur, children: sortNodes(cur.children.map((c) => (c.type === "dir" ? collapse(c) : c))) };
  };
  const sortNodes = (nodes: TreeNode[]) =>
    [...nodes].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "tr") : a.type === "dir" ? -1 : 1));
  return sortNodes(root.children.map((c) => (c.type === "dir" ? collapse(c) : c)));
}

/** Files in the order the tree shows them (for ↑/↓ navigation and the default selection). */
export function flattenTree(nodes: TreeNode[]): FileDiff[] {
  const out: FileDiff[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.type === "file") out.push(n.file);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export const statusLetter: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  binary: "B",
};
