# Algoritma dan Sistem di Proyek Ini

Dokumen ini menjelaskan **algoritma apa yang dipakai, sistem apa yang dibangun, dan prinsip software engineering apa yang melandasinya**. Tujuannya pembelajaran: setiap bagian menunjuk ke file nyata, jadi kamu bisa membuka kodenya sambil membaca.

Dokumen ini melengkapi [ARCHITECTURE.md](../ARCHITECTURE.md). ARCHITECTURE.md menjawab "apa saja yang ada dan di mana". Dokumen ini menjawab "kenapa dibuat begini dan apa konsep di baliknya".

Isi:

1. [Gambaran sistem](#1-gambaran-sistem)
2. [Algoritma](#2-algoritma)
3. [Prinsip software engineering yang diterapkan](#3-prinsip-software-engineering-yang-diterapkan)
4. [Trade-off dan keterbatasan yang jujur](#4-trade-off-dan-keterbatasan-yang-jujur)
5. [Cara belajar dari kode ini](#5-cara-belajar-dari-kode-ini)
6. [Glosarium](#6-glosarium)

---

## 1. Gambaran sistem

### Jenis sistem

Bot ini adalah **proses tunggal yang berjalan terus-menerus (long-running service)** dengan tiga pintu masuk:

| Pintu masuk         | Pemicu                                  | Kode                               |
| ------------------- | --------------------------------------- | ---------------------------------- |
| Polling             | Timer internal, tiap ~20 detik          | `src/monitor.js`                   |
| Interaksi Discord   | Pesan chat, tombol, slash command, DM   | `src/chat/`                        |
| HTTP API (bertanda) | Skrip lokal milik pemilik (backup dll.) | `src/server.js`, `src/security.js` |

Polling dipakai karena IDN tidak menyediakan push (webhook atau websocket) untuk "member mulai live". Satu-satunya cara tahu adalah bertanya berulang-ulang.

### Aliran data utama

```
        IDN GraphQL API
              │  (polling tiap ~20 detik, bisa beberapa halaman)
              ▼
     fetchAllLivestreams()            src/idnApi.js        ← I/O
              │
              ▼
     checkLiveMembers()               src/monitor.js       ← orkestrasi
        │  bandingkan "yang live sekarang" dengan "yang kita ingat live"
        │
        ├─ baru muncul   → notif "mulai" → simpan ke activeLives
        ├─ masih ada     → perbarui jumlah penonton, cek milestone
        └─ hilang 2 kali → notif "selesai" → catat riwayat sesi
              │
              ▼
     fitur sampingan (rekap, streak, tebak-tebakan, status bot, ...)
     dibungkus safely() supaya gagalnya tidak merusak inti
              │
              ▼
     Discord (webhook / DM / channel)  src/notify/          ← I/O
     File JSON di CACHE_DIR            src/storage/         ← I/O
```

### Lapisan dan arah dependensi

```
  chat/   ──┐
  notify/ ──┼──►  storage/  ──►  jsonStore.js
  monitor ──┘      utils.js, streakMath.js, schedulePattern.js  (logika murni)
```

Aturan yang dijaga: `chat/` dan `notify/` **tidak saling mengimpor**. Kalau keduanya butuh fungsi yang sama, fungsi itu dipindah ke modul baru yang netral. Contohnya `schedulePattern.js`, `streakMath.js`, dan `chat/interactionHelpers.js`. Alasannya dijelaskan di bagian 3.1.

---

## 2. Algoritma

Format tiap algoritma: **di mana, masalah yang dipecahkan, cara kerja, kompleksitas, kenapa dipilih**.

### 2.1 Polling self-scheduling dengan kompensasi durasi

- **Di mana:** `computeNextPollDelay` dan `pollLoop` di [src/monitor.js](../src/monitor.js).
- **Masalah:** `setInterval` bisa menumpuk panggilan kalau satu siklus lebih lama dari intervalnya (misalnya kena rate limit Discord). Menunggu interval penuh _setelah_ siklus selesai membuat jadwal bergeser makin jauh tiap siklus lambat.
- **Cara kerja:** `setTimeout` baru dipasang **setelah** siklus selesai. Jedanya `max(1 detik, interval - lamaSiklus)`, sehingga ritme tetap ~interval dari awal ke awal siklus.

```js
function computeNextPollDelay(elapsedMs) {
  return Math.max(MIN_POLL_DELAY_MS, POLL_INTERVAL_MS - elapsedMs);
}
```

- **Kompleksitas:** O(1) untuk perhitungan jeda.
- **Kenapa:**
  - Tidak ada dua siklus yang tumpang tindih, jadi tidak ada _race condition_ pada `activeLives`.
  - Jeda minimum 1 detik mencegah _busy loop_ yang menghantam API saat sedang bermasalah.
  - Fungsinya murni, jadi bisa dites tanpa timer sungguhan.

### 2.2 Deteksi perubahan state dengan debounce (histeresis)

- **Di mana:** `checkLiveMembers` di [src/monitor.js](../src/monitor.js), konstanta `ENDED_GRACE_POLLS = 2`.
- **Masalah:** bot hanya melihat potret ("siapa live sekarang"), bukan kejadian. Notif harus dikirim saat **transisi**, bukan tiap potret. Selain itu respons IDN kadang kehilangan satu entri sesaat (glitch).
- **Cara kerja:** ada dua kumpulan, `currentLiveUsernames` (dari respons terbaru) dan `activeLives` (ingatan bot). Tiap siklus:
  1. Ada di respons, belum ada di ingatan: transisi **mulai**, kirim notif, simpan.
  2. Ada di keduanya: perbarui data, reset `missingStreak`.
  3. Ada di ingatan, tidak ada di respons: naikkan `missingStreak`. Baru setelah **2 siklus berturut-turut** absen, dianggap **selesai**.
  4. Slug berubah untuk username yang sama: sesi lama ditutup, sesi baru dibuka.
- **Kompleksitas:** O(L) per siklus, dengan L jumlah live (operasi `Set` dan `Map` rata-rata O(1)).
- **Kenapa:** debounce menukar keterlambatan notif "selesai" (maksimal satu siklus) dengan hilangnya notif palsu "selesai lalu mulai lagi". Idenya sama dengan _debouncing_ tombol fisik atau histeresis pada termostat.
- **Aturan pendukung:** satu username hanya diproses sekali per respons (`currentLiveUsernames.has(...)`). Tanpa itu, dua entri dengan slug berbeda membuat sesi buka-tutup bolak-balik.

### 2.3 Pengiriman at-least-once dengan "commit setelah sukses"

- **Di mana:** `sendDiscordNotif` dan penyimpanan `activeLives` di `checkLiveMembers`.
- **Masalah:** kalau notif gagal terkirim, member tidak boleh dianggap sudah diumumkan.
- **Cara kerja:** state (`activeLives.set(...)`) baru ditulis **setelah** pengiriman sukses. Kalau gagal, state tidak berubah, sehingga siklus berikutnya mencoba lagi dengan sendirinya. Tidak perlu antrean retry terpisah, karena _state itu sendiri adalah antreannya_.
- **Konsekuensi:** semantiknya at-least-once. Kalau Discord menerima pesan tetapi respons hilang di jalan, notif bisa terkirim dua kali. Ini sengaja dipilih karena notif ganda kecil biayanya, notif hilang besar biayanya.

### 2.4 Retry dengan batas dan backoff dari server

- **Di mana:** `sendWebhookRequest` di [src/notify/webhook.js](../src/notify/webhook.js).
- **Masalah:** Discord membalas HTTP 429 saat terkena rate limit. Mengabaikannya kehilangan notif. Mengulang tanpa henti menyandera siklus polling.
- **Cara kerja:**
  - Hanya status **429** yang di-retry. Error lain (payload salah, 5xx, jaringan putus) langsung dianggap gagal, karena mengulang payload yang sama hasilnya sama.
  - Lama tunggu diambil dari `retry_after` di body respons Discord, dibatasi maksimal 5 detik.
  - Maksimal 3 percobaan tambahan.
  - Tiap request punya timeout 10 detik (`AbortSignal.timeout`).
- **Kenapa:** menghormati sinyal server (jangan menebak waktu tunggu), tetapi tetap membatasi kerugian terburuk. Setiap loop yang menunggu pihak luar harus punya batas atas, karena polling ikut menunggu.

### 2.5 Menghitung streak dengan menelusuri mundur

- **Di mana:** `computeCurrentStreak` di [src/streakMath.js](../src/streakMath.js).
- **Masalah:** berapa hari berturut-turut (WIB) seorang member punya live?
- **Cara kerja:** tanggal sesi disimpan sebagai `Set` string `YYYY-MM-DD`. Mulai dari hari ini (atau kemarin kalau hari ini belum ada), mundur satu hari demi satu hari selama tanggalnya ada di `Set`. Jumlah langkah adalah panjang streak.
- **Kompleksitas:** O(S) dengan S panjang streak. Cek `Set.has` O(1).
- **Detail yang penting:**
  - Streak tidak putus sampai **sehari penuh** lewat tanpa aktivitas, seperti Duolingo. Kalau kemarin ada live dan hari ini belum, streak tetap hidup.
  - Pergeseran tanggal lewat `shiftDateWIB` dengan zona waktu eksplisit `+07:00`. Method `Date` yang bergantung zona waktu server sengaja dihindari, karena server Railway berjalan di UTC.
  - Logikanya murni (tanpa I/O), jadi mudah dites, dan dipakai dua tempat (perintah chat dan alert milestone).

### 2.6 Pola jadwal: modus (nilai paling sering) dengan ambang keyakinan

- **Di mana:** `computeSchedulePattern`, `isHourInRange`, `HEADS_UP_*` di [src/schedulePattern.js](../src/schedulePattern.js).
- **Masalah:** IDN tidak menyediakan jadwal resmi. Bot hanya punya riwayat live-nya sendiri (maksimal 10 sesi terakhir per orang).
- **Cara kerja:**
  1. Waktu mulai diperkirakan mundur: `mulai = selesai - durasi`.
  2. Hitung **histogram frekuensi** per bucket waktu (pagi/siang/malam) dan per hari dalam seminggu.
  3. Ambil **modus** (bucket dan hari yang paling sering).
  4. Alert proaktif hanya dikirim kalau data cukup (minimal 5 sesi) **dan** bucket dominan mencakup minimal 50% riwayat, **dan** member pernah live di hari yang sama dalam seminggu.
- **Dua detail yang sering salah di tempat lain:**
  - **Rentang yang melewati tengah malam.** Jam malam 22, 23, 0, 1 kalau diambil min/max mentah menjadi "0–23". Solusinya jam dini hari digeser +24 sebelum min/max, lalu di-`mod 24` lagi saat ditampilkan. `isHourInRange` menangani kasus `min > max` dengan logika "di luar [max, min]".
  - **Jangan menebak tanpa dasar.** Tanpa ambang keyakinan, ada tebakan yang pasti meleset 6 dari 7 hari. Ambang itu bentuk sederhana dari _confidence threshold_.
- **Kompleksitas:** O(n) untuk n ≤ 10 entri.
- **Catatan jujur:** ini statistik deskriptif, bukan prediksi. Untuk 10 titik data, modus sudah cukup dan model yang lebih rumit tidak ada gunanya.

### 2.7 Downsampling merata untuk kurva penonton

- **Di mana:** `downsample`, `addViewerSample` di [src/viewerTimeline.js](../src/viewerTimeline.js).
- **Masalah:** jumlah penonton dibaca tiap 20 detik. Live 3 jam menghasilkan 540 titik, dan `activeLives` ikut ditulis ke disk tiap siklus. Ukurannya harus tetap kecil, berapapun lamanya live.
- **Cara kerja:** ada batas 240 sampel. Saat terlampaui, sampel dipadatkan jadi separuhnya dengan mengambil titik dari indeks merata (`step = (n-1)/(max-1)`). Titik **pertama dan terakhir selalu ikut**, sehingga rentang waktunya tetap utuh. Live yang sangat panjang kehilangan resolusi, bukan bentuk.
- **Kompleksitas:** O(max) per pemadatan. Pemadatan jarang terjadi (amortized murah).
- **Alternatif yang sengaja tidak dipakai:** LTTB atau Ramer–Douglas–Peucker mempertahankan bentuk lebih baik, tetapi untuk grafik kecil di Discord, pengambilan merata sudah memadai dan jauh lebih mudah dites dan dijelaskan.

### 2.8 Rata-rata berbobot waktu (integrasi trapesium)

- **Di mana:** `computeViewerStats` di [src/viewerTimeline.js](../src/viewerTimeline.js).
- **Masalah:** rata-rata aritmetika dari sampel salah kalau jarak antar sampel tidak seragam (siklus lambat, sampel dilewati).
- **Cara kerja:** luas di bawah kurva dihitung dengan **aturan trapesium**: untuk tiap pasangan sampel bersebelahan, `luas += (v1 + v2) / 2 * selisihWaktu`. Rata-rata = total luas dibagi total durasi.
- **Kompleksitas:** O(n).
- **Pelajaran:** jarak antar sampel adalah bobot. Mengabaikannya adalah kesalahan statistik yang umum.

### 2.9 Jarak edit Levenshtein untuk saran salah ketik

- **Di mana:** `editDistance`, `suggestCommand` di [src/chat/commandSuggest.js](../src/chat/commandSuggest.js).
- **Masalah:** "cok strek nala" seharusnya menghasilkan "Maksud kamu `cok streak`?".
- **Cara kerja:** **pemrograman dinamis** untuk jarak Levenshtein (jumlah minimal sisip, hapus, ganti huruf untuk mengubah satu kata menjadi kata lain). Implementasinya memakai **satu baris memori** (cukup menyimpan baris sebelumnya), bukan matriks penuh.
- **Kompleksitas:** waktu O(n·m), memori O(m).
- **Aturan agar saran tidak mengganggu** (inilah bagian yang menentukan kualitas, bukan algoritmanya):
  - Hanya kata pertama yang diperiksa dan minimal 4 huruf.
  - Kalau kata itu sudah persis sebuah perintah, tidak ada saran (perintahnya dikenal, hanya argumennya yang tidak cocok).
  - Ambang jarak 1 (atau 2 untuk kata 7 huruf ke atas).
  - Kalau dua perintah sama-sama dekat (seri), tidak ada saran, karena menebak salah lebih buruk daripada diam.
- **Kenapa tidak fuzzy search yang lebih canggih:** hanya 19 kata kunci, jadi O(19 · panjang²) tidak terasa.

### 2.10 Pencocokan nama: per kata, bukan substring

- **Di mana:** `matchesNameFragment` dan `containsWholeWord` di [src/utils.js](../src/utils.js).
- **Masalah:** `nama.includes("a")` cocok ke hampir semua nama. Kata kunci "cok" ikut nyangkut di "cokelat".
- **Cara kerja:**
  - `matchesNameFragment`: input dipecah per kata, lalu kata harus **persis sama** dengan nama depan, atau minimal 3 huruf dan menjadi awalan (prefix) nama itu.
  - `containsWholeWord`: regex dengan batas non-alfanumerik di kiri dan kanan. Frasa dari pengguna di-_escape_ dulu, jadi karakter regex di dalamnya tidak ditafsirkan sebagai pola.
- **Pelajaran:** matching longgar menghasilkan false positive yang sulit dilacak. Mulai dari matching ketat, lalu longgarkan hanya di tempat yang terbukti perlu.

### 2.11 Penandatanganan request: HMAC-SHA256 dengan jendela waktu

- **Di mana:** `signPayload`, `verifySignature`, `requireSignedRequest` di [src/security.js](../src/security.js).
- **Masalah:** endpoint HTTP (backup, snapshot gifter) tidak boleh bisa dipanggil sembarang orang, dan request yang dicuri tidak boleh bisa diputar ulang.
- **Cara kerja:**
  1. Klien menghitung `HMAC-SHA256(secret, timestamp + "." + body)` dan mengirimkan timestamp dan tanda tangannya di header.
  2. Server menghitung ulang dan membandingkan.
  3. Request yang timestamp-nya lebih dari 5 menit dari sekarang ditolak (anti _replay_).
  4. Perbandingan memakai `crypto.timingSafeEqual`, supaya waktu respons tidak membocorkan seberapa mirip tanda tangan yang ditebak.
  5. Body dibatasi 5 MB, jadi klien tidak bisa menghabiskan memori.
- **Kenapa HMAC, bukan token biasa:** secret tidak pernah dikirim lewat jaringan, dan tanda tangan terikat ke isi request. Mengubah satu byte body membuat tanda tangan tidak valid.

### 2.12 Penulisan atomik (temp file + rename)

- **Di mana:** `writeFileAtomic` di [src/storage/jsonStore.js](../src/storage/jsonStore.js).
- **Masalah:** kalau proses mati di tengah `writeFile` (redeploy, crash), file tinggal separuh dan JSON tidak valid. Pembacaan berikutnya menganggapnya rusak, lalu menimpanya dengan default. Data hilang permanen.
- **Cara kerja:** tulis ke `file.tmp`, lalu `rename` ke nama tujuan. `rename` di dalam satu filesystem bersifat atomik, jadi pembaca selalu melihat versi lama yang utuh **atau** versi baru yang utuh, tidak pernah separuh.
- **Lapis kedua:** kalau file ada tapi isinya bukan JSON, salinannya disimpan sebagai `*.corrupt-<waktu>` sebelum jatuh ke default. Datanya masih bisa diselamatkan manual.

### 2.13 Pemeringkatan tebak-tebakan

- **Di mana:** [src/storage/guessGame.js](../src/storage/guessGame.js).
- **Cara kerja:** tebakan durasi diurutkan menurut selisih terhadap durasi sebenarnya (`sort` dengan penentu seri waktu tebak lebih awal). Tiga teratas mendapat 3, 2, 1 poin, ditambah bonus +2 untuk selisih ≤ 2 menit. Tebakan "siapa live berikutnya" bernilai +2. Tebakan dikunci setelah 15 menit pertama live supaya tidak ada yang menebak setelah jawabannya terlihat.
- **Kompleksitas:** O(g log g) untuk g penebak.
- **Pelajaran:** aturan permainan yang adil adalah bagian desain. Penentu seri yang deterministik (waktu tebak) mencegah hasil berbeda tiap dijalankan.

### 2.14 Penghitung rangkaian (run-length) untuk pesan berulang

- **Di mana:** [src/chat/repeatedReplyGuard.js](../src/chat/repeatedReplyGuard.js).
- **Cara kerja:** `Map` berkunci `channel:pengguna` menyimpan `{teks, jumlah, idPesan}`. Teks yang sama berturut-turut menaikkan hitungan, teks berbeda mengulang dari 1. Setelah ketikan ke-2, ketikan berikutnya menghapus pesan lama dalam rangkaian itu.
- **Pelajaran:** ini versi sederhana dari _run-length encoding_. Batas waktu pernah ada di sini, lalu dihapus karena terbukti menimbulkan bug. Aturan yang lebih sedikit sering lebih benar.

### 2.15 Router perintah chat: rantai pencocokan berurutan

- **Di mana:** `ROUTES` dan `buildChatReply` di [src/chat/commandRoutes.js](../src/chat/commandRoutes.js). Tombol, dropdown, dan modal memakai pola yang sama di [src/chat/interactionRoutes.js](../src/chat/interactionRoutes.js) (tabel `customId` ke handler).
- **Cara kerja:** pola _chain of responsibility_. `ROUTES` adalah daftar fungsi kecil bernama (`routeStreak`, `routeCompareList`, ...). Tiap fungsi mengembalikan `NO_MATCH` (bukan urusan saya, lanjut) atau balasannya. Daftar dijalankan berurutan dan **yang pertama menjawab menang**. Fitur baru (personal, tebak, wrapped) dipasang sebagai pencegat di depan, supaya perilaku lama tidak berubah. Pesan yang tidak cocok apa pun jatuh ke menu bantuan.
- **Kenapa `NO_MATCH` berupa `Symbol`, bukan `null`:** `null` adalah balasan sah (artinya "pesan ini bukan untuk bot, diam saja"). Penanda "lanjut" harus nilai yang tidak mungkin tertukar dengan balasan apa pun, dan `Symbol` unik menjamin itu.
- **Riwayat:** dulu ini satu fungsi ~600 baris. Dipecah menjadi tabel karena fungsi sepanjang itu tidak bisa dibaca, dites per aturan, atau diubah tanpa takut. Cara membuktikan pemecahannya tidak mengubah perilaku dijelaskan di bagian 3.10.
- **Konsekuensi:** urutan adalah bagian dari logika. Menambah pola di tempat yang salah bisa diam-diam mencuri pesan dari pola lain. Karena itu ada tes yang memeriksa jawaban untuk ratusan kalimat, dan skrip fuzz yang mengirim ribuan pesan acak.

---

## 3. Prinsip software engineering yang diterapkan

### 3.1 Pisahkan logika murni dari I/O ("functional core, imperative shell")

Fungsi yang hanya menerima input dan mengembalikan output (tanpa file, jaringan, atau jam global) ditaruh terpisah: `computeCurrentStreak`, `computeSchedulePattern`, `computeViewerStats`, `computeNextPollDelay`, `editDistance`.

- **Manfaat:** dites dengan input langsung, tanpa mock.
- **Bukti di kode:** komentar `monitor.js` menyebut "logic murni dipisah dari orkestrasi yang nyentuh I/O".

Arah dependensi satu arah (`chat` dan `notify` tidak saling impor) mencegah **dependensi melingkar**, yang membuat modul tidak bisa dites atau dipahami sendiri-sendiri. Pola yang dipakai: bila dua modul butuh hal yang sama, buat modul ketiga yang netral.

### 3.2 DRY lewat factory: `createJsonStore`

Pola "baca file, cache di memori, fallback ke default, tulis atomik" dulu ditulis manual di sekitar 6 tempat. Sekarang satu fungsi, [src/storage/jsonStore.js](../src/storage/jsonStore.js), dipakai 17 modul penyimpanan.

- Perbaikan sekali berlaku di semua tempat (misalnya perbaikan penulisan atomik).
- **Cache memperbarui hanya setelah penulisan sukses.** Versi awalnya memperbarui cache lebih dulu (optimistic), lalu kalau disk gagal, proses mengira data tersimpan padahal tidak. Ini contoh klasik: _jangan percaya state yang belum terkonfirmasi_.

### 3.3 Isolasi kegagalan (bulkhead dan graceful degradation)

Prinsip: **fitur tambahan tidak boleh menjatuhkan fitur inti**.

- `safely(label, fn)` di `monitor.js` membungkus fitur sampingan (grafik, tebak-tebakan, status bot, ringkasan mingguan). Kalau salah satu melempar error, error dicatat dan siklus polling lanjut.
- Ini lahir dari bug nyata: error di fitur sampingan bisa membuat sesi live "tersangkut" karena siklus terhenti di tengah.
- Pengiriman DM dan tag punya cadangan: kalau pemisahan preferensi gagal, jatuh ke "tag semua" (perilaku lama), bukan diam.
- `unhandledRejection` tidak lagi mematikan proses. Pemilik diberi tahu lewat DM dengan _cooldown_ 10 menit, supaya error yang berulang tidak membanjiri.

### 3.4 Jangan percaya data, termasuk data milik sendiri

- Data dari **luar** (API IDN, input chat) divalidasi: `view_count` bisa `null`, nama bisa kosong ("jangan sampai notif menulis `undefined`").
- Data dari **disk** disaring saat dimuat (`cleanSamples`, `cleanScores`, `cleanDuration`, ...). File bisa korup atau diedit tangan, dan satu entri `null` pernah membuat `cok papan tebak` melempar error.
- Konfigurasi dari **environment** divalidasi (`envHour` menerima 0–23, `envStr` memangkas spasi, interval polling punya minimum).

Aturan praktis: validasi di **batas sistem** (tempat data masuk), lalu kode di dalam boleh lebih percaya diri.

### 3.5 Pertahanan berlapis (defense in depth)

Satu perlindungan tidak cukup, jadi dipasang beberapa yang saling menutup:

| Ancaman                          | Lapisan pertahanan                                             |
| -------------------------------- | -------------------------------------------------------------- |
| Nama member berisi `@everyone`   | `allowed_mentions: { parse: [] }` di semua pengiriman webhook  |
| Banyak subscriber memenuhi pesan | Batas 50 mention, sisanya "(+N subscriber lain)"               |
| Request HTTP palsu               | HMAC + timestamp + `timingSafeEqual`                           |
| Replay request curian            | Jendela 5 menit                                                |
| Body raksasa menghabiskan memori | Batas 5 MB                                                     |
| Pesan melebihi batas Discord     | `clampDiscordContent`, batas panjang embed yang dites          |
| Rahasia ikut ter-commit          | `.gitignore`, `.git/info/exclude`, dan tidak ada token di repo |

### 3.6 Idempotensi dan penanganan restart

Hal yang harus aman dijalankan ulang kapan saja:

- `activeLives` ditulis tiap siklus, sehingga restart tidak menghilangkan puncak penonton atau memicu notif "mulai" ganda.
- Dedup mingguan (`digestWeek`) memastikan ringkasan DM tidak dikirim dua kali kalau bot restart di jam yang sama.
- Alert milestone memakai penanda (`alertedMilestones`, `lastAlertedStreak`) supaya satu angka hanya dirayakan sekali.
- `shutdown` yang rapi: siklus yang sedang berjalan dibiarkan selesai, hanya siklus berikutnya yang dibatalkan.

### 3.7 Observabilitas

Sistem harus bisa memberi tahu kalau sedang sakit:

- `pollHealth` menghitung kegagalan berturut-turut ke IDN dan memberi tahu pemilik di ambang tertentu (sekali, lalu sinyal pulih).
- Log boot menyatakan apakah penyimpanan persisten (`CACHE_DIR aktif: ... persistent ✓`). Kegagalan senyap yang paling berbahaya (data hilang tiap redeploy) dibuat berisik.
- Perintah `cok status` dan `/api/status` memperlihatkan kondisi tanpa membuka log.

### 3.8 Strategi pengujian

Sekitar 880 tes dengan `node --test`, tanpa framework tambahan. Lapisannya:

| Lapisan               | Contoh                                                                   |
| --------------------- | ------------------------------------------------------------------------ |
| Unit murni            | `streakMath.test.js`, `viewerTimeline.test.js`, `commandSuggest.test.js` |
| Penyimpanan           | `jsonStore.test.js`, `userPrefs`, `guessGame` (termasuk data korup)      |
| Integrasi dengan fake | `monitor.test.js` (IDN dan Discord di-mock)                              |
| Isolasi kegagalan     | `sideFeatureIsolation.test.js` (fitur sampingan dipaksa melempar)        |
| Regresi               | Satu tes untuk tiap bug yang pernah ditemukan                            |
| Fuzz                  | Ribuan pesan acak ke router, harus 0 kegagalan                           |
| Batas ukuran          | Embed bantuan harus < 4096 karakter                                      |

Praktik penting:

- **Waktu dikendalikan** (`Date.now` di-stub), jadi tes tidak flaky dan tidak bergantung jam sungguhan.
- **Tes diuji pada jam yang dibekukan.** Seluruh suite dijalankan ulang pada puluhan jam palsu di sekitar tengah malam, pergantian bulan, tahun, dan pekan. Cara ini menemukan tes yang hanya gagal pada menit tertentu (misalnya data "1 menit yang lalu" yang pada pukul 00:00:30 ternyata jatuh ke hari atau bulan sebelumnya). Pelajarannya: data uji sebaiknya dijangkar ke tanggal eksplisit, bukan "sekarang dikurangi N".
- **Tes ditulis dari bug nyata.** Tiap perbaikan menambah tes yang akan gagal kalau bug muncul lagi.
- **CI** (`.github/workflows`) menjalankan semua tes tiap push, di Node 20.

### 3.9 Dokumentasi sebagai bagian dari kode

- Komentar menjelaskan **kenapa**, bukan **apa**. Banyak komentar mencatat bug yang pernah terjadi ("BUG SEBELUMNYA: ..."), supaya orang berikutnya tidak "menyederhanakan" kode dan menghidupkan bug itu lagi.
- `ARCHITECTURE.md` mencatat keputusan, audit, dan titik ekstensi.
- Aturan sederhana: kalau sesuatu terlihat berlebihan di kode, harus ada komentar yang menjelaskan alasannya.

### 3.10 Refactor yang dibuktikan, bukan diyakini (golden master)

Memecah fungsi 600 baris itu berisiko: urutan pencocokan adalah logika, dan satu `if` yang bergeser bisa diam-diam mengubah jawaban bot untuk kalimat yang tidak ada di tes. Tes yang ada (835 saat itu) lulus tidak cukup membuktikan "perilakunya sama", karena tes hanya mencakup kalimat yang terpikir oleh penulisnya.

Teknik yang dipakai: **characterization test / golden master**.

1. **Rekam dulu, ubah kemudian.** Sebelum menyentuh kode, jalankan versi lama untuk korpus besar (semua kalimat dari tes + ratusan kombinasi perintah × nama, termasuk nama aneh, dalam lima konteks: channel bot, channel biasa, owner, DM) dan simpan semua jawabannya: 4.185 kombinasi.
2. **Buat lingkungan deterministik.** Waktu, `Math.random`, dan jaringan dibuat tetap. Dua rekaman dari kode yang sama harus identik byte-per-byte. Kalau tidak, jaring pengamannya tidak bisa dipercaya.
3. **Ubah struktur saja**, jangan perilaku. Setelah itu rekam lagi dan bandingkan. Hasilnya: 0 perbedaan.
4. **Perilaku yang memang salah diperbaiki terpisah**, bukan terselip dalam refactor. Saat memindahkan kode ditemukan bug lama (`cok constructor` dibalas dengan fungsi karena kunci objek berasal dari input pengguna). Perbaikannya dikerjakan sebagai langkah tersendiri dengan tes yang terbukti gagal pada kode lama.

Pelajaran umumnya: **refactor = mengubah struktur tanpa mengubah perilaku**. Kalau keduanya dicampur, saat ada yang rusak tidak ada yang tahu penyebabnya. Dan kalau kamu tidak bisa membuktikan perilakunya sama, kamu sebenarnya tidak sedang merefaktor, kamu sedang berharap.

Dua pelajaran kecil dari bug yang ditemukan:

- **Input pengguna jangan dipakai langsung sebagai kunci objek biasa.** `obj[input]` juga membaca `constructor`, `__proto__`, `toString` dari `Object.prototype`. Pakai `Object.prototype.hasOwnProperty.call(obj, key)`, `Map`, atau `Object.create(null)`. Pola ini sudah benar di `aliases.js` dan `guessGame.js`, dan sekarang juga di router.
- **Tes yang baik harus terbukti bisa gagal.** Tes untuk bug itu dijalankan terhadap kode lama yang sengaja dikembalikan, dan benar-benar gagal. Tes yang tidak pernah terlihat gagal belum membuktikan apa-apa.

---

## 4. Trade-off dan keterbatasan yang jujur

Desain yang baik bukan desain tanpa kelemahan. Ini yang sengaja diterima:

| Pilihan                                      | Keuntungan                                         | Harga yang dibayar                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Penyimpanan file JSON                        | Tanpa database, murah, mudah di-backup             | Tidak ada transaksi, tidak ada query, penulisan `writeFileSync` memblokir sebentar                                                              |
| Cache di memori                              | Cepat, tanpa baca ulang                            | Asumsi **satu proses saja**. Dua instance akan saling menimpa dan notif ganda                                                                   |
| Polling 20 detik                             | Satu-satunya cara dengan API IDN                   | Notif bisa terlambat hingga ~20 detik; ada beban request tetap                                                                                  |
| At-least-once                                | Notif tidak hilang                                 | Duplikat mungkin terjadi pada kasus langka                                                                                                      |
| State percakapan di `Map` memori             | Sederhana                                          | Hilang saat restart (menu "balas angka" gugur, tidak merusak data)                                                                              |
| Pola jadwal dari 10 sesi                     | Sederhana, mudah dijelaskan                        | Bisa meleset kalau pola live berubah; sengaja diberi ambang keyakinan                                                                           |
| `replies.js` berisi ~2.800 baris, 118 fungsi | Semua pembuat balasan di satu tempat, mudah dicari | Terlalu besar: kandidat dipecah per fitur (rekap, statistik, langganan). Belum dikerjakan karena risikonya lebih besar dari manfaatnya sekarang |

**Kapan perlu pindah ke database:** bila datanya perlu di-query lintas entitas (misalnya "semua sesi di atas 5.000 penonton bulan lalu"), bila ada lebih dari satu instance, atau bila file data melewati puluhan MB. Untuk skala sekarang (puluhan member, ratusan sesi), file JSON adalah pilihan yang tepat. Memakai PostgreSQL sejak awal akan menambah biaya dan kerumitan tanpa manfaat.

---

## 5. Cara belajar dari kode ini

Urutan baca yang disarankan, dari yang paling mudah:

1. [src/storage/jsonStore.js](../src/storage/jsonStore.js): 70 baris, konsep cache, atomik, dan fallback.
2. [src/streakMath.js](../src/streakMath.js): logika murni dengan tanggal dan zona waktu.
3. [src/viewerTimeline.js](../src/viewerTimeline.js): downsampling dan integrasi numerik.
4. [src/chat/commandSuggest.js](../src/chat/commandSuggest.js): pemrograman dinamis dan aturan "kapan diam".
5. [src/security.js](../src/security.js): kriptografi praktis.
6. [src/notify/webhook.js](../src/notify/webhook.js): retry, timeout, dan batas.
7. [src/monitor.js](../src/monitor.js): orkestrasi, state machine, isolasi kegagalan. Baca terakhir.

Latihan:

- **Mudah:** tambahkan satu perintah ke `COMMANDS` di `commandSuggest.js` dan tulis tesnya.
- **Sedang:** ubah `ENDED_GRACE_POLLS` menjadi 1 dan 4, jalankan `tests/monitor.test.js`. Lihat tes mana yang gagal dan kenapa. Itu cara paling cepat memahami debounce.
- **Sedang:** ganti `downsample` dengan algoritma LTTB. Tes lama harus tetap lulus.
- **Sulit:** rancang antarmuka penyimpanan (`load`/`save`) yang bisa diganti SQLite tanpa mengubah pemanggil. `createJsonStore` sudah hampir seperti itu.

---

## 6. Glosarium

| Istilah                 | Arti singkat                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Atomik                  | Operasi yang selesai seluruhnya atau tidak sama sekali, tidak pernah separuh              |
| At-least-once           | Jaminan pesan sampai minimal sekali (duplikat mungkin), lawan dari at-most-once           |
| Backoff                 | Menunggu sebelum mencoba lagi, biasanya makin lama                                        |
| Bulkhead                | Sekat yang membatasi kegagalan supaya tidak menjalar ke bagian lain                       |
| Chain of responsibility | Daftar penangan yang dicoba berurutan sampai ada yang cocok                               |
| Debounce / histeresis   | Menahan perubahan state sampai kondisinya bertahan beberapa kali, supaya tidak berkedip   |
| Defense in depth        | Beberapa lapis pengaman yang saling menutup, bukan satu                                   |
| Downsampling            | Mengurangi jumlah titik data sambil menjaga bentuk keseluruhan                            |
| Fuzz test               | Menguji dengan input acak dalam jumlah besar untuk mencari kasus tak terduga              |
| Graceful degradation    | Fitur yang gagal diturunkan fungsinya, bukan menjatuhkan seluruh sistem                   |
| HMAC                    | Tanda tangan dari secret + pesan, membuktikan pengirim tahu secret dan pesan tidak diubah |
| Idempoten               | Dijalankan berkali-kali hasilnya sama dengan sekali                                       |
| Levenshtein             | Jumlah minimal sisip, hapus, ganti huruf untuk mengubah satu kata menjadi kata lain       |
| Pure function           | Fungsi tanpa efek samping yang hasilnya hanya bergantung pada argumennya                  |
| Rate limit (HTTP 429)   | Server menolak sementara karena terlalu banyak request                                    |
| Replay attack           | Mengirim ulang request sah yang pernah disadap                                            |
| Trapesium (aturan)      | Menghitung luas di bawah kurva dengan potongan trapesium antar titik berurutan            |
