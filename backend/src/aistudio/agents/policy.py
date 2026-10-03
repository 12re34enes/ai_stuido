"""Permission policy engine (spec §8, layer 2).

``evaluate(request, context)`` decides each agent :class:`PermissionRequest` without any I/O:

* **deny** - direct remote access (ssh, psql, kubectl exec, docker -H ...), ``denied_commands``,
  forbidden paths (gitignore-style globs relative to the session cwd / workspace roots, plus
  protected system paths such as ``~/.ssh``), writes to read-only paths, writes outside
  cwd + ``extra_dirs`` (path traversal), any change by an advisor or in a read-only sandbox,
  network tools when network access is off.
* **allow** - reads inside the workspace, writes inside cwd/extra dirs for writer roles,
  ``allowed_commands``, the repo's own test/lint commands and a conservative safe list
  (``git status``, ``ls``, ``rg`` ... without dangerous options).
* **ask** - everything else; the caller turns this into an approval.

Compound shell commands are fully analysed (see :mod:`aistudio.agents.shell`): every command
in ``a && b; c | d``, subshells, substitutions, ``sudo``/``env``/``bash -c``/``xargs`` wrappers
must pass. ``cd`` is followed so relative paths resolve against the right directory.

Command patterns (``allowed_commands``, ``denied_commands``, the safe list) match either as a
word prefix (``"git push"`` matches ``git push origin main``), as a glob over the whole command
when they contain ``* ? [`` (``"rm -rf *"``), or in Claude's ``Bash(npm run test:*)`` form.
"""

from __future__ import annotations

import contextlib
import fnmatch
import os
import re
import shlex
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Literal

from aistudio.agents.roles import ROLE_LABELS
from aistudio.agents.shell import Command, ShellAnalysis, analyze
from aistudio.contracts.agents import AgentRole, Boundaries, PermissionRequest, SandboxLevel, ToolKind

Verdict = Literal["allow", "deny", "ask"]

REMOTE_ACCESS_MESSAGE = "Uzak sistemlere yalnız remote_exec ve db_query araçlarıyla erişebilirsin."

DEFAULT_SAFE_COMMANDS: tuple[str, ...] = (
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git rev-parse",
    "git ls-files",
    "git blame",
    "git grep",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "rg",
    "grep",
    "find",
    "pwd",
    "echo",
    "which",
    "diff",
    "stat",
    "tree",
    "cd",
    "true",
)

WRITER_ROLES: frozenset[str] = frozenset({"writer", "tester"})
READ_ONLY_ROLES: frozenset[str] = frozenset({"advisor"})

REMOTE_COMMANDS: frozenset[str] = frozenset(
    {
        "ssh",
        "scp",
        "sftp",
        "rsync",
        "mosh",
        "telnet",
        "psql",
        "mysql",
        "mariadb",
        "mongo",
        "mongosh",
        "redis-cli",
        "valkey-cli",
        "keydb-cli",
        "sqlcmd",
        "ssh-copy-id",
        "sshpass",
        "autossh",
        "sshfs",
        "ftp",
        "lftp",
        "rlogin",
        "rsh",
        "rcp",
        "pgcli",
        "mycli",
        "usql",
        "cqlsh",
        "clickhouse-client",
        "mysqlsh",
        "pg_dump",
        "pg_dumpall",
        "pg_restore",
        "mysqldump",
        "mongodump",
        "mongorestore",
        "mongoexport",
        "mongoimport",
    }
)
NETWORK_COMMANDS: frozenset[str] = frozenset(
    {"curl", "wget", "http", "https", "xh", "httpie", "nc", "ncat", "netcat", "socat", "aria2c", "ping"}
)
_REMOTE_ENV_VARS = frozenset({"DOCKER_HOST", "CONTAINER_HOST", "DOCKER_CONTEXT", "GIT_SSH_COMMAND"})
_KUBE_REMOTE_VERBS = frozenset({"exec", "port-forward", "attach", "cp", "debug", "proxy", "rsh", "rsync"})
_KUBE_VALUE_OPTS = frozenset(
    {"-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-s", "--server", "--user", "--token"}
)
_DOCKER_REMOTE_OPTS = frozenset({"-H", "--host", "-c", "--context", "--url", "--remote", "-r", "--connection"})

_MUTATING_COMMANDS: frozenset[str] = frozenset(
    {
        "rm",
        "rmdir",
        "unlink",
        "shred",
        "touch",
        "mkdir",
        "tee",
        "truncate",
        "chmod",
        "chown",
        "chgrp",
        "ln",
        "mv",
        "cp",
        "install",
        "dd",
        "patch",
        "mkfifo",
        "mknod",
        "kill",
        "killall",
        "pkill",
        "launchctl",
        "crontab",
        "defaults",
        "brew",
        "apt",
        "apt-get",
        "yum",
        "dnf",
        "port",
    }
)
_GIT_MUTATING: frozenset[str] = frozenset(
    {
        "add",
        "am",
        "apply",
        "checkout",
        "cherry-pick",
        "clean",
        "clone",
        "commit",
        "fetch",
        "gc",
        "init",
        "merge",
        "mv",
        "prune",
        "pull",
        "push",
        "rebase",
        "reset",
        "restore",
        "revert",
        "rm",
        "switch",
        "tag",
        "worktree",
        "stash",
        "submodule",
        "update-index",
        "update-ref",
        "notes",
        "replace",
        "filter-branch",
        "config",
        "remote",
        "branch",
    }
)
_PKG_MANAGERS = frozenset(
    {"npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go", "gem", "bundle", "composer", "pipx"}
)
_PKG_MUTATING_SUBS = frozenset(
    {
        "install",
        "i",
        "ci",
        "add",
        "remove",
        "rm",
        "uninstall",
        "update",
        "upgrade",
        "up",
        "link",
        "unlink",
        "publish",
        "init",
        "sync",
        "lock",
        "tidy",
        "get",
        "prune",
        "dedupe",
    }
)
_ALL_PATHS_WRITTEN = frozenset({"rm", "rmdir", "unlink", "shred", "touch", "mkdir", "tee", "truncate", "mv"})
_FIND_DANGEROUS = frozenset(
    {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"}
)
_GIT_BRANCH_LIST_FLAGS = frozenset(
    {
        "-a",
        "--all",
        "-r",
        "--remotes",
        "-v",
        "-vv",
        "--verbose",
        "--list",
        "-l",
        "--show-current",
        "--no-color",
        "--color",
        "--no-column",
        "--column",
        "-i",
        "--ignore-case",
        "--omit-empty",
    }
)
_GIT_BRANCH_VALUE_FLAGS = frozenset(
    {"--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--abbrev"}
)
_CONTENT_READERS = frozenset({"cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ack", "diff"})
_NON_PATH_ARGS = frozenset({"echo", "pwd", "which", "true"})  # arguments are never opened as files
_PATH_INPUT_KEYS = ("file_path", "filePath", "path", "notebook_path", "target_file", "filename")


# --------------------------------------------------------------------------- results / context


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    verdict: Verdict
    reason: str  # Turkish, shown to the user / returned to the agent
    rule: str  # machine-readable rule id

    @property
    def allowed(self) -> bool:
        return self.verdict == "allow"

    @property
    def denied(self) -> bool:
        return self.verdict == "deny"


def _allow(reason: str, rule: str) -> PolicyDecision:
    return PolicyDecision("allow", reason, rule)


def _deny(reason: str, rule: str) -> PolicyDecision:
    return PolicyDecision("deny", reason, rule)


def _ask(reason: str, rule: str) -> PolicyDecision:
    return PolicyDecision("ask", reason, rule)


@dataclass(frozen=True, slots=True)
class PolicyContext:
    role: AgentRole
    cwd: str
    boundaries: Boundaries = field(default_factory=Boundaries)
    extra_dirs: tuple[str, ...] = ()
    read_roots: tuple[str, ...] = ()  # further readable roots (other workspace repos)
    safe_commands: tuple[str, ...] = DEFAULT_SAFE_COMMANDS
    project_commands: tuple[str, ...] = ()  # the repo's own test/lint/build commands
    home: str | None = None  # home directory on the session's host (for ``~``)
    protected_forbidden: tuple[str, ...] = ()  # absolute paths, never read or written
    protected_readonly: tuple[str, ...] = ()  # absolute paths, never written
    auto_allow_web: bool = False
    realpath: Callable[[str], str] | None = None  # resolve symlinks (local sessions only)


# --------------------------------------------------------------------------- path patterns


def _glob_regex(pat: str) -> str:
    out: list[str] = []
    i, n = 0, len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if pat.startswith("**/", i):
                out.append("(?:.*/)?")
                i += 3
                continue
            if pat.startswith("**", i):
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "[":
            j = pat.find("]", i + 2 if pat.startswith(("[!", "[^", "[]"), i) else i + 1)
            if j < 0:
                out.append(re.escape(c))
            else:
                inner = pat[i + 1 : j]
                if inner.startswith("!"):
                    inner = "^" + inner[1:]
                out.append("[" + inner.replace("\\", "\\\\") + "]")
                i = j + 1
                continue
        elif c == "\\" and i + 1 < n:
            out.append(re.escape(pat[i + 1]))
            i += 2
            continue
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


class PathPatterns:
    """Gitignore-style matcher. A pattern without ``/`` matches a name at any depth; with a
    ``/`` it is anchored to the root; ``**`` spans directories; a trailing ``/`` is accepted;
    ``!pattern`` re-includes; matching a directory also matches everything below it.
    Patterns starting with ``~/`` are absolute (relative to the host's home directory)."""

    def __init__(self, patterns: Iterable[str], *, home: str | None = None) -> None:
        self._rules: list[tuple[re.Pattern[str], bool, bool]] = []  # (regex, negate, absolute)
        for raw in patterns:
            p = raw.strip()
            if not p or p.startswith("#"):
                continue
            negate = p.startswith("!")
            if negate:
                p = p[1:].strip()
            absolute = False
            if p == "~" or p.startswith("~/"):
                if home is None:
                    continue
                p = home.rstrip("/") + p[1:]
                absolute = True
            if len(p) > 1:
                p = p.rstrip("/")
            body = p.lstrip("/")
            if not body:
                continue
            anchored = absolute or "/" in p
            prefix = "" if anchored else "(?:.*/)?"
            self._rules.append((re.compile(f"^{prefix}{_glob_regex(body)}(?:/.*)?$", re.S), negate, absolute))

    def __bool__(self) -> bool:
        return bool(self._rules)

    def matches(self, relative_candidates: Sequence[str], absolute: str) -> bool:
        result = False
        abs_rel = absolute.lstrip("/")
        for rx, negate, is_abs in self._rules:
            targets = (abs_rel,) if is_abs else relative_candidates
            if any(rx.match(t) for t in targets):
                result = not negate
        return result


def _inside(path: str, roots: Iterable[str]) -> bool:
    for r in roots:
        base = r.rstrip("/")
        if path in (r, base) or path.startswith(base + "/"):
            return True
    return False


class _Env:
    """Resolved roots and matchers for one evaluation."""

    def __init__(self, pctx: PolicyContext) -> None:
        self.pctx = pctx
        self.home = (pctx.home or os.path.expanduser("~")).rstrip("/") or "/"
        self.cwd = self.norm(pctx.cwd, "/")
        self.write_roots = [self.cwd, *(self.norm(d, self.cwd) for d in pctx.extra_dirs)]
        self.read_roots = [*self.write_roots, *(self.norm(r, self.cwd) for r in pctx.read_roots)]
        self.forbidden = PathPatterns(pctx.boundaries.forbidden_paths, home=self.home)
        self.readonly = PathPatterns(pctx.boundaries.readonly_paths, home=self.home)
        self.protected_forbidden = [self.norm(p, "/") for p in pctx.protected_forbidden]
        self.protected_readonly = [self.norm(p, "/") for p in pctx.protected_readonly]
        role = pctx.role
        self.read_only_reason: str | None = None
        if role in READ_ONLY_ROLES:
            self.read_only_reason = "Danışman rolü salt okunurdur; dosya veya sistem değişikliği yapamaz."
        elif pctx.boundaries.sandbox == SandboxLevel.read_only:
            self.read_only_reason = "Bu oturum salt okunur modda; değişiklik yapamaz."

    def norm(self, path: str, base: str | None = None) -> str:
        p = path
        if p == "~" or p.startswith("~/"):
            p = self.home + p[1:]
        if not os.path.isabs(p):
            p = os.path.join(base if base is not None else self.cwd, p)
        p = os.path.normpath(p)
        if self.pctx.realpath is not None:
            with contextlib.suppress(OSError, ValueError):
                p = self.pctx.realpath(p)
        return p

    def display(self, path: str) -> str:
        if _inside(path, [self.cwd]) and path != self.cwd:
            return os.path.relpath(path, self.cwd)
        if path.startswith(self.home + "/"):
            return "~" + path[len(self.home) :]
        return path

    def _relative(self, path: str) -> list[str]:
        rels = [os.path.relpath(path, r) for r in self.read_roots if _inside(path, [r])]
        return rels or [path.lstrip("/")]

    def is_forbidden(self, path: str) -> bool:
        if _inside(path, self.protected_forbidden):
            return True
        return bool(self.forbidden) and self.forbidden.matches(self._relative(path), path)

    def is_readonly(self, path: str) -> bool:
        if _inside(path, self.protected_readonly):
            return True
        return bool(self.readonly) and self.readonly.matches(self._relative(path), path)

    def can_write(self, path: str) -> bool:
        return _inside(path, self.write_roots)

    def can_read(self, path: str) -> bool:
        return _inside(path, self.read_roots)


# --------------------------------------------------------------------------- command helpers


PatternKind = Literal["words", "prefix", "glob"]


def parse_pattern(pattern: str) -> tuple[str, PatternKind]:
    """``Bash(npm run test:*)`` -> ("npm run test", "prefix"); ``rm -rf *`` -> glob; else words."""
    p = pattern.strip()
    m = re.fullmatch(r"Bash\((.*)\)", p, re.S)
    if m:
        p = m.group(1).strip()
    if p.endswith(":*"):
        return p[:-2].rstrip(), "prefix"
    if any(ch in p for ch in "*?["):
        return p, "glob"
    return p, "words"


def command_matches(pattern: str, cmd: Command) -> bool:
    """Word-prefix match; string prefix for ``...:*``; glob over the whole command for globs."""
    p, kind = parse_pattern(pattern)
    if not p or not cmd.argv:
        return False
    if kind == "glob":
        return fnmatch.fnmatchcase(cmd.text(), p)
    if kind == "prefix":
        return cmd.text().startswith(p)
    try:
        pwords = shlex.split(p)
    except ValueError:
        pwords = p.split()
    if not pwords:
        return False
    pwords[0] = os.path.basename(pwords[0])
    words = [cmd.name, *cmd.args]
    return words[: len(pwords)] == pwords


def _first_kube_verb(cmd: Command) -> str | None:
    args = cmd.args
    i = 0
    while i < len(args):
        a = args[i]
        if a in _KUBE_VALUE_OPTS:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        return a
    return None


def _global_args(cmd: Command) -> list[str]:
    """Options before the first positional (docker/podman global flags)."""
    out: list[str] = []
    for a in cmd.args:
        if not a.startswith("-"):
            break
        out.append(a)
    return out


def is_remote_command(cmd: Command) -> bool:
    """Direct access to another machine or database (must go through Studio tools)."""
    if any(k in _REMOTE_ENV_VARS for k in cmd.assignments):
        return True
    name = cmd.name
    if name in REMOTE_COMMANDS:
        return True
    pos = cmd.positionals()
    if name in ("kubectl", "oc", "kubecolor"):
        return _first_kube_verb(cmd) in _KUBE_REMOTE_VERBS
    if name in ("docker", "podman", "nerdctl", "docker-compose"):
        for a in _global_args(cmd):
            if a in _DOCKER_REMOTE_OPTS or a.startswith(("--host=", "--context=", "--url=", "--connection=")):
                return True
            if a.startswith("-H") and len(a) > 2:
                return True
        return pos[:2] == ["context", "use"]
    if name == "gcloud":
        return any(p in ("ssh", "scp", "start-iap-tunnel") for p in pos)
    if name == "aws":
        return ("ssm" in pos and "start-session" in pos) or "ec2-instance-connect" in pos
    if name in ("az", "doctl"):
        return "ssh" in pos[:3]
    if name in ("fly", "flyctl"):
        return bool(pos) and pos[0] in ("ssh", "proxy", "sftp")
    if name == "heroku":
        return bool(pos) and pos[0] in ("run", "pg:psql", "redis:cli", "ps:exec")
    return False


def _git_branch_listing(args: list[str]) -> bool:
    listing = False
    i = 0
    while i < len(args):
        a = args[i]
        if a in _GIT_BRANCH_LIST_FLAGS:
            listing = listing or a in ("--list", "-l")
            i += 1
            continue
        if a in _GIT_BRANCH_VALUE_FLAGS:
            i += 2
            continue
        if a.startswith("--") and a.partition("=")[0] in (*_GIT_BRANCH_VALUE_FLAGS, "--color", "--column"):
            i += 1
            continue
        if listing and not a.startswith("-"):
            i += 1
            continue
        return False
    return True


def _git_mutates(cmd: Command) -> bool:
    args = cmd.args
    if not args:
        return False
    sub, rest = args[0], args[1:]
    if sub not in _GIT_MUTATING:
        return False
    first = next((a for a in rest if not a.startswith("-")), None)
    if sub == "branch":
        return not _git_branch_listing(rest)
    if sub == "stash":
        return first not in ("list", "show")
    if sub == "config":
        return not any(a in ("--get", "--get-all", "--get-regexp", "--list", "-l") for a in rest)
    if sub == "remote":
        return first not in (None, "show", "get-url")
    if sub == "tag":
        return bool(rest) and not any(a in ("-l", "--list") for a in rest)
    if sub == "worktree":
        return first != "list"
    if sub == "notes":
        return first not in (None, "list", "show")
    if sub == "submodule":
        return first not in (None, "status", "summary", "foreach")
    return True


def _perl_inplace(a: str) -> bool:
    return bool(re.fullmatch(r"-[a-hj-zA-Z]*i\S*", a)) and not a.startswith(("-M", "-m", "-I", "-e", "-E"))


def is_mutating(cmd: Command) -> bool:
    name = cmd.name
    if name in _MUTATING_COMMANDS:
        return True
    if name == "git":
        return _git_mutates(cmd)
    if name in ("sed", "gsed"):
        return any(a == "-i" or a.startswith(("-i", "--in-place")) for a in cmd.args)
    if name in ("perl", "ruby"):
        return any(_perl_inplace(a) for a in cmd.args)
    if name in _PKG_MANAGERS:
        return any(p in _PKG_MUTATING_SUBS for p in cmd.positionals()[:2])
    return False


def write_targets(cmd: Command) -> list[str]:
    """Paths a command writes (redirections + well-known file-mutating commands)."""
    out = [r.target for r in cmd.redirects if r.writes and r.target]
    name = cmd.name
    pos = cmd.positionals()
    if name in _ALL_PATHS_WRITTEN:
        if name == "truncate":
            pos = [p for i, p in enumerate(pos) if not (i == 0 and "-s" in cmd.args and p[:1].isdigit())]
        out.extend(pos)
    elif name in ("chmod", "chown", "chgrp"):
        out.extend(pos[1:])
    elif name in ("cp", "install", "ln"):
        args = cmd.args
        if "-t" in args and args.index("-t") + 1 < len(args):
            out.append(args[args.index("-t") + 1])
        elif pos:
            out.append(pos[-1])
    elif name == "dd":
        out.extend(a[3:] for a in cmd.args if a.startswith("of="))
    elif name in ("sed", "gsed") and is_mutating(cmd):
        script_given = any(a in ("-e", "-f") or a.startswith(("-e", "-f", "--expression", "--file")) for a in cmd.args)
        out.extend(pos if script_given else pos[1:])
    return [t for t in out if t]


def _path_words(cmd: Command) -> list[str]:
    words: list[str] = []
    for a in cmd.args:
        if not a or "\n" in a:
            continue
        if a.startswith("-"):
            if "=" not in a:
                continue
            a = a.partition("=")[2]
            if not a:
                continue
        if "://" in a:
            continue
        words.append(a)
        if cmd.name == "git" and ":" in a and not a.startswith(":"):
            words.append(a.partition(":")[2])  # `git show HEAD:path/to/file`
    for r in cmd.redirects:
        if not r.is_dup and not r.is_device and r.op not in ("<<", "<<-", "<<<") and r.target:
            words.append(r.target)
    if cmd.chdir:
        words.append(cmd.chdir)
    return words


def is_dynamic(word: str) -> bool:
    """A word whose value the shell computes (``$VAR``, ``$(...)``, backticks, ``~user``)."""
    return "$" in word or "`" in word or (word.startswith("~") and word != "~" and not word.startswith("~/"))


def _has_glob(word: str) -> bool:
    return any(ch in word for ch in "*?[")


def _reads_content(cmd: Command) -> bool:
    """Commands that print file contents (as opposed to names, sizes or nothing)."""
    if cmd.name in _CONTENT_READERS:
        return True
    return cmd.name == "git" and bool(cmd.args) and cmd.args[0] in ("show", "diff", "log", "blame", "grep")


def _reads_recursively(cmd: Command) -> bool:
    name, args = cmd.name, cmd.args
    if name in ("grep", "egrep", "fgrep"):
        return any(
            a in ("--recursive", "--dereference-recursive", "--directories=recurse")
            or (a.startswith("-") and not a.startswith("--") and ("r" in a[1:] or "R" in a[1:]))
            for a in args
        )
    if name in ("rg", "ag", "ack"):
        return "--files" not in args
    return name == "git" and bool(args) and args[0] == "grep"


def _dangerous_args(cmd: Command) -> bool:
    name, args = cmd.name, cmd.args
    if name == "find":
        return any(a in _FIND_DANGEROUS for a in args)
    if name == "rg":
        return any(a == "--pre" or a.startswith("--pre=") for a in args)
    if name == "tree":
        return "-o" in args
    if name == "git":
        if any(
            a in ("--output", "--ext-diff", "-O") or a.startswith(("--output=", "--open-files-in-pager", "-O"))
            for a in args
        ):
            return True  # writes a file / runs a configured external program
        if args and args[0] == "branch":
            return not _git_branch_listing(args[1:])
    return False


def _is_safe(cmd: Command, safe: Sequence[str]) -> bool:
    if cmd.privileged or cmd.unsafe or not cmd.argv:
        return False
    if not any(command_matches(p, cmd) for p in safe):
        return False
    return not _dangerous_args(cmd)


def _project_prefixes(commands: Iterable[str]) -> list[Command]:
    out: list[Command] = []
    for c in commands:
        if c and c.strip():
            out.extend(x for x in analyze(c).commands if x.argv)
    return out


def _prefix_match(prefix: Command, cmd: Command) -> bool:
    words = [cmd.name, *cmd.args]
    pwords = [prefix.name, *prefix.args]
    return words[: len(pwords)] == pwords and prefix.chdir == cmd.chdir


# --------------------------------------------------------------------------- request helpers


def request_command(req: PermissionRequest) -> str | None:
    """Shell command carried by the request, if any."""
    if req.command is not None:
        return req.command
    if req.kind != ToolKind.command:
        return None
    raw = req.input.get("command", req.input.get("cmd"))
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list) and all(isinstance(x, str) for x in raw):
        parts: list[str] = [str(x) for x in raw]
        # Codex sends ["bash", "-lc", "<script>"]; shlex.join keeps it analysable.
        return shlex.join(parts)
    return ""


def request_paths(req: PermissionRequest) -> list[str]:
    seen: dict[str, None] = {}
    for p in req.paths:
        if p:
            seen.setdefault(p, None)
    for key in _PATH_INPUT_KEYS:
        v = req.input.get(key)
        if isinstance(v, str) and v:
            seen.setdefault(v, None)
    extra = req.input.get("paths")
    if isinstance(extra, list):
        for v in extra:
            if isinstance(v, str) and v:
                seen.setdefault(v, None)
    return list(seen)


# --------------------------------------------------------------------------- evaluation


def evaluate(req: PermissionRequest, pctx: PolicyContext) -> PolicyDecision:
    env = _Env(pctx)
    if req.kind == ToolKind.studio:
        return _allow("Studio aracı; kendi onay kurallarıyla çalışır.", "studio_tool")
    command = request_command(req)
    if command is not None:
        return _evaluate_command(command, req, env)
    paths = [env.norm(p) for p in request_paths(req)]
    for p in paths:
        if env.is_forbidden(p):
            return _deny(f"Bu yola erişim yasak: {env.display(p)}", "forbidden_path")
    kind = req.kind
    if kind == ToolKind.subagent:
        return _allow("Alt ajan; araç çağrıları ayrıca denetlenir.", "subagent")
    if kind in (ToolKind.file_read, ToolKind.search):
        if all(env.can_read(p) for p in paths):
            return _allow("Çalışma alanı içinde okuma.", "workspace_read")
        return _ask("Çalışma alanı dışındaki bir yolu okumak istiyor.", "outside_read")
    if kind == ToolKind.file_edit:
        return _evaluate_write(paths, env)
    if kind == ToolKind.web:
        if not pctx.boundaries.network:
            return _deny("Bu oturumda ağ erişimi kapalı.", "network")
        if pctx.auto_allow_web:
            return _allow("Web erişimine ayarlardan izin verilmiş.", "web")
        return _ask("Web'e erişmek istiyor.", "web")
    if kind == ToolKind.mcp:
        return _ask("Harici bir MCP aracını kullanmak istiyor.", "mcp_tool")
    return _ask("Bu işlem otomatik olarak onaylanamadı; kullanıcı onayı gerekiyor.", "needs_approval")


def _evaluate_write(paths: list[str], env: _Env) -> PolicyDecision:
    for p in paths:
        if env.is_readonly(p):
            return _deny(f"Bu yol salt okunur: {env.display(p)}", "readonly_path")
        if not env.can_write(p):
            return _deny(f"Çalışma dizini dışına yazma izni yok: {env.display(p)}", "outside_workspace")
    if env.read_only_reason is not None:
        return _deny(env.read_only_reason, "read_only")
    if not paths:
        return _ask("Değiştirilecek dosya belirlenemedi.", "unknown_paths")
    if env.pctx.role in WRITER_ROLES:
        return _allow("Çalışma dizini içinde yazma.", "workspace_write")
    title = ROLE_LABELS.get(env.pctx.role, env.pctx.role)
    return _ask(f"{title} rolü dosya değiştirmek istiyor.", "role_write")


def _resolvable(word: str, base: str | None) -> bool:
    if is_dynamic(word):
        return False
    return base is not None or os.path.isabs(word) or word == "~" or word.startswith("~/")


@dataclass(slots=True)
class _Located:
    cmd: Command
    base: str | None  # working directory the command runs in; None = unknown


def _locate(analysis: ShellAnalysis, start: str, env: _Env) -> list[_Located]:
    """Follow ``cd``/``pushd``/``popd`` so relative paths resolve against the right directory."""
    out: list[_Located] = []
    base: str | None = start
    for cmd in analysis.commands:
        here = base
        if cmd.chdir is not None:
            if is_dynamic(cmd.chdir):
                here = None
            else:
                here = env.norm(cmd.chdir, base) if base is not None or os.path.isabs(cmd.chdir) else None
        out.append(_Located(cmd, here))
        if cmd.name in ("cd", "pushd"):
            pos = cmd.positionals()
            target = pos[0] if pos else "~"
            if target == "-" or is_dynamic(target):
                base = None
            elif base is not None or os.path.isabs(target) or target.startswith("~"):
                base = env.norm(target, base)
        elif cmd.name == "popd":
            base = None
    return out


def _evaluate_command(command: str, req: PermissionRequest, env: _Env) -> PolicyDecision:
    pctx = env.pctx
    bounds = pctx.boundaries
    if not command.strip():
        return _ask("Komut boş veya okunamadı.", "empty_command")
    start = env.cwd
    raw_cwd = req.input.get("cwd")
    if isinstance(raw_cwd, str) and raw_cwd:
        start = env.norm(raw_cwd, env.cwd)
        if env.is_forbidden(start):
            return _deny(f"Bu yola erişim yasak: {env.display(start)}", "forbidden_path")
    analysis = analyze(command)
    located = _locate(analysis, start, env)

    # 1. direct remote access
    for loc in located:
        if is_remote_command(loc.cmd):
            return _deny(REMOTE_ACCESS_MESSAGE, "remote_access")
    # 2. explicitly denied commands
    stripped = command.strip()
    for pattern in bounds.denied_commands:
        norm, kind = parse_pattern(pattern)
        if norm and kind == "glob" and fnmatch.fnmatchcase(stripped, norm):
            return _deny(f"Bu komut sınırlar gereği yasak: {pattern}", "denied_command")
        if any(command_matches(pattern, loc.cmd) for loc in located):
            return _deny(f"Bu komut sınırlar gereği yasak: {pattern}", "denied_command")
    # 3. network tools when network access is off
    if not bounds.network and any(loc.cmd.name in NETWORK_COMMANDS for loc in located):
        return _deny("Bu oturumda ağ erişimi kapalı.", "network")
    # 4. forbidden paths anywhere in the command (or in the request's own path list)
    for raw in request_paths(req):
        p = env.norm(raw, start)
        if env.is_forbidden(p):
            return _deny(f"Bu yola erişim yasak: {env.display(p)}", "forbidden_path")
    for loc in located:
        for word in _path_words(loc.cmd):
            if not _resolvable(word, loc.base):
                continue
            p = env.norm(word, loc.base or env.cwd)
            if env.is_forbidden(p):
                return _deny(f"Bu yola erişim yasak: {env.display(p)}", "forbidden_path")
    # 5. writes: read-only paths, traversal outside the working dirs, read-only roles
    targets: list[str] = []
    unknown_targets = False
    for loc in located:
        for t in write_targets(loc.cmd):
            if not _resolvable(t, loc.base):
                unknown_targets = True  # computed by the shell: cannot be bounded statically
                continue
            targets.append(env.norm(t, loc.base or env.cwd))
    for t in targets:
        if env.is_readonly(t):
            return _deny(f"Bu yol salt okunur: {env.display(t)}", "readonly_path")
        if not env.can_write(t):
            return _deny(f"Çalışma dizini dışına yazma izni yok: {env.display(t)}", "outside_workspace")
    mutating = any(is_mutating(loc.cmd) for loc in located)
    if env.read_only_reason is not None and (targets or unknown_targets or mutating):
        return _deny(env.read_only_reason, "read_only")
    # 6. automatic allow when every command is known-good
    if analysis.ok and not analysis.control and located and not unknown_targets:
        reasons = _auto_allow_reasons(located, env)
        if reasons is not None and (not targets or pctx.role in WRITER_ROLES):
            return _allow(reasons, "allowed_command")
    return _ask("Bu komut otomatik olarak onaylanamadı; kullanıcı onayı gerekiyor.", "needs_approval")


def _may_reveal_forbidden(cmd: Command, words: list[str], base: str, env: _Env) -> bool:
    """Globs or recursive searches could print a forbidden file's contents."""
    if not _reads_content(cmd):
        return False
    recursive = _reads_recursively(cmd)
    if env.forbidden and (recursive or any(_has_glob(w) for w in words)):
        return True
    if recursive:
        roots = [base, *(env.norm(w, base) for w in words)]
        return any(_inside(p, [r]) for r in roots for p in env.protected_forbidden)
    return False


def _safe_here(cmd: Command, base: str | None, env: _Env) -> bool:
    """A safe-list command running in a readable directory touching only readable paths."""
    if base is None or not env.can_read(base) or not _is_safe(cmd, env.pctx.safe_commands):
        return False
    words = [] if cmd.name in _NON_PATH_ARGS else _path_words(cmd)
    if any(is_dynamic(w) for w in words):
        return False
    if not all(env.can_read(env.norm(w, base)) for w in words):
        return False
    return not _may_reveal_forbidden(cmd, words, base, env)


def _auto_allow_reasons(located: list[_Located], env: _Env) -> str | None:
    pctx = env.pctx
    project = _project_prefixes(pctx.project_commands)
    kinds: set[str] = set()
    for loc in located:
        cmd = loc.cmd
        if cmd.privileged:
            return None
        if not cmd.argv:  # bare redirection (`> file`): a write, already bounded above
            if pctx.role not in WRITER_ROLES:
                return None
            kinds.add("write")
            continue
        if any(command_matches(p, cmd) for p in pctx.boundaries.allowed_commands):
            kinds.add("allowed")
            continue
        if any(_prefix_match(p, cmd) for p in project):
            kinds.add("project")
            continue
        if _safe_here(cmd, loc.base, env):
            kinds.add("safe")
            continue
        return None
    labels = {
        "allowed": "izinli komutlar",
        "project": "projenin kendi komutları",
        "safe": "güvenli komut listesi",
        "write": "çalışma dizini içinde yazma",
    }
    return "Otomatik izin: " + ", ".join(labels[k] for k in ("allowed", "project", "safe", "write") if k in kinds) + "."
