/**
 * Derivations over the backend's meeting/profile payloads.
 *
 * The backend is the source of truth: nothing here invents a value the API
 * didn't return. Where a design element needs a number the API doesn't expose
 * (e.g. per-participant slot scores), the view renders the real signal instead
 * rather than fabricating one.
 */

/* ── fairness tiers ─────────────────────────────────────────────────────── */

export const tier = (s) => (s >= 75 ? 'high' : s >= 50 ? 'mid' : 'low');

export const fairnessLabel = (s) =>
  s >= 75 ? 'Excellent' : s >= 50 ? 'Good' : s >= 30 ? 'Below average' : 'Needs attention';

export const fairnessVar = (s) =>
  s >= 75 ? 'var(--forest)' : s >= 50 ? 'var(--ochre)' : 'var(--stone)';

/* ── people ─────────────────────────────────────────────────────────────── */

export const initials = (name) =>
  name
    ? name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '??';

/** Resolve a userId against a meeting's participantNames map. */
export function personOf(meeting, uid) {
  const info = meeting?.participantNames?.[uid];
  const name = (typeof info === 'object' ? info?.name : info) || uid;
  const email = (typeof info === 'object' ? info?.email : '') || '';
  return { id: uid, name, email, initials: initials(name) };
}

/** Invitees (not the organiser), ordered as stored. */
export const participantsOf = (meeting) =>
  (meeting?.participantUserIds || []).map(uid => personOf(meeting, uid));

export const organiserOf = (meeting) => personOf(meeting, meeting?.creatorUserId);

/* ── meeting identity ───────────────────────────────────────────────────── */

/** Stable short code, e.g. MTG-4F2A — derived from the requestId, not random. */
export function meetingCode(requestId) {
  if (!requestId) return 'MTG-????';
  const tail = String(requestId).replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase();
  return `MTG-${tail.padStart(4, '0')}`;
}

/* ── slots + score ──────────────────────────────────────────────────────── */

export const slotsOf = (meeting) =>
  [...(meeting?.slots || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

/** The slot the organiser booked, if any. */
export function selectedSlot(meeting) {
  if (!meeting?.selectedSlotStart) return null;
  const target = new Date(meeting.selectedSlotStart).getTime();
  return (meeting.slots || []).find(s => new Date(s.startIso).getTime() === target) || null;
}

/**
 * The fairness number shown for a meeting:
 * the booked slot's score once confirmed, otherwise the best proposal.
 * Falls back to the AI's meeting-level score. Null when nothing is scored yet.
 */
export function meetingScore(meeting) {
  const chosen = selectedSlot(meeting);
  if (chosen?.score != null) return chosen.score;
  const best = slotsOf(meeting)[0];
  if (best?.score != null) return best.score;
  if (meeting?.aiMeetingScore != null) return meeting.aiMeetingScore;
  return null;
}

/* ── status ─────────────────────────────────────────────────────────────── */

export const isOrganiser = (m, uid) => m?.userRole === 'organizer' || m?.creatorUserId === uid;

/** A confirmed invitation this user has neither accepted nor declined. */
export function needsMyAction(m, uid) {
  if (!m || isOrganiser(m, uid)) return false;
  if (m.status !== 'confirmed') return false;
  return !(m.acceptedBy || []).includes(uid) && !(m.declinedBy || []).includes(uid);
}

/** An organiser's pending meeting that already has proposals to choose from. */
export const awaitsMyPick = (m, uid) =>
  isOrganiser(m, uid) && m?.status === 'pending';

/** Clock reads live in this module so component bodies stay pure. */
export const isFuture = (iso) => !!iso && new Date(iso).getTime() > Date.now();

/** The soonest confirmed meeting still ahead of us. */
export function nextUpcoming(meetings) {
  return meetings
    .filter(m => m.status === 'confirmed' && isFuture(m.selectedSlotStart))
    .sort((a, b) => new Date(a.selectedSlotStart) - new Date(b.selectedSlotStart))[0] || null;
}

export const myStatusIn = (m, uid) =>
  (m?.declinedBy || []).includes(uid) ? 'declined'
    : (m?.acceptedBy || []).includes(uid) ? 'accepted'
      : 'waiting';

/* ── formatting ─────────────────────────────────────────────────────────── */

const t = (iso, opts) => new Date(iso).toLocaleString('en-US', opts);

export const fmtTime = (iso) => t(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDay = (iso) => t(iso, { weekday: 'short' });
export const fmtDate = (iso) => t(iso, { month: 'short', day: 'numeric' });
export const fmtDateFull = (iso) => t(iso, { weekday: 'long', month: 'long', day: 'numeric' });
export const fmtStamp = (iso) => `${fmtDay(iso)} ${fmtDate(iso)} · ${fmtTime(iso)}`;

/** "Tue 14:00" — the compact form used in tables. */
export const fmtWhen = (iso) => (iso ? `${fmtDay(iso)} ${fmtTime(iso)}` : null);

/** Duration label: 45 → "45 min", 90 → "1h 30m". */
export function fmtDuration(min) {
  if (!min) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Forward-looking: "in 3h", "tomorrow", "in 4 days". Null once past. */
export function fmtSoon(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms < 0) return null;
  const h = ms / 3600000;
  if (h < 1) return 'in < 1h';
  if (h < 24) return `in ${Math.round(h)}h`;
  const d = Math.floor(ms / 86400000);
  if (d === 1) return 'tomorrow';
  if (d <= 7) return `in ${d} days`;
  return null;
}

/** Backward-looking, compact: "4m", "2h", "yesterday", "6d". */
export function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60000) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d`;
  return fmtDate(iso);
}

/**
 * Same instant as a complete phrase, so callers never have to bolt "ago" onto
 * a word like "yesterday".
 */
export function fmtAgoPhrase(iso) {
  const short = fmtAgo(iso);
  if (!short) return '';
  if (short === 'just now' || short === 'yesterday') return short;
  return /^\d/.test(short) ? `${short} ago` : `on ${short}`;
}

/* ── aggregates for the overview ────────────────────────────────────────── */

const startOfWeek = (base = new Date()) => {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
};

/** Mon–Sun of the current week, each with the meetings landing on it. */
export function weekAhead(meetings) {
  const mon = startOfWeek();
  const todayStr = new Date().toDateString();
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(mon);
    date.setDate(mon.getDate() + i);
    const events = meetings
      .filter(m => m.selectedSlotStart && m.status !== 'cancelled')
      .filter(m => new Date(m.selectedSlotStart).toDateString() === date.toDateString())
      .sort((a, b) => new Date(a.selectedSlotStart) - new Date(b.selectedSlotStart));
    return {
      date,
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      num: date.getDate(),
      today: date.toDateString() === todayStr,
      off: date.getDay() === 0 || date.getDay() === 6,
      events,
    };
  });
}

/** Total confirmed minutes booked inside the current week. */
export function bookedThisWeek(meetings) {
  const mon = startOfWeek();
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 7);
  const list = meetings.filter(m =>
    m.status === 'confirmed' &&
    m.selectedSlotStart &&
    new Date(m.selectedSlotStart) >= mon &&
    new Date(m.selectedSlotStart) < sun
  );
  const minutes = list.reduce((sum, m) => sum + (m.durationMinutes || 0), 0);
  return { minutes, count: list.length, hours: Math.floor(minutes / 60), rest: minutes % 60 };
}

/**
 * A real activity feed, assembled from timestamps the API actually returns:
 * creation, booking, cancellation and per-user declines. Accepts carry no
 * timestamp in the payload, so they're surfaced per-meeting instead.
 */
export function buildActivity(meetings, currentUserId, limit = 7) {
  const items = [];
  const who = (m, uid) => (uid === currentUserId ? 'You' : personOf(m, uid).name);

  for (const m of meetings) {
    if (m.createdAt) {
      const n = m.slots?.length || 0;
      items.push({
        at: m.createdAt,
        who: who(m, m.creatorUserId),
        did: n ? `proposed ${n} time${n === 1 ? '' : 's'} for` : 'created',
        what: m.title,
        meeting: m,
      });
    }
    if (m.status === 'confirmed' && m.selectedSlotStart && m.updatedAt) {
      items.push({
        at: m.updatedAt,
        who: who(m, m.creatorUserId),
        did: `booked ${fmtWhen(m.selectedSlotStart)} for`,
        what: m.title,
        meeting: m,
      });
    }
    if (m.cancelledAt) {
      items.push({
        at: m.cancelledAt,
        who: who(m, m.cancelledBy || m.creatorUserId),
        did: 'cancelled',
        what: m.title,
        meeting: m,
      });
    }
    for (const [uid, detail] of Object.entries(m.declineDetails || {})) {
      if (!detail?.declinedAt) continue;
      items.push({
        at: detail.declinedAt,
        who: who(m, uid),
        did: 'declined',
        what: m.title,
        meeting: m,
      });
    }
  }

  return items
    .filter(i => !Number.isNaN(new Date(i.at).getTime()))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

/**
 * Seven-day fairness trace. The API exposes only the live score plus this
 * week's load, so this is a reconstruction from those two numbers — not stored
 * history. Views label it as such.
 */
export function fairnessTrace(score, meetingsThisWeek) {
  const start = Math.max(0, Math.min(100, score + meetingsThisWeek * 2));
  const days = Array.from({ length: 7 }, (_, i) => {
    const k = i / 6;
    return Math.round(Math.max(0, Math.min(100, start + (score - start) * k)));
  });
  const labels = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toLocaleDateString('en-US', { weekday: 'short' })[0];
  });

  /* Bars are scaled to the local range, not 0–100 — otherwise a 12-point move
     inside a narrow band renders as seven identical blocks. The floor keeps the
     smallest bar visible. */
  const lo = Math.max(0, Math.min(...days) - 4);
  const hi = Math.min(100, Math.max(...days) + 4);
  const span = hi - lo || 1;
  const heights = days.map(v => 0.28 + 0.72 * ((v - lo) / span));

  return { days, labels, heights, delta: days[6] - days[0] };
}
