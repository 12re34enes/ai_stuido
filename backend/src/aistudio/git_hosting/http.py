"""HTTP layer shared by the GitHub and GitLab clients.

* **Conditional requests**: GET responses carrying an ``ETag`` are cached (LRU) and revalidated
  with ``If-None-Match``. A ``304`` returns the cached body; on GitHub these are free against
  the rate limit, which is what makes frequent PR polling cheap.
* **Rate-limit awareness**: ``x-ratelimit-*`` / ``ratelimit-*`` headers are tracked; primary
  limit exhaustion, ``Retry-After`` and GitHub's secondary limits put the client into a
  backoff window during which calls fail fast with :class:`RateLimited` (the watcher
  reschedules instead of hammering the API).
* **Errors**: HTTP failures become ``StudioError`` subclasses with Turkish messages.
"""

from __future__ import annotations

import json as jsonlib
import re
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx

from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, PermissionDenied, StudioError, Unavailable, ValidationFailed
from aistudio.security.masking import Masker

_LINK_NEXT = re.compile(r'<([^>]+)>\s*;\s*rel="?next"?')
_MAX_SECONDARY_BACKOFF = 15 * 60.0


class RateLimited(Unavailable):
    code = "rate_limited"

    def __init__(self, message: str, *, retry_at: datetime) -> None:
        super().__init__(message, details={"retry_at": retry_at.isoformat()})
        self.retry_at = retry_at


class HostingAuthError(Unavailable):
    """The token was rejected (HTTP 401)."""

    code = "hosting_auth"


@dataclass
class ApiResponse:
    status: int
    data: Any
    headers: httpx.Headers
    not_modified: bool = False
    next_url: str | None = None


@dataclass
class _Cached:
    etag: str
    data: Any
    next_url: str | None


def _next_link(header: str | None) -> str | None:
    if not header:
        return None
    for part in header.split(","):
        m = _LINK_NEXT.search(part)
        if m:
            return m.group(1)
    return None


def _error_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:300]
    if isinstance(body, dict):
        msg = body.get("message") or body.get("error_description") or body.get("error") or ""
        if isinstance(msg, dict | list):
            msg = jsonlib.dumps(msg, ensure_ascii=False)
        errors = body.get("errors")
        if isinstance(errors, list) and errors:
            details = [
                str(e.get("message") or e.get("code") or e) if isinstance(e, dict) else str(e) for e in errors[:3]
            ]
            msg = f"{msg} ({'; '.join(details)})" if msg else "; ".join(details)
        return str(msg)[:500]
    return str(body)[:300]


class ApiClient:
    def __init__(
        self,
        *,
        base_url: str,
        headers: Mapping[str, str],
        label: str,
        masker: Masker,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = utcnow,
        cache_size: int = 512,
        timeout: float = 20.0,
    ) -> None:
        self.label = label
        self.base_url = base_url.rstrip("/")
        self._masker = masker
        self._clock = clock
        self._http = httpx.AsyncClient(
            base_url=self.base_url + "/",
            headers=dict(headers),
            timeout=httpx.Timeout(timeout, connect=10.0),
            follow_redirects=True,
            transport=transport,
        )
        self._cache: OrderedDict[str, _Cached] = OrderedDict()
        self._cache_size = cache_size
        self._secondary_backoff = 60.0
        self.blocked_until: datetime | None = None
        self.rate_remaining: int | None = None
        self.rate_reset: datetime | None = None
        self.requests = 0
        self.not_modified = 0

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------ rate limits
    def _ensure_not_blocked(self) -> None:
        if self.blocked_until is not None:
            now = self._clock()
            if now < self.blocked_until:
                wait = int((self.blocked_until - now).total_seconds()) + 1
                raise RateLimited(
                    f"{self.label} istek sınırına ulaşıldı; {wait} sn sonra yeniden denenecek.",
                    retry_at=self.blocked_until,
                )
            self.blocked_until = None

    def _note_rate(self, resp: httpx.Response) -> bool:
        """Track rate-limit headers. Returns True if this response is a rate-limit rejection."""
        h = resp.headers
        remaining = h.get("x-ratelimit-remaining") or h.get("ratelimit-remaining")
        reset = h.get("x-ratelimit-reset") or h.get("ratelimit-reset")
        if remaining is not None and remaining.strip().isdigit():
            self.rate_remaining = int(remaining)
        if reset is not None and reset.strip().isdigit():
            self.rate_reset = datetime.fromtimestamp(int(reset), UTC)
        now = self._clock()
        limited = False
        if resp.status_code in (403, 429):
            retry_after = h.get("retry-after")
            text = resp.text.lower() if resp.status_code == 403 else ""
            if retry_after and retry_after.strip().isdigit():
                self.blocked_until = now + timedelta(seconds=int(retry_after))
                limited = True
            elif self.rate_remaining == 0 and self.rate_reset is not None:
                self.blocked_until = max(self.rate_reset, now + timedelta(seconds=1))
                limited = True
            elif resp.status_code == 429 or "rate limit" in text:
                # Secondary limit without a hint: exponential backoff.
                self.blocked_until = now + timedelta(seconds=self._secondary_backoff)
                self._secondary_backoff = min(self._secondary_backoff * 2, _MAX_SECONDARY_BACKOFF)
                limited = True
        elif resp.is_success or resp.status_code == 304:
            self._secondary_backoff = 60.0
            if self.rate_remaining == 0 and self.rate_reset is not None and self.rate_reset > now:
                # Proactive: the next call would be rejected anyway.
                self.blocked_until = self.rate_reset
        return limited

    # ------------------------------------------------------------------ requests
    def _cache_key(self, url: str, params: Mapping[str, Any] | None) -> str:
        query = urlencode(sorted((k, str(v)) for k, v in (params or {}).items()))
        return f"{url}?{query}"

    def _error(self, resp: httpx.Response, *, limited: bool) -> StudioError:
        msg = self._masker.mask(_error_message(resp))
        code = resp.status_code
        label = self.label
        if limited and self.blocked_until is not None:
            wait = max(1, int((self.blocked_until - self._clock()).total_seconds()))
            return RateLimited(
                f"{label} istek sınırına ulaşıldı; {wait} sn sonra yeniden denenecek.", retry_at=self.blocked_until
            )
        if code == 401:
            return HostingAuthError(f"{label} belirteci geçersiz veya süresi dolmuş. Hesabı yeniden bağla.")
        if code == 403:
            return PermissionDenied(
                f"{label} bu işleme izin vermedi. Belirtecin kapsamlarını ve repo erişimini kontrol et.",
                details={"message": msg},
            )
        if code == 404:
            return NotFound(
                f"{label} kaynağı bulunamadı. Repo, PR veya işin var olduğundan ve belirtecin erişimi "
                "olduğundan emin ol.",
                details={"message": msg},
            )
        if code == 409:
            return Conflict(f"{label} isteği çakışma nedeniyle reddetti: {msg}", details={"message": msg})
        if code in (400, 422):
            return ValidationFailed(f"{label} isteği reddetti: {msg}", details={"message": msg})
        if code >= 500:
            return Unavailable(f"{label} şu anda yanıt vermiyor (HTTP {code}). Biraz sonra yeniden dene.")
        return Unavailable(f"{label} beklenmeyen bir yanıt verdi (HTTP {code}).", details={"message": msg})

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        headers: Mapping[str, str] | None = None,
        cache: bool = False,
        parse: str = "json",
    ) -> ApiResponse:
        self._ensure_not_blocked()
        key = self._cache_key(url, params) if cache and method == "GET" else None
        cached = self._cache.get(key) if key is not None else None
        hdrs = dict(headers or {})
        if cached is not None:
            hdrs["If-None-Match"] = cached.etag
        try:
            resp = await self._http.request(method, url, params=params, json=json, headers=hdrs)
        except httpx.TimeoutException as e:
            raise Unavailable(f"{self.label} isteği zaman aşımına uğradı.") from e
        except httpx.TransportError as e:
            raise Unavailable(f"{self.label} sunucusuna ulaşılamadı.") from e
        self.requests += 1
        limited = self._note_rate(resp)
        if resp.status_code == 304 and cached is not None and key is not None:
            self._cache.move_to_end(key)
            self.not_modified += 1
            return ApiResponse(304, cached.data, resp.headers, not_modified=True, next_url=cached.next_url)
        if not resp.is_success:
            raise self._error(resp, limited=limited)
        if parse == "text":
            data: Any = resp.text
        elif not resp.content:
            data = None
        else:
            try:
                data = resp.json()
            except ValueError as e:
                raise Unavailable(f"{self.label} geçersiz bir yanıt döndürdü.") from e
        next_url = _next_link(resp.headers.get("link"))
        etag = resp.headers.get("etag")
        if key is not None and etag:
            self._cache[key] = _Cached(etag=etag, data=data, next_url=next_url)
            self._cache.move_to_end(key)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return ApiResponse(resp.status_code, data, resp.headers, next_url=next_url)

    async def get(self, url: str, *, params: Mapping[str, Any] | None = None, cache: bool = True) -> Any:
        return (await self.request("GET", url, params=params, cache=cache)).data

    async def get_text(self, url: str, *, params: Mapping[str, Any] | None = None) -> str:
        return str((await self.request("GET", url, params=params, parse="text")).data or "")

    async def paginate(
        self,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        item_key: str | None = None,
        max_pages: int = 5,
        limit: int | None = None,
        cache: bool = True,
    ) -> list[Any]:
        items: list[Any] = []
        next_url: str | None = url
        next_params: Mapping[str, Any] | None = params
        pages = 0
        while next_url and pages < max_pages:
            resp = await self.request("GET", next_url, params=next_params, cache=cache)
            data = resp.data
            page = data.get(item_key, []) if item_key and isinstance(data, dict) else data
            if isinstance(page, list):
                items.extend(page)
            pages += 1
            if limit is not None and len(items) >= limit:
                return items[:limit]
            next_url, next_params = resp.next_url, None  # next links carry their own query
        return items
