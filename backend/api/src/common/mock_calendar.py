"""
mock_calendar — synthetic calendars for live demos.

A user carrying a MOCKCAL record behaves as though a real calendar were
connected: generate_slots sees their busy blocks, the AI scorer receives their
events, and CalendarView renders them. Nothing here touches Google or the
network, so a demo runs offline and looks the same on any day of the year —
the weekly pattern is expanded relative to whatever week is being viewed.

Storage:  PK=USER#<id>, SK=MOCKCAL
  {"persona": "jensen"}    → weekly pattern expanded from PERSONAS
  {"events": [...]}        → explicit events, used verbatim (start/end/summary)

Seed with `python scripts/seed_demo_calendars.py`.
"""
from __future__ import annotations

import logging
from datetime import date as _date
from datetime import datetime, time, timedelta
from typing import Dict, List, Optional

from src.common.dynamo import get_db
from src.common.time_utils import parse_naive_utc
from src.common.timezone import get_tz_offset_hours

logger = logging.getLogger(__name__)

SK = "MOCKCAL"

# Never materialise more than this, however wide a window is asked for.
MAX_WINDOW_DAYS = 120

# ---------------------------------------------------------------------------
# Personas
#
# weekly:  (weekday, "HH:MM", duration_minutes, summary) — weekday 0 = Monday,
#          times are LOCAL to the persona's timezone.
# allDay:  (weekday, summary) — emitted as a midnight-to-midnight UTC block,
#          which is what generate_slots treats as a blocked calendar date.
#
# The two personas are deliberately complementary: Jensen's mornings are gone
# and Mark's afternoons are gone, so the only clean overlap is the midday window.
# That gives a live demo something visible to say about every candidate slot.
# ---------------------------------------------------------------------------

PERSONAS: Dict[str, dict] = {
    "jensen": {
        "displayName": "Jensen Huang",
        "email": "jensen.huang@demo.smartscheduler.app",
        "role": "Hardware Engineer",
        "department": "Hardware",
        "timezone": "Asia/Jerusalem",
        "skills": ["Hardware design", "Research", "AI"],
        "statusMessage": "Mornings are packed",
        "weekly": [
            (0, "09:00", 30, "Design standup"),
            (1, "09:00", 30, "Design standup"),
            (2, "09:00", 30, "Design standup"),
            (3, "09:00", 30, "Design standup"),
            (0, "10:00", 120, "Design review — checkout flow"),
            (1, "09:45", 105, "User interviews"),
            (2, "10:00", 90, "Sprint planning"),
            (3, "10:30", 60, "1:1 with manager"),
            (4, "09:30", 90, "Design critique"),
            # Shared with Mark — the one block where both are busy at once, so
            # the majority-conflict filter has something to remove.
            (1, "12:00", 60, "Company all-hands"),
        ],
        "allDay": [],
    },
    "mark": {
        "displayName": "Mark Zuckerberg",
        "email": "mark.zuckerberg@demo.smartscheduler.app",
        "role": "Backend Engineer",
        "department": "Software R&D",
        "timezone": "Asia/Jerusalem",
        "skills": ["AI", "Vr", "Meta"],
        "statusMessage": "Afternoons are for meetings",
        "weekly": [
            (0, "13:00", 90, "Customer sync"),
            (1, "14:00", 120, "Platform architecture review"),
            (2, "13:30", 60, "Support rotation handover"),
            (2, "16:00", 60, "Incident review"),
            (3, "13:00", 180, "Migration workshop"),
            (1, "12:00", 60, "Company all-hands"),
        ],
        # Blocks the whole Friday — exercises the all-day filter in generate_slots.
        "allDay": [(4, "Conference — offsite")],
    },
}


# ---------------------------------------------------------------------------
# Assignment lookup
# ---------------------------------------------------------------------------

def get_assignment(user_id: str) -> Optional[dict]:
    """Return the user's MOCKCAL record, or None when they have no mock calendar."""
    if not user_id:
        return None
    try:
        return get_db().get(f"USER#{user_id}", SK)
    except Exception as exc:
        logger.warning(f"[mock_calendar] assignment lookup failed for {user_id}: {exc}")
        return None


def is_mock_user(user_id: str) -> bool:
    return get_assignment(user_id) is not None


def set_assignment(user_id: str, persona: str) -> None:
    """Attach a persona to a user. Raises KeyError for an unknown persona."""
    if persona not in PERSONAS:
        raise KeyError(f"Unknown persona {persona!r}. Known: {', '.join(PERSONAS)}")
    get_db().put(f"USER#{user_id}", SK, {
        "userId": user_id,
        "persona": persona,
        "assignedAt": datetime.now().isoformat(),
    })


def clear_assignment(user_id: str) -> None:
    get_db().delete(f"USER#{user_id}", SK)


# ---------------------------------------------------------------------------
# Expansion
# ---------------------------------------------------------------------------

def _iso_z(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _event(uid: str, summary: str, start: datetime, end: datetime, day: _date, idx: int) -> dict:
    """Build an event in the same shape get_google_events returns."""
    return {
        "id": f"mock-{uid}-{day.isoformat()}-{idx}",
        "summary": summary,
        "start": _iso_z(start),
        "end": _iso_z(end),
        "description": "",
        "location": "",
        "colorId": "",
        "attendees": [],
        "htmlLink": "",
        "source": "mock",
    }


def expand_persona(persona_key: str, t_min: datetime, t_max: datetime,
                   user_id: str = "demo") -> List[dict]:
    """
    Materialise a persona's weekly pattern across [t_min, t_max] (naive UTC).

    Local wall-clock times are converted with the timezone's *current* UTC
    offset, so an event that straddles a DST change can land an hour off. That
    is fine for a demo and keeps the module dependency-free.
    """
    persona = PERSONAS.get(persona_key)
    if not persona:
        logger.warning(f"[mock_calendar] unknown persona {persona_key!r}")
        return []

    if (t_max - t_min) > timedelta(days=MAX_WINDOW_DAYS):
        t_max = t_min + timedelta(days=MAX_WINDOW_DAYS)

    offset = timedelta(hours=get_tz_offset_hours(persona.get("timezone", "UTC")))
    events: List[dict] = []

    # Walk local calendar days, padded by one on each side so events that cross
    # the window edge after the UTC shift are still considered.
    day = (t_min + offset).date() - timedelta(days=1)
    last_day = (t_max + offset).date() + timedelta(days=1)

    while day <= last_day:
        weekday = day.weekday()
        idx = 0
        for rule_day, hhmm, duration, summary in persona.get("weekly", []):
            if rule_day != weekday:
                continue
            hour, minute = (int(part) for part in hhmm.split(":"))
            start = datetime.combine(day, time(hour, minute)) - offset
            end = start + timedelta(minutes=duration)
            if start < t_max and end > t_min:
                events.append(_event(user_id, summary, start, end, day, idx))
            idx += 1
        for rule_day, summary in persona.get("allDay", []):
            if rule_day != weekday:
                continue
            # Midnight-to-midnight UTC: what collect_all_day_dates recognises.
            start = datetime.combine(day, time(0, 0))
            end = start + timedelta(days=1)
            if start < t_max and end > t_min:
                events.append(_event(user_id, summary, start, end, day, idx))
            idx += 1
        day += timedelta(days=1)

    events.sort(key=lambda e: e["start"])
    return events


def _window(time_min_iso: str, time_max_iso: str) -> Optional[tuple]:
    t_min = parse_naive_utc(time_min_iso)
    t_max = parse_naive_utc(time_max_iso)
    if t_min is None or t_max is None or t_max <= t_min:
        return None
    return t_min, t_max


def get_mock_events(user_id: str, time_min_iso: str, time_max_iso: str) -> List[dict]:
    """
    Events for a mock-calendar user in the given ISO window.
    Returns [] for users without a mock calendar — so it is safe to call for
    everyone.
    """
    assignment = get_assignment(user_id)
    if not assignment:
        return []

    window = _window(time_min_iso, time_max_iso)
    if not window:
        return []
    t_min, t_max = window

    explicit = assignment.get("events")
    if explicit:
        out = []
        for i, ev in enumerate(explicit):
            start = parse_naive_utc(str(ev.get("start", "")))
            end = parse_naive_utc(str(ev.get("end", "")))
            if start is None or end is None or not (start < t_max and end > t_min):
                continue
            out.append(_event(user_id, str(ev.get("summary", "Busy")), start, end, start.date(), i))
        out.sort(key=lambda e: e["start"])
        return out

    return expand_persona(str(assignment.get("persona", "")), t_min, t_max, user_id)


def get_mock_busy(user_id: str, date_start: datetime, date_end: datetime) -> List[dict]:
    """get_mock_events for the datetime-based callers (fairness / slot generation)."""
    return get_mock_events(user_id, date_start.isoformat() + "Z", date_end.isoformat() + "Z")


def describe(user_id: str) -> Optional[dict]:
    """Summary of a user's mock calendar for calendar_status. None when unset."""
    assignment = get_assignment(user_id)
    if not assignment:
        return None
    persona_key = str(assignment.get("persona", ""))
    persona = PERSONAS.get(persona_key, {})
    label = persona.get("displayName") or (persona_key or "Custom")
    now = datetime.utcnow()
    try:
        count = len(get_mock_busy(user_id, now, now + timedelta(days=7)))
    except Exception:
        count = 0
    return {
        "connected": True,
        "persona": persona_key,
        "label": label,
        "eventsNextWeek": count,
    }
