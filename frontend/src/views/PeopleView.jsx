import { useState, useMemo } from 'react';
import { useToast } from '../context/ToastContext.jsx';
import { Ico, Score } from '../ui/Primitives.jsx';
import { initials, fmtAgo } from '../lib/meetings';

export default function PeopleView({ users, meetings, currentUserId, onScheduleWith, onViewProfile }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [dept, setDept] = useState('all');

  /* Shared history, computed from the meetings this user can already see. */
  const history = useMemo(() => {
    const map = {};
    for (const m of meetings) {
      if (m.status === 'cancelled') continue;
      const ids = new Set([...(m.participantUserIds || []), m.creatorUserId]);
      for (const uid of ids) {
        if (uid === currentUserId) continue;
        const entry = map[uid] || (map[uid] = { count: 0, last: null });
        entry.count += 1;
        if (m.selectedSlotStart) {
          const at = new Date(m.selectedSlotStart);
          if (at <= new Date() && (!entry.last || at > entry.last)) entry.last = at;
        }
      }
    }
    return map;
  }, [meetings, currentUserId]);

  const departments = useMemo(
    () => [...new Set(users.map(u => u.department).filter(Boolean))].sort(),
    [users],
  );

  const rows = useMemo(() => {
    let list = users.filter(u => (u.userId || u.id) !== currentUserId);
    if (dept !== 'all') list = list.filter(u => u.department === dept);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(u =>
        (u.name || u.displayName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.role || '').toLowerCase().includes(q) ||
        (u.department || '').toLowerCase().includes(q)
      );
    }
    return list
      .map(u => ({ ...u, uid: u.userId || u.id, ...(history[u.userId || u.id] || { count: 0, last: null }) }))
      .sort((a, b) => b.count - a.count || (a.name || '').localeCompare(b.name || ''));
  }, [users, query, dept, currentUserId, history]);

  const copyInvite = () => {
    navigator.clipboard
      .writeText(`Join me on Smart Scheduler — fair meeting scheduling: ${window.location.origin}`)
      .then(() => toast('Invite link copied.', 'success'))
      .catch(() => toast('Could not copy the link.', 'error'));
  };

  return (
    <div className="page fade">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 className="page-title">People</h1>
          <p className="page-sub">
            Who you schedule with, and how fairly the burden has been shared between you.
          </p>
        </div>
        <div className="page-acts">
          <button className="btn s" onClick={copyInvite}><Ico n="copy" s={13} /> Copy invite</button>
        </div>
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '22px 0 8px', gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="inp"
            style={{ width: 250 }}
            placeholder="Search name, role or department…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {departments.length > 0 && (
            <select className="inp" style={{ width: 'auto' }} value={dept} onChange={e => setDept(e.target.value)}>
              <option value="all">All departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
        <span className="eyebrow">
          {rows.length} member{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          {users.length <= 1 ? (
            <>
              No colleagues yet. People appear here once they sign up —{' '}
              <button className="btn g sm" onClick={copyInvite}>copy the invite link</button>
            </>
          ) : `Nobody matches “${query || dept}”.`}
        </div>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '32%' }}>Name</th>
                <th>Fairness</th><th>Role</th><th>Department</th>
                <th>Together</th><th>Last met</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(u => (
                <tr key={u.uid} onClick={() => onViewProfile?.(u.uid)}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="mono-av">{initials(u.name || u.displayName)}</div>
                      <div>
                        <div className="t-title">{u.name || u.displayName || 'Unknown'}</div>
                        <div className="t-sub">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td><Score v={u.fairness_score} /></td>
                  <td><span className="t-when">{u.role || '—'}</span></td>
                  <td><span className="t-when">{u.department || '—'}</span></td>
                  <td><span className="t-when">{u.count || '—'}</span></td>
                  <td><span className="t-when">{u.last ? fmtAgo(u.last) : '—'}</span></td>
                  <td>
                    <button
                      className="btn s sm"
                      onClick={(e) => { e.stopPropagation(); onScheduleWith?.(u.email); }}
                    >
                      Schedule
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
