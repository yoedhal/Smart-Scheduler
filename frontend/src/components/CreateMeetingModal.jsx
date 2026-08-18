import { useState, useEffect, useMemo, useRef } from 'react';
import { apiGet } from '../apiClient';
import { useToast } from '../context/ToastContext.jsx';
import { Ico } from '../ui/Primitives.jsx';
import { fmtDate, fmtDay, fmtTime, fmtDuration, initials } from '../lib/meetings';

const RANGES = [
  { v: '3',  l: '3 days'  },
  { v: '7',  l: '1 week'  },
  { v: '14', l: '2 weeks' },
  { v: '30', l: '1 month' },
];

const WINDOWS = [
  { v: 'all',       l: 'Any time',  hours: null },
  { v: 'morning',   l: 'Morning',   hours: [8, 9, 10, 11] },
  { v: 'afternoon', l: 'Afternoon', hours: [12, 13, 14, 15, 16] },
  { v: 'evening',   l: 'Evening',   hours: [17, 18, 19, 20] },
];

const DAY_KEYS = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];

const windowForHour = (h) => (h <= 11 ? 'morning' : h <= 16 ? 'afternoon' : 'evening');

/**
 * Single-step creation: describe the meeting, hit "Find times", and go.
 *
 * Slot generation and AI scoring both happen inside `create_meeting`, which can
 * take several seconds, so the modal hands the payload to `onSubmit` and closes
 * at once rather than holding the organiser on a spinner. The caller runs the
 * request and drops them on Meetings, where the ranked times show up on the new
 * meeting as soon as the backend answers.
 */
export default function CreateMeetingModal({
  prefill, users = [], currentUserId, onClose, onSubmit,
}) {
  const toast = useToast();
  const [directory, setDirectory] = useState(users);
  const applied = useRef(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState(45);
  const [picked, setPicked] = useState([]);      // user objects
  const [range, setRange] = useState('7');
  const [customDays, setCustomDays] = useState(14);
  const [startDate, setStartDate] = useState('');
  const [window_, setWindow] = useState('all');
  const [excluded, setExcluded] = useState([]);
  const [query, setQuery] = useState('');
  const [drafted, setDrafted] = useState(false);
  const [seedTime, setSeedTime] = useState(null);

  const today = new Date().toISOString().slice(0, 10);

  /* The directory usually arrives with the app; fetch only if it hasn't. */
  useEffect(() => {
    if (users.length) { setDirectory(users); return; }
    apiGet('/api/users')
      .then(data => setDirectory(Array.isArray(data) ? data : []))
      .catch(() => toast('Could not load the user directory.', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users]);

  /* Apply prefill once the directory is available so participants can resolve. */
  useEffect(() => {
    if (applied.current || !prefill) return;
    applied.current = true;

    if (typeof prefill === 'string') {
      const match = directory.find(u => u.email === prefill || u.userId === prefill);
      if (match) setPicked([match]);
      return;
    }

    if (prefill.datetime) {
      const dt = new Date(prefill.datetime);
      setStartDate(dt.toISOString().slice(0, 10));
      setRange('3');
      setWindow(windowForHour(dt.getHours()));
      setSeedTime(dt);
      return;
    }

    const p = prefill.parsed;
    if (!p) return;
    setDrafted(true);
    if (p.title) setTitle(p.title);
    if (p.description) setDescription(p.description);
    if (p.durationMinutes) setDuration(p.durationMinutes);
    if (p.dateRangeStart) { setStartDate(p.dateRangeStart); setRange('custom'); setCustomDays(p.daysForward || 7); }
    else if (p.daysForward) {
      const s = String(p.daysForward);
      if (RANGES.some(r => r.v === s)) setRange(s);
      else { setRange('custom'); setCustomDays(p.daysForward); }
    }
    if (WINDOWS.some(w => w.v === p.timeWindow)) setWindow(p.timeWindow);
    if (Array.isArray(p.excludedWeekdays) && p.excludedWeekdays.length) {
      setExcluded([...new Set(p.excludedWeekdays.map(Number).filter(d => d >= 0 && d <= 6))]);
    }
    if (Array.isArray(p.participants) && p.participants.length) {
      const resolved = p.participants
        .map(pp => directory.find(u => u.userId === pp.userId || u.email === pp.email) || pp)
        .filter(Boolean);
      setPicked(resolved);
    }
  }, [prefill, directory]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return directory
      .filter(u => (u.userId || u.id) !== currentUserId)
      .filter(u => !picked.some(p => (p.userId || p.id) === (u.userId || u.id)))
      .filter(u =>
        (u.displayName || u.name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, directory, picked, currentUserId]);

  const daysForward = range === 'custom'
    ? Math.max(1, Math.min(90, Number(customDays) || 7))
    : parseInt(range, 10);
  const preferredHours = WINDOWS.find(w => w.v === window_)?.hours;

  const nameOf = (u) => u.displayName || u.name || u.email;

  /* Fire and forget: the caller owns the request from here, so the organiser is
     never held on a spinner while the scheduler and the AI reviewer run. */
  const create = () => {
    if (!title.trim() || picked.length === 0) return;
    onSubmit({
      title: title.trim(),
      description,
      durationMinutes: Number(duration),
      participantIds: picked.map(u => u.userId || u.id).filter(Boolean),
      participantEmails: picked.map(u => u.email).filter(Boolean),
      daysForward,
      ...(startDate ? { dateRangeStart: startDate } : {}),
      ...(preferredHours ? { preferredHours } : {}),
      ...(excluded.length ? { excludedWeekdays: excluded } : {}),
    });
  };

  const canContinue = title.trim().length > 0 && picked.length > 0;

  return (
    <div className="veil" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mod" style={{ width: 600 }}>
        <div className="mod-h">
          <div>
            <div className="eyebrow">
              Details{drafted ? ' · drafted from your words' : ''}
            </div>
            <h2>New meeting</h2>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <div className="mod-b">
          {seedTime && (
            <div className="callout sig" style={{ marginTop: 14 }}>
              <div className="eyebrow">Starting from your calendar click</div>
              <p>
                Searching around {fmtDay(seedTime)} {fmtDate(seedTime)}, {fmtTime(seedTime)}.
                The scheduler still ranks every viable time in the range.
              </p>
            </div>
          )}

          <div className="f-row">
            <div className="f-lab">Title</div>
            <input
              className="inp" autoFocus maxLength={200} value={title}
              placeholder="Q3 roadmap review"
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
            />
          </div>

          <div className="f-row">
            <div className="f-lab">Duration</div>
            <div className="seg mono" style={{ marginTop: 4 }}>
              {[15, 30, 45, 60, 90].map(d => (
                <button key={d} className={duration === d ? 'on' : ''} onClick={() => setDuration(d)}>
                  {d < 60 ? `${d}m` : d === 60 ? '1h' : '1.5h'}
                </button>
              ))}
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Participants</div>
            <div>
              {picked.length > 0 && (
                <div className="chip-row" style={{ marginBottom: 10 }}>
                  {picked.map(u => (
                    <span key={u.userId || u.id || u.email} className="chip">
                      <span className="mono-av" style={{ width: 20, height: 20, fontSize: 8 }}>
                        {initials(nameOf(u))}
                      </span>
                      {nameOf(u)}
                      <button onClick={() => setPicked(picked.filter(p => p !== u))}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <input
                className="inp"
                placeholder="Search colleagues by name or email…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (matches[0]) { setPicked([...picked, matches[0]]); setQuery(''); }
                }}
              />
              {query.trim() && (
                <div className="plist">
                  {matches.length === 0 ? (
                    <div className="f-hint">No registered colleague matches “{query}”.</div>
                  ) : matches.map(u => (
                    <button
                      key={u.userId || u.id}
                      className="prow"
                      onClick={() => { setPicked([...picked, u]); setQuery(''); }}
                    >
                      <div className="mono-av">{initials(nameOf(u))}</div>
                      <span className="prow-n">{nameOf(u)}</span>
                      <span className="prow-s">{u.email}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="f-hint">
                {picked.length
                  ? `${picked.length} invitee${picked.length > 1 ? 's' : ''} — their calendars and fairness balances are read when ranking times`
                  : 'Pick at least one person to schedule with'}
              </div>
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Search range</div>
            <div>
              <div className="seg mono">
                {[...RANGES, { v: 'custom', l: 'Custom' }].map(r => (
                  <button key={r.v} className={range === r.v ? 'on' : ''} onClick={() => setRange(r.v)}>
                    {r.l}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="date" className="inp" min={today} value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                />
                {range === 'custom' && (
                  <input
                    type="number" min={1} max={90} className="inp" value={customDays}
                    onChange={e => setCustomDays(Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 1)))}
                  />
                )}
              </div>
              <div className="f-hint">
                Searching {daysForward} day{daysForward > 1 ? 's' : ''}
                {startDate ? ` from ${fmtDate(`${startDate}T12:00:00`)}` : ' from today'}
              </div>
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Time of day</div>
            <div className="seg mono" style={{ marginTop: 4 }}>
              {WINDOWS.map(w => (
                <button key={w.v} className={window_ === w.v ? 'on' : ''} onClick={() => setWindow(w.v)}>
                  {w.l}
                </button>
              ))}
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Skip days</div>
            <div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {DAY_KEYS.map(([label, idx]) => (
                  <button
                    key={idx} title={label}
                    className={`day-t${excluded.includes(idx) ? ' off' : ''}`}
                    onClick={() => setExcluded(x => x.includes(idx) ? x.filter(d => d !== idx) : [...x, idx])}
                  >{label[0]}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Agenda</div>
            <textarea
              className="inp" maxLength={2000} value={description}
              placeholder="What will you discuss? Any context or links…"
              onChange={e => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="mod-f">
          <span className="eyebrow">
            {picked.length} calendar{picked.length === 1 ? '' : 's'} · {fmtDuration(duration)}
          </span>
          <div className="mod-f-r">
            <button className="btn s" onClick={onClose}>Cancel</button>
            <button className="btn p" onClick={create} disabled={!canContinue}>
              Find times <Ico n="arrow" s={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
