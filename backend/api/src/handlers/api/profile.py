from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

from fastapi import HTTPException

from src.database.repository import MeetingRepository, UserRepository
from src.core.fairness import engine as _fairness_engine

logger = logging.getLogger(__name__)

_user_repo = UserRepository()
_meeting_repo = MeetingRepository()


def handle_profile(identity: dict) -> dict:
    user_id = identity["user_id"]
    email = identity["email"]
    display_name = identity["display_name"]
    try:
        _user_repo.ensure_profile(user_id, email, display_name)
        profile = _user_repo.get_profile(user_id)
        fairness = _user_repo.get_fairness(user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="User not found")
        metrics = fairness.meetingLoadMetrics if fairness else {}
        last_updated = fairness.lastUpdatedAt.isoformat() if fairness and fairness.lastUpdatedAt else None
        # Recalculate score at read time so passive recovery is reflected immediately
        live_score = (
            _fairness_engine.calculate_user_score(metrics, last_updated) if fairness else 100.0
        )
        # Count only recent cancellations (last 30 days) for the UI details panel
        cutoff = datetime.now() - timedelta(days=30)
        recent_cancellations = sum(
            1 for ts in metrics.get("cancellation_timestamps", [])
            if datetime.fromisoformat(str(ts)) > cutoff
        )
        return {
            "id": user_id,
            "name": profile.displayName,
            "displayName": profile.displayName,
            "email": profile.email,
            "bio": profile.bio,
            "role": profile.role,
            "department": profile.department,
            "skills": profile.skills,
            "status_message": profile.statusMessage,
            "statusMessage": profile.statusMessage,
            "timezone": profile.timezone,
            "workingHours": profile.workingHours,
            "workingDays": profile.workingDays,
            "lunchBreak": profile.lunchBreak,
            "notificationPrefs": profile.notificationPrefs,
            "showFairnessScore": profile.showFairnessScore,
            "fairness_score": live_score,
            "details": {
                "meetings_this_week":      metrics.get("meetings_this_week", 0),
                "fairness_balance":        round(float(metrics.get("fairness_balance", 0.0)), 1),
                "inconvenient_count":      metrics.get("inconvenient_count", 0),
                "convenient_count":        metrics.get("convenient_count", 0),
                "cancellations_last_month": recent_cancellations,
                "last_week_reset":         fairness.lastWeekReset if fairness else None,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"[profile] soft-fail for {user_id}: {exc}")
        return {
            "id": user_id,
            "name": display_name,
            "email": email,
            "role": "Professional",
            "fairness_score": 100.0,
            "details": {"meetings_this_week": 0, "cancellations_last_month": 0, "prime_slots_accepted": 0},
        }


def handle_update_profile(identity: dict, data: str | None) -> dict:
    if not data:
        raise HTTPException(status_code=400, detail="Missing data")
    try:
        updates = json.loads(data)
        updated = _user_repo.update_profile(identity["user_id"], updates)
        return {"status": "success", "profile": updated.model_dump(mode="json")}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


def handle_public_profile(identity: dict, action: str) -> dict:
    target_id = action.split(":", 1)[1]
    target = _user_repo.get_profile(target_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    fairness = _user_repo.get_fairness(target_id)
    return {
        "id": target_id,
        "name": target.displayName,
        "bio": target.bio,
        "role": target.role,
        "department": target.department,
        "skills": target.skills,
        "status": target.statusMessage,
        "score": float(fairness.fairnessScore) if (fairness and target.showFairnessScore) else None,
    }


def handle_profile_stats(identity: dict) -> dict:
    try:
        meetings = _meeting_repo.get_user_meetings(identity["user_id"])
        return _user_repo.get_stats(identity["user_id"], meetings)
    except Exception:
        return {}


def handle_list_users(identity: dict) -> list:
    try:
        users = _user_repo.get_all_users(identity["user_id"])
        return [
            {
                "userId": u.get("userId", ""),
                "id": u.get("userId", ""),
                "displayName": u.get("displayName", ""),
                "name": u.get("displayName", ""),
                "email": u.get("email", ""),
                "role": u.get("role", ""),
                "department": u.get("department", ""),
                "fairness_score": u.get("fairness_score", 100.0),
                "skills": u.get("skills", []),
                "statusMessage": u.get("statusMessage", ""),
            }
            for u in users
        ]
    except Exception:
        return []


def handle_shared_meetings(identity: dict, action: str) -> dict:
    target_id = action.split(":", 1)[1]
    try:
        return _user_repo.get_shared_meetings(identity["user_id"], target_id)
    except Exception:
        return {"count": 0, "recentTitles": []}


def handle_reset_fairness(identity: dict) -> dict:
    """Reset meetings_this_week and cancellation_timestamps so the score can recover."""
    uid = identity["user_id"]
    fairness = _user_repo.get_fairness(uid)
    if not fairness:
        raise HTTPException(status_code=404, detail="Fairness record not found")
    now = datetime.now().isoformat()
    new_metrics = {
        **fairness.meetingLoadMetrics,
        "meetings_this_week": 0,
        "fairness_balance": 0.0,
        "inconvenient_count": 0,
        "convenient_count": 0,
        "cancellation_timestamps": [],
    }
    new_score = _fairness_engine.calculate_user_score(new_metrics, now)
    _user_repo._db.put(f"USER#{uid}", "FAIRNESS", {
        **fairness.model_dump(mode="json"),
        "meetingLoadMetrics": new_metrics,
        "fairnessScore": new_score,
        "lastWeekReset": now,
        "lastUpdatedAt": now,
    })
    return {"fairnessScore": new_score, "meetingLoadMetrics": new_metrics}
