# Ajan Orkestrasyon Stüdyosu: Genel Plan

> Kullanıcının ilk planı, olduğu gibi. Kararlar ve teknik ayrıntılar için bkz. [sartname.md](sartname.md).

## 1. Amaç

Tek kullanıcılı, yerelde çalışan bir masaüstü/web uygulaması. Claude ve Codex ajanlarını birlikte çalıştırır, akışlarını kullanıcı tasarlar, tüm ajanlar ortak hafızadan beslenir ve işler kontrol kapılarından geçmeden tamamlanmış sayılmaz. Hedef: AI ile geliştirmede hız, izlenebilirlik ve kalite.

## 2. İlkeler

- Sadelik: varsayılan ekran sakin, detay istenince açılır.
- Plan, uygulama, test, veri onayı ve deploy ayrı durumlardır, birbirinin yerine geçmez.
- Local ile production hiçbir yerde karışmaz.
- Kanıtsız iş tamamlanmış sayılmaz.
- Ajan sınırları (dokunulmayacak dosyalar, yalnız sandbox vb.) birinci sınıf kavramdır.

## 3. Mimari

- Motor: FastAPI, SQLite, yerel çalışma, arayüze canlı olay akışı.
- Ajan adaptörleri: Claude Code ve Codex CLI için ayrı adaptör. Sağlayıcı eklemek adaptör yazmaktan ibaret.
- İzolasyon: Her ajan ayrı git worktree'de çalışır, birleştirme kontrollü ayrı adımdır.
- Arayüz: React.

## 4. Çekirdek kavramlar

- Ajan: Sağlayıcı, model, rol, izinler.
- Akış: Ajanların sıralı, paralel veya koşullu bağlandığı düzen. Kullanıcı tuvalde kurar.
- Danışman: Kod yazmayan, görüş veren ajan.
- Kapı: Geçilmeden ilerlenemeyen kontrol noktası.
- Ortak hafıza: Tüm ajanların okuduğu proje bilgisi.
- Çalışma alanı: Proje başına ayrı hafıza, host, akış ve ayarlar.

## 5. Çalışma modları

- Tek ajan.
- İkili: biri yazar, diğer model inceler.
- Yarış: aynı iş paralel yapılır, sonuçlar karşılaştırılır.
- Hat: planlayıcı → geliştirici → inceleyen → test eden.
- Kurul / danışma: kod yok, bağımsız görüşler, karşı tez, tek karar belgesi.

## 6. Ortak hafıza

- Katmanlar: proje gerçekleri, kararlar, sınırlar, oturum özetleri.
- Markdown dosyaları, git ile sürümlü, elle düzenlenebilir.
- Ajanlar yazma önerir, kullanıcı onaylar.

## 7. Kontrol kapıları

Plan onayı, sınır denetimi, build/test kanıtı, çapraz model incelemesi, kullanıcı son onayı. Akış başına açılıp kapatılabilir.

## 8. Uzak bağlantılar

- SSH host ve veritabanı profilleri, kimlik bilgisi anahtar zincirinde.
- Ortam etiketi: local, test, production.
- Yetki seviyeleri: salt okuma, sınırlı yazma, tam yetki. Production'da varsayılan salt okuma, yazma komutları tek tek onaylı.
- Tüm uzak komutlar kayıt altında.

## 9. Limit ve kullanım

- Sağlayıcı başına oturum ve haftalık limit, sıfırlanma zamanı.
- Ajan başına token, süre, bağlam doluluk oranı.
- Görev başına maliyet ve bütçe tavanı.
- Limit dolunca diğer sağlayıcıya yönlendirme veya kuyruk.

## 10. Stüdyolar (hazır paketler)

Her biri kendi prompt şablonu, ajan kadrosu, çıktı biçimi ve kapılarıyla gelir: mimari tasarım, piyasa analizi, tasarım, veritabanı, kod inceleme, hata ayıklama, dokümantasyon, teklif/kapsam. Şablonlar düzenlenebilir, sürümlenir, değişkenleri hafızadan dolar. Kullanıcı kendi stüdyosunu tanımlayabilir.

## 11. Destekleyici özellikler

Checkpoint ve geri alma, oturum tekrar oynatma, çakışma uyarısı, gizli bilgi maskeleme, görev kuyruğu ve zamanlama, MCP ile ek araçlar, kalite puanı, ajan performans geçmişi, çalışan ajana müdahale, dışa aktarım, komut paleti, yedekleme.

## 12. Arayüz yaklaşımı

Her özellik ayrı panel değildir. Bilgi, önemine göre dört seviyede gösterilir:

- Her zaman görünen, minimal: Ajan durumu (küçük nokta ve tek satır), limitler (ince bir çubuk veya rozet), ortam etiketi, onay bekleyen iş sayısı.
- Yerinde açılan: Bir öğeye tıklanınca küçük açılır kart: ajan detayı, limit dökümü, kapı durumu.
- Yan çekmece: Canlı çıktı, diff, hafıza önerileri. İhtiyaç olunca açılır, kapanınca iz bırakmaz.
- Tam sayfa: Sadece gerçekten alan isteyenler: akış tuvali, danışma oturumu, stüdyo çıktıları, oturum tekrar oynatma.

Ana ekran: ortada görev ve akış, geri kalan her şey kenarda sessiz. Komut paleti her yerden erişilir.

## 13. Tasarım dili

- Genel kabuk Claude dilinde: açık sıcak zemin, ölçülü vurgu rengi, serif başlıklar, geniş boşluklar, yumuşak ve kısa geçişler.
- Her ajan kendi sağlayıcısının dilini taşır: Codex ajanının kartı, çıktı alanı ve logosu Codex stilinde, Claude ajanınınki Claude stilinde.
- Hareket: durum değişimleri, devretme ve akış ilerlemesi ince animasyonlarla. Süs amaçlı hareket yok.
- Tipografi, hizalama, boşluk ve bileşen tutarlılığı öncelikli kalite ölçütü.

## 14. Fazlar

| Faz | Süre | Çıktı |
|---|---|---|
| 0 | Yarım gün | İki adaptörün kanıtı, limit bilgisinin okunabilirliği |
| 1 | Haftasonu | Arayüz kabuğu, ajan kartları, canlı çıktı, ikili mod |
| 2 | 1-2 hafta | Akış tuvali, paralel çalışma, limit göstergeleri |
| 3 | 1 hafta | Ortak hafıza, danışma modu |
| 4 | 1-2 hafta | SSH ve veritabanı profilleri, yetki seviyeleri |
| 5 | 1 hafta | Kapılar, checkpoint, ilk üç stüdyo |
| 6 | Sonrası | Kalan stüdyolar, zamanlama, performans geçmişi |

## 15. Riskler ve açık sorular

- CLI çıktı biçimleri ve bayrakları sık değişir, güncel sürümlerle doğrulanmalı.
- Limit bilgisinin ne kadarı araçlardan okunabiliyor, ne kadarı kendi sayacımızla hesaplanacak.
- Paralel ajanlarda birleştirme ve çakışma yönetimi en zor kısım.
- Uzak sunucuda yetki modeli oturmadan SSH açılmamalı.
- Dağıtım düşünülürse sağlayıcı logolarının kullanım koşulları.
