"""Command classification (spec §12). Pure functions, no I/O.

Every remote shell command, SQL query, Redis command and MongoDB command is classified as
``read``, ``write`` or ``unknown`` before anything runs. ``unknown`` is always treated as
``write`` by the permission policy. The classifiers are deliberately conservative: anything
they cannot prove to be read-only is not ``read``.

Shell: parsed with bashlex (POSIX/bash grammar; commands are executed with ``/bin/sh -c``).
Each *simple command* becomes a :class:`Segment`; nested command substitutions are segments
of their own. A read-only allowlist with argument awareness decides each segment; output
redirections to files, ``sudo``, unknown programs and anything computed at run time are not
read. If bashlex cannot parse the command a strict shlex fallback is used and the result is
marked ``parsed=False`` (never auto-allowed by limited-write patterns).

SQL: split into statements with the sqlglot tokenizer of the profile's dialect and parsed per
statement; only SELECT/SHOW/DESCRIBE/EXPLAIN (not EXPLAIN ANALYZE of a write) and read-only
WITH queries are read. The split statements are exactly what the executor runs.

Redis: one command per line, command allowlist. MongoDB: a JSON command document
(``{"find": "users", "filter": {...}}``) or a small mongosh subset (``db.users.find({...})``).
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import bashlex
import sqlglot
from bson import json_util
from sqlglot import exp
from sqlglot.dialects.dialect import Dialect
from sqlglot.tokenizer_core import TokenType

from aistudio.contracts.remote import Classification, CommandClass

Verdict = tuple[CommandClass, str]


def _words(text: str) -> frozenset[str]:
    """Whitespace-separated word table (keeps the allowlists compact and reviewable)."""
    return frozenset(text.split())


def _wordt(text: str) -> tuple[str, ...]:
    return tuple(text.split())


READ: CommandClass = "read"
WRITE: CommandClass = "write"
UNKNOWN: CommandClass = "unknown"


@dataclass(frozen=True)
class Segment:
    """One unit of a command: a simple shell command, an SQL statement, a Redis command."""

    text: str
    klass: CommandClass
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class ClassifiedCommand:
    klass: CommandClass
    reasons: tuple[str, ...]
    segments: tuple[Segment, ...] = ()
    parsed: bool = True  # False when the structural parser failed (fallback or unparseable)

    @property
    def is_read(self) -> bool:
        return self.klass == READ

    def to_contract(self) -> Classification:
        return Classification(klass=self.klass, reasons=list(self.reasons))


def merge_classes(classes: Iterable[CommandClass]) -> CommandClass:
    seen = set(classes)
    if WRITE in seen:
        return WRITE
    if UNKNOWN in seen:
        return UNKNOWN
    return READ


def _dedupe(items: Iterable[str]) -> tuple[str, ...]:
    out: list[str] = []
    for item in items:
        if item and item not in out:
            out.append(item)
    return tuple(out)


def _single(klass: CommandClass, reason: str, *, parsed: bool = True, text: str = "") -> ClassifiedCommand:
    return ClassifiedCommand(klass, (reason,), (Segment(text, klass, (reason,)),) if text else (), parsed)


def _from_segments(segments: Sequence[Segment], *, parsed: bool, extra: Sequence[str] = ()) -> ClassifiedCommand:
    klass = merge_classes(s.klass for s in segments)
    # Lead with the reasons that make the command non-read; they matter most to approvers.
    ordered = [s for s in segments if s.klass != READ] + [s for s in segments if s.klass == READ]
    reasons = _dedupe([*extra, *(r for s in ordered for r in s.reasons)])
    return ClassifiedCommand(klass, reasons, tuple(segments), parsed)


# ============================================================================ shell

MAX_SHELL_LENGTH = 20_000
_MAX_DEPTH = 4
_SINKS = frozenset({"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/1", "/dev/fd/2"})
_SAFE_BIN_DIRS = frozenset({"/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin", "/usr/local/sbin"})
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

_SAFE_ENV = _words(
    """
LANG LANGUAGE TZ TERM COLUMNS LINES NO_COLOR CLICOLOR CLICOLOR_FORCE FORCE_COLOR TIME_STYLE
POSIXLY_CORRECT SYSTEMD_COLORS SYSTEMD_URLIFY GREP_COLORS LS_COLORS
"""
)
_PAGER_VARS = frozenset({"PAGER", "SYSTEMD_PAGER", "GIT_PAGER", "MANPAGER"})


def scan_word(raw: str) -> tuple[bool, bool]:
    """Inspect the raw source text of a shell word.

    Returns ``(has_expansion, has_unquoted_glob)``: parameter/command expansion anywhere
    outside single quotes, and unquoted glob or brace characters (which the shell expands
    to file names at run time).
    """
    expansion = glob = False
    quote: str | None = None
    i, n = 0, len(raw)
    while i < n:
        c = raw[i]
        if quote == "'":
            if c == "'":
                quote = None
        elif quote == '"':
            if c == "\\":
                i += 1
            elif c == '"':
                quote = None
            elif c in "$`":
                expansion = True
        elif c == "\\":
            i += 1
        elif c in "'\"":
            quote = c
        elif c in "$`":
            expansion = True
        elif c in "*?[" or (c == "{" and ("," in raw[i:] or ".." in raw[i:])):
            glob = True
        i += 1
    return expansion, glob


def assignment_verdict(name: str, value: str) -> Verdict | None:
    """``None`` if assigning ``name=value`` cannot change what later commands do."""
    name = name.rstrip("+")
    if name in _PAGER_VARS:
        if value in ("", "cat"):
            return None
        return UNKNOWN, f"`{name}` değişkeni komut çalıştırabilir; bilinmeyen sayılır"
    if name in _SAFE_ENV or name.startswith("LC_"):
        return None
    if re.fullmatch(r"[a-z_][a-z0-9_]*", name):
        return None  # shell-local variable (env vars that change program behaviour are upper-case)
    return UNKNOWN, f"`{name}` ortam değişkeni komutların davranışını değiştirebilir; bilinmeyen sayılır"


def parse_opts(
    args: Sequence[str], *, short_with_arg: str = "", long_with_arg: Iterable[str] = ()
) -> tuple[list[tuple[str, str | None]], list[str]]:
    """getopt-style parse. Options are recognised anywhere (GNU permutation), so this errs on
    the side of seeing more options, never fewer. Returns ``([(flag, value)], positionals)``."""
    longs = frozenset(long_with_arg)
    opts: list[tuple[str, str | None]] = []
    pos: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            pos.extend(args[i + 1 :])
            break
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if eq:
                opts.append((name, val))
            elif name in longs and i + 1 < len(args):
                opts.append((name, args[i + 1]))
                i += 1
            else:
                opts.append((name, None))
        elif a.startswith("-") and len(a) > 1:
            j = 1
            while j < len(a):
                c = a[j]
                if c in short_with_arg:
                    rest = a[j + 1 :]
                    if rest:
                        opts.append(("-" + c, rest))
                    elif i + 1 < len(args):
                        opts.append(("-" + c, args[i + 1]))
                        i += 1
                    else:
                        opts.append(("-" + c, None))
                    break
                opts.append(("-" + c, None))
                j += 1
        else:
            pos.append(a)
        i += 1
    return opts, pos


def flag_hit(flag: str, longs: Iterable[str] = (), shorts: str = "") -> bool:
    """True if ``flag`` is one of ``longs`` (or an unambiguous GNU abbreviation of one) or a
    single-letter flag in ``shorts``."""
    if flag.startswith("--"):
        return len(flag) > 2 and any(name.startswith(flag) for name in longs)
    return len(flag) == 2 and flag[0] == "-" and flag[1] in shorts


def _any_flag(opts: Iterable[tuple[str, str | None]], longs: Iterable[str] = (), shorts: str = "") -> str | None:
    longs = tuple(longs)
    for flag, _ in opts:
        if flag_hit(flag, longs, shorts):
            return flag
    return None


Validator = Callable[["_Shell", str, list[str], list[str]], Verdict]


@dataclass(frozen=True)
class _Cmd:
    check: Validator
    # Arguments decide the verdict: run-time expansion or unquoted globs in them make it unknown.
    sensitive: bool = False


def _read(name: str, note: str = "salt okuma komutu") -> Verdict:
    return READ, f"`{name}` {note}"


def _write(name: str, note: str) -> Verdict:
    return WRITE, f"`{name}` {note}"


def _unknown(name: str, note: str) -> Verdict:
    return UNKNOWN, f"`{name}` {note}"


class _Shell:
    """Walks a bashlex tree and collects one segment per simple command."""

    def __init__(self, src: str, depth: int) -> None:
        self.src = src
        self.depth = depth
        self.segments: list[Segment] = []

    def raw(self, node: Any) -> str:
        return self.src[node.pos[0] : node.pos[1]]

    def add(self, text: str, verdicts: Sequence[Verdict]) -> None:
        klass = merge_classes(v[0] for v in verdicts)
        self.segments.append(Segment(" ".join(text.split()), klass, _dedupe(v[1] for v in verdicts)))

    # ------------------------------------------------------------------ tree walking
    def visit(self, node: Any) -> None:
        kind = getattr(node, "kind", None)
        if kind == "command":
            self.command(node)
        elif kind in ("list", "pipeline"):
            for part in node.parts:
                self.visit(part)
        elif kind == "compound":
            for part in node.list:
                self.visit(part)
            self.compound_redirects(node)
        elif kind in ("if", "for", "while", "until"):
            for part in node.parts:
                self.visit(part)
            self.compound_redirects(node)
        elif kind == "function":
            self.add(self.raw(node), [(UNKNOWN, "Fonksiyon tanımı komutların yerine geçebilir; bilinmeyen sayılır")])
            for part in node.parts:
                self.visit(part)
        elif kind in ("reservedword", "operator", "pipe"):
            return
        elif kind == "word":
            self.substitutions(node)
        else:
            text = self.raw(node) if hasattr(node, "pos") else str(kind)
            self.add(text, [(UNKNOWN, f"Desteklenmeyen kabuk yapısı ({kind}); bilinmeyen sayılır")])

    def compound_redirects(self, node: Any) -> None:
        for r in getattr(node, "redirects", None) or []:
            verdict = self.redirect(r)
            if verdict is not None:
                self.add(self.raw(r), [verdict])

    def substitutions(self, node: Any) -> None:
        for part in getattr(node, "parts", None) or []:
            kind = getattr(part, "kind", None)
            if kind in ("commandsubstitution", "processsubstitution"):
                self.visit(part.command)
            elif kind in ("parameter", "tilde"):
                continue
            else:
                self.substitutions(part)

    def command(self, node: Any) -> None:
        words: list[Any] = []
        assigns: list[Any] = []
        verdicts: list[Verdict] = []
        redirects: list[Any] = []
        for part in node.parts:
            kind = getattr(part, "kind", None)
            if kind == "word":
                words.append(part)
            elif kind == "assignment":
                assigns.append(part)
            elif kind == "redirect":
                redirects.append(part)
            else:
                verdicts.append((UNKNOWN, f"Desteklenmeyen kabuk yapısı ({kind}); bilinmeyen sayılır"))
        for part in (*words, *assigns):
            self.substitutions(part)
        for r in redirects:
            verdict = self.redirect(r)
            if verdict is not None:
                verdicts.append(verdict)
        for a in assigns:
            name, _, value = str(a.word).partition("=")
            verdict = assignment_verdict(name, value)
            if verdict is not None:
                verdicts.append(verdict)
        if words:
            verdicts.append(self.argv([str(w.word) for w in words], [self.raw(w) for w in words]))
        elif not verdicts:
            verdicts.append((READ, "Yalnız kabuk değişkeni ataması"))
        self.add(self.raw(node), verdicts)

    def redirect(self, r: Any) -> Verdict | None:
        rtype = str(getattr(r, "type", ""))
        out = getattr(r, "output", None)
        if out is None or isinstance(out, int):
            return None  # file descriptor duplication / close (2>&1, >&2)
        self.substitutions(out)
        target = str(getattr(out, "word", ""))
        raw = self.raw(out) if hasattr(out, "pos") else target
        if rtype in ("<<", "<<-"):
            heredoc = getattr(r, "heredoc", None)
            body = str(getattr(heredoc, "value", "") or "")
            quoted = any(q in raw for q in "'\"\\")
            if not quoted and ("`" in body or "$(" in body):
                return UNKNOWN, "Heredoc içinde komut yerine geçen ifade var; bilinmeyen sayılır"
            return None
        if ">" not in rtype:
            return None  # input redirection reads
        if rtype == ">&" and (target.isdigit() or target == "-"):
            return None
        expansion, glob = scan_word(raw)
        if not expansion and not glob and target in _SINKS:
            return None
        return WRITE, f"Dosyaya yönlendirme (`{rtype} {target}`) yazma işlemidir"

    # ------------------------------------------------------------------ argv
    def argv(self, argv: list[str], raws: list[str]) -> Verdict:
        if not argv:
            return READ, "Boş komut"
        expansion, glob = scan_word(raws[0])
        if expansion or glob or not argv[0]:
            return UNKNOWN, "Komut adı çalışma anında belirleniyor; bilinmeyen sayılır"
        name = argv[0]
        if "/" in name:
            directory, _, base = name.rpartition("/")
            if directory not in _SAFE_BIN_DIRS:
                return _unknown(name, "standart sistem dizinleri dışında bir program; bilinmeyen sayılır")
            name = base
        spec = _COMMANDS.get(name)
        if spec is None:
            if name in _KNOWN_WRITE:
                return _write(name, _KNOWN_WRITE[name])
            return _unknown(name, "salt okuma listesinde değil; yazma sayılır")
        if spec.sensitive:
            for raw in raws[1:]:
                e, g = scan_word(raw)
                if e or g:
                    return _unknown(name, "argümanları çalışma anında genişliyor (değişken/joker); denetlenemiyor")
        return spec.check(self, name, argv[1:], raws[1:])

    def script(self, name: str, script: str) -> Verdict:
        if self.depth + 1 >= _MAX_DEPTH:
            return _unknown(name, "iç içe kabuk derinliği aşıldı; bilinmeyen sayılır")
        inner = _classify_shell(script, self.depth + 1)
        detail = "; ".join(inner.reasons) or "boş betik"
        return inner.klass, f"`{name}` içeriği: {detail}"

    def inner(self, name: str, args: list[str], raws: list[str]) -> Verdict:
        if not args:
            return _read(name, "komutsuz çalıştırıldı")
        return self.argv(args, raws)


# ---------------------------------------------------------------- validators


def _v_simple(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    return _read(name)


def _write_flags(longs: Iterable[str], shorts: str = "", note: str = "dosyaya yazar") -> Validator:
    longs = tuple(longs)

    def check(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
        opts, _ = parse_opts(args)
        hit = _any_flag(opts, longs, shorts)
        if hit:
            return _write(f"{name} {hit}", note)
        return _read(name)

    return check


def _max_positionals(limit: int, note: str) -> Validator:
    def check(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
        _, pos = parse_opts(args)
        if len(pos) > limit:
            return _write(name, note)
        return _read(name)

    return check


def _v_sort(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="koSTt", long_with_arg=("--key", "--output", "--field-separator"))
    if _any_flag(opts, ("--compress-program",)):
        return _unknown(name, "--compress-program bir program çalıştırır")
    if _any_flag(opts, ("--output",), "o"):
        return _write(f"{name} -o", "sonucu dosyaya yazar")
    return _read(name)


def _v_rg(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args)
    if _any_flag(opts, ("--pre", "--pre-glob")):
        return _unknown(f"{name} --pre", "her dosya için bir program çalıştırır")
    return _read(name)


def _v_pager(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    if any(a.startswith("+") for a in args):
        return _unknown(name, "`+` ile başlangıç komutu çalıştırabilir")
    opts, _ = parse_opts(args, short_with_arg="oObhjkpPtTxyz#")
    if _any_flag(opts, ("--log-file", "--LOG-FILE"), "oO"):
        return _write(name, "günlük dosyası yazar")
    return _read(name)


def _v_date(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args, short_with_arg="dfrs", long_with_arg=("--date", "--file", "--reference", "--set"))
    if _any_flag(opts, ("--set",), "s"):
        return _write(f"{name} -s", "sistem saatini değiştirir")
    if any(not p.startswith("+") for p in pos):
        return _write(name, "argümanla sistem saatini değiştirir")
    return _read(name)


def _v_hostname(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args, short_with_arg="F", long_with_arg=("--file",))
    if pos or _any_flag(opts, ("--file", "--boot"), "Fb"):
        return _write(name, "host adını değiştirir")
    return _read(name)


def _v_top(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="dnpuUoOswl")
    if _any_flag(opts, (), "bl"):
        return _read(name, "toplu (batch) kipte salt okuma")
    return _unknown(name, "etkileşimli kipte süreç sonlandırabilir; `top -b` kullanın")


def _v_ss(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="fAFN")
    if _any_flag(opts, ("--kill",), "K"):
        return _write(f"{name} -K", "soketleri kapatır")
    return _read(name)


_IP_WRITE_VERBS = _words(
    """
add del delete change chg replace set flush append prepend restore save exec attach detach create
update reset identify pid
"""
)


def _v_ip(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        a = args[i]
        if a in ("-b", "-batch", "-force", "--batch", "--force"):
            return _unknown(f"{name} {a}", "toplu komut dosyası çalıştırır")
        if a in ("-n", "-netns", "-l", "-loops", "-f", "-family", "-rc", "-rcvbuf"):
            i += 2
            continue
        i += 1
    for a in args[i + 1 :]:
        if a in _IP_WRITE_VERBS:
            return _write(f"{name} {a}", "ağ yapılandırmasını değiştirir")
    return _read(name)


def _v_ifconfig(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    _, pos = parse_opts(args)
    if len(pos) > 1:
        return _write(name, "arayüz yapılandırmasını değiştirir")
    return _read(name)


def _v_route(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    _, pos = parse_opts(args, short_with_arg="A")
    if pos and pos[0] not in ("get", "monitor", "show"):
        return _write(name, "yönlendirme tablosunu değiştirir")
    return _read(name)


def _v_arp(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="iHt")
    if _any_flag(opts, ("--set", "--delete", "--file"), "sdf"):
        return _write(name, "ARP tablosunu değiştirir")
    return _read(name)


def _v_file(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="mfFeP")
    if _any_flag(opts, ("--compile",), "C"):
        return _write(f"{name} -C", "sihirli dosyayı derleyip yazar")
    return _read(name)


def _v_tree(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="oLPIH", long_with_arg=("--filelimit", "--timefmt", "--sort"))
    if _any_flag(opts, (), "o"):
        return _write(f"{name} -o", "çıktıyı dosyaya yazar")
    return _read(name)


def _v_yq(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args)
    if _any_flag(opts, ("--inplace", "--split-exp"), "is"):
        return _write(name, "dosyayı yerinde değiştirir")
    return _read(name)


def _v_dmesg(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="nfFlsS")
    longs = ("--clear", "--read-clear", "--console-off", "--console-on", "--console-level")
    if _any_flag(opts, longs, "cCDEn"):
        return _write(name, "çekirdek günlük tamponunu/konsolunu değiştirir")
    return _read(name)


def _v_sysctl(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args)
    if _any_flag(opts, ("--write", "--load", "--system"), "wp") or any("=" in p for p in pos):
        return _write(name, "çekirdek parametresini değiştirir")
    return _read(name)


def _v_mount(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args, short_with_arg="t")
    if pos or any(not flag_hit(f, ("--show-labels", "--types", "--verbose"), "ltv") for f, _ in opts):
        return _write(name, "dosya sistemi bağlar/değiştirir")
    return _read(name)


def _v_crontab(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args, short_with_arg="u")
    flags = {f for f, _ in opts}
    if "-l" in flags and not pos and flags <= {"-l", "-u"}:
        return _read(name, "-l zamanlanmış görevleri listeler")
    return _write(name, "zamanlanmış görevleri değiştirir")


def _v_lastlog(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="bturR")
    if _any_flag(opts, ("--clear", "--set"), "CS"):
        return _write(name, "giriş kayıtlarını değiştirir")
    return _read(name)


def _v_history(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="d")
    if _any_flag(opts, (), "wa"):
        return _write(name, "geçmişi dosyaya yazar")
    return _read(name)


def _v_names(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    """export/declare/typeset/local/readonly: assignments must not alter later commands."""
    for a in args:
        if a.startswith(("-", "+")):
            continue
        var, eq, value = a.partition("=")
        verdict = assignment_verdict(var, value if eq else "")
        if verdict is not None and (eq or var in _PAGER_VARS):
            return verdict
    return _read(name, "değişken tanımı")


def _v_read_builtin(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args, short_with_arg="adinNptu")
    targets = list(pos)
    for flag, value in opts:
        if flag == "-a" and value:
            targets.append(value)
    for var in targets:
        verdict = assignment_verdict(var, "?")
        if verdict is not None:
            return verdict
    return _read(name, "değişkene okur")


def _v_printf(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    if len(args) >= 2 and args[0] == "-v":
        verdict = assignment_verdict(args[1], "?")
        if verdict is not None:
            return verdict
    return _read(name)


def _v_alias(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    if any("=" in a for a in args):
        return _unknown(name, "komutların yerine geçebilir; bilinmeyen sayılır")
    return _read(name)


def _v_hash(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="pd")
    if _any_flag(opts, (), "p"):
        return _unknown(f"{name} -p", "komutun çalıştırılacağı yolu değiştirir")
    return _read(name)


def _v_tee(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    return _write(name, "girdiyi dosyaya yazar")


_FIND_WRITE = frozenset({"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"})


def _v_find(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    for a in args:
        if a in _FIND_WRITE:
            return _write(f"find {a}", "dosya siler, komut çalıştırır veya dosyaya yazar")
    return _read(name)


def sed_script_safe(script: str) -> bool:
    """True if a sed script cannot write files or run commands (no ``w``/``W``/``e`` commands and
    no ``w``/``e`` flags on ``s``). Anything the scanner does not understand is unsafe."""
    s, n = script, len(script)

    def field_end(i: int, delim: str) -> int:
        while i < n:
            c = s[i]
            if c == "\\":
                i += 2
                continue
            if c == "\n":
                return -1
            if c == delim:
                return i + 1
            i += 1
        return -1

    def address(i: int) -> int:
        if i < n and s[i].isdigit():
            while i < n and s[i].isdigit():
                i += 1
            if i < n and s[i] == "~":
                i += 1
                while i < n and s[i].isdigit():
                    i += 1
            return i
        if i < n and s[i] == "$":
            return i + 1
        if i < n and s[i] in "/\\":
            if s[i] == "\\":
                if i + 1 >= n:
                    return -1
                delim, i = s[i + 1], i + 2
            else:
                delim, i = "/", i + 1
            i = field_end(i, delim)
            if i < 0:
                return -1
            while i < n and s[i] in "IM":
                i += 1
        return i

    def to_eol(i: int, stop: str = "\n") -> int:
        while i < n and s[i] not in stop:
            if s[i] == "\\":
                i += 1
            i += 1
        return i

    i = 0
    while i < n:
        c = s[i]
        if c in " \t\n;":
            i += 1
            continue
        if c == "#":
            i = to_eol(i)
            continue
        j = address(i)
        if j < 0:
            return False
        if j != i:
            i = j
            while i < n and s[i] in " \t":
                i += 1
            if i < n and s[i] == ",":
                i += 1
                while i < n and s[i] in " \t":
                    i += 1
                if i < n and s[i] in "+~":
                    i += 1
                    while i < n and s[i].isdigit():
                        i += 1
                else:
                    j = address(i)
                    if j <= i:
                        return False
                    i = j
        while i < n and s[i] in " \t!":
            i += 1
        if i >= n:
            return False
        c = s[i]
        if c in "{}":
            i += 1
        elif c in "wWe":
            return False
        elif c in "aic" or c in "rR":
            i = to_eol(i + 1)
        elif c in ":btTv":
            i = to_eol(i + 1, "\n;")
        elif c in "sy":
            if i + 1 >= n or s[i + 1] in "\n\\":
                return False
            delim = s[i + 1]
            i = field_end(i + 2, delim)
            if i < 0:
                return False
            i = field_end(i, delim)
            if i < 0:
                return False
            if c == "s":
                while i < n and (s[i] in "gpiImMwe" or s[i].isdigit()):
                    if s[i] in "we":
                        return False
                    i += 1
        elif c in "=dDgGhHlLnNpPqQxzF":
            i += 1
            while i < n and (s[i].isdigit() or s[i] in " \t") and c in "lLqQ":
                i += 1
        else:
            return False
    return True


def _v_sed(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    scripts: list[str] = []
    positional: list[str] = []
    script_opt = sandbox = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional.extend(args[i + 1 :])
            break
        if a.startswith("--"):
            opt, eq, val = a.partition("=")
            if flag_hit(opt, ("--in-place",)):
                return _write(f"{name} -i", "dosyayı yerinde değiştirir")
            if flag_hit(opt, ("--file",)):
                return _unknown(f"{name} -f", "betik dosyası denetlenemez")
            if opt == "--sandbox":
                sandbox = True
            elif flag_hit(opt, ("--expression",)):
                script_opt = True
                if eq:
                    scripts.append(val)
                else:
                    scripts.append(args[i + 1] if i + 1 < len(args) else "")
                    i += 1
            elif flag_hit(opt, ("--line-length",)) and not eq:
                i += 1
            i += 1
            continue
        if a.startswith("-") and len(a) > 1:
            j = 1
            consumed_next = False
            while j < len(a):
                ch = a[j]
                if ch in "iI":
                    return _write(f"{name} -i", "dosyayı yerinde değiştirir")
                if ch == "f":
                    return _unknown(f"{name} -f", "betik dosyası denetlenemez")
                if ch in "el":
                    value = a[j + 1 :]
                    if not value:
                        value = args[i + 1] if i + 1 < len(args) else ""
                        consumed_next = True
                    if ch == "e":
                        script_opt = True
                        scripts.append(value)
                    break
                j += 1
            i += 2 if consumed_next else 1
            continue
        positional.append(a)
        i += 1
    if not script_opt and positional:
        scripts.append(positional[0])
    if not sandbox and not all(sed_script_safe(sc) for sc in scripts):
        return _write(name, "betiği dosyaya yazıyor veya komut çalıştırıyor (w/W/e)")
    return _read(name)


_AWK_STRING = re.compile(r'"(?:[^"\\\n]|\\.)*"')
_AWK_REGEX = re.compile(r"(^|[~(,!{;&|\n]\s*)/(?:[^/\\\n]|\\.)*/")


def awk_program_safe(program: str) -> bool:
    """Conservative: no system(), pipes, output redirection after print/printf or @load/@include."""
    text = _AWK_STRING.sub('""', program)
    text = _AWK_REGEX.sub(lambda m: m.group(1) + "//", text)
    if re.search(r"\bsystem\s*\(", text) or re.search(r"@\s*(load|include)", text):
        return False
    if "|" in text.replace("||", ""):
        return False
    return not re.search(r"\bprintf?\b[^;{}\n]*>", text)


def _v_awk(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    programs: list[str] = []
    positional: list[str] = []
    program_opt = sandbox = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional.extend(args[i + 1 :])
            break
        if a.startswith("--"):
            opt, eq, val = a.partition("=")
            if opt == "--sandbox":
                sandbox = True
            elif flag_hit(opt, ("--file", "--exec", "--include", "--load", "--debug")):
                return _unknown(f"{name} {opt}", "dış program/betik yükler; denetlenemez")
            elif flag_hit(opt, ("--pretty-print", "--profile", "--dump-variables")):
                return _write(f"{name} {opt}", "dosyaya yazar")
            elif flag_hit(opt, ("--source",)):
                program_opt = True
                if eq:
                    programs.append(val)
                else:
                    programs.append(args[i + 1] if i + 1 < len(args) else "")
                    i += 1
            elif opt in ("--field-separator", "--assign") and not eq:
                i += 1
            i += 1
            continue
        if a.startswith("-") and len(a) > 1:
            ch = a[1]
            if ch in "fEilD":
                return _unknown(f"{name} -{ch}", "dış program/betik yükler; denetlenemez")
            if ch in "opd":
                return _write(f"{name} -{ch}", "dosyaya yazar")
            if ch == "S":
                sandbox = True
            if ch in "Fv" and len(a) == 2:
                i += 1
            if ch == "e":
                program_opt = True
                if len(a) > 2:
                    programs.append(a[2:])
                else:
                    programs.append(args[i + 1] if i + 1 < len(args) else "")
                    i += 1
            i += 1
            continue
        positional.append(a)
        i += 1
    if not program_opt and positional:
        programs.append(positional[0])
    if sandbox or all(awk_program_safe(p) for p in programs):
        return _read(name)
    return _write(name, "programı komut çalıştırabilir veya dosyaya yazabilir")


# ---------------------------------------------------------------- curl / wget

_CURL_SHORT_ARG = "AbcCdDeEFHKmoPQrtTuUwxXyYz"
_CURL_LONG_ARG = _words(
    """
--header --proxy-header --user-agent --referer --user --proxy --proxy-user --max-time
--connect-timeout --retry --retry-delay --retry-max-time --cacert --capath --cert --key --cert-type
--key-type --pass --resolve --connect-to --interface --dns-servers --write-out --range --limit-rate
--max-filesize --url --cookie --oauth2-bearer --max-redirs --noproxy --proto --proto-redir --socks5
--socks5-hostname --request --output --dump-header --trace --trace-ascii --stderr --cookie-jar
--config --upload-file --data --data-ascii --data-binary --data-raw --data-urlencode --form
--form-string --json --output-dir --etag-save --hsts --alt-svc --libcurl --quote --mail-from
--mail-rcpt --mail-auth --unix-socket --abstract-unix-socket --url-query --variable --netrc-file
--request-target
"""
)
_CURL_DATA = ("--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode")
_CURL_ALWAYS_WRITE = _wordt(
    """
--remote-name --remote-name-all --output-dir --create-dirs --upload-file --form --form-string --json
--quote --ftp-create-dirs --etag-save --hsts --alt-svc --libcurl --mail-from --mail-rcpt --mail-auth
"""
)
_CURL_FILE_OUT = ("--output", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--cookie-jar")
_URL_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*)://")


def _v_curl(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, pos = parse_opts(args, short_with_arg=_CURL_SHORT_ARG, long_with_arg=_CURL_LONG_ARG)
    method: str | None = None
    data = get = False
    urls = list(pos)
    for flag, value in opts:
        if flag_hit(flag, ("--request",), "X"):
            method = (value or "").upper()
        elif flag_hit(flag, ("--get",), "G"):
            get = True
        elif flag_hit(flag, _CURL_DATA, "d"):
            data = True
        elif flag_hit(flag, ("--config",), "K"):
            return _unknown(f"{name} -K", "yapılandırma dosyası denetlenemez")
        elif flag_hit(flag, _CURL_FILE_OUT, "oDc"):
            if value not in ("-", "/dev/null"):
                return _write(f"{name} {flag}", "dosyaya yazar")
        elif flag_hit(flag, _CURL_ALWAYS_WRITE, "OTFQ"):
            return _write(f"{name} {flag}", "dosya yazar veya veri yükler/gönderir")
        elif flag_hit(flag, ("--header", "--proxy-header"), "H") and value and "method-override" in value.lower():
            return _write(f"{name} -H", "HTTP yöntemini değiştiren başlık gönderir")
        elif flag_hit(flag, ("--url",)) and value:
            urls.append(value)
    for url in urls:
        m = _URL_SCHEME.match(url)
        if m and m.group(1).lower() not in ("http", "https"):
            return _unknown(name, f"`{m.group(1)}://` protokolü; yalnız http/https okuma sayılır")
    if method is not None and method not in ("GET", "HEAD"):
        return _write(f"{name} -X {method}", "yazma isteğidir")
    if data and not get:
        return _write(f"{name} -d", "veri gönderen (POST) istektir")
    return _read(name, "GET/HEAD isteği")


_WGET_SHORT_ARG = "OoaeiBtTwQPlADRXIU"
_WGET_LONG_ARG = _words(
    """
--output-document --output-file --append-output --execute --input-file --tries --timeout --wait
--method --post-data --post-file --body-data --body-file --directory-prefix --header --user-agent
--user --password --save-cookies --load-cookies --warc-file --config
"""
)
_WGET_WRITE = _wordt(
    """
--post-data --post-file --body-data --body-file --recursive --mirror --directory-prefix
--force-directories --save-cookies --warc-file --timestamping --continue --convert-links
--backup-converted --page-requisites
"""
)


def _v_wget(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg=_WGET_SHORT_ARG, long_with_arg=_WGET_LONG_ARG)
    to_stdout = False
    for flag, value in opts:
        if flag_hit(flag, ("--output-document",), "O"):
            if value in ("-", "/dev/null"):
                to_stdout = True
            else:
                return _write(f"{name} -O", "dosyaya indirir")
        elif flag_hit(flag, ("--spider",)):
            to_stdout = True
        elif flag_hit(flag, ("--output-file", "--append-output"), "oa"):
            if value not in ("-", "/dev/null"):
                return _write(f"{name} {flag}", "günlük dosyası yazar")
        elif flag_hit(flag, ("--execute", "--config"), "e"):
            return _unknown(f"{name} {flag}", "yapılandırma komutu çalıştırır")
        elif flag_hit(flag, ("--method",)):
            if (value or "").upper() not in ("GET", "HEAD"):
                return _write(f"{name} --method", "yazma isteğidir")
        elif flag_hit(flag, _WGET_WRITE, "rmPxNckKp"):
            return _write(f"{name} {flag}", "dosya yazar veya veri gönderir")
    if not to_stdout:
        return _write(name, "varsayılan olarak dosyaya indirir; okuma için `-O -` kullanın")
    return _read(name, "standart çıktıya indirme")


# ---------------------------------------------------------------- service managers / packages


def _first_positional(args: Sequence[str], with_arg: Iterable[str] = ()) -> tuple[str | None, list[str]]:
    """First non-option argument (skipping values of options in ``with_arg``) and what follows."""
    takes = frozenset(with_arg)
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            i += 1
            break
        if a.startswith("-") and a != "-":
            if "=" not in a and a in takes:
                i += 2
            else:
                i += 1
            continue
        break
    if i >= len(args):
        return None, []
    return args[i], list(args[i + 1 :])


def _verbs(
    read: Iterable[str],
    *,
    with_arg: Iterable[str] = (),
    empty_read: bool = True,
    prefixes: tuple[str, ...] = (),
    sub: dict[str, frozenset[str]] | None = None,
    write_flags: tuple[str, ...] = (),
    note: str = "yazma/yönetim işlemi",
) -> Validator:
    read_set = frozenset(read)
    takes = tuple(with_arg)
    subs = sub or {}

    def check(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
        if write_flags:
            opts, _ = parse_opts(args)
            hit = _any_flag(opts, write_flags)
            if hit:
                return _write(f"{name} {hit}", "dosyaya yazar veya durumu değiştirir")
        verb, rest = _first_positional(args, takes)
        if verb is None:
            return _read(name) if empty_read else _unknown(name, "alt komutsuz; bilinmeyen sayılır")
        if verb in subs:
            second, _ = _first_positional(rest, takes)
            if second is not None and second in subs[verb]:
                return _read(f"{name} {verb} {second}")
            return _write(f"{name} {verb} {second or ''}".rstrip(), note)
        if verb in read_set or (prefixes and verb.startswith(prefixes)):
            return _read(f"{name} {verb}")
        return _write(f"{name} {verb}", note)

    return check


_SYSTEMCTL_WITH_ARG = _wordt(
    """
-t --type --state -p --property -H --host -M --machine -n --lines -o --output --root --image -s
--signal --what --job-mode --preset-mode --timestamp --message -P --kill-whom
"""
)
_v_systemctl = _verbs(
    _words("status show cat help is-active is-enabled is-failed is-system-running get-default show-environment"),
    with_arg=_SYSTEMCTL_WITH_ARG,
    prefixes=("list-",),
)

_JOURNALCTL_WRITE = _wordt(
    """
--vacuum-size --vacuum-time --vacuum-files --rotate --flush --sync --relinquish-var
--smart-relinquish-var --setup-keys --update-catalog --cursor-file
"""
)


def _v_journalctl(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args)
    hit = _any_flag(opts, _JOURNALCTL_WRITE)
    if hit:
        return _write(f"{name} {hit}", "günlükleri değiştirir veya siler")
    return _read(name)


def _v_service(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    if args == ["--status-all"] or (len(args) == 2 and args[1] == "status"):
        return _read(name)
    return _write(name, "servisi değiştirir/başlatır/durdurur")


def _v_hostnamectl(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    verb, rest = _first_positional(args)
    if verb is None or verb == "status":
        return _read(name)
    if verb in ("hostname", "icon-name", "chassis", "deployment", "location") and not rest:
        return _read(f"{name} {verb}")
    return _write(f"{name} {verb}", "sistem kimliğini değiştirir")


def _v_dpkg(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args)
    allowed = _wordt(
        "--list --listfiles --status --search --print-avail --get-selections --audit --print-architecture "
        "--print-foreign-architectures --compare-versions --version --help --verify"
    )
    if opts and all(flag_hit(f, allowed, "lLsSpCV") for f, _ in opts):
        return _read(name)
    return _write(name, "paket kurar/kaldırır")


def _v_rpm(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args)
    writes = ("--install", "--upgrade", "--freshen", "--erase", "--import", "--rebuilddb", "--initdb", "--setperms")
    if _any_flag(opts, (*writes, "--setugids", "--restore", "--reinstall"), "iUFe"):
        return _write(name, "paket kurar/kaldırır")
    if _any_flag(opts, ("--query", "--verify", "--version", "--help"), "qV"):
        return _read(name)
    return _write(name, "salt okuma sorgusu değil")


def _v_tar(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    flags = list(args)
    if flags and not flags[0].startswith("-"):
        flags[0] = "-" + flags[0]  # old style: `tar tvf x.tar`
    opts, _ = parse_opts(flags, short_with_arg="fCbHKLNTVgX", long_with_arg=("--file", "--directory"))
    exec_opts = _wordt(
        "--to-command --use-compress-program --checkpoint-action --info-script --new-volume-script "
        "--rsh-command --rmt-command"
    )
    if _any_flag(opts, exec_opts, "IF"):
        return _unknown(name, "harici program çalıştırır")
    writes = ("--extract", "--get", "--create", "--append", "--update", "--delete", "--catenate", "--concatenate")
    if _any_flag(opts, writes, "xcruA"):
        return _write(name, "arşiv yazar veya dosya çıkarır")
    if _any_flag(opts, ("--list",), "t"):
        return _read(name, "-t arşivi listeler")
    return _write(name, "salt okuma (listeleme) kipi değil")


def _v_compress(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="S", long_with_arg=("--suffix",))
    if _any_flag(opts, ("--stdout", "--to-stdout", "--list", "--test"), "clt"):
        return _read(name, "standart çıktıya/listeleme")
    return _write(name, "dosyaları yerinde sıkıştırır/açar")


def _v_unzip(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="dx")
    if _any_flag(opts, (), "lvtpZ"):
        return _read(name, "listeleme/test")
    return _write(name, "dosya çıkarır")


def _v_iptables(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="tjio")
    writes = _wordt(
        "--append --delete --insert --replace --flush --zero --new-chain --delete-chain --policy --rename-chain"
    )
    if _any_flag(opts, writes, "ADIRFZNXPE"):
        return _write(name, "güvenlik duvarı kurallarını değiştirir")
    if _any_flag(opts, ("--list", "--list-rules"), "LS"):
        return _read(name)
    return _write(name, "salt okuma (listeleme) kipi değil")


def _v_iptables_save(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="Mtf")
    if _any_flag(opts, ("--file",), "f"):
        return _write(name, "dosyaya yazar")
    return _read(name)


# ---------------------------------------------------------------- containers / clusters / git

_DOCKER_WITH_ARG = _wordt(
    """
-H --host -c --context --config -l --log-level --tlscacert --tlscert --tlskey
"""
)
_DOCKER_OPT_WITH_ARG = _wordt(
    """
-f --filter --format -n --last --tail --since --until --type -s --size
"""
)
_DOCKER_READ = frozenset(
    {"ps", "logs", "inspect", "stats", "images", "top", "version", "info", "port", "diff", "history", "events"}
)
_DOCKER_SUB = {
    "container": frozenset({"ls", "list", "ps", "logs", "inspect", "stats", "top", "port", "diff"}),
    "image": frozenset({"ls", "list", "inspect", "history"}),
    "network": frozenset({"ls", "list", "inspect"}),
    "volume": frozenset({"ls", "list", "inspect"}),
    "system": frozenset({"df", "info", "events"}),
    "context": frozenset({"ls", "list", "inspect", "show"}),
    "node": frozenset({"ls", "list", "inspect", "ps"}),
    "service": frozenset({"ls", "list", "inspect", "ps", "logs"}),
    "stack": frozenset({"ls", "list", "ps", "services"}),
    "config": frozenset({"ls", "list", "inspect"}),
    "plugin": frozenset({"ls", "list", "inspect"}),
    "manifest": frozenset({"inspect"}),
}
_COMPOSE_WITH_ARG = _wordt(
    """
-f --file -p --project-name --project-directory --env-file --profile --ansi --parallel --progress
"""
)
_COMPOSE_READ = frozenset({"ps", "logs", "config", "top", "images", "ls", "version", "events", "port"})


def _compose(name: str, args: list[str]) -> Verdict:
    verb, _ = _first_positional(args, _COMPOSE_WITH_ARG)
    if verb is None:
        return _read(name)
    if verb in _COMPOSE_READ:
        return _read(f"{name} {verb}")
    return _write(f"{name} {verb}", "konteynerleri değiştirir")


def _v_docker(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    sub, rest = _first_positional(args, _DOCKER_WITH_ARG)
    if sub is None:
        return _read(name)
    if sub == "compose":
        return _compose(f"{name} compose", rest)
    if sub in _DOCKER_SUB:
        second, _ = _first_positional(rest, _DOCKER_OPT_WITH_ARG)
        if second is not None and second in _DOCKER_SUB[sub]:
            return _read(f"{name} {sub} {second}")
        return _write(f"{name} {sub} {second or ''}".rstrip(), "konteyner ortamını değiştirir")
    if sub in _DOCKER_READ:
        return _read(f"{name} {sub}")
    return _write(f"{name} {sub}", "konteyner ortamını değiştirir")


def _v_docker_compose(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    return _compose(name, args)


_KUBE_WITH_ARG = _wordt(
    """
-n --namespace --context --kubeconfig -s --server --cluster --user --token --as --as-group --as-uid
--certificate-authority --client-certificate --client-key --request-timeout -v --v --vmodule
--cache-dir --tls-server-name --username --password -l --selector -o --output -f --filename -c
--container --field-selector --sort-by --since --since-time --tail --template -L --label-columns
--chunk-size --limit-bytes --max-log-requests --raw --subresource --for --timeout -k --kustomize
"""
)
_KUBE_READ = _words(
    """
get describe logs top explain version api-resources api-versions cluster-info events wait
"""
)
_KUBE_SUB = {
    "config": frozenset({"view", "get-contexts", "current-context", "get-clusters", "get-users"}),
    "auth": frozenset({"can-i", "whoami"}),
    "rollout": frozenset({"status", "history"}),
}
_KUBE_WRITE_FLAGS = ("--log-file", "--profile-output", "--output-directory")


def _v_kubectl(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args)
    hit = _any_flag(opts, _KUBE_WRITE_FLAGS)
    if hit:
        return _write(f"{name} {hit}", "dosyaya yazar")
    sub, rest = _first_positional(args, _KUBE_WITH_ARG)
    if sub is None:
        return _read(name)
    if sub in _KUBE_SUB:
        second, _ = _first_positional(rest, _KUBE_WITH_ARG)
        if second is not None and second in _KUBE_SUB[sub]:
            return _read(f"{name} {sub} {second}")
        return _write(f"{name} {sub} {second or ''}".rstrip(), "küme durumunu değiştirir")
    if sub in _KUBE_READ:
        return _read(f"{name} {sub}")
    return _write(f"{name} {sub}", "küme durumunu değiştirir")


_v_helm = _verbs(
    {"list", "ls", "status", "get", "history", "hist", "show", "inspect", "search", "version", "env", "lint"}
    | {"template", "verify"},
    with_arg=_wordt(
        "-n --namespace --kube-context --kubeconfig --registry-config --repository-cache --repository-config "
        "--kube-apiserver --kube-as-user --kube-as-group --kube-ca-file --kube-token --burst-limit --qps "
        "-o --output --revision --max -f --values --set --version"
    ),
    sub={
        "repo": frozenset({"list", "ls"}),
        "plugin": frozenset({"list", "ls"}),
        "dependency": frozenset({"list", "ls"}),
        "dep": frozenset({"list", "ls"}),
    },
    write_flags=("--output-dir",),
    note="sürüm/küme durumunu değiştirir",
)

_GIT_WITH_ARG = frozenset({"-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--list-cmds"})
_GIT_READ = _words(
    """
status log diff show rev-parse ls-files ls-tree ls-remote cat-file blame annotate shortlog describe
grep rev-list name-rev merge-base count-objects for-each-ref show-ref whatchanged cherry show-branch
var help version check-ignore check-attr verify-commit verify-tag range-diff diff-tree diff-index
diff-files
"""
)


def _git_sub(sub: str, rest: list[str]) -> Verdict:
    label = f"git {sub}"
    if sub == "branch":
        opts, pos = parse_opts(rest)
        writes = _wordt(
            "--delete --move --copy --force --set-upstream-to --unset-upstream --edit-description --track "
            "--no-track --create-reflog"
        )
        if _any_flag(opts, writes, "dDmMcCfut"):
            return _write(label, "branch siler/taşır/değiştirir")
        listing = ("--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at")
        if pos and not _any_flag(opts, listing, "l"):
            return _write(label, "yeni branch oluşturur")
        return _read(label)
    if sub == "tag":
        opts, pos = parse_opts(rest)
        writes = ("--annotate", "--sign", "--local-user", "--force", "--delete", "--message", "--file", "--edit")
        if _any_flag(opts, writes, "asufdmFe"):
            return _write(label, "etiket oluşturur/siler")
        listing = ("--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--verify")
        if pos and not _any_flag(opts, listing, "lnv"):
            return _write(label, "yeni etiket oluşturur")
        return _read(label)
    if sub == "remote":
        _, pos = parse_opts(rest)
        if not pos or pos[0] in ("show", "get-url"):
            return _read(label)
        return _write(label, "uzak depo ayarlarını değiştirir")
    if sub == "config":
        opts, pos = parse_opts(
            rest, short_with_arg="f", long_with_arg=("--file", "--blob", "--type", "--default", "--comment")
        )
        writes = ("--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit")
        if _any_flag(opts, writes, "e"):
            return _write(label, "yapılandırmayı değiştirir")
        if pos and pos[0] in ("get", "list"):
            return _read(label)
        if pos and pos[0] in ("set", "unset", "rename-section", "remove-section", "edit"):
            return _write(label, "yapılandırmayı değiştirir")
        gets = ("--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "--get-color", "--get-colorbool")
        if _any_flag(opts, gets, "l") or len(pos) <= 1:
            return _read(label)
        return _write(label, "yapılandırmayı değiştirir")
    if sub == "reflog":
        _, pos = parse_opts(rest)
        if pos and pos[0] in ("expire", "delete", "drop"):
            return _write(label, "reflog kayıtlarını siler")
        return _read(label)
    if sub == "stash":
        _, pos = parse_opts(rest)
        if pos and pos[0] in ("list", "show"):
            return _read(f"{label} {pos[0]}")
        return _write(label, "çalışma ağacını değiştirir")
    if sub in ("worktree", "notes", "submodule"):
        _, pos = parse_opts(rest)
        reads = {"worktree": ("list",), "notes": ("list", "show"), "submodule": ("status", "summary")}[sub]
        if (not pos and sub != "worktree") or (pos and pos[0] in reads):
            return _read(label)
        return _write(label, "depoyu değiştirir")
    if sub in _GIT_READ:
        opts, _ = parse_opts(rest)
        hit = _any_flag(opts, ("--output", "--ext-diff", "--open-files-in-pager"), "O" if sub == "grep" else "")
        if hit:
            return _unknown(f"{label} {hit}", "dosyaya yazar veya harici program çalıştırır")
        return _read(label)
    return _write(label, "salt okuma listesinde değil; depoyu değiştirebilir")


def _v_git(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-c", "--config-env") or a.startswith(("--config-env=", "--exec-path=")) or re.match(r"^-c.", a):
            return _unknown(f"{name} {a}", "yapılandırmayı değiştirerek komut çalıştırabilir")
        if a in _GIT_WITH_ARG:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        break
    if i >= len(args):
        return _read(name)
    return _git_sub(args[i], list(args[i + 1 :]))


# ---------------------------------------------------------------- wrappers


def _v_env(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            i += 1
            break
        if a in ("-i", "--ignore-environment", "-0", "--null", "-"):
            i += 1
        elif a in ("-u", "--unset", "-C", "--chdir"):
            i += 2
        elif a.startswith(("--unset=", "--chdir=")) or re.match(r"^-[uC].", a):
            i += 1
        elif a.startswith("-"):
            return _unknown(f"{name} {a}", "seçeneği desteklenmiyor; bilinmeyen sayılır")
        else:
            break
    while i < len(args) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", args[i]):
        var, _, value = args[i].partition("=")
        verdict = assignment_verdict(var, value)
        if verdict is not None:
            return verdict
        i += 1
    if i >= len(args):
        return _read(name, "ortam değişkenlerini listeler")
    return sh.argv(args[i:], raws[i:])


def _skip_options(args: list[str], with_arg: Iterable[str]) -> int:
    takes = frozenset(with_arg)
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        if args[i] == "--":
            return i + 1
        i += 2 if args[i] in takes else 1
    return i


def _v_nice(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = _skip_options(args, ("-n", "--adjustment"))
    return sh.inner(name, args[i:], raws[i:])


def _v_timeout(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = _skip_options(args, ("-s", "-k", "--signal", "--kill-after")) + 1  # duration
    return sh.inner(name, args[i:], raws[i:])


def _v_stdbuf(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = _skip_options(args, ("-i", "-o", "-e", "--input", "--output", "--error"))
    return sh.inner(name, args[i:], raws[i:])


def _v_passthrough(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    return sh.inner(name, args, raws)


def _v_time(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        a = args[i]
        if a in ("-o", "--output") or a.startswith("--output="):
            return _write(f"{name} -o", "sonucu dosyaya yazar")
        if a == "--":
            i += 1
            break
        i += 2 if a in ("-f", "--format") else 1
    return sh.inner(name, args[i:], raws[i:])


def _v_command(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    if args and args[0] in ("-v", "-V"):
        return _read(name, "-v komut yolunu gösterir")
    i = 0
    while i < len(args) and args[i] in ("-p", "--"):
        i += 1
    return sh.inner(name, args[i:], raws[i:])


def _v_exec(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    i = _skip_options(args, ("-a",))
    return sh.inner(name, args[i:], raws[i:])


def _v_ionice(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    opts, _ = parse_opts(args, short_with_arg="cnpPu")
    if _any_flag(opts, ("--pid", "--pgid", "--uid"), "pPu"):
        return _write(name, "başka süreçlerin önceliğini değiştirir")
    i = _skip_options(args, ("-c", "-n", "--class", "--classdata"))
    return sh.inner(name, args[i:], raws[i:])


def _v_xargs(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    with_arg = ("-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "--max-args", "-P", "--max-procs")
    i = _skip_options(args, (*with_arg, "-s", "--max-chars", "--process-slot-var"))
    inner = args[i:]
    if not inner:
        return _read(name, "varsayılan olarak echo çalıştırır")
    prog = inner[0].rpartition("/")[2]
    spec = _COMMANDS.get(prog)
    if spec is not None and spec.sensitive:
        return _unknown(f"{name} {prog}", "çalışma anında eklenen argümanlar denetlenemiyor")
    return sh.argv(inner, raws[i:])


def _v_shell(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    c_flag = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            i += 1
            break
        if a.startswith("--"):
            i += 1
            continue
        if a[:1] in "-+" and len(a) > 1:
            if a[0] == "-" and "c" in a[1:]:
                c_flag = True
            i += 2 if a in ("-o", "+o", "-O", "+O") else 1
            continue
        break
    if not c_flag or i >= len(args):
        return _unknown(name, "betik dosyası/standart girdi çalıştırır; içerik denetlenemez")
    expansion, _ = scan_word(raws[i])
    if expansion:
        return _unknown(f"{name} -c", "betiği çalışma anında oluşturuluyor; denetlenemez")
    return sh.script(f"{name} -c", args[i])


def _v_watch(sh: _Shell, name: str, args: list[str], raws: list[str]) -> Verdict:
    exec_mode = False
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        a = args[i]
        if a == "--":
            i += 1
            break
        if a in ("-x", "--exec"):
            exec_mode = True
        i += 2 if a in ("-n", "--interval", "-q", "--equexit") else 1
    if i >= len(args):
        return _read(name)
    if exec_mode:
        return sh.argv(args[i:], raws[i:])
    return sh.script(name, " ".join(args[i:]))


_SIMPLE = _words(
    """
ls dir vdir cat tac head tail grep egrep fgrep zgrep zegrep zfgrep zcat bzcat xzcat zstdcat wc cut
tr nl column fold rev paste join comm diff cmp md5sum sha1sum sha224sum sha256sum sha384sum
sha512sum b2sum cksum sum stat readlink realpath basename dirname pwd echo test [ [[ ]] which
whereis type id whoami groups users who w last logname uname uptime cal free df du ps pgrep pstree
pidof vmstat iostat mpstat lsblk lscpu lsmem lspci lsusb lsof netstat ping ping6 traceroute
traceroute6 tracepath dig nslookup host getent printenv locale nproc arch getconf tty sleep seq yes
jq expr od hexdump strings findmnt lsattr getfacl namei true false : cd pushd popd dirs wait jobs
exit return times help shopt umask ulimit set unset fmt pr expand unexpand numfmt factor base64
base32 apt-cache dpkg-query
"""
)

_KNOWN_WRITE: dict[str, str] = {
    **dict.fromkeys(
        ("rm", "rmdir", "unlink", "shred", "truncate", "mv", "cp", "dd", "ln", "touch", "mkdir", "mknod", "mkfifo"),
        "dosya sistemini değiştirir",
    ),
    **dict.fromkeys(
        ("chmod", "chown", "chgrp", "chattr", "setfacl", "install", "patch", "split", "csplit"),
        "dosyaları değiştirir",
    ),
    **dict.fromkeys(
        ("rsync", "scp", "sftp", "ssh", "nc", "ncat", "netcat", "socat", "telnet"), "başka bir hosta bağlanır"
    ),
    "sudo": "yetki yükseltir; yazma sayılır",
    **dict.fromkeys(("su", "doas", "pkexec", "runuser"), "yetki/kullanıcı değiştirir; yazma sayılır"),
    **dict.fromkeys(("kill", "pkill", "killall"), "süreçleri sonlandırır"),
    **dict.fromkeys(("reboot", "shutdown", "poweroff", "halt", "init", "telinit"), "sistemi yeniden başlatır/kapatır"),
    **dict.fromkeys(
        ("apt-get", "yum", "dnf", "zypper", "apk", "pacman", "snap", "pip", "pip3", "npm", "yarn", "pnpm", "gem"),
        "paket kurar/kaldırır",
    ),
    **dict.fromkeys(("cargo", "make", "go"), "derleme/kurulum çalıştırır"),
    **dict.fromkeys(
        ("useradd", "userdel", "usermod", "groupadd", "groupdel", "passwd", "chpasswd", "visudo"),
        "kullanıcı hesaplarını değiştirir",
    ),
    **dict.fromkeys(("vi", "vim", "nvim", "nano", "emacs", "ed"), "dosya düzenler"),
    **dict.fromkeys(("umount", "mkfs", "fdisk", "parted", "swapon", "swapoff"), "diskleri değiştirir"),
    **dict.fromkeys(("python", "python3", "perl", "ruby", "node", "php", "lua", "bash", "zsh"), "betik yorumlayıcısı"),
    **dict.fromkeys(("psql", "mysql", "mariadb", "mongo", "mongosh", "redis-cli", "sqlite3"), "veritabanı istemcisi"),
    **dict.fromkeys(("eval", "source", ".", "trap", "let", "enable", "fish", "csh", "tcsh"), "içeriği denetlenemez"),
    **dict.fromkeys(("logger", "wall", "write", "mail", "sendmail", "at", "batch"), "mesaj/görev gönderir"),
    **dict.fromkeys(("zip", "gzip", "gunzip", "bzip2", "xz", "zstd"), "dosyaları yerinde değiştirir"),
}

_COMMANDS: dict[str, _Cmd] = {
    **{n: _Cmd(_v_simple) for n in _SIMPLE},
    # argument-aware read commands
    "sort": _Cmd(_v_sort, sensitive=True),
    "uniq": _Cmd(_max_positionals(1, "ikinci argümana (çıktı dosyası) yazar"), sensitive=True),
    "xxd": _Cmd(_max_positionals(1, "ikinci argümana (çıktı dosyası) yazar"), sensitive=True),
    "rg": _Cmd(_v_rg, sensitive=True),
    "less": _Cmd(_v_pager, sensitive=True),
    "more": _Cmd(_v_pager, sensitive=True),
    "date": _Cmd(_v_date, sensitive=True),
    "hostname": _Cmd(_v_hostname, sensitive=True),
    "top": _Cmd(_v_top, sensitive=True),
    "ss": _Cmd(_v_ss, sensitive=True),
    "ip": _Cmd(_v_ip, sensitive=True),
    "ifconfig": _Cmd(_v_ifconfig, sensitive=True),
    "route": _Cmd(_v_route, sensitive=True),
    "arp": _Cmd(_v_arp, sensitive=True),
    "file": _Cmd(_v_file, sensitive=True),
    "tree": _Cmd(_v_tree, sensitive=True),
    "yq": _Cmd(_v_yq, sensitive=True),
    "dmesg": _Cmd(_v_dmesg, sensitive=True),
    "sysctl": _Cmd(_v_sysctl, sensitive=True),
    "mount": _Cmd(_v_mount, sensitive=True),
    "crontab": _Cmd(_v_crontab, sensitive=True),
    "lastlog": _Cmd(_v_lastlog, sensitive=True),
    "history": _Cmd(_v_history, sensitive=True),
    "export": _Cmd(_v_names, sensitive=True),
    "declare": _Cmd(_v_names, sensitive=True),
    "typeset": _Cmd(_v_names, sensitive=True),
    "local": _Cmd(_v_names, sensitive=True),
    "readonly": _Cmd(_v_names, sensitive=True),
    "read": _Cmd(_v_read_builtin, sensitive=True),
    "mapfile": _Cmd(_v_read_builtin, sensitive=True),
    "readarray": _Cmd(_v_read_builtin, sensitive=True),
    "printf": _Cmd(_v_printf, sensitive=True),
    "alias": _Cmd(_v_alias, sensitive=True),
    "hash": _Cmd(_v_hash, sensitive=True),
    "tee": _Cmd(_v_tee),
    "find": _Cmd(_v_find, sensitive=True),
    "sed": _Cmd(_v_sed, sensitive=True),
    "awk": _Cmd(_v_awk, sensitive=True),
    "gawk": _Cmd(_v_awk, sensitive=True),
    "mawk": _Cmd(_v_awk, sensitive=True),
    "nawk": _Cmd(_v_awk, sensitive=True),
    "curl": _Cmd(_v_curl, sensitive=True),
    "wget": _Cmd(_v_wget, sensitive=True),
    "systemctl": _Cmd(_v_systemctl, sensitive=True),
    "journalctl": _Cmd(_v_journalctl, sensitive=True),
    "service": _Cmd(_v_service, sensitive=True),
    "loginctl": _Cmd(
        _verbs({"session-status", "user-status", "seat-status"}, prefixes=("list-", "show-")), sensitive=True
    ),
    "timedatectl": _Cmd(
        _verbs({"status", "show", "list-timezones", "timesync-status", "show-timesync"}), sensitive=True
    ),
    "hostnamectl": _Cmd(_v_hostnamectl, sensitive=True),
    "networkctl": _Cmd(_verbs({"list", "status", "lldp", "label", "cat"}), sensitive=True),
    "resolvectl": _Cmd(
        _verbs({"status", "query", "statistics", "show-cache", "show-server-state", "service", "openpgp", "tlsa"}),
        sensitive=True,
    ),
    "ufw": _Cmd(
        _verbs(
            {"status", "show", "version"}, sub={"app": frozenset({"list", "info"})}, note="güvenlik duvarını değiştirir"
        ),
        sensitive=True,
    ),
    "nft": _Cmd(_verbs({"list"}, with_arg=("-I", "--includepath", "-D", "--define"), write_flags=("--file",)), True),
    "apt": _Cmd(
        _verbs(
            {"list", "show", "search", "policy", "depends", "rdepends", "showsrc", "changelog"},
            note="paket kurar/kaldırır",
        ),
        sensitive=True,
    ),
    "dpkg": _Cmd(_v_dpkg, sensitive=True),
    "rpm": _Cmd(_v_rpm, sensitive=True),
    "tar": _Cmd(_v_tar, sensitive=True),
    **{n: _Cmd(_v_compress, sensitive=True) for n in ("gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "zstd")},
    "unzip": _Cmd(_v_unzip, sensitive=True),
    "iptables": _Cmd(_v_iptables, sensitive=True),
    "ip6tables": _Cmd(_v_iptables, sensitive=True),
    "iptables-save": _Cmd(_v_iptables_save, sensitive=True),
    "ip6tables-save": _Cmd(_v_iptables_save, sensitive=True),
    "docker": _Cmd(_v_docker, sensitive=True),
    "podman": _Cmd(_v_docker, sensitive=True),
    "nerdctl": _Cmd(_v_docker, sensitive=True),
    "docker-compose": _Cmd(_v_docker_compose, sensitive=True),
    "kubectl": _Cmd(_v_kubectl, sensitive=True),
    "oc": _Cmd(_v_kubectl, sensitive=True),
    "helm": _Cmd(_v_helm, sensitive=True),
    "git": _Cmd(_v_git, sensitive=True),
    # wrappers: the wrapped command is classified on its own
    "env": _Cmd(_v_env, sensitive=True),
    "nice": _Cmd(_v_nice, sensitive=True),
    "nohup": _Cmd(_v_passthrough, sensitive=True),
    "builtin": _Cmd(_v_passthrough, sensitive=True),
    "timeout": _Cmd(_v_timeout, sensitive=True),
    "stdbuf": _Cmd(_v_stdbuf, sensitive=True),
    "time": _Cmd(_v_time, sensitive=True),
    "command": _Cmd(_v_command, sensitive=True),
    "exec": _Cmd(_v_exec, sensitive=True),
    "ionice": _Cmd(_v_ionice, sensitive=True),
    "xargs": _Cmd(_v_xargs, sensitive=True),
    "sh": _Cmd(_v_shell, sensitive=True),
    "dash": _Cmd(_v_shell, sensitive=True),
    "bash": _Cmd(_v_shell, sensitive=True),
    "watch": _Cmd(_v_watch, sensitive=True),
}


# ---------------------------------------------------------------- shell entry points


def _fallback(text: str, depth: int) -> ClassifiedCommand:
    """Strict tokenizer used when bashlex cannot parse. Quotes are lost here, so every glob or
    ``$`` is treated as an expansion. Grouping, substitution and heredocs are unknown."""
    note = "Kabuk ayrıştırıcısı komutu çözemedi; basit ayrıştırma kullanıldı"
    if any(tok in text for tok in ("`", "$(", "<(", ">(")):
        return _single(UNKNOWN, "Komut yerine geçen ifade ayrıştırılamadı; bilinmeyen sayılır", parsed=False, text=text)
    lexer = shlex.shlex(text.replace("\n", " ; "), posix=True, punctuation_chars=";&|<>()")
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return _single(
            UNKNOWN, "Komut ayrıştırılamadı (kapanmamış tırnak); bilinmeyen sayılır", parsed=False, text=text
        )
    sh = _Shell(text, depth)
    commands: list[tuple[list[str], list[Verdict]]] = [([], [])]
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok and all(c in ";&|" for c in tok):
            commands.append(([], []))
            i += 1
            continue
        if tok and any(c in "()" for c in tok):
            return _single(UNKNOWN, "Gruplama/alt kabuk ayrıştırılamadı; bilinmeyen sayılır", parsed=False, text=text)
        if tok and all(c in "<>&" for c in tok) and any(c in "<>" for c in tok):
            target = tokens[i + 1] if i + 1 < len(tokens) else ""
            if tok in ("<<", "<<-"):
                return _single(UNKNOWN, "Heredoc ayrıştırılamadı; bilinmeyen sayılır", parsed=False, text=text)
            if ">" in tok and not (tok == ">&" and (target.isdigit() or target == "-")) and target not in _SINKS:
                commands[-1][1].append((WRITE, f"Dosyaya yönlendirme (`{tok} {target}`) yazma işlemidir"))
            i += 2
            continue
        commands[-1][0].append(tok)
        i += 1
    for argv, verdicts in commands:
        if not argv and not verdicts:
            continue
        j = 0
        while j < len(argv) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*\+?=", argv[j]):
            var, _, value = argv[j].partition("=")
            verdict = assignment_verdict(var, value)
            if verdict is not None:
                verdicts.append(verdict)
            j += 1
        rest = argv[j:]
        if rest:
            verdicts.append(sh.argv(rest, rest))
        elif not verdicts:
            verdicts.append((READ, "Yalnız kabuk değişkeni ataması"))
        sh.add(" ".join(argv), verdicts)
    if not sh.segments:
        return ClassifiedCommand(READ, ("Boş komut",), (), False)
    return _from_segments(sh.segments, parsed=False, extra=(note,))


def _classify_shell(command: str, depth: int) -> ClassifiedCommand:
    text = command.strip()
    if not text:
        return ClassifiedCommand(READ, ("Boş komut",), (), True)
    if len(text) > MAX_SHELL_LENGTH:
        return _single(UNKNOWN, "Komut çok uzun; bilinmeyen sayılır", parsed=False, text=text[:200])
    if _CONTROL_CHARS.search(text):
        return _single(UNKNOWN, "Komut kontrol karakterleri içeriyor; bilinmeyen sayılır", parsed=False, text=text)
    if "$'" in text or '$"' in text:
        return _single(
            UNKNOWN, "ANSI-C/yerel tırnaklama ($'…') desteklenmiyor; bilinmeyen sayılır", parsed=False, text=text
        )
    try:
        trees = bashlex.parse(text)
    except Exception:  # bashlex raises ParsingError, NotImplementedError and assorted internals
        return _fallback(text, depth)
    sh = _Shell(text, depth)
    try:
        for tree in trees:
            sh.visit(tree)
    except Exception:
        return _single(UNKNOWN, "Komut ağacı işlenemedi; bilinmeyen sayılır", parsed=False, text=text)
    if not sh.segments:
        return ClassifiedCommand(READ, ("Yalnız yorum",), (), True)
    return _from_segments(sh.segments, parsed=True)


def classify_shell(command: str) -> ClassifiedCommand:
    """Classify a shell command line as it will be run by ``/bin/sh -c``."""
    return _classify_shell(command, 0)


# ============================================================================ SQL

SQL_DIALECTS: dict[str, str] = {"postgres": "postgres", "mysql": "mysql", "sqlite": "sqlite", "mssql": "tsql"}
MAX_SQL_LENGTH = 200_000


def _modifying_types() -> tuple[type[exp.Expr], ...]:
    names = _wordt(
        "Insert Update Delete Merge Create Drop Alter TruncateTable Command Copy Grant Revoke Set Transaction "
        "Commit Rollback Use Execute LoadData Kill Analyze Attach Detach"
    )
    return tuple(getattr(exp, n) for n in names if hasattr(exp, n))


_MODIFYING = _modifying_types()

_SIDE_EFFECT_FUNCTIONS = _words(
    # postgres
    """
pg_terminate_backend pg_cancel_backend pg_reload_conf pg_rotate_logfile pg_promote pg_switch_wal
pg_switch_xlog pg_create_restore_point pg_start_backup pg_stop_backup pg_backup_start pg_backup_stop
set_config setval nextval lo_import lo_export lo_unlink lo_create lo_creat lo_put lo_from_bytea
lo_truncate dblink dblink_exec dblink_connect pg_file_write pg_file_unlink pg_file_rename pg_file_sync
pg_advisory_lock pg_advisory_lock_shared pg_advisory_xact_lock pg_advisory_xact_lock_shared
pg_try_advisory_lock pg_try_advisory_lock_shared pg_try_advisory_xact_lock pg_notify
pg_logical_emit_message pg_replication_slot_advance pg_drop_replication_slot
pg_create_physical_replication_slot pg_create_logical_replication_slot pg_stat_reset
pg_stat_reset_shared pg_stat_reset_single_table_counters pg_stat_statements_reset pg_wal_replay_pause
pg_wal_replay_resume pg_import_system_collations
"""
    # mysql
    "get_lock release_lock release_all_locks"
    # sqlite (CLI / extensions)
    " load_extension writefile edit"
)

_READ_PRAGMAS_CALL = _words(
    """
table_info table_xinfo index_list index_info index_xinfo foreign_key_list foreign_key_check
integrity_check quick_check table_list
"""
)
_READ_PRAGMAS = _READ_PRAGMAS_CALL | _words(
    """
database_list compile_options collation_list function_list module_list pragma_list user_version
schema_version application_id page_count page_size freelist_count encoding journal_mode data_version
max_page_count cache_size busy_timeout foreign_keys auto_vacuum synchronous temp_store locking_mode
mmap_size wal_autocheckpoint recursive_triggers secure_delete query_only cell_size_check
trusted_schema
"""
)


def split_sql(sql: str, kind: str) -> list[str]:
    """Split into statements with the dialect's tokenizer (strings/comments respected)."""
    dialect = Dialect.get_or_raise(SQL_DIALECTS[kind])
    statements: list[str] = []
    start = 0
    seen = False
    for tok in dialect.tokenize(sql):
        if tok.token_type == TokenType.SEMICOLON:
            if seen:
                statements.append(sql[start : tok.start].strip())
            start = tok.end + 1
            seen = False
        else:
            seen = True
    if seen:
        statements.append(sql[start:].strip())
    return [s for s in statements if s]


def _function_names(node: exp.Expr) -> set[str]:
    names: set[str] = set()
    for f in node.find_all(exp.Func):
        names.add(f.sql_name().lower())
        if isinstance(f, exp.Anonymous):
            names.add(str(f.this).lower())
    return names


def _classify_query(q: exp.Expr) -> Verdict:
    if q.find(exp.Into) is not None:
        return WRITE, "SELECT … INTO yeni tablo/değişken oluşturur"
    if q.find(exp.Lock) is not None:
        return WRITE, "FOR UPDATE/SHARE satır kilidi alır"
    for node in q.find_all(*_MODIFYING):
        return WRITE, f"Veri değiştiren alt ifade içeriyor ({node.key.upper()})"
    for name in sorted(_function_names(q) & _SIDE_EFFECT_FUNCTIONS):
        return WRITE, f"`{name}()` yan etkili bir fonksiyondur"
    return READ, "SELECT okuma işlemidir"


def _classify_explain(rest: str, dialect: str, depth: int) -> Verdict:
    analyze = False
    s = rest.strip()
    m = re.match(r"^\((?P<opts>[^)]*)\)\s*", s)
    if m:
        for part in m.group("opts").upper().split(","):
            words = part.split()
            if words and words[0] in ("ANALYZE", "ANALYSE"):
                analyze = not (len(words) > 1 and words[1] in ("FALSE", "OFF", "0"))
        s = s[m.end() :]
    while True:
        m = re.match(r"^(ANALY[SZ]E|VERBOSE|EXTENDED|PARTITIONS|QUERY\s+PLAN|FORMAT\s*=\s*\w+)\s+", s, re.IGNORECASE)
        if not m:
            break
        if m.group(1).upper().startswith("ANALY"):
            analyze = True
        s = s[m.end() :]
    if depth >= 2:
        return UNKNOWN, "İç içe EXPLAIN; bilinmeyen sayılır"
    klass, _ = _classify_statement(s, dialect, depth + 1)
    if klass == READ:
        return READ, "EXPLAIN okuma işlemidir"
    if klass == UNKNOWN:
        return UNKNOWN, "EXPLAIN içindeki ifade ayrıştırılamadı; bilinmeyen sayılır"
    if analyze:
        return WRITE, "EXPLAIN ANALYZE yazma ifadesini gerçekten çalıştırır"
    return READ, "EXPLAIN yalnız planı gösterir (çalıştırmaz)"


def _classify_pragma(stmt: str) -> Verdict:
    m = re.match(r"^\s*PRAGMA\s+(?:[\w\"\[\]`]+\.)?[\"\[`]?(\w+)[\"\]`]?\s*(=|\()?", stmt, re.IGNORECASE)
    if not m:
        return UNKNOWN, "PRAGMA ayrıştırılamadı; bilinmeyen sayılır"
    name, op = m.group(1).lower(), m.group(2)
    if op == "=":
        return WRITE, f"PRAGMA {name} ataması ayarı değiştirir"
    if op == "(" and name not in _READ_PRAGMAS_CALL:
        return WRITE, f"PRAGMA {name}(…) ayarı değiştirir"
    if name in _READ_PRAGMAS:
        return READ, f"PRAGMA {name} okuma işlemidir"
    return WRITE, f"PRAGMA {name} salt okuma listesinde değil"


def _classify_expr(e: exp.Expr, stmt: str, dialect: str, depth: int) -> Verdict:
    if isinstance(e, exp.Query):
        return _classify_query(e)
    if isinstance(e, exp.Describe):
        inner = e.this
        if isinstance(inner, _MODIFYING) or (isinstance(inner, exp.Query) and _classify_query(inner)[0] != READ):
            style = str(e.args.get("style") or "").upper()
            if style.startswith("ANALY") or re.search(r"\bANALY[SZ]E\b", stmt, re.IGNORECASE):
                return WRITE, "EXPLAIN ANALYZE yazma ifadesini gerçekten çalıştırır"
            return READ, "EXPLAIN yalnız planı gösterir (çalıştırmaz)"
        return READ, "DESCRIBE/EXPLAIN okuma işlemidir"
    if isinstance(e, exp.Show):
        return READ, "SHOW okuma işlemidir"
    if isinstance(e, exp.Pragma):
        return _classify_pragma(stmt)
    if isinstance(e, exp.Command):
        name = str(e.this).upper().strip()
        rest = e.expression
        rest_text = str(rest.this) if isinstance(rest, exp.Literal) else (rest.sql() if rest is not None else "")
        if name == "SHOW":
            return READ, "SHOW okuma işlemidir"
        if name in ("EXPLAIN", "DESCRIBE", "DESC"):
            return _classify_explain(rest_text, dialect, depth)
        return WRITE, f"`{name}` yazma/yönetim ifadesidir"
    return WRITE, f"`{e.key.upper()}` yazma/yönetim ifadesidir"


def _classify_statement(stmt: str, dialect: str, depth: int) -> Verdict:
    try:
        parsed = [e for e in sqlglot.parse(stmt, read=dialect) if e is not None]
    except Exception:
        return UNKNOWN, "SQL ayrıştırılamadı; bilinmeyen sayılır"
    if not parsed:
        return READ, "Boş ifade"
    if len(parsed) > 1:
        return UNKNOWN, "Beklenmeyen çoklu ifade; bilinmeyen sayılır"
    return _classify_expr(parsed[0], stmt, dialect, depth)


def classify_sql(sql: str, kind: str) -> ClassifiedCommand:
    """Classify SQL for a db kind (``postgres``/``mysql``/``sqlite``/``mssql``)."""
    if kind not in SQL_DIALECTS:
        raise ValueError(f"not an SQL kind: {kind}")
    if not sql.strip():
        return ClassifiedCommand(READ, ("Boş sorgu",), (), True)
    if len(sql) > MAX_SQL_LENGTH:
        return _single(UNKNOWN, "Sorgu çok uzun; bilinmeyen sayılır", parsed=False, text=sql[:200])
    if "/*!" in sql:
        return _single(UNKNOWN, "MySQL çalıştırılabilir yorumu (/*! … */) içeriyor; bilinmeyen sayılır", parsed=False)
    try:
        statements = split_sql(sql, kind)
    except Exception:
        return _single(UNKNOWN, "Sorgu ayrıştırılamadı; bilinmeyen sayılır", parsed=False, text=sql.strip())
    if not statements:
        return ClassifiedCommand(READ, ("Yalnız yorum",), (), True)
    dialect = SQL_DIALECTS[kind]
    segments: list[Segment] = []
    for idx, stmt in enumerate(statements, 1):
        klass, reason = _classify_statement(stmt, dialect, 0)
        prefix = f"{idx}. ifade: " if len(statements) > 1 else ""
        segments.append(Segment(" ".join(stmt.split()), klass, (prefix + reason,)))
    parsed = all(not (s.klass == UNKNOWN and "ayrıştırılamadı" in s.reasons[0]) for s in segments)
    return _from_segments(segments, parsed=parsed)


# ============================================================================ Redis

_REDIS_READ = _words(
    """
GET MGET GETRANGE SUBSTR STRLEN LCS EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME KEYS SCAN RANDOMKEY
DUMP TOUCH HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSCAN HSTRLEN HRANDFIELD HTTL HPTTL LRANGE
LLEN LINDEX LPOS SMEMBERS SISMEMBER SMISMEMBER SCARD SSCAN SRANDMEMBER SINTER SUNION SDIFF
SINTERCARD ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZREVRANGEBYLEX ZSCORE ZMSCORE
ZCARD ZCOUNT ZLEXCOUNT ZRANK ZREVRANK ZSCAN ZRANDMEMBER ZINTER ZUNION ZDIFF ZINTERCARD XRANGE
XREVRANGE XLEN XPENDING XREAD BITCOUNT BITPOS GETBIT BITFIELD_RO PFCOUNT GEOPOS GEODIST GEOHASH
GEORADIUS_RO GEORADIUSBYMEMBER_RO GEOSEARCH SORT_RO INFO DBSIZE PING ECHO TIME LASTSAVE ROLE EVAL_RO
EVALSHA_RO FCALL_RO JSON.GET JSON.MGET JSON.TYPE JSON.STRLEN JSON.ARRLEN JSON.OBJKEYS JSON.OBJLEN
JSON.RESP FT.SEARCH FT.INFO FT._LIST FT.AGGREGATE FT.EXPLAIN TS.GET TS.MGET TS.RANGE TS.REVRANGE
TS.MRANGE TS.INFO
"""
)
_REDIS_READ_SUB: dict[str, frozenset[str]] = {
    "OBJECT": frozenset({"ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"}),
    "MEMORY": frozenset({"USAGE", "STATS", "DOCTOR", "MALLOC-STATS", "HELP"}),
    "CLIENT": frozenset({"LIST", "INFO", "GETNAME", "ID", "TRACKINGINFO", "GETREDIR", "HELP"}),
    "CONFIG": frozenset({"GET", "HELP"}),
    "SLOWLOG": frozenset({"GET", "LEN", "HELP"}),
    "LATENCY": frozenset({"LATEST", "HISTORY", "DOCTOR", "GRAPH", "HISTOGRAM", "HELP"}),
    "COMMAND": frozenset({"COUNT", "INFO", "DOCS", "LIST", "GETKEYS", "GETKEYSANDFLAGS", "HELP"}),
    "CLUSTER": frozenset({"INFO", "NODES", "SLOTS", "SHARDS", "MYID", "KEYSLOT", "COUNTKEYSINSLOT", "LINKS", "HELP"}),
    "XINFO": frozenset({"STREAM", "GROUPS", "CONSUMERS", "HELP"}),
    "FUNCTION": frozenset({"LIST", "STATS", "DUMP", "HELP"}),
    "SCRIPT": frozenset({"EXISTS", "HELP"}),
    "ACL": frozenset({"WHOAMI", "CAT", "USERS", "HELP"}),
    "PUBSUB": frozenset({"CHANNELS", "NUMSUB", "NUMPAT", "SHARDCHANNELS", "SHARDNUMSUB", "HELP"}),
    "MODULE": frozenset({"LIST", "HELP"}),
}


def split_redis(text: str) -> list[list[str]]:
    """One command per line (``#`` comments allowed); words use shell-style quoting."""
    commands: list[list[str]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        argv = shlex.split(stripped)
        if argv:
            commands.append(argv)
    return commands


def _classify_redis_argv(argv: list[str]) -> Verdict:
    name = argv[0].upper()
    upper_args = [a.upper() for a in argv[1:]]
    if name in _REDIS_READ:
        return READ, f"`{name}` okuma komutudur"
    if name in _REDIS_READ_SUB:
        sub = upper_args[0] if upper_args else ""
        if sub in _REDIS_READ_SUB[name]:
            return READ, f"`{name} {sub}` okuma komutudur"
        return WRITE, f"`{name} {sub}`".rstrip() + " yazma/yönetim komutudur"
    if name == "SORT":
        if "STORE" in upper_args:
            return WRITE, "`SORT … STORE` sonucu yazar"
        return READ, "`SORT` okuma komutudur"
    if name in ("GEORADIUS", "GEORADIUSBYMEMBER"):
        if "STORE" in upper_args or "STOREDIST" in upper_args:
            return WRITE, f"`{name} … STORE` sonucu yazar"
        return READ, f"`{name}` okuma komutudur"
    return WRITE, f"`{name}` yazma/yönetim komutudur"


def classify_redis(text: str) -> ClassifiedCommand:
    try:
        commands = split_redis(text)
    except ValueError:
        return _single(UNKNOWN, "Redis komutu ayrıştırılamadı (kapanmamış tırnak)", parsed=False, text=text.strip())
    if not commands:
        return ClassifiedCommand(READ, ("Boş komut",), (), True)
    segments = []
    for argv in commands:
        klass, reason = _classify_redis_argv(argv)
        segments.append(Segment(" ".join(argv), klass, (reason,)))
    return _from_segments(segments, parsed=True)


# ============================================================================ MongoDB


@dataclass(frozen=True)
class MongoOp:
    """A MongoDB command document ready for ``db.command(...)`` (first key = command name)."""

    command: dict[str, Any]
    name: str
    collection: str | None = None
    single: bool = False  # findOne
    extra: dict[str, Any] = field(default_factory=dict)


_MONGO_READ = _words(
    """
find count distinct listcollections listindexes listdatabases dbstats collstats serverstatus
buildinfo hostinfo ping connectionstatus whatsmyuri currentop top getlog getcmdlineopts getparameter
ismaster hello datasize replsetgetstatus replsetgetconfig dbhash usersinfo rolesinfo connpoolstats
lockinfo getdefaultrwconcern
"""
)
_MONGO_SHELL = re.compile(r"^\s*db\.(?P<coll>[A-Za-z0-9_$\-.]+?)\.(?P<method>\w+)\((?P<args>.*)\)\s*;?\s*$", re.DOTALL)
_MONGO_DB_CALL = re.compile(r"^\s*db\.(?P<method>runCommand|adminCommand)\((?P<args>.*)\)\s*;?\s*$", re.DOTALL)


def _mongo_loads(text: str) -> Any:
    try:
        return json_util.loads(text)
    except Exception as e:
        raise ValueError("Argümanlar geçerli (Extended) JSON olmalı; anahtarlar çift tırnaklı yazılmalı") from e


def _mongo_from_method(coll: str, method: str, args: list[Any]) -> MongoOp:
    def arg(i: int, default: Any = None) -> Any:
        return args[i] if len(args) > i and args[i] is not None else default

    m = method
    if m in ("find", "findOne"):
        cmd: dict[str, Any] = {"find": coll, "filter": arg(0, {})}
        if arg(1) is not None:
            cmd["projection"] = arg(1)
        if m == "findOne":
            cmd["limit"] = 1
        return MongoOp(cmd, "find", coll, single=m == "findOne")
    if m == "aggregate":
        return MongoOp({"aggregate": coll, "pipeline": arg(0, []), "cursor": {}}, "aggregate", coll)
    if m in ("countDocuments", "count"):
        return MongoOp({"count": coll, "query": arg(0, {})}, "count", coll)
    if m == "estimatedDocumentCount":
        return MongoOp({"count": coll}, "count", coll)
    if m == "distinct":
        return MongoOp({"distinct": coll, "key": arg(0, ""), "query": arg(1, {})}, "distinct", coll)
    if m == "getIndexes":
        return MongoOp({"listIndexes": coll}, "listIndexes", coll)
    if m == "stats":
        return MongoOp({"collStats": coll}, "collStats", coll)
    if m in ("insertOne", "insertMany"):
        docs = [arg(0, {})] if m == "insertOne" else list(arg(0, []))
        return MongoOp({"insert": coll, "documents": docs}, "insert", coll)
    if m in ("updateOne", "updateMany", "replaceOne"):
        update = {"q": arg(0, {}), "u": arg(1, {}), "multi": m == "updateMany", **(arg(2, {}) or {})}
        return MongoOp({"update": coll, "updates": [update]}, "update", coll)
    if m in ("deleteOne", "deleteMany"):
        return MongoOp(
            {"delete": coll, "deletes": [{"q": arg(0, {}), "limit": 1 if m == "deleteOne" else 0}]}, "delete", coll
        )
    if m == "drop":
        return MongoOp({"drop": coll}, "drop", coll)
    if m == "createIndex":
        keys = arg(0, {})
        opts = dict(arg(1, {}) or {})
        name = opts.pop("name", None) or "_".join(f"{k}_{v}" for k, v in dict(keys).items())
        return MongoOp({"createIndexes": coll, "indexes": [{"key": keys, "name": name, **opts}]}, "createIndexes", coll)
    raise ValueError(f"Desteklenmeyen mongosh yöntemi: {method}. Komut belgesi (JSON) kullanın.")


def parse_mongo(text: str) -> MongoOp:
    """Parse a JSON command document or a supported ``db.<coll>.<method>(...)`` call."""
    stripped = text.strip()
    if not stripped:
        raise ValueError("Boş MongoDB komutu.")
    if stripped.startswith("{"):
        doc = _mongo_loads(stripped)
        if not isinstance(doc, dict) or not doc:
            raise ValueError("MongoDB komutu boş olmayan bir JSON nesnesi olmalı.")
        name = str(next(iter(doc)))
        coll = doc[name] if isinstance(doc[name], str) else None
        return MongoOp(dict(doc), name, coll)
    m = _MONGO_DB_CALL.match(stripped)
    if m:
        doc = _mongo_loads(m.group("args"))
        if not isinstance(doc, dict) or not doc:
            raise ValueError("runCommand bir JSON nesnesi almalı.")
        name = str(next(iter(doc)))
        coll = doc[name] if isinstance(doc[name], str) else None
        return MongoOp(dict(doc), name, coll, extra={"admin": m.group("method") == "adminCommand"})
    m = _MONGO_SHELL.match(stripped)
    if not m:
        raise ValueError("MongoDB komutu JSON komut belgesi ya da db.<koleksiyon>.<yöntem>(…) biçiminde olmalı.")
    raw_args = m.group("args").strip()
    args = _mongo_loads(f"[{raw_args}]") if raw_args else []
    if not isinstance(args, list):
        raise ValueError("Argümanlar ayrıştırılamadı.")
    return _mongo_from_method(m.group("coll"), m.group("method"), args)


def _contains_key(value: Any, keys: frozenset[str]) -> bool:
    if isinstance(value, dict):
        return any(k in keys or _contains_key(v, keys) for k, v in value.items())
    if isinstance(value, list | tuple):
        return any(_contains_key(v, keys) for v in value)
    return False


def _classify_mongo_doc(doc: dict[str, Any], depth: int = 0) -> Verdict:
    if not doc:
        return UNKNOWN, "Boş komut belgesi"
    name = str(next(iter(doc)))
    lname = name.lower()
    if lname == "aggregate":
        if _contains_key(doc.get("pipeline"), frozenset({"$out", "$merge"})):
            return WRITE, "aggregate `$out`/`$merge` aşaması koleksiyona yazar"
        return READ, "aggregate okuma işlemidir"
    if lname == "explain":
        inner = doc.get("explain")
        verbosity = str(doc.get("verbosity", "allPlansExecution"))
        if isinstance(inner, dict) and depth < 2:
            klass, _ = _classify_mongo_doc(inner, depth + 1)
            if klass != READ and verbosity != "queryPlanner":
                return WRITE, "explain yazma komutunu çalıştırma istatistikleriyle değerlendirir"
        return READ, "explain okuma işlemidir"
    if lname in _MONGO_READ:
        return READ, f"`{name}` okuma komutudur"
    return WRITE, f"`{name}` yazma/yönetim komutudur"


def classify_mongo(text: str) -> ClassifiedCommand:
    try:
        op = parse_mongo(text)
    except ValueError as e:
        message = str(e).rstrip(".")
        return _single(UNKNOWN, f"{message}. Bilinmeyen sayılır.", parsed=False, text=" ".join(text.split())[:200])
    klass, reason = _classify_mongo_doc(op.command)
    segment = Segment(f"{op.name} {op.collection or ''}".strip(), klass, (reason,))
    return ClassifiedCommand(klass, (reason,), (segment,), True)


# ============================================================================ dispatch

QueryLanguage = Literal["shell", "sql", "redis", "mongodb"]


def classify_query(kind: str, text: str) -> ClassifiedCommand:
    """Classify a ``db_query`` for the profile's db kind."""
    if kind in SQL_DIALECTS:
        return classify_sql(text, kind)
    if kind == "redis":
        return classify_redis(text)
    if kind == "mongodb":
        return classify_mongo(text)
    raise ValueError(f"unsupported db kind: {kind}")
