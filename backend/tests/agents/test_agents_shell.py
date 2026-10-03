"""Shell command analysis used by the policy engine."""

from __future__ import annotations

from aistudio.agents.shell import analyze


def names(command: str) -> list[str]:
    return [c.name for c in analyze(command).commands]


def test_compound_operators_and_subshells() -> None:
    assert names("git status && ls -la | wc -l; pwd & echo x || true") == ["git", "ls", "wc", "pwd", "echo", "true"]
    assert names("(cd sub; make) && { ls; }") == ["cd", "make", "ls"]
    assert names("ls\nssh host") == ["ls", "ssh"]


def test_wrappers_are_peeled() -> None:
    a = analyze("sudo -u root env -i A=1 B=2 nohup nice -n 5 timeout 10s ssh host ls")
    (c,) = a.commands
    assert c.argv == ["ssh", "host", "ls"]
    assert c.privileged and c.assignments == {"A": "1", "B": "2"}
    assert c.wrappers == ["sudo", "env", "nohup", "nice", "timeout"]
    assert names("xargs -n1 -I{} scp {} host:") == ["scp"]
    assert names("command -v ssh") == ["command"]
    assert names("env") == ["env"]
    assert names("env -S 'psql -h db'") == ["psql"]


def test_nested_scripts_and_substitutions() -> None:
    assert names("bash -lc 'git status && psql'") == ["git", "psql"]
    assert names("zsh -o pipefail -c 'ls | mysql'") == ["ls", "mysql"]
    assert names('eval "redis-cli -h x"') == ["redis-cli"]
    assert names('echo "$(ssh host)"') == ["echo", "ssh"]
    assert names("echo `whoami`") == ["echo", "whoami"]
    assert names("echo $((1 + $(id -u)))") == ["echo", "id"]
    assert names("echo ${X:-$(hostname)}") == ["echo", "hostname"]
    assert names("diff <(ssh h cat a) b") == ["diff", "ssh"]
    assert names("watch -n 1 'mongosh --eval x'") == ["mongosh"]
    assert names("find . -exec rm -f {} \\; -print") == ["find", "rm"]
    assert names("bash script.sh") == ["bash"]


def test_quotes_are_respected() -> None:
    assert names("echo '$(ssh host)' 'a && b'") == ["echo"]
    (c,) = analyze('grep -e "foo bar" "file name.txt"').commands
    assert c.argv == ["grep", "-e", "foo bar", "file name.txt"]
    (c,) = analyze(r"echo a\ b").commands
    assert c.argv == ["echo", "a b"]


def test_heredocs() -> None:
    a = analyze("cat <<EOF > out.txt\nssh line\n$(mysql -e x)\nEOF\nls")
    assert [c.name for c in a.commands] == ["cat", "ls", "mysql"]
    assert [(r.op, r.target, r.writes) for r in a.commands[0].redirects] == [
        ("<<", "EOF", False),
        (">", "out.txt", True),
    ]
    assert names("cat <<'EOF'\n$(mysql -e x)\nEOF") == ["cat"]
    assert names("cat <<-END\n\tssh x\n\tEND\npwd") == ["cat", "pwd"]


def test_redirections() -> None:
    (c,) = analyze("make 2>&1 >/dev/null 2>err.log < in.txt").commands
    ops = [(r.op, r.target, r.fd, r.writes, r.is_dup) for r in c.redirects]
    assert ops == [
        (">&", "1", "2", False, True),
        (">", "/dev/null", None, False, False),
        (">", "err.log", "2", True, False),
        ("<", "in.txt", None, False, False),
    ]
    (bare,) = analyze("> truncated.txt").commands
    assert bare.argv == [] and bare.redirects[0].writes


def test_git_global_options() -> None:
    (c,) = analyze("git -C repo --no-pager log --oneline").commands
    assert c.argv == ["git", "log", "--oneline"] and c.chdir == "repo" and not c.unsafe
    (c,) = analyze("git -c core.pager=x status").commands
    assert c.argv == ["git", "status"] and c.unsafe


def test_parse_problems_are_reported() -> None:
    assert not analyze("echo 'open").ok
    assert not analyze('echo "open').ok
    assert not analyze("echo $(ls").ok
    assert analyze("case x in a) ls;; esac").control
    assert analyze("ls # ssh comment").ok and names("ls # ssh comment") == ["ls"]
    assert names("for f in a b; do cat $f; done") == ["cat"]


def test_depth_limit() -> None:
    a = analyze("eval " * 12 + "ssh host")
    assert not a.ok and a.control
    assert names("eval " * 3 + "ssh host") == ["ssh"]
