"""Git plumbing for one workspace memory repo (git CLI via ``aistudio.core.proc``).

Commits are authored by "AI Studio"; the human/agent behind a change is recorded in an
``AI-Studio-Actor`` trailer so history can show who did what. The user's global git config
must not interfere (signing, hooks, autocrlf), so every call pins those options.
"""

from __future__ import annotations

import asyncio
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field

from aistudio.contracts.transport import CompletedProcess
from aistudio.core import proc
from aistudio.core.errors import NotFound, StudioError, ValidationFailed

AUTHOR_NAME = "AI Studio"
AUTHOR_EMAIL = "studio@aistudio.local"
ACTOR_TRAILER = "AI-Studio-Actor"

_GIT_OPTS = (
    "-c",
    f"user.name={AUTHOR_NAME}",
    "-c",
    f"user.email={AUTHOR_EMAIL}",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.quotepath=false",
)
_REV = re.compile(r"^(?:[0-9a-fA-F]{4,64}|HEAD(?:~\d{1,4})?)$")
_RS, _US = "\x1e", "\x1f"
MAX_DIFF_CHARS = 200_000


class MemoryGitError(StudioError):
    status_code = 500
    code = "memory_git_error"


class MemoryCommit(BaseModel):
    sha: str
    short_sha: str
    message: str  # subject line
    body: str = ""
    author: str
    actor: str | None = None
    committed_at: datetime
    paths: list[str] = Field(default_factory=list)


def validate_rev(rev: str) -> str:
    rev = rev.strip()
    if not _REV.match(rev):
        raise ValidationFailed("Geçersiz commit kimliği.", details={"commit": rev})
    return rev


def _message(subject: str, *, body: str | None, actor: str, trailers: dict[str, str] | None) -> str:
    subject = " ".join(subject.split()) or "Hafıza güncellendi"
    parts = [subject]
    if body and body.strip():
        parts.append(body.strip())
    lines = [f"{ACTOR_TRAILER}: {actor}"]
    lines += [f"{k}: {v}" for k, v in (trailers or {}).items() if v]
    parts.append("\n".join(lines))
    return "\n\n".join(parts) + "\n"


class MemoryRepo:
    def __init__(self, root: Path) -> None:
        self.root = root

    # ------------------------------------------------------------------ low level
    async def git(self, *args: str, check: bool = True, timeout: float = 60) -> CompletedProcess:
        res = await proc.git(*_GIT_OPTS, *args, cwd=str(self.root), timeout=timeout)
        if check and res.returncode != 0:
            raise MemoryGitError(
                "Hafıza reposunda git işlemi başarısız oldu.",
                details={"command": " ".join(args[:2]), "stderr": res.stderr.strip()[-2000:]},
            )
        return res

    def is_repo(self) -> bool:
        return (self.root / ".git").exists()

    def file(self, rel: str) -> Path:
        return self.root / rel

    # ------------------------------------------------------------------ setup
    async def init(self, starter: dict[str, str], *, actor: str = "system") -> str | None:
        """Create the repo (if needed), add any missing starter files and commit them."""
        self.root.mkdir(parents=True, exist_ok=True)
        if not self.is_repo():
            await self.git("init", "-q", "-b", "main")
        for rel, content in starter.items():
            path = self.file(rel)
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(path.write_text, content, encoding="utf-8")
        return await self.commit_all("Hafıza başlatıldı", actor=actor)

    # ------------------------------------------------------------------ queries
    async def head(self) -> str | None:
        res = await self.git("rev-parse", "--verify", "-q", "HEAD", check=False)
        if res.returncode != 0:
            return None
        return res.stdout.strip() or None

    async def resolve(self, rev: str) -> str:
        rev = validate_rev(rev)
        res = await self.git("rev-parse", "--verify", "-q", f"{rev}^{{commit}}", check=False)
        if res.returncode != 0 or not res.stdout.strip():
            raise NotFound("Hafıza commit'i bulunamadı.", details={"commit": rev})
        return res.stdout.strip()

    async def is_dirty(self) -> bool:
        res = await self.git("status", "--porcelain", "--untracked-files=all")
        return bool(res.stdout.strip())

    async def show(self, rev: str, rel: str) -> str | None:
        res = await self.git("show", f"{rev}:{rel}", check=False)
        return res.stdout if res.returncode == 0 else None

    async def log(self, *, path: str | None = None, limit: int = 50) -> list[MemoryCommit]:
        if await self.head() is None:
            return []
        fmt = (
            _RS
            + _US.join(
                ["%H", "%h", "%an", "%cI", "%s", "%b", f"%(trailers:key={ACTOR_TRAILER},valueonly,separator=%x2C)"]
            )
            + _US
        )
        args = ["log", f"-n{max(1, min(limit, 1000))}", f"--format={fmt}", "--name-only"]
        if path:
            args += ["--", path]
        res = await self.git(*args)
        commits: list[MemoryCommit] = []
        for record in res.stdout.split(_RS):
            if not record.strip():
                continue
            fields = record.split(_US)
            if len(fields) < 8:
                continue
            sha, short, author, date, subject, body, actor, rest = fields[:8]
            body = re.sub(r"(?m)^AI-Studio-[\w-]+:.*$", "", body).strip()
            commits.append(
                MemoryCommit(
                    sha=sha,
                    short_sha=short,
                    author=author,
                    committed_at=datetime.fromisoformat(date).astimezone(UTC),
                    message=subject,
                    body=body,
                    actor=actor.strip() or None,
                    paths=[p for p in rest.splitlines() if p.strip()],
                )
            )
        return commits

    async def last_modified(self, *, limit: int = 2000) -> dict[str, datetime]:
        """Latest commit time per path (one ``git log`` pass)."""
        if await self.head() is None:
            return {}
        res = await self.git("log", f"-n{limit}", f"--format={_RS}%cI", "--name-only")
        seen: dict[str, datetime] = {}
        for record in res.stdout.split(_RS):
            lines = [ln for ln in record.splitlines() if ln.strip()]
            if not lines:
                continue
            ts = datetime.fromisoformat(lines[0].strip()).astimezone(UTC)
            for p in lines[1:]:
                seen.setdefault(p.strip(), ts)
        return seen

    async def diff(self, base: str, head: str, *, path: str | None = None) -> tuple[str, bool]:
        args = ["diff", "--no-color", "--no-ext-diff", base, head]
        if path:
            args += ["--", path]
        res = await self.git(*args)
        text = res.stdout
        if len(text) > MAX_DIFF_CHARS:
            return text[:MAX_DIFF_CHARS], True
        return text, False

    # ------------------------------------------------------------------ changes
    async def commit_all(
        self,
        subject: str,
        *,
        actor: str,
        body: str | None = None,
        trailers: dict[str, str] | None = None,
    ) -> str | None:
        """Stage everything and commit. Returns the new sha, or ``None`` if nothing changed."""
        await self.git("add", "-A")
        staged = await self.git("diff", "--cached", "--quiet", check=False)
        if staged.returncode == 0 and await self.head() is not None:
            return None
        msg = _message(subject, body=body, actor=actor, trailers=trailers)
        # "whitespace" cleanup keeps Markdown "#" lines in bodies (the default "strip" would drop them).
        await self.git("commit", "-q", "--no-verify", "--allow-empty", "--cleanup=whitespace", "-m", msg)
        return await self.head()

    async def restore_tree(self, sha: str) -> None:
        """Make index and working tree match ``sha`` (files added later are removed)."""
        await self.git("read-tree", "-u", "--reset", sha)

    async def merge_three_way(self, base: str, ours: str, theirs: str) -> str | None:
        """``git merge-file`` on temp files. Returns merged text, or ``None`` on conflict."""

        def _write(d: str, name: str, text: str) -> str:
            p = os.path.join(d, name)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
            return p

        with tempfile.TemporaryDirectory(prefix="aistudio-merge-") as d:
            o = await asyncio.to_thread(_write, d, "ours", ours)
            b = await asyncio.to_thread(_write, d, "base", base)
            t = await asyncio.to_thread(_write, d, "theirs", theirs)
            res = await proc.git("merge-file", "-p", "-q", o, b, t, cwd=d)
        return res.stdout if res.returncode == 0 else None
