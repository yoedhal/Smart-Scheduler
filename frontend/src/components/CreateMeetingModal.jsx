import { useState, useEffect, useRef } from 'react';
import { apiPost, apiGet } from '../apiClient';
import { CalendarPlus, X } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import WizardStep1 from './createMeeting/WizardStep1.jsx';
import WizardStep2 from './createMeeting/WizardStep2.jsx';
import WizardStep3 from './createMeeting/WizardStep3.jsx';

/**
 * Global Create Meeting Modal.
 * Props:
 *   prefill      – string (email) or { datetime: ISO } or null
 *   onClose      – called when modal is dismissed without creating
 *   onCreated    – called after successful creation
 *   onRefresh    – refresh meetings list
 */
export default function CreateMeetingModal({ prefill, onClose, onCreated, onRefresh }) {
  const notify = useToast();
  const [creating, setCreating] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardDatetime, setWizardDatetime] = useState(null);
  const [titleTouched, setTitleTouched] = useState(false);
  const [newMeeting, setNewMeeting] = useState({
    title: '', durationMinutes: 60, daysForward: 7, description: '',
  });

  // Scheduling preferences state
  const [schedPreset, setSchedPreset] = useState('7');      // '3','7','14','30','custom'
  const [customFrom, setCustomFrom] = useState('');          // YYYY-MM-DD
  const [customDays, setCustomDays] = useState(14);
  const [timeWindow, setTimeWindow] = useState('all');       // 'all','morning','afternoon','evening'
  const [excludedWeekdays, setExcludedWeekdays] = useState([]); // [0-6]
  const [showAdvanced, setShowAdvanced] = useState(false);

  // User search state
  const [allUsers, setAllUsers] = useState([]);
  const [usersLoadError, setUsersLoadError] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const searchRef = useRef(null);
  const dropdownRef = useRef(null);

  // Load all registered users once on mount
  useEffect(() => {
    apiGet('/api/users').then(data => {
      const list = Array.isArray(data) ? data : (data?.users ?? []);
      setAllUsers(list);
    }).catch(() => setUsersLoadError(true));
  }, []);

  // Apply prefill on mount
  useEffect(() => {
    if (prefill) {
      if (typeof prefill === 'object' && prefill?.parsed) {
        // NL-parsed prefill from the command palette
        const p = prefill.parsed;
        setNewMeeting(m => ({
          ...m,
          title: p.title || m.title,
          durationMinutes: p.durationMinutes || m.durationMinutes,
          daysForward: p.daysForward || m.daysForward,
          description: p.description || m.description,
        }));
        setTitleTouched(true);
        // Apply scheduling range from parsed intent. If the LLM returned a specific
        // start date, or a daysForward value that doesn't match a quick preset,
        // switch the wizard to the Custom range and prefill its inputs.
        const presetValues = ['3', '7', '14', '30'];
        const dfStr = p.daysForward ? String(p.daysForward) : null;
        if (p.dateRangeStart) {
          setSchedPreset('custom');
          setCustomFrom(p.dateRangeStart);
          if (p.daysForward) setCustomDays(p.daysForward);
        } else if (dfStr && presetValues.includes(dfStr)) {
          setSchedPreset(dfStr);
        } else if (p.daysForward) {
          setSchedPreset('custom');
          setCustomDays(p.daysForward);
        }
        // Time-of-day preference + excluded weekdays (Mon=0 … Sun=6)
        if (['morning', 'afternoon', 'evening', 'all'].includes(p.timeWindow)) {
          setTimeWindow(p.timeWindow);
        }
        if (Array.isArray(p.excludedWeekdays) && p.excludedWeekdays.length) {
          const clean = Array.from(new Set(
            p.excludedWeekdays
              .map(d => parseInt(d, 10))
              .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
          ));
          setExcludedWeekdays(clean);
        }
        // Auto-expand advanced section so the user immediately sees the parsed prefs
        if (
          (p.timeWindow && p.timeWindow !== 'all') ||
          (Array.isArray(p.excludedWeekdays) && p.excludedWeekdays.length)
        ) {
          setShowAdvanced(true);
        }
        // Resolve parsed participants against the loaded user list
        (p.participants || []).forEach(parsedUser => {
          const match = allUsers.find(u =>
            u.userId === parsedUser.userId ||
            (parsedUser.email && u.email === parsedUser.email)
          );
          if (match) addUser(match);
        });
      } else if (typeof prefill === 'object' && prefill?.datetime) {
        setWizardDatetime(prefill.datetime);
      } else if (typeof prefill === 'string') {
        // Try to match a registered user by email
        const match = allUsers.find(u => u.email === prefill || u.userId === prefill);
        if (match) addUser(match);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUsers]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          searchRef.current && !searchRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Escape key closes modal
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addUser = (user) => {
    if (!selectedUsers.find(u => u.userId === user.userId)) {
      setSelectedUsers(prev => [...prev, user]);
    }
    setSearchQuery('');
    setDropdownOpen(false);
  };

  const removeUser = (userId) => {
    setSelectedUsers(prev => prev.filter(u => u.userId !== userId));
  };

  const filteredUsers = searchQuery.trim()
    ? allUsers.filter(u => {
        if (selectedUsers.find(s => s.userId === u.userId)) return false;
        const q = searchQuery.toLowerCase();
        const name = (u.displayName || u.name || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        return name.includes(q) || email.includes(q);
      }).slice(0, 8)
    : [];

  // Derive scheduling params from UI state
  const daysForward = schedPreset === 'custom' ? Math.max(1, Math.min(90, customDays)) : parseInt(schedPreset);
  const dateRangeStart = schedPreset === 'custom' && customFrom ? customFrom : undefined;
  const preferredHours = timeWindow === 'morning'   ? [8, 9, 10, 11]
                       : timeWindow === 'afternoon' ? [12, 13, 14, 15, 16]
                       : timeWindow === 'evening'   ? [17, 18, 19, 20]
                       : null;

  const schedLabel = schedPreset === 'custom'
    ? `${daysForward} days${customFrom ? ` from ${customFrom}` : ''}`
    : schedPreset === '3' ? '3 days' : schedPreset === '7' ? '1 week'
    : schedPreset === '14' ? '2 weeks' : '1 month';

  const timeLabel = timeWindow === 'morning' ? 'Morning (8–12)'
                  : timeWindow === 'afternoon' ? 'Afternoon (12–17)'
                  : timeWindow === 'evening' ? 'Evening (17–20)'
                  : 'All hours';

  const toggleWeekday = (d) => setExcludedWeekdays(prev =>
    prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
  );

  const handleCreate = async (e) => {
    e.preventDefault();
    if (selectedUsers.length === 0) return;
    setCreating(true);
    try {
      const created = await apiPost('/api/meetings/create', {
        title: newMeeting.title,
        description: newMeeting.description || '',
        durationMinutes: Number(newMeeting.durationMinutes),
        participantEmails: selectedUsers.map(u => u.email),
        participantIds: selectedUsers.map(u => u.userId),
        daysForward,
        ...(dateRangeStart ? { dateRangeStart } : {}),
        ...(preferredHours ? { preferredHours } : {}),
        ...(excludedWeekdays.length ? { excludedWeekdays } : {}),
      });
      notify('Meeting created! AI is optimizing slots…', 'success');
      onRefresh?.();
      onCreated?.(created?.requestId ?? null);
    } catch (err) {
      notify(err?.message || 'Failed to create meeting', 'error');
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-head">
          <h3><CalendarPlus size={16} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }} />New Meeting Request</h3>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <form onSubmit={handleCreate} className="modal-form">
          {/* Wizard step indicator */}
          <div className="wizard-steps">
            {[1,2,3].map(n => (
              <div key={n} className={`wizard-dot${wizardStep >= n ? ' done' : ''}${wizardStep === n ? ' active' : ''}`} />
            ))}
            <span className="wizard-label">Step {wizardStep} of 3</span>
          </div>

          {wizardStep === 1 && (
            <WizardStep1
              newMeeting={newMeeting}
              setNewMeeting={setNewMeeting}
              titleTouched={titleTouched}
              setTitleTouched={setTitleTouched}
              onCancel={onClose}
              onNext={() => setWizardStep(2)}
            />
          )}

          {wizardStep === 2 && (
            <WizardStep2
              wizardDatetime={wizardDatetime}
              selectedUsers={selectedUsers}
              addUser={addUser}
              removeUser={removeUser}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              dropdownOpen={dropdownOpen}
              setDropdownOpen={setDropdownOpen}
              filteredUsers={filteredUsers}
              usersLoadError={usersLoadError}
              searchRef={searchRef}
              dropdownRef={dropdownRef}
              schedPreset={schedPreset}
              setSchedPreset={setSchedPreset}
              customFrom={customFrom}
              setCustomFrom={setCustomFrom}
              customDays={customDays}
              setCustomDays={setCustomDays}
              timeWindow={timeWindow}
              setTimeWindow={setTimeWindow}
              excludedWeekdays={excludedWeekdays}
              toggleWeekday={toggleWeekday}
              showAdvanced={showAdvanced}
              setShowAdvanced={setShowAdvanced}
              onBack={() => setWizardStep(1)}
              onNext={() => setWizardStep(3)}
            />
          )}

          {wizardStep === 3 && (
            <WizardStep3
              newMeeting={newMeeting}
              setNewMeeting={setNewMeeting}
              selectedUsers={selectedUsers}
              schedLabel={schedLabel}
              timeWindow={timeWindow}
              timeLabel={timeLabel}
              excludedWeekdays={excludedWeekdays}
              creating={creating}
              onBack={() => setWizardStep(2)}
            />
          )}
        </form>
      </div>
    </div>
  );
}
