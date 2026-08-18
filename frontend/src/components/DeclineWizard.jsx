import { useState, useEffect } from 'react';
import { Ico } from '../ui/Primitives.jsx';
import { meetingCode } from '../lib/meetings';

const REASONS = [
  { key: 'busy',     label: 'Busy',     hint: 'Clashes with my schedule' },
  { key: 'personal', label: 'Personal', hint: 'A personal commitment' },
  { key: 'other',    label: 'Custom',   hint: 'Write your own reason' },
];

/**
 * Confirm → reason → done. The reason is stored against the meeting so the
 * organiser can see why, and the backend reshuffles slots when everyone declines.
 */
export default function DeclineWizard({ meeting, onSubmit, onClose }) {
  const [step, setStep] = useState(1);
  const [reason, setReason] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reshuffled, setReshuffled] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  /* "Custom" is only a reason once they have actually written one. */
  const custom = reason === 'other';
  const ready = !!reason && (!custom || comment.trim().length > 0);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit(reason, comment.trim() || null);
      setReshuffled(!!result?.reshuffled);
      setStep(3);
    } catch (err) {
      setError(err?.message || 'Could not send the decline.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="veil" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mod" style={{ width: 480 }}>
        <div className="mod-h">
          <div>
            <div className="eyebrow">
              {meeting ? `${meetingCode(meeting.requestId)} · step ${step} of 3` : `Step ${step} of 3`}
            </div>
            <h2>{step === 3 ? 'Decline sent' : 'Decline meeting'}</h2>
          </div>
          <button className="x" onClick={onClose} disabled={busy}>×</button>
        </div>

        <div className="mod-b">
          {step === 1 && (
            <div style={{ paddingTop: 16 }}>
              <p style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)', margin: 0 }}>
                Decline {meeting?.title ? <b style={{ color: 'var(--ink)' }}>{meeting.title}</b> : 'this meeting'}?
              </p>
              <p style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--ink-3)', marginTop: 12 }}>
                The organiser is told, along with your reason. If everyone invited declines, the
                scheduler generates a fresh set of times automatically.
              </p>
            </div>
          )}

          {step === 2 && (
            <div style={{ paddingTop: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Why?</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {REASONS.map(r => (
                  <button
                    key={r.key}
                    className={`radio-card${reason === r.key ? ' on' : ''}`}
                    onClick={() => setReason(r.key)}
                  >
                    <div className="rc-top">
                      <span className="rc-dot" />
                      <span className="rc-name">{r.label}</span>
                    </div>
                    <div className="rc-desc">{r.hint}</div>
                  </button>
                ))}
              </div>
              {reason && (
                <>
                  <div className="eyebrow" style={{ margin: '16px 0 8px' }}>
                    {custom ? 'Your reason' : 'Note for the organiser (optional)'}
                  </div>
                  <textarea
                    className="inp"
                    autoFocus={custom}
                    maxLength={500}
                    placeholder={custom
                      ? 'Tell the organiser why this time does not work'
                      : 'Anything you want to add'}
                    value={comment}
                    onChange={e => setComment(e.target.value)}
                  />
                  {custom && (
                    <div className="f-hint" style={{ marginTop: 6 }}>
                      {comment.trim() ? `${comment.trim().length}/500` : 'A reason is required for a custom decline.'}
                    </div>
                  )}
                </>
              )}
              {error && <p className="composer-err" style={{ marginTop: 12 }}>{error}</p>}
            </div>
          )}

          {step === 3 && (
            <div style={{ paddingTop: 22, textAlign: 'center' }}>
              <div style={{
                width: 54, height: 54, borderRadius: '50%', display: 'inline-grid',
                placeItems: 'center', background: 'var(--signal-soft)', color: 'var(--signal)',
              }}>
                <Ico n="check" s={24} />
              </div>
              <p style={{ fontSize: 13.5, marginTop: 16, marginBottom: 0 }}>The organiser has been notified.</p>
              <p style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.6 }}>
                {reshuffled
                  ? 'Everyone invited has now declined, so a fresh set of times is being generated.'
                  : 'They can pick a different time or go ahead without you.'}
              </p>
            </div>
          )}
        </div>

        <div className="mod-f">
          {step === 1 && (
            <>
              <button className="btn g" onClick={onClose}>Keep it</button>
              <button className="btn d" onClick={() => setStep(2)}>Continue <Ico n="arrow" s={13} /></button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="btn g" onClick={() => setStep(1)} disabled={busy}>
                <Ico n="back" s={13} /> Back
              </button>
              <button className="btn d" onClick={submit} disabled={!ready || busy}>
                {busy ? <><span className="spin-sm" /> Sending…</> : 'Decline meeting'}
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <span className="eyebrow">Done</span>
              <button className="btn p" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
