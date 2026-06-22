const DEFAULTS = {
  serverUrl: "",
  extensionToken: "",
  intervalMinutes: 5,
  maxWindowDays: 7,
  aeroflotEnabled: true,
  s7Enabled: true,
};

const form = document.querySelector("#settingsForm");
const statusElement = document.querySelector("#status");
const lastRunElement = document.querySelector("#lastRun");

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set(readForm());
  setStatus("Настройки сохранены");
});

document.querySelector("#testButton").addEventListener("click", async () => {
  try {
    const settings = readForm();
    const response = await fetch(`${normalizeServerUrl(settings.serverUrl)}/api/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    const extensionStatus = health.extension_enabled ? "приём расширения включён" : "токен не настроен";
    setStatus(`Сервер доступен: ${extensionStatus}`);
  } catch (error) {
    setStatus(`Ошибка подключения: ${error.message}`);
  }
});

document.querySelector("#runButton").addEventListener("click", async () => {
  setStatus("Мониторинг запущен...");
  const response = await chrome.runtime.sendMessage({ type: "run-now" });
  setStatus(response.ok ? "Проверка завершена" : `Ошибка: ${response.error}`);
  await renderStatus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.lastStatus || changes.lastRunAt)) {
    renderStatus();
  }
});

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  document.querySelector("#serverUrl").value = settings.serverUrl;
  document.querySelector("#extensionToken").value = settings.extensionToken;
  document.querySelector("#intervalMinutes").value = settings.intervalMinutes;
  document.querySelector("#maxWindowDays").value = settings.maxWindowDays;
  document.querySelector("#aeroflotEnabled").checked = settings.aeroflotEnabled;
  document.querySelector("#s7Enabled").checked = settings.s7Enabled;
  await renderStatus();
}

function readForm() {
  return {
    serverUrl: normalizeServerUrl(document.querySelector("#serverUrl").value),
    extensionToken: document.querySelector("#extensionToken").value.trim(),
    intervalMinutes: Number(document.querySelector("#intervalMinutes").value),
    maxWindowDays: Number(document.querySelector("#maxWindowDays").value),
    aeroflotEnabled: document.querySelector("#aeroflotEnabled").checked,
    s7Enabled: document.querySelector("#s7Enabled").checked,
  };
}

async function renderStatus() {
  const state = await chrome.storage.local.get({ lastStatus: "Ещё не запускалось", lastRunAt: "" });
  setStatus(state.lastStatus);
  lastRunElement.textContent = state.lastRunAt
    ? `Последний полный запуск: ${new Date(state.lastRunAt).toLocaleString("ru-RU")}`
    : "";
}

function normalizeServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function setStatus(message) {
  statusElement.textContent = message;
}
