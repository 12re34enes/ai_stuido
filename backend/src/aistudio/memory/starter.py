"""Starter content for a new workspace memory repo (Turkish, hand-editable)."""

from __future__ import annotations

FACTS_MD = """\
# Proje gerçekleri

<!--
Bu dosya her ajanın sistem istemine girer. Kısa, doğru ve güncel tut:
yalnız kalıcı ve doğrulanmış bilgileri yaz. Boş bıraktığın başlıklar ajanlara gönderilmez.
Gizli bilgi (parola, anahtar, belirteç) yazma; onlar Anahtar Zinciri'nde durur.
-->

## Amaç
<!-- Proje ne işe yarıyor, kimin için? Tek paragraf yeterli. -->

## Teknoloji yığını
<!-- Diller, çatılar, veritabanları, önemli kütüphaneler ve sürümleri. -->

## Mimari
<!-- Ana bileşenler, servisler ve aralarındaki ilişki. Veri nereden gelir, nereye gider? -->

## Repolar ve dizin yapısı
<!-- Hangi repo ne içerir; önemli klasörler ve sahipleri. -->

## Komutlar
<!-- Kurulum, geliştirme sunucusu, test, lint, build. Örn: `pnpm test`, `uv run pytest`. -->

## Kodlama kuralları
<!-- İsimlendirme, hata yönetimi, test beklentileri, commit biçimi, yasaklı kalıplar. -->

## Ortamlar
<!-- local / test / production: adresler, deploy yöntemi, kimin onayı gerekir. -->

## Sözlük
<!-- Projeye özgü terimler ve kısaltmalar. -->
"""

BOUNDARIES_MD = """\
---
# Bu bölüm makinece okunur ve sınır motorunu doğrudan besler.
# Yollar repo köküne göre, .gitignore biçiminde yazılır (örn. "secrets/**").
forbidden_paths: []        # Hiç okunmayacak ve yazılmayacak yollar. Örn: [".env", "secrets/**"]
readonly_paths: []         # Okunabilir ama değiştirilemez yollar. Örn: ["migrations/**", "vendor/**"]
allowed_commands: []       # Sormadan çalıştırılabilecek komut desenleri. Örn: ["npm test", "uv run pytest*"]
denied_commands: []        # Her zaman reddedilecek komut desenleri. Örn: ["rm -rf *", "git push --force*"]
network: true              # Ajanların ağ erişimi (true / false)
sandbox: workspace_write   # read_only | workspace_write | full
remote_access: none        # Uzak sunucu erişimi: none | read | limited | full
---

# Sınırlar

Bu dosya ajanların bu çalışma alanında neye dokunabileceğini belirler. Üstteki ön bilgi
bölümü (iki `---` çizgisi arası) makinece okunur ve her ajan oturumunda dört katmanda uygulanır:
CLI'ın kendi izin ayarları, izin isteklerinin politika motoru, birleştirme öncesi sınır
denetimi kapısı ve uzak erişimin yalnız Studio araçlarıyla yapılması.

## Alanlar

- **forbidden_paths:** Ajanların hiç okumaması ve yazmaması gereken yollar.
- **readonly_paths:** Okunabilen ama değiştirilemeyen yollar.
- **allowed_commands:** Kullanıcıya sorulmadan çalıştırılabilecek komut desenleri.
- **denied_commands:** Her zaman reddedilecek komut desenleri.
- **network:** `false` ise ajanlar ağa erişemez.
- **sandbox:** `read_only` salt okuma, `workspace_write` yalnız çalışma alanına yazma, `full` tam yetki.
- **remote_access:** Uzak sunuculara erişim seviyesi; `none` ise hiç erişilemez.

## Açıklamalar

<!-- Neden bu sınırları koyduğunu buraya yaz. Ajanlar bu bölümü de okur. -->
"""

DECISIONS_README_MD = """\
# Karar kayıtları

Bu klasörde alınan mimari ve teknik kararlar tarih sırasıyla tutulur. Her karar ayrı bir
dosyadır: `YYYY-MM-DD-kisa-baslik.md`. Ajanlar karar dizinini (tarih, başlık, tek satırlık özet)
sistem isteminde görür; ayrıntıyı `memory_read` aracıyla okur.

Kararlar Kurul akışlarından ya da ajanların `memory_propose` önerilerinden gelir ve ancak senin
onayınla kaydedilir. Elle de ekleyebilirsin.

## Şablon

```markdown
---
title: Kısa karar başlığı
date: 2026-01-31
status: kabul edildi   # önerildi | kabul edildi | yerini aldı | reddedildi
summary: Kararın tek cümlelik özeti.
---

# Kısa karar başlığı

## Bağlam
Hangi sorun ya da ihtiyaç bu kararı gerektirdi?

## Karar
Ne yapmaya karar verdik?

## Sonuçlar
Olumlu ve olumsuz etkiler, kabul edilen ödünler.

## Değerlendirilen seçenekler
Seçilmeyen alternatifler ve neden seçilmedikleri.
```
"""

SESSIONS_README_MD = """\
# Oturum özetleri

Her ajan oturumu bittiğinde AI Studio bu klasöre bir özet önerir:
`YYYY-MM-DD-<oturum>.md`. Özet; istenen işi, ajanın son yanıtını, değişen dosyaları,
çalıştırılan komutları ve kullanımı içerir. Öneri onaylanınca kaydedilir.

Ajanlar son birkaç oturumun başlığını sistem isteminde görür; ayrıntıyı `memory_read`
aracıyla okur. Otomatik özetler Ayarlar → Hafıza bölümünden kapatılabilir.
"""

GITIGNORE = """\
.DS_Store
*.swp
*~
"""

STARTER_FILES: dict[str, str] = {
    "facts.md": FACTS_MD,
    "boundaries.md": BOUNDARIES_MD,
    "decisions/README.md": DECISIONS_README_MD,
    "sessions/README.md": SESSIONS_README_MD,
    ".gitignore": GITIGNORE,
}
