from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from urllib.parse import unquote

from src.common import calendar_client
from fastapi import HTTPException

from src.common.timezone import get_tz_offset_hours
from src.core.fairness import engine as fairness_engine
from src.database import models
from src.database.repository import MeetingRepository, UserRepository

logger = logging.getLogger(__name__)

_meeting_repo = MeetingRepository()
_user_repo = UserRepository()


def handle_meetings(identity: dict) -> list:
    user_id = identity["user_id"]
    try:
        meetings = _meeting_repo.get_user_meetings(user_id)
        logger.info(f"[meetings] user_id={user_id} → found {len(meetings)} meetings")
        all_pids: set = set()
        for m in meetings:
            all_pids.update(m.participantUserIds)
            all_pids.add(m.creatorUserId)
        name_map = _user_repo.get_by_ids(list(all_pids))
        result = []
        for m in meetings:
            slots = _meeting_repo.get_slots(m.requestId)
            d = m.model_dump(mode="json")
            d["slots"] = [s.model_dump(mode="json") for s in slots]
            d["userRole"] = "organizer" if m.creatorUserId == user_id else "participant"
            d["participantNames"] = {
                pid: name_map.get(pid, {"name": pid, "email": ""})
                for pid in (set(m.participantUserIds) | {m.creatorUserId})
            }
            result.append(d)
        return result
    except Exception as exc:
        logger.error(f"[meetings] failed for {user_id}: {exc}", exc_info=True)
        return []


def handle_create_meeting(identity: dict, data: str | None) -> dict:
    if not data:
        raise HTTPException(status_code=400, detail="Missing data for create_meeting")
    try:
        meeting_data = models.MeetingCreateSchema(**json.loads(data))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid meeting data: {exc}")

    user_id = identity["user_id"]
    if meeting_data.participantEmails:
        found = _user_repo.get_by_emails(meeting_data.participantEmails)
        ids = list(meeting_data.participantIds)
        for u in found:
            uid = u.get("userId", "")
            if uid and uid not in ids and uid != user_id:
                ids.append(uid)
        meeting_data.participantIds = ids

    from src.handlers.api._scheduling import run_or_schedule
    return run_or_schedule(meeting_data, user_id)


def handle_book(identity: dict, action: str, data: str | None) -> dict:
    parts = action.split(":", 2)
    if len(parts) < 3:
        raise HTTPException(status_code=400, detail="Invalid book action (expected book:<id>:<slot>)")
    request_id, slot_start_iso = parts[1], unquote(parts[2])
    user_id = identity["user_id"]

    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("status") == "confirmed":
        raise HTTPException(status_code=409, detail="This meeting has already been booked — please refresh and try another slot")

    slot_data = _meeting_repo.get_slot(request_id, slot_start_iso)

    # Confirm slot first (conditional write — raises 409 if slot already taken)
    _meeting_repo.confirm_slot(request_id, slot_start_iso)
    # Update organizer's personal fairness only after successful confirmation
    slot_utc = datetime.fromisoformat(slot_start_iso)
    _apply_personal_fairness(user_id, slot_utc, int(meeting.get("durationMinutes", 60)))
    _meeting_repo.log_activity(request_id, "booked", user_id)

    # Update local dict to reflect the confirmed state so the response is accurate.
    # Clear any previous round's declines so participants start fresh.
    meeting["status"] = "confirmed"
    meeting["selectedSlotStart"] = slot_start_iso
    meeting["acceptedBy"] = []
    meeting["declinedBy"] = []
    meeting["declineDetails"] = {}
    meeting["updatedAt"] = datetime.now().isoformat()
    _meeting_repo.update_meta(request_id, meeting)

    end_iso = _compute_end_iso(slot_start_iso, slot_data, meeting)
    ics_content = calendar_client.generate_ics_content(
        title=meeting.get("title", "Meeting"), start_iso=slot_start_iso, end_iso=end_iso
    )
    write_result = _write_to_calendars(meeting, slot_start_iso, end_iso, request_id)
    return {
        "status": "success",
        "message": "Meeting confirmed successfully",
        "meeting": meeting,
        "icsContent": ics_content,
        "calendarSyncWarning": _calendar_warning(user_id, write_result),
    }


def handle_accept(identity: dict, action: str) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if user_id not in meeting.get("participantUserIds", []):
        raise HTTPException(status_code=403, detail="You are not a participant in this meeting")
    accepted = meeting.get("acceptedBy", [])
    if user_id not in accepted:
        accepted.append(user_id)
    meeting["acceptedBy"] = accepted
    _meeting_repo.update_meta(request_id, meeting)
    _meeting_repo.log_activity(request_id, "accepted", user_id)
    # Update participant's personal fairness — only possible once the slot is confirmed
    slot_start = meeting.get("selectedSlotStart")
    if slot_start:
        _apply_personal_fairness(user_id, datetime.fromisoformat(slot_start), int(meeting.get("durationMinutes", 60)))
    else:
        logger.info(f"[fairness_update] accept for {request_id}: meeting not yet booked, skipping fairness")
    return {"status": "success", "message": "Meeting accepted", "acceptedBy": accepted}


def handle_decline(identity: dict, action: str, data: str | None) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    if not data:
        raise HTTPException(status_code=400, detail="Missing data for decline (reason required)")
    try:
        payload = models.MeetingDeclineSchema(**json.loads(data))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid decline data: {exc}")

    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if user_id == meeting.get("creatorUserId"):
        raise HTTPException(status_code=403, detail="The organizer cannot decline their own meeting")
    if user_id not in meeting.get("participantUserIds", []):
        raise HTTPException(status_code=403, detail="You are not a participant in this meeting")

    declined = meeting.get("declinedBy", [])
    if user_id not in declined:
        declined.append(user_id)
    now = datetime.now()
    details = dict(meeting.get("declineDetails") or {})
    details[user_id] = {
        "reason": payload.reason,
        "comment": payload.comment,
        "slotIso": meeting.get("selectedSlotStart"),
        "declinedAt": now.isoformat(),
    }
    meeting["declinedBy"] = declined
    meeting["declineDetails"] = details
    meeting["acceptedBy"] = [u for u in meeting.get("acceptedBy", []) if u != user_id]
    meeting["updatedAt"] = now.isoformat()

    invited = meeting.get("participantUserIds", [])
    all_declined = bool(invited) and all(u in declined for u in invited)
    logger.info(
        f"[decline] request_id={request_id} decliner={user_id} "
        f"invited={invited} declined={declined} status={meeting.get('status')} "
        f"all_declined={all_declined}"
    )

    reshuffled = False
    if all_declined and meeting.get("status") == "confirmed":
        # All invited users declined — reshuffle: release the slot, regenerate, back to pending
        if ext_ids := meeting.get("externalEventIds"):
            try:
                calendar_client.remove_meeting_from_calendars(ext_ids)
            except Exception as exc:
                logger.error(f"Calendar delete failed on all-decline reshuffle for {request_id}: {exc}")
        # `daysForward` on the record preserves the user's original intent (the
        # LLM parser can return 1 for "tomorrow"/"on Friday"). For the reshuffle
        # search itself, floor at 7 days so once we shift the anchor to `now`
        # there's enough room left for slots to survive working-days, conflicts,
        # and past-hour filtering.
        search_days = max(int(meeting.get("daysForward") or 7), 7)
        # Keep declinedBy/declineDetails so organizer can see who declined and why
        # on the pending card. They are cleared when the organizer books a new slot.
        meeting.update({
            "status": "pending",
            "selectedSlotStart": None,
            "acceptedBy": [],
            "externalEventIds": {},
            "dateRangeStart": now.isoformat(),
            "dateRangeEnd": (now + timedelta(days=search_days)).isoformat(),
        })
        _meeting_repo.update_meta(request_id, meeting)
        _meeting_repo.delete_slots(request_id)
        from src.handlers.api._scheduling import build_reschedule_payload, run_local_steps
        sched_payload = build_reschedule_payload(meeting, meeting.get("creatorUserId", ""), request_id, search_days)
        run_local_steps(sched_payload)
        _meeting_repo.log_activity(request_id, "reshuffled_all_declined", user_id)
        reshuffled = True
    else:
        _meeting_repo.update_meta(request_id, meeting)

    _meeting_repo.log_activity(request_id, "declined", user_id, {"reason": payload.reason})

    return {
        "status": "success",
        "message": "Meeting declined" + (" — all participants declined, slots reshuffled" if reshuffled else ""),
        "declinedBy": declined,
        "reshuffled": reshuffled,
    }


def handle_cancel(identity: dict, action: str) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("creatorUserId") != user_id:
        raise HTTPException(status_code=403, detail="Only the organizer can cancel a meeting")
    if ext_ids := meeting.get("externalEventIds"):
        try:
            cleanup = calendar_client.remove_meeting_from_calendars(ext_ids)
            logger.info(
                f"[cancel] calendar cleanup for {request_id}: "
                f"deleted={len(cleanup['succeeded'])} failed={len(cleanup['failed'])}"
            )
            if cleanup["failed"]:
                logger.warning(
                    f"[cancel] {request_id} could not delete events for users: {cleanup['failed']}"
                )
        except Exception as exc:
            logger.error(f"Calendar delete failed during cancel for {request_id}: {exc}")
    updated = _meeting_repo.cancel(request_id, user_id)
    _user_repo.update_fairness_on_cancel(user_id)
    _meeting_repo.log_activity(request_id, "cancelled", user_id)
    return {"status": "success", "message": "Meeting cancelled", "meeting": updated}


def handle_edit(identity: dict, action: str, data: str | None) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    if not data:
        raise HTTPException(status_code=400, detail="Missing data for edit")
    try:
        payload = models.MeetingEditSchema(**json.loads(data))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid edit data: {exc}")
    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("creatorUserId") != user_id:
        raise HTTPException(status_code=403, detail="Only the organizer can edit a meeting")

    if meeting.get("status") == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot edit a cancelled meeting")

    original_status = meeting.get("status")
    needs_regen = original_status == "pending"

    if payload.daysForward is not None:
        meeting["daysForward"] = payload.daysForward
    if payload.preferredHours is not None:
        meeting["preferredHours"] = payload.preferredHours
    if payload.excludedWeekdays is not None:
        meeting["excludedWeekdays"] = payload.excludedWeekdays

    updated = _meeting_repo.edit(
        request_id, user_id,
        title=payload.title,
        duration_minutes=payload.durationMinutes,
        description=payload.description,
        days_forward=payload.daysForward,
    )

    if needs_regen and updated:
        # Apply preference changes to the fresh `updated` dict (edit() re-fetches from DB)
        if payload.preferredHours is not None:
            updated["preferredHours"] = payload.preferredHours
        if payload.excludedWeekdays is not None:
            updated["excludedWeekdays"] = payload.excludedWeekdays
        days_forward = int(updated.get("daysForward") or 7)
        now = datetime.now()
        updated.update({
            "dateRangeStart": now.isoformat(),
            "dateRangeEnd": (now + timedelta(days=days_forward)).isoformat(),
        })
        _meeting_repo.update_meta(request_id, updated)
        _meeting_repo.delete_slots(request_id)
        from src.handlers.api._scheduling import build_reschedule_payload, run_local_steps
        sched_payload = build_reschedule_payload(
            updated, user_id, request_id, days_forward,
            preferred_hours=payload.preferredHours,
            excluded_weekdays=payload.excludedWeekdays,
        )
        run_local_steps(sched_payload)

    # Editing a confirmed meeting clears participant responses so everyone must respond again.
    if updated and original_status == "confirmed":
        if payload.preferredHours is not None:
            updated["preferredHours"] = payload.preferredHours
        if payload.excludedWeekdays is not None:
            updated["excludedWeekdays"] = payload.excludedWeekdays
        now = datetime.now()
        updated["acceptedBy"] = []
        updated["declinedBy"] = []
        updated["declineDetails"] = {}
        updated["updatedAt"] = now.isoformat()
        _meeting_repo.update_meta(request_id, updated)
        external_ids = updated.get("externalEventIds") or {}
        if external_ids:
            try:
                start_iso = updated.get("selectedSlotStart", "")
                dur = int(updated.get("durationMinutes", 60))
                if start_iso:
                    end_iso = (datetime.fromisoformat(start_iso) + timedelta(minutes=dur)).isoformat()
                    calendar_client.update_meeting_in_calendars(
                        external_ids=external_ids,
                        title=updated.get("title", "Meeting"),
                        start_iso=start_iso, end_iso=end_iso,
                    )
            except Exception:
                pass
    _meeting_repo.log_activity(request_id, "edited", user_id)
    return {"status": "success", "meeting": updated, "slotsRegenerated": needs_regen}


def handle_book_custom(identity: dict, action: str, data: str | None) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    if not data:
        raise HTTPException(status_code=400, detail="Missing data for book_custom")
    try:
        slot_info = json.loads(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid book_custom data: {exc}")

    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("creatorUserId") != user_id:
        raise HTTPException(status_code=403, detail="Only the organizer can book a slot")

    slot_start_iso = slot_info.get("startIso", "")
    slot_end_iso = slot_info.get("endIso", "")
    fairness_impact = float(slot_info.get("fairnessImpact", -2.0))
    if not slot_start_iso:
        raise HTTPException(status_code=400, detail="startIso is required")

    effective_end = slot_end_iso or (
        datetime.fromisoformat(slot_start_iso) + timedelta(minutes=int(meeting.get("durationMinutes", 60)))
    ).isoformat()
    slot = models.SuggestedTimeSlot(
        requestId=request_id,
        startIso=datetime.fromisoformat(slot_start_iso),
        endIso=datetime.fromisoformat(effective_end),
        score=float(slot_info.get("score", 50.0)),
        fairnessImpact=fairness_impact,
        conflictCount=slot_info.get("conflictCount", 0),
        explanation=slot_info.get("explanation", "Manually selected time"),
    )
    _meeting_repo.write_slot(request_id, slot_start_iso, slot.model_dump(mode="json"))
    _apply_personal_fairness(user_id, datetime.fromisoformat(slot_start_iso), int(meeting.get("durationMinutes", 60)))
    meeting["status"] = "confirmed"
    meeting["selectedSlotStart"] = slot_start_iso
    _meeting_repo.update_meta(request_id, meeting)
    _meeting_repo.log_activity(request_id, "booked", user_id, {"custom": True})

    ics_content = calendar_client.generate_ics_content(
        title=meeting.get("title", "Meeting"), start_iso=slot_start_iso, end_iso=effective_end
    )
    write_result = _write_to_calendars(meeting, slot_start_iso, effective_end, request_id)
    return {
        "status": "success",
        "message": "Custom time booked successfully",
        "meeting": meeting,
        "icsContent": ics_content,
        "calendarSyncWarning": _calendar_warning(user_id, write_result),
    }


def handle_reschedule(identity: dict, action: str, data: str | None) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("creatorUserId") != user_id:
        raise HTTPException(status_code=403, detail="Only the organizer can reschedule")
    if meeting.get("status") == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot reschedule a cancelled meeting")

    # `daysForward` on the record preserves the user's original intent (the
    # LLM parser can return 1 for "tomorrow"/"on Friday"). For the reschedule
    # search itself, floor at 7 days so once we shift the anchor to `now`
    # there's enough room left for slots to survive working-days, conflicts,
    # and past-hour filtering.
    search_days = max(int(meeting.get("daysForward") or 7), 7)

    now = datetime.now()
    if ext_ids := meeting.get("externalEventIds", {}):
        calendar_client.remove_meeting_from_calendars(ext_ids)

    # Reverse fairness for organizer + all participants who had accepted
    accepted_pids = meeting.get("acceptedBy", [])
    for uid in set([user_id] + list(accepted_pids)):
        _reverse_personal_fairness(uid)

    meeting.update({
        "status": "pending",
        "selectedSlotStart": None,
        "acceptedBy": [],
        "dateRangeStart": now.isoformat(),
        "dateRangeEnd": (now + timedelta(days=search_days)).isoformat(),
        "updatedAt": now.isoformat(),
        "externalEventIds": {},
    })
    _meeting_repo.update_meta(request_id, meeting)
    _meeting_repo.delete_slots(request_id)

    from src.handlers.api._scheduling import build_reschedule_payload, run_local_steps, _run_ai_inline
    payload = build_reschedule_payload(meeting, user_id, request_id, search_days)
    run_local_steps(payload)

    ai_fields = _run_ai_inline(request_id, payload)
    if ai_fields:
        meeting.update(ai_fields)
        _meeting_repo.update_meta(request_id, meeting)

    _meeting_repo.log_activity(request_id, "rescheduled", user_id, {"searchDays": search_days})
    return {"status": "success", "message": "Meeting rescheduled — new slots generated"}


def handle_score_slot(identity: dict, data: str | None) -> dict:
    if not data:
        raise HTTPException(status_code=400, detail="Missing data for score_slot")
    try:
        payload = json.loads(data)
        start_iso = payload.get("startIso", "")
        duration_minutes = int(payload.get("durationMinutes", 60))
        participant_ids = payload.get("participantIds", [])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid score_slot data: {exc}")
    if not start_iso:
        raise HTTPException(status_code=400, detail="startIso is required")
    try:
        user_id = identity["user_id"]
        slot_dt = datetime.fromisoformat(start_iso)
        end_dt = slot_dt + timedelta(minutes=duration_minutes)
        all_ids = list(set([user_id] + participant_ids))

        participant_states = []
        participant_tz_offsets = []
        participant_working_days = []
        for uid in all_ids:
            state = _user_repo.get_fairness(uid)
            if state:
                participant_states.append(state.model_dump(mode="json"))
            p = _user_repo.get_profile_raw(uid)
            if p:
                participant_tz_offsets.append(get_tz_offset_hours(p.get("timezone", "UTC")))
                participant_working_days.append(p.get("workingDays", [0, 1, 2, 3, 4]))

        user_profile = _user_repo.get_profile_raw(user_id)
        tz_offset = get_tz_offset_hours((user_profile or {}).get("timezone", "UTC"))
        organizer_working_days = (user_profile or {}).get("workingDays", [0, 1, 2, 3, 4])

        # Deterministic engine baseline — same scorer the SFN workflow uses
        result = fairness_engine.score_time_slot(
            slot_dt, participant_states, duration_minutes,
            tz_offset_hours=tz_offset,
            participant_tz_offsets=participant_tz_offsets or None,
            participant_working_days=participant_working_days or None,
            organizer_working_days=organizer_working_days,
        )

        # AI overlay — same flow as `_run_ai_inline` uses for meeting creation.
        # Heuristic score is passed in as the AI's reference; AI overrides it.
        from src.core.ai_fairness import score_meeting_with_ai
        from src.handlers.api._scheduling import build_participants_context

        ai_scored = False
        ai_suggestions = None
        try:
            participants_context = build_participants_context(
                user_id, participant_ids or [],
                slot_dt - timedelta(hours=24),
                slot_dt + timedelta(hours=24),
            )
            ai_result = score_meeting_with_ai(
                request_id="score_slot_preview",
                candidate_slots=[{
                    "startIso": start_iso,
                    "score": result["score"],
                    "explanation": result.get("explanation", ""),
                    "conflictCount": result.get("conflictCount", 0),
                }],
                participants=participants_context,
            )
            if ai_result.get("method") == "ai":
                slot_scores = ai_result.get("slot_scores") or []
                if slot_scores:
                    entry = slot_scores[0]
                    result["score"] = float(entry.get("ai_score", result["score"]))
                    result["explanation"] = entry.get("description") or result.get("explanation", "")
                    ai_scored = True
                cal_sugg = ai_result.get("calendar_suggestions") or []
                if cal_sugg:
                    ai_suggestions = "; ".join(str(s) for s in cal_sugg[:2])
                elif ai_result.get("best_slot_reason"):
                    ai_suggestions = ai_result["best_slot_reason"]
        except Exception as e:
            logger.warning(f"score_slot AI failed, using engine: {e}")

        return {
            "startIso": start_iso,
            "endIso": end_dt.isoformat(),
            "score": result["score"],
            "fairnessImpact": result["fairnessImpact"],
            "explanation": result["explanation"],
            "conflictCount": result.get("conflictCount", 0),
            "aiScored": ai_scored,
            "aiSuggestions": ai_suggestions,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Scoring failed: {exc}")


def handle_parse_meeting_nl(identity: dict, data: str | None) -> dict:
    """Parse free-text meeting request → prefill fields for the create modal."""
    if not data:
        raise HTTPException(status_code=400, detail="Missing data for parse_meeting_nl")
    try:
        text = (json.loads(data).get("text") or "").strip()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid parse_meeting_nl data: {exc}")
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    from src.common import openai_client

    user_id = identity["user_id"]
    known_users = []
    try:
        known_users = _user_repo.get_all_users(user_id)
    except Exception:
        pass

    try:
        parsed = openai_client.parse_meeting_intent(
            text=text,
            today_iso=datetime.now().date().isoformat(),
            known_users=known_users,
        )
    except openai_client.OpenAIScoreError as e:
        logger.warning(f"parse_meeting_nl failed: {e}")
        raise HTTPException(status_code=503, detail=f"AI parser unavailable: {e}")

    # Resolve participantHints → real users (matches displayName or email, case-insensitive)
    resolved_users = []
    hints_lower = [h.lower() for h in parsed["participantHints"]]
    seen_ids: set = set()
    for u in known_users:
        uid = u.get("userId", "")
        if uid == user_id or uid in seen_ids:
            continue
        name = (u.get("displayName") or "").lower()
        email = (u.get("email") or "").lower()
        for h in hints_lower:
            if h and (h == name or h == email or h in name or h in email):
                resolved_users.append({
                    "userId": uid,
                    "displayName": u.get("displayName", ""),
                    "email": u.get("email", ""),
                })
                seen_ids.add(uid)
                break

    return {
        "title": parsed["title"],
        "durationMinutes": parsed["durationMinutes"],
        "daysForward": parsed["daysForward"],
        "dateRangeStart": parsed["dateRangeStart"],
        "timeWindow": parsed["timeWindow"],
        "excludedWeekdays": parsed["excludedWeekdays"],
        "description": parsed["description"],
        "participants": resolved_users,
        "unmatchedHints": [h for h in parsed["participantHints"]
                          if not any(h.lower() == ru["displayName"].lower() or h.lower() == ru["email"].lower()
                                     or h.lower() in ru["displayName"].lower() or h.lower() in ru["email"].lower()
                                     for ru in resolved_users)],
    }


def handle_meeting_log(identity: dict, action: str) -> list:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("creatorUserId") != user_id and user_id not in meeting.get("participantUserIds", []):
        raise HTTPException(status_code=403, detail="Access denied")
    return _meeting_repo.get_activity_log(request_id)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _safe_get_calendar(uid: str, slot_utc: datetime, duration_minutes: int) -> list:
    """Returns calendar events ±24h around the slot. Never raises."""
    try:
        return calendar_client.get_user_busy_slots(
            uid,
            slot_utc - timedelta(hours=24),
            slot_utc + timedelta(hours=24),
        )
    except Exception as exc:
        logger.warning(f"[fairness_update] calendar fetch failed for {uid}: {exc}")
        return []


def _apply_personal_fairness(uid: str, slot_utc: datetime, duration_minutes: int) -> None:
    """Calculate and persist one participant's personal fairness update."""
    try:
        profile   = _user_repo.get_profile_raw(uid) or {}
        fairness  = _user_repo.get_fairness(uid)
        mtw = int(float(
            (fairness.meetingLoadMetrics or {}).get("meetings_this_week", 0)
        )) if fairness else 0
        impact, breakdown = fairness_engine.personal_impact_for_participant(
            slot_utc,
            get_tz_offset_hours(profile.get("timezone", "UTC")),
            profile.get("workingDays", [0, 1, 2, 3, 4]),
            profile.get("workingHours", {"start": "09:00", "end": "18:00"}),
            profile.get("lunchBreak"),
            mtw,
            _safe_get_calendar(uid, slot_utc, duration_minutes),
            duration_minutes,
        )
        _user_repo.update_fairness_for_single(uid, impact, breakdown)
    except Exception as exc:
        logger.warning(f"[fairness_update] skipped for {uid}: {exc}")


def _reverse_personal_fairness(uid: str) -> None:
    """Undo the last booking's fairness delta for one user."""
    try:
        _user_repo.reverse_fairness_for_single(uid)
    except Exception as exc:
        logger.warning(f"[fairness_reversal] skipped for {uid}: {exc}")


def _compute_end_iso(start_iso: str, slot_data: dict | None, meeting: dict) -> str:
    if slot_data and slot_data.get("endIso"):
        return slot_data["endIso"]
    return (
        datetime.fromisoformat(start_iso) + timedelta(minutes=int(meeting.get("durationMinutes", 60)))
    ).isoformat()


def _write_to_calendars(meeting: dict, start_iso: str, end_iso: str, request_id: str) -> dict:
    try:
        result = calendar_client.write_meeting_to_calendars(
            creator_id=meeting.get("creatorUserId", ""),
            participant_ids=meeting.get("participantUserIds", []),
            title=meeting.get("title", "Meeting"),
            start_iso=start_iso,
            end_iso=end_iso,
        )
        if result.get("event_ids"):
            meeting["externalEventIds"] = result["event_ids"]
            _meeting_repo.update_meta(request_id, meeting)
        return result
    except Exception:
        return {"event_ids": {}, "failed": []}


def _calendar_warning(user_id: str, write_result: dict) -> str | None:
    if user_id in write_result.get("failed", []) and _user_repo.has_oauth_tokens(user_id, "google"):
        return "Couldn't sync to Google Calendar. Your token may have expired — reconnect in Profile."
    return None
