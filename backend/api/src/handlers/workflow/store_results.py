"""
SFN State: StoreResults

Persists the final ranked slots to DynamoDB by selecting the best from
scored_slots.

Meeting-level AI verdict is written separately by `_scheduling._run_ai_inline`
after this step completes.

Input:  payload with request_id and scored_slots
Output: adds stored_slots_count
"""
import logging
from datetime import datetime

from src.database import models
from src.database.repository import MeetingRepository

logger = logging.getLogger(__name__)
_meeting_repo = MeetingRepository()


def handler(payload: dict) -> dict:
    request_id = payload["request_id"]
    scored_slots = payload.get("scored_slots", [])

    logger.info(
        f"[sfn:store_results] START request_id={request_id} "
        f"scored_slots={len(scored_slots)}"
    )

    from src.core.fairness import engine
    from datetime import datetime as _dt
    try:
        days_forward = max(1, (_dt.fromisoformat(payload["date_range_end"]) - _dt.fromisoformat(payload["date_range_start"])).days)
    except Exception:
        days_forward = 7
    slot_count = min(50, max(10, days_forward * 4))
    logger.info(
        f"[sfn:store_results] selecting request_id={request_id} "
        f"days_forward={days_forward} slot_count_cap={slot_count}"
    )
    best_slots = engine.select_best_slots(scored_slots, count=slot_count)

    if best_slots:
        top = best_slots[0]
        logger.info(
            f"[sfn:store_results] top_slot request_id={request_id} "
            f"startIso={top.get('startIso')} score={top.get('score', 0):.1f} "
            f"conflictCount={top.get('conflictCount', 0)}"
        )

    for slot_data in best_slots:
        slot = models.SuggestedTimeSlot(
            requestId=request_id,
            startIso=datetime.fromisoformat(slot_data["startIso"].replace("Z", "+00:00")),
            endIso=datetime.fromisoformat(slot_data["endIso"].replace("Z", "+00:00")),
            score=float(slot_data["score"]),
            fairnessImpact=float(slot_data["fairnessImpact"]),
            conflictCount=slot_data.get("conflictCount", 0),
            explanation=slot_data["explanation"],
            aiScored=bool(slot_data.get("aiScored", False)),
            aiSuggestions=slot_data.get("aiSuggestions"),
            isPreferred=bool(slot_data.get("isPreferred", False)),
        )
        _meeting_repo.write_slot(
            request_id,
            slot.startIso.isoformat(),
            slot.model_dump(mode="json"),
        )

    creator_id = payload.get("creator_id", "")
    if creator_id:
        try:
            _meeting_repo.log_activity(request_id, "created", creator_id)
        except Exception as e:
            logger.warning(f"store_results: failed to log created activity: {e}")

    logger.info(
        f"[sfn:store_results] DONE request_id={request_id} "
        f"stored={len(best_slots)}"
    )
    payload["stored_slots_count"] = len(best_slots)
    return payload
