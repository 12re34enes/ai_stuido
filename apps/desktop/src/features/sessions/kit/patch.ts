/**
 * Unified diff (git patch) → the two texts DiffView renders. Agents report file changes as
 * patches; DiffView compares an original and a modified text. Only hunk content is known, so
 * gaps between hunks become a "⋯" line on both sides (an unchanged line, never highlighted).
 */

export interface PatchFile {
  /** New path (old path for deletions). */
  path: string;
  oldPath: string | null;
  original: string;
  modified: string;
  additions: number;
  deletions: number;
  /** Binary or header-only change: nothing to show line by line. */
  empty: boolean;
}

export const HUNK_GAP = "⋯";

function stripPrefix(p: string): string {
  const t = p.trim().replace(/\t.*$/, "");
  if (t === "/dev/null") return t;
  return t.replace(/^[ab]\//, "");
}

interface Draft {
  path: string;
  oldPath: string | null;
  a: string[];
  b: string[];
  additions: number;
  deletions: number;
  hunks: number;
}

function finish(d: Draft): PatchFile {
  return {
    path: d.path,
    oldPath: d.oldPath,
    original: d.a.join("\n"),
    modified: d.b.join("\n"),
    additions: d.additions,
    deletions: d.deletions,
    empty: d.hunks === 0,
  };
}

const draft = (path: string, oldPath: string | null): Draft => ({ path, oldPath, a: [], b: [], additions: 0, deletions: 0, hunks: 0 });

/** Parse a (possibly multi-file) unified diff. Unknown text before the first header is ignored. */
export function parsePatch(patch: string | null | undefined, fallbackPath = ""): PatchFile[] {
  if (!patch) return [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFile[] = [];
  const st: { cur: Draft | null; inHunk: boolean } = { cur: null, inHunk: false };

  const start = (path: string, oldPath: string | null): Draft => {
    if (st.cur) files.push(finish(st.cur));
    st.cur = draft(path, oldPath);
    st.inHunk = false;
    return st.cur;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      start(m?.[2] ?? fallbackPath, m && m[1] !== m[2] ? (m[1] ?? null) : null);
      continue;
    }
    if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      const oldP = stripPrefix(line.slice(4));
      const newP = stripPrefix((lines[i + 1] ?? "").slice(4));
      const path = newP === "/dev/null" ? oldP : newP;
      const renamed = oldP !== "/dev/null" && oldP !== path ? oldP : null;
      const c = st.cur;
      // A "diff --git" header already opened this file: keep it, just refine the paths.
      if (c && c.hunks === 0 && c.a.length === 0 && c.b.length === 0) {
        c.path = path || c.path;
        c.oldPath = renamed ?? c.oldPath;
      } else {
        start(path || fallbackPath, renamed);
      }
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const d = st.cur ?? start(fallbackPath, null);
      if (d.hunks > 0) {
        d.a.push(HUNK_GAP);
        d.b.push(HUNK_GAP);
      }
      d.hunks++;
      st.inHunk = true;
      continue;
    }
    const d = st.cur;
    if (!d || !st.inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      d.b.push(line.slice(1));
      d.additions++;
    } else if (line.startsWith("-")) {
      d.a.push(line.slice(1));
      d.deletions++;
    } else if (line.startsWith(" ") || line === "") {
      // A bare empty line at the very end is the patch's trailing newline, not context.
      if (line === "" && i === lines.length - 1) continue;
      d.a.push(line.slice(1));
      d.b.push(line.slice(1));
    } else {
      st.inHunk = false;
    }
  }
  if (st.cur) files.push(finish(st.cur));
  return files;
}

/** Totals for a diffstat ("+12 −3") without rendering. */
export function patchTotals(files: PatchFile[]): { additions: number; deletions: number } {
  return files.reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), {
    additions: 0,
    deletions: 0,
  });
}
