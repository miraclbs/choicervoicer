# Seslendirme Stüdyosu

Kendi videolarını yükleyip üstüne kendi sesinle dublaj yaptığın basit bir program.

## Başlatma

**`Baslat.bat`** dosyasına çift tıkla. Tarayıcıda `http://127.0.0.1:8765` kendiliğinden açılır.
Siyah pencere açık kaldığı sürece program çalışır; işin bitince pencereyi kapat.

Gerekenler: Python 3 ve ffmpeg (ikisi de bu bilgisayarda kurulu).
Mikrofon için Chrome ya da Edge kullan.

## Her şey otomatik kaydedilir

Kırpma, konuşmacılar ve kayıtlar her değişiklikte kaydedilir (sağ üstte "✓ Tüm değişiklikler
kaydedildi" yazar). Programı tekrar açtığında ana sayfada videonun kartında:

- **🎙️ Seslendir**: doğrudan kayda devam
- **✏️ Düzenle**: konuşmacıları/bölümleri (ya da "1 · Kırp" sekmesinden kırpmayı) değiştir

## Kullanım

1. **Video yükle**: ana sayfadaki alana videoyu sürükle (MP4, MOV, MKV…).
2. **Kırp**: videonun kullanmak istediğin kısmını seç.
   - Zaman çizelgesindeki mavi kenarları sürükle, ya da videoyu istediğin ana getirip
     **Şu an** butonlarına bas (`I` = başlangıç, `O` = bitiş). `←` `→` ile 0,1 sn hassas ayar.
   - Kırpmak istemiyorsan **Kırpmadan devam et**.
   - Orijinal video saklanır; sonradan "1 · Kırp" sekmesine dönüp kırpmayı değiştirebilirsin
     (bölümler ve kayıtlar yeni zamana kaydırılır).
   - Kırpmadan sonra program sesi yapay zekâyla ikiye ayırır: **konuşmalar** ve **arka plan**
     (müzik, efekt, ortam sesi). 1 dakikalık kısım yaklaşık 20–30 saniye sürer.
3. **Konuşmacıları ayır** (her video için bir kez):
   - Program konuşmaları kendisi bulur ve kişilere ayırır.
   - Hemen ardından **"Bu kim konuşuyor?"** diye her bölümü dinletip sorar.
     `1` / `2` tuşuna basman ya da butona tıklaman yeterli.
   - Yanlış bölünen yeri düzeltebilirsin: zaman çizelgesinde kenarları sürükle,
     boş yerde sürükleyerek yeni bölüm ekle, `S` ile oynatma çizgisinden ikiye böl.
   - "Tamam, seslendirmeye geç" deyince bölme kaydedilir; bir daha sorulmaz.
4. **Seslendir**:
   - "Ben kimi seslendiriyorum?" kısmından kişiyi seç (iki kişi oynuyorsanız
     herkes kendi karakterini seçer).
   - Ekran parça parça çalışır: ortada sadece üzerinde çalıştığın replik vardır
     (üstte "Replik 3 / 12 · Kişi 1", altında **Orijinali dinle · Kaydet · Benimkini dinle**).
     Sağ panelde tüm replikler, arka plan ve dışa aktarma durur. `←` `→` ya da oklarla replik değiştir.
   - **`R`** ile kaydet: geri sayım biter, ekranda kırmızı "KONUŞ" yazınca konuş.
     `Boşluk` sadece o repliği oynatır. Zaman çizelgesinde üst şerit **orijinal konuşma**,
     alt şerit **senin kaydın**.
   - Kayıttan sonra sesin otomatik olarak orijinal konuşmanın üstüne oturtulur
     (geç ya da erken başladıysan düzelir).
   - Oturmadıysa: alt şeritte kaydını **fareyle sürükle**, ya da `,` `.` ile 20 ms
     (Shift ile 100 ms) kaydır. `A` = tekrar otomatik oturt, **↺** = kaydettiğin yere döndür.
   - Kayıt bitince otomatik dinletilir. Beğenmezsen tekrar `R`, beğenirsen **`N`** (sonraki).
5. **Dublajlı izle** ile kendi sesinle, **Orijinalini izle** ile videonun kendi sesiyle izle.
   İzlerken videonun altındaki **Orijinal ses / Benim sesim** düğmesiyle (ya da `T` tuşuyla)
   anında karşılaştırabilirsin.
6. **MP4 olarak kaydet** ile dublajlı videoyu indir.

## Arka plan sesleri

Seslendir ekranındaki **🎵 Arka plan** kutusundan seçilir:

- **Müzik ve efektler** (önerilen): orijinal konuşmalar silinir; müzik, efekt ve ortam sesi
  baştan sona devam eder, senin sesin üstüne biner. Seviyesini kaydırıcıyla ayarlayabilirsin.
- **Yok**: sadece senin sesin.
- **Orijinal ses, konuşma anlarında kapalı** / **Orijinal ses kısık**: ayırma olmadan eski yöntemler.

Ayırma kusursuz değildir: müziğin çok yüksek olduğu yerlerde arkada hafif konuşma izi kalabilir.

Ses ayırma için `demucs` paketi gerekir (bu bilgisayarda kurulu). Başka bir bilgisayarda:
`python -m pip install demucs`

## Ayarlar (Seslendir → ⚙ Ayarlar)

- **Gecikme düzeltmesi**: sesin dudaklardan geç geliyorsa kaydırıcıyı sağa çek.
- Kulaklık takıyorsan kayıt sırasında orijinal sesi ya da arka planı ve diğer kayıtları duyabilirsin.

## Dosyalar nerede?

Her video `projeler/` klasöründe ayrı bir klasördür:
`kaynak.mp4` (yüklediğin video), `video_….mp4` (kırpılmış hali), `arkaplan.wav`
(konuşmaları silinmiş ses), `takes/` (senin kayıtların), `exports/` (oluşturulan dublajlı videolar).
