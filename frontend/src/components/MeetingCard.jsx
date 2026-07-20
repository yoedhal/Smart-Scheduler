import { useState, useEffect, useMemo } from 'react';
import { apiGet } from '../apiClient';
import { Pencil, Trash2, RefreshCw, Ban, CalendarDays } from 'lucide-react';
import DeclineBadge from './DeclineBadge.jsx';
import SlotCalendar from './SlotCalendar.jsx';
import SlotList from './SlotList.jsx';
import { fmtRelative, getInitials } from './meetingDashboardUtils.js';

/* ─────────────────────────────────────────────
   MeetingCard sub-component
───────────────────────────────────────────── */
export default function MeetingCard({
  meeting, currentUserId, isExpanded, onToggle, onAccept, onDecline, onBook,
  onEdit, onCancel, onReschedule, busyId, style,
  fmtDate, fmtTime, fmtFull,
  customPicker = {}, onCustomPickerChange, onScoreCustom, onBookCustom,
  onParticipantClick, isCalendarConnected,
  allMeetings = [],
}) {
  const [slotView, setSlotView] = useState('calendar');
  const [calEvents, setCalEvents] = useState(null);
  const [conflictWarning, setConflictWarning] = useState(null); // { slot, existingMeeting }
  const isOrganizer    = meeting.userRole === 'organizer';
  const isConfirmed    = meeting.status === 'confirmed';
  const hasSlots       = Array.isArray(meeting.slots) && meeting.slots.length > 0;
  const userAccepted   = (meeting.acceptedBy || []).includes(currentUserId);
  const userDeclined   = (meeting.declinedBy || []).includes(currentUserId);
  const needsAccept    = !isOrganizer && isConfirmed && !userAccepted && !userDeclined;
  const participantCount = (meeting.participantUserIds || []).length;
  const participantNames = meeting.participantNames || {};

  // Fetch calendar events once when the slot panel first expands.
  // Use actual slot dates (not stale dateRangeStart/End from meeting creation).
  useEffect(() => {
    if (!isExpanded || !isOrganizer || isConfirmed || calEvents !== null) return;
    const slots = meeting.slots;
    if (!slots || slots.length === 0) { setCalEvents([]); return; }
    const starts = slots.map(s => new Date(s.startIso).getTime()).filter(t => !isNaN(t));
    const ends   = slots.map(s => new Date(s.endIso || s.startIso).getTime()).filter(t => !isNaN(t));
    if (!starts.length) { setCalEvents([]); return; }
    const timeMin = new Date(Math.min(...starts)).toISOString();
    const timeMax = new Date(Math.max(...ends) + 3600000).toISOString(); // +1hr buffer
    apiGet(`/api/calendar/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`)
      .then(data => setCalEvents(Array.isArray(data) ? data : []))
      .catch(() => setCalEvents([]));
  }, [isExpanded, isOrganizer, isConfirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Confirmed Smart Scheduler meetings (other than this one) to overlay on the slot calendar
  const ssMeetings = useMemo(() => {
    return (allMeetings || [])
      .filter(m =>
        m.status === 'confirmed' &&
        m.requestId !== meeting.requestId &&
        m.selectedSlotStart
      )
      .map(m => ({
        summary: m.title,
        start: m.selectedSlotStart,
        end: new Date(
          new Date(m.selectedSlotStart).getTime() + (m.durationMinutes || 60) * 60000
        ).toISOString(),
      }));
  }, [allMeetings, meeting.requestId]);

  // Filter out proposed slots that conflict with already-confirmed SS meetings.
  // Slots were generated at meeting-creation time; by now some times may be taken.
  const visibleSlots = useMemo(() => {
    if (!meeting.slots?.length) return [];
    if (!ssMeetings.length) return meeting.slots;
    const dur = (meeting.durationMinutes || 60) * 60000;
    return meeting.slots.filter(slot => {
      const sStart = new Date(slot.startIso).getTime();
      const sEnd = new Date(slot.endIso).getTime() || (sStart + dur);
      return !ssMeetings.some(m => {
        const mStart = new Date(m.start).getTime();
        const mEnd = new Date(m.end).getTime();
        return sStart < mEnd && sEnd > mStart;
      });
    });
  }, [meeting.slots, ssMeetings, meeting.durationMinutes]);

  const handleSlotSelect = (slot) => {
    const slotStart = new Date(slot.startIso).getTime();
    const slotEnd   = new Date(slot.endIso || slot.startIso).getTime() || (slotStart + (meeting.durationMinutes || 60) * 60000);
    const conflict  = ssMeetings.find(m => {
      const mStart = new Date(m.start).getTime();
      const mEnd   = new Date(m.end).getTime();
      return slotStart < mEnd && slotEnd > mStart;
    });
    if (conflict) {
      setConflictWarning({ slot, existingMeeting: conflict });
    } else {
      onBook(meeting.requestId, slot);
    }
  };

  // Avatar stack for header
  const topParticipants = (meeting.participantUserIds || []).slice(0, 3);
  const overflowCount   = Math.max(0, (meeting.participantUserIds || []).length - 3);

  return (
    <div className={`mc ${meeting.userRole} ${isConfirmed ? 'confirmed' : 'pending'} ${needsAccept ? 'needs-action' : ''}`} style={style}>

      {/* Card header — always visible */}
      <div className="mc-head" onClick={onToggle}>
        <div className="mc-left">
          <div className="mc-title-row">
            <span className="mc-status-dot" />
            <span className="mc-title">{meeting.title}</span>
            <span className={`mc-role-badge ${meeting.userRole}`}>
              {isOrganizer ? 'Organizer' : 'Invited'}
            </span>
          </div>
          <div className="mc-meta">
            <span>⏱ {meeting.durationMinutes}m</span>
            {!isOrganizer && (
              <span className="mc-organizer">
                👤 {participantNames[meeting.creatorUserId]?.name || 'Unknown'}
              </span>
            )}
            {participantCount > 0 && (
              <div className="participant-avatars">
                {topParticipants.map(pid => {
                  const nameInfo = participantNames[pid];
                  return (
                    <div key={pid} className="p-avatar-chip" title={nameInfo?.name || pid}>
                      {getInitials(nameInfo?.name || '')}
                    </div>
                  );
                })}
                {overflowCount > 0 && <div className="p-avatar-overflow">+{overflowCount}</div>}
              </div>
            )}
            {isConfirmed && meeting.selectedSlotStart && (() => {
              const rel = fmtRelative(meeting.selectedSlotStart);
              return (
                <span className="mc-confirmed-time">
                  <CalendarDays size={12} style={{ verticalAlign: 'middle', marginRight: '0.3rem' }} />
                  {fmtFull(meeting.selectedSlotStart)}
                  {rel && <span style={{ marginLeft: '0.4rem', color: '#22c55e', fontWeight: 600 }}>{rel}</span>}
                </span>
              );
            })()}
            {isOrganizer && isConfirmed && (meeting.participantUserIds || []).length > 0 && (
              <span className="mc-slots-hint">
                {(meeting.acceptedBy || []).length}/{(meeting.participantUserIds || []).length} participants accepted
              </span>
            )}
            {!isConfirmed && hasSlots && isOrganizer && (
              <span className="mc-slots-hint">{visibleSlots.length} slots available — pick one</span>
            )}
          </div>
        </div>

        <div className="mc-right">
          {/* Accept / Decline buttons for participant */}
          {needsAccept && (
            <>
              <button
                className="btn-accept"
                onClick={e => { e.stopPropagation(); onAccept(); }}
                disabled={busyId === meeting.requestId || !isCalendarConnected}
                title={!isCalendarConnected ? 'Connect Google Calendar to approve meetings' : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', ...(!isCalendarConnected ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
              >
                {busyId === meeting.requestId ? <><span className="btn-spinner" />Accepting…</> : '✓ Accept'}
              </button>
              {onDecline && (
                <button
                  className="btn-action-sm btn-action-danger"
                  title="Decline meeting"
                  onClick={e => { e.stopPropagation(); onDecline(); }}
                >
                  <Ban size={13} />
                </button>
              )}
            </>
          )}
          {!isOrganizer && isConfirmed && userAccepted && (
            <span className="badge-accepted">✓ Accepted</span>
          )}
          {!isOrganizer && userDeclined && (
            <span className="badge-declined">✗ Declined</span>
          )}

          {/* Organizer action buttons */}
          {isOrganizer && onEdit && (
            <button
              className="btn-action-sm"
              title="Edit meeting"
              onClick={e => { e.stopPropagation(); onEdit(); }}
            >
              <Pencil size={13} />
            </button>
          )}
          {isOrganizer && onReschedule && (
            <button
              className="btn-action-sm"
              title="Reschedule (regenerate slots)"
              onClick={e => { e.stopPropagation(); onReschedule(); }}
            >
              <RefreshCw size={13} />
            </button>
          )}
          {isOrganizer && onCancel && (
            <button
              className="btn-action-sm btn-action-danger"
              title="Cancel meeting"
              onClick={e => { e.stopPropagation(); onCancel(); }}
            >
              <Trash2 size={13} />
            </button>
          )}

          {isOrganizer && (meeting.declinedBy || []).length > 0 && (
            <DeclineBadge meeting={meeting} onParticipantClick={onParticipantClick} />
          )}

          <span className={`status-chip ${isConfirmed ? 'confirmed' : 'pending'}`}>
            {isConfirmed ? 'Confirmed' : 'Pending'}
          </span>

          {/* Expand arrow */}
          {isOrganizer && (
            <span className="expand-arrow">{isExpanded ? '▲' : '▼'}</span>
          )}
        </div>
      </div>

      {/* Slot selection panel — organizer, pending, expanded, not in-flight */}
      {isExpanded && isOrganizer && !isConfirmed && busyId !== meeting.requestId && (
        <div className="mc-panel slots-panel">
          {/* AI's choice — slot recommendation + reasoning */}
          {meeting.aiMethod === 'ai' && meeting.aiBestSlotReason && (
            <div style={{
              border: '1px solid #8b5cf644',
              background: 'linear-gradient(135deg, #8b5cf60d, #8b5cf604)',
              borderRadius: '10px',
              padding: '0.65rem 0.9rem',
              marginBottom: '0.75rem',
            }}>
              <div style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: '#8b5cf6',
                marginBottom: '0.3rem',
              }}>
                🧠 AI's choice
                {meeting.aiBestSlotIso && (() => {
                  const d = new Date(meeting.aiBestSlotIso);
                  return isNaN(d) ? '' : ` — ${d.toLocaleString('en-US', {
                    weekday: 'short', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}`;
                })()}
              </div>
              <p style={{
                margin: 0,
                fontSize: '0.8rem',
                lineHeight: 1.5,
                color: 'var(--text-secondary)',
              }}>
                {meeting.aiBestSlotReason}
              </p>
            </div>
          )}

          {/* Empty-state when slot generation produced no slots */}
          {!hasSlots && (
            <div style={{
              border: '1px solid rgba(245,158,11,0.3)',
              background: 'rgba(245,158,11,0.06)',
              borderRadius: '10px',
              padding: '0.9rem 1rem',
              marginBottom: '0.9rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.6rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>⚠️</span>
                <strong style={{ fontSize: '0.88rem' }}>No AI slots available yet</strong>
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Slot generation hasn't completed for this meeting. Click <strong>Regenerate</strong> to
                run the scheduler again, or pick a custom time below.
              </div>
              {onReschedule && (
                <button
                  className="btn-score"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={onReschedule}
                >
                  <RefreshCw size={12} style={{ verticalAlign: 'middle', marginRight: '0.3rem' }} />
                  Regenerate slots
                </button>
              )}
            </div>
          )}

          {/* AI-generated slots */}
          {hasSlots && (
            <>
              <div className="slots-view-header">
                <span className="panel-title" style={{ margin: 0 }}>AI-Optimised Time Slots — click to confirm</span>
                <div className="slot-view-toggle">
                  <button className={slotView === 'calendar' ? 'svt-btn active' : 'svt-btn'} onClick={() => setSlotView('calendar')}>📅 Calendar</button>
                  <button className={slotView === 'list' ? 'svt-btn active' : 'svt-btn'} onClick={() => setSlotView('list')}>☰ List</button>
                </div>
              </div>
              {hasSlots && visibleSlots.length === 0 && (
                <div style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px', padding: '0.6rem 0.8rem', marginBottom: '0.5rem', fontSize: '0.82rem', color: '#fca5a5' }}>
                  ⚠️ All proposed slots conflict with your existing meetings. Use the custom time picker below to choose a different time.
                </div>
              )}
              {conflictWarning && (
                <div style={{ background: '#7f1d1d22', border: '1px solid #ef4444', borderRadius: '6px', padding: '0.6rem 0.8rem', marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                  <span style={{ color: '#fca5a5' }}>
                    ⚠️ This slot overlaps with <strong>{conflictWarning.existingMeeting.summary}</strong>. Book anyway?
                  </span>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                    <button onClick={() => { onBook(meeting.requestId, conflictWarning.slot); setConflictWarning(null); }}
                      style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: '4px', padding: '0.25rem 0.6rem', cursor: 'pointer', fontSize: '0.75rem' }}>
                      Book anyway
                    </button>
                    <button onClick={() => setConflictWarning(null)}
                      style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: '4px', padding: '0.25rem 0.6rem', cursor: 'pointer', fontSize: '0.75rem' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {slotView === 'calendar' ? (
                <SlotCalendar
                  slots={visibleSlots}
                  preferredHours={meeting.preferredHours}
                  calEvents={calEvents}
                  ssMeetings={ssMeetings}
                  onBook={handleSlotSelect}
                />
              ) : (
                <SlotList
                  slots={visibleSlots}
                  calEvents={calEvents}
                  ssMeetings={ssMeetings}
                  onBook={handleSlotSelect}
                />
              )}
            </>
          )}

          {/* Custom time picker */}
          {onCustomPickerChange && (
            <div className="custom-picker">
              <div className="custom-picker-title">🕐 Or pick a custom time</div>
              <div className="custom-picker-row">
                <input
                  type="datetime-local"
                  className="custom-datetime-input"
                  value={customPicker.datetime || ''}
                  onChange={e => onCustomPickerChange({ datetime: e.target.value, scored: null })}
                />
                <button
                  className="btn-score"
                  disabled={!customPicker.datetime || customPicker.scoring}
                  onClick={onScoreCustom}
                >
                  {customPicker.scoring ? '⏳ Scoring…' : '📊 Calculate Fairness'}
                </button>
              </div>

              {customPicker.scored && (
                <div className="custom-scored">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <div className="slot-score-row" style={{ flex: 1 }}>
                      <span className="slot-score-label">Fairness</span>
                      <div className="slot-score-track">
                        <div
                          className="slot-score-fill"
                          style={{ width: `${Math.min(100, Math.round(customPicker.scored.score))}%` }}
                        />
                      </div>
                      <span className="slot-score-val">{Math.round(customPicker.scored.score)}%</span>
                    </div>
                    {customPicker.scored.aiScored && (
                      <span title="Scored by AI" style={{ marginLeft: '0.5rem', fontSize: '0.62rem', fontWeight: 700, color: '#8b5cf6', background: '#8b5cf61a', border: '1px solid #8b5cf644', borderRadius: '10px', padding: '0.1rem 0.4rem' }}>
                        🧠 AI
                      </span>
                    )}
                  </div>
                  <div className="slot-explain" style={{ marginBottom: customPicker.scored.aiSuggestions ? '0.4rem' : '0.75rem' }}>
                    "{customPicker.scored.explanation}"
                  </div>
                  {customPicker.scored.aiSuggestions && (
                    <div className="slot-explain" style={{ marginBottom: '0.75rem', color: '#8b5cf6', fontStyle: 'normal' }}>
                      💡 {customPicker.scored.aiSuggestions}
                    </div>
                  )}
                  <button className="btn-book-custom" onClick={onBookCustom}>
                    ✅ Book This Time
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {/* Participant acceptance panel — organizer, confirmed, expanded */}
      {isExpanded && isOrganizer && isConfirmed && (
        <div className="mc-panel accept-panel">
          {meeting.description && (
            <div className="mc-description">
              <strong>📋 Agenda:</strong> {meeting.description}
            </div>
          )}
          <div className="panel-title">👥 Participant Status</div>
          <div className="participant-list">
            <div className="participant-row">
              <span className="p-dot accepted" />
              <span className="p-name">You (Organizer)</span>
              <span className="p-status confirmed">✓ Organized</span>
            </div>
            {(meeting.participantUserIds || []).map(pid => {
              const accepted  = (meeting.acceptedBy || []).includes(pid);
              const declined  = (meeting.declinedBy || []).includes(pid);
              const nameInfo  = participantNames[pid];
              const display   = nameInfo?.name || pid;
              const statusClass = accepted ? 'confirmed' : declined ? 'declined' : 'pending';
              const statusLabel = accepted ? '✓ Accepted' : declined ? '✗ Declined' : '⏳ Pending';
              return (
                <div
                  key={pid}
                  className="participant-row clickable"
                  onClick={(e) => { e.stopPropagation(); onParticipantClick?.(pid); }}
                >
                  <div className="p-avatar-sm" title={nameInfo?.email || pid}>
                    {getInitials(display)}
                  </div>
                  <span className="p-name" title={nameInfo?.email || pid}>{display}</span>
                  <span className={`p-status ${statusClass}`}>{statusLabel}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Info panel — participant, pending (meeting not yet booked) */}
      {isExpanded && !isOrganizer && !isConfirmed && (
        <div className="mc-panel info-panel">
          {meeting.description && (
            <div className="mc-description">
              <strong>📋 Agenda:</strong> {meeting.description}
            </div>
          )}
          <p>The organizer is still selecting a time slot. You'll be notified once a time is confirmed.</p>
        </div>
      )}

      {/* Info panel — participant, confirmed */}
      {isExpanded && !isOrganizer && isConfirmed && (
        <div className="mc-panel info-panel">
          {meeting.description && (
            <div className="mc-description">
              <strong>📋 Agenda:</strong> {meeting.description}
            </div>
          )}
          {meeting.selectedSlotStart && (
            <p><CalendarDays size={13} style={{ verticalAlign: 'middle', marginRight: '0.3rem' }} />Scheduled for: <strong>{fmtFull(meeting.selectedSlotStart)}</strong></p>
          )}
        </div>
      )}
    </div>
  );
}
