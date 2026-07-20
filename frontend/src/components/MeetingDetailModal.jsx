import { useEffect } from 'react';
import { X } from 'lucide-react';
import DetailRow from './meetingDetail/DetailRow.jsx';
import ParticipantList from './meetingDetail/ParticipantList.jsx';
import AiAnalysisPanel from './meetingDetail/AiAnalysisPanel.jsx';
import ActionBtn from './meetingDetail/ActionBtn.jsx';

/* ─────────────────────────────────────────────
   MeetingDetailModal
   A reusable modal showing meeting details + actions.
   Used from CalendarView and MeetingDashboard.

   Props:
     meeting        – meeting object
     currentUserId  – authenticated user's id
     onClose        – fn()
     onAccept       – fn(requestId)
     onDecline      – fn(requestId)
     onCancel       – fn(requestId)
     onReschedule   – fn(requestId)
     onBook         – fn(requestId, slotStart)
     onEdit         – fn(meeting)
───────────────────────────────────────────── */
export default function MeetingDetailModal({
  meeting,
  currentUserId,
  onClose,
  onAccept,
  onDecline,
  onCancel,
  onReschedule,
  onEdit,
}) {
  /* Close on Escape — must be before early return (Rules of Hooks) */
  useEffect(() => {
    if (!meeting) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [meeting, onClose]);

  if (!meeting) return null;

  const isOrganizer   = meeting.userRole === 'organizer' || meeting.creatorUserId === currentUserId;
  const isParticipant = !isOrganizer;
  const hasAccepted   = (meeting.acceptedBy || []).includes(currentUserId);
  const hasDeclined   = (meeting.declinedBy || []).includes(currentUserId);

  /* Format date/time */
  const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  };
  const formatTime = (iso) => {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const statusColor = {
    confirmed: { bg: 'rgba(52,211,153,0.12)', color: '#34d399', label: 'Confirmed' },
    pending:   { bg: 'rgba(251,191,36,0.12)', color: '#fbbf24', label: 'Pending'   },
    cancelled: { bg: 'rgba(248,113,113,0.12)', color: '#f87171', label: 'Cancelled' },
  }[meeting.status] || { bg: 'rgba(107,122,148,0.12)', color: '#6b7a94', label: meeting.status };

  return (
    <div
      className="mdm-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'var(--bg-overlay)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
        animation: 'fadeIn 0.15s ease',
      }}
    >
      <div
        className="mdm-card"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-modal)',
          width: '100%',
          maxWidth: '540px',
          maxHeight: '90vh',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          padding: '1.5rem 1.5rem 1rem',
          borderBottom: '1px solid var(--border)',
          gap: '1rem',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem', wordBreak: 'break-word' }}>
              {meeting.title}
            </h2>
            <span style={{
              display: 'inline-block',
              padding: '0.2rem 0.6rem',
              borderRadius: '20px',
              fontSize: '0.7rem',
              fontWeight: 700,
              background: statusColor.bg,
              color: statusColor.color,
            }}>
              {statusColor.label}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-raised)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              width: '30px', height: '30px',
              borderRadius: '50%',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.9rem',
              flexShrink: 0,
              transition: 'all var(--transition)',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
            aria-label="Close"
          ><X size={14} /></button>
        </div>

        {/* Body */}
        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Time block */}
          {meeting.selectedSlotStart && (
            <DetailRow label="When">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                  {formatDate(meeting.selectedSlotStart)}
                </span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  {formatTime(meeting.selectedSlotStart)} · {meeting.durationMinutes} min
                </span>
              </div>
            </DetailRow>
          )}

          {/* Duration (if no slot yet) */}
          {!meeting.selectedSlotStart && (
            <DetailRow label="Duration">
              <span style={{ color: 'var(--text-secondary)' }}>{meeting.durationMinutes} minutes</span>
            </DetailRow>
          )}

          {/* Role */}
          <DetailRow label="Your role">
            <span style={{
              display: 'inline-block',
              padding: '0.2rem 0.6rem',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
              fontWeight: 600,
              background: isOrganizer ? 'rgba(56,189,248,0.12)' : 'rgba(167,139,250,0.12)',
              color: isOrganizer ? 'var(--accent)' : 'var(--purple)',
            }}>
              {isOrganizer ? 'Organizer' : 'Participant'}
            </span>
          </DetailRow>

          {/* Participants */}
          {Object.keys(meeting.participantNames || {}).length > 0 && (
            <DetailRow label="Participants">
              <ParticipantList
                participants={Object.entries(meeting.participantNames ?? {}).map(([uid, info]) => ({
                  userId: uid,
                  name: (typeof info === 'object' ? info.name : info) || uid,
                  email: typeof info === 'object' ? (info.email || '') : '',
                }))}
                acceptedBy={meeting.acceptedBy || []}
                currentUserId={currentUserId}
              />
            </DetailRow>
          )}

          {/* Description */}
          {meeting.description && (
            <DetailRow label="Description">
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.84rem', lineHeight: 1.6 }}>
                {meeting.description}
              </p>
            </DetailRow>
          )}

          {/* Fairness score */}
          {meeting.selectedSlotScore != null && (
            <DetailRow label="Slot score">
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {Math.round(meeting.selectedSlotScore)} / 100
              </span>
            </DetailRow>
          )}

          {/* Scoring verdict — AI when available, engine baseline otherwise */}
          {meeting.status !== 'cancelled' && meeting.aiMethod === 'ai' && (
            <DetailRow label={meeting.aiMethod === 'ai' ? 'AI analysis' : 'Scoring'}>
              <AiAnalysisPanel
                analysis={{
                  method: meeting.aiMethod,
                  model: meeting.aiModel || '',
                  summary: meeting.aiSummary || '',
                  bestSlot: meeting.aiBestSlotIso || '',
                  bestSlotReason: meeting.aiBestSlotReason || '',
                  calendarSuggestions: meeting.aiCalendarSuggestions || [],
                  meetingFairnessScore: meeting.aiMeetingScore || 0,
                }}
                selectedSlotStart={meeting.selectedSlotStart}
              />
            </DetailRow>
          )}

          {/* ICS download */}
          {meeting.icsUrl && (
            <DetailRow label="Calendar">
              <a
                href={meeting.icsUrl}
                download
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.3rem 0.7rem',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--accent-dim)',
                  color: 'var(--accent)',
                  fontSize: '0.78rem',
                  fontWeight: 500,
                  textDecoration: 'none',
                  transition: 'all var(--transition)',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(56,189,248,0.2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--accent-dim)'}
              >
                Download .ics
              </a>
            </DetailRow>
          )}
        </div>

        {/* Action footer */}
        {meeting.status !== 'cancelled' && (
          <div style={{
            padding: '1rem 1.5rem 1.25rem',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: '0.6rem',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}>
            {/* Participant actions */}
            {isParticipant && meeting.status === 'confirmed' && !hasAccepted && !hasDeclined && (
              <>
                <ActionBtn
                  label="Accept"
                  color="var(--success)"
                  bg="rgba(52,211,153,0.12)"
                  border="rgba(52,211,153,0.25)"
                  onClick={() => { onAccept?.(meeting.requestId); onClose(); }}
                />
                <ActionBtn
                  label="Decline"
                  color="var(--danger)"
                  bg="rgba(248,113,113,0.1)"
                  border="rgba(248,113,113,0.25)"
                  onClick={() => { onDecline?.(meeting.requestId); onClose(); }}
                />
              </>
            )}
            {isParticipant && meeting.status === 'confirmed' && hasAccepted && (
              <span style={{ fontSize: '0.8rem', color: 'var(--success)', alignSelf: 'center' }}>
                You accepted this meeting
              </span>
            )}
            {isParticipant && meeting.status === 'confirmed' && hasDeclined && (
              <span style={{ fontSize: '0.8rem', color: 'var(--danger)', alignSelf: 'center' }}>
                You declined this meeting
              </span>
            )}

            {/* Organizer actions */}
            {isOrganizer && meeting.status === 'confirmed' && (
              <>
                {onEdit && (
                  <ActionBtn label="Edit" onClick={() => { onEdit(meeting); onClose(); }} />
                )}
                {onReschedule && (
                  <ActionBtn label="Reschedule" onClick={() => { onReschedule(meeting.requestId); onClose(); }} />
                )}
                <ActionBtn
                  label="Cancel"
                  color="var(--danger)"
                  bg="rgba(248,113,113,0.1)"
                  border="rgba(248,113,113,0.25)"
                  onClick={() => { onCancel?.(meeting.requestId); onClose(); }}
                />
              </>
            )}
            {isOrganizer && meeting.status === 'pending' && (
              <ActionBtn
                label="Cancel"
                color="var(--danger)"
                bg="rgba(248,113,113,0.1)"
                border="rgba(248,113,113,0.25)"
                onClick={() => { onCancel?.(meeting.requestId); onClose(); }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
