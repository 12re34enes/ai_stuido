/**
 * Unified diff parsing (git diff / difflib output) for the memory history and proposal views.
 * Produces files → hunks → numbered lines; tolerant of truncated input.
 */

export type DiffLineType = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  /** Section text after the @@ markers (heading context), if any. */
  section: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** Display path: the new path, or the old one for deletions. */
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

function stripPrefix(p: string): string | null {
  const t = p.trim().replace(/\t.*$/, "");
  if (t === "/dev/null") return null;
  return t.replace(/^[ab]\//, "");
}

function finish(file: DiffFile): DiffFile {
  let status: DiffFile["status"] = "modified";
  if (file.oldPath === null && file.newPath !== null) status = "added";
  else if (file.newPath === null && file.oldPath !== null) status = "deleted";
  else if (file.oldPath && file.newPath && file.oldPath !== file.newPath) status = "renamed";
  return { ...file, path: file.newPath ?? file.oldPath ?? "", status };
}

interface ParseState {
  files: DiffFile[];
  file: DiffFile | null;
  hunk: DiffHunk | null;
  oldNo: number;
  newNo: number;
}

function openFile(st: ParseState, oldPath: string | null, newPath: string | null): DiffFile {
  if (st.file) st.files.push(finish(st.file));
  st.file = { oldPath, newPath, path: "", status: "modified", hunks: [], added: 0, removed: 0 };
  st.hunk = null;
  return st.file;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const st: ParseState = { files: [], file: null, hunk: null, oldNo: 0, newNo: 0 };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      openFile(st, m?.[1] ?? null, m?.[2] ?? null);
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      const file = st.file ?? openFile(st, null, null);
      st.oldNo = Number(h[1]);
      st.newNo = Number(h[2]);
      st.hunk = { header: line, section: h[3] ?? "", oldStart: st.oldNo, newStart: st.newNo, lines: [] };
      file.hunks.push(st.hunk);
      continue;
    }
    // "--- a/x" starts a file header: right after "diff --git", or a new file in difflib output.
    if (line.startsWith("--- ") && (st.hunk === null || isHeaderStart(line))) {
      const oldPath = stripPrefix(line.slice(4));
      if (st.file && st.hunk === null && st.file.hunks.length === 0) st.file.oldPath = oldPath;
      else openFile(st, oldPath, null);
      continue;
    }
    if (line.startsWith("+++ ") && st.file && st.hunk === null) {
      st.file.newPath = stripPrefix(line.slice(4));
      continue;
    }
    if (st.hunk === null || st.file === null) {
      if (st.file && line.startsWith("new file mode")) st.file.oldPath = null;
      if (st.file && line.startsWith("deleted file mode")) st.file.newPath = null;
      continue; // index / mode / similarity headers are not rendered
    }
    const { file, hunk } = st;
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), newNo: st.newNo++ });
      file.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldNo: st.oldNo++ });
      file.removed++;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "meta", text: line.slice(1).trim() });
    } else {
      hunk.lines.push({ type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: st.oldNo++, newNo: st.newNo++ });
    }
  }
  if (st.file) st.files.push(finish(st.file));
  return st.files;
}

/**
 * Inside a hunk, a line starting with "--- " is normally a deleted line beginning with "-- ".
 * It is a new file header only when the next diff markers follow, which we cannot see here;
 * difflib output for several files always repeats "--- a/" or "--- /dev/null".
 */
function isHeaderStart(line: string): boolean {
  return /^--- (a\/|\/dev\/null)/.test(line);
}

export function diffTotals(files: DiffFile[]): { added: number; removed: number } {
  return files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), { added: 0, removed: 0 });
}
