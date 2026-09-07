import { useState, useEffect, useRef, useMemo } from 'react';
import { Ico } from '../ui/Primitives.jsx';
import { fmtWhen, meetingCode } from '../lib/meetings';

const RECENT_KEY = 'ss-palette-recent';
const MAX_RECENT = 5;

const loadRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
};
const saveRecent = (item) => {
  const prev = loadRecent().filter(r => r.id !== item.id);
  localStorage.setItem(RECENT_KEY, JSON.stringify([{ id: item.id, label: item.label, type: item.type }, ...prev].slice(0, MAX_RECENT)));
};

export default function CommandPalette({
  onClose, onNavigate, onNewMeeting, onNewMeetingFromText,
  onOpenMeeting, onOpenPerson, signOut, meetings = [], users = [],
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [recent, setRecent] = useState(loadRecent);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const actions = useMemo(() => [
    { id: 'cmd:new',       label: 'New meeting',   type: 'action', meta: 'N', run: () => onNewMeeting?.() },
    { id: 'cmd:dashboard', label: 'Go to Overview', type: 'action', meta: '1', run: () => { onClose(); onNavigate('dashboard'); } },
    { id: 'cmd:meetings',  label: 'Go to Meetings', type: 'action', meta: '2', run: () => { onClose(); onNavigate('meetings'); } },
    { id: 'cmd:calendar',  label: 'Go to Calendar', type: 'action', meta: '3', run: () => { onClose(); onNavigate('calendar'); } },
    { id: 'cmd:people',    label: 'Go to People',   type: 'action', meta: '4', run: () => { onClose(); onNavigate('people'); } },
    { id: 'cmd:profile',   label: 'Go to Settings', type: 'action', meta: '5', run: () => { onClose(); onNavigate('profile'); } },
    { id: 'cmd:signout',   label: 'Sign out',       type: 'action', meta: '',  run: () => { onClose(); signOut?.(); } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const meetingItems = useMemo(() => meetings.slice(0, 40).map(m => ({
    id: `mtg:${m.requestId}`,
    label: m.title || 'Untitled meeting',
    type: 'meeting',
    meta: m.selectedSlotStart ? fmtWhen(m.selectedSlotStart) : m.status,
    keywords: meetingCode(m.requestId),
    run: () => onOpenMeeting?.(m),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [meetings]);

  const peopleItems = useMemo(() => users.slice(0, 60).map(u => ({
    id: `usr:${u.userId || u.id}`,
    label: u.displayName || u.name || u.email,
    type: 'person',
    meta: u.role || u.email || '',
    keywords: u.email || '',
    run: () => onOpenPerson?.(u.userId || u.id),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [users]);

  const byId = useMemo(() => {
    const map = {};
    [...actions, ...meetingItems, ...peopleItems].forEach(i => { map[i.id] = i; });
    return map;
  }, [actions, meetingItems, peopleItems]);

  /* "Create a meeting from what I just typed" — only once there's enough to parse. */
  const nlItem = useMemo(() => {
    const raw = query.trim();
    if (!onNewMeetingFromText || raw.length < 8) return null;
    return {
      id: 'cmd:nl',
      label: parsing ? `Reading “${raw}”…` : `Draft a meeting: “${raw}”`,
      type: 'ai',
      meta: 'AI',
      run: async () => {
        if (parsing) return;
        setParsing(true);
        try { await onNewMeetingFromText(raw); } finally { setParsing(false); }
      },
    };
  }, [query, parsing, onNewMeetingFromText]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (i) => i.label.toLowerCase().includes(q) || (i.keywords || '').toLowerCase().includes(q);
    if (!q) {
      return [
        { label: 'Recent', items: recent.map(r => byId[r.id]).filter(Boolean) },
        { label: 'Actions', items: actions.slice(0, 5) },
      ].filter(s => s.items.length);
    }
    return [
      ...(nlItem ? [{ label: 'AI', items: [nlItem] }] : []),
      { label: 'Actions', items: actions.filter(hit) },
      { label: 'Meetings', items: meetingItems.filter(hit) },
      { label: 'People', items: peopleItems.filter(hit) },
    ].filter(s => s.items.length);
  }, [query, recent, byId, actions, meetingItems, peopleItems, nlItem]);

  const flat = useMemo(() => sections.flatMap(s => s.items), [sections]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector('.palette-i.on')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (item) => {
    if (!item) return;
    if (item.type !== 'ai') saveRecent(item);
    setRecent(loadRecent());
    item.run();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(i => Math.min(i + 1, flat.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); run(flat[cursor]); }
  };

  const iconFor = (type) =>
    type === 'meeting' ? 'meetings' : type === 'person' ? 'people' : type === 'ai' ? 'spark' : 'cmd';

  let index = 0;

  return (
    <div className="palette-veil" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          ref={inputRef}
          className="palette-in"
          placeholder="Search meetings and people, or describe a meeting…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {flat.length === 0 ? (
            <div className="empty">Nothing matches “{query}”.</div>
          ) : sections.map(section => (
            <div key={section.label}>
              <div className="palette-sec">{section.label}</div>
              {section.items.map(item => {
                const i = index++;
                return (
                  <div
                    key={item.id}
                    className={`palette-i${i === cursor ? ' on' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => run(item)}
                  >
                    <span className="palette-i-ic"><Ico n={iconFor(item.type)} s={14} /></span>
                    <span className="palette-i-l">{item.label}</span>
                    {item.meta && <span className="palette-i-m">{item.meta}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">↑↓ move · ⏎ select · esc close</div>
      </div>
    </div>
  );
}
