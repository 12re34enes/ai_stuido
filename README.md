# AI Studio

Claude Code ve Codex ajanlarını kendi aboneliklerinizle, resmî CLI'lar üzerinden birlikte çalıştıran,
macOS (Apple Silicon) için yerel masaüstü orkestrasyon stüdyosu.

- [Genel plan](docs/plan.md)
- [Teknik şartname](docs/sartname.md) — ürünün tek doğru kaynağı
- [Katkı rehberi](CLAUDE.md) — kod düzeni, kurallar, komutlar (İngilizce)

## Neler yapar

| Alan | Kısaca |
| --- | --- |
| **Görevler** | Tek, İkili, Yarış, Hat, Kurul ve **Ekip** modları; her adım canlı izlenir, geri sarılır, yeniden oynatılır. |
| **Ekip orkestrasyonu** | Danışman → Lider → Geliştiriciler → alt ajanlar hiyerarşisini görsel olarak kurun; bağımlı/bağımsız test ajanları ekleyin, her üyenin sağlayıcısını, modelini ve effort'unu ayrı seçin. |
| **Akışlar** | Ajan, danışman, kapı, paralel, birleştirme, karşılaştırma, koşul, sentez, git, deploy ve insan düğümleriyle akış tasarlayın; zamanlayın. |
| **Stüdyolar** | Mimari, pazar analizi, kod incelemesi, hata ayıklama, dokümantasyon gibi hazır akış + çıktı şablonları; kendi stüdyonuzu YAML ile yazın. |
| **Oturumlar** | Claude/Codex oturumlarını canlı izleyin, yönlendirin, durdurun; ajanların kendi alt ajanları ağaç olarak görünür, bağlam penceresi doluluğu halkada izlenir. Makinenizdeki veya sunuculardaki mevcut oturumları içe aktarın. |
| **Ortak hafıza** | Çalışma alanı başına `facts.md`, kararlar ve görev özetleri; ajan önerileri onayınızla hafızaya girer. |
| **Kapılar ve onaylar** | Test, lint, tip, inceleme ve insan kapıları; onay kutusu menü çubuğundan, bildirimlerden ve kanallardan erişilir. Üretim onayları varsayılan olarak yalnızca uygulamadan verilir. |
| **Uzak erişim** | SSH sunucuları ve veritabanları ortam etiketleriyle (yerel/test/üretim) ve yetki seviyeleriyle; tüm uzak komutlar denetim kaydına yazılır. |
| **Git ve deploy** | Her ajan kendi worktree'sinde çalışır; çakışma kontrolü, kontrol noktaları, GitHub/GitLab PR/MR, CI durumu ve deploy profilleri. |
| **Limitler** | Abonelik pencereleri, kullanım ve bütçeler; limit dolunca sıraya al, sor ya da diğer sağlayıcıya geç. |
| **Uyarılar** | macOS bildirimi, Telegram, Slack, Discord, Microsoft Teams, e-posta, ntfy ve webhook kanalları; sessiz saatler ve yönlendirme kuralları. |
| **Masaüstü** | Menü çubuğu simgesi, genel kısayol (varsayılan ⌃⌥Space), komut paleti (⌘K), açık/koyu tema, hareketli arayüz. |

## Gereksinimler

- macOS 13+ ve Apple Silicon
- [`uv`](https://docs.astral.sh/uv/) (Python 3.13'ü kendisi kurar), Node.js ve `pnpm` 10
- Masaüstü uygulaması için Rust (`rustup`) ve Xcode Command Line Tools
- Giriş yapılmış CLI'lar: `claude` (Claude Code) ve/veya `codex` (OpenAI Codex). AI Studio API anahtarı
  istemez; CLI'ların kendi abonelik oturumlarını kullanır.

## Hızlı başlangıç

```sh
make setup        # backend (uv) ve arayüz (pnpm) bağımlılıkları
make demo         # örnek veriler ve sahte CLI'larla arayüzü gezin — kota harcamaz, giriş gerekmez
```

`make demo` açıldığında tarayıcıda http://localhost:1420 adresine gidin. Demo, gerçek studiod'u sahte
Claude/Codex süreçleriyle çalıştırır ve örnek bir çalışma alanı, biten bir İkili görev, onay bekleyen bir
Hat görevi, sunucular ve bir veritabanı profili oluşturur. Verileri `.aistudio-demo/` altında tutar.

Gerçek CLI'larla geliştirme:

```sh
make dev          # studiod (8765) + web arayüzü (1420), veriler .aistudio-dev/ altında
make dev-app      # aynı backend ile Tauri masaüstü uygulaması (macOS)
make verify-clis  # gerçek claude/codex CLI'larını bu Mac'te doğrular (çok az kota harcar)
```

`make verify-clis` adaptörlerin kullandığı her CLI davranışını (akış, izin turları, kesme, limit
olayları, oturum içe aktarma, alt ajanlar) ucuz bir modelle sınar ve ham kayıtları maskeli olarak
`scripts/verify/out/` altına yazar. CLI sürümünü güncelledikten sonra çalıştırın.

## Uygulamayı paketleme

```sh
scripts/package/build-macos-app.sh          # "AI Studio.app" (ad-hoc imzalı)
scripts/package/build-macos-app.sh --dmg    # ayrıca .dmg
```

Betik gömülü bir Python 3.13 ile studiod'u uygulamanın içine koyar; uygulama ilk açılışta studiod'u bir
LaunchAgent olarak kaydeder, böylece pencere kapalıyken de görevler ve zamanlanmış akışlar çalışır.
Developer ID imzası ve notarization için betiğin başındaki açıklamaya bakın.

Veriler `~/Library/Application Support/AI Studio` altındadır (`AISTUDIO_HOME` ile değiştirilebilir);
gizli değerler macOS Anahtar Zinciri'nde tutulur, olay kaydı ve ayarlar yerel SQLite'tadır.

## Güvenlik notları

- Ajanlar temizlenmiş bir ortamla çalışır: SSH ajanı, bulut kimlikleri ve token'lar ajan sürecine geçmez.
  Uzak sunucu ve veritabanı erişimi yalnızca AI Studio araçları üzerinden, yetki seviyesine göre olur.
- Ajan çıktıları, kayıtlar ve bildirimler bilinen gizli değerlere ve token kalıplarına karşı maskelenir.
- Üretim ortamındaki yazma işlemleri ve deploy'lar onay ister; bu onaylar varsayılan olarak yalnızca
  uygulamadan verilebilir.

## Geliştirme

```sh
make check        # gizli değer taraması + lint + tip denetimi + testler (backend ve arayüz)
make test         # yalnızca testler
cd apps/desktop && pnpm e2e        # Playwright uçtan uca testleri (sahte backend ile)
cd apps/desktop/src-tauri && cargo test
```

Ayrıntılı kurallar, modül yapısı ve katkı süreci için [CLAUDE.md](CLAUDE.md).
