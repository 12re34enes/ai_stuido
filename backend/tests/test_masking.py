from __future__ import annotations

import random
import string

import pytest

from aistudio.security.masking import MASK, Masker

# Test credentials are assembled at runtime so no secret-shaped literal lives in the repo
# (GitHub push protection would reject it).
_B = "-----BEGIN OPENSSH " + "PRIVATE KEY-----"
_E = "-----END OPENSSH " + "PRIVATE KEY-----"
_JWT = ".".join(
    ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmN" + "Hl0w5N_XgL0n3I9P"]
)


def _random_token(length: int = 40, seed: int = 7) -> str:
    rng = random.Random(seed)
    alphabet = string.ascii_letters + string.digits
    while True:
        tok = "".join(rng.choice(alphabet) for _ in range(length))
        if any(c.isupper() for c in tok) and any(c.islower() for c in tok) and any(c.isdigit() for c in tok):
            return tok


@pytest.fixture
def masker() -> Masker:
    return Masker()


def test_known_secret_masked_everywhere(masker: Masker) -> None:
    masker.add_secret("s3cr3t-value-XYZ")
    assert masker.mask("a s3cr3t-value-XYZ b s3cr3t-value-XYZ") == f"a {MASK} b {MASK}"


def test_short_known_values_ignored(masker: Masker) -> None:
    masker.add_secret("abc")
    assert masker.mask("abc abc") == "abc abc"


@pytest.mark.parametrize(
    "text",
    [
        "token ghp_" + "a" * 36,
        "github_pat_" + "A1b2" * 10,
        "glpat-" + "x" * 20,
        "xox" + "b-1234567890-abcdefghij",
        "AKIA" + "ABCDEFGHIJKLMNOP",
        "sk-ant-api03-" + "z" * 30,
        "sk-proj-" + "q" * 40,
        "123456789:" + "A" * 35,
        _JWT,
        f"{_B}\nabc\ndef\n{_E}",
    ],
)
def test_token_patterns(masker: Masker, text: str) -> None:
    out = masker.mask(text)
    assert MASK in out
    assert "ghp_aaaa" not in out and "PRIVATE KEY-----\nabc" not in out


def test_url_credentials_keep_structure(masker: Masker) -> None:
    out = masker.mask("postgres://app:pa55word@db.internal:5432/prod")
    assert out == f"postgres://app:{MASK}@db.internal:5432/prod"


def test_assignments(masker: Masker) -> None:
    assert masker.mask("DB_PASSWORD=hunter2hunter2") == f"DB_PASSWORD={MASK}"
    assert masker.mask('api_key: "abcdef123456"') == f'api_key: "{MASK}"'
    assert masker.mask("--password supersecret") == f"--password {MASK}"


def test_does_not_mask_normal_text(masker: Masker) -> None:
    text = (
        "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 merged into main; "
        "see src/components/AgentCard/AgentCard.tsx and the token count was 1200"
    )
    assert masker.mask(text) == text


@pytest.mark.parametrize("seed", range(25))
def test_entropy_catches_random_credentials(masker: Masker, seed: int) -> None:
    token = _random_token(seed=seed)
    assert masker.mask(f"value {token}") == f"value {MASK}"


def test_entropy_ignores_long_identifiers(masker: Masker) -> None:
    text = "useAgentCardHeaderTitleComponentPropsWithMotionV2 and AISTUDIO_DEV_TOKEN_PLACEHOLDER_VALUE_X1"
    assert masker.mask(text) == text


def test_mask_obj_recurses_and_keeps_keys(masker: Masker) -> None:
    masker.add_secret("topsecret99")
    obj = {"password": "topsecret99", "nested": [{"x": "a topsecret99"}], "n": 3}
    assert masker.mask_obj(obj) == {"password": MASK, "nested": [{"x": f"a {MASK}"}], "n": 3}
