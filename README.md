# JKT48 IDN Live Notifier

Discord bot yang mantau IDN Live tiap ~20 detik (bisa diatur lewat `POLL_INTERVAL_SECONDS`) dan ngirim notifikasi otomatis pas member JKT48 mulai/selesai live, plus fitur tanya-jawab lewat chat ("cok, siapa yang live?") ATAU slash command native ("/live", "/rekap", "/grafik", dst - lihat `npm run register-slash-commands` di bawah). 3 member prioritas (Nala/Levi/Lily, bisa ditambah lewat chat) dapet perlakuan flashy tambahan lewat DM ke pemilik bot.

Untuk penjelasan arsitektur, data flow, dan alasan desain di balik keputusan-keputusan teknisnya, lihat **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Untuk pembelajaran: **[docs/ALGORITMA-DAN-SISTEM.md](docs/ALGORITMA-DAN-SISTEM.md)** menjelaskan algoritma yang dipakai, pola sistemnya, dan prinsip software engineering di baliknya, lengkap dengan trade-off dan urutan baca kode.

## Jalanin lokal

```bash
npm install
cp .env.example .env   # isi DISCORD_WEBHOOK_URL minimal
npm start
```

`DISCORD_WEBHOOK_URL` itu satu-satunya env var yang **wajib** — semua yang lain di `.env.example` opsional dan bikin fitur tambahan aktif kalau diisi (bot token buat chat, ID owner buat DM prioritas, dst). Penjelasan tiap env var ada di `.env.example` dan di ARCHITECTURE.md §8.

## Scripts

| Command                                  | Buat apa                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm start`                              | Nyalain bot (`node src/index.js`)                                                                                                                                  |
| `npm test`                               | Jalanin automated test suite (`node --test`)                                                                                                                       |
| `npm run lint`                           | Cek gaya kode pake ESLint                                                                                                                                          |
| `npm run format`                         | Rapiin format kode otomatis pake Prettier                                                                                                                          |
| `npm run format:check`                   | Cek format tanpa ngubah file (dipake CI)                                                                                                                           |
| `npm run cek-gifter`                     | Tool CLI manual buat cek top-gifter (lihat `scripts/cek-top-gifter.js`)                                                                                            |
| `npm run backup-data`                    | Tool CLI manual buat narik backup data bot ke file lokal                                                                                                           |
| `npm run restore-data -- <file>`         | Pulihkan data dari file backup. Default cuma PRATINJAU; tambah `--apply` buat benar-benar menimpa (keadaan sekarang disimpan dulu ke `backups/pre-restore-*.json`) |
| `npm run vc-playground`                  | Halaman web lokal (http://localhost:4848) buat nyoba fitur `input vc` tanpa DM Discord beneran - lihat bagian "Rangkuman VC"                                       |
| `npm run register-slash-commands`        | Daftarin slash command ("/live", "/rekap", dst) ke SERVER - jalanin ulang tiap kali daftar command-nya berubah. Tidak muncul di DM                                 |
| `npm run register-slash-commands:global` | Sama, tapi GLOBAL: command muncul di server DAN di DM dengan bot (butuh sampai ~1 jam; command per-server lama otomatis dikosongkan)                               |

## Rangkuman VC (khusus owner, lewat DM)

Chat bot lewat **DM** dan ketik `input vc`. Bot mengirim satu pesan rangkuman Video Call (di-update otomatis) plus panel tombol (berhalaman seperti menu utama bot: maks 3 tombol per halaman + Tutup / Menu sebelumnya / Menu lainnya) buat tambah/ubah/hapus sesi, ganti judul, dan reset periode. Urutan tambah sesi: member → tanggal → **sesi (dropdown)** → form (Mulai, Link, Tiket). Pilihan sesi mengikuti hari: **Senin-Jumat sesi 1-3** (buka 16.15-16.30 / 17.45-18.00 / 19.15-19.30), **Sabtu-Minggu sesi 1-6** (11.30-11.45 / 13.00-13.15 / 14.30-14.45, lalu sesi 4-6 sama dengan sesi 1-3 hari kerja). Jam buka ikut sesinya, jadi yang diketik tinggal jam mulai, yang harus **15 menit sebelum jam buka sampai jam buka** (buka 16.15-16.30 → mulai 16.00-16.15; di luar rentang ditolak). Sesi 4-6 di hari kerja ditolak. Satu link Zoom cuma boleh dipakai satu sesi (dicek lewat ID rapat Zoom-nya, jadi beda host/`?pwd=` tetap dianggap sama). Beberapa member di sesi yang sama? Setelah simpan, tombol **Member lain (Sesi N sama)** langsung ke form member berikutnya tanpa pilih tanggal/sesi lagi. Sesi yang baru dibuat berstatus **belum selesai** sampai kamu menekan **✅ Selesai**. Selama itu, tombol Tutup berubah jadi **Tutup & buang N sesi baru**: menutup panel sekaligus membuang sesi-sesi baru itu, dan kalau rangkumannya jadi kosong pesan rangkuman (judul + pembuka) ikut dihapus. Sesi dari sitting sebelumnya (sudah Selesai) tidak pernah disentuh. Mau hapus total? Tombol **Hapus rangkuman** (ada konfirmasi) menghapus pesan rangkuman dari DM dan mengosongkan semua sesi; julukan member tetap disimpan. Member prioritas selalu di atas dengan format spesial; catatan absurdnya digenerate otomatis. `julukan vc <nama> = <julukan>` buat julukan di judul member. **Pengingat jam mulai**: 5 menit sebelum jam Mulai sesi (sampai 10 menit sesudahnya, kalau bot sempat restart) bot DM kamu berisi link Zoom, kode sandi, tiket, dan jam buka; satu DM per sesi, matikan dengan `VC_REMINDER_DM=off`. Orang lain gak dapat respons apa pun, dan di channel server fitur ini cuma menjawab "pakai DM".

### Coba tanpa DM Discord: VC Playground

`npm run vc-playground` lalu buka <http://localhost:4848>. Isinya simulasi DM/channel Discord di browser yang menjalankan **kode bot yang asli** (router, tombol, dropdown, form, renderer, penyimpanan) di atas Discord palsu:

- **Aman**: cuma mendengarkan `127.0.0.1`, tidak login ke Discord, semua panggilan jaringan diblokir, token/webhook di `.env` tidak terbaca, data ditulis ke folder sementara (hilang saat dihentikan).
- Bisa berperan sebagai **Owner** atau **Orang lain**, di **DM** atau **channel server**; tombol/dropdown/form berperilaku seperti Discord (form wajib terisi, dropdown maks 25 opsi, dst).
- Aturan Discord **ditegakkan**: isi > 2000 karakter, > 5 baris komponen, custom_id ganda, balas dua kali, `editReply` sebelum ack, interaksi tanpa respons ("Interaksi ini gagal"), ack > 3 detik. Pelanggaran muncul merah di tab **Log**.
- Tab **Data VC** menampilkan isi `vc-schedule.json`; tab **Alat uji** punya data contoh, data banyak (uji pemecahan pesan), simulasi gangguan (DM ditolak, bot belum login, IDN down, Discord lambat), dan memajukan jam bot (uji draft kedaluwarsa).
- Batasnya: tampilan teksnya pendekatan markdown Discord, bukan renderer aslinya. Tampilan akhir di aplikasi Discord tetap perlu dicek sekali.

## Backup

Bot ngirim **backup mingguan otomatis ke DM owner** (file `.json`, tanpa webhook channel; matikan dengan `WEEKLY_BACKUP_DM=off`). Kalau data di Railway hilang: `npm run restore-data -- backup-xxxx.json` buat lihat pratinjau, lalu tambah `--apply`. Webhook channel khusus di-push ulang lewat `npm run set-channel-routing`.

## Monitoring

`GET /healthz` (publik, tanpa data member) jawab **200** selama polling IDN sukses dalam 5 menit terakhir dan **503** kalau macet (IDN down terus, atau loop polling berhenti). Pasang di uptime monitor (mis. UptimeRobot, interval 5 menit) ke `https://<domain-railway-kamu>/healthz` biar kamu dikabari kalau bot hidup tapi gak lagi mendeteksi live. `/` tetap selalu 200 (dipakai health check deploy Railway).

## Deploy

Didesain buat jalan di [Railway](https://railway.app) lewat `npm start`. Tempelin sebuah **Volume** ke service-nya biar data (rekap live, riwayat durasi, dll) tahan lintas redeploy — tanpa Volume, data ke-reset tiap kali ada deploy baru (bot bakal nge-log status ini pas boot). Detail lebih lengkap ada di ARCHITECTURE.md §9.
