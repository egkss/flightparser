from __future__ import annotations

import html

import httpx

from .config import Settings
from .models import FlightDeal, TrackingRoute


class TelegramNotifier:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def enabled(self) -> bool:
        return bool(self.settings.telegram_bot_token and self.settings.telegram_chat_id)

    async def send_deals(
        self,
        route: TrackingRoute,
        deals: list[tuple[FlightDeal, float | None, bool, list[str]]],
    ) -> bool:
        if not self.enabled or not deals:
            return False

        text = self._format_message(route, deals)
        url = f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/sendMessage"
        payload = {
            "chat_id": self.settings.telegram_chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
        return True

    def _format_message(
        self,
        route: TrackingRoute,
        deals: list[tuple[FlightDeal, float | None, bool, list[str]]],
    ) -> str:
        header = f"<b>{html.escape(route.origin)} -> {html.escape(route.destination)}</b>"
        parts = [header, "Топ-3 дешевых варианта:"]
        for index, (deal, drop_percent, is_error_fare, reasons) in enumerate(deals, start=1):
            marker = "ERROR FARE CANDIDATE" if is_error_fare else "DEAL"
            drop_text = f", падение {drop_percent:.1f}%" if drop_percent is not None else ""
            reasons_text = ", ".join(reasons)
            parts.append(
                "\n".join(
                    [
                        f"{index}. <b>{marker}</b>",
                        f"Цена: <b>{deal.price:,} RUB</b>{drop_text}".replace(",", " "),
                        f"Дата: {deal.depart_date.isoformat()}",
                        f"Источник: {html.escape(self._source_title(deal.source))}",
                        f"Рейс: {html.escape(deal.flight_number or deal.airline or 'не указан')}",
                        f"Причина: {html.escape(reasons_text)}",
                        f"<a href=\"{html.escape(deal.link)}\">Открыть билет</a>",
                    ]
                )
            )
        return "\n\n".join(parts)

    @staticmethod
    def _source_title(source: str) -> str:
        return {
            "travelpayouts": "Aviasales / Travelpayouts",
            "aeroflot_website": "Аэрофлот · сайт",
            "s7_website": "S7 · сайт",
            "demo": "Demo-данные",
        }.get(source, source)
