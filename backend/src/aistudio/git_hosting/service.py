"""GitHub / GitLab integration service (spec §13), registered as ``GitHostingService``.

Accounts hold a personal access token (Keychain). A workspace repo is mapped to an account and a
slug by parsing its ``origin`` URL; the matching client (GitHub REST+GraphQL / GitLab REST v4)
does the work. PR takibi lives in :mod:`aistudio.git_hosting.watcher`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
import sqlalchemy as sa

from aistudio.contracts.engine import FlowEngine, Task, TaskCreate
from aistudio.contracts.git_hosting import CheckRun, HostingKind, PullRequestRef, PullRequestStatus
from aistudio.contracts.workspaces import Repo, WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, StudioError, Unavailable, ValidationFailed
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.git_hosting.client import HostingClient
from aistudio.git_hosting.github import GitHubClient
from aistudio.git_hosting.gitlab import GitLabClient
from aistudio.git_hosting.http import HostingAuthError
from aistudio.git_hosting.logs import clean_log, tail
from aistudio.git_hosting.models import (
    GitAccount,
    GitAccountCreate,
    Issue,
    IssueTaskBody,
    PrSnapshot,
    PullRequestSummary,
    RemoteRepo,
    RepoHostingInfo,
    WatchInfo,
)
from aistudio.git_hosting.remote_url import (
    match_account,
    normalize_api_url,
    parse_remote_url,
    slug_for_account,
    web_host_and_prefix,
)
from aistudio.git_hosting.tables import git_accounts, git_repo_accounts
from aistudio.git_hosting.templates import compose_body, find_template
from aistudio.git_hosting.watcher import PrWatcher
from aistudio.security.secrets import secret_ref

log = logging.getLogger(__name__)

ClientFactory = Callable[[HostingKind, str, str], HostingClient]

SETTINGS_DEFAULTS: dict[str, Any] = {
    "git.poll_active_seconds": 45,  # active PR (pending CI, fix task running, recent activity)
    "git.poll_idle_seconds": 300,
    "git.autofix_max_attempts": 3,  # consecutive CI fix tasks before giving up (pr.autofix_failed)
    "git.ci_settle_seconds": 300,  # act on a failure while other checks still run after this long
    "git.review_settle_seconds": 60,  # wait for a burst of review comments to finish
    "git.log_max_chars": 20000,  # job_log API
    "git.fix_log_chars": 12000,  # per failing job, in a CI fix task prompt
    "git.fix_log_jobs": 3,
    "git.autofix_reply": "Bu geri bildirim {sha} commit'iyle ele alındı. (AI Studio)",
}


@dataclass
class AccountRecord:
    account: GitAccount
    token_ref: str

    @property
    def kind(self) -> HostingKind:
        return self.account.kind

    @property
    def web_url(self) -> str:
        return self.account.web_url


@dataclass
class Resolved:
    repo: Repo
    account: GitAccount
    slug: str
    client: HostingClient
    pinned: bool


class GitHostingServiceImpl:
    def __init__(
        self,
        ctx: AppContext,
        *,
        client_factory: ClientFactory | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._ctx = ctx
        self._clock = clock
        self._transport = transport
        self._factory = client_factory or self._default_factory
        self._clients: dict[str, HostingClient] = {}
        self._client_lock = asyncio.Lock()
        self.watcher = PrWatcher(self, ctx, clock=clock)

    def _default_factory(self, kind: HostingKind, api_url: str, token: str) -> HostingClient:
        if kind == "github":
            return GitHubClient(
                api_url=api_url, token=token, masker=self._ctx.masker, transport=self._transport, clock=self._clock
            )
        return GitLabClient(
            api_url=api_url, token=token, masker=self._ctx.masker, transport=self._transport, clock=self._clock
        )

    async def aclose(self) -> None:
        clients, self._clients = list(self._clients.values()), {}
        for c in clients:
            await c.aclose()

    async def setting(self, key: str) -> Any:
        value = await self._ctx.store.get(key)
        return SETTINGS_DEFAULTS.get(key) if value is None else value

    # ------------------------------------------------------------------ accounts
    @staticmethod
    def _account_from_row(row: Any) -> AccountRecord:
        data = dict(row)
        token_ref = data.pop("token_ref")
        return AccountRecord(account=GitAccount(**data), token_ref=token_ref)

    async def _account_records(self) -> list[AccountRecord]:
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(sa.select(git_accounts).order_by(git_accounts.c.created_at))).mappings().all()
        return [self._account_from_row(r) for r in rows]

    async def _account_record(self, account_id: str) -> AccountRecord:
        async with self._ctx.db.connect() as conn:
            row = (
                (await conn.execute(sa.select(git_accounts).where(git_accounts.c.id == account_id))).mappings().first()
            )
        if row is None:
            raise NotFound("Git hesabı bulunamadı.")
        return self._account_from_row(row)

    async def list_accounts(self) -> list[GitAccount]:
        return [r.account for r in await self._account_records()]

    async def get_account(self, account_id: str) -> GitAccount:
        return (await self._account_record(account_id)).account

    async def _validate_token(self, kind: HostingKind, api_url: str, token: str) -> Any:
        label = "GitHub" if kind == "github" else "GitLab"
        client = self._factory(kind, api_url, token)
        try:
            return await client.current_user()
        except HostingAuthError as e:
            raise ValidationFailed("Belirteç geçersiz veya süresi dolmuş.") from e
        except StudioError as e:
            if e.code == "permission_denied":
                scope = "read:user ve repo" if kind == "github" else "api"
                raise ValidationFailed(f"Belirtecin yetkisi yetersiz ({scope} kapsamı gerekli).") from e
            if e.code == "not_found":
                raise ValidationFailed(f"Sunucu adresi yanlış görünüyor: {label} API'si bulunamadı.") from e
            host = web_host_and_prefix(api_url)[0]
            raise ValidationFailed(f"{label} sunucusuna ulaşılamadı ({host}). Adresi ve bağlantını kontrol et.") from e
        finally:
            await client.aclose()

    async def add_account(self, req: GitAccountCreate) -> GitAccount:
        token = req.token.strip()
        if not token:
            raise ValidationFailed("Erişim belirteci boş olamaz.")
        api_url, web_url = normalize_api_url(req.kind, req.api_url)
        self._ctx.masker.add_secret(token)
        user = await self._validate_token(req.kind, api_url, token)
        if not user.username:
            raise ValidationFailed("Belirteç doğrulandı ama kullanıcı adı alınamadı.")
        async with self._ctx.db.connect() as conn:
            dup = (
                await conn.execute(
                    sa.select(git_accounts.c.id).where(
                        git_accounts.c.api_url == api_url, git_accounts.c.username == user.username
                    )
                )
            ).first()
        if dup:
            raise Conflict("Bu hesap zaten ekli.")
        now = self._clock()
        account_id = new_id("gitacc")
        host = web_host_and_prefix(web_url)[0]
        account = GitAccount(
            id=account_id,
            kind=req.kind,
            name=(req.name or "").strip() or f"{user.username}@{host}",
            api_url=api_url,
            web_url=web_url,
            username=user.username,
            scopes=user.scopes,
            created_at=now,
            updated_at=now,
        )
        ref = secret_ref("git", account_id, "token")
        await asyncio.to_thread(self._ctx.secrets.set, ref, token)
        async with self._ctx.db.begin() as conn:
            await conn.execute(git_accounts.insert().values(**account.model_dump(), token_ref=ref))
        await self._ctx.events.append(
            "git.account_added",
            {"account_id": account_id, "kind": req.kind, "username": user.username, "host": host},
            actor="user",
        )
        return account

    async def verify_account(self, account_id: str) -> GitAccount:
        rec = await self._account_record(account_id)
        token = await self._token(rec)
        user = await self._validate_token(rec.kind, rec.account.api_url, token)
        now = self._clock()
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                git_accounts.update().where(git_accounts.c.id == account_id).values(scopes=user.scopes, updated_at=now)
            )
        return await self.get_account(account_id)

    async def delete_account(self, account_id: str) -> None:
        rec = await self._account_record(account_id)
        async with self._ctx.db.begin() as conn:
            await conn.execute(git_repo_accounts.delete().where(git_repo_accounts.c.account_id == account_id))
            await conn.execute(git_accounts.delete().where(git_accounts.c.id == account_id))
        await asyncio.to_thread(self._ctx.secrets.delete, rec.token_ref)
        client = self._clients.pop(account_id, None)
        if client is not None:
            await client.aclose()
        await self._ctx.events.append(
            "git.account_removed", {"account_id": account_id, "username": rec.account.username}, actor="user"
        )

    async def _token(self, rec: AccountRecord) -> str:
        token = await asyncio.to_thread(self._ctx.secrets.get, rec.token_ref)
        if not token:
            raise Unavailable(
                f"{rec.account.name} hesabının belirteci Anahtar Zinciri'nde bulunamadı. Hesabı yeniden ekle."
            )
        return token

    async def client_for(self, rec: AccountRecord) -> HostingClient:
        async with self._client_lock:
            client = self._clients.get(rec.account.id)
            if client is None:
                client = self._factory(rec.kind, rec.account.api_url, await self._token(rec))
                self._clients[rec.account.id] = client
            return client

    async def account_repos(self, account_id: str, *, limit: int = 200) -> list[RemoteRepo]:
        rec = await self._account_record(account_id)
        return await (await self.client_for(rec)).list_repos(limit=limit)

    # ------------------------------------------------------------------ repo resolution
    async def _pinned_account(self, repo_id: str) -> str | None:
        async with self._ctx.db.connect() as conn:
            row = (
                await conn.execute(
                    sa.select(git_repo_accounts.c.account_id).where(git_repo_accounts.c.repo_id == repo_id)
                )
            ).first()
        return str(row[0]) if row else None

    async def resolve(self, repo_id: str) -> Resolved:
        repo = await self._ctx.services.get(WorkspaceService).get_repo(repo_id)  # type: ignore[type-abstract]
        if not repo.remote_url:
            raise ValidationFailed("Bu reponun uzak (origin) adresi yok; GitHub/GitLab işlemleri yapılamıyor.")
        loc = parse_remote_url(repo.remote_url)
        if loc is None:
            raise ValidationFailed("Reponun uzak adresi çözümlenemedi.", details={"remote_url": repo.remote_url})
        pinned_id = await self._pinned_account(repo_id)
        records = await self._account_records()
        if pinned_id is not None:
            rec = next((r for r in records if r.account.id == pinned_id), None)
            slug = slug_for_account(loc, rec) if rec is not None else None
            if rec is None or slug is None:
                raise ValidationFailed("Bu repo için seçilen hesap reponun sunucusuyla eşleşmiyor.")
            return Resolved(repo, rec.account, slug, await self.client_for(rec), True)
        match = match_account(loc, records)
        if match is None:
            raise NotFound(
                f"{loc.host} için bağlı bir GitHub/GitLab hesabı yok. Ayarlar → Git hesapları bölümünden ekle.",
                details={"host": loc.host},
            )
        rec, slug = match
        return Resolved(repo, rec.account, slug, await self.client_for(rec), False)

    async def repo_info(self, repo_id: str) -> RepoHostingInfo:
        r = await self.resolve(repo_id)
        return RepoHostingInfo(
            repo_id=repo_id,
            account_id=r.account.id,
            account_name=r.account.name,
            kind=r.account.kind,
            host=web_host_and_prefix(r.account.web_url)[0],
            slug=r.slug,
            web_url=f"{r.account.web_url}/{r.slug}",
            pinned=r.pinned,
        )

    async def pin_account(self, repo_id: str, account_id: str | None) -> RepoHostingInfo:
        await self._ctx.services.get(WorkspaceService).get_repo(repo_id)  # type: ignore[type-abstract]
        async with self._ctx.db.begin() as conn:
            await conn.execute(git_repo_accounts.delete().where(git_repo_accounts.c.repo_id == repo_id))
            if account_id is not None:
                await self._account_record(account_id)
                await conn.execute(git_repo_accounts.insert().values(repo_id=repo_id, account_id=account_id))
        return await self.repo_info(repo_id)

    # ------------------------------------------------------------------ pull requests
    async def _template(self, repo: Repo, kind: HostingKind) -> str | None:
        if repo.host_id is not None:  # checkout lives on a remote host
            return None
        return await asyncio.to_thread(find_template, repo.path, kind)

    async def open_pull_request(
        self, repo_id: str, *, head: str, base: str, title: str, body: str, draft: bool = False
    ) -> PullRequestRef:
        r = await self.resolve(repo_id)
        if not title.strip():
            raise ValidationFailed("PR başlığı boş olamaz.")
        template = await self._template(r.repo, r.account.kind)
        final_body = self._ctx.masker.mask(compose_body(template, body))
        info = await r.client.open_pr(
            r.slug,
            head=head,
            base=base or r.repo.default_branch,
            title=self._ctx.masker.mask(title.strip()),
            body=final_body,
            draft=draft,
        )
        ref = PullRequestRef(
            repo_id=repo_id,
            number=info.number,
            url=info.url,
            title=info.title,
            head=info.head,
            base=info.base,
            draft=info.draft,
        )
        await self._ctx.events.append(
            "pr.opened",
            {
                "repo_id": repo_id,
                "number": ref.number,
                "url": ref.url,
                "title": ref.title,
                "head": ref.head,
                "base": ref.base,
                "draft": ref.draft,
                "template_used": template is not None,
            },
            workspace_id=r.repo.workspace_id,
        )
        return ref

    async def list_pulls(self, repo_id: str, *, limit: int = 50) -> list[PullRequestSummary]:
        r = await self.resolve(repo_id)
        return await r.client.list_prs(r.slug, limit=limit)

    async def snapshot(self, repo_id: str, number: int) -> PrSnapshot:
        r = await self.resolve(repo_id)
        return await r.client.pr_snapshot(r.slug, number, repo_id=repo_id)

    async def pr_status(self, repo_id: str, number: int) -> PullRequestStatus:
        return (await self.snapshot(repo_id, number)).status

    async def watch(self, repo_id: str, number: int, *, task_id: str | None, autofix: bool = True) -> None:
        await self.watcher.watch(repo_id, number, task_id=task_id, autofix=autofix)

    async def unwatch(self, repo_id: str, number: int) -> None:
        await self.watcher.unwatch(repo_id, number)

    async def list_watches(self, *, active_only: bool = False) -> list[WatchInfo]:
        return await self.watcher.list(active_only=active_only)

    async def job_log(self, repo_id: str, job_id: str, *, max_chars: int | None = None) -> str:
        r = await self.resolve(repo_id)
        raw = await r.client.job_log(r.slug, job_id)
        limit = int(max_chars or await self.setting("git.log_max_chars"))
        text = tail(clean_log(raw), limit * 2)
        return tail(self._ctx.masker.mask(text), limit)

    async def post_reply(self, r: Resolved, number: int, comment_id: str, body: str, thread_id: str | None) -> str:
        """Reply without touching watch state (used by the watcher inside a poll)."""
        text = self._ctx.masker.mask(body.strip())
        if not text:
            raise ValidationFailed("Yanıt boş olamaz.")
        return await r.client.reply_to_comment(r.slug, number, comment_id, text, thread_id=thread_id)

    async def reply_to_comment(
        self,
        repo_id: str,
        number: int,
        comment_id: str,
        body: str,
        *,
        thread_id: str | None = None,
        by_agent: bool = False,
    ) -> str:
        r = await self.resolve(repo_id)
        created = await self.post_reply(r, number, comment_id, body, thread_id)
        await self.watcher.note_reply(repo_id, number, replied_to=comment_id, own_comment_id=created, by_agent=by_agent)
        return created

    async def resolve_thread(self, repo_id: str, number: int, thread_id: str) -> None:
        r = await self.resolve(repo_id)
        await r.client.resolve_thread(r.slug, number, thread_id)

    # ------------------------------------------------------------------ pipelines
    async def trigger_pipeline(
        self, repo_id: str, *, ref: str, workflow: str | None = None, variables: dict[str, str] | None = None
    ) -> str:
        r = await self.resolve(repo_id)
        if not ref.strip():
            raise ValidationFailed("Pipeline için branch veya etiket belirtilmeli.")
        run_id = await r.client.trigger_pipeline(r.slug, ref=ref.strip(), workflow=workflow, variables=variables)
        await self._ctx.events.append(
            "git.pipeline_triggered",
            {
                "repo_id": repo_id,
                "ref": ref,
                "workflow": workflow,
                "run_id": run_id,
                "variables": sorted(variables or {}),
            },
            workspace_id=r.repo.workspace_id,
        )
        return run_id

    async def pipeline_status(self, repo_id: str, run_id: str) -> CheckRun:
        r = await self.resolve(repo_id)
        return await r.client.pipeline_status(r.slug, run_id)

    # ------------------------------------------------------------------ issues
    async def list_issues(self, repo_id: str, *, limit: int = 50) -> list[Issue]:
        r = await self.resolve(repo_id)
        return await r.client.list_issues(r.slug, limit=limit)

    async def issue_to_task(self, repo_id: str, number: int, body: IssueTaskBody | None = None) -> Task:
        body = body or IssueTaskBody()
        r = await self.resolve(repo_id)
        issue = await r.client.get_issue(r.slug, number)
        engine = self._ctx.services.get(FlowEngine)  # type: ignore[type-abstract]
        mask = self._ctx.masker.mask
        kind_label = "GitHub issue" if r.account.kind == "github" else "GitLab issue"
        labels = f"\nEtiketler: {', '.join(issue.labels)}" if issue.labels else ""
        prompt = (
            f"{kind_label} #{issue.number}: {issue.title}\n{issue.url}{labels}\n\n"
            f"{truncate(issue.body.strip(), 20000) or '(açıklama yok)'}\n\n"
            "Görev: bu issue'da istenen işi yap. Belirsiz bir nokta varsa varsayımını açıkça yaz."
        )
        req = TaskCreate(
            workspace_id=r.repo.workspace_id,
            title=mask(f"#{issue.number} {issue.title}"),
            prompt=mask(prompt),
            studio_id=body.studio_id,
            repo_ids=[repo_id],
            base_ref=body.base_ref,
            inputs={"issue_number": issue.number, "issue_url": issue.url, "issue_title": mask(issue.title)},
            source="issue",
            source_ref={"repo_id": repo_id, "issue": issue.number, "url": issue.url},
            start=body.start,
        )
        if body.mode is not None:
            req.mode = body.mode
        task = await engine.create_task(req)
        await self._ctx.events.append(
            "git.issue_task_created",
            {"repo_id": repo_id, "issue": issue.number, "url": issue.url, "title": issue.title, "task_id": task.id},
            workspace_id=r.repo.workspace_id,
            task_id=task.id,
            actor="user",
        )
        return task
