"""Exhaustive classification tables (pure)."""

from __future__ import annotations

import pytest

from aistudio.remote.classify import (
    awk_program_safe,
    classify_mongo,
    classify_query,
    classify_redis,
    classify_shell,
    classify_sql,
    parse_mongo,
    scan_word,
    sed_script_safe,
    split_redis,
    split_sql,
)

# ----------------------------------------------------------------------------- shell: read

SHELL_READ = [
    "ls",
    "ls -la /var/log",
    "ls -la /var/log 2>/dev/null",
    "ls 2>&1",
    "ls >/dev/null 2>&1",
    "ls &>/dev/null",
    "cat /etc/os-release",
    "head -n 50 /var/log/syslog",
    "tail -n 200 /var/log/nginx/error.log",
    "tail -f /var/log/app.log",
    "less /var/log/syslog",
    "grep -R 'ERROR' /var/log/app",
    "rg -n TODO src",
    "egrep 'a|b' file",
    "find / -name '*.log' -mtime -1",
    "find . -type f -size +100M",
    "du -sh /var/*",
    "df -h",
    "ps aux",
    "ps aux | grep nginx | grep -v grep",
    "top -b -n 1",
    "top -bn1",
    "free -m",
    "uptime",
    "whoami",
    "id",
    "uname -a",
    "env",
    "printenv PATH",
    "date",
    "date +%Y-%m-%d",
    "journalctl -u nginx --since today --no-pager",
    "journalctl -xe -n 100",
    "systemctl status nginx",
    "systemctl show nginx -p ActiveState",
    "systemctl list-units --failed",
    "systemctl list-timers",
    "systemctl is-active nginx",
    "systemctl --no-pager status",
    "systemctl",
    "docker ps -a",
    "docker logs --tail 100 web",
    "docker inspect web",
    "docker stats --no-stream",
    "docker images",
    "docker top web",
    "docker container ls",
    "docker image ls",
    "docker compose ps",
    "docker compose -f prod.yml logs --tail 50",
    "docker-compose logs",
    "kubectl get pods",
    "kubectl -n prod get pods -o wide",
    "kubectl get pods --namespace kube-system",
    "kubectl describe pod web-1",
    "kubectl logs -f deploy/web",
    "kubectl top nodes",
    "kubectl explain pods",
    "kubectl config view",
    "kubectl auth can-i list pods",
    "kubectl rollout status deploy/web",
    "helm list -A",
    "helm status web -n prod",
    "git status",
    "git log --oneline -20",
    "git diff HEAD~1",
    "git show HEAD",
    "git branch -a",
    "git branch --list 'feat*'",
    "git tag",
    "git tag -l 'v*'",
    "git remote -v",
    "git config --get user.email",
    "git config user.email",
    "git stash list",
    "git -C /srv/app status",
    "curl https://example.com/health",
    "curl -sS -I https://example.com",
    "curl -fsSL https://example.com/api -H 'Accept: application/json'",
    "curl -X GET https://example.com",
    "curl -o /dev/null -w '%{http_code}' https://example.com",
    "curl -G -d q=1 https://example.com/search",
    "wget -qO- https://example.com",
    "wget -O - https://example.com",
    "wget --spider https://example.com",
    "sed -n '1,20p' file.txt",
    "sed 's/foo/bar/g' file.txt",
    "sed -e 's/a/b/' -e '/x/d' file",
    "sed '$d' file",
    "awk '{print $1}' access.log",
    "awk -F: '$3 > 1000 {print $1}' /etc/passwd",
    "awk '/error|warn/ {c++} END {print c}' log",
    "sort file | uniq -c | sort -rn | head",
    "cut -d: -f1 /etc/passwd",
    "wc -l *.log",
    "stat /etc/hosts",
    "file /bin/ls",
    "which python3",
    "command -v node",
    "type ls",
    "echo hello",
    "printf '%s\\n' a b",
    "test -f /etc/hosts && echo yes",
    "cd /var/log && ls",
    "pwd",
    "hostname",
    "hostname -f",
    "ip addr show",
    "ip route",
    "ip -br a",
    "ss -tlnp",
    "netstat -tulpn",
    "lsof -i :80",
    "ping -c 3 example.com",
    "dig example.com",
    "getent hosts example.com",
    "dmesg | tail",
    "sysctl -a",
    "sysctl net.ipv4.ip_forward",
    "mount",
    "crontab -l",
    "lastlog",
    "last -n 10",
    "dpkg -l | grep nginx",
    "apt list --installed",
    "apt-cache policy nginx",
    "rpm -qa",
    "tar -tzf backup.tar.gz",
    "tar tvf backup.tar",
    "gzip -dc log.gz | tail",
    "zcat log.gz | grep x",
    "unzip -l a.zip",
    "iptables -L -n",
    "iptables-save",
    "ufw status verbose",
    "nft list ruleset",
    "timedatectl",
    "hostnamectl status",
    "loginctl list-sessions",
    "service nginx status",
    "service --status-all",
    "LANG=C ls",
    "LC_ALL=C sort file",
    "TZ=UTC date",
    "PAGER=cat git log",
    "x=1; echo $x",
    "for f in /var/log/*.log; do tail -n 1 $f; done",
    "while read l; do echo $l; done < file",
    "if test -f x; then cat x; fi",
    "{ uptime; df -h; }",
    "(cd /tmp && ls)",
    "echo $(whoami)",
    "echo `hostname`",
    "cat $(ls /etc/*.conf | head -1)",
    "diff <(ls a) <(ls b)",
    "time ls",
    "timeout 5 tail -f log",
    "nice -n 10 du -sh /",
    "nohup uptime",
    "env LANG=C ls",
    "xargs echo",
    "ls | xargs grep foo",
    "sh -c 'ls; uptime'",
    "bash -c 'cat /etc/hosts | wc -l'",
    "bash -lc 'uptime'",
    "watch -n 2 'df -h'",
    "/usr/bin/ls /",
    "/bin/cat /etc/hosts",
    "ls # rm -rf /",
    "cat file <<< 'x'",
    "export LANG=C; ls",
    "set -euo pipefail; ls",
    "read -r name < file",
    "jq .version package.json",
    "yq .a f.yml",
    "tree -L 2",
    "md5sum file",
    "",
]


@pytest.mark.parametrize("command", SHELL_READ)
def test_shell_read(command: str) -> None:
    c = classify_shell(command)
    assert c.klass == "read", (command, c.reasons)
    assert c.reasons


# ----------------------------------------------------------------------------- shell: write

SHELL_WRITE = [
    "rm -rf /tmp/x",
    "rm file",
    "mv a b",
    "cp a b",
    "touch x",
    "mkdir -p /srv/new",
    "chmod 777 /etc/passwd",
    "chown root x",
    "ln -s a b",
    "dd if=/dev/zero of=/dev/sda",
    "truncate -s 0 log",
    "echo hi > file",
    "echo hi >> file",
    "ls > out.txt",
    "ls 2> err.log",
    "ls &> all.log",
    "echo x >| file",
    "cat <<EOF > /etc/motd\nhi\nEOF",
    "cat file | tee copy",
    "tee x",
    "ls | tee -a log",
    "sed -i 's/a/b/' file",
    "sed -i.bak 's/a/b/' file",
    "sed --in-place 's/a/b/' file",
    "sed -ni 's/a/b/p' file",
    "sed 's/x/y/w out.txt' file",
    "sed '/x/w out.txt' file",
    "sed 's/x/date/e' file",
    "sed '1e id' file",
    "awk '{print $1 > \"/tmp/out\"}' file",
    "awk '{system(\"rm -rf /\")}' file",
    "awk '{print | \"sh\"}' file",
    "awk -o file '{print}'",
    "sudo ls",
    "sudo -u postgres psql",
    "su - root",
    "kill -9 1234",
    "pkill nginx",
    "killall node",
    "reboot",
    "shutdown -h now",
    "systemctl restart nginx",
    "systemctl stop nginx",
    "systemctl daemon-reload",
    "systemctl enable --now nginx",
    "systemctl -H other restart nginx",
    "service nginx restart",
    "journalctl --vacuum-size=100M",
    "journalctl --vacuum-t=2d",
    "journalctl --rotate",
    "docker rm web",
    "docker run -d nginx",
    "docker exec web ls",
    "docker stop web",
    "docker system prune -f",
    "docker container rm web",
    "docker compose up -d",
    "docker compose down",
    "docker-compose restart",
    "kubectl delete pod web",
    "kubectl apply -f x.yml",
    "kubectl exec -it web -- sh",
    "kubectl scale deploy web --replicas 0",
    "kubectl config use-context prod",
    "kubectl rollout restart deploy/web",
    "kubectl get pods --log-file /tmp/x",
    "helm upgrade web chart",
    "helm uninstall web",
    "helm template x chart --output-dir out",
    "git push",
    "git commit -m x",
    "git checkout main",
    "git reset --hard",
    "git pull",
    "git fetch",
    "git branch new-feature",
    "git branch -D old",
    "git tag v1.0",
    "git tag -d v1",
    "git remote add o url",
    "git config user.email a@b.c",
    "git config --unset user.email",
    "git stash",
    "git reflog expire --all",
    "curl -X POST https://example.com",
    "curl -XDELETE https://example.com/x",
    "curl --request PUT https://x",
    "curl -d a=1 https://example.com",
    "curl --data-binary @f https://x",
    "curl -F file=@x https://x",
    "curl --json '{}' https://x",
    "curl -T file https://x",
    "curl -o out.html https://example.com",
    "curl -O https://example.com/file",
    "curl -fsSLo out https://example.com",
    "curl -c cookies.txt https://x",
    "curl -H 'X-HTTP-Method-Override: DELETE' https://x",
    "wget https://example.com/file",
    "wget -O out https://example.com",
    "wget --post-data a=1 -O - https://x",
    "wget -r -O - https://x",
    "sort -o out file",
    "sort --output=out file",
    "uniq in out",
    "xxd -r in out",
    "less -o log.txt file",
    "file -C -m magic",
    "tree -o out.txt",
    "yq -i '.a=1' f.yml",
    "date -s '2020-01-01'",
    "date 0101",
    "hostname newname",
    "ip link set eth0 down",
    "ip addr add 10.0.0.1/24 dev eth0",
    "ip route del default",
    "ifconfig eth0 down",
    "route add default gw 1.1.1.1",
    "arp -d 10.0.0.1",
    "ss -K dst 10.0.0.1",
    "dmesg -c",
    "dmesg --clear",
    "sysctl -w net.ipv4.ip_forward=1",
    "sysctl net.ipv4.ip_forward=1",
    "mount /dev/sdb1 /mnt",
    "crontab -r",
    "crontab file",
    "lastlog -C -u x",
    "history -w /tmp/h",
    "dpkg -i x.deb",
    "apt install nginx",
    "apt-get install nginx",
    "rpm -e nginx",
    "tar -xzf a.tar.gz",
    "tar -czf a.tar.gz dir",
    "tar xvf a.tar",
    "gzip file",
    "unzip a.zip",
    "iptables -F",
    "iptables -A INPUT -j DROP",
    "iptables-save -f /etc/rules",
    "ufw allow 22",
    "ufw enable",
    "nft flush ruleset",
    "nft -f rules.nft",
    "timedatectl set-timezone UTC",
    "hostnamectl hostname newname",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} \\;",
    "find . -execdir rm {} +",
    "find . -ok rm {} \\;",
    "find . -fprint out",
    "find / -fls out",
    "xargs rm",
    "ls | xargs rm -f",
    "find . | xargs -0 rm",
    "echo $(rm -rf /tmp/x)",
    "echo `rm -rf /tmp/x`",
    "ls; rm x",
    "ls && rm x",
    "false || rm x",
    "ls | rm x",
    "(rm x)",
    "{ rm x; }",
    "for f in *; do rm $f; done",
    "if true; then rm x; fi",
    "diff <(rm x) b",
    "sh -c 'rm -rf /tmp/x'",
    "bash -c 'ls; rm x'",
    "watch 'rm x'",
    "time rm x",
    "timeout 10 rm x",
    "nice rm x",
    "nohup rm x &",
    "env rm x",
    "env LANG=C rm x",
    "command rm x",
    "exec rm x",
    "ionice -p 1 -c 3",
    "python3 -c 'print(1)'",
    "perl -e 1",
    "node app.js",
    "psql -c 'select 1'",
    "mysql -e 'select 1'",
    "redis-cli flushall",
    "mongosh --eval 'db.dropDatabase()'",
    "vi /etc/hosts",
    "nano file",
    "ssh other ls",
    "scp a host:b",
    "rsync -a a b",
    "nc -l 1234",
    "eval ls",
    "source ~/.bashrc",
    ". ./env.sh",
    "make install",
    "npm install",
    "pip install x",
    "useradd bob",
    "passwd root",
    "umount /mnt",
    "logger hello",
    "zsh -c 'ls'",
]


@pytest.mark.parametrize("command", SHELL_WRITE)
def test_shell_write_or_unknown(command: str) -> None:
    c = classify_shell(command)
    assert c.klass in ("write", "unknown"), (command, c.reasons)
    assert not c.is_read


# Things that must be unknown specifically (cannot be proven either way).
SHELL_UNKNOWN = [
    "$CMD",
    "${CMD} -rf /",
    "$(echo rm) -rf /",
    "./script.sh",
    "/tmp/evil",
    "~/bin/tool",
    "foo-unknown-tool --flag",
    "PATH=/tmp ls",
    "LD_PRELOAD=/tmp/x.so ls",
    "HOME=/tmp/evil git log",
    "GIT_PAGER=less git log",
    "PAGER=evil man ls",
    "export PATH=/tmp:$PATH; ls",
    "export LD_PRELOAD=/x.so",
    "alias ls='rm -rf /'",
    "f() { ls; }; f",
    "find . $OPTS",
    "find . -name *.log",
    "curl $URL",
    "curl gopher://127.0.0.1:6379/_FLUSHALL",
    "curl dict://x",
    "curl file:///etc/passwd",
    "curl -K config.txt https://x",
    "wget -e robots=off -O - https://x",
    "git -c core.pager=evil log",
    "git -ccore.fsmonitor=evil status",
    "git --config-env=core.pager=X log",
    "git diff --ext-diff",
    "git log --output=/tmp/x",
    "git grep -O foo",
    "rg --pre evil foo",
    "sort --compress-program=evil file",
    "less +!rm file",
    "awk -f prog.awk file",
    "sed -f script.sed file",
    "top",
    "env -S 'rm x'",
    "ls | xargs find",
    "sh script.sh",
    "bash < script.sh",
    'sh -c "$SCRIPT"',
    "tar --to-command=sh -xf a.tar",
    "hash -p /tmp/evil ls",
    "case x in a) ls;; esac",
    "echo $((1+2))",
    "cat <<EOF\n$(rm -rf /)\nEOF",
    "echo $'\\x72\\x6d'",
    "ls\x07",
    "echo a\rrm",
    "read PATH < /tmp/x",
    "printf -v PATH '%s' /tmp",
    "ip -b cmds.txt",
    # bashlex cannot parse quoted heredoc delimiters: the strict fallback refuses heredocs.
    "cat <<'EOF'\n$(rm -rf /)\nEOF",
]


@pytest.mark.parametrize("command", SHELL_UNKNOWN)
def test_shell_unknown(command: str) -> None:
    c = classify_shell(command)
    assert c.klass == "unknown", (command, c.klass, c.reasons)


def test_shell_reasons_are_turkish_and_name_the_culprit() -> None:
    c = classify_shell("ls; sudo rm -rf /")
    assert c.klass == "write"
    assert any("sudo" in r for r in c.reasons)
    c = classify_shell("echo hi > /etc/motd")
    assert any("yönlendirme" in r and "/etc/motd" in r for r in c.reasons)
    c = classify_shell("frobnicate")
    assert c.klass == "unknown" and "yazma sayılır" in c.reasons[0]


def test_shell_segments_and_nested_substitutions() -> None:
    c = classify_shell("systemctl restart app $(rm -rf /)")
    texts = [s.text for s in c.segments]
    assert "rm -rf /" in texts
    assert any(t.startswith("systemctl restart app") for t in texts)
    assert c.parsed
    c = classify_shell("uptime && df -h | sort")
    assert [s.text for s in c.segments] == ["uptime", "df -h", "sort"]


def test_shell_fallback_is_marked_unparsed() -> None:
    c = classify_shell("time ls")
    assert c.klass == "read" and not c.parsed
    c = classify_shell("[[ -f x ]] && rm x")
    assert c.klass in ("write", "unknown") and not c.parsed
    c = classify_shell("echo 'unterminated")
    assert c.klass == "unknown"


def test_shell_too_long_is_unknown() -> None:
    assert classify_shell("ls " + "a" * 30_000).klass == "unknown"


def test_scan_word() -> None:
    assert scan_word("'$HOME'") == (False, False)
    assert scan_word('"$HOME"') == (True, False)
    assert scan_word("$HOME") == (True, False)
    assert scan_word("*.log") == (False, True)
    assert scan_word("'*.log'") == (False, False)
    assert scan_word("\\*.log") == (False, False)
    assert scan_word("{a,b}") == (False, True)
    assert scan_word("`id`") == (True, False)


@pytest.mark.parametrize(
    ("script", "safe"),
    [
        ("1,10p", True),
        ("s/foo/bar/g", True),
        ("s|a|b|", True),
        ("/start/,/end/p", True),
        ("$d", True),
        ("1~2d", True),
        ("y/abc/xyz/", True),
        ("/x/{p;q}", True),
        ("1!G;h;$!d", True),
        ("s/a\\/b/c/", True),
        ("/re/I p", True),
        ("0,/re/d", True),
        ("a\\\nappended", True),
        ("r /etc/hosts", True),
        ("s/x/y/w out", False),
        ("s/x/y/e", False),
        ("s/x/y/gw out", False),
        ("w out", False),
        ("/x/w out", False),
        ("1e id", False),
        ("W out", False),
        ("s/x", False),
        ("k", False),
    ],
)
def test_sed_scanner(script: str, safe: bool) -> None:
    assert sed_script_safe(script) is safe


@pytest.mark.parametrize(
    ("program", "safe"),
    [
        ("{print $1}", True),
        ("$3 > 100 {print $1}", True),
        ("/a|b/ {print}", True),
        ('$1 == "x" || $2 == "y"', True),
        ('{print "a>b"}', True),
        ("{ if ($3 > 10) print $1 }", True),
        ('{print $1 > "/tmp/x"}', False),
        ('{print $1 >> "/tmp/x"}', False),
        ('{system("id")}', False),
        ('{print | "sh"}', False),
        ('{"date" | getline d}', False),
        ('@load "x"', False),
    ],
)
def test_awk_scanner(program: str, safe: bool) -> None:
    assert awk_program_safe(program) is safe


# ----------------------------------------------------------------------------- SQL

SQL_CASES: list[tuple[str, str, str]] = [
    # (kind, query, expected class)
    ("postgres", "SELECT * FROM users", "read"),
    ("postgres", "select id from users where id = 1", "read"),
    ("postgres", "SELECT 1 UNION SELECT 2", "read"),
    ("postgres", "WITH x AS (SELECT 1) SELECT * FROM x", "read"),
    ("postgres", "EXPLAIN SELECT * FROM t", "read"),
    ("postgres", "EXPLAIN ANALYZE SELECT * FROM t", "read"),
    ("postgres", "EXPLAIN DELETE FROM t", "read"),
    ("postgres", "EXPLAIN ANALYZE DELETE FROM t", "write"),
    ("postgres", "EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1", "write"),
    ("postgres", "EXPLAIN (ANALYZE false) UPDATE t SET a = 1", "read"),
    ("postgres", "SHOW search_path", "read"),
    ("postgres", "SELECT ';' AS semi", "read"),
    ("postgres", "SELECT 1; -- trailing comment", "read"),
    ("postgres", "/* only a comment */", "read"),
    ("postgres", "SELECT now(), version(), count(*) FROM t", "read"),
    ("postgres", "SELECT * INTO newtable FROM t", "write"),
    ("postgres", "SELECT * FROM t FOR UPDATE", "write"),
    ("postgres", "SELECT * FROM t FOR SHARE", "write"),
    ("postgres", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "write"),
    ("postgres", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "write"),
    ("postgres", "SELECT pg_terminate_backend(123)", "write"),
    ("postgres", "SELECT nextval('seq')", "write"),
    ("postgres", "SELECT set_config('a', 'b', false)", "write"),
    ("postgres", "SELECT lo_export(1, '/tmp/x')", "write"),
    ("postgres", "INSERT INTO t VALUES (1)", "write"),
    ("postgres", "UPDATE t SET a = 1", "write"),
    ("postgres", "DELETE FROM t", "write"),
    ("postgres", "TRUNCATE t", "write"),
    ("postgres", "DROP TABLE t", "write"),
    ("postgres", "CREATE TABLE x (a int)", "write"),
    ("postgres", "ALTER TABLE t ADD COLUMN b int", "write"),
    ("postgres", "GRANT ALL ON t TO u", "write"),
    ("postgres", "VACUUM t", "write"),
    ("postgres", "BEGIN", "write"),
    ("postgres", "COMMIT", "write"),
    ("postgres", "SET search_path = x", "write"),
    ("postgres", "COPY t TO STDOUT", "write"),
    ("postgres", "CALL p()", "write"),
    ("postgres", "SELECT 1; DELETE FROM t", "write"),
    ("postgres", "select * from", "unknown"),
    ("postgres", "SELEKT 1", "unknown"),
    ("mysql", "SHOW TABLES", "read"),
    ("mysql", "SHOW CREATE TABLE t", "read"),
    ("mysql", "DESCRIBE t", "read"),
    ("mysql", "DESC t", "read"),
    ("mysql", "EXPLAIN SELECT 1", "read"),
    ("mysql", "EXPLAIN ANALYZE DELETE FROM t", "write"),
    ("mysql", "SELECT * FROM t LOCK IN SHARE MODE", "write"),
    ("mysql", "SELECT GET_LOCK('a', 1)", "write"),
    ("mysql", "SELECT * FROM t INTO OUTFILE '/tmp/x'", "unknown"),
    ("mysql", "/*!50000 DROP TABLE t */", "unknown"),
    ("mysql", "SELECT /*!50000 1 */", "unknown"),
    ("mysql", "USE db", "write"),
    ("mysql", "LOCK TABLES t READ", "write"),
    ("mysql", "SELECT 'a\\'; DROP TABLE t; --'", "read"),
    ("mssql", "SELECT TOP 10 * FROM t", "read"),
    ("mssql", "SELECT * FROM t WITH (NOLOCK)", "read"),
    ("mssql", "SELECT * INTO #tmp FROM t", "write"),
    ("mssql", "EXEC sp_who", "write"),
    ("mssql", "SET NOCOUNT ON", "write"),
    ("sqlite", "SELECT * FROM sqlite_master", "read"),
    ("sqlite", "PRAGMA table_info(t)", "read"),
    ("sqlite", "PRAGMA user_version", "read"),
    ("sqlite", "PRAGMA integrity_check", "read"),
    ("sqlite", "PRAGMA journal_mode", "read"),
    ("sqlite", "PRAGMA journal_mode=WAL", "write"),
    ("sqlite", "PRAGMA journal_mode(WAL)", "write"),
    ("sqlite", "PRAGMA user_version = 3", "write"),
    ("sqlite", "PRAGMA optimize", "write"),
    ("sqlite", "PRAGMA wal_checkpoint", "write"),
    ("sqlite", "EXPLAIN QUERY PLAN SELECT * FROM t", "read"),
    ("sqlite", "ATTACH DATABASE 'x.db' AS x", "write"),
    ("sqlite", "SELECT load_extension('x')", "write"),
]


@pytest.mark.parametrize(("kind", "query", "expected"), SQL_CASES)
def test_sql_classification(kind: str, query: str, expected: str) -> None:
    c = classify_sql(query, kind)
    assert c.klass == expected, (kind, query, c.reasons)
    assert c.reasons


def test_sql_multi_statement_reasons_are_per_statement() -> None:
    c = classify_sql("SELECT 1; DELETE FROM t; SELECT 2", "postgres")
    assert c.klass == "write"
    assert any(r.startswith("2. ifade") and "DELETE" in r for r in c.reasons)
    assert [s.klass for s in c.segments] == ["read", "write", "read"]


def test_sql_split_respects_strings_and_comments() -> None:
    assert split_sql("SELECT ';'; SELECT 2 -- x;y\n", "postgres") == ["SELECT ';'", "SELECT 2 -- x;y"]
    assert split_sql("-- c\n;;", "postgres") == []
    assert split_sql("SELECT $$a;b$$; SELECT 1", "postgres") == ["SELECT $$a;b$$", "SELECT 1"]


def test_sql_unknown_kind_raises() -> None:
    with pytest.raises(ValueError, match="not an SQL kind"):
        classify_sql("SELECT 1", "oracle")


# ----------------------------------------------------------------------------- Redis

REDIS_CASES = [
    ("GET key", "read"),
    ("get key", "read"),
    ("MGET a b", "read"),
    ("HGETALL user:1", "read"),
    ("KEYS *", "read"),
    ("SCAN 0 MATCH user:* COUNT 100", "read"),
    ("TTL a", "read"),
    ("INFO memory", "read"),
    ("DBSIZE", "read"),
    ("CONFIG GET maxmemory", "read"),
    ("CLIENT LIST", "read"),
    ("SLOWLOG GET 10", "read"),
    ("XRANGE s - +", "read"),
    ("SORT list", "read"),
    ("SORT list STORE dst", "write"),
    ("GEORADIUS k 0 0 1 km STORE x", "write"),
    ("GEORADIUS k 0 0 1 km", "read"),
    ("EVAL_RO 'return 1' 0", "read"),
    ("SET a 1", "write"),
    ("DEL a", "write"),
    ("FLUSHALL", "write"),
    ("FLUSHDB", "write"),
    ("CONFIG SET maxmemory 1", "write"),
    ("CLIENT KILL ID 1", "write"),
    ("EVAL 'return 1' 0", "write"),
    ("EXPIRE a 10", "write"),
    ("GETDEL a", "write"),
    ("SHUTDOWN", "write"),
    ("MULTI", "write"),
    ("GET a\nDEL a", "write"),
    ("# comment only", "read"),
    ("GET 'unterminated", "unknown"),
]


@pytest.mark.parametrize(("text", "expected"), REDIS_CASES)
def test_redis_classification(text: str, expected: str) -> None:
    assert classify_redis(text).klass == expected


def test_redis_split() -> None:
    assert split_redis('GET "a b"\n# c\n\nSET x 1') == [["GET", "a b"], ["SET", "x", "1"]]


# ----------------------------------------------------------------------------- MongoDB

MONGO_CASES = [
    ('{"find": "users", "filter": {"active": true}}', "read"),
    ('{"aggregate": "o", "pipeline": [{"$match": {}}], "cursor": {}}', "read"),
    ('{"aggregate": "o", "pipeline": [{"$match": {}}, {"$out": "x"}], "cursor": {}}', "write"),
    ('{"aggregate": "o", "pipeline": [{"$merge": {"into": "x"}}], "cursor": {}}', "write"),
    ('{"aggregate": "o", "pipeline": [{"$facet": {"a": [{"$out": "x"}]}}], "cursor": {}}', "write"),
    ('{"count": "users"}', "read"),
    ('{"distinct": "users", "key": "city"}', "read"),
    ('{"listCollections": 1}', "read"),
    ('{"serverStatus": 1}', "read"),
    ('{"explain": {"find": "u"}, "verbosity": "executionStats"}', "read"),
    ('{"explain": {"delete": "u", "deletes": []}, "verbosity": "executionStats"}', "write"),
    ('{"explain": {"delete": "u", "deletes": []}, "verbosity": "queryPlanner"}', "read"),
    ('{"insert": "u", "documents": [{}]}', "write"),
    ('{"update": "u", "updates": []}', "write"),
    ('{"delete": "u", "deletes": []}', "write"),
    ('{"findAndModify": "u", "query": {}}', "write"),
    ('{"drop": "u"}', "write"),
    ('{"dropDatabase": 1}', "write"),
    ('{"createIndexes": "u", "indexes": []}', "write"),
    ('db.users.find({"age": {"$gt": 5}})', "read"),
    ("db.users.find()", "read"),
    ('db.users.findOne({"_id": 1})', "read"),
    ('db.users.aggregate([{"$group": {"_id": "$city"}}])', "read"),
    ('db.users.aggregate([{"$out": "x"}])', "write"),
    ('db.users.countDocuments({"a": 1})', "read"),
    ('db.users.distinct("city")', "read"),
    ('db.users.insertOne({"a": 1})', "write"),
    ("db.users.deleteMany({})", "write"),
    ('db.users.updateOne({"a": 1}, {"$set": {"b": 2}})', "write"),
    ("db.users.drop()", "write"),
    ('db.runCommand({"ping": 1})', "read"),
    ('db.adminCommand({"shutdown": 1})', "write"),
    ("db.users.find({age: 5})", "unknown"),
    ("db.users.remove({})", "unknown"),
    ("show dbs", "unknown"),
    ("[1, 2]", "unknown"),
    ("", "unknown"),
]


@pytest.mark.parametrize(("text", "expected"), MONGO_CASES)
def test_mongo_classification(text: str, expected: str) -> None:
    assert classify_mongo(text).klass == expected, text


def test_mongo_parse_shell_methods_to_commands() -> None:
    op = parse_mongo('db.orders.find({"a": 1}, {"_id": 0})')
    assert op.command == {"find": "orders", "filter": {"a": 1}, "projection": {"_id": 0}}
    op = parse_mongo('db.a.b.updateMany({"x": 1}, {"$set": {"y": 2}})')
    assert op.collection == "a.b" and op.command["updates"][0]["multi"] is True
    op = parse_mongo('{"find": "users"}')
    assert op.name == "find" and op.collection == "users"


def test_classify_query_dispatch() -> None:
    assert classify_query("postgres", "SELECT 1").klass == "read"
    assert classify_query("redis", "GET a").klass == "read"
    assert classify_query("mongodb", '{"find": "x"}').klass == "read"
    with pytest.raises(ValueError, match="unsupported db kind"):
        classify_query("cassandra", "x")
