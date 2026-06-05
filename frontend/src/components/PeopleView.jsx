import { useState, useEffect, useMemo } from 'react';
import { apiGet } from '../apiClient';
import { Users, Copy, Check, CalendarPlus, Search } from 'lucide-react';
import './PeopleView.css';
import { fairnessColor } from '../fairnessColor';

const getInitials = (name) =>
  name ? name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase() : '?';

const getScoreColor = fairnessColor;

const APP_URL = window.location.origin;

export default function PeopleView({ meetings, onScheduleWith, onViewProfile }) {
  const [users, setUsers]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [deptFilter, setDeptFilter] = useState('all');
  const [inviteCopied, setInviteCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiGet('/api/users')
      .then(data => setUsers(Array.isArray(data) ? data : []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);

  // "Recently scheduled with" — unique confirmed participants, top 5
  const recentPeople = useMemo(() => {
    const seen = new Set();
    const people = [];
    for (const m of (meetings || [])) {
      if (m.status === 'confirmed') {
        for (const pid of (m.participantUserIds || [])) {
          if (!seen.has(pid)) {
            seen.add(pid);
            const u = users.find(u => u.id === pid);
            if (u) people.push(u);
          }
          if (people.length >= 5) break;
        }
      }
      if (people.length >= 5) break;
    }
    return people;
  }, [meetings, users]);

  // Unique departments for filter
  const departments = useMemo(() => {
    const all = users.map(u => u.department).filter(Boolean);
    return [...new Set(all)].sort();
  }, [users]);

  const filtered = useMemo(() => {
    let list = users;
    if (deptFilter !== 'all') list = list.filter(u => u.department === deptFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(u =>
        u.name?.toLowerCase().includes(q) ||
        u.role?.toLowerCase().includes(q) ||
        u.department?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [users, search, deptFilter]);

  return (
    <div className="pv-people-wrap">
      <div className="people-header">
        <div>
          <h2 className="people-title">People</h2>
          <p className="people-sub">Your organisation's members · connect & schedule</p>
        </div>
      </div>

      {/* Recently scheduled with */}
      {recentPeople.length > 0 && (
        <div className="people-recent">
          <div className="people-section-label">Recently scheduled with</div>
          <div className="people-recent-row">
            {recentPeople.map(u => (
              <div key={u.id} className="people-recent-chip" onClick={() => onViewProfile?.(u.id)} title={u.name}>
                <div className="people-chip-avatar">{getInitials(u.name)}</div>
                <span>{u.name?.split(' ')[0]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + filter */}
      <div className="people-search-bar">
        <div className="people-search-wrap">
          <Search size={14} className="people-search-icon" />
          <input
            type="text"
            className="people-search-input"
            placeholder="Search by name, role or department…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="people-dept-select"
          value={deptFilter}
          onChange={e => setDeptFilter(e.target.value)}
        >
          <option value="all">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="people-grid">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="people-card-skeleton">
              <div className="skeleton" style={{ width: 48, height: 48, borderRadius: '50%', flexShrink: 0 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div className="skeleton" style={{ height: 13, width: '60%' }} />
                <div className="skeleton" style={{ height: 11, width: '40%' }} />
                <div className="skeleton" style={{ height: 10, width: '75%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        users.length === 0 ? (
          <div className="people-empty" style={{ padding: '3rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
            <Users size={56} strokeWidth={1} style={{ opacity: 0.25 }} />
            <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text-primary)' }}>No colleagues yet</div>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '340px', margin: 0, lineHeight: 1.6 }}>
              People appear here when colleagues sign up to Smart Scheduler.
              Share the app link to get started.
            </p>
            <button
              style={{
                marginTop: '0.5rem', padding: '0.55rem 1.1rem', borderRadius: '8px',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                color: inviteCopied ? 'var(--success)' : 'var(--text-primary)',
                fontSize: '0.84rem', fontWeight: 500, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                transition: 'color 0.2s',
              }}
              onClick={() => {
                const msg = `I'm using Smart Scheduler to organise fair meeting scheduling — join me at ${APP_URL}`;
                navigator.clipboard.writeText(msg).then(() => {
                  setInviteCopied(true);
                  setTimeout(() => setInviteCopied(false), 2000);
                });
              }}
            >
              {inviteCopied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy invite message</>}
            </button>
          </div>
        ) : (
          <div className="people-empty">
            <Users size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
            <p>No results match your search.</p>
          </div>
        )
      ) : (
        <>
          <div className="people-section-label" style={{ marginBottom: '0.75rem' }}>
            {filtered.length} member{filtered.length !== 1 ? 's' : ''}
          </div>
          <div className="people-grid">
            {filtered.map((u, i) => {
              const scoreColor = getScoreColor(Math.round(u.fairness_score ?? 100));
              return (
                <div key={u.id} className="people-card" style={{ '--delay': `${Math.min(i * 40, 400)}ms` }}>
                  <div className="people-card-top" onClick={() => onViewProfile?.(u.id)} style={{ cursor: 'pointer' }}>
                    <div className="people-card-avatar">{getInitials(u.name)}</div>
                    <div className="people-card-info">
                      <div className="people-card-name">{u.name || 'Unknown'}</div>
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                        {u.role && <span className="people-role-chip">{u.role}</span>}
                        {u.department && <span className="people-dept-chip">{u.department}</span>}
                      </div>
                      {u.statusMessage && (
                        <div className="people-status-msg">{u.statusMessage}</div>
                      )}
                    </div>
                    <div className="people-score-badge" style={{ color: scoreColor, borderColor: scoreColor + '40' }}
                      title="Fairness score (0–100): based on meeting load, cancellations, and willingness to accept inconvenient times. Higher is better.">
                      {Math.round(u.fairness_score ?? 100)}
                    </div>
                  </div>
                  <div className="people-card-actions">
                    <button
                      className="people-btn schedule-btn"
                      onClick={() => { if (onScheduleWith) onScheduleWith(u.email); }}
                    >
                      <CalendarPlus size={13} style={{ marginRight: '0.3rem', verticalAlign: 'middle' }} />Schedule
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
