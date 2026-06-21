const searchForm = document.querySelector("#searchForm");
const createTrackButton = document.querySelector("#createTrackButton");
const runMonitorButton = document.querySelector("#runMonitorButton");
const formMessage = document.querySelector("#formMessage");
const resultsList = document.querySelector("#resultsList");
const trackingList = document.querySelector("#trackingList");
const historyList = document.querySelector("#historyList");
const historyTitle = document.querySelector("#historyTitle");

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
            <a href="${deal.link}" target="_blank" rel="noreferrer">Открыть</a>
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
          <div class="meta">Падение: ${item.drop_percent === null ? "нет данных" : `${item.drop_percent}%`}</div>
          <a href="${item.link}" target="_blank" rel="noreferrer">Открыть билет</a>
        </article>
      `,
    )
    .join("");
}

async function loadHealth() {
  const health = await requestJson("/api/health");
  document.querySelector("#sourceStatus").textContent = health.source;
  document.querySelector("#telegramStatus").textContent = health.telegram_enabled ? "включен" : "выключен";
  document.querySelector("#intervalStatus").textContent = `${health.check_interval_minutes} мин`;
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
