from __future__ import annotations

from datetime import UTC, datetime

from aistudio.contracts.gitops import Worktree
from aistudio.gitops.git import (
    parse_merge_tree,
    parse_raw_numstat,
    parse_version,
    parse_worktree_porcelain,
    split_patches,
)
from aistudio.gitops.runner import TransportGitRunner, tail
from aistudio.gitops.watcher import compute_pairs, overlaps_from_pairs

OID = "c66a4ff3" * 5  # a 40-hex object id
Z40 = "0" * 40


def test_parse_version() -> None:
    assert parse_version("git version 2.39.5 (Apple Git-154)") == (2, 39, 5)
    assert parse_version("git version 2.43.0") == (2, 43, 0)
    assert parse_version("git version 2.50") == (2, 50, 0)
    assert parse_version("nonsense") == (0, 0, 0)


def test_parse_merge_tree_clean_and_conflicts() -> None:
    clean = parse_merge_tree(f"{OID}\0", 0)
    assert clean is not None and clean.clean and clean.tree == OID

    out = (
        f"{OID}\0f.txt\0sp ace.txt\0\0"
        "1\0f.txt\0Auto-merging\0Auto-merging f.txt\n\0"
        "1\0f.txt\0CONFLICT (contents)\0CONFLICT (content): Merge conflict in f.txt\n\0"
        "2\0old.txt\0new.txt\0CONFLICT (rename/delete)\0CONFLICT (rename/delete): ...\n\0"
    )
    res = parse_merge_tree(out, 1)
    assert res is not None and not res.clean
    assert res.conflicts == ["f.txt", "sp ace.txt", "old.txt", "new.txt"]


def test_parse_merge_tree_errors() -> None:
    assert parse_merge_tree("", 1) is None
    assert parse_merge_tree("fatal: nope\n", 128) is None
    assert parse_merge_tree(f"{OID}\0", 128) is None
    unknown = parse_merge_tree(f"{OID}\0\0", 1)
    assert unknown is not None and unknown.conflicts == ["?"]


def test_parse_raw_numstat_with_rename_and_binary() -> None:
    out = (
        f":000000 100644 {Z40} {OID} A\0b.bin\0"
        f":100644 100644 {OID} {OID} M\0f.txt\0"
        f":100644 100644 {OID} {OID} R087\0old name.txt\0new name.txt\0"
        f":100644 000000 {OID} {Z40} D\0gone.txt\0"
        "-\t-\tb.bin\0"
        "3\t1\tf.txt\0"
        "2\t2\t\0old name.txt\0new name.txt\0"
        "0\t9\tgone.txt\0"
    )
    entries = parse_raw_numstat(out)
    assert [(e.status, e.path, e.old_path, a, d) for e, a, d in entries] == [
        ("A", "b.bin", None, None, None),
        ("M", "f.txt", None, 3, 1),
        ("R", "new name.txt", "old name.txt", 2, 2),
        ("D", "gone.txt", None, 0, 9),
    ]
    assert parse_raw_numstat("") == []


def test_parse_worktree_porcelain() -> None:
    out = (
        "worktree /repo\0HEAD " + OID + "\0branch refs/heads/main\0\0"
        "worktree /wt/a\0HEAD " + OID + "\0detached\0\0"
        "worktree /wt/b\0HEAD " + OID + "\0branch refs/heads/aistudio/x/agent-1\0locked\0"
        "prunable gitdir file points to non-existent location\0\0"
    )
    entries = parse_worktree_porcelain(out)
    assert [e.path for e in entries] == ["/repo", "/wt/a", "/wt/b"]
    assert entries[0].branch == "refs/heads/main" and not entries[0].detached
    assert entries[1].detached and entries[1].branch is None
    assert entries[2].locked and entries[2].prunable


def test_split_patches() -> None:
    text = (
        "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+diff --git fake\n"
        "diff --git a/y b/y\nnew file mode 100644\n"
    )
    chunks = split_patches(text)
    assert len(chunks) == 2
    assert chunks[0].startswith("diff --git a/x") and "+diff --git fake" in chunks[0]
    assert chunks[1].startswith("diff --git a/y")


def test_tail_keeps_the_end() -> None:
    assert tail("abc", 10) == "abc"
    out = tail("x" * 1000 + "END", 100)
    assert out.endswith("END") and len(out) <= 100 and "kısaltıldı" in out


def test_transport_env_prefix_unsets_repo_location() -> None:
    argv = TransportGitRunner._env_prefix({"GIT_INDEX_FILE": "/tmp/idx"})
    assert argv[0] == "env"
    assert "GIT_DIR" in argv and "-u" in argv
    assert "GIT_INDEX_FILE=/tmp/idx" in argv
    assert argv.count("GIT_INDEX_FILE") == 0  # not unset when explicitly provided
    assert "GIT_TERMINAL_PROMPT=0" in argv


def _wt(wid: str, repo: str) -> Worktree:
    return Worktree(
        id=wid,
        repo_id=repo,
        workspace_id="ws",
        path=f"/wt/{wid}",
        branch=f"aistudio/t/{wid}",
        base_ref="main",
        base_sha=OID,
        created_at=datetime.now(UTC),
    )


def test_compute_pairs_and_overlaps() -> None:
    wts = [_wt("a", "r1"), _wt("b", "r1"), _wt("c", "r1"), _wt("d", "r2")]
    changed = {
        "a": frozenset({"x.py", "y.py"}),
        "b": frozenset({"x.py"}),
        "c": frozenset({"x.py", "y.py", "z.py"}),
        "d": frozenset({"x.py"}),  # other repo: never overlaps with r1
    }
    pairs = compute_pairs(wts, changed)
    assert pairs == {
        ("r1", "a", "b"): frozenset({"x.py"}),
        ("r1", "a", "c"): frozenset({"x.py", "y.py"}),
        ("r1", "b", "c"): frozenset({"x.py"}),
    }
    overlaps = overlaps_from_pairs(pairs, {"a": ["s1"], "c": ["s3", "s4"]})
    assert [(o.path, o.worktree_ids, o.session_ids) for o in overlaps] == [
        ("x.py", ["a", "b", "c"], ["s1", "s3", "s4"]),
        ("y.py", ["a", "c"], ["s1", "s3", "s4"]),
    ]
