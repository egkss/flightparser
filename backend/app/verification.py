from __future__ import annotations

from collections import defaultdict

from .models import PriceHistoryItem, VerifiedHistoryItem


def dedupe_latest(results: list[PriceHistoryItem]) -> list[PriceHistoryItem]:
    unique = {}
    for item in results:
        key = (item.route_id, item.depart_date, item.source, item.flight_number, item.price)
        unique.setdefault(key, item)
    return list(unique.values())


def enrich_results(
    results: list[PriceHistoryItem],
    context: list[PriceHistoryItem],
) -> list[VerifiedHistoryItem]:
    by_route_date: dict[tuple[int | None, object], list[PriceHistoryItem]] = defaultdict(list)
    for item in context:
        by_route_date[(item.route_id, item.depart_date)].append(item)

    enriched = []
    for item in results:
        comparable = [
            candidate
            for candidate in by_route_date[(item.route_id, item.depart_date)]
            if _prices_close(item.price, candidate.price, 0.08)
        ]
        sources = sorted({candidate.source for candidate in comparable})
        repeated_checks = sum(
            1
            for candidate in comparable
            if candidate.source == item.source
            and candidate.flight_number == item.flight_number
            and _prices_close(item.price, candidate.price, 0.03)
        )
        has_multiple_sources = len(sources) >= 2
        has_rechecks = repeated_checks >= 3
        confidence = "high" if has_multiple_sources and has_rechecks else "medium" if has_multiple_sources or has_rechecks else "low"
        enriched.append(
            VerifiedHistoryItem(
                **item.model_dump(),
                confidence=confidence,
                confirmation_sources=sources,
                repeated_checks=max(1, repeated_checks),
            )
        )
    return enriched


def _prices_close(left: int, right: int, tolerance: float) -> bool:
    return abs(left - right) <= max(left, right) * tolerance
