from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import aiosqlite

from .models import FlightDeal, PriceHistoryItem, RouteWithStats, TrackingCreate, TrackingRoute


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[aiosqlite.Connection]:
        db = await aiosqlite.connect(self.path)
        db.row_factory = aiosqlite.Row
        try:
            yield db
        finally:
            await db.close()

    async def init(self) -> None:
        async with self.connect() as db:
            await db.executescript(
                """
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS tracking_routes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    origin TEXT NOT NULL,
                    destination TEXT NOT NULL,
                    origin_code TEXT NOT NULL,
                    destination_code TEXT NOT NULL,
                    date_from TEXT NOT NULL,
                    date_to TEXT NOT NULL,
                    direct_only INTEGER NOT NULL DEFAULT 1,
                    baggage_required INTEGER NOT NULL DEFAULT 0,
                    price_threshold INTEGER,
                    notify_error_fare INTEGER NOT NULL DEFAULT 1,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    route_id INTEGER,
                    origin TEXT NOT NULL,
                    destination TEXT NOT NULL,
                    origin_code TEXT NOT NULL,
                    destination_code TEXT NOT NULL,
                    depart_date TEXT NOT NULL,
                    price INTEGER NOT NULL,
                    airline TEXT,
                    flight_number TEXT,
                    transfers INTEGER NOT NULL DEFAULT 0,
                    baggage TEXT,
                    link TEXT NOT NULL,
                    source TEXT NOT NULL,
                    raw_json TEXT NOT NULL DEFAULT '{}',
                    is_error_fare INTEGER NOT NULL DEFAULT 0,
                    drop_percent REAL,
                    found_at TEXT NOT NULL,
                    FOREIGN KEY(route_id) REFERENCES tracking_routes(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_price_history_route_date
                    ON price_history(route_id, depart_date, found_at);

                CREATE TABLE IF NOT EXISTS notification_events (
                    fingerprint TEXT PRIMARY KEY,
                    sent_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS browser_extension_status (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    state TEXT NOT NULL,
                    current_route TEXT,
                    last_error TEXT,
                    last_heartbeat_at TEXT NOT NULL,
                    last_run_at TEXT,
                    providers_json TEXT NOT NULL DEFAULT '[]'
                );
                """
            )
            await db.commit()

    async def create_route(self, item: TrackingCreate, origin_code: str, destination_code: str) -> TrackingRoute:
        now = utc_now()
        async with self.connect() as db:
            cursor = await db.execute(
                """
                INSERT INTO tracking_routes (
                    origin, destination, origin_code, destination_code, date_from, date_to,
                    direct_only, baggage_required, price_threshold, notify_error_fare,
                    active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.origin,
                    item.destination,
                    origin_code,
                    destination_code,
                    item.date_from.isoformat(),
                    item.date_to.isoformat(),
                    int(item.direct_only),
                    int(item.baggage_required),
                    item.price_threshold,
                    int(item.notify_error_fare),
                    int(item.active),
                    now,
                    now,
                ),
            )
            await db.commit()
            route_id = int(cursor.lastrowid)
        route = await self.get_route(route_id)
        if route is None:
            raise RuntimeError("Не удалось создать трек")
        return route

    async def list_routes(self, active_only: bool = False) -> list[RouteWithStats]:
        where = "WHERE r.active = 1" if active_only else ""
        async with self.connect() as db:
            cursor = await db.execute(
                f"""
                SELECT
                    r.*,
                    MIN(h.price) AS best_price,
                    (
                        SELECT h2.price
                        FROM price_history h2
                        WHERE h2.route_id = r.id
                        ORDER BY h2.found_at DESC
                        LIMIT 1
                    ) AS last_price,
                    MAX(h.found_at) AS last_checked_at
                FROM tracking_routes r
                LEFT JOIN price_history h ON h.route_id = r.id
                {where}
                GROUP BY r.id
                ORDER BY r.created_at DESC
                """
            )
            rows = await cursor.fetchall()
        return [self._route_with_stats_from_row(row) for row in rows]

    async def get_route(self, route_id: int) -> TrackingRoute | None:
        async with self.connect() as db:
            cursor = await db.execute("SELECT * FROM tracking_routes WHERE id = ?", (route_id,))
            row = await cursor.fetchone()
        return self._route_from_row(row) if row else None

    async def delete_route(self, route_id: int) -> None:
        async with self.connect() as db:
            await db.execute("DELETE FROM tracking_routes WHERE id = ?", (route_id,))
            await db.commit()

    async def save_deal(
        self,
        deal: FlightDeal,
        route_id: int | None,
        is_error_fare: bool = False,
        drop_percent: float | None = None,
    ) -> int:
        async with self.connect() as db:
            cursor = await db.execute(
                """
                INSERT INTO price_history (
                    route_id, origin, destination, origin_code, destination_code, depart_date,
                    price, airline, flight_number, transfers, baggage, link, source, raw_json,
                    is_error_fare, drop_percent, found_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    route_id,
                    deal.origin,
                    deal.destination,
                    deal.origin_code,
                    deal.destination_code,
                    deal.depart_date.isoformat(),
                    deal.price,
                    deal.airline,
                    deal.flight_number,
                    deal.transfers,
                    deal.baggage,
                    deal.link,
                    deal.source,
                    json.dumps(deal.raw, ensure_ascii=False),
                    int(is_error_fare),
                    drop_percent,
                    utc_now(),
                ),
            )
            await db.commit()
            return int(cursor.lastrowid)

    async def history(self, route_id: int, limit: int = 100) -> list[PriceHistoryItem]:
        async with self.connect() as db:
            cursor = await db.execute(
                """
                SELECT * FROM price_history
                WHERE route_id = ?
                ORDER BY found_at DESC
                LIMIT ?
                """,
                (route_id, limit),
            )
            rows = await cursor.fetchall()
        return [self._history_from_row(row) for row in rows]

    async def browser_parser_results(self, limit: int = 30) -> list[PriceHistoryItem]:
        async with self.connect() as db:
            cursor = await db.execute(
                """
                SELECT * FROM price_history
                WHERE source IN ('aeroflot_website', 's7_website')
                ORDER BY found_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = await cursor.fetchall()
        return [self._history_from_row(row) for row in rows]

    async def list_results(
        self,
        source: str | None = None,
        route_id: int | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        min_price: int | None = None,
        max_price: int | None = None,
        direct_only: bool = False,
        error_only: bool = False,
        limit: int = 100,
    ) -> list[PriceHistoryItem]:
        clauses = []
        values: list[Any] = []
        if source:
            clauses.append("source = ?")
            values.append(source)
        if route_id is not None:
            clauses.append("route_id = ?")
            values.append(route_id)
        if date_from:
            clauses.append("depart_date >= ?")
            values.append(date_from)
        if date_to:
            clauses.append("depart_date <= ?")
            values.append(date_to)
        if min_price is not None:
            clauses.append("price >= ?")
            values.append(min_price)
        if max_price is not None:
            clauses.append("price <= ?")
            values.append(max_price)
        if direct_only:
            clauses.append("transfers = 0")
        if error_only:
            clauses.append("is_error_fare = 1")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(limit)

        async with self.connect() as db:
            cursor = await db.execute(
                f"SELECT * FROM price_history {where} ORDER BY found_at DESC LIMIT ?",
                values,
            )
            rows = await cursor.fetchall()
        return [self._history_from_row(row) for row in rows]

    async def confirmation_context(self, hours: int = 24, limit: int = 1000) -> list[PriceHistoryItem]:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        async with self.connect() as db:
            cursor = await db.execute(
                """
                SELECT * FROM price_history
                WHERE found_at >= ?
                ORDER BY found_at DESC
                LIMIT ?
                """,
                (since, limit),
            )
            rows = await cursor.fetchall()
        return [self._history_from_row(row) for row in rows]

    async def price_chart(self, route_id: int, source: str | None = None, limit: int = 300) -> list[dict[str, Any]]:
        source_clause = "AND source = ?" if source else ""
        values: list[Any] = [route_id]
        if source:
            values.append(source)
        values.append(limit)
        async with self.connect() as db:
            cursor = await db.execute(
                f"""
                SELECT source, found_at, price
                FROM price_history
                WHERE route_id = ? {source_clause}
                ORDER BY found_at ASC
                LIMIT ?
                """,
                values,
            )
            rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def notification_was_sent(self, fingerprint: str) -> bool:
        async with self.connect() as db:
            cursor = await db.execute(
                "SELECT 1 FROM notification_events WHERE fingerprint = ?",
                (fingerprint,),
            )
            return await cursor.fetchone() is not None

    async def mark_notification_sent(self, fingerprint: str) -> None:
        async with self.connect() as db:
            await db.execute(
                "INSERT OR IGNORE INTO notification_events (fingerprint, sent_at) VALUES (?, ?)",
                (fingerprint, utc_now()),
            )
            await db.commit()

    async def update_extension_status(
        self,
        state: str,
        current_route: str | None,
        last_error: str | None,
        last_run_at: str | None,
        providers: list[str],
    ) -> None:
        async with self.connect() as db:
            await db.execute(
                """
                INSERT INTO browser_extension_status (
                    id, state, current_route, last_error, last_heartbeat_at, last_run_at, providers_json
                ) VALUES (1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    state = excluded.state,
                    current_route = excluded.current_route,
                    last_error = excluded.last_error,
                    last_heartbeat_at = excluded.last_heartbeat_at,
                    last_run_at = COALESCE(excluded.last_run_at, browser_extension_status.last_run_at),
                    providers_json = excluded.providers_json
                """,
                (state, current_route, last_error, utc_now(), last_run_at, json.dumps(providers)),
            )
            await db.commit()

    async def extension_status(self) -> dict[str, Any] | None:
        async with self.connect() as db:
            cursor = await db.execute("SELECT * FROM browser_extension_status WHERE id = 1")
            row = await cursor.fetchone()
        return dict(row) if row else None

    async def browser_parser_stats(self) -> tuple[int, str | None, dict[str, int]]:
        async with self.connect() as db:
            cursor = await db.execute(
                """
                SELECT source, COUNT(*) AS result_count, MAX(found_at) AS last_received_at
                FROM price_history
                WHERE source IN ('aeroflot_website', 's7_website')
                GROUP BY source
                """
            )
            rows = await cursor.fetchall()

        source_counts = {row["source"]: row["result_count"] for row in rows}
        last_received_at = max(
            (row["last_received_at"] for row in rows if row["last_received_at"]),
            default=None,
        )
        return sum(source_counts.values()), last_received_at, source_counts

    async def baseline_stats(self, route_id: int) -> dict[str, float | int | None]:
        async with self.connect() as db:
            cursor = await db.execute(
                """
                SELECT MIN(price) AS min_price, AVG(price) AS avg_price, COUNT(*) AS sample_count
                FROM price_history
                WHERE route_id = ?
                """,
                (route_id,),
            )
            row = await cursor.fetchone()
        return {
            "min_price": row["min_price"] if row else None,
            "avg_price": row["avg_price"] if row else None,
            "sample_count": row["sample_count"] if row else 0,
        }

    def _route_from_row(self, row: aiosqlite.Row) -> TrackingRoute:
        return TrackingRoute(
            id=row["id"],
            origin=row["origin"],
            destination=row["destination"],
            origin_code=row["origin_code"],
            destination_code=row["destination_code"],
            date_from=row["date_from"],
            date_to=row["date_to"],
            direct_only=bool(row["direct_only"]),
            baggage_required=bool(row["baggage_required"]),
            price_threshold=row["price_threshold"],
            notify_error_fare=bool(row["notify_error_fare"]),
            active=bool(row["active"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _route_with_stats_from_row(self, row: aiosqlite.Row) -> RouteWithStats:
        route = self._route_from_row(row)
        return RouteWithStats(
            **route.model_dump(),
            best_price=row["best_price"],
            last_price=row["last_price"],
            last_checked_at=row["last_checked_at"],
        )

    def _history_from_row(self, row: aiosqlite.Row) -> PriceHistoryItem:
        return PriceHistoryItem(
            id=row["id"],
            route_id=row["route_id"],
            origin=row["origin"],
            destination=row["destination"],
            origin_code=row["origin_code"],
            destination_code=row["destination_code"],
            depart_date=row["depart_date"],
            price=row["price"],
            airline=row["airline"],
            flight_number=row["flight_number"],
            transfers=row["transfers"],
            baggage=row["baggage"],
            link=row["link"],
            source=row["source"],
            raw=json.loads(row["raw_json"] or "{}"),
            found_at=row["found_at"],
            is_error_fare=bool(row["is_error_fare"]),
            drop_percent=row["drop_percent"],
        )
