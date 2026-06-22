const searchForm = document.querySelector("#searchForm");
const createTrackButton = document.querySelector("#createTrackButton");
const runMonitorButton = document.querySelector("#runMonitorButton");
const formMessage = document.querySelector("#formMessage");
const resultsList = document.querySelector("#resultsList");
const trackingList = document.querySelector("#trackingList");
const historyList = document.querySelector("#historyList");
const historyTitle = document.querySelector("#historyTitle");
const browserParserList = document.querySelector("#browserParserList");
const refreshBrowserParserButton = document.querySelector("#refreshBrowserParserButton");

function formatMoney(value) {
  if (value === null || value === undefined) return "нет данных";
  return `${Number(value).toLocaleString("ru-RU")} RUB`;
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("ru-RU");
}

function setMessage(text, isError = false) {
  formMessage.textContent = text;
  formMessage.style.color = isError ? "#b53d2a" : "#667074";
}

function getPayload() {
  const form = new FormData(searchForm);
  const threshold = form.get("price_threshold");
  return {
    origin: String(form.get("origin")).trim(),
    destination: String(form.get("destination")).trim(),
    date_from: form.get("date_from"),
    date_to: form.get("date_to"),
    direct_only: form.get("direct_only") === "on",
    baggage_required: form.get("baggage_required") === "on",
    price_threshold: threshold ? Number(threshold) : null,
    notify_error_fare: form.get("notify_error_fare") === "on",
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || "Ошибка запроса";
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg).join(", ") : detail);
  }
  return payload;
}

function renderDeals(deals) {
  if (!deals.length) {
    resultsList.className = "deal-list empty-state";
    resultsList.textContent = "Нет прямых рейсов внутри окна";
    return;
  }

  resultsList.className = "deal-list";
  resultsList.innerHTML = deals
    .map(
      (deal) => `
        <article class="deal">
          <div class="deal-top">
            <strong class="price">${formatMoney(deal.price)}</strong>
            <div class="deal-actions">
              ${renderSourceBadge(deal.source)}
              <a href="${deal.link}" target="_blank" rel="noreferrer">Открыть</a>
            </div>
          </div>
          <div>${deal.origin} -> ${deal.destination}</div>
          <div class="meta">${formatDate(deal.depart_date)} · ${deal.airline || "авиакомпания неизвестна"} · пересадок: ${deal.transfers}</div>
        </article>
      `,
    )
    .join("");
}

function renderTracks(routes) {
  if (!routes.length) {
    trackingList.className = "track-list empty-state";
    trackingList.textContent = "Треков пока нет";
    return;
  }

  trackingList.className = "track-list";
  trackingList.innerHTML = routes
    .map(
      (route) => `
        <article class="track">
          <div class="track-top">
            <strong>${route.origin} -> ${route.destination}</strong>
            <button class="danger-button" data-delete="${route.id}" type="button">Удалить</button>
          </div>
          <div class="meta">${formatDate(route.date_from)} - ${formatDate(route.date_to)} · лучшие: ${formatMoney(route.best_price)}</div>
          <div class="meta">Порог: ${formatMoney(route.price_threshold)} · прямые: ${route.direct_only ? "да" : "нет"}</div>
          <button class="secondary-button" data-history="${route.id}" data-title="${route.origin} -> ${route.destination}" type="button">История</button>
        </article>
      `,
    )
    .join("");
}

function renderHistory(items) {
  if (!items.length) {
    historyList.className = "history-list empty-state";
    historyList.textContent = "История появится после первой проверки";
    return;
  }

  historyList.className = "history-list";
  historyList.innerHTML = items
    .map(
      (item) => `
        <article class="history-item">
          <div class="history-top">
            <strong>${formatMoney(item.price)}</strong>
            ${item.is_error_fare ? '<span class="badge">ERROR FARE -30%</span>' : ""}
          </div>
          <div class="meta">${formatDate(item.depart_date)} · найдено ${new Date(item.found_at).toLocaleString("ru-RU")}</div>
          <div class="meta">Источник: ${formatSource(item.source)}${item.flight_number ? ` · ${item.flight_number}` : ""}</div>
          <div class="meta">Падение: ${item.drop_percent === null ? "нет данных" : `${item.drop_percent}%`}</div>
          <a href="${item.link}" target="_blank" rel="noreferrer">Открыть билет</a>
        </article>
      `,
    )
    .join("");
}

function formatSource(source) {
  return {
    aeroflot_website: "Аэрофлот · сайт",
    s7_website: "S7 · сайт",
    travelpayouts: "Aviasales / Travelpayouts",
    demo: "Demo-данные",
  }[source] || source;
}

function sourceClass(source) {
  return {
    aeroflot_website: "source-aeroflot",
    s7_website: "source-s7",
    travelpayouts: "source-aviasales",
    demo: "source-demo",
  }[source] || "source-unknown";
}

function renderSourceBadge(source) {
  return `<span class="source-badge ${sourceClass(source)}">${formatSource(source)}</span>`;
}

function renderBrowserParser(data) {
  document.querySelector("#browserParserStatus").textContent = data.enabled ? "приём включён" : "токен не настроен";
  document.querySelector("#browserParserSidebarStatus").textContent = data.enabled ? "включён" : "выключен";
  document.querySelector("#browserParserLastReceived").textContent = data.last_received_at
    ? new Date(data.last_received_at).toLocaleString("ru-RU")
    : "данных ещё нет";
  document.querySelector("#browserParserTotal").textContent = data.total_results;

  const sourceEntries = Object.entries(data.source_counts);
  const sourceSummary = document.querySelector("#browserParserSources");
  sourceSummary.innerHTML = sourceEntries.length
    ? sourceEntries.map(([source, count]) => `${renderSourceBadge(source)} <strong>${count}</strong>`).join("")
    : "";

  if (!data.results.length) {
    browserParserList.className = "deal-list empty-state";
    browserParserList.textContent = "Данных от расширения пока нет";
    return;
  }

  browserParserList.className = "deal-list browser-deal-list";
  browserParserList.innerHTML = data.results
    .map(
      (item) => `
        <article class="deal browser-deal">
          <div class="deal-top">
            <strong class="price">${formatMoney(item.price)}</strong>
            ${renderSourceBadge(item.source)}
          </div>
          <strong>${item.origin} → ${item.destination}</strong>
          <div class="meta">${formatDate(item.depart_date)} · ${item.flight_number || item.airline || "рейс не указан"} · пересадок: ${item.transfers}</div>
          <div class="meta">Получено: ${new Date(item.found_at).toLocaleString("ru-RU")}</div>
          <div class="deal-actions">
            ${item.is_error_fare ? '<span class="badge">ERROR FARE -30%</span>' : ""}
            <a href="${item.link}" target="_blank" rel="noreferrer">Открыть у авиакомпании</a>
          </div>
        </article>
      `,
    )
    .join("");
}

async function loadBrowserParser() {
  const data = await requestJson("/api/providers/browser");
  renderBrowserParser(data);
}

function renderBrowserParserError(error) {
  browserParserList.className = "deal-list empty-state";
  browserParserList.textContent = `Ошибка обновления: ${error.message}`;
}

async function loadHealth() {
  const health = await requestJson("/api/health");
  document.querySelector("#sourceStatus").textContent = formatSource(health.source);
  document.querySelector("#telegramStatus").textContent = health.telegram_enabled ? "включен" : "выключен";
  document.querySelector("#intervalStatus").textContent = `${health.check_interval_minutes} мин`;
  document.querySelector("#browserParserSidebarStatus").textContent = health.extension_enabled ? "включён" : "выключен";
}

async function loadTracks() {
  const routes = await requestJson("/api/tracking");
  renderTracks(routes);
}

async function loadHistory(routeId, title) {
  const items = await requestJson(`/api/tracking/${routeId}/history`);
  historyTitle.textContent = title;
  renderHistory(items);
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Ищу...");
  try {
    const payload = getPayload();
    const data = await requestJson("/api/search", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderDeals(data.results);
    setMessage(`Готово: ${data.origin_code} -> ${data.destination_code}`);
  } catch (error) {
    setMessage(error.message, true);
  }
});

createTrackButton.addEventListener("click", async () => {
  setMessage("Создаю трек...");
  try {
    const payload = getPayload();
    await requestJson("/api/tracking", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadTracks();
    setMessage("Трек добавлен");
  } catch (error) {
    setMessage(error.message, true);
  }
});

runMonitorButton.addEventListener("click", async () => {
  runMonitorButton.disabled = true;
  runMonitorButton.textContent = "Проверяю...";
  try {
    const result = await requestJson("/api/monitor/run", { method: "POST" });
    await loadTracks();
    setMessage(`Проверено треков: ${result.checked_routes}, сохранено цен: ${result.saved_items}`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    runMonitorButton.disabled = false;
    runMonitorButton.textContent = "Запустить проверку";
  }
});

refreshBrowserParserButton.addEventListener("click", async () => {
  refreshBrowserParserButton.disabled = true;
  try {
    await loadBrowserParser();
  } catch (error) {
    renderBrowserParserError(error);
  } finally {
    refreshBrowserParserButton.disabled = false;
  }
});

trackingList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const deleteId = target.dataset.delete;
  if (deleteId) {
    await requestJson(`/api/tracking/${deleteId}`, { method: "DELETE" });
    await loadTracks();
    return;
  }

  const historyId = target.dataset.history;
  if (historyId) {
    await loadHistory(historyId, target.dataset.title || "История");
  }
});

function setDefaultDates() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), 6, 10));
  const to = new Date(Date.UTC(now.getUTCFullYear(), 6, 15));
  searchForm.elements.date_from.value = from.toISOString().slice(0, 10);
  searchForm.elements.date_to.value = to.toISOString().slice(0, 10);
}

setDefaultDates();
loadHealth().catch((error) => setMessage(error.message, true));
loadTracks().catch((error) => setMessage(error.message, true));
loadBrowserParser().catch(renderBrowserParserError);
setInterval(() => loadBrowserParser().catch(renderBrowserParserError), 30000);
