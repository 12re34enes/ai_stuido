"""GitHub client: REST v3 (with ETag revalidation) plus GraphQL where REST has no answer
(review decision, review threads and their resolved state, resolving a thread)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any, Literal, cast
from urllib.parse import quote

import httpx

from aistudio.contracts.git_hosting import CheckRun, PullRequestRef, PullRequestStatus, ReviewComment
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, Unavailable, ValidationFailed
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

_PR_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 50) {
            nodes { databaseId author { login } body createdAt path line }
          }
        }
      }
      latestReviews(first: 50) {
        nodes { databaseId author { login } body state submittedAt }
      }
    }
  }
}
"""

_RESOLVE_MUTATION = """
mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } }
}
"""

_CHECK_STATUSES = {"queued": "queued", "in_progress": "in_progress", "completed": "completed"}
_CONCLUSIONS = {
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
}
_REVIEW_DECISIONS = {
    "APPROVED": "approved",
    "CHANGES_REQUESTED": "changes_requested",
    "REVIEW_REQUIRED": "review_required",
}
# GraphQL review threads are re-read when the PR changed, or at least this often.
_THREADS_MAX_AGE = timedelta(minutes=5)

type CheckStatus = Literal["queued", "in_progress", "completed"]


def _check_status(value: object) -> CheckStatus:
    return cast(CheckStatus, _CHECK_STATUSES.get(str(value), "queued"))


def _conclusion(value: object) -> Any:
    if value is None:
        return None
    text = str(value)
    if text == "startup_failure":
        return "failure"
    return text if text in _CONCLUSIONS else "neutral"


def _owner_name(path: str) -> tuple[str, str]:
    owner, _, name = path.partition("/")
    if not owner or not name or "/" in name:
        raise ValidationFailed("GitHub repo adı 'sahip/repo' biçiminde olmalı.", details={"path": path})
    return owner, name


def graphql_url_for(api_url: str) -> str:
    base = api_url.rstrip("/")
    if base == "https://api.github.com":
        return "https://api.github.com/graphql"
    if base.endswith("/api/v3"):
        return base[: -len("/v3")] + "/graphql"
    return base + "/graphql"


class GitHubClient(HostingClient):
    kind = "github"
    label = "GitHub"

    def __init__(
        self,
        *,
        api_url: str,
        token: str,
        masker: Masker,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = utcnow,
        dispatch_lookup_attempts: int = 5,
        dispatch_lookup_delay: float = 2.0,
    ) -> None:
        self.api = ApiClient(
            base_url=api_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "AI-Studio",
            },
            label=self.label,
            masker=masker,
            transport=transport,
            clock=clock,
        )
        self._graphql_url = graphql_url_for(api_url)
        self._clock = clock
        self._dispatch_attempts = dispatch_lookup_attempts
        self._dispatch_delay = dispatch_lookup_delay
        self._threads: dict[tuple[str, int], tuple[datetime, dict[str, Any]]] = {}

    @property
    def blocked_until(self) -> datetime | None:
        return self.api.blocked_until

    async def aclose(self) -> None:
        await self.api.aclose()

    async def _graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        resp = await self.api.request("POST", self._graphql_url, json={"query": query, "variables": variables})
        body = resp.data if isinstance(resp.data, dict) else {}
        errors = body.get("errors") or []
        data = body.get("data")
        if errors and not data:
            first = errors[0] if isinstance(errors[0], dict) else {"message": str(errors[0])}
            if first.get("type") == "NOT_FOUND":
                raise NotFound("GitHub kaynağı bulunamadı.", details={"message": first.get("message")})
            raise Unavailable(f"GitHub GraphQL hatası: {first.get('message', '')}"[:300])
        return data or {}

    # ------------------------------------------------------------------ account
    async def current_user(self) -> HostingUser:
        resp = await self.api.request("GET", "/user")
        data = resp.data or {}
        scopes = [s.strip() for s in resp.headers.get("x-oauth-scopes", "").split(",") if s.strip()]
        return HostingUser(
            username=str(data.get("login", "")), name=data.get("name"), web_url=data.get("html_url"), scopes=scopes
        )

    async def list_repos(self, *, limit: int = 200) -> list[RemoteRepo]:
        items = await self.api.paginate(
            "/user/repos",
            params={"per_page": 100, "sort": "updated", "affiliation": "owner,collaborator,organization_member"},
            max_pages=max(1, (limit + 99) // 100),
            limit=limit,
        )
        return [
            RemoteRepo(
                full_name=r["full_name"],
                name=r["name"],
                web_url=r["html_url"],
                clone_url=r.get("clone_url"),
                ssh_url=r.get("ssh_url"),
                default_branch=r.get("default_branch"),
                private=bool(r.get("private")),
                description=r.get("description"),
                updated_at=parse_dt(r.get("updated_at")),
            )
            for r in items
        ]

    # ------------------------------------------------------------------ pull requests
    async def open_pr(self, path: str, *, head: str, base: str, title: str, body: str, draft: bool) -> PullRequestInfo:
        owner, name = _owner_name(path)
        try:
            resp = await self.api.request(
                "POST",
                f"/repos/{owner}/{name}/pulls",
                json={"title": title, "head": head, "base": base, "body": body, "draft": draft},
            )
        except ValidationFailed as e:
            detail = str(e.details.get("message", "")).lower()
            if "already exists" in detail:
                raise Conflict("Bu branch için zaten açık bir PR var.", details=e.details) from e
            if "no commits between" in detail:
                raise ValidationFailed("İki branch arasında fark yok; PR açılamadı.", details=e.details) from e
            if "head" in detail and "invalid" in detail:
                raise ValidationFailed("Branch GitHub'da bulunamadı; önce push edilmeli.", details=e.details) from e
            raise
        pr = resp.data or {}
        return PullRequestInfo(
            number=int(pr["number"]),
            url=pr["html_url"],
            title=pr.get("title", title),
            head=pr.get("head", {}).get("ref", head),
            base=pr.get("base", {}).get("ref", base),
            draft=bool(pr.get("draft", draft)),
        )

    async def list_prs(self, path: str, *, limit: int = 50) -> list[PullRequestSummary]:
        owner, name = _owner_name(path)
        items = await self.api.paginate(
            f"/repos/{owner}/{name}/pulls",
            params={"state": "open", "per_page": min(100, limit)},
            max_pages=1,
            limit=limit,
        )
        return [
            PullRequestSummary(
                number=int(p["number"]),
                title=p["title"],
                url=p["html_url"],
                head=p["head"]["ref"],
                base=p["base"]["ref"],
                draft=bool(p.get("draft")),
                author=(p.get("user") or {}).get("login"),
                updated_at=parse_dt(p.get("updated_at")),
            )
            for p in items
        ]

    async def _checks(self, owner: str, name: str, sha: str) -> list[CheckRun]:
        runs = await self.api.paginate(
            f"/repos/{owner}/{name}/commits/{sha}/check-runs", params={"per_page": 100}, item_key="check_runs"
        )
        checks: list[CheckRun] = []
        for run in runs:
            app_slug = (run.get("app") or {}).get("slug")
            checks.append(
                CheckRun(
                    name=str(run.get("name", "")),
                    status=_check_status(run.get("status")),
                    conclusion=_conclusion(run.get("conclusion")) if run.get("status") == "completed" else None,
                    url=run.get("html_url") or run.get("details_url"),
                    # For GitHub Actions the check run id is the job id (logs endpoint).
                    job_id=str(run["id"]) if app_slug == "github-actions" and run.get("id") is not None else None,
                )
            )
        combined = await self.api.get(f"/repos/{owner}/{name}/commits/{sha}/status")
        for st in (combined or {}).get("statuses", []):
            state = st.get("state")
            done = state in ("success", "failure", "error")
            checks.append(
                CheckRun(
                    name=str(st.get("context", "status")),
                    status="completed" if done else "in_progress",
                    conclusion=("success" if state == "success" else "failure") if done else None,
                    url=st.get("target_url"),
                )
            )
        return checks

    async def _review_data(self, owner: str, name: str, number: int, *, pr_changed: bool) -> dict[str, Any]:
        key = (f"{owner}/{name}", number)
        now = self._clock()
        cached = self._threads.get(key)
        if cached is not None and not pr_changed and now - cached[0] < _THREADS_MAX_AGE:
            return cached[1]
        data = await self._graphql(_PR_QUERY, {"owner": owner, "name": name, "number": number})
        pr = ((data.get("repository") or {}).get("pullRequest")) or {}
        self._threads[key] = (now, pr)
        return pr

    async def pr_snapshot(self, path: str, number: int, *, repo_id: str) -> PrSnapshot:
        owner, name = _owner_name(path)
        resp = await self.api.request("GET", f"/repos/{owner}/{name}/pulls/{number}", cache=True)
        pr: dict[str, Any] = resp.data or {}
        head = pr.get("head") or {}
        base = pr.get("base") or {}
        head_sha = head.get("sha")
        if pr.get("merged") or pr.get("merged_at"):
            state: Literal["open", "closed", "merged"] = "merged"
        elif pr.get("state") == "closed":
            state = "closed"
        else:
            state = "open"
        checks: list[CheckRun] = []
        comments: list[ReviewComment] = []
        decision: Any = "none"
        if state == "open":
            if head_sha:
                checks = await self._checks(owner, name, head_sha)
            review = await self._review_data(owner, name, number, pr_changed=not resp.not_modified)
            decision = _REVIEW_DECISIONS.get(str(review.get("reviewDecision")), "none")
            for thread in (review.get("reviewThreads") or {}).get("nodes") or []:
                if thread.get("isResolved"):
                    continue
                for c in (thread.get("comments") or {}).get("nodes") or []:
                    created = parse_dt(c.get("createdAt")) or self._clock()
                    comments.append(
                        ReviewComment(
                            id=str(c.get("databaseId")),
                            author=((c.get("author") or {}).get("login")) or "ghost",
                            body=c.get("body") or "",
                            path=c.get("path") or thread.get("path"),
                            line=c.get("line") or thread.get("line"),
                            created_at=created,
                            thread_id=thread.get("id"),
                        )
                    )
            if decision == "changes_requested":
                for rv in (review.get("latestReviews") or {}).get("nodes") or []:
                    if rv.get("state") != "CHANGES_REQUESTED" or not (rv.get("body") or "").strip():
                        continue
                    comments.append(
                        ReviewComment(
                            id=f"review:{rv.get('databaseId')}",
                            author=((rv.get("author") or {}).get("login")) or "ghost",
                            body=rv.get("body") or "",
                            created_at=parse_dt(rv.get("submittedAt")) or self._clock(),
                        )
                    )
        mergeable = pr.get("mergeable")
        head_repo = (head.get("repo") or {}).get("full_name")
        base_repo = (base.get("repo") or {}).get("full_name")
        status = PullRequestStatus(
            ref=PullRequestRef(
                repo_id=repo_id,
                number=number,
                url=pr.get("html_url", ""),
                title=pr.get("title", ""),
                head=head.get("ref", ""),
                base=base.get("ref", ""),
                draft=bool(pr.get("draft")),
            ),
            state=state,
            mergeable=mergeable if isinstance(mergeable, bool) else None,
            has_conflicts=pr.get("mergeable_state") == "dirty",
            checks=checks,
            review_decision=decision,
            unresolved_comments=comments,
            head_sha=head_sha,
            updated_at=parse_dt(pr.get("updated_at")),
        )
        return PrSnapshot(
            status=status, web_url=pr.get("html_url", ""), is_fork=head_repo is None or head_repo != base_repo
        )

    async def job_log(self, path: str, job_id: str) -> str:
        owner, name = _owner_name(path)
        if not job_id.isdigit():
            raise ValidationFailed("Geçersiz iş kimliği.", details={"job_id": job_id})
        return await self.api.get_text(f"/repos/{owner}/{name}/actions/jobs/{job_id}/logs")

    async def reply_to_comment(
        self, path: str, number: int, comment_id: str, body: str, *, thread_id: str | None = None
    ) -> str:
        owner, name = _owner_name(path)
        if comment_id.startswith("review:") or not comment_id.isdigit():
            # Review summaries (and anything that is not a line comment) get a PR conversation comment.
            resp = await self.api.request(
                "POST", f"/repos/{owner}/{name}/issues/{number}/comments", json={"body": body}
            )
        else:
            resp = await self.api.request(
                "POST", f"/repos/{owner}/{name}/pulls/{number}/comments/{comment_id}/replies", json={"body": body}
            )
        return str((resp.data or {}).get("id", ""))

    async def resolve_thread(self, path: str, number: int, thread_id: str) -> None:
        await self._graphql(_RESOLVE_MUTATION, {"id": thread_id})
        self._threads.pop((path, number), None)

    # ------------------------------------------------------------------ actions
    async def trigger_pipeline(
        self, path: str, *, ref: str, workflow: str | None, variables: dict[str, str] | None
    ) -> str:
        owner, name = _owner_name(path)
        if not workflow:
            raise ValidationFailed("GitHub Actions için workflow dosyası (ör. deploy.yml) belirtilmeli.")
        workflow = workflow.strip().rsplit("/", 1)[-1]  # ".github/workflows/deploy.yml" -> "deploy.yml"
        wf = quote(workflow, safe="")
        dispatched_at = self._clock()
        resp = await self.api.request(
            "POST",
            f"/repos/{owner}/{name}/actions/workflows/{wf}/dispatches",
            json={"ref": ref, "inputs": variables or {}},
        )
        if isinstance(resp.data, dict) and resp.data.get("workflow_run_id"):
            return str(resp.data["workflow_run_id"])
        run_id = await self._find_dispatched_run(owner, name, wf, ref, dispatched_at)
        return run_id or f"pending:{workflow}:{ref}:{int(dispatched_at.timestamp())}"

    async def _find_dispatched_run(
        self, owner: str, name: str, wf: str, ref: str, since: datetime, attempts: int | None = None
    ) -> str | None:
        branch = ref.removeprefix("refs/heads/")
        params: dict[str, Any] = {"event": "workflow_dispatch", "per_page": 10}
        if not ref.startswith("refs/tags/"):
            params["branch"] = branch
        for attempt in range(self._dispatch_attempts if attempts is None else attempts):
            if attempt:
                await asyncio.sleep(self._dispatch_delay)
            data = await self.api.get(f"/repos/{owner}/{name}/actions/workflows/{wf}/runs", params=params, cache=False)
            for run in (data or {}).get("workflow_runs", []):
                created = parse_dt(run.get("created_at"))
                if created is not None and created >= since - timedelta(seconds=90):
                    return str(run["id"])
        return None

    async def pipeline_status(self, path: str, run_id: str) -> CheckRun:
        owner, name = _owner_name(path)
        if run_id.startswith("pending:"):
            _, workflow, rest = run_id.split(":", 2)
            ref, _, ts = rest.rpartition(":")
            since = datetime.fromtimestamp(int(ts), self._clock().tzinfo) if ts.isdigit() else self._clock()
            found = await self._find_dispatched_run(owner, name, quote(workflow, safe=""), ref, since, attempts=1)
            if found is None:
                return CheckRun(name=workflow, status="queued")
            run_id = found
        if not run_id.isdigit():
            raise ValidationFailed("Geçersiz çalıştırma kimliği.", details={"run_id": run_id})
        run = await self.api.get(f"/repos/{owner}/{name}/actions/runs/{run_id}", cache=False) or {}
        status = _check_status(run.get("status"))
        return CheckRun(
            name=str(run.get("name") or run.get("display_title") or run_id),
            status=status,
            conclusion=_conclusion(run.get("conclusion")) if status == "completed" else None,
            url=run.get("html_url"),
            job_id=None,
        )

    # ------------------------------------------------------------------ issues
    @staticmethod
    def _issue(i: dict[str, Any]) -> Issue:
        return Issue(
            number=int(i["number"]),
            title=i.get("title", ""),
            body=i.get("body") or "",
            state=i.get("state", "open"),
            url=i.get("html_url", ""),
            author=(i.get("user") or {}).get("login"),
            labels=[lb["name"] if isinstance(lb, dict) else str(lb) for lb in i.get("labels", [])],
            comments=int(i.get("comments") or 0),
            created_at=parse_dt(i.get("created_at")),
            updated_at=parse_dt(i.get("updated_at")),
        )

    async def list_issues(self, path: str, *, limit: int = 50) -> list[Issue]:
        owner, name = _owner_name(path)
        items = await self.api.paginate(
            f"/repos/{owner}/{name}/issues",
            params={"state": "open", "per_page": min(100, limit), "sort": "updated"},
            max_pages=max(1, (limit + 99) // 100),
        )
        return [self._issue(i) for i in items if "pull_request" not in i][:limit]

    async def get_issue(self, path: str, number: int) -> Issue:
        owner, name = _owner_name(path)
        data = await self.api.get(f"/repos/{owner}/{name}/issues/{number}") or {}
        if "pull_request" in data:
            raise ValidationFailed(f"#{number} bir PR, issue değil.")
        return self._issue(data)
