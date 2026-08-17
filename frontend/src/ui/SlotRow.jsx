import { fmtTime, fmtDate, fmtDay, tier } from '../lib/meetings';

/**
 * One ranked proposal from the scheduler.
 *
 * The design mock showed a per-participant fairness bar on each row; the API
 * returns a single aggregate score per slot plus its written explanation, so
 * that's what fills the middle column — the real scoring signal rather than an
 * invented per-person breakdown.
 */
export default function SlotRow({ slot, rank, selected, onSelect, durationMinutes, note }) {
  const score = Math.round(slot.score ?? 0);
  const start = new Date(slot.startIso);
  const end = slot.endIso
    ? new Date(slot.endIso)
    : new Date(start.getTime() + (durationMinutes || 60) * 60000);

  return (
    <button type="button" className={`slot${selected ? ' on' : ''}`} onClick={onSelect}>
      {rank === 0 && <span className="best">BEST</span>}

      <div>
        <div className="slot-d">
          {fmtDay(slot.startIso)} · {fmtDate(slot.startIso)}{note ? ` · ${note}` : ''}
        </div>
        <div className="slot-t">{fmtTime(start)}–{fmtTime(end)}</div>
      </div>

      <div>
        <div className="slot-why">
          {slot.explanation || 'Scored against everyone’s working hours, load and calendar conflicts.'}
        </div>
        <div className="slot-tags">
          {slot.aiScored && <span className="slot-tag ai">AI scored</span>}
          {slot.conflictCount > 0
            ? <span className="slot-tag warn">{slot.conflictCount} conflict{slot.conflictCount > 1 ? 's' : ''}</span>
            : <span className="slot-tag">No conflicts</span>}
          {slot.fairnessImpact != null && (
            <span className="slot-tag">
              Balance {slot.fairnessImpact >= 0 ? '+' : ''}{Math.round(slot.fairnessImpact)}
            </span>
          )}
        </div>
        <div className="slot-bar">
          <i className={`f-${tier(score)}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
        </div>
      </div>

      <div className="slot-agg">
        <div className="n">{score}</div>
        <div className="eyebrow" style={{ marginTop: 4 }}>Fair</div>
      </div>
    </button>
  );
}
