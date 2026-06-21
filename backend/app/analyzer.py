from __future__ import annotations

from dataclasses import dataclass

from .models import FlightDeal, TrackingRoute


@dataclass(frozen=True)
class DealAnalysis:
    should_notify: bool
    is_error_fare: bool
    drop_percent: float | None
    reasons: list[str]


def analyze_deal(
    deal: FlightDeal,
    route: TrackingRoute,
    baseline: dict[str, float | int | None],
    telegram_drop_percent: float,
    error_fare_percent: float,
) -> DealAnalysis:
    reasons: list[str] = []
    min_price = baseline.get("min_price")
    avg_price = baseline.get("avg_price")
    sample_count = int(baseline.get("sample_count") or 0)

    drop_from_min = _drop_percent(min_price, deal.price)
    drop_from_avg = _drop_percent(avg_price, deal.price)
    meaningful_drop = max([value for value in [drop_from_min, drop_from_avg] if value is not None], default=None)

    is_new_minimum = min_price is None or deal.price < int(min_price)
    is_price_threshold = route.price_threshold is not None and deal.price <= route.price_threshold
    is_error_fare = sample_count >= 3 and drop_from_avg is not None and drop_from_avg >= error_fare_percent
    is_regular_drop = meaningful_drop is not None and meaningful_drop >= telegram_drop_percent

    if is_new_minimum:
        reasons.append("new_minimum")
    if is_regular_drop:
        reasons.append("price_drop")
    if is_price_threshold:
        reasons.append("below_threshold")
    if route.notify_error_fare and is_error_fare:
        reasons.append("error_fare_candidate")

    return DealAnalysis(
        should_notify=bool(reasons),
        is_error_fare=is_error_fare,
        drop_percent=meaningful_drop,
        reasons=reasons,
    )


def _drop_percent(old_value: float | int | None, new_value: int) -> float | None:
    if not old_value or old_value <= 0 or new_value >= old_value:
        return None
    return round(((float(old_value) - new_value) / float(old_value)) * 100, 2)
