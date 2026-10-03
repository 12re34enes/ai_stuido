from __future__ import annotations

from dataclasses import dataclass

import pytest

from aistudio.contracts.git_hosting import HostingKind
from aistudio.core.errors import ValidationFailed
from aistudio.git_hosting.remote_url import match_account, normalize_api_url, parse_remote_url

CASES: list[tuple[str, tuple[str, str, int | None, str] | None]] = [
    ("https://github.com/acme/widgets.git", ("https", "github.com", None, "acme/widgets")),
    ("https://github.com/acme/widgets", ("https", "github.com", None, "acme/widgets")),
    ("https://github.com/acme/widgets/", ("https", "github.com", None, "acme/widgets")),
    ("https://user:secret@github.com/acme/widgets.git", ("https", "github.com", None, "acme/widgets")),
    ("git@github.com:acme/widgets.git", ("scp", "github.com", None, "acme/widgets")),
    ("github.com:acme/widgets", ("scp", "github.com", None, "acme/widgets")),
    ("ssh://git@github.com/acme/widgets.git", ("ssh", "github.com", None, "acme/widgets")),
    ("ssh://git@ssh.github.com:443/acme/widgets.git", ("ssh", "github.com", 443, "acme/widgets")),
    ("git://github.com/acme/widgets.git", ("git", "github.com", None, "acme/widgets")),
    ("git+ssh://git@github.com/acme/widgets.git", ("ssh", "github.com", None, "acme/widgets")),
    ("https://GitLab.Example.com:8443/group/sub/proj.git", ("https", "gitlab.example.com", 8443, "group/sub/proj")),
    (
        "ssh://git@gitlab.example.com:2222/group/sub/deep/proj.git",
        ("ssh", "gitlab.example.com", 2222, "group/sub/deep/proj"),
    ),
    ("git@gitlab.com:group/subgroup/project.git", ("scp", "gitlab.com", None, "group/subgroup/project")),
    ("http://10.0.0.5/team/app.git", ("http", "10.0.0.5", None, "team/app")),
    ("/srv/git/app.git", None),
    ("file:///srv/git/app.git", None),
    ("https://github.com/only-owner", None),
    ("https://github.com/acme/../etc", None),
    ("", None),
    ("https://host:notaport/a/b", None),
]


@pytest.mark.parametrize(("url", "expected"), CASES)
def test_parse_remote_url(url: str, expected: tuple[str, str, int | None, str] | None) -> None:
    loc = parse_remote_url(url)
    if expected is None:
        assert loc is None
    else:
        assert loc is not None
        assert (loc.scheme, loc.host, loc.port, loc.path) == expected


@pytest.mark.parametrize(
    ("kind", "raw", "api", "web"),
    [
        ("github", None, "https://api.github.com", "https://github.com"),
        ("github", "https://github.com", "https://api.github.com", "https://github.com"),
        ("github", "ghe.example.com", "https://ghe.example.com/api/v3", "https://ghe.example.com"),
        ("github", "https://ghe.example.com/api/v3/", "https://ghe.example.com/api/v3", "https://ghe.example.com"),
        ("gitlab", None, "https://gitlab.com/api/v4", "https://gitlab.com"),
        ("gitlab", "https://gitlab.example.com", "https://gitlab.example.com/api/v4", "https://gitlab.example.com"),
        (
            "gitlab",
            "https://h.example.com/gitlab/api/v4",
            "https://h.example.com/gitlab/api/v4",
            "https://h.example.com/gitlab",
        ),
        ("gitlab", "http://10.0.0.5:8080", "http://10.0.0.5:8080/api/v4", "http://10.0.0.5:8080"),
    ],
)
def test_normalize_api_url(kind: HostingKind, raw: str | None, api: str, web: str) -> None:
    assert normalize_api_url(kind, raw) == (api, web)


def test_normalize_rejects_bad_scheme() -> None:
    with pytest.raises(ValidationFailed, match="Geçersiz sunucu adresi"):
        normalize_api_url("gitlab", "ftp://example.com")


@dataclass
class Acc:
    name: str
    kind: HostingKind
    web_url: str


ACCOUNTS = [
    Acc("gh", "github", "https://github.com"),
    Acc("ghe", "github", "https://ghe.corp.example"),
    Acc("gl", "gitlab", "https://gitlab.com"),
    Acc("self", "gitlab", "https://code.example.com/gitlab"),
]


@pytest.mark.parametrize(
    ("url", "account", "slug"),
    [
        ("git@github.com:acme/widgets.git", "gh", "acme/widgets"),
        ("ssh://git@ssh.github.com:443/acme/widgets.git", "gh", "acme/widgets"),
        ("https://ghe.corp.example/team/app", "ghe", "team/app"),
        ("git@gitlab.com:a/b/c.git", "gl", "a/b/c"),
        ("https://code.example.com/gitlab/grp/sub/proj.git", "self", "grp/sub/proj"),
        ("git@code.example.com:grp/sub/proj.git", "self", "grp/sub/proj"),
        ("https://bitbucket.org/acme/widgets.git", None, None),
        ("https://github.com/acme/widgets/extra", None, None),  # GitHub slugs are exactly owner/repo
    ],
)
def test_match_account(url: str, account: str | None, slug: str | None) -> None:
    loc = parse_remote_url(url)
    assert loc is not None
    result = match_account(loc, ACCOUNTS)
    if account is None:
        assert result is None
    else:
        assert result is not None
        assert (result[0].name, result[1]) == (account, slug)
