"""
AI-powered fairness scoring — primary scorer.

This module wraps an OpenAI gpt-4.1-mini agent that takes:
  - heuristic candidate slots (used only as a sanity-check reference)
  - each participant's historical fairness scores + load metrics
  - each participant's Google Calendar events for the meeting horizon

…and emits a PRIMARY fairness verdict per candidate slot, identifies the single
best slot with a rationale, and suggests concrete calendar-event changes that
would unlock even better options.

The AI's score is the score the user sees. The heuristic score is only used
as a fallback if the AI call fails (OpenAI down, no API key, parse error).

Runtime model: gpt-4.1-mini (cheap, fast, JSON-mode output). Override via the
AI_FAIRNESS_MODEL env var. Only gpt-4.1-mini and gpt-4.1-nano are validated
against this project's OpenAI access.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from src.common.openai_client import _norm_iso, _redact_events

logger = logging.getLogger(__name__)

# AI call budget: cap input context to avoid runaway cost on huge groups
MAX_PARTICIPANTS_FOR_AI = 25
MAX_EVENTS_PER_PARTICIPANT = 40
MAX_HISTORY_ENTRIES = 20

MODEL_ID = os.environ.get("AI_FAIRNESS_MODEL", "gpt-4.1-mini")


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are Smart Scheduler AI. Output STRICT JSON only — no markdown, no prose.

Inputs:
- candidate_slots: each with heuristic_reference_score (reference only — use your own judgment) and conflictCount.
- participants: displayName, timezone, current_fairness_score, weekly load, fairness_trend, redacted calendar_density (start/end/duration/attendee_count only).
- organizer_preferences: optional preferred time window.

For every slot, produce ai_score 0-100 for GROUP fairness, weighing:
time-of-day quality per timezone · weekly load balance · calendar context (back-to-backs, focus blocks) · historical equity · inclusion across participants.

Then pick the single best slot and explain in 2-3 sentences who benefits and what burdens are avoided.
Then provide 2-4 specific, actionable calendar_suggestions to unlock better slots — each must name a participant (by displayName) and a concrete day/time.

If organizer_preferences is set and best_slot falls outside that window, open best_slot_reason with one sentence naming the timezone/group trade-off (e.g. "Your morning preference was set aside because that window falls at 02:00 for the New York participant.").

PRIVACY: participant displayNames ARE allowed. Never quote calendar event titles or attendee emails — refer to events generically: "a focus block", "a 1:1", "back-to-back meetings".

JSON schema:
{"meeting_fairness_score":<0-100 float>,"summary":"<one sentence verdict>","best_slot":"<startIso exact match>","best_slot_reason":"<2-3 sentences>","calendar_suggestions":["<suggestion>",...],"slot_scores":[{"startIso":"<exact match>","ai_score":<0-100 float>,"description":"<one sentence>"},...]}
"""


def _build_user_prompt(
    candidate_slots: List[dict],
    participants: List[dict],
    organizer_preferences: Optional[Dict[str, Any]] = None,
) -> str:
    """Build the JSON payload sent to the agent."""
    truncated = participants[:MAX_PARTICIPANTS_FOR_AI]
    body = {
        "candidate_slots": [
            {
                "startIso": s.get("startIso"),
                "heuristic_reference_score": float(s.get("score", 0.0)),
                "heuristic_explanation": s.get("explanation", ""),
                "conflictCount": int(s.get("conflictCount", 0)),
            }
            for s in candidate_slots
        ],
        "participants": [
            {
                "userId": p.get("userId", ""),
                "displayName": p.get("displayName") or p.get("userId", ""),
                "timezone": p.get("timezone", "UTC"),
                "current_fairness_score": float(p.get("current_fairness_score", 50.0)),
                "meetings_this_week": int(p.get("meetings_this_week", 0)),
                "fairness_trend": p.get("fairness_trend", [])[:MAX_HISTORY_ENTRIES],
                "calendar_density": _redact_events(
                    p.get("calendar_events", []),
                    max_events=MAX_EVENTS_PER_PARTICIPANT,
                    include_attendee_count=True,
                ),
            }
            for p in truncated
        ],
    }
    if organizer_preferences:
        body["organizer_preferences"] = organizer_preferences
    return json.dumps(body, separators=(",", ":"))


# ---------------------------------------------------------------------------
# OpenAI invocation
# ---------------------------------------------------------------------------

def _call_openai(user_prompt: str) -> Optional[dict]:
    """Invoke the AI fairness model with JSON-mode structured output.

    Returns the parsed JSON dict on success, or None on any failure — caller
    falls back to heuristic scores so the meeting flow never breaks.
    """
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        logger.error("[ai_fairness] OPENAI_API_KEY not set — AI scoring disabled")
        return None

    try:
        from openai import OpenAI
    except ImportError:
        logger.error("[ai_fairness] openai package not installed — AI scoring disabled")
        return None

    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=MODEL_ID,
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=2000,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
        content = resp.choices[0].message.content or ""
        return json.loads(content)
    except Exception as exc:
        logger.error(f"[ai_fairness] OpenAI call failed (model={MODEL_ID}): {exc}", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _heuristic_fallback(candidate_slots: List[dict]) -> Dict[str, Any]:
    """Produce a fallback result using only the heuristic scores.

    `summary` and `best_slot_reason` are left empty so the UI doesn't surface
    an apologetic banner — the heuristic scores still show normally on each slot.
    """
    if not candidate_slots:
        return {
            "method": "heuristic_fallback",
            "model": MODEL_ID,
            "meeting_fairness_score": 0.0,
            "summary": "",
            "best_slot": "",
            "best_slot_reason": "",
            "calendar_suggestions": [],
            "slot_scores": [],
        }
    avg = round(sum(float(s.get("score", 0)) for s in candidate_slots) / len(candidate_slots), 1)
    best = max(candidate_slots, key=lambda s: float(s.get("score", 0)))
    return {
        "method": "heuristic_fallback",
        "model": MODEL_ID,
        "meeting_fairness_score": avg,
        "summary": "",
        "best_slot": str(best.get("startIso", "")),
        "best_slot_reason": "",
        "calendar_suggestions": [],
        "slot_scores": [
            {
                "startIso": str(s.get("startIso", "")),
                "ai_score": float(s.get("score", 0.0)),
                "description": s.get("explanation", ""),
            }
            for s in candidate_slots
        ],
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def score_meeting_with_ai(
    request_id: str,
    candidate_slots: List[dict],
    participants: List[dict],
    organizer_preferences: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Run the AI fairness pass on a meeting. AI is the PRIMARY scorer — heuristic
    scores are only used if the AI call fails.

    Args:
        request_id: meeting requestId (for logging only)
        candidate_slots: list of dicts with startIso, score (heuristic
            reference), explanation, conflictCount.
        participants: list of dicts with userId, timezone,
            current_fairness_score, meetings_this_week, fairness_trend,
            calendar_events.

    Returns:
        {
            "method": "ai" | "heuristic_fallback",
            "model": str,
            "meeting_fairness_score": float,
            "summary": str,
            "best_slot": str (startIso),
            "best_slot_reason": str,
            "calendar_suggestions": [str],
            "slot_scores": [{startIso, ai_score, description}],
        }
    """
    if not candidate_slots:
        return _heuristic_fallback([])

    user_prompt = _build_user_prompt(candidate_slots, participants, organizer_preferences)
    ai = _call_openai(user_prompt)

    if not ai:
        return _heuristic_fallback(candidate_slots)

    # Map AI per-slot scores back to input slots (match by normalized startIso)
    ai_by_start: Dict[str, dict] = {}
    for entry in ai.get("slot_scores", []) or []:
        key = _norm_iso(entry.get("startIso"))
        if key:
            ai_by_start[key] = entry

    slot_scores_out: List[dict] = []
    for s in candidate_slots:
        start_raw = str(s.get("startIso", ""))
        key = _norm_iso(start_raw)
        heuristic = float(s.get("score", 0.0))
        ai_entry = ai_by_start.get(key, {})

        # Use AI score directly if present, else fall back to heuristic for this slot
        try:
            ai_score = float(ai_entry.get("ai_score")) if ai_entry.get("ai_score") is not None else heuristic
        except (TypeError, ValueError):
            ai_score = heuristic

        ai_score = max(0.0, min(100.0, round(ai_score, 1)))
        slot_scores_out.append({
            "startIso": start_raw,
            "ai_score": ai_score,
            "description": str(ai_entry.get("description") or s.get("explanation", ""))[:500],
        })

    # Resolve best_slot — AI's choice if it matches an input slot, else top by ai_score
    best_iso = _norm_iso(ai.get("best_slot", ""))
    best_match = next(
        (entry for entry in slot_scores_out if _norm_iso(entry["startIso"]) == best_iso),
        None,
    )
    if not best_match and slot_scores_out:
        best_match = max(slot_scores_out, key=lambda e: e["ai_score"])

    suggestions_raw = ai.get("calendar_suggestions", []) or []
    suggestions = [str(s)[:400] for s in suggestions_raw if str(s).strip()][:4]

    logger.info(
        f"[ai_fairness] request_id={request_id} method=ai slots={len(slot_scores_out)} "
        f"best={best_match['startIso'] if best_match else 'n/a'} suggestions={len(suggestions)}"
    )

    return {
        "method": "ai",
        "model": MODEL_ID,
        "meeting_fairness_score": float(ai.get("meeting_fairness_score", 0.0)),
        "summary": str(ai.get("summary", ""))[:280],
        "best_slot": best_match["startIso"] if best_match else "",
        "best_slot_reason": str(ai.get("best_slot_reason", ""))[:600],
        "calendar_suggestions": suggestions,
        "slot_scores": slot_scores_out,
    }
