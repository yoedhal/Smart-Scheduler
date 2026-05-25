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
        all_pids: set = set()
        for m in meetings:
            all_pids.update(m.participantUserIds)
        name_map = _user_repo.get_by_ids(list(all_pids))
        result = []
        for m in meetings:
            slots = _meeting_repo.get_slots(m.requestId)
            d = m.model_dump(mode="json")
            d["slots"] = [s.model_dump(mode="json") for s in slots]
            d["userRole"] = "organizer" if m.creatorUserId == user_id else "participant"
            d["participantNames"] = {
                pid: name_map.get(pid, {"name": pid, "email": ""})
                for pid in m.participantUserIds
            }
            result.append(d)
        return result
    except Exception as exc:
        logger.warning(f"[meetings] failed for {user_id}: {exc}")
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
    fairness_impact = float(slot_data.get("fairnessImpact", -2.0)) if slot_data else -2.0
    all_pids = list(set([meeting.get("creatorUserId", "")] + meeting.get("participantUserIds", [])))

    # Confirm slot first (conditional write — raises 409 if slot already taken)
    _meeting_repo.confirm_slot(request_id, slot_start_iso)
    # Update fairness only after successful confirmation to avoid double-penalising on concurrent books
    _user_repo.update_fairness_on_booking(all_pids, fairness_impact)
    _meeting_repo.log_activity(request_id, "booked", user_id)

    # Update local dict to reflect the confirmed state so the response is accurate
    meeting["status"] = "confirmed"
    meeting["selectedSlotStart"] = slot_start_iso
    meeting["updatedAt"] = datetime.now().isoformat()

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
    return {"status": "success", "message": "Meeting accepted", "acceptedBy": accepted}


def handle_decline(identity: dict, action: str) -> dict:
    request_id = action.split(":", 1)[1]
    user_id = identity["user_id"]
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
    meeting["declinedBy"] = declined
    meeting["acceptedBy"] = [u for u in meeting.get("acceptedBy", []) if u != user_id]
    meeting["updatedAt"] = datetime.now().isoformat()
    _meeting_repo.update_meta(request_id, meeting)
    _meeting_repo.log_activity(request_id, "declined", user_id)
    try:
        decliner_profile = _user_repo.get_profile(user_id)
        decliner_name = decliner_profile.displayName if decliner_profile else "A participant"
        _user_repo.send_message(
            from_uid=user_id,
            to_uid=meeting.get("creatorUserId", ""),
            content=f'{decliner_name} declined your meeting: "{meeting.get("title", "Meeting")}"',
            msg_type="general",
        )
    except Exception as e:
        logger.warning(f"Failed to send decline notification: {e}")
    return {"status": "success", "message": "Meeting declined", "declinedBy": declined}


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
            calendar_client.remove_meeting_from_calendars(ext_ids)
        except Exception as exc:
            logger.error(f"Calendar delete failed during cancel for {request_id}: {exc}")
    updated = _meeting_repo.cancel(request_id, user_id)
    _user_repo.update_fairness_on_cancel(user_id)
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

    duration_changed = payload.durationMinutes is not None and payload.durationMinutes != meeting.get("durationMinutes")
    horizon_changed = payload.daysForward is not None and payload.daysForward != meeting.get("daysForward", 7)
    needs_regen = (duration_changed or horizon_changed) and meeting.get("status") == "pending"

    if payload.daysForward is not None:
        meeting["daysForward"] = payload.daysForward

    updated = _meeting_repo.edit(
        request_id, user_id,
        title=payload.title,
        duration_minutes=payload.durationMinutes,
        description=payload.description,
        days_forward=payload.daysForward,
    )

    if needs_regen and updated:
        days_forward = updated.get("daysForward", 7)
        now = datetime.now()
        updated.update({
            "dateRangeStart": now.isoformat(),
            "dateRangeEnd": (now + timedelta(days=days_forward)).isoformat(),
        })
        _meeting_repo.update_meta(request_id, updated)
        _meeting_repo.delete_slots(request_id)
        from src.handlers.api._scheduling import build_reschedule_payload, run_local_steps
        sched_payload = build_reschedule_payload(updated, user_id, request_id, days_forward)
        run_local_steps(sched_payload)

    if updated and updated.get("status") == "confirmed":
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
    all_pids = list(set([meeting.get("creatorUserId", "")] + meeting.get("participantUserIds", [])))
    _user_repo.update_fairness_on_booking(all_pids, fairness_impact)
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
    days_forward = 7
    if data:
        try:
            days_forward = int(json.loads(data).get("daysForward", 7))
        except Exception:
            pass

    meeting = _meeting_repo.get_meta(request_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.get("creatorUserId") != user_id:
        raise HTTPException(status_code=403, detail="Only the organizer can reschedule")
    if meeting.get("status") == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot reschedule a cancelled meeting")

    now = datetime.now()
    if ext_ids := meeting.get("externalEventIds", {}):
        calendar_client.remove_meeting_from_calendars(ext_ids)

    meeting.update({
        "status": "pending",
        "selectedSlotStart": None,
        "acceptedBy": [],
        "dateRangeStart": now.isoformat(),
        "dateRangeEnd": (now + timedelta(days=days_forward)).isoformat(),
        "updatedAt": now.isoformat(),
        "externalEventIds": {},
    })
    _meeting_repo.update_meta(request_id, meeting)
    _meeting_repo.delete_slots(request_id)

    from src.handlers.api._scheduling import build_reschedule_payload, run_local_steps
    payload = build_reschedule_payload(meeting, user_id, request_id, days_forward)
    run_local_steps(payload)
    _meeting_repo.log_activity(request_id, "rescheduled", user_id, {"daysForward": days_forward})
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

        result = fairness_engine.score_time_slot(
            slot_dt, participant_states, duration_minutes,
            tz_offset_hours=tz_offset,
            participant_tz_offsets=participant_tz_offsets or None,
            participant_working_days=participant_working_days or None,
        )
        return {
            "startIso": start_iso,
            "endIso": end_dt.isoformat(),
            "score": result["score"],
            "fairnessImpact": result["fairnessImpact"],
            "explanation": result["explanation"],
            "conflictCount": result.get("conflictCount", 0),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Scoring failed: {exc}")


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
