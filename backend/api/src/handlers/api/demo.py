"""
Demo mode — two mock colleagues with synthetic calendars.

Turning demo mode on provisions the personas defined in
``src/common/mock_calendar.py`` as real users (profile + fairness + a MOCKCAL
record), so they can be invited to a meeting like anyone else and their busy
blocks flow through slot generation, fairness scoring and the AI verdict.

Demo mode is per-user: the flag lives at ``USER#<id> / DEMOMODE`` and only
controls whether *that* user sees the demo colleagues in the people picker.
The user's own calendar is never mocked — their real availability is used.

Turning demo mode off hides the demo users again but leaves their records in
place, because past meetings may still reference them.
"""
from __future__ import annotations

import logging
from datetime import datetime

from src.common import mock_calendar
from src.common.dynamo import get_db
from src.database import models

logger = logging.getLogger(__name__)

DEMO_SK = "DEMOMODE"

# Stable ids so re-enabling reuses the same colleagues instead of duplicating them.
DEMO_USER_IDS = {persona: f"demo-{persona}" for persona in mock_calendar.PERSONAS}


def _db():
    return get_db()


def is_demo_user(user_id: str) -> bool:
    return user_id in DEMO_USER_IDS.values()


def is_enabled(user_id: str) -> bool:
    try:
        item = _db().get(f"USER#{user_id}", DEMO_SK)
        return bool(item and item.get("enabled"))
    except Exception as exc:
        logger.warning(f"[demo] flag lookup failed for {user_id}: {exc}")
        return False


def _ensure_demo_user(persona_key: str) -> dict:
    """Create (idempotently) the profile, fairness state and mock calendar for a persona."""
    persona = mock_calendar.PERSONAS[persona_key]
    uid = DEMO_USER_IDS[persona_key]
    db = _db()

    if not db.get(f"USER#{uid}", "PROFILE"):
        db.put(f"USER#{uid}", "PROFILE", models.UserProfile(
            userId=uid,
            email=persona["email"],
            displayName=persona["displayName"],
            bio="Demo colleague — synthetic calendar, no real account.",
            role=persona["role"],
            department=persona["department"],
            skills=persona["skills"],
            statusMessage=persona["statusMessage"],
            timezone=persona["timezone"],
        ).model_dump(mode="json"))

    if not db.get(f"USER#{uid}", "FAIRNESS"):
        db.put(f"USER#{uid}", "FAIRNESS", models.FairnessState(
            userId=uid,
            fairnessScore=50.0,
            meetingLoadMetrics={
                "meetings_this_week": 0,
                "prime_slots_accepted": 0,
                "cancellation_timestamps": [],
            },
            inconvenientMeetingsCount=0,
            lastWeekReset=datetime.now().isoformat(),
        ).model_dump(mode="json"))

    mock_calendar.set_assignment(uid, persona_key)

    return {
        "userId": uid,
        "displayName": persona["displayName"],
        "persona": persona_key,
        "summary": persona["statusMessage"],
    }


def _demo_user_summaries() -> list:
    out = []
    for persona_key, uid in DEMO_USER_IDS.items():
        persona = mock_calendar.PERSONAS[persona_key]
        out.append({
            "userId": uid,
            "displayName": persona["displayName"],
            "persona": persona_key,
            "summary": persona["statusMessage"],
        })
    return out


def handle_demo_status(identity: dict) -> dict:
    enabled = is_enabled(identity["user_id"])
    return {
        "enabled": enabled,
        "users": _demo_user_summaries() if enabled else [],
        "available": _demo_user_summaries(),
    }


def handle_demo_enable(identity: dict) -> dict:
    user_id = identity["user_id"]
    users = [_ensure_demo_user(persona_key) for persona_key in mock_calendar.PERSONAS]
    _db().put(f"USER#{user_id}", DEMO_SK, {
        "userId": user_id,
        "enabled": True,
        "enabledAt": datetime.now().isoformat(),
        "demoUserIds": [u["userId"] for u in users],
    })
    logger.info(f"[demo] enabled for {user_id} with {[u['userId'] for u in users]}")
    return {"status": "success", "enabled": True, "users": users}


def handle_demo_disable(identity: dict) -> dict:
    user_id = identity["user_id"]
    _db().delete(f"USER#{user_id}", DEMO_SK)
    logger.info(f"[demo] disabled for {user_id}")
    return {"status": "success", "enabled": False, "users": []}
