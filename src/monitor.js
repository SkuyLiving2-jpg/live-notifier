const { fetchAllLivestreams, isJkt48Member } = require("./idnApi");
const { activeLives, saveActiveLives } = require("./storage/activeLives");
const { loadDurationHistory, recordLiveDuration } = require("./storage/durationHistory");
const { recordLiveStartedToday, recordLiveEndedToday } = require("./storage/dailyLog");
const { getPriorityConfig } = require("./priority");
const { sendDiscordNotif } = require("./notify/liveNotify");
const { maybePartyModeAlert, maybeAlertEndingSoon } = require("./notify/priorityDm");
const { maybeAlertViewerMilestone, maybeAnnounceNewRecord, maybeSendDailyRecap } = require("./notify/publicAlerts");
const { POLL_INTERVAL_MS } = require("./config");

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
        const terkirim = await sendDiscordNotif(live.creator.name, live.creator.username, live.slug, "start", live.image_url);
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
          recordLiveStartedToday(
            live.creator.name,
            live.creator.username,
            live.live_at ? new Date(live.live_at) : new Date(),
            live.view_count ?? null,
          );
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
        if (typeof live.view_count === "number") {
          entry.peakViewCount = Math.max(entry.peakViewCount ?? 0, live.view_count);
        }
        await maybeAlertEndingSoon(entry, durationHistory);
        await maybeAlertViewerMilestone(entry);
      }
    }

    // Kirim notif "sudah selesai" + bersihkan cache kalau member udah selesai live
    for (const [username, memberData] of activeLives) {
      if (!currentLiveUsernames.has(username)) {
        const terkirim = await sendDiscordNotif(memberData.name, memberData.username, memberData.slug, "end", memberData.imageUrl);
        if (terkirim) {
          if (memberData.liveAt) {
            const durationMs = Date.now() - new Date(memberData.liveAt).getTime();
            await maybeAnnounceNewRecord(username, memberData.name, durationMs, durationHistory);
            recordLiveDuration(username, memberData.name, durationMs);
            recordLiveEndedToday(
              memberData.name,
              memberData.username,
              durationMs,
              new Date(),
              memberData.peakViewCount ?? memberData.viewCount ?? null,
            );
          }
          activeLives.delete(username);
          saveActiveLives();
        }
        // kalau gagal kirim, sengaja nggak dihapus dari cache
        // biar dicoba lagi di polling berikutnya
      }
    }

    await maybeSendDailyRecap();
  } catch (error) {
    console.error("Gagal ngecek IDN Live:", error.message);
  }
}

// Jalankan polling tiap 30 detik (self-scheduling biar nggak tumpang tindih
// kalau checkLiveMembers kebetulan lebih lambat dari interval-nya)
async function pollLoop() {
  await checkLiveMembers();
  setTimeout(pollLoop, POLL_INTERVAL_MS);
}

module.exports = { checkLiveMembers, pollLoop };
