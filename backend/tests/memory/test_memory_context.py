from __future__ import annotations

from memory_helpers import MemEnv

from aistudio.contracts.agents import Boundaries
from aistudio.memory.context import CONTEXT_CAP, TRUNCATION_MARKER, DecisionEntry, SessionEntry, build_context
from aistudio.memory.markdown import compact, first_paragraph_line, split_front_matter

FACTS = """\
# Proje gerçekleri

<!-- yönerge: ajanlara gitmemeli -->

## Amaç
Ödeme altyapısı sunan bir API.

## Teknoloji yığını
<!-- boş başlık -->

## Komutlar
- `make test`
"""

BOUNDARIES = """\
---
forbidden_paths: [.env]
denied_commands: ["rm -rf *"]
network: false
---
# Sınırlar

## Alanlar
Genel açıklama (ajana gitmemeli).

## Açıklamalar
Production verisine asla dokunulmaz.
"""


def _decision(i: int) -> str:
    return (
        f"---\ntitle: Karar {i:02d}\ndate: 2026-09-{i:02d}\nstatus: kabul edildi\n---\n"
        f"# Karar {i:02d}\n\n## Bağlam\nBağlam {i}.\n\n## Karar\nSeçenek {i} seçildi.\n"
    )


async def _seed(env: MemEnv, decisions: int = 20) -> None:
    await env.svc.ensure(env.ws.id)
    root = env.ctx.settings.paths.memory_dir(env.ws.slug)
    # Written like an external editor would; one sync commit keeps the test fast.
    (root / "facts.md").write_text(FACTS)
    (root / "boundaries.md").write_text(BOUNDARIES)
    for i in range(1, decisions + 1):
        (root / f"decisions/2026-09-{i:02d}-karar-{i}.md").write_text(_decision(i))
    (root / "sessions/2026-10-01-ses-a.md").write_text("# Oturum özeti: Giriş hatası\n\nx\n")
    await env.svc.head(env.ws.id)


async def test_writer_context_has_facts_boundaries_and_notes(mem: MemEnv) -> None:
    await _seed(mem)
    text = await mem.svc.context_for_agent(mem.ws.id, role="writer")
    assert text.startswith("# Ortak hafıza: Ödeme Servisi")
    assert "## Proje gerçekleri" in text and "Ödeme altyapısı sunan bir API." in text
    assert "### Amaç" in text  # demoted under the section heading
    assert "yönerge" not in text and "Teknoloji yığını" not in text  # comments + empty headings dropped
    assert "`.env`" in text and "Ağ erişimi: kapalı" in text and "`rm -rf *`" in text
    assert "Production verisine asla dokunulmaz." in text
    assert "Genel açıklama" not in text
    assert "Karar 20" in text and "Seçenek 20 seçildi." in text
    assert "Karar 01" not in text  # writers get only the newest decisions
    assert "ve 12 karar daha" in text
    assert "Giriş hatası" in text
    assert "memory_read" in text and "memory_propose" in text
    assert "Karar kayıtları" not in text  # README files are not decisions
    assert len(text) <= CONTEXT_CAP


async def test_advisor_context_gets_more_decisions_and_no_notes(mem: MemEnv) -> None:
    await _seed(mem)
    writer = await mem.svc.context_for_agent(mem.ws.id, role="writer")
    advisor = await mem.svc.context_for_agent(mem.ws.id, role="advisor")
    assert advisor.count("- 2026-09-") > writer.count("- 2026-09-")
    assert "Karar 01" in advisor
    assert "Production verisine asla dokunulmaz." not in advisor
    assert "[kabul edildi]" in advisor


async def test_context_is_capped_with_graceful_truncation(mem: MemEnv) -> None:
    big = "# Proje gerçekleri\n\n## Amaç\n" + "\n".join(f"Satır {i}: " + "x" * 80 for i in range(400))
    await mem.svc.write(mem.ws.id, "facts.md", big, message="büyük")
    for role in ("writer", "advisor", "reviewer", "planner", "tester", "judge", "synthesizer"):
        text = await mem.svc.context_for_agent(mem.ws.id, role=role)  # type: ignore[arg-type]
        assert len(text) <= CONTEXT_CAP, role
        assert TRUNCATION_MARKER in text
        assert "## Sınırlar (zorunlu)" in text  # boundaries always survive
        assert text.rstrip().endswith("Hafıza dosyalarını doğrudan düzenleme.")


def test_build_context_respects_small_cap() -> None:
    text = build_context(
        workspace_name="W",
        role="advisor",
        facts="## Amaç\n" + "uzun satır\n" * 2000,
        boundaries=Boundaries(forbidden_paths=["secrets/**"]),
        boundary_notes="",
        decisions=[DecisionEntry(path=f"decisions/{i}.md", date="2026-01-01", title=f"K{i}") for i in range(100)],
        sessions=[SessionEntry(path="sessions/a.md", date="2026-01-02", title="Oturum")],
        cap=2500,
    )
    assert len(text) <= 2500
    assert "`secrets/**`" in text


def test_empty_memory_context_is_friendly() -> None:
    text = build_context(
        workspace_name="Boş",
        role="writer",
        facts="# Proje gerçekleri\n\n## Amaç\n<!-- doldur -->\n",
        boundaries=Boundaries(),
        boundary_notes="",
        decisions=[],
        sessions=[],
    )
    assert "_Henüz proje gerçeği yazılmamış._" in text
    assert "Karar dizini" not in text and "Son oturumlar" not in text


def test_markdown_helpers() -> None:
    fm = split_front_matter("---\ntitle: X\n---\n# Başlık\n")
    assert fm.data == {"title": "X"} and fm.body == "# Başlık\n"
    assert split_front_matter("# yok\n").data is None
    bad = split_front_matter("---\na: [1\n---\nbody")
    assert bad.error and "YAML" in bad.error
    assert first_paragraph_line("# T\n\n## Bağlam\nb\n\n## Karar\n- Seçim yapıldı\n", after_heading="Karar") == (
        "Seçim yapıldı"
    )
    assert compact("# T\n\n## Boş\n\n## Dolu\nx\n") == "## Dolu\nx"
