from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .aviasales_client import AviasalesClient
from .cities import resolve_city_code
from .config import Settings, get_settings
from .database import Database
from .models import (
    AeroflotResultsIngest,
    BrowserParserResponse,
    FlightDeal,
    MonitorRunResult,
    ProviderResultsIngest,
    SearchRequest,
    SearchResponse,
    TrackingCreate,
)
from .scheduler import PriceMonitor, create_scheduler
from .telegram_notifier import TelegramNotifier

settings = get_settings()
database = Database(settings.database_file)
client = AviasalesClient(settings)
notifier = TelegramNotifier(settings)
monitor = PriceMonitor(database, client, notifier, settings)
scheduler = create_scheduler(monitor, settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await database.init()
    scheduler.start()
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

frontend_dir = Path(__file__).resolve().parents[2] / "frontend"
if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")


def get_db() -> Database:
    return database


def get_client() -> AviasalesClient:
    return client


@app.get("/")
async def index() -> FileResponse:
    index_path = frontend_dir / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend is not built yet")
    return FileResponse(index_path)


@app.get("/api/health")
async def health(settings_: Settings = Depends(get_settings)) -> dict:
    return {
        "ok": True,
        "source": "travelpayouts" if settings_.travelpayouts_token else "demo",
        "telegram_enabled": bool(settings_.telegram_bot_token and settings_.telegram_chat_id),
        "extension_enabled": bool(settings_.extension_api_token),
        "check_interval_minutes": settings_.check_interval_minutes,
    }


@app.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest, api_client: AviasalesClient = Depends(get_client)) -> SearchResponse:
    origin_code, destination_code = _resolve_codes(request.origin, request.destination)
    results = await api_client.search_window(request, origin_code, destination_code)
    return SearchResponse(origin_code=origin_code, destination_code=destination_code, results=results)


@app.get("/api/tracking")
async def list_tracking(db: Database = Depends(get_db)):
    return await db.list_routes()


@app.post("/api/tracking")
async def create_tracking(request: TrackingCreate, db: Database = Depends(get_db)):
    origin_code, destination_code = _resolve_codes(request.origin, request.destination)
    route = await db.create_route(request, origin_code, destination_code)
    return route


@app.delete("/api/tracking/{route_id}")
async def delete_tracking(route_id: int, db: Database = Depends(get_db)) -> dict:
    await db.delete_route(route_id)
    return {"ok": True}


@app.get("/api/tracking/{route_id}/history")
async def route_history(route_id: int, db: Database = Depends(get_db)):
    return await db.history(route_id)


@app.get("/api/providers/browser", response_model=BrowserParserResponse)
async def browser_parser_panel(
    db: Database = Depends(get_db),
    settings_: Settings = Depends(get_settings),
) -> BrowserParserResponse:
    total_results, last_received_at, source_counts = await db.browser_parser_stats()
    return BrowserParserResponse(
        enabled=bool(settings_.extension_api_token),
        last_received_at=last_received_at,
        total_results=total_results,
        source_counts=source_counts,
        results=await db.browser_parser_results(),
    )


@app.post("/api/monitor/run", response_model=MonitorRunResult)
async def run_monitor_once() -> MonitorRunResult:
    return await monitor.run_once()


@app.post("/api/providers/aeroflot/results", response_model=MonitorRunResult)
async def ingest_aeroflot_results(
    payload: AeroflotResultsIngest,
    x_extension_token: str = Header(default=""),
    db: Database = Depends(get_db),
    settings_: Settings = Depends(get_settings),
) -> MonitorRunResult:
    generic_payload = ProviderResultsIngest(
        provider="aeroflot",
        route_id=payload.route_id,
        results=[item.model_dump() for item in payload.results],
    )
    return await _ingest_provider_results(generic_payload, x_extension_token, db, settings_)


@app.post("/api/providers/results", response_model=MonitorRunResult)
async def ingest_provider_results(
    payload: ProviderResultsIngest,
    x_extension_token: str = Header(default=""),
    db: Database = Depends(get_db),
    settings_: Settings = Depends(get_settings),
) -> MonitorRunResult:
    return await _ingest_provider_results(payload, x_extension_token, db, settings_)


async def _ingest_provider_results(
    payload: ProviderResultsIngest,
    extension_token: str,
    db: Database,
    settings_: Settings,
) -> MonitorRunResult:
    if not settings_.extension_api_token:
        raise HTTPException(status_code=503, detail="Приём данных расширения не настроен")
    if not hmac.compare_digest(extension_token, settings_.extension_api_token):
        raise HTTPException(status_code=401, detail="Неверный токен расширения")

    route = await db.get_route(payload.route_id)
    if route is None or not route.active:
        raise HTTPException(status_code=404, detail="Активный трек не найден")

    provider_settings = {
        "aeroflot": ("SU", "aeroflot_website"),
        "s7": ("S7", "s7_website"),
    }
    airline, source = provider_settings[payload.provider]
    deals = []
    for item in payload.results:
        if not route.date_from <= item.depart_date <= route.date_to:
            raise HTTPException(status_code=422, detail="Дата результата находится вне окна трека")
        if route.direct_only and item.transfers != 0:
            continue
        deals.append(
            FlightDeal(
                origin=route.origin,
                destination=route.destination,
                origin_code=route.origin_code,
                destination_code=route.destination_code,
                depart_date=item.depart_date,
                price=item.price,
                airline=airline,
                flight_number=item.flight_number,
                transfers=item.transfers,
                baggage="unknown",
                link=item.link,
                source=source,
                raw={"extension": True, "provider": payload.provider},
            )
        )

    saved_items, sent_notifications = await monitor.ingest_deals(route, deals[:3])
    return MonitorRunResult(
        checked_routes=1,
        saved_items=saved_items,
        sent_notifications=sent_notifications,
    )


def _resolve_codes(origin: str, destination: str) -> tuple[str, str]:
    try:
        return resolve_city_code(origin), resolve_city_code(destination)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
