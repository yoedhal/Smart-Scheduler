import { useState, useEffect, useRef, useMemo } from 'react';
import { apiPost } from '../apiClient';
import { useToast } from '../context/ToastContext.jsx';
import { Ico, SecHead, Toggle } from '../ui/Primitives.jsx';
import { initials, fairnessLabel, fairnessVar, tier } from '../lib/meetings';

const DAY_KEYS = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];

const TIMEZONES = [
  'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver',
  'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Atlantic/Reykjavik',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Helsinki',
  'Asia/Jerusalem', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  'Pacific/Auckland',
];

const STATUS_PRESETS = [
  'Focused', 'Open to connect', 'Busy', 'Travelling', 'Learning', 'Available',
];

/** Only the fields the backend's UserProfile model will accept. */
const draftFrom = (p) => ({
  displayName: p.displayName || p.name || '',
  bio: p.bio || '',
  role: p.role || '',
  department: p.department || '',
  skills: p.skills || [],
  statusMessage: p.statusMessage || p.status_message || '',
  timezone: p.timezone || 'Asia/Jerusalem',
  workingHours: p.workingHours || { start: '09:00', end: '18:00' },
  workingDays: p.workingDays || [0, 1, 2, 3, 4],
  lunchBreak: p.lunchBreak || { start: '12:00', duration: 60 },
  notificationPrefs: p.notificationPrefs || { invites: true, reminders: true, digest: false },
  showFairnessScore: p.showFairnessScore ?? true,
});

const addMins = (t, m) => {
  const [h, mm] = String(t).split(':').map(Number);
  const total = h * 60 + mm + m;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export default function SettingsView({
  profile, meetings, calendarStatus, theme, setTheme,
  onCalendarConnect, onCalendarDisconnect, onProfileUpdate, onSignOut, initialTab,
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => draftFrom(profile));
  const [saved, setSaved] = useState(() => draftFrom(profile));
  const [saving, setSaving] = useState(false);
  const [skillInput, setSkillInput] = useState('');
  const [resetting, setResetting] = useState(false);
  const [disconnectAsk, setDisconnectAsk] = useState(null);
  const calendarRef = useRef(null);

  /* Deep link from "connect your calendar" prompts. */
  useEffect(() => {
    if (initialTab === 'calendar' && calendarRef.current) {
      calendarRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [initialTab]);

  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  const score = Math.round(Number(profile?.fairness_score ?? 50));
  const details = profile?.details || {};
  const balance = Math.round(details.fairness_balance ?? 0);

  const stats = useMemo(() => ({
    total: meetings.length,
    confirmed: meetings.filter(m => m.status === 'confirmed').length,
    awaiting: meetings.filter(m => m.status === 'awaiting').length,
    organised: meetings.filter(m => m.userRole === 'organizer').length,
    invited: meetings.filter(m => m.userRole === 'participant').length,
  }), [meetings]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiPost('/api/profile/update', draft);
      if (res?.status === 'success') {
        const merged = { ...profile, ...res.profile, name: res.profile.displayName };
        onProfileUpdate?.(merged);
        const next = draftFrom(merged);
        setDraft(next);
        setSaved(next);
        toast('Settings saved.', 'success');
      } else {
        toast('Save did not go through. Try again.', 'error');
      }
    } catch (err) {
      toast(err?.message || 'Failed to save settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const resetFairness = async () => {
    setResetting(true);
    try {
      const result = await apiPost('/api/profile/fairness/reset', {});
      onProfileUpdate?.({
        ...profile,
        fairness_score: result.fairnessScore,
        details: {
          ...details,
          fairness_balance: 0,
          inconvenient_count: 0,
          convenient_count: 0,
          cancellations_last_month: 0,
          last_week_reset: new Date().toISOString(),
        },
      });
      toast('Fairness balance reset to neutral.', 'success');
    } catch (err) {
      toast(err?.message || 'Reset failed.', 'error');
    } finally {
      setResetting(false);
    }
  };

  const addSkill = () => {
    const val = skillInput.trim().replace(/,$/, '');
    if (val && !draft.skills.includes(val)) set({ skills: [...draft.skills, val] });
    setSkillInput('');
  };

  const activeDays = draft.workingDays.length;
  const google = calendarStatus?.google;
  const ics = calendarStatus?.ics;

  return (
    <div className="page fade">
      <div className="page-head">
        <div>
          <div className="eyebrow">Account</div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            Availability rules feed straight into slot scoring. Anything you block here will never
            be proposed to anyone scheduling with you.
          </p>
        </div>
        <div className="page-acts">
          <button className="btn s" onClick={onSignOut}><Ico n="logout" s={13} /> Sign out</button>
          <button className="btn p" onClick={save} disabled={!dirty || saving}>
            {saving ? <><span className="spin-sm" /> Saving…</> : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      <div className="cols" style={{ paddingTop: 30 }}>
        {/* ── left column ─────────────────────────────────────────────── */}
        <div>
          <section className="sec">
            <SecHead n="01" title="Identity" />

            <div className="f-row">
              <div className="f-lab">Avatar</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 4 }}>
                <div className="mono-av fill" style={{ width: 44, height: 44, fontSize: 13 }}>
                  {initials(draft.displayName)}
                </div>
                <div className="f-hint" style={{ margin: 0 }}>
                  Initials are taken from your display name.
                </div>
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Name</div>
              <div>
                <input
                  className="inp"
                  value={draft.displayName}
                  placeholder="Your full name"
                  onChange={e => set({ displayName: e.target.value })}
                />
                {draft.displayName && !draft.displayName.includes(' ') && /[\d.]/.test(draft.displayName) && (
                  <div className="f-hint">That looks like a username. A real name reads better to colleagues.</div>
                )}
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Email</div>
              <div className="f-val" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--ink-2)' }}>
                {profile.email}
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Role</div>
              <input
                className="inp"
                value={draft.role}
                placeholder="e.g. Lead engineer"
                onChange={e => set({ role: e.target.value })}
              />
            </div>

            <div className="f-row">
              <div className="f-lab">Department</div>
              <input
                className="inp"
                value={draft.department}
                placeholder="e.g. Platform"
                onChange={e => set({ department: e.target.value })}
              />
            </div>

            <div className="f-row">
              <div className="f-lab">Status</div>
              <div>
                <input
                  className="inp"
                  value={draft.statusMessage}
                  placeholder="What you're up to"
                  onChange={e => set({ statusMessage: e.target.value })}
                />
                <div className="chip-row" style={{ marginTop: 10 }}>
                  {STATUS_PRESETS.map(s => (
                    <button
                      key={s}
                      className={`chip pick${draft.statusMessage === s ? ' on' : ''}`}
                      onClick={() => set({ statusMessage: s })}
                    >{s}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Bio</div>
              <textarea
                className="inp"
                value={draft.bio}
                placeholder="A line or two about what you work on."
                onChange={e => set({ bio: e.target.value })}
              />
            </div>

            <div className="f-row">
              <div className="f-lab">Skills</div>
              <div>
                <div className="tagbox">
                  {draft.skills.filter(Boolean).map(s => (
                    <span key={s} className="chip">
                      {s}
                      <button onClick={() => set({ skills: draft.skills.filter(x => x !== s) })}>×</button>
                    </span>
                  ))}
                  <input
                    value={skillInput}
                    placeholder={draft.skills.length ? '' : 'React, Design…'}
                    onChange={e => setSkillInput(e.target.value)}
                    onBlur={addSkill}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill(); }
                      if (e.key === 'Backspace' && !skillInput && draft.skills.length) {
                        set({ skills: draft.skills.slice(0, -1) });
                      }
                    }}
                  />
                </div>
                <div className="f-hint">Enter or comma to add · shown on your public profile</div>
              </div>
            </div>
          </section>

          <section className="sec">
            <SecHead n="02" title="Availability" aside="feeds slot scoring" />

            <div className="f-row">
              <div className="f-lab">Time zone</div>
              <div>
                <select className="inp" value={draft.timezone} onChange={e => set({ timezone: e.target.value })}>
                  {TIMEZONES.includes(draft.timezone) ? null : <option>{draft.timezone}</option>}
                  {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
                <div className="f-hint">
                  Every candidate time is scored against each person's local hours.
                </div>
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Working days</div>
              <div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAY_KEYS.map(([label, idx]) => (
                    <button
                      key={idx}
                      className={`day-t${draft.workingDays.includes(idx) ? ' on' : ''}`}
                      title={label}
                      onClick={() => set({
                        workingDays: draft.workingDays.includes(idx)
                          ? draft.workingDays.filter(d => d !== idx)
                          : [...draft.workingDays, idx].sort((a, b) => a - b),
                      })}
                    >{label[0]}</button>
                  ))}
                </div>
                <div className="f-hint">{activeDays} of 7 days available</div>
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Working hours</div>
              <div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="time" className="inp" value={draft.workingHours.start}
                    onChange={e => set({ workingHours: { ...draft.workingHours, start: e.target.value } })}
                  />
                  <span style={{ color: 'var(--ink-3)' }}>to</span>
                  <input
                    type="time" className="inp" value={draft.workingHours.end}
                    onChange={e => set({ workingHours: { ...draft.workingHours, end: e.target.value } })}
                  />
                </div>
                <div className="f-hint">Times outside this window are never proposed</div>
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Lunch</div>
              <div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="time" className="inp" value={draft.lunchBreak.start}
                    onChange={e => set({ lunchBreak: { ...draft.lunchBreak, start: e.target.value } })}
                  />
                  <div className="seg mono">
                    {[30, 60, 90].map(d => (
                      <button
                        key={d}
                        className={draft.lunchBreak.duration === d ? 'on' : ''}
                        onClick={() => set({ lunchBreak: { ...draft.lunchBreak, duration: d } })}
                      >{d} min</button>
                    ))}
                  </div>
                </div>
                <div className="f-hint">
                  Held daily · {draft.lunchBreak.start} to {addMins(draft.lunchBreak.start, draft.lunchBreak.duration)}
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* ── right column ────────────────────────────────────────────── */}
        <div>
          <section className="sec">
            <SecHead n="03" title="Fairness" aside={fairnessLabel(score)} />
            <div className="gauge">
              <div className="gauge-n" style={{ color: fairnessVar(score) }}>{score}</div>
              <div className="gauge-b">
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {balance > 0
                    ? `+${balance}: you're owed a convenient slot`
                    : balance < 0
                      ? `${balance}: you've been getting the good slots`
                      : 'Level: neutral standing'}
                </div>
                <div className="gauge-t">
                  <i className={`f-${tier(score)}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
                </div>
                <div className="gauge-scale"><span>0</span><span>50 neutral</span><span>100</span></div>
              </div>
            </div>

            {details.inconvenient_count > 0 && (
              <div className="brk">
                <div>
                  <div className="brk-l">Off-hours meetings ×{details.inconvenient_count}</div>
                  <div className="brk-d">Weekend or awkward hours: you took the hit</div>
                </div>
                <span className="brk-v up">credit</span>
              </div>
            )}
            {details.convenient_count > 0 && (
              <div className="brk">
                <div>
                  <div className="brk-l">Prime-time meetings ×{details.convenient_count}</div>
                  <div className="brk-d">Convenient slots: someone else compromised</div>
                </div>
                <span className="brk-v dn">debit</span>
              </div>
            )}
            {details.cancellations_last_month > 0 && (
              <div className="brk">
                <div>
                  <div className="brk-l">Cancellations ×{details.cancellations_last_month}</div>
                  <div className="brk-d">Last 30 days: disrupted others' plans</div>
                </div>
                <span className="brk-v dn">−{details.cancellations_last_month * 5}</span>
              </div>
            )}
            {!details.inconvenient_count && !details.convenient_count && !details.cancellations_last_month && (
              <div className="brk">
                <div>
                  <div className="brk-l">No scored bookings yet</div>
                  <div className="brk-d">Everyone starts at 50. Balance decays 2% a day.</div>
                </div>
              </div>
            )}

            {(score < 45 || score > 80) && (
              <button
                className="btn s"
                style={{ marginTop: 14, width: '100%', justifyContent: 'center' }}
                onClick={resetFairness}
                disabled={resetting}
              >
                {resetting ? <><span className="spin-sm" /> Resetting…</> : 'Reset balance to neutral'}
              </button>
            )}

            <div className="f-hint" style={{ marginTop: 16 }}>
              {stats.total} meetings · {stats.confirmed} confirmed · {stats.awaiting} awaiting accepts ·{' '}
              {stats.organised} organised · {stats.invited} invited
            </div>
          </section>

          <section className="sec" ref={calendarRef}>
            <SecHead n="04" title="Calendars" />

            <div className="f-row wide">
              <div>
                <div className="f-name" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <i className={`dot ${google?.connected ? 'confirmed' : 'muted'}`} />
                  Google Calendar
                </div>
                <div className="f-hint">
                  {google?.connected
                    ? google.email || 'Connected'
                    : 'Reads availability and writes confirmed meetings'}
                </div>
              </div>
              {google?.connected ? (
                <button className="btn s" onClick={() => setDisconnectAsk('google')}>Disconnect</button>
              ) : (
                <button className="btn p" onClick={() => onCalendarConnect('google')}>Connect</button>
              )}
            </div>

            {ics?.connected && (
              <div className="f-row wide">
                <div>
                  <div className="f-name" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <i className="dot confirmed" />
                    Outlook (.ics feed)
                  </div>
                  <div className="f-hint">Read-only availability feed</div>
                </div>
                <button className="btn s" onClick={() => setDisconnectAsk('ics')}>Disconnect</button>
              </div>
            )}
          </section>

          <section className="sec">
            <SecHead n="05" title="Appearance" />
            <div style={{ display: 'grid', gap: 8, paddingTop: 16 }}>
              <button className={`radio-card${theme === 'light' ? ' on' : ''}`} onClick={() => setTheme('light')}>
                <div className="rc-top"><span className="rc-dot" /><span className="rc-name">Light</span></div>
                <div className="rc-desc">Warm paper. Best in daylight.</div>
              </button>
              <button className={`radio-card${theme === 'dark' ? ' on' : ''}`} onClick={() => setTheme('dark')}>
                <div className="rc-top"><span className="rc-dot" /><span className="rc-name">Dark</span></div>
                <div className="rc-desc">Ink ground with the same warmth.</div>
              </button>
            </div>
          </section>

          <section className="sec">
            <SecHead n="06" title="Notifications" />
            {[
              { k: 'invites',   n: 'Meeting invitations', d: 'When someone invites you to a meeting' },
              { k: 'reminders', n: 'Reminders',           d: 'An hour before a confirmed meeting' },
              { k: 'digest',    n: 'Weekly fairness digest', d: 'A summary of your score and activity' },
            ].map(row => (
              <div key={row.k} className="f-row wide">
                <div>
                  <div className="f-name">{row.n}</div>
                  <div className="f-hint">{row.d}</div>
                </div>
                <Toggle
                  label={row.n}
                  on={!!draft.notificationPrefs[row.k]}
                  onChange={v => set({ notificationPrefs: { ...draft.notificationPrefs, [row.k]: v } })}
                />
              </div>
            ))}
          </section>

          <section className="sec">
            <SecHead n="07" title="Privacy" />
            <div className="f-row wide">
              <div>
                <div className="f-name">Show my fairness score</div>
                <div className="f-hint">Colleagues can see it on your public profile</div>
              </div>
              <Toggle
                label="Show my fairness score"
                on={draft.showFairnessScore}
                onChange={v => set({ showFairnessScore: v })}
              />
            </div>
          </section>
        </div>
      </div>

      {disconnectAsk && (
        <div className="veil" onClick={e => e.target === e.currentTarget && setDisconnectAsk(null)}>
          <div className="mod" style={{ width: 440 }}>
            <div className="mod-h">
              <div>
                <div className="eyebrow">Calendar</div>
                <h2>Disconnect?</h2>
              </div>
              <button className="x" onClick={() => setDisconnectAsk(null)}>×</button>
            </div>
            <div className="mod-b">
              <p style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6, paddingTop: 14 }}>
                Your meetings stay put, but availability will stop syncing and new confirmations
                won't be written to this calendar.
              </p>
            </div>
            <div className="mod-f">
              <button className="btn g" onClick={() => setDisconnectAsk(null)}>Keep connected</button>
              <button
                className="btn d"
                onClick={() => { onCalendarDisconnect(disconnectAsk); setDisconnectAsk(null); }}
              >Disconnect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
