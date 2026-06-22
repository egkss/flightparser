# Aviaparser

Веб-панель для поиска и мониторинга дешевых авиабилетов. Проект ищет самый дешевый билет внутри заданного окна дат, хранит историю цен и отправляет важные уведомления в Telegram.

## Что уже сделано

- Backend на FastAPI.
- SQLite-хранилище треков и истории цен.
- Поиск через Travelpayouts API с demo-режимом без токена.
- Мониторинг активных треков каждые 30 минут.
- Эвристика error fare: билет выделяется, если он дешевле средней исторической цены на 30% или больше.
- Telegram-уведомления по новым минимумам, падению цены на 3%+ и порогу цены.
- Веб-интерфейс для ручного поиска, создания треков, запуска проверки и просмотра истории.
- Docker и `docker-compose.yml` для запуска на Ubuntu Server.

## MVP

- 1 пользователь.
- Основной интерфейс: веб.
- Уведомления: Telegram.
- География старта: города и аэропорты РФ.
- Только прямые рейсы.
- Только перелеты в одну сторону.
- Маршрут формата `A -> B`.
- Поиск самого дешевого билета на любую дату внутри окна.
- Telegram получает топ-3 варианта при важном изменении.
- Багаж не обязателен, но есть переключатель в форме.

## Важное про Aviasales и error fare

Сейчас проект использует Travelpayouts API, то есть официальный источник данных Aviasales/Travelpayouts. Прямой парсинг сайта Aviasales с обходом защиты не добавлен.

Для error fare в MVP используется практичная эвристика: если новая цена ниже средней исторической цены на `ERROR_FARE_PERCENT` процентов, запись помечается как `ERROR FARE CANDIDATE`, а Telegram-сообщение выделяет ее отдельно.

## Структура

```text
.
├── backend/
│   ├── app/
│   │   ├── analyzer.py
│   │   ├── aviasales_client.py
│   │   ├── cities.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── main.py
│   │   ├── models.py
│   │   ├── scheduler.py
│   │   └── telegram_notifier.py
│   └── requirements.txt
├── data/
├── frontend/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── implementation_plan.md
```

## Настройка

Создай `.env` из примера:

```bash
cp .env.example .env
```

Заполни переменные:

```env
TRAVELPAYOUTS_TOKEN=your_token
TRAVELPAYOUTS_MARKER=your_marker
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
EXTENSION_API_TOKEN=long_random_token
CHECK_INTERVAL_MINUTES=30
TELEGRAM_DROP_PERCENT=3
ERROR_FARE_PERCENT=30
DATABASE_PATH=data/aviaparser.db
PUBLIC_BASE_URL=http://localhost:8000
```

Без `TRAVELPAYOUTS_TOKEN` приложение запустится в demo-режиме и будет отдавать тестовые цены.

## Запуск через Docker

```bash
docker compose up --build -d
```

После запуска:

- Веб-панель: `http://localhost:8000`
- Swagger API: `http://localhost:8000/docs`
- Healthcheck: `http://localhost:8000/api/health`

## Локальный запуск без Docker

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```

## API

- `POST /api/search` - ручной поиск топ-3 вариантов внутри окна дат.
- `GET /api/tracking` - список треков.
- `POST /api/tracking` - создать трек мониторинга.
- `DELETE /api/tracking/{route_id}` - удалить трек.
- `GET /api/tracking/{route_id}/history` - история цен по треку.
- `POST /api/monitor/run` - вручную запустить проверку всех активных треков.
- `GET /api/health` - состояние приложения.

## Формат трека

```json
{
  "origin": "Омск",
  "destination": "Москва",
  "date_from": "2026-07-10",
  "date_to": "2026-07-15",
  "direct_only": true,
  "baggage_required": false,
  "price_threshold": 9000,
  "notify_error_fare": true
}
```

Города переводятся в IATA-коды через `backend/app/cities.py`. Можно вводить и IATA-коды напрямую, например `OMS` -> `MOW`.

## Деплой на Ubuntu Server

1. Установить Docker и Docker Compose plugin.
2. Скопировать проект на сервер.
3. Создать `.env` и заполнить токены.
4. Запустить `docker compose up --build -d`.
5. Открыть порт `8000` или поставить reverse proxy.

Для первого запуска аккаунты в вебе не используются. Если панель будет доступна из интернета, лучше закрыть ее через reverse proxy с Basic Auth, VPN или доступом по IP.

## Мониторинг сайтов авиакомпаний через Chrome

Папка `chrome-extension` содержит расширение Chrome, которое открывает поиск Аэрофлота и S7 в фоновых вкладках и отправляет найденные цены в Aviaparser. Chrome должен оставаться запущенным.

На сервере создай отдельный токен и добавь его в `.env`:

```bash
openssl rand -hex 32
```

```env
EXTENSION_API_TOKEN=полученная_строка
```

Перезапусти backend:

```bash
docker compose up -d --build
```

Установка расширения:

1. Скачай папку `chrome-extension` на компьютер с Chrome.
2. Открой `chrome://extensions`.
3. Включи режим разработчика.
4. Нажми «Загрузить распакованное расширение» и выбери папку `chrome-extension`.
5. Открой настройки расширения.
6. Укажи адрес Aviaparser и тот же `EXTENSION_API_TOKEN`.
7. Включи нужные источники, сохрани настройки и нажми «Запустить сейчас».

По умолчанию расширение проверяет треки с окном не больше 7 дней каждые 5 минут. При проверке Chrome создает и закрывает фоновые вкладки авиакомпаний. Если Аэрофлот или S7 показывает CAPTCHA/антибот-проверку, её нужно один раз пройти вручную в обычной вкладке Chrome.
# flightparser
