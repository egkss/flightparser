from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .analyzer import analyze_deal
from .aviasales_client import AviasalesClient
from .config import Settings
from .database import Database
from .models import MonitorRunResult, SearchRequest
from .telegram_notifier import TelegramNotifier


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
            notification_payload = []

            for deal in deals[:3]:
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
                if analysis.should_notify:
                    notification_payload.append(
                        (deal, analysis.drop_percent, analysis.is_error_fare, analysis.reasons)
                    )

            if notification_payload:
                did_send = await self.notifier.send_deals(route, notification_payload[:3])
                sent_notifications += int(did_send)

        return MonitorRunResult(
            checked_routes=len(routes),
            saved_items=saved_items,
            sent_notifications=sent_notifications,
        )


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
