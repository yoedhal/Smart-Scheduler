"""
Scheduling orchestration: tries Step Functions first, falls back to calling
the workflow step handlers in-process. Shared by handle_create_meeting and
handle_reschedule.

After the sync slot-generation pipeline completes, AI fairness scoring runs
SYNCHRONOUSLY (inline). The AI's per-slot scores replace the heuristic scores
in DynamoDB; the heuristic scores are kept as a fallback when AI fails. The
AI verdict (best slot, reason, calendar suggestions) is stored in the meeting
META so the frontend gets everything in one round trip.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

import boto3

from src.common.timezone import get_tz_offset_hours
from src.database import models
from src.database.repository import AIFairnessRepository, MeetingRepository, UserRepository

logger = logging.getLogger(__name__)


class _DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)

_sfn_client = None
_meeting_repo = MeetingRepository()
_user_repo = UserRepository()
_ai_repo = AIFairnessRepository()


def _get_sfn_client():
    global _sfn_client
    if _sfn_client is None:
        _sfn_client = boto3.client("stepfunctions")
    return _sfn_client


def _get_state_machine_arn() -> str:
    region = os.environ.get("AWS_REGION", "us-east-1")
    account_id = os.environ.get("AWS_ACCOUNT_ID", "")
    if not account_id:
        account_id = boto3.client("sts").get_caller_identity()["Account"]
    return f"arn:aws:states:{region}:{account_id}:stateMachine:SmartSchedulerWorkflow"


# ---------------------------------------------------------------------------
# Inline AI scoring (replaces the previous async Step Function)
# ---------------------------------------------------------------------------

def build_participants_context(
    creator_id: str,
    participant_ids: list,
    date_start: datetime,
    date_end: datetime,
) -> list:
    """Gather per-participant fairness history + calendar events for the AI."""
    from src.common import calendar_client

    all_ids = list({creator_id, *(participant_ids or [])} - {""})
    participants_context = []
    for uid in all_ids:
        profile = _user_repo.get_profile_raw(uid) or {}
        fairness = _user_repo.get_fairness(uid)
        load_metrics = fairness.meetingLoadMetrics if fairness else {}
        current_score = float(fairness.fairnessScore) if fairness else 100.0
        trend = _ai_repo.get_recent_fairness_trend(uid, limit=20)

        try:
            calendar_events = calendar_client.get_user_busy_slots(uid, date_start, date_end)
        except Exception as exc:
            logger.warning(f"[ai_inline] calendar fetch failed for {uid}: {exc}")
            calendar_events = []

        participants_context.append({
            "userId": uid,
            "displayName": profile.get("displayName") or profile.get("email", uid).split("@")[0],
            "timezone": profile.get("timezone", "UTC"),
            "current_fairness_score": current_score,
            "meetings_this_week": int(float(load_metrics.get("meetings_this_week", 0) or 0)),
            "fairness_trend": trend,
            "calendar_events": calendar_events,
        })
    return participants_context


def _run_ai_inline(request_id: str, sfn_input: dict) -> Optional[dict]:
    """
    Runs AI fairness scoring synchronously right after the heuristic SFN.
    Reads the stored slots, calls OpenAI, updates each slot's score +
    explanation in DynamoDB, and writes the meeting-level AI verdict to the
    top-level ai* fields on meeting META.

    Never raises — on any failure, returns None and the meeting flow continues
    with heuristic scores already in DynamoDB.
    """
    from src.core.ai_fairness import score_meeting_with_ai

    try:
        slots = _meeting_repo.get_slots(request_id)
        if not slots:
            logger.warning(f"[ai_inline] no slots found for {request_id} — skipping")
            return None

        candidate_slots = [
            {
                "startIso": s.startIso.isoformat(),
                "score": float(s.score),
                "explanation": s.explanation or "",
                "conflictCount": int(s.conflictCount or 0),
            }
            for s in slots
        ]

        try:
            date_start = datetime.fromisoformat(sfn_input["date_range_start"])
            date_end = datetime.fromisoformat(sfn_input["date_range_end"])
        except Exception:
            date_start = datetime.utcnow()
            date_end = datetime.utcnow() + timedelta(days=7)

        organizer_id = sfn_input.get("creator_id", "")
        participants_context = build_participants_context(
            organizer_id,
            sfn_input.get("participant_ids", []) or [],
            date_start,
            date_end,
        )

        preferred_hours = sfn_input.get("preferred_hours")
        organizer_preferences = None
        if preferred_hours:
            organizer_tz = next(
                (p.get("timezone", "UTC") for p in participants_context if p.get("userId") == organizer_id),
                "UTC",
            )
            first = preferred_hours[0]
            label = "morning" if first <= 11 else "afternoon" if first <= 16 else "evening"
            organizer_preferences = {
                "organizer_id": organizer_id,
                "organizer_timezone": organizer_tz,
                "preferred_hours_local": preferred_hours,
                "preferred_label": label,
            }

        # Capture the heuristic's preferred slot BEFORE AI overwrites slot scores —
        # we'll compare against AI's pick to measure disagreement in production.
        heuristic_best = max(candidate_slots, key=lambda s: float(s.get("score", 0.0)), default=None)
        heuristic_best_iso = str(heuristic_best.get("startIso", "")) if heuristic_best else ""

        t0 = time.time()
        ai_result = score_meeting_with_ai(request_id, candidate_slots, participants_context, organizer_preferences)
        ai_latency_ms = int((time.time() - t0) * 1000)

        # Update each slot's primary score + explanation with the AI verdict.
        # On a heuristic_fallback (no key / OpenAI error) the scores are the
        # engine's, so aiScored must stay False — the UI badge reflects it.
        was_ai_scored = ai_result.get("method") == "ai"
        ai_by_start = {str(entry.get("startIso")): entry for entry in ai_result.get("slot_scores", [])}
        for slot in slots:
            start_key = slot.startIso.isoformat()
            ai_entry = ai_by_start.get(start_key)
            if not ai_entry:
                continue
            slot_dict = slot.model_dump(mode="json")
            ai_score = float(ai_entry.get("ai_score", slot.score))
            slot_dict["score"] = ai_score
            slot_dict["explanation"] = ai_entry.get("description", slot_dict.get("explanation", ""))
            slot_dict["aiScored"] = was_ai_scored
            _meeting_repo.write_slot(request_id, start_key, slot_dict)

        ai_best_iso = str(ai_result.get("best_slot", ""))
        differs = bool(ai_best_iso and heuristic_best_iso and ai_best_iso != heuristic_best_iso)
        ai_score_for_ai_pick = float(ai_by_start.get(ai_best_iso, {}).get("ai_score", 0.0)) if ai_best_iso else 0.0
        ai_score_for_heuristic_pick = float(ai_by_start.get(heuristic_best_iso, {}).get("ai_score", 0.0)) if heuristic_best_iso else 0.0
        score_gap = round(ai_score_for_ai_pick - ai_score_for_heuristic_pick, 1)

        logger.info(
            f"[ai_inline] request_id={request_id} method={ai_result.get('method')} "
            f"latency_ms={ai_latency_ms} slots={len(candidate_slots)} "
            f"participants={len(participants_context)} disagree={differs} score_gap={score_gap}"
        )

        meeting_ai_fields = {
            "aiMeetingScore": float(ai_result.get("meeting_fairness_score", 0.0)),
            "aiSummary": str(ai_result.get("summary", ""))[:300],
            "aiBestSlotIso": ai_best_iso,
            "aiBestSlotReason": str(ai_result.get("best_slot_reason", ""))[:600],
            "aiCalendarSuggestions": list(ai_result.get("calendar_suggestions", []))[:4],
            "aiMethod": ai_result.get("method", ""),
            "aiModel": ai_result.get("model", ""),
            "aiLatencyMs": ai_latency_ms,
            "aiHeuristicBestIso": heuristic_best_iso,
            "aiDisagreedWithHeuristic": differs,
            "aiScoreGap": score_gap,
            "aiSlotCount": len(candidate_slots),
            "aiParticipantCount": len(participants_context),
        }

        meeting = _meeting_repo.get_meta(request_id)
        if meeting:
            meeting.update(meeting_ai_fields)
            _meeting_repo.update_meta(request_id, meeting)

        # Feed the per-participant fairness trend so future AI calls have context
        if ai_result.get("method") == "ai":
            try:
                meeting_score = float(ai_result.get("meeting_fairness_score", 0.0))
                for p in participants_context:
                    _ai_repo.append_user_fairness_point(p["userId"], request_id, meeting_score)
            except Exception as exc:
                logger.warning(f"[ai_inline] failed to append fairness history: {exc}")

        return meeting_ai_fields

    except Exception as exc:
        logger.warning(f"[ai_inline] failed for {request_id}: {exc}")
        return None


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def run_or_schedule(
    meeting_data: models.MeetingCreateSchema, user_id: str
) -> dict:
    """
    Creates the meeting record, runs the heuristic slot pipeline (Step Functions
    when available, in-process otherwise), then runs AI fairness scoring inline.
    Returns the meeting dict with the top-level ai* fields populated.
    """
    account_id = os.environ.get("AWS_ACCOUNT_ID", "")
    is_local = not account_id or os.environ.get("ENVIRONMENT") == "development"

    meeting = _meeting_repo.create_record(meeting_data, user_id)
    creator_profile = _user_repo.get_profile_raw(user_id)
    creator_tz = (creator_profile or {}).get("timezone", "UTC")

    all_pids = list(set([user_id] + (meeting_data.participantIds or [])))
    participant_profiles_for_sfn = []
    for uid in all_pids:
        p = _user_repo.get_profile_raw(uid)
        if p:
            participant_profiles_for_sfn.append({
                "userId": uid,
                "timezone": p.get("timezone", "UTC"),
                "workingHours": p.get("workingHours", {"start": "09:00", "end": "18:00"}),
                "workingDays": p.get("workingDays", [0, 1, 2, 3, 4]),
                "lunchBreak": p.get("lunchBreak", {"start": "12:00", "duration": 60}),
            })

    sfn_input = {
        "request_id": meeting.requestId,
        "creator_id": user_id,
        "participant_ids": meeting_data.participantIds,
        "date_range_start": meeting.dateRangeStart.isoformat(),
        "date_range_end": meeting.dateRangeEnd.isoformat(),
        "duration_minutes": meeting.durationMinutes,
        "tz_offset_hours": get_tz_offset_hours(creator_tz),
        "participant_profiles": participant_profiles_for_sfn,
        "preferred_hours": getattr(meeting_data, "preferredHours", None),
        "excluded_weekdays": getattr(meeting_data, "excludedWeekdays", None),
    }

    if is_local:
        try:
            run_local_steps(sfn_input)
        except Exception as local_exc:
            logger.warning(f"Local scheduling failed for {meeting.requestId}: {local_exc}")
    else:
        try:
            sfn = _get_sfn_client()
            resp = sfn.start_sync_execution(
                stateMachineArn=_get_state_machine_arn(),
                name=f"schedule-{meeting.requestId}",
                input=json.dumps(sfn_input, cls=_DecimalEncoder),
            )
            if resp["status"] == "FAILED":
                raise Exception(resp.get("error", "Workflow failed"))
        except Exception as sfn_exc:
            logger.warning(f"SFN failed for {meeting.requestId}, falling back to local: {sfn_exc}")
            try:
                run_local_steps(sfn_input)
            except Exception as local_exc:
                logger.warning(f"Local scheduling also failed for {meeting.requestId}: {local_exc}")

        # Guard: SFN can return SUCCEEDED yet leave no slots in DynamoDB if the
        # store_results step misbehaves. Re-run the workflow in-process if so.
        if not _meeting_repo.get_slots(meeting.requestId):
            logger.warning(f"No slots stored for {meeting.requestId} after SFN, running local fallback")
            try:
                run_local_steps(sfn_input)
            except Exception as local_exc:
                logger.warning(f"Local fallback after empty SFN failed for {meeting.requestId}: {local_exc}")

    ai_fields = _run_ai_inline(meeting.requestId, sfn_input)

    meeting_dict = meeting.model_dump(mode="json")
    if ai_fields:
        meeting_dict.update(ai_fields)
    return meeting_dict


def run_local_steps(payload: dict) -> None:
    """Calls the workflow step handlers sequentially (SFN fallback path)."""
    from src.handlers.workflow import (
        calculate_fairness,
        fetch_participants,
        generate_slots,
        store_results,
    )
    payload = fetch_participants.handler(payload)
    payload = generate_slots.handler(payload)
    payload = calculate_fairness.handler(payload)
    store_results.handler(payload)


def build_reschedule_payload(
    meeting: dict, user_id: str, request_id: str, days_forward: int,
    preferred_hours=None, excluded_weekdays=None,
) -> dict:
    creator_profile = _user_repo.get_profile_raw(user_id)
    creator_tz = (creator_profile or {}).get("timezone", "UTC")
    now = datetime.now()
    return {
        "request_id": request_id,
        "creator_id": user_id,
        "participant_ids": meeting.get("participantUserIds", []),
        "date_range_start": now.isoformat(),
        "date_range_end": (now + timedelta(days=int(days_forward))).isoformat(),
        "duration_minutes": int(meeting.get("durationMinutes", 60)),
        "tz_offset_hours": get_tz_offset_hours(creator_tz),
        "preferred_hours": preferred_hours if preferred_hours is not None else meeting.get("preferredHours"),
        "excluded_weekdays": excluded_weekdays if excluded_weekdays is not None else meeting.get("excludedWeekdays"),
    }
