from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .analyzer import analyze_deal
from .aviasales_client import AviasalesClient
from .config import Settings
from .database import Database
from .models import FlightDeal, MonitorRunResult, SearchRequest, TrackingRoute
from .telegram_notifier import TelegramNotifier


@dataclass(frozen=True)
class IngestOutcome:
    saved_items: int
    sent_notifications: int
    error_dates: list[date]


class PriceMonitor:
    def __init__(
        self,
        database: Database,
        client: AviasalesClient,
        notifier: TelegramNotifier,
        settings: Settings,
    ) -> None:
        self.database = database
        self.client = client
        self.notifier = notifier
        self.settings = settings

    async def run_once(self) -> MonitorRunResult:
        routes = await self.database.list_routes(active_only=True)
        saved_items = 0
        sent_notifications = 0

        for route in routes:
            request = SearchRequest(
                origin=route.origin,
                destination=route.destination,
                date_from=route.date_from,
                date_to=route.date_to,
                direct_only=route.direct_only,
                baggage_required=route.baggage_required,
                price_threshold=route.price_threshold,
                notify_error_fare=route.notify_error_fare,
            )
            deals = await self.client.search_window(request, route.origin_code, route.destination_code)
            outcome = await self.ingest_deals(route, deals[:3])
            saved_items += outcome.saved_items
            sent_notifications += outcome.sent_notifications
            if outcome.error_dates:
                saved_items += await self._recheck_error_fares(route, request, outcome.error_dates)

        return MonitorRunResult(
            checked_routes=len(routes),
            saved_items=saved_items,
            sent_notifications=sent_notifications,
        )

    async def ingest_deals(
        self,
        route: TrackingRoute,
        deals: list[FlightDeal],
        allow_notifications: bool = True,
    ) -> IngestOutcome:
        notification_payload = []
        notification_fingerprints = []
        saved_items = 0
        error_dates: set[date] = set()

        for deal in deals:
            baseline = await self.database.baseline_stats(route.id)
            analysis = analyze_deal(
                deal,
                route,
                baseline,
                self.settings.telegram_drop_percent,
                self.settings.error_fare_percent,
            )
            await self.database.save_deal(
                deal,
                route_id=route.id,
                is_error_fare=analysis.is_error_fare,
                drop_percent=analysis.drop_percent,
            )
            saved_items += 1
            if analysis.is_error_fare:
                error_dates.add(deal.depart_date)
            if allow_notifications and analysis.should_notify:
                fingerprint = self._notification_fingerprint(route, deal)
                if await self.database.notification_was_sent(fingerprint):
                    continue
                notification_payload.append(
                    (deal, analysis.drop_percent, analysis.is_error_fare, analysis.reasons)
                )
                notification_fingerprints.append(fingerprint)

        sent_notifications = 0
        if notification_payload:
            did_send = await self.notifier.send_deals(route, notification_payload[:3])
            sent_notifications = int(did_send)
            if did_send:
                for fingerprint in notification_fingerprints[:3]:
                    await self.database.mark_notification_sent(fingerprint)
        return IngestOutcome(saved_items, sent_notifications, sorted(error_dates))

    async def _recheck_error_fares(
        self,
        route: TrackingRoute,
        request: SearchRequest,
        error_dates: list[date],
    ) -> int:
        saved_items = 0
        for attempt in range(1, 3):
            await asyncio.sleep(max(0, self.settings.error_fare_recheck_seconds))
            deals = await self.client.search_window(request, route.origin_code, route.destination_code)
            confirmation_deals = [
                deal.model_copy(update={"raw": {**deal.raw, "confirmation_attempt": attempt}})
                for deal in deals
                if deal.depart_date in error_dates
            ]
            outcome = await self.ingest_deals(route, confirmation_deals[:3], allow_notifications=False)
            saved_items += outcome.saved_items
        return saved_items

    @staticmethod
    def _notification_fingerprint(route: TrackingRoute, deal: FlightDeal) -> str:
        flight_key = deal.flight_number or deal.airline or deal.source
        return f"{route.id}:{deal.depart_date.isoformat()}:{flight_key}:{deal.price}"


def create_scheduler(monitor: PriceMonitor, settings: Settings) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        monitor.run_once,
        "interval",
        minutes=settings.check_interval_minutes,
        id="price-monitor",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    return scheduler
