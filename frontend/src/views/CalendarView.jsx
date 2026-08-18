import { useState, useEffect, useRef, useMemo } from 'react';
import { apiGet, apiRegisterCalendarWatch, apiCheckCalendarSync } from '../apiClient';
import { useToast } from '../context/ToastContext.jsx';
import { Ico } from '../ui/Primitives.jsx';
import { fmtTime, fmtDuration, meetingCode, statusLabel } from '../lib/meetings';

const HOUR_START = 7;
const HOUR_END = 22;
const ROW = 46;                       // px per hour — matches .cal-cell
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
const hasTime = (iso) => iso && iso.includes('T');

const startOfWeek = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow) + offset * 7);
  return d;
};

export default function CalendarView({
  meetings, calendarStatus, onOpenMeeting, onCreateAt, onConnectCalendar,
}) {
  const toast = useToast();
  const [mode, setMode] = useState(() => (window.innerWidth < 760 ? 'day' : 'week'));
  const [offset, setOffset] = useState(0);
  const [extEvents, setExtEvents] = useState([]);
  const [popover, setPopover] = useState(null);   // { ev, x, y }
  const [webhookActive, setWebhookActive] = useState(false);
  const offsetRef = useRef(offset);
  const lastChangeToken = useRef(null);
  const tokenErrorShown = useRef(false);

  const googleConnected = calendarStatus?.google?.connected;
  const icsConnected = calendarStatus?.ics?.connected;
  const anyConnected = googleConnected || icsConnected;

  useEffect(() => { offsetRef.current = offset; }, [offset]);
  useEffect(() => { setOffset(0); }, [mode]);

  /* ── visible days ─────────────────────────────────────────────────────── */
  const days = useMemo(() => {
    const todayStr = new Date().toDateString();
    if (mode === 'day') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + offset);
      return [{ date: d, today: d.toDateString() === todayStr }];
    }
    const mon = startOfWeek(offset);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return { date: d, today: d.toDateString() === todayStr };
    });
  }, [mode, offset]);

  const rangeLabel = useMemo(() => {
    if (days.length === 1) {
      return days[0].date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' })
      .formatRange(days[0].date, days[days.length - 1].date);
  }, [days]);

  /* ── external calendar events ─────────────────────────────────────────── */
  const fetchExternal = async (viewOffset) => {
    const first = mode === 'day'
      ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + viewOffset); return d; })()
      : startOfWeek(viewOffset);
    const last = new Date(first);
    last.setDate(first.getDate() + (mode === 'day' ? 1 : 7));
    try {
      const data = await apiGet(
        `/api/calendar/events?timeMin=${encodeURIComponent(first.toISOString())}&timeMax=${encodeURIComponent(last.toISOString())}`,
      );
      setExtEvents(Array.isArray(data) ? data : []);
    } catch {
      setExtEvents([]);
      if (googleConnected && !tokenErrorShown.current) {
        tokenErrorShown.current = true;
        toast('Could not sync Google Calendar — your token may have expired. Reconnect it in Settings.', 'warning');
      }
    }
  };

  /* Fetch on mount / navigation / connection change. With Google push
     notifications live, poll the cheap change token and only re-fetch when it
     moves; otherwise fall back to an unconditional 60s refresh. */
  useEffect(() => {
    if (!anyConnected) { setExtEvents([]); return; }
    fetchExternal(offset);

    if (webhookActive) {
      apiCheckCalendarSync()
        .then(r => { lastChangeToken.current = r?.changeToken ?? null; })
        .catch(() => {});
      const id = setInterval(async () => {
        try {
          const { changeToken } = await apiCheckCalendarSync();
          if (changeToken !== lastChangeToken.current) {
            lastChangeToken.current = changeToken;
            fetchExternal(offsetRef.current);
          }
        } catch { /* transient — next tick retries */ }
      }, 10_000);
      return () => clearInterval(id);
    }

    const id = setInterval(() => fetchExternal(offsetRef.current), 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, mode, anyConnected, webhookActive]);

  useEffect(() => {
    if (!anyConnected) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchExternal(offsetRef.current);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyConnected]);

  useEffect(() => { tokenErrorShown.current = false; }, [googleConnected]);

  /* Register a Google push channel; degrades quietly when unconfigured. */
  useEffect(() => {
    if (!googleConnected) { setWebhookActive(false); return; }
    apiRegisterCalendarWatch()
      .then(res => setWebhookActive(res?.status === 'registered' || res?.status === 'active'))
      .catch(() => setWebhookActive(false));
  }, [googleConnected]);

  useEffect(() => {
    const close = () => setPopover(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, []);

  /* ── laid-out events per day ──────────────────────────────────────────── */
  const scheduled = useMemo(
    () => meetings.filter(m => m.selectedSlotStart && m.status !== 'cancelled'),
    [meetings],
  );

  /* Meetings written through to Google shouldn't render twice. */
  const mirroredIds = useMemo(() => {
    const set = new Set();
    for (const m of scheduled) {
      for (const val of Object.values(m.externalEventIds || {})) {
        if (typeof val === 'string' && val.startsWith('google:')) set.add(val.slice(7));
      }
    }
    return set;
  }, [scheduled]);

  const allDayFor = (date) =>
    extEvents.filter(ev => {
      if (hasTime(ev.start)) return false;
      const s = new Date(ev.start + 'T00:00:00');
      const e = ev.end ? new Date(ev.end + 'T00:00:00') : new Date(s.getTime() + 864e5);
      return s <= date && e > date;
    });

  const eventsFor = (date) => {
    const dayStr = date.toDateString();

    const own = scheduled
      .filter(m => new Date(m.selectedSlotStart).toDateString() === dayStr)
      .map(m => {
        const start = new Date(m.selectedSlotStart);
        const s = start.getHours() + start.getMinutes() / 60;
        return {
          key: m.requestId,
          kind: m.status,
          startH: s,
          endH: s + (m.durationMinutes || 60) / 60,
          title: m.title,
          meta: fmtTime(m.selectedSlotStart),
          meeting: m,
        };
      });

    const ext = extEvents
      .filter(ev => hasTime(ev.start))
      .filter(ev => !mirroredIds.has(ev.id))
      .filter(ev => new Date(ev.start).toDateString() === dayStr)
      .map(ev => {
        const start = new Date(ev.start);
        const end = ev.end && hasTime(ev.end) ? new Date(ev.end) : new Date(start.getTime() + 36e5);
        const s = start.getHours() + start.getMinutes() / 60;
        const e = end.getHours() + end.getMinutes() / 60;
        return {
          key: `ext-${ev.id || ev.start}-${ev.summary}`,
          kind: 'external',
          startH: s,
          endH: e <= s ? HOUR_END : e,
          title: ev.summary || 'Busy',
          meta: ev.source === 'ics' ? 'Outlook' : 'Google',
          location: ev.location || '',
          link: ev.htmlLink || '',
        };
      });

    const raw = [...own, ...ext]
      .map(e => ({
        ...e,
        top: (Math.max(e.startH, HOUR_START) - HOUR_START) * ROW,
        height: (Math.min(e.endH, HOUR_END) - Math.max(e.startH, HOUR_START)) * ROW - 2,
      }))
      .filter(e => e.height > 0);

    // Side-by-side columns for overlapping blocks
    return raw.map((e, i) => {
      const cluster = raw.filter(o => e.startH < o.endH && o.startH < e.endH);
      const total = cluster.length;
      const idx = cluster.indexOf(raw[i]);
      return { ...e, col: idx < 0 ? 0 : idx, cols: total || 1 };
    });
  };

  /* ── now indicator ────────────────────────────────────────────────────── */
  const now = new Date();
  const nowH = now.getHours() + now.getMinutes() / 60;
  const showNow = nowH >= HOUR_START && nowH <= HOUR_END;

  const hasAllDay = days.some(d => allDayFor(d.date).length > 0);
  const anythingInView = days.some(d => eventsFor(d.date).length > 0) || hasAllDay;

  const jumpToday = () => setOffset(0);

  return (
    <div className="page fade">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {rangeLabel} · {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-sub">
            Confirmed and proposed meetings alongside the events on your connected calendar.
            {onCreateAt && ' Click any empty slot to start a new meeting there.'}
          </p>
        </div>
        <div className="page-acts">
          <div className="seg mono">
            {['day', 'week'].map(v => (
              <button key={v} className={mode === v ? 'on' : ''} onClick={() => setMode(v)}>
                {v}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={() => setOffset(o => o - 1)} title="Previous">
            <Ico n="prev" s={15} />
          </button>
          <button className="btn s" onClick={jumpToday}>Today</button>
          <button className="icon-btn" onClick={() => setOffset(o => o + 1)} title="Next">
            <Ico n="next" s={15} />
          </button>
        </div>
      </div>

      {!anyConnected && (
        <div className="callout sig click" style={{ marginTop: 22 }} onClick={onConnectCalendar}>
          <div className="eyebrow">Showing Smart Scheduler only</div>
          <p>
            Connect Google Calendar to see your existing commitments here and let slot scoring
            account for them. <b>Open settings →</b>
          </p>
        </div>
      )}

      <div className="cal">
        <div className="cal-scroll">
          {hasAllDay && (
            <div className="cal-allday" style={{ '--cal-cols': days.length }}>
              <div className="cal-allday-cell" style={{ background: 'transparent' }}>
                <span className="eyebrow">All day</span>
              </div>
              {days.map(d => (
                <div key={d.date.toISOString()} className="cal-allday-cell">
                  {allDayFor(d.date).map(ev => (
                    <div key={`${ev.id || ev.start}-${ev.summary}`} className="cal-allday-chip" title={ev.summary}>
                      {ev.summary || 'All day'}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="cal-grid" style={{ '--cal-cols': days.length }}>
            <div className="cal-gutter" />
            {days.map(d => (
              <div key={d.date.toISOString()} className={`cal-hd${d.today ? ' today' : ''}`}>
                <span>{d.date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                <span className="cal-hd-n">{d.date.getDate()} {d.date.toLocaleDateString('en-US', { month: 'short' })}</span>
              </div>
            ))}

            <div className="cal-times">
              {HOURS.map(h => (
                <div key={h} className="cal-time">{String(h).padStart(2, '0')}:00</div>
              ))}
            </div>

            {days.map(d => (
              <div
                key={d.date.toISOString()}
                className={`cal-col${d.today ? ' today' : ''}`}
                style={{ cursor: onCreateAt ? 'crosshair' : undefined }}
                onClick={(e) => {
                  if (!onCreateAt || e.target.closest('.ev')) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = (e.clientY - rect.top) / ROW + HOUR_START;
                  const snapped = Math.floor(frac * 2) / 2;
                  const dt = new Date(d.date);
                  dt.setHours(Math.floor(snapped), Math.round((snapped % 1) * 60), 0, 0);
                  onCreateAt(dt.toISOString());
                }}
              >
                {HOURS.map(h => <div key={h} className="cal-cell" />)}

                {showNow && d.today && (
                  <div className="cal-now" style={{ top: (nowH - HOUR_START) * ROW }} />
                )}

                {eventsFor(d.date).map(ev => {
                  const w = 100 / ev.cols;
                  return (
                    <button
                      key={ev.key}
                      className={`ev ${ev.kind}`}
                      style={{
                        top: ev.top,
                        height: ev.height,
                        left: `calc(${ev.col * w}% + 4px)`,
                        width: `calc(${w}% - 8px)`,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setPopover(p => p?.ev.key === ev.key ? null : {
                          ev,
                          x: Math.min(r.left, window.innerWidth - 300),
                          y: Math.min(r.bottom + 8, window.innerHeight - 220),
                        });
                      }}
                    >
                      <div className="ev-t">{ev.title}</div>
                      {ev.height > 28 && <div className="ev-m">{ev.meta}</div>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {!anythingInView && (
        <div className="empty">
          Nothing scheduled in this view. Use the arrows to look around
          {onCreateAt && ', or click a slot to book something'}.
        </div>
      )}

      {popover && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 69 }} onClick={() => setPopover(null)} />
          <div className="pop" style={{ left: popover.x, top: popover.y }}>
            <div className="eyebrow">
              {popover.ev.meeting
                ? `${meetingCode(popover.ev.meeting.requestId)} · ${statusLabel(popover.ev.meeting)}`
                : `From ${popover.ev.meta}`}
            </div>
            <h4>{popover.ev.title}</h4>
            <div className="pop-m">
              {String(Math.floor(popover.ev.startH)).padStart(2, '0')}:
              {String(Math.round((popover.ev.startH % 1) * 60)).padStart(2, '0')}
              {popover.ev.meeting && ` · ${fmtDuration(popover.ev.meeting.durationMinutes)}`}
            </div>
            {popover.ev.location && <div className="pop-m">{popover.ev.location}</div>}
            <div className="pop-acts">
              {popover.ev.meeting ? (
                <button
                  className="btn p sm"
                  onClick={() => { onOpenMeeting(popover.ev.meeting); setPopover(null); }}
                >
                  Open meeting <Ico n="arrow" s={12} />
                </button>
              ) : popover.ev.link ? (
                <a
                  className="btn s sm"
                  href={popover.ev.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderBottom: '1px solid var(--rule-2)' }}
                >
                  <Ico n="link" s={12} /> Open in calendar
                </a>
              ) : (
                <span className="eyebrow">External event</span>
              )}
              <button className="btn g sm" onClick={() => setPopover(null)}>Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
