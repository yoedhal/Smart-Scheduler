import { useState, useMemo } from 'react';
import { Ico, Stack, Score } from '../ui/Primitives.jsx';
import {
  meetingCode, meetingScore, participantsOf, organiserOf,
  fmtWhen, fmtDuration, needsMyAction, awaitsMyPick, isOrganiser, myStatusIn, isFuture,
} from '../lib/meetings';

const FILTERS = [
  { id: 'all',       label: 'All'       },
  { id: 'needs',     label: 'Needs you' },
  { id: 'pending',   label: 'Pending'   },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'cancelled', label: 'Cancelled' },
];

export default function MeetingsView({
  meetings, currentUserId, needsAction,
  isCalendarConnected, onConnectCalendar, onNewMeeting, onOpenMeeting,
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    let out = meetings;

    if (filter === 'needs') {
      out = out.filter(m => needsMyAction(m, currentUserId) || awaitsMyPick(m, currentUserId));
    } else if (filter === 'cancelled') {
      out = out.filter(m => m.status === 'cancelled');
    } else if (filter === 'all') {
      out = out.filter(m => m.status !== 'cancelled');
    } else {
      out = out.filter(m => m.status === filter);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter(m =>
        m.title?.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q) ||
        meetingCode(m.requestId).toLowerCase().includes(q)
      );
    }

    // Things that need a decision float up; then upcoming by time; then newest.
    const rank = (m) => {
      if (needsMyAction(m, currentUserId) || awaitsMyPick(m, currentUserId)) return 0;
      if (m.status === 'confirmed' && isFuture(m.selectedSlotStart)) return 1;
      if (m.status === 'cancelled') return 3;
      return 2;
    };
    return [...out].sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      const at = a.selectedSlotStart ? new Date(a.selectedSlotStart).getTime() : Infinity;
      const bt = b.selectedSlotStart ? new Date(b.selectedSlotStart).getTime() : Infinity;
      if (at !== bt) return at - bt;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }, [meetings, filter, query, currentUserId]);

  const counts = useMemo(() => ({
    all: meetings.filter(m => m.status !== 'cancelled').length,
    needs: meetings.filter(m => needsMyAction(m, currentUserId) || awaitsMyPick(m, currentUserId)).length,
    pending: meetings.filter(m => m.status === 'pending').length,
    confirmed: meetings.filter(m => m.status === 'confirmed').length,
    cancelled: meetings.filter(m => m.status === 'cancelled').length,
  }), [meetings, currentUserId]);

  /** What this row is waiting on, from this user's point of view. */
  const rowState = (m) => {
    if (m.status === 'cancelled') return { cls: 'cancelled', label: 'cancelled' };
    if (needsMyAction(m, currentUserId)) return { cls: 'pending', label: 'accept?', act: true };
    if (awaitsMyPick(m, currentUserId)) {
      return m.slots?.length
        ? { cls: 'pending', label: 'pick a time', act: true }
        : { cls: 'pending', label: 'no slots', act: true };
    }
    if (m.status === 'pending') return { cls: 'pending', label: 'pending' };
    const mine = myStatusIn(m, currentUserId);
    if (!isOrganiser(m, currentUserId) && mine === 'declined') return { cls: 'declined', label: 'you declined' };
    return { cls: 'confirmed', label: 'confirmed' };
  };

  return (
    <div className="page fade">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 className="page-title">Meetings</h1>
          <p className="page-sub">
            Every request you organise or take part in, ranked by the fairness of the chosen time.
          </p>
        </div>
        <div className="page-acts">
          <button className="btn p" onClick={onNewMeeting}>
            <Ico n="plus" s={13} /> New meeting
          </button>
        </div>
      </div>

      {!isCalendarConnected && (
        <div className="callout sig click" style={{ marginTop: 22 }} onClick={onConnectCalendar}>
          <div className="eyebrow">Calendar not connected</div>
          <p>Connect Google Calendar to create meetings or accept invitations. <b>Open settings →</b></p>
        </div>
      )}

      {needsAction > 0 && filter !== 'needs' && (
        <div className="callout click" style={{ marginTop: 22 }} onClick={() => setFilter('needs')}>
          <div className="eyebrow">Awaiting your response</div>
          <p>
            {needsAction} confirmed meeting{needsAction > 1 ? 's are' : ' is'} waiting on your accept
            or decline. <b>Show them →</b>
          </p>
        </div>
      )}

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '22px 0 8px', gap: 16, flexWrap: 'wrap',
      }}>
        <div className="seg">
          {FILTERS.map(f => (
            <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}{counts[f.id] > 0 && ` ${counts[f.id]}`}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            className="inp"
            style={{ width: 210 }}
            placeholder="Filter by title…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <span className="eyebrow">{list.length} shown</span>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          {query ? `Nothing matches “${query}”.` : 'Nothing here.'}
        </div>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '36%' }}>Meeting</th>
                <th>Fairness</th><th>People</th><th>Duration</th><th>When</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map(m => {
                const state = rowState(m);
                const org = organiserOf(m);
                return (
                  <tr
                    key={m.requestId}
                    onClick={() => onOpenMeeting(m)}
                    className={m.status === 'cancelled' ? 'dim' : undefined}
                  >
                    <td>
                      <div className="t-title">{m.title}</div>
                      <div className="t-sub">
                        {meetingCode(m.requestId)} ·{' '}
                        {isOrganiser(m, currentUserId) ? 'you organise' : `by ${org.name}`}
                      </div>
                    </td>
                    <td><Score v={meetingScore(m)} /></td>
                    <td><Stack people={participantsOf(m)} max={4} /></td>
                    <td><span className="t-when">{fmtDuration(m.durationMinutes)}</span></td>
                    <td>
                      <span className="t-when">
                        {m.selectedSlotStart
                          ? fmtWhen(m.selectedSlotStart)
                          : m.slots?.length ? `${m.slots.length} proposed` : '—'}
                      </span>
                    </td>
                    <td>
                      <span className={`st${state.act ? ' act' : ''}`}>
                        <i className={`dot ${state.cls}`} />{state.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
