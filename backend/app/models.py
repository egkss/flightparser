from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class SearchRequest(BaseModel):
    origin: str = Field(min_length=2, max_length=80)
    destination: str = Field(min_length=2, max_length=80)
    date_from: date
    date_to: date
    direct_only: bool = True
    baggage_required: bool = False
    price_threshold: int | None = Field(default=None, ge=1)
    notify_error_fare: bool = True

    @model_validator(mode="after")
    def validate_dates(self) -> "SearchRequest":
        if self.date_to < self.date_from:
            raise ValueError("date_to не может быть раньше date_from")
        if (self.date_to - self.date_from).days > 31:
            raise ValueError("Окно поиска в MVP ограничено 31 днем")
        return self


class TrackingCreate(SearchRequest):
    active: bool = True


class TrackingRoute(TrackingCreate):
    id: int
    origin_code: str
    destination_code: str
    created_at: datetime
    updated_at: datetime


class FlightDeal(BaseModel):
    origin: str
    destination: str
    origin_code: str
    destination_code: str
    depart_date: date
    price: int
    airline: str | None = None
    flight_number: str | None = None
    transfers: int = 0
    baggage: str | None = None
    link: str
    source: str = "travelpayouts"
    raw: dict[str, Any] = Field(default_factory=dict)

    @field_validator("price", mode="before")
    @classmethod
    def normalize_price(cls, value: Any) -> int:
        return int(float(value))


class PriceHistoryItem(FlightDeal):
    id: int
    route_id: int | None = None
    found_at: datetime
    is_error_fare: bool = False
    drop_percent: float | None = None


class SearchResponse(BaseModel):
    origin_code: str
    destination_code: str
    results: list[FlightDeal]


class RouteWithStats(TrackingRoute):
    best_price: int | None = None
    last_price: int | None = None
    last_checked_at: datetime | None = None


class MonitorRunResult(BaseModel):
    checked_routes: int
    saved_items: int
    sent_notifications: int


class BrowserParserResponse(BaseModel):
    enabled: bool
    last_received_at: datetime | None = None
    total_results: int
    source_counts: dict[str, int]
    results: list[PriceHistoryItem]


class AeroflotDealInput(BaseModel):
    depart_date: date
    price: int = Field(ge=1)
    flight_number: str | None = Field(default=None, max_length=80)
    transfers: int = Field(default=0, ge=0, le=4)
    link: str = Field(min_length=1, max_length=2000)

    @field_validator("link")
    @classmethod
    def validate_aeroflot_link(cls, value: str) -> str:
        if not value.startswith("https://www.aeroflot.ru/"):
            raise ValueError("Допустимы только ссылки aeroflot.ru")
        return value


class AeroflotResultsIngest(BaseModel):
    route_id: int = Field(ge=1)
    results: list[AeroflotDealInput] = Field(min_length=1, max_length=30)


class ProviderDealInput(BaseModel):
    depart_date: date
    price: int = Field(ge=1)
    flight_number: str | None = Field(default=None, max_length=80)
    transfers: int = Field(default=0, ge=0, le=4)
    link: str = Field(min_length=1, max_length=2000)


class ProviderResultsIngest(BaseModel):
    provider: Literal["aeroflot", "s7"]
    route_id: int = Field(ge=1)
    results: list[ProviderDealInput] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def validate_result_links(self) -> "ProviderResultsIngest":
        allowed_prefixes = {
            "aeroflot": "https://www.aeroflot.ru/",
            "s7": "https://ibe.s7.ru/",
        }
        prefix = allowed_prefixes[self.provider]
        if any(not result.link.startswith(prefix) for result in self.results):
            raise ValueError(f"Ссылка результата не соответствует источнику {self.provider}")
        return self
