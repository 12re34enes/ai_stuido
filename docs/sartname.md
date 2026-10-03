# AI Studio: Teknik Şartname

> Durum: **Taslak, onay bekliyor.** Kaynak: [plan.md](plan.md) ve planlama konuşmasında alınan kararlar.
> Bu belge onaylanınca kodlama buna göre yapılır. Değişen her karar önce burada güncellenir.

---

## 0. Özet

AI Studio, macOS (Apple Silicon) üzerinde çalışan, tek kullanıcılı bir masaüstü uygulaması. Claude Code ve Codex ajanlarını kullanıcının kendi aboneliğiyle, resmi CLI'lar üzerinden çalıştırır. Kullanıcının tasarladığı akışlarla ajanları yönetir, tüm ajanları ortak hafızadan besler. İşler kanıtlı kontrol kapılarından geçmeden tamamlanmış sayılmaz.

**İlk kullanılabilir sürüm her şeyi içerir.** Bölüm 21'deki adımlar ayrı sürümler değil, inşa sırasıdır.

## 1. Alınan kararlar

| Konu | Karar |
|---|---|
| Ad | **AI Studio** |
| Platform | macOS, Apple Silicon (M3). Optimize, yerel masaüstü uygulaması |
| Hesaplar | Claude ve ChatGPT **abonelikleri**. Plan türünden bağımsız çalışır: limitler CLI'lardan yüzde ve sıfırlanma zamanı olarak okunur |
| Ajanların çalıştırılması | Resmi `claude` ve `codex` CLI'ları kullanıcının kendi girişiyle alt süreç olarak sürülür. Uygulama hiçbir oturum belirtecine dokunmaz |
| Kabuk | Tauri 2 + React + TypeScript |
| Motor | Python (FastAPI). Arka planda sürekli çalışan servis (launchd) |
| Arayüz dili | Türkçe (kod, dosya ve tanımlayıcılar İngilizce) |
| Tema | Açık ve koyu (sistemle eşleşir, elle seçilebilir) |
| Hareket | Uygulamanın her yerinde, bol ve anlamlı. Referans: Claude, Codex, Apple |
| Git barındırma | GitHub ve GitLab (kendi sunucusunda barındırılan GitLab dahil). Claude'daki gibi PR/MR, CI ve review entegrasyonu |
| Deploy | Uygulama deploy'u kendisi yapar. Production deploy'u kilitli onaydan geçer |
| Menü çubuğu, bildirim, genel kısayol | Üçü de var |
| Uyarılar | Çok kanallı (bkz. bölüm 15). Kanaldan onay verme desteği |
| Mevcut oturumlar | Yerelde ve uzak sunucuda daha önce çalışmış Claude/Codex oturumları keşfedilip ajan olarak eklenebilir ve devam ettirilebilir |
| Proje yapısı | Uygulama hiçbir proje yapısı varsaymaz. Çalışma alanı tek repo da olabilir, repo grubu da |

## 2. Doğrulanmış CLI yetenekleri

3 Ekim 2026'da güncel sürümler üzerinde kontrol edildi. Ayrıntılı doğrulama gerçek girişle kullanıcının Mac'inde yapılacak (bölüm 21, M0).

### Claude Code 2.1.288

- **Başsız çalışma:** `claude -p --input-format stream-json --output-format stream-json --verbose`. Çift yönlü JSON akışı sağlar, süreç açık kaldıkça çok turlu konuşma yapılabilir.
- **Kontrol protokolü:** `can_use_tool` ile izin istekleri bize gelir, `interrupt` ile durdururuz. Diğer alt tipler:
  - `set_permission_mode`: izin modunu değiştirir
  - `mcp_message`: aracı sunucuyu bizim süreçte barındırmamızı sağlar
  - `rewind_files`: dosyaları geri sarar
- **Oturum yönetimi:**
  - `--session-id <uuid>`, `--resume <id>`, `--fork-session`
  - Oturum dosyaları `~/.claude/projects/<dizin>/<oturum>.jsonl` altında
- **Limit bilgisi:** Akışta `rate_limit_event` olayı gelir. İçeriği:
  - `five_hour`, `seven_day`, model bazlı haftalık pencereler
  - `utilization`, `resetsAt`
  - `status` (`allowed` / `allowed_warning` / `rejected`)
- **Sınırlar ve izinler:** `--settings` (allow/deny kuralları), `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--add-dir`.
- **Bağlam verme:** `--append-system-prompt`, `--mcp-config`, `--strict-mcp-config`, `--model`, `--effort`.

### Codex CLI 0.160.0

- **`codex app-server`:** stdio üzerinden JSON-RPC konuşur. Protokol şeması `codex app-server generate-json-schema` ile üretilebiliyor. Kullanacağımız yöntemler:
  - `thread/start`: `cwd`, `sandbox`, `approvalPolicy`, `model`, `developerInstructions` alır
  - `turn/start`, `turn/steer` (çalışan tura müdahale), `turn/interrupt`
  - `thread/resume`, `thread/fork`, `thread/revert`
  - `thread/list` (`cwd` filtresiyle), `thread/read`, `thread/turns/list`
  - `account/rateLimits/read` ve güncelleme bildirimi: `primary`/`secondary` pencereler, `usedPercent`, `resetsAt`, `windowDurationMins`. Boştayken de okunabilir.
  - Sunucudan bize gelen istekler: komut, dosya değişikliği ve izin onayları, dinamik araç çağrıları
- **Yedek yol:** `codex exec --json` ve `codex exec resume`. app-server "deneysel" olarak işaretli olduğu için bu yol açık tutulur.
- **Sandbox seçenekleri:** `read-only`, `workspace-write`, `danger-full-access`.

### Bunun sonuçları

- İki sağlayıcıda da **limitler okunabiliyor**. Kendi sayacımız yalnız yedek olarak kalır.
- İki sağlayıcıda da **izin istekleri bize geliyor**. Kapılar ve onay kutusu, CLI'ın kendi akışına doğal biçimde bağlanır.
- İki sağlayıcıda da **araçları ajan kanalının içinden sunabiliyoruz**: Claude'da `mcp_message`, Codex'te dinamik araçlar. Böylece uzak sunucuda çalışan ajana da port yönlendirmesi olmadan Studio araçlarını veririz.
- Adaptörler stdio konuşuyor. Bu yüzden **aynı adaptör hem yerel süreçte hem SSH kanalında** çalışır (bölüm 6).

## 3. Mimari

```
┌────────────────────────── AI Studio.app (Tauri 2) ──────────────────────────┐
│  React arayüz (WKWebView)   Menü çubuğu ikonu   Genel kısayol   Bildirimler   │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket (127.0.0.1, belirteçli)
┌───────────────▼────────────── studiod (Python, launchd) ─────────────────────┐
│ API · Olay günlüğü · Akış motoru · Kapılar · Hafıza · Limitler · Zamanlayıcı │
│ Git barındırma · Uzak bağlantılar · Deploy · Uyarılar · Maskeleme · Yedek    │
│ Adaptörler: claude │ codex       Taşıyıcılar: yerel süreç │ SSH kanalı        │
└──────┬──────────────────────┬───────────────────────────┬────────────────────┘
       │ stdio                │ stdio                     │ asyncssh
  claude -p (stream-json)  codex app-server        Uzak host: CLI'lar, kabuk, DB
```

- **Uygulama (Tauri):** Pencereler, menü çubuğu, genel kısayol ve yerel bildirimlerden sorumlu. Pencere kapanınca uygulama menü çubuğunda yaşamaya devam eder.
- **studiod:** Bütün iş mantığı burada. Girişte launchd ile başlar (macOS `SMAppService`). Uygulamadan tamamen çıkılsa bile PR takibi, zamanlanmış görevler ve uyarılar çalışır.
- **İletişim:** studiod yalnız `127.0.0.1` üzerinde, rastgele bir portta dinler. Bağlantı, Anahtar Zinciri'nde tutulan kuruluma özel bir belirteçle doğrulanır, `Origin` kontrol edilir. Komutlar HTTP ile gider, canlı olaylar WebSocket ile gelir.
- **Veri:** `~/Library/Application Support/AI Studio/` altında:
  - `studio.db`: SQLite, WAL modu
  - `workspaces/<ad>/memory/`: her çalışma alanının hafıza reposu
  - `worktrees/`
  - `checkpoints/`
  - `backups/`
  - `logs/`
- **Gizli bilgiler:** Yalnız macOS Anahtar Zinciri'nde tutulur. Veritabanında sadece referansları olur.

### Teknoloji seçimi

| Katman | Seçim | Neden |
|---|---|---|
| Kabuk | Tauri 2 (Rust) | Sistemin WebKit'ini kullanır, düşük bellek, hızlı açılış. Yerel titreşim (vibrancy) efekti, menü çubuğu ve kısayol desteği var |
| Arayüz | React 19, TypeScript, Vite | Planla uyumlu, olgun ekosistem |
| Hareket | Motion (motion.dev) | Yay fiziği, yerleşim ve paylaşılan öğe geçişleri, kesintiye uğratılabilir animasyonlar |
| Tuval | @xyflow/react | Akış tuvali için endüstri standardı |
| Durum | TanStack Query (sunucu), Zustand (arayüz) | Basit ve hızlı |
| Büyük listeler | TanStack Virtual | Binlerce satırlık canlı çıktıda akıcılık |
| Editör ve diff | CodeMirror 6 (merge görünümü dahil) | Monaco'dan çok daha hafif |
| Komut paleti | cmdk | Raycast tarzı palet |
| Erişilebilir temel bileşenler | Radix Primitives | Stil bizim, davranış ve erişilebilirlik hazır |
| Stil | Tailwind v4 + CSS değişkeni tasarım belirteçleri | Tutarlılık, hız |
| Motor | Python 3.13, uv, FastAPI, uvicorn, Pydantic v2 | İş G/Ç ağırlıklı. SSH, DB ve keychain kütüphaneleri olgun |
| Veritabanı | SQLite + SQLAlchemy Core + Alembic | Göçler (migration) kontrollü |
| SSH | asyncssh | Async, jump host, port yönlendirme |
| SQL sınıflandırma | sqlglot | Okuma/yazma ayrımı için sorgu ayrıştırma |
| Git | git CLI (alt süreç) | worktree ve `merge-tree` için en güvenilir yol |
| Dosya izleme | watchfiles (FSEvents) | Canlı çakışma uyarısı |
| Paketleme | python-build-standalone, `.app` içinde gömülü | PyInstaller tek dosyanın yavaş açılışı yok |
| Tip paylaşımı | Pydantic → JSON Schema → TypeScript | Arayüz ve motor tek şemadan beslenir |
| Testler | pytest, vitest, Playwright (WebKit motoru) | WebKit testi, WKWebView'a en yakın sonuç |

## 4. Çekirdek kavramlar ve veri modeli

Tek gerçek kaynak **olay günlüğüdür**. Diğer tablolar ya yapılandırma ya da hız için olaylardan türetilmiş görünümlerdir.

| Tablo | İçerik |
|---|---|
| `event` | Sadece eklenen olay günlüğü: zaman, çalışma alanı, görev, oturum, tür, veri. Önceki olayın özetini (hash) içerir, sonradan değiştirilirse fark edilir. Arama için FTS5 |
| `workspace` | Ad, renk, ayarlar |
| `repo` | Çalışma alanına bağlı bir veya birden fazla repo: yol, uzak adres, sağlayıcı, varsayılan branch, kapılarda kullanılan komutlar (lint/test/build) |
| `account` | GitHub/GitLab hesapları (sunucu adresi, Anahtar Zinciri referansı). Claude/Codex girişi CLI'ın kendisinde kalır, biz yalnız durumunu gösteririz |
| `agent_profile` | Ad, sağlayıcı, model, efor, rol, ek talimat, sınırlar, izinler |
| `agent_session` | Çalışan veya geçmiş oturum: sağlayıcı, CLI'ın oturum kimliği, konum (yerel veya host), dizin, worktree, durum, kaynak (oluşturuldu/içe aktarıldı) |
| `flow` | Düğüm ve bağlantı grafiği, sürüm, şablon mu, bağlı stüdyo |
| `task` | Başlık, istem, akış, bütçe, öncelik, zamanlama |
| `run`, `node_run` | Akışın bir koşusu ve düğüm koşuları: durum, deneme sayısı, çıktılar |
| `gate_result` | Kapı türü, sonuç, kanıt, kararı kimin verdiği |
| `approval` | Merkezi onay kutusu: plan, hafıza, uzak komut, deploy, birleştirme, son onay, araç izni. Hangi kanaldan karar verildiği de tutulur |
| `memory_proposal` | Katman, diff, kaynak oturum, durum |
| `checkpoint` | Worktree git referansları, hafıza commit'i, koşu durumu |
| `host`, `db_profile` | Bağlantı bilgileri, ortam etiketi, yetki seviyesi, Anahtar Zinciri referansı |
| `deploy_profile` | Tür (CI / SSH / komut), hedef ortam, sağlık kontrolü, geri alma komutu |
| `limit_snapshot` | Sağlayıcı, pencere, kullanım yüzdesi, sıfırlanma zamanı, kaynak (olay/sorgu/tahmin) |
| `alert_channel`, `alert_rule` | Kanal ayarları, kural (olay türü, önem, çalışma alanı, kanallar, sessiz saatler) |
| `studio` | Sürümlü şablon (bölüm 16) |
| `schedule` | Zamanlanmış görev şablonu, cron, sonraki çalışma |

## 5. Akış motoru

Akış, düğümlerden oluşan bir grafiktir. **Çalışma modları ve stüdyolar ayrı kod değil, hazır akış şablonlarıdır.**

### Düğüm türleri

| Düğüm | Görev |
|---|---|
| `agent` | Kod yazan ajan adımı. Kendi worktree'sinde çalışır |
| `advisor` | Danışman. Salt okuma, kod yazmaz, görüş belgesi üretir |
| `gate` | Kontrol kapısı (bölüm 9) |
| `parallel` / `join` | Dallanma ve birleşme. Join hepsini veya ilk biteni bekleyebilir |
| `compare` | Yarış sonuçlarını karşılaştırır: kapıları her sonuçta çalıştırır, yan yana gösterir, kullanıcı veya hakem ajan seçer |
| `condition` | Çıktıya göre yönlendirir. Örnek: inceleme başarısızsa geliştiriciye döner. Döngülerin üst sınırı var |
| `synthesis` | Kurul: görüşleri toplar, karşı tez ister, tek karar belgesi yazar |
| `merge` | Worktree'yi hedef branch'e birleştirir (bölüm 7) |
| `git` | Push, PR/MR açma |
| `deploy` | Deploy profilini çalıştırır |
| `human` | Kullanıcıdan girdi veya elle yapılacak bir adım |

### Hazır mod şablonları

```
Tek:    [ajan] → [build/test] → [son onay]
İkili:  [yazar: A] → [build/test] → [inceleme: B] ─başarısız→ yazar (en fazla N tur)
Yarış:  ┌[ajan A]┐
        └[ajan B]┘ → [karşılaştır] → [seçilen birleşir]
Hat:    [planlayıcı] → [plan onayı] → [geliştirici] → [inceleyen] → [test eden] → [son onay]
Kurul:  ┌[danışman A]┐
        └[danışman B]┘ → [karşı tez] → [sentez] → [karar belgesi] → [hafızaya karar önerisi]
```

- **Veri aktarımı:** Düğüm çıktıları saklanır. Şablonlar `{{nodes.plan.output}}`, `{{memory.decisions}}`, `{{input.*}}` ile bunlara başvurur.
- **Dayanıklılık:** Koşu durumu veritabanında tutulur. studiod yeniden başlarsa koşular kaldığı yerden devam eder. Ajan oturumları CLI'ın kendi oturum kimliğiyle sürdürülür.
- **Çapraz inceleme kuralı:** İnceleyen, yazandan farklı sağlayıcıda olmak zorundadır. Motor bunu zorunlu tutar.

## 6. Ajan adaptörleri

### Ortak arayüz

Her sağlayıcı bir adaptördür ve şunları uygular:
- `start` / `resume` / `fork`
- `send` (yeni mesaj), `steer` (çalışan tura müdahale), `interrupt`
- `events()`: olayları ortak şemaya çevirir. Olay türleri:
  - mesaj parçası, mesaj
  - araç çağrısı, araç sonucu
  - dosya değişikliği, komut
  - izin isteği, kullanım, limit
  - tur sonu, hata
- `respond_approval`
- `read_limits`
- `list_sessions` / `import_session`

**Taşıyıcı adaptörden ayrıdır:** Yerel süreç veya SSH kanalı. İki CLI da stdio konuştuğu için aynı adaptör uzak sunucuda da değişmeden çalışır.

### Claude adaptörü

- **Başlatma:** `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` ile birlikte:
  - `--session-id` veya `--resume`
  - `--settings` (ürettiğimiz izin kuralları)
  - `--append-system-prompt` (hafıza)
  - `--model`, `--effort`
- **İzinler:** `can_use_tool` istekleri politika motorumuza gelir. Motor ya otomatik karar verir ya da onay kutusuna düşürür.
- **Studio araçları:** `mcp_message` ile aynı kanaldan sunulur.
- **Limitler:** `rate_limit_event` olaylarından alınır. Kullanım ve bağlam doluluğu tur sonu olayından hesaplanır.
- **Boştayken limit:** Son bilinen değer gösterilir, ne kadar eski olduğu da yazılır. Boştayken limit sorgulamanın limit harcamayan bir yolu var mı, M0'da doğrulanacak.

### Codex adaptörü

- **Başlatma:** `codex app-server` (stdio JSON-RPC). Bir süreç birden fazla thread taşıyabilir.
  - `thread/start`: `developerInstructions` ile hafızayı, `sandbox` ve `approvalPolicy` ile sınırları verir
  - `turn/steer` ile müdahale edilir
  - Onay istekleri politika motorumuza gelir
- **Studio araçları:** Dinamik araçlar ile sunulur.
- **Limitler:** `account/rateLimits/read` ve güncelleme bildirimi.
- **Protokol tipleri:** CLI sürümüne sabitlenmiş şemadan otomatik üretilir. Testler protokol değişikliğini yakalar.

### Sürüm politikası

- Her adaptör test edilmiş sürüm aralığını bildirir.
- Açılışta `claude --version` ve `codex --version` okunur. Aralık dışındaysa uyarı gösterilir.
- **"Uyumluluk testi"** düğmesi kısa bir duman testi çalıştırır.
- Kaydedilmiş gerçek akışlar (maskelenmiş) ile çalışan **sahte CLI'lar** vardır. Testler limit harcamadan ve CLI kurulu olmayan ortamda bütün akışları koşturur.

### Mevcut oturumları ekleme

- **Yerel keşif:** `~/.claude/projects/**/*.jsonl` taranır, Codex'te `thread/list` kullanılır.
- **Uzak keşif:** Seçilen hostta SSH üzerinden aynı keşif yapılır. Uzakta Codex için app-server SSH kanalında çalıştırılır.
- **Liste:** Oturumlar proje dizinine göre gruplanır. Her birinde başlık, son etkinlik, model, mesaj sayısı, dizin ve branch görünür.
- **Ekle:** Oturumun geçmişi olay günlüğüne aktarılır (tekrar oynatılabilir) ve oturuma bağlı bir ajan kartı oluşur.
- **Devam:** Oturum kendi konumunda sürdürülür: Claude için `--resume`, Codex için `thread/resume`. Uzak oturum o sunucuda, SSH üzerinden devam eder.
- **Harici izleme:** Uygulama dışında açılmış (ör. terminalde) çalışan oturumlar salt okuma olarak canlı izlenebilir.
- **Uzak sunucu ön koşulu:** Sunucuda CLI kurulu ve giriş yapılmış olmalı. Uygulama bunu kontrol eder ve eksikse kurulum adımlarını gösterir.

## 7. İzolasyon, birleştirme ve çakışma

- **Worktree:** Kod yazan her ajan kendi worktree'sinde çalışır: `aistudio/<görev>/<ajan>-<n>` branch'i. Danışmanlar salt okuma sandbox'ta çalışır.
- **Çok repolu görev:** Ajan dokunduğu her repo için bir worktree alır (worktree seti). Birleştirme ve PR her repo için ayrı yapılır ama birbirine bağlıdır.
- **Canlı çakışma uyarısı:** Etkin ajanların worktree'leri izlenir. İki ajan aynı dosyaya dokunduğunda iki kartta da uyarı çıkar.
- **Birleştirme öncesi:** `git merge-tree --write-tree` ile checkout yapmadan çakışma tespit edilir, diff gösterilir. Seçenekler:
  - birleştir
  - squash
  - cherry-pick
  - çakışmayı bir ajana çözdür. Çözüm yeni bir worktree'de yapılır ve kapılardan tekrar geçer.
- **Temizlik:** Birleşen veya terk edilen worktree'ler, ayarlanabilir bir süre sonra temizlenir.
- **Uzak ajanlar:** Worktree'leri uzak sunucuda, aynı kurallarla oluşturulur.

## 8. Sınırlar ve izinler

Sınırlar ajan profilinde ve çalışma alanının `boundaries.md` hafıza dosyasında tanımlanır. Tanımlanabilenler:
- dokunulmayacak yollar
- salt okunur yollar
- izinli komutlar
- ağ erişimi
- sandbox seviyesi
- uzak bağlantı erişimi

Sınırlar dört katmanda uygulanır:

1. **CLI'ın kendi mekanizması:** Claude'da `--settings` deny kuralları ve `--disallowedTools`. Codex'te sandbox modu ve kurallar.
2. **İzin isteklerinin yakalanması:** Her araç izni politika motorundan geçer. Motor otomatik izin verir, reddeder veya kullanıcıya sorar.
3. **Sonradan sınır denetimi kapısı:** Diff, yasak yollarla karşılaştırılır. İhlal varsa kapı başarısız olur ve değişiklik birleşmez.
4. **Uzak erişim yalnız Studio araçlarıyla:**
   - Ajan süreçleri temizlenmiş bir ortamla başlar: `SSH_AUTH_SOCK` yok, `~/.ssh` okunamaz.
   - `ssh`, `scp`, `rsync`, `psql`, `mysql` gibi doğrudan erişim komutları engellidir.
   - Ajan uzak sisteme yalnız `remote.exec` ve `db.query` araçlarıyla dokunabilir. Bunlar da yetki seviyesinden, onaydan ve kayıttan geçer.

## 9. Kontrol kapıları

Her kapının girdisi, denetimi, kanıtı ve kararı kayıt altındadır.

| Kapı | Nasıl çalışır |
|---|---|
| Plan onayı | Plan düğümünün çıktısı onay kutusuna düşer. Kullanıcı planı düzenleyebilir, onaylayabilir veya notla reddedebilir |
| Sınır denetimi | Otomatik. Diff ve komut kaydı sınırlarla karşılaştırılır |
| Build/test kanıtı | Repo'da tanımlı lint, typecheck, test ve build komutlarını **ajan değil studiod çalıştırır**. Çıkış kodları ve çıktılar saklanır. Ajanın "testler geçti" demesi kanıt sayılmaz |
| Çapraz model incelemesi | Farklı sağlayıcı inceler. Bulgular önem derecesiyle yapılandırılmış gelir. Engelleyici bulgu varsa iş yazara geri döner (tur sınırı var) |
| Kullanıcı son onayı | Özet, diff ve kanıtlar tek ekranda gösterilir |
| Deploy onayı | Deploy düğümünden önce çalışır |
| Production komut onayı | Production'daki her yazma komutu için ayrı ayrı istenir |

- Kapılar akış başına açılıp kapatılabilir.
- **Production'la ilgili kapılar kilitlidir**, kapatılamaz.

## 10. Ortak hafıza

- **Katmanlar:**
  - `facts.md`: proje gerçekleri
  - `decisions/`: tarihli karar kayıtları
  - `boundaries.md`: sınırlar. Ön bilgi bölümü makinece okunur ve doğrudan sınır motorunu besler.
  - `sessions/`: oturum özetleri
- **Saklama:** Her çalışma alanının uygulama veri dizininde kendi git reposu olur. Böylece şirket repolarına dosya eklenmez. İstenirse repo'daki `.aistudio/memory/` dizinine bağlanabilir.
- **Düzenleme:** Uygulama içi markdown editörüyle ya da harici bir editörle yapılabilir.
- **Ajanlara verilmesi:**
  - Claude'a `--append-system-prompt`, Codex'e `developerInstructions` ile verilir.
  - Sistem istemine yalnız gerçekler, sınırlar ve kararların dizini girer.
  - Ayrıntıyı ajan `memory.read` aracıyla okur.
- **Yazma önerisi:** Ajan `memory.propose` aracını çağırır. Öneri yan çekmecede diff olarak görünür, onaylanınca commit edilir.
- **Oturum sonu:** Oturum bitince özet otomatik olarak öneri halinde gelir.

## 11. Studio araçları (ajanlara sunulan)

İki sağlayıcıda da ajan kanalının içinden sunulur (bölüm 2).

| Araç | İşlev |
|---|---|
| `memory.read`, `memory.propose` | Hafıza okuma ve yazma önerisi |
| `evidence.submit` | Kanıt ekleme (çıktı, ekran görüntüsü). Kapı kanıtı yine studiod'un kendi çalıştırdığıdır |
| `ask_user` | Kullanıcıya soru sorar. Soru onay kutusuna düşer, uyarı üretir |
| `remote.exec` | Uzak komut. Yetki seviyesi, onay ve kayıttan geçer |
| `db.query` | Veritabanı sorgusu. Sınıflandırılır, production'da salt okuma işlemi içinde çalışır |
| `deploy.request` | Deploy isteği. Kapılardan geçer |
| `handoff`, `report_status` | Devretme ve durum bildirimi. Akış animasyonunu da besler |

## 12. Uzak bağlantılar

- **SSH:**
  - `~/.ssh/config` içe aktarılabilir.
  - Jump host (ProxyJump) desteklenir.
  - Anahtar veya parola kullanılabilir, ikisi de Anahtar Zinciri'nde durur.
  - `known_hosts` sıkı biçimde doğrulanır.
- **Veritabanı:** PostgreSQL, MySQL/MariaDB, SQLite, MSSQL, MongoDB, Redis. Doğrudan veya SSH tüneliyle bağlanılır.
- **Ortam etiketi:** `local` (nötr), `test` (amber), `production` (kırmızı). Production bağlamı etkinken pencerenin etrafında ince kırmızı bir çerçeve ve etiket görünür. Karışması mümkün değildir.
- **Yetki seviyeleri:** Salt okuma, sınırlı yazma, tam yetki.
  - Production'da varsayılan salt okumadır.
  - Production'daki yazma komutları her seferinde tek tek onaylanır, "her zaman izin ver" seçeneği yoktur.
- **Komut sınıflandırma:**
  - **Kabuk:** Bilinen salt okuma komutlarından (`ls`, `cat`, `tail`, `grep`, `journalctl`, `docker ps/logs`, `systemctl status`...) bir izin listesi var, argümanlar da ayrıştırılır. Pipe ve yönlendirmeler incelenir. Tanınmayan her komut yazma sayılır.
  - **SQL:** sqlglot ile ayrıştırılır. `SELECT`, `EXPLAIN`, `SHOW` okuma sayılır, geri kalan her şey yazma sayılır. Çok ifadeli sorgularda her ifade ayrı değerlendirilir. Salt okuma seviyesinde veritabanı tarafında da salt okuma işlemi açılır (ikinci katman).
- **Kayıt:** Her uzak komut kayıt altına alınır:
  - kim çalıştırdı (ajan / kullanıcı)
  - ne çalıştırdı, nasıl sınıflandı
  - kim onayladı
  - maskelenmiş çıktı, çıkış kodu, süre

  Kayıt değiştirilemez ve dışa aktarılabilir.
- **Uzak terminal:** Kullanıcının kendi komutları için bir uzak terminal var. Bu komutlar da aynı kayda düşer.

## 13. GitHub ve GitLab

- **Hesap:**
  - Kişisel erişim belirteci kullanılır, kurulum rehberli yapılır.
  - Belirteç Anahtar Zinciri'nde tutulur.
  - GitLab için sunucu adresi girilebilir (kendi sunucusunda barındırılan).
- **İşlemler:** Repo listeleme ve klonlama, branch, push, PR/MR açma. Başlık ve açıklama, repo'daki şablona göre doldurulur.
- **PR takibi (Claude'daki gibi):**
  - CI kırılırsa loglar çekilir, ajan düzeltir, iş kapılardan geçer ve push edilir.
  - Review yorumu gelirse ajan ya düzeltir ya da gerekçeli yanıt yazar.
  - Base branch ile çakışma olursa birleştirip çözer.
  - Döngü, CI yeşil ve PR birleştirilebilir olana kadar sürer.
- **Issue'lar:** Issue'dan görev oluşturulabilir. Görev ve issue birbirine bağlanır.
- **Güncellemeler:**
  - Uygulama dışarıdan erişilebilir olmadığı için güncellemeler sorgulamayla alınır.
  - GitHub'da ETag'li koşullu istekler kullanılır, maliyeti çok düşüktür.
  - Sorgu aralığı uyarlanır: etkin PR'da 30-60 saniye, boştayken 5 dakika.
- **CI:** GitHub Actions ve GitLab CI için durum, log ve yeniden çalıştırma. Deploy için `workflow_dispatch` ve pipeline tetikleme.

## 14. Deploy

- **Profil türleri:**
  - **CI:** GitHub Actions workflow'u veya GitLab pipeline'ı değişkenlerle tetiklenir, bitene kadar izlenir.
  - **SSH:** Bir veya birden fazla hostta betik çalıştırılır (sıralı veya kademeli). `remote.exec` politikaları geçerlidir.
  - **Komut:** Yerel bir komut çalıştırılır.
- **Akıştaki yeri:** Deploy bir akış düğümüdür. Önceki kapılar geçilmiş olmalıdır.
- **Production'da:**
  - kilitli onay
  - değişiklik özeti
  - sağlık kontrolü (URL veya komut)
  - tanımlıysa tek tıkla geri alma komutu
- **Geçmiş:** Ortam başına deploy geçmişi tutulur.

## 15. Uyarılar

### Kanallar

- **Tek yönlü:** macOS bildirimi, Microsoft Teams, Discord, e-posta (SMTP), telefona push (ntfy), genel webhook.
- **Çift yönlü (onay verilebilir):**
  - **Telegram:** satır içi butonlar, uzun sorgulama ile çalışır
  - **Slack:** Block Kit butonları, Socket Mode ile çalışır

  İkisi de bilgisayara dışarıdan erişim açmadan çalışır.
- **Production onayları:** Varsayılan olarak **yalnız uygulamadan** verilir. Ayarlardan kanala açılabilir. Açılırsa yalnız bağlanmış kullanıcı kimliği onay verebilir ve ikinci bir doğrulama istenir.

### Olaylar ve önem dereceleri

| Önem | Olaylar | Varsayılan yönlendirme |
|---|---|---|
| Kritik | Production komut veya deploy onayı bekliyor; production deploy başarısız; sınır ihlali; ajan çöktü veya takıldı (N dakika çıktı yok); limit doldu ve iş kuyruğa alındı | Tüm etkin kanallar + sesli macOS bildirimi. Sessiz saatleri deler |
| Yüksek | Onay bekleyen iş (plan, birleştirme, son onay, ajan sorusu); kapı tur sınırını aştı; PR takibi CI'ı düzeltemedi; production deploy başarılı | macOS + birincil mobil kanal |
| Normal | Görev tamamlandı; PR'a yeni review; limit %80; zamanlanmış görev başladı veya bitti; test ortamına deploy | macOS |
| Bilgi | Hafıza önerisi; ajan devretti; limit sıfırlandı | Yalnız uygulama içi |

### Uyarı kuralları

- Sessiz saatler tanımlanabilir.
- Aynı olay 5 dakika içinde tek bildirime iner. Birden fazla olay gruplanır (ör. "3 onay bekliyor").
- Kanal başına hız sınırı uygulanır.
- Uyarı metinleri maskeleme işleminden geçer.
- Her uyarı uygulamada ilgili yere açılan bir bağlantı taşır: `aistudio://approval/<id>`.

## 16. Stüdyolar

Stüdyo, sürümlü bir YAML şablonudur ve şunları tanımlar:
- ajan kadrosu
- akış
- prompt şablonları
- çıktı biçimi
- kapılar
- değişkenler

Değişkenler hafızadan ve kullanıcı girdisinden dolar. Uygulamada şablonlar için bir editör ve sürüm geçmişi var. Kullanıcı kendi stüdyosunu tanımlayabilir.

| Stüdyo | Kadro ve akış | Çıktı | Özel kapılar |
|---|---|---|---|
| Mimari tasarım | Kurul: Claude ve Codex bağımsız görüş → karşı tez → sentez | Karar kaydı (ADR) + diyagram + hafızaya karar önerisi | Son onay |
| Piyasa analizi | Araştırmacı (web erişimli) + eleştirmen | Kaynaklı rapor | Son onay |
| Tasarım | Tasarımcı → uygulayıcı → inceleyen | Tasarım notu + bileşen/prototip + ekran görüntüsü | Görsel kanıt, son onay |
| Veritabanı | Şema tasarımcısı → inceleyen (diğer model) → test ortamında migration denemesi | Şema, migration, geri alma, etki analizi | Test ortamı kanıtı. Production'a uygulama ayrı ve kilitli |
| Kod inceleme | İki model bağımsız inceler → bulgular birleşir, çelişkiler işaretlenir | Önem dereceli bulgu listesi, istenirse PR yorumu | — |
| Hata ayıklama | Teşhis (salt okuma log/DB) → hipotezler → hatayı yeniden üreten test → düzeltme → inceleme | Teşhis raporu + düzeltme | Hatayı yeniden üreten test kanıtı |
| Dokümantasyon | Yazar → doğrulayıcı (kodla tutarlılık kontrolü) | Doküman | Tutarlılık kontrolü |
| Teklif/kapsam | Kapsam analisti + tahminci + eleştirmen | İş kalemleri, süre, riskler | Son onay |

## 17. Limit ve kullanım

- **Kaynaklar:** Claude'da `rate_limit_event`, Codex'te `account/rateLimits/*`. İkisi de yoksa kendi tahminimiz devreye girer. Her değerin kaynağı ve ne kadar eski olduğu gösterilir.
- **Ajan başına:** token (giriş/çıkış/önbellek), süre, tur sayısı, bağlam doluluk oranı.
- **Görev bütçesi:** Abonelikte dolar anlamsız olduğu için bütçe limit yüzdesiyle tanımlanır: "5 saatlik pencerenin en fazla %X'i, haftalığın en fazla %Y'si". Süre ve tur tavanı da konabilir. Claude'un verdiği API karşılığı tutar yalnız bilgi olarak gösterilir.
- **Limit dolduğunda:** Akış başına politika seçilir:
  - eşdeğer rol için diğer sağlayıcıya geç
  - sıfırlanana kadar kuyrukta beklet (zamanlayıcı sıfırlanma zamanını bilir)
  - kullanıcıya sor
- **Çapraz inceleme ve limit:** Sağlayıcılardan biri doluysa çapraz inceleme beklemeye alınır. Aynı sağlayıcıyla inceleme yalnız kullanıcı açıkça onaylarsa yapılır.
- **Arayüz:**
  - Üst çubukta her sağlayıcı için iki ince çubuk (5 saat, haftalık). Renk %70'te ve %90'da değişir.
  - Tıklanınca döküm ve sıfırlanmaya geri sayım açılır.
  - Menü çubuğu ikonunda mini halkalar.

## 18. Destekleyici özellikler

| Özellik | Tasarım |
|---|---|
| Checkpoint ve geri alma | Her düğüm bitiminde checkpoint alınır: worktree'ler gizli referanslara (`refs/aistudio/checkpoints/*`), hafıza commit'i, koşu durumu. Geri almada worktree'ler sıfırlanır, koşu geri sarılır. Ajan bağlamı için Codex'te `thread/revert`/`fork`, Claude'da `rewind_files` ve `--fork-session` kullanılır |
| Oturum tekrar oynatma | Olay günlüğünden zaman çizelgesi. İleri-geri sarma, hız ayarı. Her an için diff ve çıktılar yeniden kurulur |
| Çakışma uyarısı | Canlı dosya örtüşmesi + birleştirme öncesi `merge-tree` kontrolü (bölüm 7) |
| Gizli bilgi maskeleme | Tüm çıktı, log, uyarı ve dışa aktarımlar maskeleyiciden geçer. Üç katman: Anahtar Zinciri'ndeki bilinen değerlerin birebir eşleşmesi, gitleaks tarzı desenler, entropi. Ham hali hiç saklanmaz |
| Görev kuyruğu ve zamanlama | Öncelikli kuyruk, sağlayıcı başına eşzamanlılık sınırı, cron ile zamanlama, "limit sıfırlanınca başlat" |
| MCP | Çalışma alanı ve ajan başına MCP sunucu yönetimi. Claude'a `--mcp-config`, Codex'e yapılandırma ile verilir |
| Kalite puanı | Koşu başına şeffaf bir formülle hesaplanır: kapıların ilk denemede geçmesi, inceleme bulgularının ağırlığı, testler, tekrar turları, kullanıcı puanı |
| Ajan performans geçmişi | Profil ve model başına başarı oranı, süre, limit tüketimi, kalite eğilimi. Öneriler de üretir (ör. "hata ayıklamada X daha başarılı") |
| Çalışan ajana müdahale | Çalışan tura mesaj gönderme (steer), duraklatma ve kesme, sonraki istemi düzenleme, işi devralma (worktree'yi editörde veya terminalde açma) |
| Dışa aktarım | Koşu ve oturumlar Markdown, HTML veya JSON olarak; stüdyo çıktıları Markdown veya PDF olarak; denetim kaydı CSV veya JSON olarak |
| Komut paleti | Uygulama içinde ⌘K. Genel kısayol ⌃⌥Space (değiştirilebilir) ile uygulama arka plandayken de yüzen bir panel açılır: yeni görev, onay ver, ajana git, çalışma alanı değiştir |
| Yedekleme | Zamanlanmış yedek: `studio.db` (SQLite yedekleme API'si) ve hafıza repoları seçilen klasöre (iCloud Drive / harici disk). Uygulama içinden geri yükleme |

## 19. Arayüz

### Kabuk

- **Sol kenar çubuğu:** Dar ve daraltılabilir, macOS titreşim (vibrancy) efektiyle yarı saydam. İçinde çalışma alanları ve şu sayfalar: Görevler, Akışlar, Stüdyolar, Hafıza, Bağlantılar, Oturumlar, Geçmiş, Ayarlar.
- **Üst çubuk:** Çalışma alanı, ortam etiketi, limit çubukları, onay sayacı, ajan durum noktaları.
- **Orta alan:** Görev ve akış.
- **Sağ çekmece:** Canlı çıktı, diff, hafıza önerileri. İhtiyaç olunca açılır, kapanınca iz bırakmaz.

### Bilginin dört seviyesi (plandaki gibi)

1. **Her zaman görünen:** durum noktaları, limit çubukları, ortam etiketi, onay sayacı.
2. **Yerinde açılan kart:** ajan detayı, limit dökümü, kapı durumu.
3. **Yan çekmece:** canlı çıktı, diff, hafıza önerileri.
4. **Tam sayfa:** akış tuvali, danışma oturumu, stüdyo çıktıları, tekrar oynatma.

### Ekranlar

- **Ana ekran:** Ortada büyük bir görev giriş alanı. Yanında şu seçiciler var:
  - mod (Tek / İkili / Yarış / Hat / Kurul)
  - stüdyo
  - repo / branch

  Altında etkin görevler, mini akış şeritleri olarak görünür. Devretmeler bu şeritlerde animasyonla akar.
- **Görev detayı:** Yatay akış ilerlemesi, ajan kartları, kapılar ve kanıtlar.
- **Akış tuvali:** Düğüm sürükle-bırak, bağlantılar, şablondan başlama, canlı koşu görünümü.
- **Danışma oturumu:** Her danışman bir sütunda, karşı tez ve sentez en sağda.
- **Oturumlar:** Mevcut oturum keşfi (yerel ve hostlar), harici oturum izleme.
- **Bağlantılar:** Hostlar, veritabanları, deploy profilleri, git hesapları, uzak komut kaydı, uzak terminal.
- **Onay kutusu:** Üst çubuktaki sayaçtan açılır. Tam liste sayfası da var.

### Menü çubuğu ve bildirimler

- **Menü çubuğu:** İkon durumu gösterir. Tıklanınca açılan pencerede limitler, etkin ajanlar ve bekleyen onaylar (yerinde onaylanabilir) görünür, hızlı yeni görev açılabilir.
- **Bildirimler:** Butonlu macOS bildirimleri (Onayla / Reddet / Aç). Tauri'nin buton desteği M0'da doğrulanacak. Yetersiz kalırsa onaylar menü çubuğundan ve uygulama içinden yapılır.

## 20. Tasarım dili ve hareket

### Görsel dil

- **Kabuk:** Claude'dan esinlenen sıcak zemin: açık temada kırık beyaz, koyu temada sıcak antrasit. Ölçülü bir mercan/kiremit vurgu rengi. Renkler yaklaşık değerlerdir, resmi varlık kullanılmaz.
- **Tipografi:** Font paketlenmez, Apple'ın sistem fontları kullanılır. Hem Claude'un serif havası hem Apple doğallığı elde edilir.
  - **Başlıklar:** `ui-serif` → New York (Apple'ın sistem serif'i)
  - **Metin:** SF Pro
  - **Kod:** SF Mono
- **Sağlayıcı dili:**
  - **Claude ajanları:** sıcak tonlar, mercan vurgu, serif başlıklar
  - **Codex ajanları:** tek renkli (siyah/beyaz/gri), keskin ve kod ağırlıklı
  - Logolar değiştirilebilir varlık olarak tutulur (iç kullanım).
- **Ölçüler:**
  - 4 px temelli boşluk ölçeği, 8 px ızgara
  - tutarlı köşe yarıçapı ölçeği
  - derinlik için ince gölge ve kenarlık
- **Bileşenler:** Tüm bileşenler tek bir iç kütüphanede (`ui/`) toplanır. Geliştirici modunda hareketleri ve durumları tek sayfada gösteren bir bileşen galerisi bulunur.

### Hareket ilkeleri

**Değişen her şey hareket eder, her hareket bir şey anlatır.**

- **Geçişler:** Hiçbir şey birden belirmez. Öğeler yay fiziğiyle girer ve çıkar.
  - Bir karta tıklanınca kart detay sayfasına genişler (paylaşılan öğe geçişi).
  - Çekmece yayla kayar, açılır kartlar tıklanan noktadan büyür.
- **Akış:**
  - Devretmede bağlantı çizgisi üzerinde ajandan ajana bir iz akar.
  - Etkin düğüm hafifçe nefes alır.
  - Kapı geçilince onay işareti çizilir, ardından yumuşak bir yeşil süpürme gelir.
  - Kapı başarısız olursa öğe kısa ve ölçülü bir şekilde sallanır.
- **Durum noktaları biçim değiştirir:**
  - boşta → çalışırken nabız atar
  - başarıda onay işaretine dönüşür
  - hatada işaret verir
- **Canlı metin:** Kare hızında gruplanır, kayarak ve solarak belirir. Titreme olmaz.
- **Sayılar ve çubuklar:** Sayılar kayarak değişir. Limit çubukları yayla dolar. Onay kartı kutuya uçar, sayaç zıplar.
- **Apple hissi:**
  - Yaylar kesintiye uğratılabilir.
  - Kaydırmada lastik etkisi var.
  - Malzemeler yarı saydam, titreşim efektli.
- **Süreler:**
  - mikro etkileşim 120–180 ms
  - standart geçiş 220–320 ms
  - sayfa geçişi 350–450 ms (yay)
- **Performans:**
  - Yalnız `transform` ve `opacity` canlandırılır (GPU).
  - ProMotion ekranda 120 fps hedeflenir.
  - Uzun listeler sanallaştırılır.
  - Akış güncellemeleri kare başına toplanır.
  - Aynı anda çalışan ağır animasyonlara üst sınır konur.
- **Erişilebilirlik:** macOS "Hareketi azalt" açıksa hareketler yumuşak solmaya iner.
- **Tutarlılık:** Yay ve süre değerleri koddaki tek bir hareket belirteci dosyasından gelir.

## 21. İnşa sırası

Her adımın bitiş ölçütü vardır. Benim ortamımda sahte CLI'larla, senin Mac'inde gerçek CLI'larla test edilir. Senin tarafındaki iş, tek komutla çalışan doğrulama betikleriyle sınırlı tutulur. Betikler bir rapor dosyası üretir.

| Adım | İçerik | Bitiş ölçütü |
|---|---|---|
| **M0 Doğrulama** | `scripts/verify/`: Claude stream-json ve kontrol protokolü (izin, kesme, devam, `mcp_message`, `rate_limit_event`); Codex app-server (thread, turn, steer, interrupt, onaylar, dinamik araçlar, limitler, thread/list); oturum dosyası biçimleri; Tauri bildirim butonları. Maskelenmiş gerçek akış kayıtları | Rapor yeşil, kayıtlar repoda, sahte CLI'lar kayıtlarla çalışıyor |
| **M1 İskelet** | Monorepo; Tauri kabuk, menü çubuğu, kısayol, bildirim; launchd ile studiod, belirteç; SQLite, göçler, olay günlüğü, WebSocket; tasarım ve hareket belirteçleri, temel bileşenler, açık/koyu tema; maskeleyici | Uygulama açılıyor, studiod arka planda yaşıyor, olaylar canlı akıyor |
| **M2 Ajanlar** | İki adaptör (yerel); profiller; oturumlar; canlı çıktı çekmecesi; müdahale; limit çubukları; worktree'ler; Studio araçları; yerel oturum keşfi; Tek ve İkili mod uçtan uca (build/test + çapraz inceleme) | Gerçek bir işi İkili modda baştan sona kanıtlı bitirmek |
| **M3 Akış motoru ve tuval** | Bütün düğüm türleri; Yarış, Hat, Kurul şablonları; tuval; çakışma uyarısı; birleştirme; checkpoint; kuyruk | Beş mod da tuvalden kurulup koşuyor |
| **M4 Hafıza ve danışma** | Hafıza reposu, öneriler, ajanlara aktarım; danışma sayfası; karar belgesi | Kurul sonucu karar hafızaya onayla işleniyor |
| **M5 Git barındırma** | GitHub ve GitLab hesapları; PR/MR; sorgulama; PR takibi ve otomatik düzeltme döngüsü; issue'dan görev | Kırık CI'lı bir PR otomatik olarak yeşile dönüyor |
| **M6 Uzak** | SSH ve DB profilleri; ortam etiketleri; yetki seviyeleri; sınıflandırma; kayıt; uzak terminal; uzak ajanlar ve uzak oturum keşfi | Production'da yazma komutu onaysız çalışamıyor; uzak oturum eklenip sürdürülüyor |
| **M7 Deploy ve uyarılar** | Deploy profilleri; uyarı kanalları; Telegram/Slack'ten onay; kurallar | Test ortamına deploy uçtan uca, onay telefondan verilebiliyor |
| **M8 Stüdyolar** | Şablon motoru, sekiz stüdyo, editör, sürümleme | Sekiz stüdyo da çıktı üretiyor |
| **M9 Tamamlayıcılar** | Tekrar oynatma, kalite puanı, performans geçmişi, dışa aktarım, yedekleme, zamanlama, MCP yönetimi, komut paleti | Bölüm 18'deki her madde çalışıyor |
| **M10 Cilalama** | Uygulamanın tamamında hareket geçişleri; performans ölçümü (120 fps, bellek); erişilebilirlik; `.app` paketleme ve imzalama | Günlük işte kullanılabilir sürüm |

## 22. Repo yapısı

```
ai_stuido/
├── apps/desktop/           # Tauri 2 uygulaması
│   ├── src/                # React arayüz (ui/, features/, motion/, i18n/)
│   └── src-tauri/          # Rust kabuk (menü çubuğu, kısayol, bildirim, launchd kaydı)
├── backend/                # studiod (Python, uv)
│   ├── src/aistudio/
│   │   ├── api/  engine/  gates/  memory/  limits/  scheduler/
│   │   ├── adapters/claude/  adapters/codex/  transports/  tools/
│   │   ├── remote/  git_hosting/  deploy/  alerts/  studios/
│   │   └── security/  storage/
│   └── tests/
├── packages/protocol/      # Ortak JSON şemaları → TS ve Pydantic tipleri
├── studios/                # Yerleşik stüdyo şablonları (YAML)
├── scripts/verify/         # Mac'te gerçek CLI doğrulama betikleri
├── fixtures/               # Kaydedilmiş, maskelenmiş CLI akışları
└── docs/                   # plan.md, sartname.md
```

## 23. Güvenlik özeti

- studiod yalnız `127.0.0.1` üzerinde dinler. Bağlantı belirteç ve `Origin` kontrolüyle doğrulanır.
- Gizli bilgiler yalnız Anahtar Zinciri'nde tutulur. Veritabanına, loglara ve ajan ortamına hiç girmez.
- Ajanlar temizlenmiş bir ortamla başlar. SSH anahtarlarına ve bulut kimlik bilgilerine erişemez.
- Production için:
  - kırmızı çerçeve
  - varsayılan salt okuma
  - komut başına onay
  - "her zaman izin ver" yok
  - onaylar varsayılan olarak yalnız uygulamadan
- Maskeleme her yerde uygulanır. Olay günlüğü zincirlenir, sonradan değiştirilirse fark edilir.

## 24. Riskler ve açık doğrulamalar

| Risk | Önlem |
|---|---|
| CLI protokolleri değişir (Codex app-server "deneysel") | Sürüme sabitlenmiş şemadan üretilen tipler, kayıtlı akış testleri, uyumluluk testi düğmesi, `codex exec --json` yedek yolu |
| Claude limitlerinin boştayken okunması | Son bilinen değer ve ne kadar eski olduğu gösterilir. M0'da limit harcamayan bir yöntem araştırılacak |
| Uzak ajanlar sunucuda CLI kurulumu ve girişi gerektirir | Uygulama kontrol eder ve kurulumu yönlendirir. Sunucuya giriş bilgisi koyma kararı kullanıcıda |
| Paralel ajanlarda birleştirme | `merge-tree` ile erken tespit, ajan destekli çözüm, çözümün tekrar kapılardan geçmesi |
| Tauri bildirim butonları | M0'da doğrulanacak. Yedek: menü çubuğu ve uygulama içi onay |
| Abonelik limitleri yoğun paralel kullanımda hızla dolar | Bütçeler, kuyruk ve sağlayıcı yönlendirme |
| "AI Studio" adı Google AI Studio'ya benziyor | Yalnız iç kullanımda sorun değil |
| Sağlayıcı logoları | Yalnız iç kullanım. Değiştirilebilir varlık olarak tutulur |
