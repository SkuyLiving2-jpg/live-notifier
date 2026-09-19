# JKT48 IDN Live Notifier

Discord bot yang mantau IDN Live tiap 30 detik dan ngirim notifikasi otomatis pas member JKT48 mulai/selesai live, plus fitur tanya-jawab lewat chat ("cok, siapa yang live?"). 3 member prioritas (Nala/Levi/Lily, bisa ditambah lewat chat) dapet perlakuan flashy tambahan lewat DM ke pemilik bot.

Untuk penjelasan arsitektur, data flow, dan alasan desain di balik keputusan-keputusan teknisnya, lihat **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Jalanin lokal

```bash
npm install
cp .env.example .env   # isi DISCORD_WEBHOOK_URL minimal
npm start
```

`DISCORD_WEBHOOK_URL` itu satu-satunya env var yang **wajib** — semua yang lain di `.env.example` opsional dan bikin fitur tambahan aktif kalau diisi (bot token buat chat, ID owner buat DM prioritas, dst). Penjelasan tiap env var ada di `.env.example` dan di ARCHITECTURE.md §8.

## Scripts

| Command                | Buat apa                                                                |
| ---------------------- | ----------------------------------------------------------------------- |
| `npm start`            | Nyalain bot (`node src/index.js`)                                       |
| `npm test`             | Jalanin automated test suite (`node --test`)                            |
| `npm run lint`         | Cek gaya kode pake ESLint                                               |
| `npm run format`       | Rapiin format kode otomatis pake Prettier                               |
| `npm run format:check` | Cek format tanpa ngubah file (dipake CI)                                |
| `npm run cek-gifter`   | Tool CLI manual buat cek top-gifter (lihat `scripts/cek-top-gifter.js`) |
| `npm run backup-data`  | Tool CLI manual buat narik backup data bot ke file lokal                |

## Deploy

Didesain buat jalan di [Railway](https://railway.app) lewat `npm start`. Tempelin sebuah **Volume** ke service-nya biar data (rekap live, riwayat durasi, dll) tahan lintas redeploy — tanpa Volume, data ke-reset tiap kali ada deploy baru (bot bakal nge-log status ini pas boot). Detail lebih lengkap ada di ARCHITECTURE.md §9.
