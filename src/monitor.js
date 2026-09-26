const { fetchAllLivestreams, isJkt48Member } = require("./idnApi");
const { activeLives, saveActiveLives } = require("./storage/activeLives");
const { loadDurationHistory, recordLiveDuration } = require("./storage/durationHistory");
const { recordLiveEnded } = require("./storage/dailyLog");
const { recordLiveCompleted } = require("./storage/liveCount");
const { getPriorityConfig } = require("./priority");
const { sendDiscordNotif } = require("./notify/liveNotify");
const { maybePartyModeAlert, maybeAlertEndingSoon, maybeSendHeadsUpAlerts } = require("./notify/priorityDm");
const {
  maybeAlertViewerMilestone,
  maybeAnnounceNewRecord,
  maybeSendDailyRecap,
  maybeSendWeeklyRecap,
  maybeSendMonthlyRecap,
} = require("./notify/publicAlerts");
const { POLL_INTERVAL_MS, MAX_PLAUSIBLE_LIVE_DURATION_MS } = require("./config");

// Berapa siklus polling BERTURUT-TURUT (~POLL_INTERVAL_MS/siklus, default 20
// detik - lihat config.js) member harus ABSEN dari respons IDN sebelum
// beneran dianggap "udah selesai live" - BUKAN langsung pas ilang SEKALI
// doang. IDN API kadang ngasih respons 200 OK yang KEBETULAN nggak
// nyantumin satu live yang beneran masih jalan (glitch sesaat di sisi IDN,
// bukan error jaringan kayak yang udah ditangani try/catch luar). Tanpa
// grace period ini, satu respons flaky kayak gitu bikin bot nganggep
// live-nya "selesai" (kecatet durasi pendek ke stats + notif "selesai"
// kekirim), terus pas dia balik muncul di siklus BERIKUTNYA, dianggap
// "mulai baru" - satu live yang beneran nyambung terus jadi kecatet PECAH
// jadi 2 sesi di rekap. Ini persis yang dilaporin owner: member yang sama
// muncul 2x di tabel rekap dengan jam "Mulai" yang SAMA PERSIS (soalnya
// `live_at` dari IDN buat live yang sama gak berubah) tapi durasi beda. 2
// siklus = harus absen 2x BERTURUT-TURUT baru dianggap beneran selesai -
// cukup buat nyaring glitch 1 siklus, tapi gak nunda notif "selesai" yang
// beneran kelamaan (paling lama satu siklus tambahan lebih lambat dari
// sebelumnya).
const ENDED_GRACE_POLLS = 2;

async function checkLiveMembers() {
  try {
    const currentLives = await fetchAllLivestreams();
    const currentLiveUsernames = new Set();
    // Dibaca sekali per siklus polling (bukan sekali per member yang live)
    // biar nggak buka file yang sama berkali-kali kalau lagi banyak yang live.
    const durationHistory = loadDurationHistory();

    for (const live of currentLives) {
      const username = live?.creator?.username;
      if (!username) continue; // skip entry yang datanya nggak lengkap
      if (!isJkt48Member(live.creator)) continue; // cuma peduli member JKT48

      currentLiveUsernames.add(username);

      // Kirim notif cuma kalo member baru mulai live
      if (!activeLives.has(username)) {
        const terkirim = await sendDiscordNotif(live.creator.name, live.creator.username, live.slug, "start", live.image_url, live.live_at);
        if (terkirim) {
          activeLives.set(username, {
            name: live.creator.name,
            username,
            slug: live.slug,
            liveAt: live.live_at,
            viewCount: live.view_count,
            peakViewCount: live.view_count ?? null,
            imageUrl: live.image_url || null,
            endingSoonAlerted: false,
            alertedMilestones: [],
          });
          saveActiveLives();
          if (getPriorityConfig(live.creator.name, live.creator.username)) {
            await maybePartyModeAlert();
          }
        }
        // kalau gagal kirim, username sengaja nggak ditambahin
        // biar dicoba lagi di polling berikutnya
      } else {
        // udah live dari sebelumnya - update data terbaru & cek heuristik
        // "kemungkinan mendekati akhir" (cuma buat member prioritas) + cek
        // milestone jumlah penonton (buat semua member JKT48)
        const entry = activeLives.get(username);
        entry.viewCount = live.view_count;
        entry.missingStreak = 0; // beneran keliatan lagi di respons ini - reset penghitung absen (kalau ada) dari ENDED_GRACE_POLLS
        if (typeof live.view_count === "number") {
          entry.peakViewCount = Math.max(entry.peakViewCount ?? 0, live.view_count);
        }
        await maybeAlertEndingSoon(entry, durationHistory);
        await maybeAlertViewerMilestone(entry);
        // BUG SEBELUMNYA: viewCount/peakViewCount di atas cuma dimutasi di
        // Map in-memory - saveActiveLives() sebelumnya cuma kepanggil kalau
        // maybeAlertEndingSoon/maybeAlertViewerMilestone kebetulan nge-trigger
        // (nyimpen SENDIRI pas nulis flag alert-nya). Kalau bot restart
        // (redeploy Railway, dll) SEBELUM itu ke-trigger lagi, active-lives-cache.json
        // di disk masih punya peakViewCount BASI dari awal live-nya doang -
        // abis restart, puncak penonton yang beneran udah dicapai sebelum
        // restart itu HILANG (peak "reset" ke angka lama), bikin "cok siapa
        // yang paling rame ditonton" salah buat live yang nyebrang restart.
        // Disimpen tiap siklus sekarang, bukan cuma pas ada alert.
        saveActiveLives();
      }
    }

    // Kirim notif "sudah selesai" + bersihkan cache kalau member udah selesai live
    for (const [username, memberData] of activeLives) {
      if (!currentLiveUsernames.has(username)) {
        memberData.missingStreak = (memberData.missingStreak || 0) + 1;
        if (memberData.missingStreak < ENDED_GRACE_POLLS) {
          // Baru absen 1x - kemungkinan glitch sesaat di respons IDN, bukan
          // beneran selesai. Ditunggu 1 siklus lagi (lihat ENDED_GRACE_POLLS
          // di atas) sebelum diproses sebagai "selesai" - kalau dia balik
          // muncul di siklus berikutnya, missingStreak-nya di-reset di
          // branch "udah live dari sebelumnya" di atas, jadi gak pernah
          // sampe ke notif/pencatatan "selesai" sama sekali.
          saveActiveLives();
          continue;
        }

        const terkirim = await sendDiscordNotif(memberData.name, memberData.username, memberData.slug, "end", memberData.imageUrl);
        if (terkirim) {
          if (memberData.liveAt) {
            const durationMs = Date.now() - new Date(memberData.liveAt).getTime();
            // BUG SEBELUMNYA: durationMs di sini gak pernah divalidasi sama
            // sekali - beda dari server.js's handleBackfillLiveHistory/
            // handleRepairLiveHistory yang UDAH nyaring durasi implausible
            // (>MAX_PLAUSIBLE_LIVE_DURATION_MS, lihat ARCHITECTURE.md §10)
            // dari jalur BACKFILL, tapi jalur LIVE normal ini (dipanggil tiap
            // POLL_INTERVAL_MS selama bot jalan) kelewatan sama sekali. Kalau
            // activeLives nyimpen `liveAt` yang udah basi (mis. bot mati
            // berjam-jam - crash loop, Railway kena masalah, dll - terus
            // member itu KEBETULAN masih/lagi live pas bot idup lagi), durasi
            // yang keitung bakal ngelewatin downtime-nya juga, dan tanpa
            // penyaringan ini bakal ke-tulis LANGSUNG ke daily-log/
            // duration-history/pengumuman rekor - persis kelas bug "100+ jam
            // live" yang dilaporin owner, cuma lewat pintu yang beda (live
            // biasa, bukan backfill). Sesi implausible DIBUANG dari
            // stats/rekor (gak nyoba nyimpen versi "diclamp" - gak ada cara
            // ngebedain berapa dari durasi itu yang beneran live vs
            // downtime), tapi notif "selesai" tetap udah kekirim & cache
            // tetep dibersihin di bawah, biar gak nyangkut selamanya.
            if (durationMs > 0 && durationMs <= MAX_PLAUSIBLE_LIVE_DURATION_MS) {
              await maybeAnnounceNewRecord(username, memberData.name, durationMs, durationHistory);
              recordLiveDuration(username, memberData.name, durationMs);
              recordLiveCompleted(username, memberData.name);
              recordLiveEnded(
                memberData.name,
                memberData.username,
                new Date(memberData.liveAt),
                new Date(),
                memberData.peakViewCount ?? memberData.viewCount ?? null,
              );
            } else {
              console.error(
                `Durasi live ${memberData.name} implausible (${durationMs}ms) - kemungkinan cache activeLives basi (bot sempet mati lama). Sesi ini DIBUANG dari stats/rekap, gak dicatet.`,
              );
            }
          }
          activeLives.delete(username);
          saveActiveLives();
        }
        // kalau gagal kirim, sengaja nggak dihapus dari cache
        // biar dicoba lagi di polling berikutnya
      }
    }

    await maybeSendDailyRecap();
    await maybeSendWeeklyRecap();
    await maybeSendMonthlyRecap();
    await maybeSendHeadsUpAlerts();
  } catch (error) {
    console.error("Gagal ngecek IDN Live:", error.message);
  }
}

// Dipegang biar bisa di-clear pas graceful shutdown (lihat stopPolling di
// bawah) - tanpa ini, SIGTERM/SIGINT dari Railway cuma bisa "maksa" proses
// berhenti (kill), bukan berhenti rapi abis siklus yang lagi jalan kelar.
let pollTimeoutHandle = null;
let stopped = false;

// Jeda MINIMAL antar siklus, apapun yang kejadian - jaring pengaman biar
// computeNextPollDelay gak pernah balikin 0 (atau negatif) yang bikin
// checkLiveMembers() langsung diulang tanpa jeda sama sekali kalau siklus
// sebelumnya somehow makan waktu >= POLL_INTERVAL_MS (mis. lagi kena retry
// rate-limit Discord beruntun) - itu bisa nge-hammer API IDN pas dia/Discord
// lagi kebetulan bermasalah, bukan nolong sama sekali.
const MIN_POLL_DELAY_MS = 1000;

// Berapa lama siklus BERIKUTNYA harus nunggu, dihitung dari berapa lama
// siklus BARUSAN makan waktu - diekstrak jadi fungsi murni biar bisa dites
// langsung tanpa perlu mock network/setTimeout beneran (sama pola kayak
// buildDailyRecapPayload/buildRecapTablePage - logic murni dipisah dari
// orkestrasi yang nyentuh I/O).
//
// BUG SEBELUMNYA: pollLoop nunggu POLL_INTERVAL_MS PENUH abis
// checkLiveMembers() selesai, bukan jadwal tetap dari AWAL siklus. Kalau
// satu siklus kebetulan lambat (mis. kena retry 429 Discord yang bisa makan
// beberapa detik - lihat webhook.js's MAX_RATE_LIMIT_WAIT_MS), siklus
// berikutnya ikut mundur juga, bukan cuma siklus yang lambat itu doang -
// efeknya numpuk (compounding) kalau lagi apes beruntun, nambah lagi ke
// keterlambatan notif yang udah ada dari jeda polling itu sendiri. Sekarang
// jeda ke siklus berikutnya dikurangin sama waktu yang udah kepake siklus
// barusan, biar cadence-nya tetep ~POLL_INTERVAL_MS dari awal ke awal
// siklus, bukan POLL_INTERVAL_MS + durasi siklus.
function computeNextPollDelay(elapsedMs) {
  return Math.max(MIN_POLL_DELAY_MS, POLL_INTERVAL_MS - elapsedMs);
}

// Jalankan polling tiap ~POLL_INTERVAL_MS (self-scheduling biar nggak
// tumpang tindih kalau checkLiveMembers kebetulan lebih lambat dari
// interval-nya)
async function pollLoop() {
  const startedAt = Date.now();
  await checkLiveMembers();
  if (stopped) return; // jangan jadwalin siklus baru - shutdown lagi diminta
  pollTimeoutHandle = setTimeout(pollLoop, computeNextPollDelay(Date.now() - startedAt));
}

// Dipanggil dari src/app.js's shutdown handler. Siklus checkLiveMembers()
// yang LAGI JALAN dibiarin kelar dulu (gak dipotong paksa) - ini cuma
// nyegah siklus BERIKUTNYA dijadwalin.
function stopPolling() {
  stopped = true;
  if (pollTimeoutHandle) {
    clearTimeout(pollTimeoutHandle);
    pollTimeoutHandle = null;
  }
}

module.exports = { checkLiveMembers, pollLoop, stopPolling, computeNextPollDelay };
