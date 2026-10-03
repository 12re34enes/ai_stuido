"""GitLab REST v4 client (gitlab.com and self-hosted). Project paths may be nested groups."""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal, cast
from urllib.parse import quote

import httpx

from aistudio.contracts.git_hosting import CheckRun, PullRequestRef, PullRequestStatus, ReviewComment
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from aistudio.git_hosting.client import HostingClient, parse_dt
from aistudio.git_hosting.http import ApiClient
from aistudio.git_hosting.models import (
    HostingUser,
    Issue,
    PrSnapshot,
    PullRequestInfo,
    PullRequestSummary,
    RemoteRepo,
)
from aistudio.security.masking import Masker

type CheckStatus = Literal["queued", "in_progress", "completed"]

_QUEUED = {"created", "pending", "waiting_for_resource", "preparing", "scheduled", "waiting_for_callback"}
_JOB_CONCLUSIONS: dict[str, str] = {
    "success": "success",
    "failed": "failure",
    "canceled": "cancelled",
    "canceling": "cancelled",
    "skipped": "skipped",
    "manual": "skipped",  # waits for a click; must not keep CI "pending" forever
}
_MERGEABLE = {"mergeable", "can_be_merged"}
_UNKNOWN_MERGE = {"checking", "unchecked", "preparing", "approvals_syncing", "cannot_be_merged_recheck"}


def _job_status(status: str) -> CheckStatus:
    if status in _QUEUED:
        return "queued"
    if status == "running":
        return "in_progress"
    return "completed"


def _job_check(job: dict[str, Any]) -> CheckRun:
    raw = str(job.get("status", ""))
    status = _job_status(raw)
    conclusion: Any = None
    if status == "completed":
        conclusion = _JOB_CONCLUSIONS.get(raw, "neutral")
        if conclusion == "failure" and job.get("allow_failure"):
            conclusion = "neutral"
    name = str(job.get("name", ""))
    stage = job.get("stage")
    return CheckRun(
        name=f"{stage}: {name}" if stage else name,
        status=status,
        conclusion=conclusion,
        url=job.get("web_url"),
        job_id=str(job["id"]) if job.get("id") is not None else None,
    )


class GitLabClient(HostingClient):
    kind = "gitlab"
    label = "GitLab"

    def __init__(
        self,
        *,
        api_url: str,
        token: str,
        masker: Masker,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.api = ApiClient(
            base_url=api_url,
            headers={"PRIVATE-TOKEN": token, "Accept": "application/json", "User-Agent": "AI-Studio"},
            label=self.label,
            masker=masker,
            transport=transport,
            clock=clock,
        )
        self._clock = clock

    @property
    def blocked_until(self) -> datetime | None:
        return self.api.blocked_until

    async def aclose(self) -> None:
        await self.api.aclose()

    @staticmethod
    def _p(path: str) -> str:
        if "/" not in path.strip("/"):
            raise ValidationFailed("GitLab proje yolu 'grup/proje' biçiminde olmalı.", details={"path": path})
        return f"/projects/{quote(path.strip('/'), safe='')}"

    async def _optional(self, url: str, params: dict[str, Any] | None = None) -> Any:
        """GET that tolerates endpoints missing on older/self-hosted editions."""
        try:
            return await self.api.get(url, params=params)
        except (NotFound, PermissionDenied):
            return None

    # ------------------------------------------------------------------ account
    async def current_user(self) -> HostingUser:
        data = await self.api.get("/user", cache=False) or {}
        scopes: list[str] = []
        with contextlib.suppress(NotFound, PermissionDenied, ValidationFailed):
            token = await self.api.get("/personal_access_tokens/self", cache=False) or {}
            scopes = [str(s) for s in token.get("scopes", [])]
        return HostingUser(
            username=str(data.get("username", "")), name=data.get("name"), web_url=data.get("web_url"), scopes=scopes
        )

    async def list_repos(self, *, limit: int = 200) -> list[RemoteRepo]:
        items = await self.api.paginate(
            "/projects",
            params={"membership": "true", "simple": "true", "per_page": 100, "order_by": "last_activity_at"},
            max_pages=max(1, (limit + 99) // 100),
            limit=limit,
        )
        return [
            RemoteRepo(
                full_name=p["path_with_namespace"],
                name=p.get("name", p["path_with_namespace"]),
                web_url=p.get("web_url", ""),
                clone_url=p.get("http_url_to_repo"),
                ssh_url=p.get("ssh_url_to_repo"),
                default_branch=p.get("default_branch"),
                private=p.get("visibility", "private") != "public",
                description=p.get("description"),
                updated_at=parse_dt(p.get("last_activity_at")),
            )
            for p in items
        ]

    # ------------------------------------------------------------------ merge requests
    async def open_pr(self, path: str, *, head: str, base: str, title: str, body: str, draft: bool) -> PullRequestInfo:
        if draft and not title.lower().startswith(("draft:", "[draft]", "(draft)")):
            title = f"Draft: {title}"
        try:
            resp = await self.api.request(
                "POST",
                f"{self._p(path)}/merge_requests",
                json={"source_branch": head, "target_branch": base, "title": title, "description": body},
            )
        except (Conflict, ValidationFailed) as e:
            detail = str(e.details.get("message", "")).lower()
            if "already exists" in detail:
                raise Conflict("Bu branch için zaten açık bir MR var.", details=e.details) from e
            if "source_branch" in detail or "invalid" in detail:
                raise ValidationFailed("Branch GitLab'de bulunamadı; önce push edilmeli.", details=e.details) from e
            raise
        mr = resp.data or {}
        return PullRequestInfo(
            number=int(mr["iid"]),
            url=mr.get("web_url", ""),
            title=mr.get("title", title),
            head=mr.get("source_branch", head),
            base=mr.get("target_branch", base),
            draft=bool(mr.get("draft", mr.get("work_in_progress", draft))),
        )

    async def list_prs(self, path: str, *, limit: int = 50) -> list[PullRequestSummary]:
        items = await self.api.paginate(
            f"{self._p(path)}/merge_requests",
            params={"state": "opened", "per_page": min(100, limit), "order_by": "updated_at"},
            max_pages=1,
            limit=limit,
        )
        return [
            PullRequestSummary(
                number=int(m["iid"]),
                title=m.get("title", ""),
                url=m.get("web_url", ""),
                head=m.get("source_branch", ""),
                base=m.get("target_branch", ""),
                draft=bool(m.get("draft", m.get("work_in_progress", False))),
                author=(m.get("author") or {}).get("username"),
                updated_at=parse_dt(m.get("updated_at")),
            )
            for m in items
        ]

    async def _discussions(self, path: str, number: int) -> list[dict[str, Any]]:
        return await self.api.paginate(
            f"{self._p(path)}/merge_requests/{number}/discussions", params={"per_page": 100}, max_pages=5
        )

    async def pr_snapshot(self, path: str, number: int, *, repo_id: str) -> PrSnapshot:
        p = self._p(path)
        mr: dict[str, Any] = await self.api.get(f"{p}/merge_requests/{number}") or {}
        raw_state = mr.get("state")
        state: Literal["open", "closed", "merged"] = (
            "merged" if raw_state == "merged" else ("open" if raw_state == "opened" else "closed")
        )
        head_sha = mr.get("sha")
        checks: list[CheckRun] = []
        comments: list[ReviewComment] = []
        decision: Any = "none"
        if state == "open":
            pipeline = mr.get("head_pipeline") or mr.get("pipeline")
            if not pipeline and head_sha:
                found = await self.api.get(f"{p}/pipelines", params={"sha": head_sha, "per_page": 1})
                pipeline = found[0] if isinstance(found, list) and found else None
            if pipeline and pipeline.get("id") is not None:
                jobs = await self.api.paginate(f"{p}/pipelines/{pipeline['id']}/jobs", params={"per_page": 100})
                checks = [_job_check(j) for j in jobs]
            for d in await self._discussions(path, number):
                notes = [n for n in d.get("notes", []) if not n.get("system")]
                if not notes or not notes[0].get("resolvable") or notes[0].get("resolved"):
                    continue
                for n in notes:
                    pos = n.get("position") or {}
                    comments.append(
                        ReviewComment(
                            id=str(n.get("id")),
                            author=(n.get("author") or {}).get("username") or "ghost",
                            body=n.get("body") or "",
                            path=pos.get("new_path") or pos.get("old_path"),
                            line=pos.get("new_line") or pos.get("old_line"),
                            created_at=parse_dt(n.get("created_at")) or self._clock(),
                            thread_id=str(d.get("id")),
                        )
                    )
            approvals = await self._optional(f"{p}/merge_requests/{number}/approvals") or {}
            reviewers = await self._optional(f"{p}/merge_requests/{number}/reviewers") or []
            if any(isinstance(r, dict) and r.get("state") == "requested_changes" for r in reviewers):
                decision = "changes_requested"
            elif approvals.get("approved") and not approvals.get("approvals_left"):
                decision = "approved"
            elif approvals.get("approvals_left"):
                decision = "review_required"
        detailed = str(mr.get("detailed_merge_status") or mr.get("merge_status") or "")
        mergeable: bool | None = (
            True if detailed in _MERGEABLE else (None if detailed in _UNKNOWN_MERGE or not detailed else False)
        )
        status = PullRequestStatus(
            ref=PullRequestRef(
                repo_id=repo_id,
                number=number,
                url=mr.get("web_url", ""),
                title=mr.get("title", ""),
                head=mr.get("source_branch", ""),
                base=mr.get("target_branch", ""),
                draft=bool(mr.get("draft", mr.get("work_in_progress", False))),
            ),
            state=state,
            mergeable=mergeable,
            has_conflicts=bool(mr.get("has_conflicts")) or detailed in ("conflict", "broken_status"),
            checks=checks,
            review_decision=decision,
            unresolved_comments=comments,
            head_sha=head_sha,
            updated_at=parse_dt(mr.get("updated_at")),
        )
        is_fork = (
            mr.get("source_project_id") is not None
            and mr.get("target_project_id") is not None
            and mr.get("source_project_id") != mr.get("target_project_id")
        )
        return PrSnapshot(status=status, web_url=mr.get("web_url", ""), is_fork=is_fork)

    async def job_log(self, path: str, job_id: str) -> str:
        if not job_id.isdigit():
            raise ValidationFailed("Geçersiz iş kimliği.", details={"job_id": job_id})
        return await self.api.get_text(f"{self._p(path)}/jobs/{job_id}/trace")

    async def _discussion_of(self, path: str, number: int, note_id: str) -> str:
        for d in await self._discussions(path, number):
            if any(str(n.get("id")) == note_id for n in d.get("notes", [])):
                return str(d["id"])
        raise NotFound("Yorum bulunamadı.", details={"comment_id": note_id})

    async def reply_to_comment(
        self, path: str, number: int, comment_id: str, body: str, *, thread_id: str | None = None
    ) -> str:
        discussion = thread_id or await self._discussion_of(path, number, comment_id)
        resp = await self.api.request(
            "POST", f"{self._p(path)}/merge_requests/{number}/discussions/{discussion}/notes", json={"body": body}
        )
        return str((resp.data or {}).get("id", ""))

    async def resolve_thread(self, path: str, number: int, thread_id: str) -> None:
        await self.api.request(
            "PUT", f"{self._p(path)}/merge_requests/{number}/discussions/{thread_id}", params={"resolved": "true"}
        )

    # ------------------------------------------------------------------ pipelines
    async def trigger_pipeline(
        self, path: str, *, ref: str, workflow: str | None, variables: dict[str, str] | None
    ) -> str:
        body: dict[str, Any] = {"ref": ref.removeprefix("refs/heads/")}
        if variables:
            body["variables"] = [{"key": k, "value": v, "variable_type": "env_var"} for k, v in variables.items()]
        resp = await self.api.request("POST", f"{self._p(path)}/pipeline", json=body)
        return str((resp.data or {})["id"])

    async def pipeline_status(self, path: str, run_id: str) -> CheckRun:
        if not run_id.isdigit():
            raise ValidationFailed("Geçersiz pipeline kimliği.", details={"run_id": run_id})
        data = await self.api.get(f"{self._p(path)}/pipelines/{run_id}", cache=False) or {}
        raw = str(data.get("status", ""))
        status = _job_status(raw)
        conclusion: Any = None
        if status == "completed":
            conclusion = "action_required" if raw == "manual" else _JOB_CONCLUSIONS.get(raw, "neutral")
        return CheckRun(name=f"Pipeline #{run_id}", status=status, conclusion=conclusion, url=data.get("web_url"))

    # ------------------------------------------------------------------ issues
    @staticmethod
    def _issue(i: dict[str, Any]) -> Issue:
        return Issue(
            number=int(i["iid"]),
            title=i.get("title", ""),
            body=i.get("description") or "",
            state="open" if i.get("state") == "opened" else str(i.get("state", "closed")),
            url=i.get("web_url", ""),
            author=(i.get("author") or {}).get("username"),
            labels=[str(lb) if not isinstance(lb, dict) else str(lb.get("name")) for lb in i.get("labels", [])],
            comments=int(i.get("user_notes_count") or 0),
            created_at=parse_dt(i.get("created_at")),
            updated_at=parse_dt(i.get("updated_at")),
        )

    async def list_issues(self, path: str, *, limit: int = 50) -> list[Issue]:
        items = await self.api.paginate(
            f"{self._p(path)}/issues",
            params={"state": "opened", "per_page": min(100, limit), "order_by": "updated_at"},
            max_pages=max(1, (limit + 99) // 100),
            limit=limit,
        )
        return [self._issue(i) for i in items]

    async def get_issue(self, path: str, number: int) -> Issue:
        return self._issue(cast(dict[str, Any], await self.api.get(f"{self._p(path)}/issues/{number}") or {}))
