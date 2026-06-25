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
const resultFilters = document.querySelector("#resultFilters");
const resultFeedList = document.querySelector("#resultFeedList");
const errorFareList = document.querySelector("#errorFareList");
const priceChart = document.querySelector("#priceChart");
const tabButtons = document.querySelectorAll("[data-tab]");
const tabPanels = document.querySelectorAll("[data-tab-panel]");

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
            <div class="deal-actions">
              ${renderSourceBadge(item.source)}
              ${renderConfidenceBadge(item.confidence)}
              ${item.is_error_fare ? '<span class="badge">ERROR FARE</span>' : ""}
            </div>
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
    travelpayouts: "Aviasales",
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

function formatConfidence(confidence) {
  return {
    high: "Высокая уверенность",
    medium: "Средняя уверенность",
    low: "Нужна проверка",
  }[confidence] || "Нужна проверка";
}

function renderConfidenceBadge(confidence) {
  return `<span class="confidence-badge confidence-${confidence}">${formatConfidence(confidence)}</span>`;
}

function renderVerifiedResults(container, items, emptyText) {
  if (!items.length) {
    container.className = "deal-list empty-state";
    container.textContent = emptyText;
    return;
  }

  container.className = "deal-list verified-deal-list";
  container.innerHTML = items
    .map(
      (item) => `
        <article class="deal verified-deal">
          <div class="deal-top">
            <strong class="price">${formatMoney(item.price)}</strong>
            <div class="deal-actions">
              ${renderSourceBadge(item.source)}
              ${renderConfidenceBadge(item.confidence)}
            </div>
          </div>
          <strong>${item.origin} → ${item.destination}</strong>
          <div class="meta">${formatDate(item.depart_date)} · ${item.flight_number || item.airline || "рейс не указан"} · пересадок: ${item.transfers}</div>
          <div class="meta">Подтверждений: ${item.repeated_checks} · источников: ${item.confirmation_sources.map(formatSource).join(", ") || formatSource(item.source)}</div>
          <div class="meta">Получено: ${new Date(item.found_at).toLocaleString("ru-RU")}${item.drop_percent === null ? "" : ` · падение ${item.drop_percent}%`}</div>
          <div class="deal-actions">
            ${item.is_error_fare ? '<span class="badge">ERROR FARE</span>' : ""}
            <a href="${item.link}" target="_blank" rel="noreferrer">Купить билет</a>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderBrowserParser(data) {
  const statusText = !data.enabled
    ? "токен не настроен"
    : data.online
      ? data.state === "running" ? "работает" : data.state === "error" ? "ошибка" : "на связи"
      : "нет heartbeat";
  document.querySelector("#browserParserStatus").textContent = statusText;
  document.querySelector("#browserParserSidebarStatus").textContent = data.online ? "на связи" : data.enabled ? "не в сети" : "выключен";
  document.querySelector("#browserParserLastReceived").textContent = data.last_received_at
    ? new Date(data.last_received_at).toLocaleString("ru-RU")
    : "данных ещё нет";
  document.querySelector("#browserParserTotal").textContent = data.total_results;
  document.querySelector("#browserParserHeartbeat").textContent = data.last_heartbeat_at
    ? new Date(data.last_heartbeat_at).toLocaleString("ru-RU")
    : "не получен";
  document.querySelector("#browserParserCurrentRoute").textContent = data.current_route
    ? `Сейчас: ${data.current_route}`
    : data.last_run_at ? `Последний запуск: ${new Date(data.last_run_at).toLocaleString("ru-RU")}` : "";
  document.querySelector("#browserParserError").textContent = data.last_error ? `Последняя ошибка: ${data.last_error}` : "";

  const sourceEntries = Object.entries(data.source_counts);
  const sourceSummary = document.querySelector("#browserParserSources");
  sourceSummary.innerHTML = sourceEntries.length
    ? sourceEntries.map(([source, count]) => `${renderSourceBadge(source)} <strong>${count}</strong>`).join("")
    : "";

  renderVerifiedResults(browserParserList, data.results, "Данных от расширения пока нет");
}

async function loadBrowserParser() {
  const data = await requestJson("/api/providers/browser");
  renderBrowserParser(data);
}

async function loadResultFeed() {
  const form = new FormData(resultFilters);
  const params = new URLSearchParams();
  for (const name of ["source", "route_id", "date_from", "date_to", "min_price", "max_price"]) {
    const value = String(form.get(name) || "");
    if (value) params.set(name, value);
  }
  if (form.get("direct_only") === "on") params.set("direct_only", "true");
  if (form.get("error_only") === "on") params.set("error_only", "true");
  const data = await requestJson(`/api/results?${params}`);
  renderVerifiedResults(resultFeedList, data.results, "По выбранным фильтрам результатов нет");
}

async function loadErrorFares() {
  const params = new URLSearchParams();
  const routeId = document.querySelector("#errorFareRoute").value;
  const source = document.querySelector("#errorFareSource").value;
  if (routeId) params.set("route_id", routeId);
  if (source) params.set("source", source);
  const data = await requestJson(`/api/error-fares?${params}`);
  renderVerifiedResults(errorFareList, data.results, "Подтверждённых кандидатов Error Fare пока нет");
}

async function loadPriceChart() {
  const routeId = document.querySelector("#chartRoute").value;
  if (!routeId) {
    priceChart.className = "chart empty-state";
    priceChart.textContent = "Выбери маршрут";
    return;
  }
  const params = new URLSearchParams({ route_id: routeId });
  const source = document.querySelector("#chartSource").value;
  if (source) params.set("source", source);
  renderPriceChart(await requestJson(`/api/price-chart?${params}`));
}

function renderPriceChart(points) {
  if (points.length < 2) {
    priceChart.className = "chart empty-state";
    priceChart.textContent = "Для графика нужно минимум две цены";
    return;
  }

  const width = 760;
  const height = 260;
  const padding = 42;
  const prices = points.map((point) => point.price);
  const times = points.map((point) => new Date(point.found_at).getTime());
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const colors = {
    travelpayouts: "#1593bd",
    aeroflot_website: "#2970b8",
    s7_website: "#65a832",
    demo: "#9a7c2f",
  };
  const grouped = points.reduce((result, point) => {
    (result[point.source] ||= []).push(point);
    return result;
  }, {});
  const lines = Object.entries(grouped)
    .map(([source, sourcePoints]) => {
      const coordinates = sourcePoints
        .map((point) => {
          const time = new Date(point.found_at).getTime();
          const x = padding + ((time - minTime) / Math.max(1, maxTime - minTime)) * (width - padding * 2);
          const y = height - padding - ((point.price - minPrice) / Math.max(1, maxPrice - minPrice)) * (height - padding * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      return `<polyline points="${coordinates}" fill="none" stroke="${colors[source] || "#667074"}" stroke-width="3" />`;
    })
    .join("");
  const legend = Object.keys(grouped)
    .map((source) => `<span style="--legend-color:${colors[source] || "#667074"}">${formatSource(source)}</span>`)
    .join("");

  priceChart.className = "chart";
  priceChart.innerHTML = `
    <div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="График изменения цены">
      <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" class="chart-axis" />
      <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-axis" />
      <text x="4" y="${padding + 4}">${formatMoney(maxPrice)}</text>
      <text x="4" y="${height - padding}">${formatMoney(minPrice)}</text>
      ${lines}
    </svg>
  `;
}

function renderBrowserParserError(error) {
  browserParserList.className = "deal-list empty-state";
  browserParserList.textContent = `Ошибка обновления: ${error.message}`;
}

async function loadHealth() {
  const health = await requestJson("/api/health");
  document.querySelector("#sourceStatus").textContent = formatSource(health.source);
  document.querySelector("#telegramStatus").textContent = health.telegram_enabled
    ? health.telegram_proxy_enabled ? "включен · VLESS" : "включен · напрямую"
    : "выключен";
  document.querySelector("#intervalStatus").textContent = `${health.check_interval_minutes} мин`;
  document.querySelector("#browserParserSidebarStatus").textContent = health.extension_enabled ? "включён" : "выключен";
}

async function loadTracks() {
  const routes = await requestJson("/api/tracking");
  renderTracks(routes);
  populateRouteSelects(routes);
}

function populateRouteSelects(routes) {
  document.querySelectorAll("[data-route-select]").forEach((select) => {
    const currentValue = select.value;
    const firstOption = select.options[0].outerHTML;
    select.innerHTML = firstOption + routes
      .map((route) => `<option value="${route.id}">${route.origin} → ${route.destination}</option>`)
      .join("");
    select.value = currentValue && routes.some((route) => String(route.id) === currentValue) ? currentValue : "";
  });
  const chartRoute = document.querySelector("#chartRoute");
  if (!chartRoute.value && routes.length) chartRoute.value = String(routes[0].id);
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
    await Promise.all([loadResultFeed(), loadErrorFares(), loadPriceChart()]);
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

resultFilters.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadResultFeed();
  } catch (error) {
    resultFeedList.className = "deal-list empty-state";
    resultFeedList.textContent = `Ошибка фильтра: ${error.message}`;
  }
});

document.querySelector("#errorFareRoute").addEventListener("change", () => loadErrorFares().catch(renderErrorFareError));
document.querySelector("#errorFareSource").addEventListener("change", () => loadErrorFares().catch(renderErrorFareError));
document.querySelector("#chartRoute").addEventListener("change", () => loadPriceChart().catch(renderChartError));
document.querySelector("#chartSource").addEventListener("change", () => loadPriceChart().catch(renderChartError));

function renderErrorFareError(error) {
  errorFareList.className = "deal-list empty-state";
  errorFareList.textContent = `Ошибка обновления: ${error.message}`;
}

function renderChartError(error) {
  priceChart.className = "chart empty-state";
  priceChart.textContent = `Ошибка графика: ${error.message}`;
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    tabButtons.forEach((item) => item.classList.toggle("active", item === button));
    tabPanels.forEach((panel) => panel.classList.toggle("active", panel.dataset.tabPanel === tab));
  });
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

async function initialize() {
  setDefaultDates();
  await Promise.all([loadHealth(), loadTracks()]);
  await Promise.all([loadBrowserParser(), loadResultFeed(), loadErrorFares(), loadPriceChart()]);
}

initialize().catch((error) => setMessage(error.message, true));
setInterval(() => {
  loadBrowserParser().catch(renderBrowserParserError);
  loadErrorFares().catch(renderErrorFareError);
}, 30000);
