from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, timedelta
from urllib.parse import urlencode

import httpx

from .config import Settings
from .models import FlightDeal, SearchRequest


EXCLUDED_AIRLINE_CODES = {"DP"}
EXCLUDED_AIRLINE_NAMES = {"pobeda", "победа"}


@dataclass(frozen=True)
class SearchWindowOutcome:
    deals: list[FlightDeal]
    excluded_results_count: int = 0
    excluded_airlines: tuple[str, ...] = ()


@dataclass(frozen=True)
class SearchDayOutcome:
    deals: list[FlightDeal]
    excluded_results_count: int = 0
    excluded_airlines: tuple[str, ...] = ()


class AviasalesClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.base_url = "https://api.travelpayouts.com"

    async def search_window(
        self,
        request: SearchRequest,
        origin_code: str,
        destination_code: str,
    ) -> list[FlightDeal]:
        return (await self.search_window_with_meta(request, origin_code, destination_code)).deals

    async def search_window_with_meta(
        self,
        request: SearchRequest,
        origin_code: str,
        destination_code: str,
    ) -> SearchWindowOutcome:
        if not self.settings.travelpayouts_token:
            return SearchWindowOutcome(self._demo_results(request, origin_code, destination_code))

        dates = self._date_range(request.date_from, request.date_to)
        async with httpx.AsyncClient(timeout=20.0) as client:
            tasks = [
                self._search_day(client, request, origin_code, destination_code, departure_date)
                for departure_date in dates
            ]
            batches = await asyncio.gather(*tasks, return_exceptions=True)

        deals: list[FlightDeal] = []
        excluded_results_count = 0
        excluded_airlines: set[str] = set()
        for batch in batches:
            if isinstance(batch, Exception):
                continue
            deals.extend(batch.deals)
            excluded_results_count += batch.excluded_results_count
            excluded_airlines.update(batch.excluded_airlines)

        return SearchWindowOutcome(
            deals=self._dedupe_and_sort(deals)[:3],
            excluded_results_count=excluded_results_count,
            excluded_airlines=tuple(sorted(excluded_airlines)),
        )

    async def _search_day(
        self,
        client: httpx.AsyncClient,
        request: SearchRequest,
        origin_code: str,
        destination_code: str,
        departure_date: date,
    ) -> SearchDayOutcome:
        params = {
            "origin": origin_code,
            "destination": destination_code,
            "departure_at": departure_date.isoformat(),
            "one_way": "true",
            "direct": "true" if request.direct_only else "false",
            "currency": "rub",
            "sorting": "price",
            "limit": 30,
            "token": self.settings.travelpayouts_token,
        }
        response = await client.get(f"{self.base_url}/aviasales/v3/prices_for_dates", params=params)
        response.raise_for_status()
        payload = response.json()
        items = payload.get("data") or []

        deals: list[FlightDeal] = []
        excluded_results_count = 0
        excluded_airlines: set[str] = set()
        for item in items:
            if self._is_excluded_airline(item):
                excluded_results_count += 1
                excluded_airlines.add(self._excluded_airline_label(item))
                continue
            if request.direct_only and int(item.get("transfers") or 0) != 0:
                continue
            price = item.get("price")
            if not price:
                continue
            deals.append(
                FlightDeal(
                    origin=request.origin,
                    destination=request.destination,
                    origin_code=origin_code,
                    destination_code=destination_code,
                    depart_date=departure_date,
                    price=price,
                    airline=item.get("airline"),
                    flight_number=str(item.get("flight_number")) if item.get("flight_number") else None,
                    transfers=int(item.get("transfers") or 0),
                    baggage="unknown",
                    link=self._build_link(item, origin_code, destination_code, departure_date),
                    raw=item,
                )
            )
        return SearchDayOutcome(
            deals=deals,
            excluded_results_count=excluded_results_count,
            excluded_airlines=tuple(sorted(excluded_airlines)),
        )

    def _build_link(self, item: dict, origin_code: str, destination_code: str, departure_date: date) -> str:
        link = item.get("link")
        if link:
            if str(link).startswith("http"):
                return str(link)
            return f"https://www.aviasales.ru{link}"

        search_code = f"{origin_code}{departure_date.strftime('%d%m')}{destination_code}1"
        query = urlencode({"marker": self.settings.travelpayouts_marker}) if self.settings.travelpayouts_marker else ""
        suffix = f"?{query}" if query else ""
        return f"https://www.aviasales.ru/search/{search_code}{suffix}"

    def _demo_results(self, request: SearchRequest, origin_code: str, destination_code: str) -> list[FlightDeal]:
        # Allows the app to boot and the UI to be tested before API tokens are configured.
        demo_prices = [7200, 7900, 8500]
        return [
            FlightDeal(
                origin=request.origin,
                destination=request.destination,
                origin_code=origin_code,
                destination_code=destination_code,
                depart_date=request.date_from + timedelta(days=index),
                price=price,
                airline="DEMO",
                flight_number=f"DM{index + 1}",
                transfers=0,
                baggage="unknown",
                link="https://www.aviasales.ru",
                source="demo",
                raw={"demo": True},
            )
            for index, price in enumerate(demo_prices)
            if request.date_from + timedelta(days=index) <= request.date_to
        ]

    def _date_range(self, start: date, end: date) -> list[date]:
        days = (end - start).days
        return [start + timedelta(days=offset) for offset in range(days + 1)]

    def _dedupe_and_sort(self, deals: list[FlightDeal]) -> list[FlightDeal]:
        best_by_key: dict[tuple[date, int, str | None], FlightDeal] = {}
        for deal in deals:
            key = (deal.depart_date, deal.price, deal.airline)
            current = best_by_key.get(key)
            if current is None or deal.price < current.price:
                best_by_key[key] = deal
        return sorted(best_by_key.values(), key=lambda item: (item.price, item.depart_date))

    def _is_excluded_airline(self, item: dict) -> bool:
        airline = str(item.get("airline") or "").strip().upper()
        if airline in EXCLUDED_AIRLINE_CODES:
            return True

        text = " ".join(str(value) for value in item.values() if isinstance(value, str)).lower()
        return any(name in text for name in EXCLUDED_AIRLINE_NAMES)

    def _excluded_airline_label(self, item: dict) -> str:
        airline = str(item.get("airline") or "").strip().upper()
        if airline == "DP":
            return "Победа"
        return airline or "Исключённая авиакомпания"
