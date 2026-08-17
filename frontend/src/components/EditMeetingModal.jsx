import { useState } from 'react';
import { apiPost } from '../apiClient';
import { useToast } from '../context/ToastContext.jsx';
import { Ico } from '../ui/Primitives.jsx';
import { meetingCode } from '../lib/meetings';

const RANGES = [
  { v: '3',  l: '3 days'  },
  { v: '7',  l: '1 week'  },
  { v: '14', l: '2 weeks' },
  { v: '30', l: '1 month' },
];

const WINDOWS = [
  { v: 'all',       l: 'Any time',   hours: [] },
  { v: 'morning',   l: 'Morning',    hours: [8, 9, 10, 11] },
  { v: 'afternoon', l: 'Afternoon',  hours: [12, 13, 14, 15, 16] },
  { v: 'evening',   l: 'Evening',    hours: [17, 18, 19, 20] },
];

const DAY_KEYS = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];

/** Derive the wizard's range preset from what the meeting actually stores. */
function initialRange(meeting) {
  const days = meeting.daysForward
    ?? Math.max(1, Math.round((new Date(meeting.dateRangeEnd) - new Date(meeting.dateRangeStart)) / 864e5));
  return RANGES.some(r => r.v === String(days)) ? String(days) : 'custom';
}

function initialWindow(meeting) {
  const first = meeting.preferredHours?.[0];
  if (first == null) return 'all';
  return first <= 11 ? 'morning' : first <= 16 ? 'afternoon' : 'evening';
}

export default function EditMeetingModal({ meeting, onClose, onSaved }) {
  const toast = useToast();
  const [title, setTitle] = useState(meeting.title || '');
  const [description, setDescription] = useState(meeting.description || '');
  const [duration, setDuration] = useState(meeting.durationMinutes || 60);
  const [range, setRange] = useState(() => initialRange(meeting));
  const [customDays, setCustomDays] = useState(() => meeting.daysForward || 14);
  const [window_, setWindow] = useState(() => initialWindow(meeting));
  const [excluded, setExcluded] = useState(() => meeting.excludedWeekdays || []);
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const daysForward = range === 'custom'
        ? Math.max(1, Math.min(90, Number(customDays) || 7))
        : parseInt(range, 10);
      const result = await apiPost(`/api/meetings/${meeting.requestId}/edit`, {
        title: title.trim(),
        description,
        durationMinutes: Number(duration),
        daysForward,
        preferredHours: WINDOWS.find(w => w.v === window_)?.hours ?? [],
        excludedWeekdays: excluded,
      });
      toast(
        result?.slotsRegenerated ? 'Updated — new times generated.'
          : result?.reopened ? 'Re-opened — participants must accept again.'
            : 'Changes saved. Regenerate to get new times.',
        'success',
      );
      await onSaved?.();
    } catch (err) {
      toast(err.message || 'Could not save changes.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="veil" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="mod" style={{ width: 600 }} onSubmit={save}>
        <div className="mod-h">
          <div>
            <div className="eyebrow">{meetingCode(meeting.requestId)} · editing</div>
            <h2>Meeting details</h2>
          </div>
          <button type="button" className="x" onClick={onClose}>×</button>
        </div>

        <div className="mod-b">
          <div className="f-row">
            <div className="f-lab">Title</div>
            <input
              className="inp" autoFocus maxLength={200} value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>

          <div className="f-row">
            <div className="f-lab">Duration</div>
            <div className="seg mono" style={{ marginTop: 4 }}>
              {[15, 30, 45, 60, 90].map(d => (
                <button key={d} type="button" className={duration === d ? 'on' : ''} onClick={() => setDuration(d)}>
                  {d < 60 ? `${d}m` : d === 60 ? '1h' : '1.5h'}
                </button>
              ))}
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Search range</div>
            <div>
              <div className="seg mono">
                {[...RANGES, { v: 'custom', l: 'Custom' }].map(r => (
                  <button key={r.v} type="button" className={range === r.v ? 'on' : ''} onClick={() => setRange(r.v)}>
                    {r.l}
                  </button>
                ))}
              </div>
              {range === 'custom' && (
                <input
                  type="number" min={1} max={90} className="inp" style={{ marginTop: 10 }}
                  value={customDays}
                  onChange={e => setCustomDays(Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 1)))}
                />
              )}
              <div className="f-hint">Changing the range or duration regenerates the proposed times.</div>
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Time of day</div>
            <div className="seg mono" style={{ marginTop: 4 }}>
              {WINDOWS.map(w => (
                <button key={w.v} type="button" className={window_ === w.v ? 'on' : ''} onClick={() => setWindow(w.v)}>
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
                    key={idx} type="button" title={label}
                    className={`day-t${excluded.includes(idx) ? ' off' : ''}`}
                    onClick={() => setExcluded(x => x.includes(idx) ? x.filter(d => d !== idx) : [...x, idx])}
                  >{label[0]}</button>
                ))}
              </div>
              <div className="f-hint">Struck-through days are never proposed for this meeting.</div>
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Agenda</div>
            <textarea
              className="inp" maxLength={2000} value={description}
              placeholder="What will you discuss?"
              onChange={e => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="mod-f">
          <button type="button" className="btn g" onClick={onClose}>Cancel</button>
          <button className="btn p" type="submit" disabled={saving || !title.trim()}>
            {saving ? <><span className="spin-sm" /> Saving…</> : <>Save changes <Ico n="arrow" s={13} /></>}
          </button>
        </div>
      </form>
    </div>
  );
}
