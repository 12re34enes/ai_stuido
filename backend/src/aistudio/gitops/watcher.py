"""Live conflict detection between active worktrees of the same repo (spec §7, §18).

Each active worktree's changed files (vs its base, incl. uncommitted and untracked) are
recomputed periodically and, for local worktrees, shortly after file-system events under the
worktree root. Two worktrees touching the same path form an overlap; a new overlap emits
``conflict.detected`` (severity high), a vanished one ``conflict.resolved``. State survives
restarts by replaying this watcher's own events, so a restart does not re-alert.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from watchfiles import DefaultFilter, awatch

from aistudio.contracts.gitops import FileOverlap, Worktree
from aistudio.core.context import AppContext
from aistudio.core.events import ET, EventFilter, Severity
from aistudio.gitops.settings import CONFLICT_POLL_SECONDS, float_setting

if TYPE_CHECKING:
    from aistudio.gitops.service import WorktreeManagerImpl

log = logging.getLogger("aistudio.gitops.watch")

CONFLICT_RESOLVED = "conflict.resolved"
EVENT_SOURCE = "gitops.overlap"
MAX_PATHS_IN_EVENT = 500
_SCAN_CONCURRENCY = 4
_PAIR_CHECK_TIMEOUT = 30.0

PairKey = tuple[str, str, str]  # (repo_id, worktree_a, worktree_b) with a < b


def compute_pairs(worktrees: Iterable[Worktree], changed: dict[str, frozenset[str]]) -> dict[PairKey, frozenset[str]]:
    by_repo: dict[str, list[str]] = defaultdict(list)
    for w in worktrees:
        if w.id in changed:
            by_repo[w.repo_id].append(w.id)
    pairs: dict[PairKey, frozenset[str]] = {}
    for repo_id, ids in by_repo.items():
        ids.sort()
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                common = changed[a] & changed[b]
                if common:
                    pairs[(repo_id, a, b)] = frozenset(common)
    return pairs


def overlaps_from_pairs(
    pairs: dict[PairKey, frozenset[str]], sessions: dict[str, list[str]] | None = None
) -> list[FileOverlap]:
    acc: dict[tuple[str, str], set[str]] = defaultdict(set)
    for (repo_id, a, b), paths in pairs.items():
        for p in paths:
            acc[(repo_id, p)].update((a, b))
    sessions = sessions or {}
    out = [
        FileOverlap(
            path=path,
            repo_id=repo_id,
            worktree_ids=sorted(wts),
            session_ids=sorted({s for w in wts for s in sessions.get(w, [])}),
        )
        for (repo_id, path), wts in acc.items()
    ]
    out.sort(key=lambda o: (o.repo_id, o.path))
    return out


def _under(path: str, roots: dict[str, str]) -> set[str]:
    hits: set[str] = set()
    for wid, root in roots.items():
        if path == root or path.startswith(root + os.sep):
            hits.add(wid)
    return hits


class ConflictWatcher:
    def __init__(self, manager: WorktreeManagerImpl, ctx: AppContext) -> None:
        self._mgr = manager
        self._ctx = ctx
        self._changed: dict[str, frozenset[str]] = {}
        self._pairs: dict[PairKey, frozenset[str]] = {}
        self._meta: dict[str, Worktree] = {}
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()
        self._fs_paths: set[str] = set()
        self._full_requested = True
        self._seeded = False

    # ------------------------------------------------------------------ control
    def poke(self) -> None:
        """Request a full rescan soon (worktree created/merged/removed, commits...)."""
        self._full_requested = True
        self._wake.set()

    def reset(self) -> None:
        """Allow ``run``/``watch_files`` to run again after :meth:`stop`."""
        self._stop.clear()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    async def _poll_seconds(self) -> float:
        return max(1.0, await float_setting(self._ctx.store, CONFLICT_POLL_SECONDS))

    async def run(self) -> None:
        """Background loop: full scan every poll interval, targeted scans on file events."""
        while not self._stop.is_set():
            fs_paths, self._fs_paths = self._fs_paths, set()
            full, self._full_requested = self._full_requested, False
            try:
                await self.scan(only_paths=None if full or not fs_paths else fs_paths)
            except Exception:
                log.exception("conflict scan failed")
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=await self._poll_seconds())
            except TimeoutError:
                self._full_requested = True
            self._wake.clear()

    async def watch_files(self, root: Path) -> None:
        """Feed file-system events under the local worktree root into targeted rescans. Falls back
        silently to polling when watching is unavailable."""
        try:
            root.mkdir(parents=True, exist_ok=True)
            async for changes in awatch(
                root,
                watch_filter=DefaultFilter(),
                stop_event=self._stop,
                rust_timeout=1000,
                debounce=800,
            ):
                self._fs_paths.update(os.path.realpath(p) for _, p in changes)
                self._wake.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("file watching unavailable; conflict detection falls back to polling", exc_info=True)

    # ------------------------------------------------------------------ scanning
    async def _seed(self) -> None:
        """Rebuild the last announced overlap state from our own events."""
        self._seeded = True
        events = await self._ctx.events.query(
            EventFilter(types=[ET.CONFLICT_DETECTED, CONFLICT_RESOLVED]), descending=True, limit=5000
        )
        pairs: dict[PairKey, set[str]] = {}
        for ev in reversed(events):
            p = ev.payload
            wts = p.get("worktree_ids")
            if p.get("source") != EVENT_SOURCE or not isinstance(wts, list) or len(wts) != 2:
                continue
            key: PairKey = (str(p.get("repo_id")), *sorted(str(w) for w in wts))  # type: ignore[assignment]
            paths = {str(x) for x in p.get("paths", [])}
            if ev.type == ET.CONFLICT_DETECTED:
                pairs.setdefault(key, set()).update(paths)
            else:
                remaining = pairs.get(key, set()) - paths
                if remaining:
                    pairs[key] = remaining
                else:
                    pairs.pop(key, None)
        self._pairs = {k: frozenset(v) for k, v in pairs.items()}

    async def scan(self, *, only_paths: set[str] | None = None) -> list[FileOverlap]:
        async with self._lock:
            if not self._seeded:
                await self._seed()
            active = await self._mgr.list(active_only=True)
            active_ids = {w.id for w in active}
            self._meta.update({w.id: w for w in active})
            for wid in list(self._changed):
                if wid not in active_ids:
                    del self._changed[wid]
            if only_paths is None:
                targets = active
            else:
                roots = {w.id: os.path.realpath(w.path) for w in active if w.location.kind == "local"}
                hit: set[str] = set()
                for p in only_paths:
                    hit |= _under(p, roots)
                targets = [w for w in active if w.id in hit or w.id not in self._changed]
            sem = asyncio.Semaphore(_SCAN_CONCURRENCY)

            async def refresh(w: Worktree) -> None:
                async with sem:
                    try:
                        self._changed[w.id] = frozenset(await self._mgr.changed_files(w.id))
                    except Exception:
                        log.debug("changed_files failed for %s", w.id, exc_info=True)

            await asyncio.gather(*(refresh(w) for w in targets))
            new_pairs = compute_pairs(active, self._changed)
            old_pairs = self._pairs
            self._pairs = new_pairs
            await self._announce(old_pairs, new_pairs)
            keep = active_ids | {w for key in new_pairs for w in key[1:]}
            self._meta = {k: v for k, v in self._meta.items() if k in keep}
            return overlaps_from_pairs(new_pairs)

    async def overlaps(self) -> list[FileOverlap]:
        """Current overlaps; always rescans so an explicit request never sees stale state."""
        await self.scan()
        return overlaps_from_pairs(self._pairs, await self._mgr.session_map())

    # ------------------------------------------------------------------ events
    async def _announce(self, old: dict[PairKey, frozenset[str]], new: dict[PairKey, frozenset[str]]) -> None:
        sessions: dict[str, list[str]] | None = None
        for key, paths in new.items():
            added = paths - old.get(key, frozenset())
            if not added:
                continue
            if sessions is None:
                sessions = await self._mgr.session_map()
            merge_conflicts = await self._pair_conflicts(key)
            await self._emit(ET.CONFLICT_DETECTED, key, added, paths, sessions, Severity.high, merge_conflicts)
        for key, paths in old.items():
            gone = paths - new.get(key, frozenset())
            if not gone:
                continue
            if sessions is None:
                sessions = await self._mgr.session_map()
            await self._emit(CONFLICT_RESOLVED, key, gone, new.get(key, frozenset()), sessions, Severity.info, None)

    async def _pair_conflicts(self, key: PairKey) -> list[str] | None:
        _, a, b = key
        try:
            result = await asyncio.wait_for(self._mgr.check_pair(a, b), timeout=_PAIR_CHECK_TIMEOUT)
        except Exception:
            log.debug("pair check failed for %s/%s", a, b, exc_info=True)
            return None
        return result.conflicts

    async def _emit(
        self,
        type_: str,
        key: PairKey,
        paths: frozenset[str],
        current: frozenset[str],
        sessions: dict[str, list[str]],
        severity: Severity,
        merge_conflicts: list[str] | None,
    ) -> None:
        repo_id, a, b = key
        known: list[Worktree] = []
        for wid in (a, b):
            w = self._meta.get(wid)
            if w is None:
                try:
                    w = await self._mgr.get(wid)
                except Exception:
                    w = None
            if w is not None:
                known.append(w)
        sorted_paths = sorted(paths)
        shown = ", ".join(sorted_paths[:3]) + (f" (+{len(sorted_paths) - 3})" if len(sorted_paths) > 3 else "")
        labels = [w.label or w.branch for w in known]
        if type_ == ET.CONFLICT_DETECTED:
            message = f"İki ajan aynı dosyalara dokunuyor: {shown}"
        else:
            message = f"Dosya örtüşmesi sona erdi: {shown}"
        payload: dict[str, Any] = {
            "source": EVENT_SOURCE,
            "repo_id": repo_id,
            "worktree_ids": [a, b],
            "paths": sorted_paths[:MAX_PATHS_IN_EVENT],
            "path_count": len(sorted_paths),
            "overlap_count": len(current),
            "branches": [w.branch for w in known],
            "labels": labels,
            "task_ids": sorted({w.task_id for w in known if w.task_id}),
            "run_ids": sorted({w.run_id for w in known if w.run_id}),
            "session_ids": sorted({s for w in (a, b) for s in sessions.get(w, [])}),
            "message": message,
        }
        if merge_conflicts is not None:
            payload["merge_conflicts"] = merge_conflicts[:MAX_PATHS_IN_EVENT]
        run_ids = {w.run_id for w in known}
        task_ids = {w.task_id for w in known}
        await self._ctx.events.append(
            type_,
            payload,
            severity=severity,
            workspace_id=known[0].workspace_id if known else None,
            run_id=next(iter(run_ids)) if len(run_ids) == 1 else None,
            task_id=next(iter(task_ids)) if len(task_ids) == 1 else None,
        )
