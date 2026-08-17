import { useState, useEffect, useMemo } from 'react';
import { apiPost, apiScoreSlot } from '../apiClient';
import { useToast } from '../context/ToastContext.jsx';
import { Ico, SecHead } from '../ui/Primitives.jsx';
import SlotRow from '../ui/SlotRow.jsx';
import EditMeetingModal from './EditMeetingModal.jsx';
import {
  meetingCode, meetingScore, participantsOf, organiserOf, selectedSlot, slotsOf,
  fmtTime, fmtDate, fmtDay, fmtDateFull, fmtDuration, fmtSoon,
  isOrganiser, needsMyAction, myStatusIn,
} from '../lib/meetings';

export default function MeetingDetailModal({
  meeting, currentUserId, allMeetings = [], isCalendarConnected,
  onClose, onRefresh, onAccept, onDecline, onParticipantClick,
}) {
  const toast = useToast();
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(null);        // 'book' | 'cancel' | 'reschedule' | 'custom'
  const [ask, setAsk] = useState(null);          // 'cancel' | 'reschedule'
  const [showEdit, setShowEdit] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [custom, setCustom] = useState({ datetime: '', scoring: false, scored: null });
  const [ics, setIcs] = useState(null);

  const organiser = isOrganiser(meeting, currentUserId);
  const confirmed = meeting.status === 'confirmed';
  const cancelled = meeting.status === 'cancelled';
  const booked = selectedSlot(meeting);
  const mine = myStatusIn(meeting, currentUserId);
  const canAct = needsMyAction(meeting, currentUserId);
  const participants = participantsOf(meeting);
  const org = organiserOf(meeting);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (showEdit || ask) { setShowEdit(false); setAsk(null); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, showEdit, ask]);

  /* Other confirmed meetings that would clash with a proposal. */
  const otherBookings = useMemo(() => allMeetings
    .filter(m => m.status === 'confirmed' && m.requestId !== meeting.requestId && m.selectedSlotStart)
    .map(m => ({
      title: m.title,
      start: new Date(m.selectedSlotStart).getTime(),
      end: new Date(m.selectedSlotStart).getTime() + (m.durationMinutes || 60) * 60000,
    })), [allMeetings, meeting.requestId]);

  const clashOf = (slot) => {
    const s = new Date(slot.startIso).getTime();
    const e = slot.endIso
      ? new Date(slot.endIso).getTime()
      : s + (meeting.durationMinutes || 60) * 60000;
    return otherBookings.find(b => s < b.end && e > b.start) || null;
  };

  const proposals = useMemo(() => slotsOf(meeting), [meeting]);
  const chosen = proposals[sel];

  const doBook = async (slot) => {
    setBusy('book');
    try {
      const result = await apiPost(
        `/api/meetings/${meeting.requestId}/book/${encodeURIComponent(slot.startIso)}`,
      );
      if (result?.calendarSyncWarning) toast(result.calendarSyncWarning, 'warning');
      else toast('Time confirmed — participants have been notified.', 'success');
      if (result?.icsContent) setIcs(result.icsContent);
      await onRefresh?.();
      if (!result?.icsContent) onClose();
    } catch (err) {
      toast(err.message || 'Could not book that time.', 'error');
    } finally {
      setBusy(null);
      setConflict(null);
    }
  };

  const selectSlot = (slot, i) => {
    setSel(i);
    setConflict(null);
    const clash = clashOf(slot);
    if (clash) setConflict({ slot, other: clash });
  };

  const scoreCustom = async () => {
    if (!custom.datetime) return;
    setCustom(c => ({ ...c, scoring: true, scored: null }));
    try {
      const result = await apiScoreSlot(
        custom.datetime, meeting.durationMinutes, meeting.participantUserIds || [],
      );
      setCustom(c => ({ ...c, scoring: false, scored: result }));
    } catch {
      toast('Could not score that time.', 'error');
      setCustom(c => ({ ...c, scoring: false }));
    }
  };

  const bookCustom = async () => {
    if (!custom.scored) return;
    setBusy('custom');
    try {
      const result = await apiPost(`/api/meetings/${meeting.requestId}/book_custom`, custom.scored);
      if (result?.calendarSyncWarning) toast(result.calendarSyncWarning, 'warning');
      else toast('Custom time booked — participants have been notified.', 'success');
      if (result?.icsContent) setIcs(result.icsContent);
      await onRefresh?.();
      if (!result?.icsContent) onClose();
    } catch (err) {
      toast(err.message || 'Could not book that time.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async () => {
    setBusy('cancel');
    try {
      await apiPost(`/api/meetings/${meeting.requestId}/cancel`);
      toast('Meeting cancelled.', 'info');
      await onRefresh?.();
      onClose();
    } catch (err) {
      toast(err.message || 'Could not cancel.', 'error');
    } finally {
      setBusy(null);
      setAsk(null);
    }
  };

  const doReschedule = async () => {
    setBusy('reschedule');
    try {
      await apiPost(`/api/meetings/${meeting.requestId}/reschedule`);
      toast('Reset to pending — new times are being generated.', 'info');
      await onRefresh?.();
      setSel(0);
    } catch (err) {
      toast(err.message || 'Could not reschedule.', 'error');
    } finally {
      setBusy(null);
      setAsk(null);
    }
  };

  const statusLine = [
    meetingCode(meeting.requestId),
    fmtDuration(meeting.durationMinutes),
    cancelled ? 'cancelled' : confirmed ? 'confirmed' : 'pending',
    organiser ? 'you organise' : `organised by ${org.name}`,
  ].join(' · ');

  return (
    <>
      <div className="veil" onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="mod" style={{ width: 760 }}>
          <div className="mod-h">
            <div>
              <div className="eyebrow">{statusLine}</div>
              <h2>{meeting.title}</h2>
            </div>
            <button className="x" onClick={onClose} aria-label="Close">×</button>
          </div>

          <div className="mod-b">
            {confirmed && meeting.selectedSlotStart && (
              <div className="f-row">
                <div className="f-lab">When</div>
                <div style={{ paddingTop: 7 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{fmtDateFull(meeting.selectedSlotStart)}</div>
                  <div className="f-hint" style={{ marginTop: 5 }}>
                    {fmtTime(meeting.selectedSlotStart)} · {fmtDuration(meeting.durationMinutes)}
                    {fmtSoon(meeting.selectedSlotStart) && ` · ${fmtSoon(meeting.selectedSlotStart)}`}
                    {meetingScore(meeting) != null && ` · fairness ${Math.round(meetingScore(meeting))}`}
                  </div>
                  {booked?.explanation && (
                    <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.55, marginTop: 8 }}>
                      {booked.explanation}
                    </div>
                  )}
                </div>
              </div>
            )}

            {meeting.description && (
              <div className="f-row">
                <div className="f-lab">Agenda</div>
                <div style={{ paddingTop: 7, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                  {meeting.description}
                </div>
              </div>
            )}

            <div className="f-row">
              <div className="f-lab">Organiser</div>
              <div style={{ paddingTop: 7, fontSize: 13.5 }}>
                {organiser ? 'You' : org.name}
              </div>
            </div>

            <div className="f-row">
              <div className="f-lab">Participants</div>
              <div className="plist">
                {participants.length === 0 && <span className="f-hint" style={{ margin: 0 }}>No invitees.</span>}
                {participants.map(p => {
                  const accepted = (meeting.acceptedBy || []).includes(p.id);
                  const declined = (meeting.declinedBy || []).includes(p.id);
                  const detail = meeting.declineDetails?.[p.id];
                  return (
                    <button
                      key={p.id}
                      className="prow"
                      onClick={() => onParticipantClick?.(p.id)}
                      title={p.email || p.name}
                    >
                      <div className="mono-av">{p.initials}</div>
                      <span className="prow-n">
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.id === currentUserId ? 'You' : p.name}
                        </span>
                        {declined && detail?.reason && (
                          <span className="f-hint" style={{ display: 'block', margin: '3px 0 0', whiteSpace: 'normal' }}>
                            {detail.reason}{detail.comment ? ` — ${detail.comment}` : ''}
                          </span>
                        )}
                      </span>
                      <span className={`prow-s ${accepted ? 'ok' : declined ? 'no' : 'wait'}`}>
                        {accepted ? 'accepted' : declined ? 'declined' : confirmed ? 'awaiting' : 'invited'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {meeting.aiMethod === 'ai' && (meeting.aiSummary || meeting.aiBestSlotReason) && (
              <div className="ai-panel">
                <div className="ai-h">
                  <Ico n="spark" s={15} />
                  <span className="eyebrow">AI analysis</span>
                  {meeting.aiModel && <span className="ai-model">{meeting.aiModel}</span>}
                </div>
                {meeting.aiSummary && <p>{meeting.aiSummary}</p>}
                {meeting.aiBestSlotReason && (
                  <p>
                    <b style={{ color: 'var(--ink)' }}>
                      {meeting.aiBestSlotIso && !Number.isNaN(new Date(meeting.aiBestSlotIso).getTime())
                        ? `${fmtDay(meeting.aiBestSlotIso)} ${fmtDate(meeting.aiBestSlotIso)}, ${fmtTime(meeting.aiBestSlotIso)} — `
                        : 'Recommended — '}
                    </b>
                    {meeting.aiBestSlotReason}
                  </p>
                )}
                {(meeting.aiCalendarSuggestions || []).map((s, i) => (
                  <div key={i} className="ai-sug">{s}</div>
                ))}
              </div>
            )}

            {ics && (
              <div className="callout sig">
                <div className="eyebrow">Add to your calendar</div>
                <p>
                  The invite is written to connected calendars automatically. Need a file?{' '}
                  <a
                    href={`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`}
                    download={`${meeting.title || 'meeting'}.ics`}
                  >Download the .ics</a>
                </p>
              </div>
            )}

            {organiser && !confirmed && !cancelled && (
              <div style={{ paddingTop: 20 }}>
                <SecHead
                  n="01"
                  title="Proposed times"
                  aside={proposals.length ? `${proposals.length} ranked` : 'none yet'}
                />

                {proposals.length === 0 ? (
                  <div className="callout warn" style={{ marginTop: 16 }}>
                    <div className="eyebrow">No times generated</div>
                    <p>
                      The scheduler found nothing inside everyone's working hours. Regenerate with a
                      wider range, or pick a time yourself below.
                    </p>
                  </div>
                ) : proposals.map((slot, i) => (
                  <SlotRow
                    key={slot.startIso}
                    slot={slot}
                    rank={i}
                    selected={sel === i}
                    durationMinutes={meeting.durationMinutes}
                    onSelect={() => selectSlot(slot, i)}
                  />
                ))}

                {conflict && (
                  <div className="callout warn">
                    <div className="eyebrow">Overlap</div>
                    <p>
                      This time overlaps <b>{conflict.other.title}</b>, which you've already confirmed.
                    </p>
                    <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
                      <button className="btn d sm" onClick={() => doBook(conflict.slot)} disabled={busy}>
                        Book anyway
                      </button>
                      <button className="btn g sm" onClick={() => setConflict(null)}>Pick another</button>
                    </div>
                  </div>
                )}

                <div style={{ paddingTop: 22 }}>
                  <SecHead n="02" title="Or choose a time yourself" />
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingTop: 14 }}>
                    <input
                      type="datetime-local"
                      className="inp"
                      value={custom.datetime}
                      onChange={e => setCustom({ datetime: e.target.value, scoring: false, scored: null })}
                    />
                    <button
                      className="btn s"
                      onClick={scoreCustom}
                      disabled={!custom.datetime || custom.scoring}
                    >
                      {custom.scoring ? <><span className="spin-sm" /> Scoring…</> : 'Score this time'}
                    </button>
                  </div>

                  {custom.scored && (
                    <div className="callout" style={{ marginTop: 14 }}>
                      <div className="eyebrow" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        Fairness {Math.round(custom.scored.score)}
                        {custom.scored.aiScored && <span className="slot-tag ai">AI scored</span>}
                      </div>
                      <p>{custom.scored.explanation}</p>
                      {custom.scored.aiSuggestions && <p>{custom.scored.aiSuggestions}</p>}
                      <button
                        className="btn p sm"
                        style={{ marginTop: 12 }}
                        onClick={bookCustom}
                        disabled={busy === 'custom'}
                      >
                        {busy === 'custom' ? <><span className="spin-sm" /> Booking…</> : <>Book this time <Ico n="arrow" s={12} /></>}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {!organiser && !confirmed && !cancelled && (
              <div className="callout" style={{ marginTop: 18 }}>
                <div className="eyebrow">Waiting on the organiser</div>
                <p>
                  {org.name} is still choosing between {meeting.slots?.length || 0} proposed times.
                  You'll be asked to accept once one is picked.
                </p>
              </div>
            )}

            {cancelled && (
              <div className="callout warn" style={{ marginTop: 18 }}>
                <div className="eyebrow">Cancelled</div>
                <p>
                  This meeting was cancelled
                  {meeting.cancelledAt ? ` on ${fmtDateFull(meeting.cancelledAt)}` : ''}.
                </p>
              </div>
            )}
          </div>

          <div className="mod-f">
            <div className="mod-f-r">
              {!cancelled && organiser && (
                <>
                  <button className="btn g" onClick={() => setShowEdit(true)}>
                    <Ico n="pencil" s={13} /> Edit
                  </button>
                  <button className="btn g" onClick={() => setAsk('reschedule')} disabled={busy}>
                    <Ico n="refresh" s={13} /> Regenerate
                  </button>
                  <button className="btn g" onClick={() => setAsk('cancel')} disabled={busy}>
                    <Ico n="trash" s={13} /> Cancel
                  </button>
                </>
              )}
              {!cancelled && !organiser && mine === 'accepted' && (
                <span className="eyebrow" style={{ color: 'var(--forest)' }}>You accepted</span>
              )}
              {!cancelled && !organiser && mine === 'declined' && (
                <span className="eyebrow" style={{ color: 'var(--danger)' }}>You declined</span>
              )}
            </div>

            <div className="mod-f-r">
              {organiser && !confirmed && !cancelled && chosen && (
                <>
                  <span className="eyebrow">
                    {fmtDay(chosen.startIso)} {fmtTime(chosen.startIso)} · {Math.round(chosen.score ?? 0)}
                  </span>
                  <button
                    className="btn p"
                    disabled={busy === 'book' || !!conflict}
                    onClick={() => doBook(chosen)}
                  >
                    {busy === 'book' ? <><span className="spin-sm" /> Booking…</> : <>Confirm this time <Ico n="arrow" s={13} /></>}
                  </button>
                </>
              )}

              {canAct && (
                <>
                  <button className="btn g" onClick={() => onDecline?.(meeting.requestId)}>
                    <Ico n="ban" s={13} /> Decline
                  </button>
                  <button
                    className="btn p"
                    disabled={!isCalendarConnected}
                    title={!isCalendarConnected ? 'Connect Google Calendar to accept meetings' : undefined}
                    onClick={async () => { await onAccept?.(meeting.requestId); onClose(); }}
                  >
                    <Ico n="check" s={13} /> Accept
                  </button>
                </>
              )}

              {(cancelled || (!organiser && !canAct)) && (
                <button className="btn s" onClick={onClose}>Close</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {ask && (
        <div className="veil" onClick={e => e.target === e.currentTarget && setAsk(null)}>
          <div className="mod" style={{ width: 440 }}>
            <div className="mod-h">
              <div>
                <div className="eyebrow">{meetingCode(meeting.requestId)}</div>
                <h2>{ask === 'cancel' ? 'Cancel this meeting?' : 'Regenerate times?'}</h2>
              </div>
              <button className="x" onClick={() => setAsk(null)}>×</button>
            </div>
            <div className="mod-b">
              <p style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6, paddingTop: 14 }}>
                {ask === 'cancel'
                  ? 'Everyone invited will see it as cancelled, and cancelling costs you 5 points of fairness balance.'
                  : 'The meeting goes back to pending and the scheduler proposes a fresh set of times. Any existing acceptances are cleared.'}
              </p>
            </div>
            <div className="mod-f">
              <button className="btn g" onClick={() => setAsk(null)}>Never mind</button>
              <button
                className={ask === 'cancel' ? 'btn d' : 'btn p'}
                disabled={!!busy}
                onClick={ask === 'cancel' ? doCancel : doReschedule}
              >
                {busy ? <><span className="spin-sm" /> Working…</> : ask === 'cancel' ? 'Cancel meeting' : 'Regenerate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showEdit && (
        <EditMeetingModal
          meeting={meeting}
          onClose={() => setShowEdit(false)}
          onSaved={async () => { setShowEdit(false); await onRefresh?.(); }}
        />
      )}
    </>
  );
}
