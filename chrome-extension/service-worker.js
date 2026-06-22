const ALARM_NAME = "direct-fare-monitor";
const HEARTBEAT_ALARM_NAME = "direct-fare-heartbeat";
const RECHECK_DELAY_MS = 45000;
const DEFAULTS = {
  serverUrl: "",
  extensionToken: "",
  intervalMinutes: 5,
  maxWindowDays: 7,
  aeroflotEnabled: true,
  s7Enabled: true,
};

const PROVIDERS = {
  aeroflot: {
    title: "Аэрофлот",
    timeoutSeconds: 70,
    buildUrl: buildAeroflotUrl,
  },
  s7: {
    title: "S7",
    timeoutSeconds: 100,
    buildUrl: buildS7Url,
  },
};

const pendingTabs = new Map();
let monitorRunning = false;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  configureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  configureAlarms();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.intervalMinutes) {
    configureAlarms();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runMonitor().catch(() => {});
  } else if (alarm.name === HEARTBEAT_ALARM_NAME) {
    sendStoredStatus();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "provider-results" && sender.tab?.id) {
    const pending = pendingTabs.get(sender.tab.id);
    if (pending && pending.provider === message.provider) {
      pending.resolve(message);
    }
    return false;
  }

  if (message.type === "provider-progress") {
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
    pending.reject(new Error(`Вкладка ${PROVIDERS[pending.provider].title} была закрыта`));
  }
});

async function configureAlarms() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  const intervalMinutes = Math.max(1, Number(settings.intervalMinutes) || DEFAULTS.intervalMinutes);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: intervalMinutes,
  });
  await chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: 1,
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
    const enabledProviders = Object.keys(PROVIDERS).filter((provider) => settings[`${provider}Enabled`]);
    if (!enabledProviders.length) throw new Error("Включи хотя бы один прямой источник");
    await updateMonitorState(settings, "running", null, null, null, enabledProviders);
    let sentRoutes = 0;
    let foundDeals = 0;
    const errors = [];
    const recheckQueue = [];

    for (const route of activeRoutes) {
      const dates = buildDateRange(route.date_from, route.date_to);
      if (dates.length > Number(settings.maxWindowDays)) {
        const error = `Пропущен ${route.origin} → ${route.destination}: окно ${dates.length} дней больше лимита`;
        errors.push(error);
        await setStatus(error);
        continue;
      }

      for (const provider of enabledProviders) {
        const deals = [];
        for (const departureDate of dates) {
          const currentRoute = `${PROVIDERS[provider].title}: ${route.origin} → ${route.destination}, ${departureDate}`;
          await setStatus(currentRoute);
          await updateMonitorState(settings, "running", currentRoute, null, null, enabledProviders);
          try {
            const result = await scanDate(provider, route, departureDate);
            deals.push(...result);
          } catch (error) {
            const message = `${PROVIDERS[provider].title}, ${route.origin} → ${route.destination}, ${departureDate}: ${error.message}`;
            errors.push(message);
            await setStatus(message);
            if (error.blockProvider) break;
          }
        }

        const bestDeals = selectBestDeals(deals, route.direct_only);
        if (!bestDeals.length) continue;

        const ingestResult = await requestJson(`${serverUrl}/api/providers/results`, {
          method: "POST",
          headers: { "X-Extension-Token": settings.extensionToken },
          body: JSON.stringify({ provider, route_id: route.id, confirmation_attempt: 0, results: bestDeals }),
        });
        for (const departureDate of ingestResult.recheck_dates || []) {
          recheckQueue.push({ provider, route, departureDate });
        }
        sentRoutes += 1;
        foundDeals += bestDeals.length;
      }
    }

    foundDeals += await recheckAnomalies(recheckQueue, settings, serverUrl, enabledProviders, errors);

    const errorSuffix = errors.length ? `; ошибок ${errors.length}: ${errors[0]}` : "";
    const lastRunAt = new Date().toISOString();
    await chrome.storage.local.set({
      lastRunAt,
      lastStatus: `Готово: треков ${sentRoutes}, цен ${foundDeals}${errorSuffix}`,
    });
    await updateMonitorState(settings, "idle", null, errors[0] || null, lastRunAt, enabledProviders);
  } catch (error) {
    await setStatus(`Ошибка: ${error.message}`);
    const settings = await chrome.storage.local.get(DEFAULTS);
    const providers = Object.keys(PROVIDERS).filter((provider) => settings[`${provider}Enabled`]);
    await updateMonitorState(settings, "error", null, error.message, null, providers);
    throw error;
  } finally {
    monitorRunning = false;
  }
}

async function recheckAnomalies(queue, settings, serverUrl, enabledProviders, errors) {
  const uniqueQueue = new Map();
  for (const item of queue) {
    uniqueQueue.set(`${item.provider}:${item.route.id}:${item.departureDate}`, item);
  }

  let savedDeals = 0;
  for (const item of uniqueQueue.values()) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await delay(RECHECK_DELAY_MS);
      const currentRoute = `Подтверждение ${attempt}/2, ${PROVIDERS[item.provider].title}: ${item.route.origin} → ${item.route.destination}, ${item.departureDate}`;
      await setStatus(currentRoute);
      await updateMonitorState(settings, "running", currentRoute, null, null, enabledProviders);
      try {
        const deals = await scanDate(item.provider, item.route, item.departureDate);
        const bestDeals = selectBestDeals(deals, item.route.direct_only);
        if (!bestDeals.length) continue;
        await requestJson(`${serverUrl}/api/providers/results`, {
          method: "POST",
          headers: { "X-Extension-Token": settings.extensionToken },
          body: JSON.stringify({
            provider: item.provider,
            route_id: item.route.id,
            confirmation_attempt: attempt,
            results: bestDeals,
          }),
        });
        savedDeals += bestDeals.length;
      } catch (error) {
        errors.push(`${currentRoute}: ${error.message}`);
      }
    }
  }
  return savedDeals;
}

async function scanDate(provider, route, departureDate) {
  const providerConfig = PROVIDERS[provider];
  const url = providerConfig.buildUrl(route.origin_code, route.destination_code, departureDate);
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("Chrome не создал вкладку поиска");

  try {
    const message = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingTabs.delete(tab.id);
        reject(new Error(`${providerConfig.title} не отдал результаты за ${providerConfig.timeoutSeconds} секунд`));
      }, providerConfig.timeoutSeconds * 1000);

      pendingTabs.set(tab.id, {
        provider,
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

    if (message.error) {
      const error = new Error(message.error);
      error.blockProvider = Boolean(message.blocked);
      throw error;
    }
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

function buildS7Url(originCode, destinationCode, departureDate) {
  const params = new URLSearchParams({
    DT1: "00:00:00",
    id: "deeplink",
    CUR: "RUB",
    useProxyMode: "true",
    searchTypeRed: "portalAvia",
    pet: "false",
    SC1: "ANY",
    FLX: "false",
    LAN: "ru",
    RDMPTN: "false",
    journeySpan: "OW",
    DA1: originCode,
    AA1: destinationCode,
    DD1: departureDate,
    FSC1: "1",
    mix: "false",
    FLC: "1",
    TA: "1",
    TY: "0",
    TC: "0",
    TI: "0",
    ibe_medium: "aviaparser_extension",
  });
  return `https://ibe.s7.ru/air?${params}`;
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

async function updateMonitorState(settings, state, currentRoute, lastError, lastRunAt, providers) {
  await chrome.storage.local.set({
    monitorState: state,
    currentRoute,
    lastError,
    heartbeatProviders: providers,
  });
  await reportStatus(settings, state, currentRoute, lastError, lastRunAt, providers);
}

async function sendStoredStatus() {
  const settings = await chrome.storage.local.get({
    ...DEFAULTS,
    monitorState: "idle",
    currentRoute: null,
    lastError: null,
    lastRunAt: null,
    heartbeatProviders: [],
  });
  const providers = settings.heartbeatProviders.length
    ? settings.heartbeatProviders
    : Object.keys(PROVIDERS).filter((provider) => settings[`${provider}Enabled`]);
  await reportStatus(
    settings,
    settings.monitorState,
    settings.currentRoute,
    settings.lastError,
    settings.lastRunAt,
    providers,
  );
}

async function reportStatus(settings, state, currentRoute, lastError, lastRunAt, providers) {
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  if (!serverUrl || !settings.extensionToken) return;
  try {
    await requestJson(`${serverUrl}/api/providers/browser/status`, {
      method: "POST",
      headers: { "X-Extension-Token": settings.extensionToken },
      body: JSON.stringify({ state, current_route: currentRoute, last_error: lastError, last_run_at: lastRunAt, providers }),
    });
    await chrome.storage.local.remove("lastHeartbeatError");
  } catch (error) {
    await chrome.storage.local.set({ lastHeartbeatError: error.message });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
