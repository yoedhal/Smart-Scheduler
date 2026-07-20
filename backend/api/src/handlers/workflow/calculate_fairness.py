"""
SFN State: CalculateFairnessScores

Produces the heuristic baseline score + fairnessImpact for every candidate
slot. AI scoring runs later inline (see `_scheduling._run_ai_inline`) and
overlays its own scores on top.
"""
import logging
from datetime import datetime

from src.common.timezone import get_tz_offset_hours
from src.core.fairness import engine

logger = logging.getLogger(__name__)


PREFERENCE_BOOST = 18  # pts added to slots matching user's preferred time window

def handler(payload: dict) -> dict:
    request_id = payload.get("request_id", "?")
    profiles = payload.get("participant_profiles", [])
    participant_states = payload.get("participant_states", [])
    candidate_slots = payload.get("candidate_slots", [])
    duration_minutes = payload.get("duration_minutes", 60)
    tz_offset = float(payload.get("tz_offset_hours", 0.0))
    preferred_hours = payload.get("preferred_hours")  # None = no preference set

    logger.info(
        f"[sfn:calculate_fairness] START request_id={request_id} "
        f"slots={len(candidate_slots)} participants={len(profiles)} "
        f"preferred_hours={preferred_hours}"
    )

    participant_tz_offsets = [get_tz_offset_hours(p.get("timezone", "UTC")) for p in profiles] or None
    participant_working_days = [p.get("workingDays", [0, 1, 2, 3, 4]) for p in profiles] or None
    participant_lunch_breaks = [p.get("lunchBreak") for p in profiles] or None

    creator_id = payload.get("creator_id", "")
    creator_profile = next((p for p in profiles if p.get("userId") == creator_id), None)
    organizer_working_days = (creator_profile or {}).get("workingDays", [0, 1, 2, 3, 4])

    # Engine baseline — provides fairnessImpact and the pre-AI score
    scored = []
    for slot in candidate_slots:
        dt = datetime.fromisoformat(slot["startIso"])
        busy_count = int(slot.get("conflictCount", 0))
        result = engine.score_time_slot(
            dt, participant_states, duration_minutes,
            tz_offset_hours=tz_offset,
            participant_tz_offsets=participant_tz_offsets,
            participant_working_days=participant_working_days,
            participant_lunch_breaks=participant_lunch_breaks,
            busy_count=busy_count,
            organizer_working_days=organizer_working_days,
        )
        scored.append({**slot, **result, "aiScored": False, "aiSuggestions": None})

    if scored:
        raw_scores = [s["score"] for s in scored]
        best = max(scored, key=lambda s: s["score"])
        logger.info(
            f"[sfn:calculate_fairness] heuristic_scores request_id={request_id} "
            f"min={min(raw_scores):.1f} max={max(raw_scores):.1f} "
            f"avg={sum(raw_scores)/len(raw_scores):.1f} "
            f"best_slot={best.get('startIso')} best_score={best['score']:.1f}"
        )

    # Apply preference boost: slots in the user's preferred time window score higher.
    # Only activated when preferred_hours is explicitly set; with no preference all
    # slots are equally preferred (isPreferred=True for all) so no boost is needed.
    if preferred_hours:
        boosted = sum(1 for s in scored if s.get("isPreferred"))
        logger.info(
            f"[sfn:calculate_fairness] preference_boost request_id={request_id} "
            f"boost={PREFERENCE_BOOST}pts boosted_slots={boosted}"
        )
        for s in scored:
            if s.get("isPreferred"):
                s["score"] = min(100.0, round(s["score"] + PREFERENCE_BOOST, 1))

    # Fill any empty explanations with heuristic fallback, then strip internal keys
    _internal = {"_hour", "_day", "_load_penalty", "_equity_bonus"}
    clean_scored = []
    for slot in scored:
        if not slot.get("explanation"):
            slot["explanation"] = engine.explain_slot(
                hour=int(slot.get("_hour", 10)),
                day=int(slot.get("_day", 0)),
                score=float(slot.get("score", 50)),
                load_penalty=float(slot.get("_load_penalty", 0.0)),
                equity_bonus=float(slot.get("_equity_bonus", 20.0)),
                working_days=organizer_working_days,
            )
        if preferred_hours and slot.get("isPreferred") and not str(slot.get("explanation", "")).startswith("(preferred"):
            slot["explanation"] = "(preferred time) " + slot.get("explanation", "")
        clean_scored.append({k: v for k, v in slot.items() if k not in _internal})

    payload["scored_slots"] = clean_scored
    logger.info(
        f"[sfn:calculate_fairness] DONE request_id={request_id} scored_slots={len(clean_scored)}"
    )
    return payload
