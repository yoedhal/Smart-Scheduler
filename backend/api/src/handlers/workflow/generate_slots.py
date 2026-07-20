"""
SFN State: GenerateCandidateSlots

Input:  full payload from FetchParticipantData
Output: adds candidate_slots (list of {startIso, endIso, conflictCount})

Pre-computes per-slot conflict counts so CalculateFairnessScores does not
need to re-fetch calendar data.

Filter pipeline:
  1. All-day events on specific calendar dates → exclude those dates entirely
     (all-day events from Google Calendar appear as 24 h midnight-to-midnight
     blocks after _to_utc_iso normalisation).
  2. Creator has a conflict at the slot time → hard-remove the slot.
  3. Majority of participants conflict → hard-remove the slot.
"""
import logging
from datetime import datetime, timedelta
from typing import Dict

from src.common import calendar_client as _cc
from src.common.time_utils import collect_all_day_dates, parse_naive_utc
from src.core.fairness import engine

logger = logging.getLogger(__name__)


def handler(payload: dict) -> dict:
    request_id = payload.get("request_id", "?")
    date_start = datetime.fromisoformat(payload["date_range_start"])
    date_end = datetime.fromisoformat(payload["date_range_end"])
    duration_minutes = payload.get("duration_minutes", 60)
    tz_offset = float(payload.get("tz_offset_hours", 0.0))
    creator_id = payload.get("creator_id", "")
    all_ids = list({creator_id} | set(payload.get("participant_ids", [])))

    preferred_hours = payload.get("preferred_hours")
    excluded_weekdays = set(payload.get("excluded_weekdays") or [])

    logger.info(
        f"[sfn:generate_slots] START request_id={request_id} "
        f"range={payload['date_range_start']} → {payload['date_range_end']} "
        f"duration={duration_minutes}m tz_offset={tz_offset} "
        f"participants={len(all_ids)} preferred_hours={preferred_hours} "
        f"excluded_weekdays={sorted(excluded_weekdays)}"
    )

    FULL_DAY_HOURS = list(range(7, 22))
    wh_list = FULL_DAY_HOURS

    # Intersect every participant's workingDays so we never schedule on a day
    # someone doesn't work. If the intersection is empty (totally disjoint
    # schedules — e.g. one is Sun-Thu and another is Fri-Sat) fall back to the
    # union so the meeting can still be scheduled with a fairness penalty.
    profiles = payload.get("participant_profiles", []) or []
    if profiles:
        intersected_wd: set = set(range(7))
        union_wd: set = set()
        for p in profiles:
            pwd = set(p.get("workingDays") or [0, 1, 2, 3, 4])
            intersected_wd &= pwd
            union_wd |= pwd
        if not intersected_wd:
            logger.warning(
                f"[sfn:generate_slots] request_id={request_id} working_day intersection is empty "
                f"— falling back to union {sorted(union_wd)}"
            )
        allowed_wd = intersected_wd if intersected_wd else (union_wd or set(range(7)))
    else:
        allowed_wd = set(range(7))

    wd_list = sorted(allowed_wd - excluded_weekdays)
    logger.info(f"[sfn:generate_slots] request_id={request_id} allowed_weekdays={wd_list}")

    candidates = engine.generate_candidate_slots(
        date_start, date_end,
        tz_offset_hours=tz_offset,
        working_hours=wh_list,
        working_days=wd_list,
    )
    end_delta = timedelta(minutes=duration_minutes)
    logger.info(f"[sfn:generate_slots] request_id={request_id} raw_candidates={len(candidates)}")

    # Fetch calendar busy intervals for all participants (best-effort)
    all_busy: Dict[str, list] = {}
    for uid in all_ids:
        try:
            busy = _cc.get_user_busy_slots(uid, date_start, date_end)
            if busy:
                all_busy[uid] = busy
                logger.info(f"[sfn:generate_slots] calendar uid={uid} busy_intervals={len(busy)}")
            else:
                logger.info(f"[sfn:generate_slots] calendar uid={uid} no busy intervals")
        except Exception as e:
            logger.warning(f"[sfn:generate_slots] calendar fetch failed uid={uid}: {e}")

    # Supplement creator busy with confirmed Smart Scheduler meetings (covers
    # users without a connected external calendar).
    request_id = payload.get("request_id", "")
    try:
        from src.database.repository import MeetingRepository
        _mtg_repo = MeetingRepository()
        for m in _mtg_repo.get_user_meetings(creator_id):
            if (
                m.status == "confirmed"
                and m.selectedSlotStart
                and m.requestId != request_id
            ):
                s = parse_naive_utc(str(m.selectedSlotStart))
                if s is not None:
                    e = s + timedelta(minutes=int(m.durationMinutes or 60))
                    all_busy.setdefault(creator_id, []).append(
                        {"start": s.isoformat(), "end": e.isoformat()}
                    )
    except Exception as _exc:
        logger.warning(f"[generate_slots] SS busy fetch failed for {creator_id}: {_exc}")

    creator_busy = all_busy.get(creator_id, [])

    # Filter 1 — exclude entire calendar dates blocked by creator's all-day events
    all_day_dates = collect_all_day_dates(creator_busy)
    if all_day_dates:
        before = len(candidates)
        candidates = [c for c in candidates if c.date() not in all_day_dates]
        logger.info(
            f"[sfn:generate_slots] filter1_allday request_id={request_id} "
            f"blocked_dates={sorted(str(d) for d in all_day_dates)} "
            f"removed={before - len(candidates)} remaining={len(candidates)}"
        )
    else:
        logger.info(f"[sfn:generate_slots] filter1_allday request_id={request_id} no all-day blocks")

    # Filter 2 — hard-remove slots where the creator has a regular-event conflict
    if creator_busy:
        def _creator_conflict(slot_dt: datetime) -> bool:
            slot_end = slot_dt + end_delta
            for b in creator_busy:
                b_start = parse_naive_utc(b.get("start", ""))
                b_end = parse_naive_utc(b.get("end", ""))
                if b_start is None or b_end is None:
                    continue
                if slot_dt < b_end and slot_end > b_start:
                    return True
            return False
        before = len(candidates)
        candidates = [c for c in candidates if not _creator_conflict(c)]
        logger.info(
            f"[sfn:generate_slots] filter2_creator request_id={request_id} "
            f"removed={before - len(candidates)} remaining={len(candidates)}"
        )
    else:
        logger.info(f"[sfn:generate_slots] filter2_creator request_id={request_id} creator has no busy intervals — skipped")

    # Filter 3 — remove slots where the majority of participants conflict.
    # Slots that survive with conflictCount > 0 receive a heavy score penalty
    # in calculate_fairness (proportional to conflict_ratio).
    def _conflict_count(slot_dt: datetime) -> int:
        slot_end = slot_dt + end_delta
        count = 0
        for uid, busy_list in all_busy.items():
            for b in busy_list:
                b_start = parse_naive_utc(b.get("start", ""))
                b_end = parse_naive_utc(b.get("end", ""))
                if b_start is None or b_end is None:
                    continue
                if slot_dt < b_end and slot_end > b_start:
                    count += 1
                    break
        return count

    majority_threshold = len(all_ids) / 2
    logger.info(
        f"[sfn:generate_slots] filter3_majority request_id={request_id} "
        f"threshold={majority_threshold:.1f} (participants={len(all_ids)})"
    )
    candidate_slots = []
    majority_removed = 0
    slots_with_conflicts = 0
    preferred_count = 0
    for dt in candidates:
        cc = _conflict_count(dt)
        if cc > majority_threshold:
            majority_removed += 1
            continue
        local_hour = int((dt.hour + round(tz_offset)) % 24)
        is_preferred = preferred_hours is None or local_hour in preferred_hours
        if cc > 0:
            slots_with_conflicts += 1
        if is_preferred:
            preferred_count += 1
        candidate_slots.append({
            "startIso": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endIso": (dt + end_delta).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "conflictCount": cc,
            "isPreferred": is_preferred,
        })

    logger.info(
        f"[sfn:generate_slots] DONE request_id={request_id} "
        f"final_slots={len(candidate_slots)} "
        f"majority_removed={majority_removed} "
        f"slots_with_conflicts={slots_with_conflicts} "
        f"preferred={preferred_count}"
    )
    payload["candidate_slots"] = candidate_slots
    return payload
