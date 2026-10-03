"""Git plumbing used by the worktree manager, written once against :class:`GitRunner`.

Parsers are pure functions (unit-tested); the async helpers never touch the user's index or
HEAD unless their name says so: snapshots use a temporary ``GIT_INDEX_FILE`` and merges are
computed with ``merge-tree --write-tree`` + ``commit-tree``.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from aistudio.contracts.gitops import DiffResult, FileDiff
from aistudio.core.errors import Unavailable
from aistudio.core.ids import ulid
from aistudio.gitops.runner import AISTUDIO_IDENTITY, GitCommandError, GitRunner

MIN_GIT_VERSION = (2, 38)
MERGE_BASE_FLAG_VERSION = (2, 40)  # ``merge-tree --merge-base``
_OID = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
_PATHSPEC_CHUNK = 200

FileStatus = Literal["added", "modified", "deleted", "renamed", "copied", "binary"]


# --------------------------------------------------------------------------- versions


def parse_version(text: str) -> tuple[int, int, int]:
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    if not m:
        return (0, 0, 0)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


async def git_version(r: GitRunner, cwd: str) -> tuple[int, int, int]:
    cp = await r.git("version", cwd=cwd)
    version = parse_version(cp.stdout)
    if version[:2] < MIN_GIT_VERSION:
        raise Unavailable(
            f"Git {MIN_GIT_VERSION[0]}.{MIN_GIT_VERSION[1]} veya üstü gerekli (bulunan: {cp.stdout.strip()}).",
        )
    return version


# --------------------------------------------------------------------------- refs


def is_oid(text: str) -> bool:
    return bool(_OID.match(text))


async def rev_parse(r: GitRunner, cwd: str, rev: str, *, kind: str = "commit") -> str | None:
    """Resolve ``rev`` to a full object id (``None`` if it does not exist or looks like an option)."""
    if not rev or rev.startswith("-"):
        return None
    cp = await r.git("rev-parse", "--verify", "--quiet", f"{rev}^{{{kind}}}", cwd=cwd, check=False)
    out = cp.stdout.strip()
    return out if cp.returncode == 0 and is_oid(out) else None


async def is_ancestor(r: GitRunner, cwd: str, ancestor: str, descendant: str) -> bool:
    cp = await r.git("merge-base", "--is-ancestor", ancestor, descendant, cwd=cwd, check=False)
    if cp.returncode in (0, 1):
        return cp.returncode == 0
    raise GitCommandError(
        "Git komutu başarısız oldu (git merge-base).",
        args=["merge-base", "--is-ancestor", ancestor, descendant],
        returncode=cp.returncode,
        stderr=cp.stderr,
    )


async def ref_exists(r: GitRunner, cwd: str, ref: str) -> bool:
    cp = await r.git("show-ref", "--verify", "--quiet", ref, cwd=cwd, check=False)
    return cp.returncode == 0


async def absolute_git_dir(r: GitRunner, cwd: str) -> str:
    return (await r.git("rev-parse", "--absolute-git-dir", cwd=cwd)).stdout.strip()


# --------------------------------------------------------------------------- worktree list


@dataclass
class WorktreeEntry:
    path: str
    head: str | None = None
    branch: str | None = None  # full ref (refs/heads/...)
    detached: bool = False
    bare: bool = False
    locked: bool = False
    prunable: bool = False


def parse_worktree_porcelain(out: str) -> list[WorktreeEntry]:
    """Parse ``git worktree list --porcelain -z``."""
    entries: list[WorktreeEntry] = []
    current: WorktreeEntry | None = None
    for field_ in out.split("\0"):
        if field_ == "":
            if current is not None:
                entries.append(current)
                current = None
            continue
        key, _, value = field_.partition(" ")
        if key == "worktree":
            if current is not None:
                entries.append(current)
            current = WorktreeEntry(path=value)
        elif current is None:
            continue
        elif key == "HEAD":
            current.head = value
        elif key == "branch":
            current.branch = value
        elif key == "detached":
            current.detached = True
        elif key == "bare":
            current.bare = True
        elif key == "locked":
            current.locked = True
        elif key == "prunable":
            current.prunable = True
    if current is not None:
        entries.append(current)
    return entries


async def worktree_list(r: GitRunner, cwd: str) -> list[WorktreeEntry]:
    cp = await r.git("worktree", "list", "--porcelain", "-z", cwd=cwd)
    return parse_worktree_porcelain(cp.stdout)


# --------------------------------------------------------------------------- status


async def is_dirty(r: GitRunner, cwd: str, *, untracked: bool) -> bool:
    cp = await r.git("status", "--porcelain=v1", "-z", f"--untracked-files={'normal' if untracked else 'no'}", cwd=cwd)
    return cp.stdout.strip("\0") != ""


def _split_z(out: str) -> list[str]:
    return [p for p in out.split("\0") if p]


async def changed_files(r: GitRunner, cwd: str, base: str) -> list[str]:
    """Committed since ``base`` + staged + unstaged + untracked (ignored files excluded).
    Renames count as both paths (they touch both)."""
    tracked = await r.git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", base, cwd=cwd)
    untracked = await r.git("ls-files", "--others", "--exclude-standard", "-z", cwd=cwd)
    return sorted(set(_split_z(tracked.stdout)) | set(_split_z(untracked.stdout)))


# --------------------------------------------------------------------------- snapshots


async def snapshot_tree(r: GitRunner, cwd: str) -> str:
    """Tree object of the worktree's full state (tracked + untracked, minus ignored) built in a
    throwaway index; the real index and HEAD are untouched."""
    gitdir = await absolute_git_dir(r, cwd)
    tmp = posixpath.join(gitdir, f"aistudio-index-{ulid().lower()}")
    env = {"GIT_INDEX_FILE": tmp}
    try:
        # Start from the real index so unchanged files keep their stat cache (no re-hashing).
        await r.copy_file(posixpath.join(gitdir, "index"), tmp)
        await r.git("add", "-A", cwd=cwd, env=env, timeout=900)
        return (await r.git("write-tree", cwd=cwd, env=env)).stdout.strip()
    finally:
        await r.remove_file(tmp)
        await r.remove_file(tmp + ".lock")


async def commit_tree(
    r: GitRunner,
    cwd: str,
    tree: str,
    parents: list[str],
    message: str,
    *,
    env: dict[str, str] | None = None,
) -> str:
    args = ["commit-tree", tree]
    for p in parents:
        args += ["-p", p]
    args += ["-F", "-"]
    cp = await r.git(*args, cwd=cwd, env={**AISTUDIO_IDENTITY, **(env or {})}, input=message.encode())
    return cp.stdout.strip()


async def snapshot_commit(r: GitRunner, cwd: str, message: str) -> str:
    """Commit (parent = HEAD) holding the worktree's full state. Not referenced by any branch."""
    tree = await snapshot_tree(r, cwd)
    head = await rev_parse(r, cwd, "HEAD")
    return await commit_tree(r, cwd, tree, [head] if head else [], message)


# --------------------------------------------------------------------------- merge-tree


@dataclass
class MergeTreeResult:
    tree: str
    conflicts: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.conflicts


def parse_merge_tree(out: str, returncode: int) -> MergeTreeResult | None:
    """Parse ``merge-tree --write-tree -z --name-only`` (messages included). ``None`` = error."""
    parts = out.split("\0")
    if not parts or not is_oid(parts[0].strip()):
        return None
    tree = parts[0].strip()
    conflicts: list[str] = []
    i = 1
    while i < len(parts) and parts[i] != "":
        if parts[i] not in conflicts:
            conflicts.append(parts[i])
        i += 1
    # Informational messages: <N> NUL <path>*N NUL <type> NUL <message> NUL ...
    i += 1
    while i < len(parts) and parts[i].isdigit():
        n = int(parts[i])
        paths = parts[i + 1 : i + 1 + n]
        kind = parts[i + 1 + n] if i + 1 + n < len(parts) else ""
        if kind.startswith("CONFLICT") and returncode == 1:
            for p in paths:
                if p and p not in conflicts:
                    conflicts.append(p)
        i += n + 3
    if returncode == 1 and not conflicts:
        conflicts.append("?")
    if returncode == 0:
        conflicts = []
    elif returncode != 1:
        return None
    return MergeTreeResult(tree=tree, conflicts=conflicts)


async def merge_trees(
    r: GitRunner,
    cwd: str,
    ours: str,
    theirs: str,
    *,
    base: str | None = None,
    merge_base_flag: bool = True,
) -> MergeTreeResult:
    """Three-way merge of two commits without a checkout. ``base`` overrides the merge base
    (cherry-picks); on git < 2.40 that is emulated with two synthetic commits whose only parent
    is ``base``, which makes ``base`` their unique merge base."""
    args = ["merge-tree", "--write-tree", "-z", "--name-only", "--messages"]
    if base is not None:
        if merge_base_flag:
            args.append(f"--merge-base={base}")
        else:
            ours_tree = await rev_parse(r, cwd, ours, kind="tree")
            theirs_tree = await rev_parse(r, cwd, theirs, kind="tree")
            assert ours_tree and theirs_tree
            ours = await commit_tree(r, cwd, ours_tree, [base], "aistudio: merge base (ours)")
            theirs = await commit_tree(r, cwd, theirs_tree, [base], "aistudio: merge base (theirs)")
    args += [ours, theirs]
    cp = await r.git(*args, cwd=cwd, check=False, timeout=600)
    result = parse_merge_tree(cp.stdout, cp.returncode)
    if result is None:
        raise GitCommandError(
            "Git komutu başarısız oldu (git merge-tree).", args=args, returncode=cp.returncode, stderr=cp.stderr
        )
    return result


# --------------------------------------------------------------------------- diffs


@dataclass(frozen=True)
class DiffLimits:
    max_files: int = 3000
    max_file_lines: int = 20_000  # skip the patch (but keep counts) above this many changed lines
    max_file_bytes: int = 256 * 1024
    max_total_bytes: int = 4 * 1024 * 1024


@dataclass
class _RawEntry:
    status: str
    path: str
    old_path: str | None = None


def parse_raw_numstat(out: str) -> list[tuple[_RawEntry, int | None, int | None]]:
    """Parse ``diff-tree -r -z -M --raw --numstat``: all raw records, then one numstat record
    per raw record, in the same order. Counts are ``None`` for binary files."""
    tokens = out.split("\0")
    raws: list[_RawEntry] = []
    i = 0
    while i < len(tokens) and tokens[i].startswith(":"):
        meta = tokens[i][1:].split(" ")
        status = meta[4] if len(meta) >= 5 else "M"
        if status[:1] in ("R", "C"):
            raws.append(_RawEntry(status=status[0], old_path=tokens[i + 1], path=tokens[i + 2]))
            i += 3
        else:
            raws.append(_RawEntry(status=status[0], path=tokens[i + 1]))
            i += 2
    result: list[tuple[_RawEntry, int | None, int | None]] = []
    for raw in raws:
        if i >= len(tokens):
            result.append((raw, 0, 0))
            continue
        added, deleted, rest = [*tokens[i].split("\t", 2), "", "", ""][:3]
        i += 3 if rest == "" else 1
        if added == "-" or deleted == "-":
            result.append((raw, None, None))
        else:
            result.append((raw, _int(added), _int(deleted)))
    return result


def _int(text: str) -> int:
    try:
        return int(text)
    except ValueError:
        return 0


def split_patches(text: str) -> list[str]:
    return [chunk for chunk in re.split(r"(?m)^(?=diff --git )", text) if chunk.startswith("diff --git ")]


_STATUS: dict[str, FileStatus] = {"A": "added", "D": "deleted", "R": "renamed", "C": "copied"}


async def tree_diff(
    r: GitRunner,
    cwd: str,
    base: str,
    head: str,
    *,
    include_patch: bool = True,
    limits: DiffLimits | None = None,
    head_label: str | None = None,
) -> DiffResult:
    """Diff between two tree-ish objects with rename and binary detection. Patches are fetched
    only for files under the per-file limit until the total budget is spent; anything skipped
    for size sets ``truncated``."""
    limits = limits or DiffLimits()
    cp = await r.git("diff-tree", "-r", "-z", "-M", "--raw", "--numstat", base, head, cwd=cwd, timeout=600)
    entries = parse_raw_numstat(cp.stdout)
    truncated = len(entries) > limits.max_files
    files: list[FileDiff] = []
    total_add = total_del = 0
    for raw, added, deleted in entries:
        binary = added is None
        total_add += added or 0
        total_del += deleted or 0
        if len(files) >= limits.max_files:
            continue
        files.append(
            FileDiff(
                path=raw.path,
                old_path=raw.old_path,
                status="binary" if binary else _STATUS.get(raw.status, "modified"),
                additions=added or 0,
                deletions=deleted or 0,
            )
        )
    if include_patch and files:
        truncated = await _attach_patches(r, cwd, base, head, files, limits) or truncated
    return DiffResult(
        base=base,
        head=head_label or head,
        files=files,
        additions=total_add,
        deletions=total_del,
        truncated=truncated,
    )


async def _attach_patches(
    r: GitRunner, cwd: str, base: str, head: str, files: list[FileDiff], limits: DiffLimits
) -> bool:
    truncated = False
    wanted: list[FileDiff] = []
    for f in files:
        if f.status == "binary":
            continue
        if f.additions + f.deletions > limits.max_file_lines:
            truncated = True
            continue
        wanted.append(f)
    budget = limits.max_total_bytes
    for start in range(0, len(wanted), _PATHSPEC_CHUNK):
        if budget <= 0:
            truncated = True
            break
        chunk = wanted[start : start + _PATHSPEC_CHUNK]
        patches = await _patches_for(r, cwd, base, head, chunk)
        for f, patch in zip(chunk, patches, strict=True):
            if patch is None:
                continue
            size = len(patch.encode())
            if size > limits.max_file_bytes or size > budget:
                truncated = True
                if size <= limits.max_file_bytes:
                    budget = 0
                continue
            f.patch = patch
            budget -= size
    return truncated


async def _patches_for(r: GitRunner, cwd: str, base: str, head: str, chunk: list[FileDiff]) -> list[str | None]:
    async def run(paths: list[str]) -> list[str]:
        cp = await r.git(
            "diff-tree",
            "-r",
            "-M",
            "-p",
            "--no-color",
            base,
            head,
            "--",
            *paths,
            cwd=cwd,
            env={"GIT_LITERAL_PATHSPECS": "1"},
            timeout=600,
        )
        return split_patches(cp.stdout)

    paths: list[str] = []
    for f in chunk:
        paths.append(f.path)
        if f.old_path:
            paths.append(f.old_path)
    patches = await run(paths)
    if len(patches) == len(chunk):
        return list(patches)
    # Ordering could not be matched (should not happen): fall back to one call per file.
    out: list[str | None] = []
    for f in chunk:
        single = await run([f.path, *([f.old_path] if f.old_path else [])])
        out.append(single[0] if len(single) == 1 else None)
    return out


# --------------------------------------------------------------------------- branches


@dataclass
class BranchRef:
    ref: str
    sha: str
    upstream: str | None
    committed_at: datetime | None
    subject: str


async def list_refs(r: GitRunner, cwd: str, *patterns: str) -> list[BranchRef]:
    fmt = "%(refname)%00%(objectname)%00%(upstream:short)%00%(committerdate:iso-strict)%00%(subject)%00%(symref)"
    cp = await r.git("for-each-ref", f"--format={fmt}", "--sort=-committerdate", *patterns, cwd=cwd)
    refs: list[BranchRef] = []
    for line in cp.stdout.splitlines():
        parts = line.split("\0")
        if len(parts) < 6 or parts[5]:  # skip symbolic refs (origin/HEAD)
            continue
        try:
            when = datetime.fromisoformat(parts[3]) if parts[3] else None
        except ValueError:
            when = None
        refs.append(
            BranchRef(ref=parts[0], sha=parts[1], upstream=parts[2] or None, committed_at=when, subject=parts[4])
        )
    return refs
