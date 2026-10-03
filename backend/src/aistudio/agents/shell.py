"""Conservative analysis of POSIX shell command lines for the permission policy.

``analyze("cd x && sudo env A=1 bash -c 'ssh h' | tee out")`` returns every simple command
that would execute, with wrappers (``sudo``, ``env``, ``nohup``, ``timeout``, ``xargs``,
``bash -c``, ``eval``, ``watch``, ``find -exec`` ...) peeled off, leading ``NAME=value``
assignments collected, and redirections recorded. Command substitutions (``$(...)``, backticks,
``<(...)``), subshells, heredoc bodies with expansions and compound operators (``&&``, ``||``,
``;``, ``|``, ``&``, newlines) are all followed.

The goal is safety, not full bash semantics: anything we cannot model makes ``ok`` False or
``control`` True, and the policy then never auto-allows the command.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Literal, NamedTuple

MAX_DEPTH = 8

_OPERATORS = (
    "&&",
    "||",
    ";;",
    "|&",
    "&>>",
    "&>",
    ">>",
    ">|",
    ">&",
    "<<<",
    "<<-",
    "<<",
    "<&",
    "<>",
    ";",
    "|",
    "&",
    "(",
    ")",
    "<",
    ">",
)
REDIRECT_OPS = frozenset({"&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", "<", ">"})
_WRITE_OPS = frozenset({"&>>", "&>", ">>", ">|", ">&", "<>", ">"})
_WORD_BREAK = frozenset(" \t\n;&|()<>")
_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
_FD_RE = re.compile(r"\d+(?=[<>])")
_DEVICE_TARGETS = ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/")

_PREFIX_KEYWORDS = frozenset({"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"})
_END_KEYWORDS = frozenset({"fi", "done", "esac", "}"})
SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "ash"})


@dataclass(frozen=True, slots=True)
class Redirect:
    op: str
    target: str
    fd: str | None = None

    @property
    def is_dup(self) -> bool:
        """``2>&1`` / ``>&-``: duplicates a descriptor, touches no file."""
        return self.op in (">&", "<&") and (self.target.isdigit() or self.target == "-")

    @property
    def is_device(self) -> bool:
        """``/dev/null``, ``/dev/stderr``...: no file on disk is read or written."""
        return self.target.startswith(_DEVICE_TARGETS)

    @property
    def writes(self) -> bool:
        if self.op not in _WRITE_OPS or self.is_dup:
            return False
        return not self.is_device

    @property
    def reads_file(self) -> bool:
        return self.op in ("<", "<>") and not self.is_device


@dataclass(slots=True)
class Command:
    """One command that will execute, after wrappers are removed."""

    argv: list[str]
    assignments: dict[str, str] = field(default_factory=dict)
    redirects: list[Redirect] = field(default_factory=list)
    privileged: bool = False  # ran through sudo/doas
    wrappers: list[str] = field(default_factory=list)
    unsafe: bool = False  # options that make auto-allow impossible (e.g. git -c)
    chdir: str | None = None  # directory the command runs in (`git -C dir`, `env -C dir`)

    @property
    def name(self) -> str:
        return os.path.basename(self.argv[0]) if self.argv else ""

    @property
    def args(self) -> list[str]:
        return self.argv[1:]

    def positionals(self) -> list[str]:
        """Arguments that are not options (everything after ``--`` counts as positional)."""
        out: list[str] = []
        after_dashdash = False
        for a in self.argv[1:]:
            if not after_dashdash and a == "--":
                after_dashdash = True
                continue
            if after_dashdash or not a.startswith("-") or a == "-":
                out.append(a)
        return out

    def subcommand(self) -> str | None:
        pos = self.positionals()
        return pos[0] if pos else None

    def text(self) -> str:
        return " ".join([self.name, *self.args]) if self.argv else ""


@dataclass(slots=True)
class ShellAnalysis:
    commands: list[Command] = field(default_factory=list)
    ok: bool = True  # fully parsed (balanced quotes, no unsupported constructs)
    control: bool = False  # contains constructs we do not model (case, functions, depth limit)

    def merge(self, other: ShellAnalysis) -> None:
        self.commands.extend(other.commands)
        self.ok = self.ok and other.ok
        self.control = self.control or other.control


# --------------------------------------------------------------------------- lexer


class _Tok(NamedTuple):
    kind: Literal["word", "op"]
    value: str
    fd: str | None = None
    quoted: bool = False


class _Lexer:
    def __init__(self, src: str) -> None:
        self.s = src
        self.n = len(src)
        self.i = 0
        self.ok = True
        self.subs: list[str] = []
        self._pending_heredocs: list[tuple[str, bool, bool]] = []  # (delimiter, strip_tabs, expand)
        self._expect_heredoc: str | None = None

    # -- helpers ----------------------------------------------------------------
    def _match_op(self, pos: int) -> str | None:
        for op in _OPERATORS:
            if self.s.startswith(op, pos):
                return op
        return None

    def _skip_squote(self, pos: int) -> int:
        """``pos`` is just after the opening quote; returns index after the closing one."""
        end = self.s.find("'", pos)
        if end < 0:
            self.ok = False
            return self.n
        return end + 1

    def _skip_dquote(self, pos: int, *, collect: bool) -> int:
        """Skip a double-quoted string starting after the quote, collecting substitutions."""
        s, n = self.s, self.n
        i = pos
        while i < n:
            c = s[i]
            if c == "\\":
                i += 2
                continue
            if c == '"':
                return i + 1
            if c == "$" and s.startswith("$(", i):
                i = self._substitution(i, collect=collect)
                continue
            if c == "`":
                i = self._backtick(i, collect=collect)
                continue
            if c == "$" and s.startswith("${", i):
                i = self._brace_param(i, collect=collect)
                continue
            i += 1
        self.ok = False
        return n

    def _match_paren(self, pos: int) -> int:
        """Index of the ``)`` closing the ``(`` just before ``pos``; -1 if unbalanced."""
        s, n = self.s, self.n
        depth = 1
        i = pos
        while i < n:
            c = s[i]
            if c == "\\":
                i += 2
                continue
            if c == "'":
                i = self._skip_squote(i + 1)
                continue
            if c == '"':
                i = self._skip_dquote(i + 1, collect=False)
                continue
            if c == "`":
                i = self._backtick(i, collect=False)
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        return -1

    def _substitution(self, pos: int, *, collect: bool) -> int:
        """``pos`` points at ``$(``; returns the index after the closing paren."""
        if self.s.startswith("$((", pos):  # arithmetic expansion: may still hide $(...)
            end = self._match_paren(pos + 2)
            if end < 0:
                self.ok = False
                return self.n
            inner = self.s[pos + 3 : end]
            if collect and ("$(" in inner or "`" in inner):
                self.subs.extend(_scan_substitutions(inner))
            return end + 2 if self.s.startswith(")", end + 1) else end + 1
        end = self._match_paren(pos + 2)
        if end < 0:
            self.ok = False
            if collect:
                self.subs.append(self.s[pos + 2 :])
            return self.n
        if collect:
            self.subs.append(self.s[pos + 2 : end])
        return end + 1

    def _backtick(self, pos: int, *, collect: bool) -> int:
        s, n = self.s, self.n
        i = pos + 1
        while i < n:
            if s[i] == "\\":
                i += 2
                continue
            if s[i] == "`":
                if collect:
                    self.subs.append(s[pos + 1 : i].replace("\\`", "`"))
                return i + 1
            i += 1
        self.ok = False
        if collect:
            self.subs.append(s[pos + 1 :])
        return n

    def _brace_param(self, pos: int, *, collect: bool) -> int:
        """``${...}``; nested substitutions inside the default value are collected."""
        depth = 0
        i = pos + 1
        while i < self.n:
            c = self.s[i]
            if c == "\\":
                i += 2
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    inner = self.s[pos + 2 : i]
                    if collect and ("$(" in inner or "`" in inner):
                        self.subs.extend(_scan_substitutions(inner))
                    return i + 1
            i += 1
        self.ok = False
        return self.n

    # -- words ------------------------------------------------------------------
    def _read_word(self) -> tuple[str, bool]:
        s, n = self.s, self.n
        buf: list[str] = []
        quoted = False
        while self.i < n:
            c = s[self.i]
            if c in _WORD_BREAK:
                break
            if c == "\\":
                if self.i + 1 < n:
                    buf.append(s[self.i + 1])
                self.i += 2
                quoted = True
                continue
            if c == "'":
                end = self._skip_squote(self.i + 1)
                buf.append(s[self.i + 1 : end - 1] if end <= n and s[end - 1 : end] == "'" else s[self.i + 1 :])
                self.i = end
                quoted = True
                continue
            if c == '"':
                start = self.i + 1
                end = self._skip_dquote(start, collect=True)
                inner = s[start : end - 1] if s[end - 1 : end] == '"' else s[start:]
                buf.append(re.sub(r"\\([\\$`\"\n])", r"\1", inner))
                self.i = end
                quoted = True
                continue
            if c == "$" and s.startswith("$(", self.i):
                start = self.i
                self.i = self._substitution(self.i, collect=True)
                buf.append(s[start : self.i])
                continue
            if c == "$" and s.startswith("${", self.i):
                start = self.i
                self.i = self._brace_param(self.i, collect=True)
                buf.append(s[start : self.i])
                continue
            if c == "`":
                start = self.i
                self.i = self._backtick(self.i, collect=True)
                buf.append(s[start : self.i])
                continue
            buf.append(c)
            self.i += 1
        return "".join(buf), quoted

    def _skip_heredocs(self) -> None:
        s = self.s
        for delimiter, strip_tabs, expand in self._pending_heredocs:
            while self.i < self.n:
                nl = s.find("\n", self.i)
                line = s[self.i : nl if nl >= 0 else self.n]
                self.i = nl + 1 if nl >= 0 else self.n
                if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                    break
                if expand and ("$(" in line or "`" in line):
                    self.subs.extend(_scan_substitutions(line))
        self._pending_heredocs.clear()

    def tokens(self) -> list[_Tok]:
        s = self.s
        toks: list[_Tok] = []
        at_word_start = True
        while self.i < self.n:
            c = s[self.i]
            if c in " \t":
                self.i += 1
                at_word_start = True
                continue
            if c == "\\" and s.startswith("\\\n", self.i):
                self.i += 2
                continue
            if c == "\n":
                toks.append(_Tok("op", "\n"))
                self.i += 1
                at_word_start = True
                if self._pending_heredocs:
                    self._skip_heredocs()
                continue
            if c == "#" and at_word_start:
                nl = s.find("\n", self.i)
                self.i = nl if nl >= 0 else self.n
                continue
            if s.startswith(("<(", ">("), self.i):  # process substitution: runs a command
                start = self.i
                end = self._match_paren(self.i + 2)
                if end < 0:
                    self.ok = False
                    self.subs.append(s[self.i + 2 :])
                    self.i = self.n
                else:
                    self.subs.append(s[self.i + 2 : end])
                    self.i = end + 1
                toks.append(_Tok("word", s[start : self.i]))
                at_word_start = False
                continue
            fd: str | None = None
            m = _FD_RE.match(s, self.i)
            if m and at_word_start:
                op = self._match_op(m.end())
                if op in REDIRECT_OPS:
                    fd = m.group(0)
                    self.i = m.end()
            op = self._match_op(self.i)
            if op is not None:
                self.i += len(op)
                toks.append(_Tok("op", op, fd))
                if op in ("<<", "<<-"):
                    self._expect_heredoc = op
                at_word_start = True
                continue
            word, quoted = self._read_word()
            toks.append(_Tok("word", word, None, quoted))
            at_word_start = False
            if self._expect_heredoc is not None:
                self._pending_heredocs.append((word, self._expect_heredoc == "<<-", not quoted))
                self._expect_heredoc = None
        return toks


def _scan_substitutions(text: str) -> list[str]:
    """Command substitutions inside text that bash expands (double-quote context)."""
    lx = _Lexer(text)
    i = 0
    while i < lx.n:
        c = text[i]
        if c == "\\":
            i += 2
        elif c == "$" and text.startswith("$(", i):
            i = lx._substitution(i, collect=True)
        elif c == "`":
            i = lx._backtick(i, collect=True)
        elif c == "$" and text.startswith("${", i):
            i = lx._brace_param(i, collect=True)
        else:
            i += 1
    return lx.subs


# --------------------------------------------------------------------------- parser


@dataclass(slots=True)
class _Simple:
    words: list[str] = field(default_factory=list)
    redirects: list[Redirect] = field(default_factory=list)


def _split_simple(toks: list[_Tok]) -> tuple[list[_Simple], bool]:
    out: list[_Simple] = []
    cur = _Simple()
    ok = True
    i = 0
    while i < len(toks):
        t = toks[i]
        if t.kind == "op":
            if t.value in REDIRECT_OPS:
                if i + 1 < len(toks) and toks[i + 1].kind == "word":
                    cur.redirects.append(Redirect(t.value, toks[i + 1].value, t.fd))
                    i += 2
                else:
                    ok = False
                    i += 1
                continue
            if cur.words or cur.redirects:
                out.append(cur)
                cur = _Simple()
            i += 1
            continue
        cur.words.append(t.value)
        i += 1
    if cur.words or cur.redirects:
        out.append(cur)
    return out, ok


def _skip_options(words: list[str], takes_arg: frozenset[str]) -> list[str]:
    i = 0
    while i < len(words):
        w = words[i]
        if w == "--":
            return words[i + 1 :]
        if not w.startswith("-") or w == "-":
            break
        if w in takes_arg:
            i += 2
            continue
        i += 1
    return words[i:]


_SUDO_ARGS = frozenset({"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "--user", "--group", "--host"})
_ENV_ARGS = frozenset({"-u", "--unset", "-C", "--chdir", "-P"})
_NICE_ARGS = frozenset({"-n", "--adjustment"})
_IONICE_ARGS = frozenset({"-c", "-n", "-p", "--class", "--classdata"})
_TIMEOUT_ARGS = frozenset({"-s", "--signal", "-k", "--kill-after"})
_STDBUF_ARGS = frozenset({"-i", "-o", "-e"})
_CAFFEINATE_ARGS = frozenset({"-t", "-w"})
_XARGS_ARGS = frozenset({"-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--arg-file", "--delimiter", "--max-args"})
_WATCH_ARGS = frozenset({"-n", "--interval", "-q", "--equexit"})
_EXEC_ARGS = frozenset({"-a"})
_SHELL_ARGS = frozenset({"-o", "+o", "-O", "+O", "--rcfile", "--init-file"})
_FLOCK_ARGS = frozenset({"-w", "--wait", "--timeout", "-E", "--conflict-exit-code"})

_GIT_VALUE_OPTS = frozenset({"-C", "--git-dir", "--work-tree", "--namespace"})
_GIT_UNSAFE_OPTS = frozenset({"-c", "--config-env", "--exec-path"})
_GIT_FLAG_OPTS = frozenset(
    {"--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--glob-pathspecs", "--no-replace-objects"}
)


def _normalize_git(argv: list[str]) -> tuple[list[str], bool, str | None]:
    """Strip git's global options (``-C dir``, ``--no-pager``...) so the subcommand comes first.
    Returns (argv, unsafe, chdir)."""
    out = [argv[0]]
    unsafe = False
    chdir: str | None = None
    i = 1
    while i < len(argv):
        a = argv[i]
        if not a.startswith("-"):
            break
        if a in _GIT_VALUE_OPTS:
            if a == "-C" and i + 1 < len(argv):
                chdir = argv[i + 1] if chdir is None else os.path.join(chdir, argv[i + 1])
            elif a in ("--git-dir", "--work-tree"):
                unsafe = True  # points git at another repository
            i += 2
            continue
        if a in _GIT_UNSAFE_OPTS:
            unsafe = True
            i += 2
            continue
        if any(a.startswith(f"{o}=") for o in (*_GIT_VALUE_OPTS, *_GIT_UNSAFE_OPTS)):
            unsafe = unsafe or a.startswith(("--config-env=", "--exec-path=", "--git-dir=", "--work-tree="))
            i += 1
            continue
        if a in _GIT_FLAG_OPTS:
            i += 1
            continue
        if a in ("-p", "--paginate"):
            unsafe = True  # pager is a configurable command
            i += 1
            continue
        break
    out.extend(argv[i:])
    return out, unsafe, chdir


def _find_exec_commands(argv: list[str]) -> list[list[str]]:
    out: list[list[str]] = []
    i = 0
    while i < len(argv):
        if argv[i] in ("-exec", "-execdir", "-ok", "-okdir"):
            j = i + 1
            inner: list[str] = []
            while j < len(argv) and argv[j] not in (";", "+"):
                inner.append(argv[j])
                j += 1
            if inner:
                out.append(inner)
            i = j + 1
            continue
        i += 1
    return out


def _normalize(sc: _Simple, depth: int, result: ShellAnalysis) -> None:
    words = list(sc.words)
    assignments: dict[str, str] = {}
    privileged = False
    wrappers: list[str] = []
    chdir: str | None = None

    def take_assignments() -> None:
        while words and _ASSIGN_RE.match(words[0]):
            key, _, value = words.pop(0).partition("=")
            assignments[key.rstrip("+")] = value

    take_assignments()
    while words and words[0] in _PREFIX_KEYWORDS:
        words.pop(0)
    if words and words[0] in _END_KEYWORDS:
        words.pop(0)
    if words and words[0] in ("for", "select"):
        return  # loop header: `for x in a b c` (substitutions were collected by the lexer)
    if words and (words[0] in ("case", "function", "coproc") or words[0].endswith("()")):
        result.control = True
        return

    while words:
        take_assignments()
        if not words:
            break
        name = os.path.basename(words[0])
        rest = words[1:]
        if name in ("sudo", "doas"):
            privileged = True
            wrappers.append(name)
            words = _skip_options(rest, _SUDO_ARGS)
            continue
        if name == "env":
            wrappers.append(name)
            i = 0
            split_string: str | None = None
            while i < len(rest):
                a = rest[i]
                if a == "--":
                    i += 1
                    break
                if a in ("-S", "--split-string") and i + 1 < len(rest):
                    split_string = rest[i + 1]
                    i += 2
                    break
                if a.startswith("--split-string="):
                    split_string = a.partition("=")[2]
                    i += 1
                    break
                if a in ("-C", "--chdir") and i + 1 < len(rest):
                    chdir = rest[i + 1]
                    i += 2
                    continue
                if a.startswith("--chdir="):
                    chdir = a.partition("=")[2]
                    i += 1
                    continue
                if a in _ENV_ARGS:
                    i += 2
                    continue
                if a.startswith("-") and a != "-":
                    i += 1
                    continue
                if _ASSIGN_RE.match(a):
                    key, _, value = a.partition("=")
                    assignments[key] = value
                    i += 1
                    continue
                break
            words = rest[i:]
            if split_string is not None:
                lx = _Lexer(split_string)
                inner = [t.value for t in lx.tokens() if t.kind == "word"]
                result.ok = result.ok and lx.ok
                words = inner + words
            if not words:
                words = ["env"]  # bare `env` prints the environment
                break
            continue
        if name in ("nohup", "builtin", "chronic", "unbuffer", "nocache"):
            wrappers.append(name)
            words = rest
            continue
        if name == "exec":
            wrappers.append(name)
            words = _skip_options(rest, _EXEC_ARGS)
            continue
        if name == "command":
            if rest[:1] and rest[0] in ("-v", "-V"):
                break  # lookup only
            wrappers.append(name)
            words = _skip_options(rest, frozenset())
            continue
        if name == "time":
            wrappers.append(name)
            words = _skip_options(rest, frozenset())
            continue
        if name == "nice":
            wrappers.append(name)
            words = _skip_options(rest, _NICE_ARGS)
            continue
        if name == "ionice":
            wrappers.append(name)
            words = _skip_options(rest, _IONICE_ARGS)
            continue
        if name == "timeout":
            wrappers.append(name)
            words = _skip_options(rest, _TIMEOUT_ARGS)[1:]  # drop DURATION
            continue
        if name == "stdbuf":
            wrappers.append(name)
            words = _skip_options(rest, _STDBUF_ARGS)
            continue
        if name == "caffeinate":
            wrappers.append(name)
            words = _skip_options(rest, _CAFFEINATE_ARGS)
            if not words:
                words = ["caffeinate"]
                break
            continue
        if name == "xargs":
            wrappers.append(name)
            words = _skip_options(rest, _XARGS_ARGS) or ["echo"]
            continue
        if name == "flock":
            wrappers.append(name)
            opts = _skip_options(rest, _FLOCK_ARGS)
            if "-c" in rest or "--command" in rest:
                idx = rest.index("-c") if "-c" in rest else rest.index("--command")
                if idx + 1 < len(rest):
                    result.merge(analyze(rest[idx + 1], _depth=depth + 1))
                return
            words = opts[1:]  # drop the lock file
            continue
        if name == "watch":
            opts = _skip_options(rest, _WATCH_ARGS)
            if opts:
                result.merge(analyze(" ".join(opts), _depth=depth + 1))
            return
        if name in SHELLS:
            i = 0
            has_c = False
            while i < len(rest) and rest[i].startswith(("-", "+")) and rest[i] not in ("-", "--"):
                a = rest[i]
                if a in _SHELL_ARGS:
                    i += 2
                    continue
                if not a.startswith("--") and "c" in a[1:]:
                    has_c = True
                i += 1
            if has_c and i < len(rest):
                result.merge(analyze(rest[i], _depth=depth + 1))
                return
            break  # `bash script.sh` / interactive shell: an opaque command
        if name == "eval":
            if rest:
                result.merge(analyze(" ".join(rest), _depth=depth + 1))
            return
        break

    if not words:
        if sc.redirects:  # `> file` alone truncates/creates the file
            result.commands.append(Command(argv=[], assignments=assignments, redirects=list(sc.redirects)))
        return

    argv = list(words)
    unsafe = False
    if os.path.basename(argv[0]) == "git":
        argv, unsafe, git_dir = _normalize_git(argv)
        if git_dir is not None:
            chdir = git_dir if chdir is None else os.path.join(chdir, git_dir)
    cmd = Command(
        argv=argv,
        assignments=assignments,
        redirects=list(sc.redirects),
        privileged=privileged,
        wrappers=wrappers,
        unsafe=unsafe,
        chdir=chdir,
    )
    result.commands.append(cmd)
    if cmd.name == "find":
        for inner in _find_exec_commands(argv):
            if depth + 1 > MAX_DEPTH:
                result.control = True
                break
            _normalize(_Simple(words=inner), depth + 1, result)


def analyze(command: str, *, _depth: int = 0) -> ShellAnalysis:
    """Every command a shell would run for ``command`` (see module docstring)."""
    result = ShellAnalysis()
    if _depth > MAX_DEPTH:
        result.ok = False
        result.control = True
        return result
    lexer = _Lexer(command)
    toks = lexer.tokens()
    simple, ok = _split_simple(toks)
    result.ok = lexer.ok and ok
    for sc in simple:
        _normalize(sc, _depth, result)
    for sub in lexer.subs:
        result.merge(analyze(sub, _depth=_depth + 1))
    return result
