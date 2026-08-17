import { useState, useMemo } from 'react';
import { useToast } from '../context/ToastContext.jsx';
import { Ico, Count, Stack, Score, SecHead } from '../ui/Primitives.jsx';
import {
  meetingCode, meetingScore, participantsOf, fmtWhen, fmtDuration, fmtAgo, fmtAgoPhrase,
  weekAhead, bookedThisWeek, buildActivity, fairnessTrace, fairnessLabel,
  needsMyAction, awaitsMyPick, nextUpcoming,
} from '../lib/meetings';

const EXAMPLES = [
  'Book 45 min with the design team next Tuesday',
  'Quick 15 min standup tomorrow morning',
  'Hour-long planning review next week, skip Friday',
];

/** Plain-language meeting composer → parse_meeting_nl → pre-filled Create. */
function Composer({ onParsed }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (text) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onParsed(text);
      setQ('');
    } catch (e) {
      setErr(e?.message || 'Could not read that — try naming who and roughly when.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <form className="composer-in" onSubmit={e => { e.preventDefault(); run(q); }}>
        <span className="composer-ico"><Ico n="spark" s={16} /></span>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Describe a meeting — “45 min with Dana and Tom next Tuesday”"
          disabled={busy}
          aria-label="Describe a meeting in plain words"
        />
        <button className="btn p" type="submit" disabled={busy || !q.trim()}>
          {busy ? <><span className="spin-sm" /> Reading…</> : <>Draft <Ico n="arrow" s={13} /></>}
        </button>
      </form>
      <div className="composer-foot">
        {err
          ? <span className="composer-err">{err}</span>
          : <>
              <span className="eyebrow">Try</span>
              {EXAMPLES.map(x => (
                <button key={x} className="composer-eg" disabled={busy} onClick={() => { setQ(x); run(x); }}>
                  {x}
                </button>
              ))}
            </>}
      </div>
    </div>
  );
}

export default function OverviewView({
  profile, meetings, needsAction, pendingPicks,
  isCalendarConnected, onConnectCalendar,
  onNewMeeting, onNewMeetingFromText, onOpenMeeting, onNavigate,
}) {
  const toast = useToast();

  const score = Number.isFinite(Number(profile?.fairness_score))
    ? Math.round(Number(profile.fairness_score))
    : 50;
  const thisWeekCount = profile?.details?.meetings_this_week ?? 0;
  const balance = Math.round(profile?.details?.fairness_balance ?? 0);

  const active = useMemo(() => meetings.filter(m => m.status !== 'cancelled'), [meetings]);
  const confirmed = useMemo(() => active.filter(m => m.status === 'confirmed'), [active]);
  const recent = useMemo(
    () => [...active].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5),
    [active],
  );
  const week = useMemo(() => weekAhead(meetings), [meetings]);
  const booked = useMemo(() => bookedThisWeek(meetings), [meetings]);
  const feed = useMemo(() => buildActivity(meetings, profile?.id), [meetings, profile?.id]);
  const trace = useMemo(() => fairnessTrace(score, thisWeekCount), [score, thisWeekCount]);

  const nextUp = useMemo(() => nextUpcoming(confirmed), [confirmed]);

  const oldestOpen = useMemo(() => {
    const open = active.filter(m => needsMyAction(m, profile?.id) || awaitsMyPick(m, profile?.id));
    if (!open.length) return null;
    return open.reduce((a, b) => (new Date(a.createdAt || 0) < new Date(b.createdAt || 0) ? a : b));
  }, [active, profile?.id]);

  const firstName = (profile?.name || profile?.displayName || 'there').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const todo = needsAction + pendingPicks;

  const handleComposed = async (text) => {
    try {
      await onNewMeetingFromText(text);
    } catch (e) {
      throw new Error(e?.message || 'The AI parser is unavailable right now.');
    }
  };

  return (
    <div className="page fade">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1 className="page-title">{greeting}, {firstName}</h1>
          <p className="page-sub">
            {todo > 0
              ? `${todo} meeting${todo > 1 ? 's need' : ' needs'} a decision from you. Your fairness score sits at ${score} — ${fairnessLabel(score).toLowerCase()}.`
              : `Nothing is waiting on you. Your fairness score sits at ${score} — ${fairnessLabel(score).toLowerCase()}.`}
          </p>
        </div>
        <div className="page-acts">
          {todo > 0 && (
            <button className="btn s" onClick={() => onNavigate('meetings')}>Review pending</button>
          )}
          <button className="btn p" onClick={onNewMeeting}>
            <Ico n="plus" s={13} /> New meeting
          </button>
        </div>
      </div>

      {!isCalendarConnected && (
        <div className="callout sig click" style={{ marginTop: 22 }} onClick={onConnectCalendar}>
          <div className="eyebrow">Calendar not connected</div>
          <p>
            Slot scoring reads your availability from Google Calendar. Connect it in Settings to
            create meetings and approve invitations. <b>Open calendar settings →</b>
          </p>
        </div>
      )}

      <Composer onParsed={handleComposed} />

      <div className="strip">
        <div className="metric click" onClick={() => onNavigate('profile')}>
          <div className="eyebrow">Fairness score</div>
          <div className="metric-v">
            <Count to={score} />
            <span className="metric-d">
              {balance === 0
                ? <>level</>
                : <span className={balance > 0 ? 'up' : 'dn'}>{balance > 0 ? '▲' : '▼'} {Math.abs(balance)}</span>}
            </span>
          </div>
          <div className="metric-note">
            {balance > 0
              ? "In credit — you're owed a convenient slot."
              : balance < 0
                ? "In debt — you've had the good slots lately."
                : 'Neutral standing. 50 is the resting point.'}
          </div>
        </div>

        <div className="metric click" onClick={() => onNavigate('meetings')}>
          <div className="eyebrow">Awaiting you</div>
          <div className="metric-v"><Count to={todo} /></div>
          <div className="metric-note">
            {oldestOpen
              ? `Oldest opened ${fmtAgoPhrase(oldestOpen.createdAt)}.`
              : 'Nothing needs a decision.'}
          </div>
        </div>

        <div className="metric click" onClick={() => onNavigate('calendar')}>
          <div className="eyebrow">Confirmed</div>
          <div className="metric-v"><Count to={confirmed.length} /></div>
          <div className="metric-note">
            {nextUp ? `Next is ${fmtWhen(nextUp.selectedSlotStart)}.` : 'Nothing on the books yet.'}
          </div>
        </div>

        <div className="metric">
          <div className="eyebrow">Booked this week</div>
          <div className="metric-v">
            {booked.hours}
            <span className="metric-d">h {booked.rest}m</span>
          </div>
          <div className="metric-note">
            Across {booked.count} meeting{booked.count === 1 ? '' : 's'}.
          </div>
        </div>
      </div>

      <div className="cols">
        <div>
          <section className="sec">
            <SecHead n="01" title="Meetings" aside={`${active.length} active`} />
            {recent.length === 0 ? (
              <div className="empty">No meetings yet — describe one above, or hit New meeting.</div>
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: '42%' }}>Meeting</th>
                      <th>Fairness</th><th>People</th><th>When</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map(m => (
                      <tr key={m.requestId} onClick={() => onOpenMeeting(m)}>
                        <td>
                          <div className="t-title">{m.title}</div>
                          <div className="t-sub">
                            {meetingCode(m.requestId)} · {fmtDuration(m.durationMinutes)} · {m.userRole}
                          </div>
                        </td>
                        <td><Score v={meetingScore(m)} /></td>
                        <td><Stack people={participantsOf(m)} max={4} /></td>
                        <td>
                          <span className="t-when">
                            {m.selectedSlotStart
                              ? fmtWhen(m.selectedSlotStart)
                              : m.slots?.length ? `${m.slots.length} slots` : '—'}
                          </span>
                        </td>
                        <td><span className="st"><i className={`dot ${m.status}`} />{m.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="sec">
            <SecHead
              n="02"
              title="Week ahead"
              aside={`${week[0].date.getDate()} — ${week[6].date.getDate()} ${week[6].date.toLocaleDateString('en-US', { month: 'short' })}`}
            />
            <div className="week">
              {week.map(d => (
                <div key={d.label} className={`wd${d.today ? ' today' : ''}${d.off ? ' off' : ''}`}>
                  <div className="eyebrow">{d.label}</div>
                  <div className="wd-n">{d.num}</div>
                  {d.events.slice(0, 3).map(m => (
                    <button
                      key={m.requestId}
                      className={`wd-e ${m.status === 'confirmed' ? 'c' : 'p'}`}
                      onClick={() => onOpenMeeting(m)}
                      title={m.title}
                    >
                      {m.title} {fmtWhen(m.selectedSlotStart)?.split(' ')[1]}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div>
          <section className="sec">
            <SecHead n="03" title="Fairness" aside="7 days" />
            <div className="chart">
              {trace.days.map((v, i) => (
                <div key={i} className={`chart-c${i === 6 ? ' now' : ''}`} title={`${trace.labels[i]}: ${v}`}>
                  <div className="chart-b" style={{ height: `${trace.heights[i] * 72}px` }} />
                  <div className="chart-l">{trace.labels[i]}</div>
                </div>
              ))}
            </div>
            <p className="chart-note">
              {profile?.details?.inconvenient_count > 0 || profile?.details?.convenient_count > 0 ? (
                <>
                  {profile.details.inconvenient_count > 0 && (
                    <>Taking {profile.details.inconvenient_count} off-hours slot
                      {profile.details.inconvenient_count > 1 ? 's' : ''} built credit. </>
                  )}
                  {profile.details.convenient_count > 0 && (
                    <>{profile.details.convenient_count} prime-time slot
                      {profile.details.convenient_count > 1 ? 's' : ''} spent it back. </>
                  )}
                  Balance decays 2% a day, so old history fades.
                </>
              ) : (
                <>No scored bookings yet. Everyone starts at 50 — accept an awkward slot and the
                  balance moves in your favour.</>
              )}
              {' '}Curve reconstructed from your current balance, not stored history.
            </p>
          </section>

          <section className="sec">
            <SecHead n="04" title="Activity" />
            {feed.length === 0 ? (
              <div className="empty">Nothing has happened yet.</div>
            ) : feed.map((f, i) => (
              <div key={i} className="feed">
                <div><b>{f.who}</b> {f.did} <em>{f.what}</em></div>
                <div className="feed-t">{fmtAgo(f.at)}</div>
              </div>
            ))}
          </section>

          {profile?.email && (
            <section className="sec">
              <SecHead n="05" title="Invite" />
              <p className="chart-note" style={{ marginTop: 14 }}>
                Colleagues appear in People once they sign up. Share the workspace link so they can
                be scheduled with.
              </p>
              <button
                className="btn s"
                style={{ marginTop: 14 }}
                onClick={() => {
                  navigator.clipboard
                    .writeText(`Join me on Smart Scheduler — fair meeting scheduling: ${window.location.origin}`)
                    .then(() => toast('Invite link copied.', 'success'))
                    .catch(() => toast('Could not copy the link.', 'error'));
                }}
              >
                <Ico n="copy" s={13} /> Copy invite link
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
