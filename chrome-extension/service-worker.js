const ALARM_NAME = "aeroflot-monitor";
const DEFAULTS = {
  serverUrl: "",
  extensionToken: "",
  intervalMinutes: 5,
  maxWindowDays: 7,
};

const pendingTabs = new Map();
let monitorRunning = false;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  configureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  configureAlarm();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.intervalMinutes) {
    configureAlarm();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runMonitor().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "aeroflot-results" && sender.tab?.id) {
    const pending = pendingTabs.get(sender.tab.id);
    if (pending) {
      pending.resolve(message);
    }
    return false;
  }

  if (message.type === "aeroflot-progress") {
    return false;
  }

  if (message.type === "run-now") {
    runMonitor()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingTabs.get(tabId);
  if (pending) {
    pending.reject(new Error("Вкладка Аэрофлота была закрыта"));
  }
});

async function configureAlarm() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  const intervalMinutes = Math.max(1, Number(settings.intervalMinutes) || DEFAULTS.intervalMinutes);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: intervalMinutes,
  });
}

async function runMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;

  try {
    const settings = await chrome.storage.local.get(DEFAULTS);
    const serverUrl = normalizeServerUrl(settings.serverUrl);
    if (!serverUrl || !settings.extensionToken) {
      throw new Error("Укажи адрес сервера и токен расширения");
    }

    await setStatus("Получаю активные треки...");
    const routes = await requestJson(`${serverUrl}/api/tracking`);
    const activeRoutes = routes.filter((route) => route.active);
    let sentRoutes = 0;
    let foundDeals = 0;
    const errors = [];

    for (const route of activeRoutes) {
      const dates = buildDateRange(route.date_from, route.date_to);
      if (dates.length > Number(settings.maxWindowDays)) {
        const error = `Пропущен ${route.origin} → ${route.destination}: окно ${dates.length} дней больше лимита`;
        errors.push(error);
        await setStatus(error);
        continue;
      }

      const deals = [];
      for (const departureDate of dates) {
        await setStatus(`${route.origin} → ${route.destination}, ${departureDate}`);
        try {
          const result = await scanDate(route, departureDate);
          deals.push(...result);
        } catch (error) {
          const message = `${route.origin} → ${route.destination}, ${departureDate}: ${error.message}`;
          errors.push(message);
          await setStatus(message);
        }
      }

      const bestDeals = selectBestDeals(deals, route.direct_only);
      if (!bestDeals.length) continue;

      await requestJson(`${serverUrl}/api/providers/aeroflot/results`, {
        method: "POST",
        headers: { "X-Extension-Token": settings.extensionToken },
        body: JSON.stringify({ route_id: route.id, results: bestDeals }),
      });
      sentRoutes += 1;
      foundDeals += bestDeals.length;
    }

    const errorSuffix = errors.length ? `; ошибок ${errors.length}: ${errors[0]}` : "";
    await chrome.storage.local.set({
      lastRunAt: new Date().toISOString(),
      lastStatus: `Готово: треков ${sentRoutes}, цен ${foundDeals}${errorSuffix}`,
    });
  } catch (error) {
    await setStatus(`Ошибка: ${error.message}`);
    throw error;
  } finally {
    monitorRunning = false;
  }
}

async function scanDate(route, departureDate) {
  const url = buildAeroflotUrl(route.origin_code, route.destination_code, departureDate);
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("Chrome не создал вкладку поиска");

  try {
    const message = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingTabs.delete(tab.id);
        reject(new Error("Аэрофлот не отдал результаты за 70 секунд"));
      }, 70000);

      pendingTabs.set(tab.id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          pendingTabs.delete(tab.id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          pendingTabs.delete(tab.id);
          reject(error);
        },
      });
    });

    if (message.error) throw new Error(message.error);
    return message.results.map((item) => ({ ...item, depart_date: departureDate, link: url }));
  } finally {
    pendingTabs.delete(tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `HTTP ${response.status}`);
  }
  return payload;
}

function buildAeroflotUrl(originCode, destinationCode, departureDate) {
  const params = new URLSearchParams({
    adults: "1",
    infants: "0",
    children: "0",
    childrenfrgn: "0",
    childrenaward: "0",
    cabin: "economy",
    routes: `${originCode}.${departureDate.replaceAll("-", "")}.${destinationCode}`,
  });
  return `https://www.aeroflot.ru/ru-ru/sb/search?${params}`;
}

function buildDateRange(dateFrom, dateTo) {
  const result = [];
  const current = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  while (current <= end) {
    result.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return result;
}

function selectBestDeals(deals, directOnly) {
  const unique = new Map();
  for (const deal of deals) {
    if (directOnly && deal.transfers !== 0) continue;
    const key = `${deal.depart_date}:${deal.flight_number || ""}:${deal.price}`;
    unique.set(key, deal);
  }
  return [...unique.values()].sort((a, b) => a.price - b.price).slice(0, 3);
}

function normalizeServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function setStatus(message) {
  await chrome.storage.local.set({ lastStatus: message });
}
