"""Persistence for hosts and database profiles. Secrets go to ``ctx.secrets`` only; rows keep a
list of which secret fields exist (``secret_fields``) so listing never touches the Keychain."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

import sqlalchemy as sa

from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.core.eventlog import EventLog
from aistudio.core.events import Severity
from aistudio.core.ids import new_id
from aistudio.remote.models import (
    DbProfileCreate,
    DbProfileRecord,
    DbProfileUpdate,
    HostCreate,
    HostRecord,
    HostUpdate,
)
from aistudio.remote.policy import PatternKind, validate_patterns
from aistudio.remote.tables import remote_db_profiles as db_t
from aistudio.remote.tables import remote_hosts as hosts_t
from aistudio.security.secrets import SecretStore, secret_ref
from aistudio.storage.db import Database

_SECRETISH_OPTION = re.compile(r"(?i)pass|secret|token|credential|private")


def host_secret_ref(host_id: str, field: str) -> str:
    return secret_ref("host", host_id, field)


def db_secret_ref(profile_id: str, field: str) -> str:
    return secret_ref("db", profile_id, field)


def pattern_kind_for_db(kind: str) -> PatternKind:
    if kind == "redis":
        return "redis"
    if kind == "mongodb":
        return "mongodb"
    return "sql"


def _host_from_row(row: Mapping[Any, Any]) -> HostRecord:
    fields = set(row["secret_fields"] or [])
    return HostRecord(
        id=row["id"],
        workspace_id=row["workspace_id"],
        name=row["name"],
        hostname=row["hostname"],
        port=row["port"],
        username=row["username"],
        jump_host_id=row["jump_host_id"],
        auth=row["auth"],
        key_path=row["key_path"],
        environment=Environment(row["environment"]),
        permission_level=PermissionLevel(row["permission_level"]),
        limited_write_patterns=list(row["limited_write_patterns"] or []),
        has_password="password" in fields,
        has_passphrase="passphrase" in fields,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _db_from_row(row: Mapping[Any, Any]) -> DbProfileRecord:
    fields = set(row["secret_fields"] or [])
    return DbProfileRecord(
        id=row["id"],
        workspace_id=row["workspace_id"],
        name=row["name"],
        kind=row["kind"],
        host=row["host"],
        port=row["port"],
        database=row["database"],
        username=row["username"],
        via_host_id=row["via_host_id"],
        options=dict(row["options"] or {}),
        environment=Environment(row["environment"]),
        permission_level=PermissionLevel(row["permission_level"]),
        limited_write_patterns=list(row["limited_write_patterns"] or []),
        has_password="password" in fields,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _patterns(patterns: Sequence[str], kind: PatternKind) -> list[str]:
    try:
        return validate_patterns(patterns, kind)
    except ValueError as e:
        raise ValidationFailed(str(e)) from None


def _check_options(options: Mapping[str, Any]) -> dict[str, Any]:
    for key in options:
        if _SECRETISH_OPTION.search(str(key)):
            raise ValidationFailed(f"Gizli bilgiler seçeneklerde saklanamaz ({key}); parola alanını kullanın.")
    return dict(options)


def _production_defaults_to_read(
    values: dict[str, Any], changes: dict[str, Any], given: set[str], current_level: PermissionLevel
) -> None:
    """Moving a target to production without choosing a level resets it to read (spec §12:
    production defaults to read-only)."""
    if values.get("environment") != Environment.production.value or "permission_level" in values:
        return
    if "permission_level" in given or current_level == PermissionLevel.read:
        return
    values["permission_level"] = PermissionLevel.read.value
    changes["permission_level"] = [current_level.value, PermissionLevel.read.value]


def _severity_for_change(changes: Mapping[str, Any]) -> Severity:
    if "environment" in changes or "permission_level" in changes or "limited_write_patterns" in changes:
        return Severity.high
    return Severity.normal


class RemoteStore:
    def __init__(self, db: Database, events: EventLog, secrets: SecretStore) -> None:
        self._db = db
        self._events = events
        self._secrets = secrets

    # ================================================================== hosts
    async def list_hosts(self, workspace_id: str | None = None) -> list[HostRecord]:
        stmt = sa.select(hosts_t).order_by(hosts_t.c.name)
        if workspace_id is not None:
            stmt = stmt.where(sa.or_(hosts_t.c.workspace_id == workspace_id, hosts_t.c.workspace_id.is_(None)))
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_host_from_row(r) for r in rows]

    async def get_host(self, host_id: str) -> HostRecord:
        async with self._db.connect() as conn:
            row = (await conn.execute(sa.select(hosts_t).where(hosts_t.c.id == host_id))).mappings().first()
        if row is None:
            raise NotFound("Host bulunamadı.", details={"host_id": host_id})
        return _host_from_row(row)

    async def resolve_host(self, ref: str, workspace_id: str | None) -> HostRecord:
        """By id, or by name (case-insensitive) among the workspace's and global hosts."""
        ref = ref.strip()
        hosts = await self.list_hosts(workspace_id)
        for h in hosts:
            if h.id == ref:
                return h
        matches = [h for h in hosts if h.name.casefold() == ref.casefold()]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValidationFailed(f"'{ref}' adında birden fazla host var; id kullanın.")
        available = ", ".join(f"{h.name} ({h.environment.value})" for h in hosts) or "yok"
        raise NotFound(f"Host bulunamadı: {ref}. Kullanılabilir hostlar: {available}")

    async def _name_taken(self, table: sa.Table, name: str, workspace_id: str | None, exclude: str | None) -> bool:
        stmt = sa.select(table.c.id, table.c.name).where(
            sa.or_(table.c.workspace_id == workspace_id, table.c.workspace_id.is_(None))
            if workspace_id is not None
            else sa.true()
        )
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return any(r[1].casefold() == name.casefold() and r[0] != exclude for r in rows)

    async def _check_jump(self, host_id: str | None, jump_host_id: str | None) -> None:
        if jump_host_id is None:
            return
        if jump_host_id == host_id:
            raise ValidationFailed("Bir host kendisinin atlama hostu olamaz.")
        seen: set[str] = set()
        current: str | None = jump_host_id
        while current is not None:
            if current in seen or current == host_id:
                raise ValidationFailed("Atlama hostu zinciri döngü oluşturuyor.")
            seen.add(current)
            try:
                current = (await self.get_host(current)).jump_host_id
            except NotFound:
                raise ValidationFailed("Atlama hostu bulunamadı.") from None
            if len(seen) > 8:
                raise ValidationFailed("Atlama hostu zinciri çok uzun.")

    def _set_secret(self, ref: str, value: str | None, fields: set[str], field: str) -> None:
        if value:
            self._secrets.set(ref, value)
            fields.add(field)
        else:
            self._secrets.delete(ref)
            fields.discard(field)

    async def create_host(self, body: HostCreate, *, actor: str = "user") -> HostRecord:
        if body.auth == "key" and not body.key_path:
            raise ValidationFailed("Anahtar ile kimlik doğrulama için anahtar dosyası yolu gerekli.")
        if body.auth == "password" and body.password is None:
            raise ValidationFailed("Parola ile kimlik doğrulama için parola gerekli.")
        if await self._name_taken(hosts_t, body.name, body.workspace_id, None):
            raise Conflict(f"'{body.name}' adında bir host zaten var.")
        host_id = new_id("host")
        await self._check_jump(host_id, body.jump_host_id)
        patterns = _patterns(body.limited_write_patterns, "shell")
        fields: set[str] = set()
        if body.password is not None:
            self._set_secret(host_secret_ref(host_id, "password"), body.password.get_secret_value(), fields, "password")
        if body.passphrase is not None:
            self._set_secret(
                host_secret_ref(host_id, "passphrase"), body.passphrase.get_secret_value(), fields, "passphrase"
            )
        now = utcnow()
        async with self._db.begin() as conn:
            await conn.execute(
                hosts_t.insert().values(
                    id=host_id,
                    workspace_id=body.workspace_id,
                    name=body.name,
                    hostname=body.hostname,
                    port=body.port,
                    username=body.username,
                    jump_host_id=body.jump_host_id,
                    auth=body.auth,
                    key_path=body.key_path,
                    environment=body.environment.value,
                    permission_level=body.permission_level.value,
                    limited_write_patterns=patterns,
                    secret_fields=sorted(fields),
                    created_at=now,
                    updated_at=now,
                )
            )
        host = await self.get_host(host_id)
        await self._events.append(
            "remote.host.created",
            {
                "host_id": host.id,
                "name": host.name,
                "hostname": host.hostname,
                "port": host.port,
                "environment": host.environment.value,
                "permission_level": host.permission_level.value,
            },
            severity=Severity.normal,
            actor=actor,
            workspace_id=host.workspace_id,
        )
        return host

    async def update_host(self, host_id: str, body: HostUpdate, *, actor: str = "user") -> HostRecord:
        current = await self.get_host(host_id)
        given = body.model_fields_set
        values: dict[str, Any] = {}
        changes: dict[str, Any] = {}
        for name in ("name", "hostname", "port", "username", "auth", "key_path", "jump_host_id"):
            if name in given:
                new = getattr(body, name)
                if new is None and name not in ("key_path", "jump_host_id"):
                    continue
                if new != getattr(current, name):
                    values[name] = new
                    changes[name] = [getattr(current, name), new]
        for name in ("environment", "permission_level"):
            if name in given and getattr(body, name) is not None:
                new_enum = getattr(body, name)
                if new_enum != getattr(current, name):
                    values[name] = new_enum.value
                    changes[name] = [getattr(current, name).value, new_enum.value]
        _production_defaults_to_read(values, changes, given, current.permission_level)
        if "limited_write_patterns" in given and body.limited_write_patterns is not None:
            patterns = _patterns(body.limited_write_patterns, "shell")
            if patterns != current.limited_write_patterns:
                values["limited_write_patterns"] = patterns
                changes["limited_write_patterns"] = [current.limited_write_patterns, patterns]
        if "name" in values and await self._name_taken(hosts_t, values["name"], current.workspace_id, host_id):
            raise Conflict(f"'{values['name']}' adında bir host zaten var.")
        if "jump_host_id" in values:
            await self._check_jump(host_id, values["jump_host_id"])
        auth = values.get("auth", current.auth)
        key_path = values.get("key_path", current.key_path)
        if auth == "key" and not key_path:
            raise ValidationFailed("Anahtar ile kimlik doğrulama için anahtar dosyası yolu gerekli.")
        fields = {f for f, on in (("password", current.has_password), ("passphrase", current.has_passphrase)) if on}
        secrets_changed = False
        if "password" in given:
            value = body.password.get_secret_value() if body.password is not None else None
            self._set_secret(host_secret_ref(host_id, "password"), value, fields, "password")
            secrets_changed = True
            changes["password"] = "değiştirildi" if value else "silindi"
        if "passphrase" in given:
            value = body.passphrase.get_secret_value() if body.passphrase is not None else None
            self._set_secret(host_secret_ref(host_id, "passphrase"), value, fields, "passphrase")
            secrets_changed = True
            changes["passphrase"] = "değiştirildi" if value else "silindi"
        if auth == "password" and "password" not in fields:
            raise ValidationFailed("Parola ile kimlik doğrulama için parola gerekli.")
        if not values and not secrets_changed:
            return current
        values["secret_fields"] = sorted(fields)
        values["updated_at"] = utcnow()
        async with self._db.begin() as conn:
            await conn.execute(hosts_t.update().where(hosts_t.c.id == host_id).values(**values))
        await self._events.append(
            "remote.host.updated",
            {"host_id": host_id, "name": values.get("name", current.name), "changes": changes},
            severity=_severity_for_change(changes),
            actor=actor,
            workspace_id=current.workspace_id,
        )
        return await self.get_host(host_id)

    async def delete_host(self, host_id: str, *, actor: str = "user") -> HostRecord:
        host = await self.get_host(host_id)
        async with self._db.connect() as conn:
            jumpers = (await conn.execute(sa.select(hosts_t.c.name).where(hosts_t.c.jump_host_id == host_id))).all()
            tunnels = (await conn.execute(sa.select(db_t.c.name).where(db_t.c.via_host_id == host_id))).all()
        if jumpers or tunnels:
            names = ", ".join([r[0] for r in jumpers] + [r[0] for r in tunnels])
            raise Conflict(f"Bu host başka kayıtlar tarafından kullanılıyor: {names}")
        async with self._db.begin() as conn:
            await conn.execute(hosts_t.delete().where(hosts_t.c.id == host_id))
        for field in ("password", "passphrase"):
            self._secrets.delete(host_secret_ref(host_id, field))
        await self._events.append(
            "remote.host.deleted",
            {"host_id": host_id, "name": host.name, "environment": host.environment.value},
            severity=Severity.normal,
            actor=actor,
            workspace_id=host.workspace_id,
        )
        return host

    def host_secret(self, host_id: str, field: str) -> str | None:
        return self._secrets.get(host_secret_ref(host_id, field))

    # ================================================================== db profiles
    async def list_db_profiles(self, workspace_id: str | None = None) -> list[DbProfileRecord]:
        stmt = sa.select(db_t).order_by(db_t.c.name)
        if workspace_id is not None:
            stmt = stmt.where(sa.or_(db_t.c.workspace_id == workspace_id, db_t.c.workspace_id.is_(None)))
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_db_from_row(r) for r in rows]

    async def get_db_profile(self, profile_id: str) -> DbProfileRecord:
        async with self._db.connect() as conn:
            row = (await conn.execute(sa.select(db_t).where(db_t.c.id == profile_id))).mappings().first()
        if row is None:
            raise NotFound("Veritabanı profili bulunamadı.", details={"profile_id": profile_id})
        return _db_from_row(row)

    async def resolve_db_profile(self, ref: str, workspace_id: str | None) -> DbProfileRecord:
        ref = ref.strip()
        profiles = await self.list_db_profiles(workspace_id)
        for p in profiles:
            if p.id == ref:
                return p
        matches = [p for p in profiles if p.name.casefold() == ref.casefold()]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValidationFailed(f"'{ref}' adında birden fazla veritabanı profili var; id kullanın.")
        available = ", ".join(f"{p.name} ({p.kind}, {p.environment.value})" for p in profiles) or "yok"
        raise NotFound(f"Veritabanı profili bulunamadı: {ref}. Kullanılabilir profiller: {available}")

    async def _check_via(self, via_host_id: str | None) -> None:
        if via_host_id is not None:
            try:
                await self.get_host(via_host_id)
            except NotFound:
                raise ValidationFailed("Tünel hostu bulunamadı.") from None

    async def create_db_profile(self, body: DbProfileCreate, *, actor: str = "user") -> DbProfileRecord:
        if await self._name_taken(db_t, body.name, body.workspace_id, None):
            raise Conflict(f"'{body.name}' adında bir veritabanı profili zaten var.")
        if body.kind == "sqlite":
            if not body.database:
                raise ValidationFailed("SQLite için dosya yolu (database) gerekli.")
            if body.via_host_id:
                raise ValidationFailed("SQLite yalnız bu Mac'teki dosyalarla çalışır; tünel kullanılamaz.")
        await self._check_via(body.via_host_id)
        patterns = _patterns(body.limited_write_patterns, pattern_kind_for_db(body.kind))
        options = _check_options(body.options)
        profile_id = new_id("dbp")
        fields: set[str] = set()
        if body.password is not None:
            self._set_secret(
                db_secret_ref(profile_id, "password"), body.password.get_secret_value(), fields, "password"
            )
        now = utcnow()
        async with self._db.begin() as conn:
            await conn.execute(
                db_t.insert().values(
                    id=profile_id,
                    workspace_id=body.workspace_id,
                    name=body.name,
                    kind=body.kind,
                    host=body.host,
                    port=body.port,
                    database=body.database,
                    username=body.username,
                    via_host_id=body.via_host_id,
                    options=options,
                    environment=body.environment.value,
                    permission_level=body.permission_level.value,
                    limited_write_patterns=patterns,
                    secret_fields=sorted(fields),
                    created_at=now,
                    updated_at=now,
                )
            )
        profile = await self.get_db_profile(profile_id)
        await self._events.append(
            "remote.db_profile.created",
            {
                "profile_id": profile.id,
                "name": profile.name,
                "kind": profile.kind,
                "environment": profile.environment.value,
                "permission_level": profile.permission_level.value,
            },
            severity=Severity.normal,
            actor=actor,
            workspace_id=profile.workspace_id,
        )
        return profile

    async def update_db_profile(
        self, profile_id: str, body: DbProfileUpdate, *, actor: str = "user"
    ) -> DbProfileRecord:
        current = await self.get_db_profile(profile_id)
        given = body.model_fields_set
        values: dict[str, Any] = {}
        changes: dict[str, Any] = {}
        for name in ("name", "host", "port", "database", "username", "via_host_id"):
            if name in given:
                new = getattr(body, name)
                if new is None and name == "name":
                    continue
                if new != getattr(current, name):
                    values[name] = new
                    changes[name] = [getattr(current, name), new]
        for name in ("environment", "permission_level"):
            if name in given and getattr(body, name) is not None:
                new_enum = getattr(body, name)
                if new_enum != getattr(current, name):
                    values[name] = new_enum.value
                    changes[name] = [getattr(current, name).value, new_enum.value]
        _production_defaults_to_read(values, changes, given, current.permission_level)
        if "options" in given and body.options is not None:
            values["options"] = _check_options(body.options)
            changes["options"] = "değiştirildi"
        if "limited_write_patterns" in given and body.limited_write_patterns is not None:
            patterns = _patterns(body.limited_write_patterns, pattern_kind_for_db(current.kind))
            if patterns != current.limited_write_patterns:
                values["limited_write_patterns"] = patterns
                changes["limited_write_patterns"] = [current.limited_write_patterns, patterns]
        if "name" in values and await self._name_taken(db_t, values["name"], current.workspace_id, profile_id):
            raise Conflict(f"'{values['name']}' adında bir veritabanı profili zaten var.")
        if "via_host_id" in values:
            if current.kind == "sqlite" and values["via_host_id"]:
                raise ValidationFailed("SQLite yalnız bu Mac'teki dosyalarla çalışır; tünel kullanılamaz.")
            await self._check_via(values["via_host_id"])
        fields = {"password"} if current.has_password else set()
        secrets_changed = False
        if "password" in given:
            value = body.password.get_secret_value() if body.password is not None else None
            self._set_secret(db_secret_ref(profile_id, "password"), value, fields, "password")
            secrets_changed = True
            changes["password"] = "değiştirildi" if value else "silindi"
        if not values and not secrets_changed:
            return current
        values["secret_fields"] = sorted(fields)
        values["updated_at"] = utcnow()
        async with self._db.begin() as conn:
            await conn.execute(db_t.update().where(db_t.c.id == profile_id).values(**values))
        await self._events.append(
            "remote.db_profile.updated",
            {"profile_id": profile_id, "name": values.get("name", current.name), "changes": changes},
            severity=_severity_for_change(changes),
            actor=actor,
            workspace_id=current.workspace_id,
        )
        return await self.get_db_profile(profile_id)

    async def delete_db_profile(self, profile_id: str, *, actor: str = "user") -> DbProfileRecord:
        profile = await self.get_db_profile(profile_id)
        async with self._db.begin() as conn:
            await conn.execute(db_t.delete().where(db_t.c.id == profile_id))
        self._secrets.delete(db_secret_ref(profile_id, "password"))
        await self._events.append(
            "remote.db_profile.deleted",
            {"profile_id": profile_id, "name": profile.name, "environment": profile.environment.value},
            severity=Severity.normal,
            actor=actor,
            workspace_id=profile.workspace_id,
        )
        return profile

    def db_password(self, profile_id: str) -> str | None:
        return self._secrets.get(db_secret_ref(profile_id, "password"))
