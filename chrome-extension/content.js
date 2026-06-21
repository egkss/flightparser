(() => {
  const RESULT_SELECTOR = '[role="group"][aria-label="Классы обслуживания"]';
  const PRICE_PATTERN = /(?:от\s*)?([\d\s\u00a0\u202f]+)\s*₽/;
  const FLIGHT_PATTERN = /\b[A-Z0-9]{2}\s?\d{3,4}\b/g;
  const startedAt = Date.now();
  let completed = false;

  const heartbeatId = setInterval(() => {
    if (!completed) {
      chrome.runtime.sendMessage({ type: "aeroflot-progress" }).catch(() => {});
    }
  }, 10000);

  const intervalId = setInterval(() => {
    if (completed) return;

    const groups = [...document.querySelectorAll(RESULT_SELECTOR)];
    if (groups.length) {
      const results = groups.map(extractDeal).filter(Boolean);
      if (results.length) {
        completed = true;
        clearInterval(intervalId);
        clearInterval(heartbeatId);
        chrome.runtime.sendMessage({ type: "aeroflot-results", results });
        return;
      }
    }

    if (Date.now() - startedAt > 60000) {
      completed = true;
      clearInterval(intervalId);
      clearInterval(heartbeatId);
      chrome.runtime.sendMessage({
        type: "aeroflot-results",
        error: "На странице не появились цены; проверь CAPTCHA или блокировку",
        results: [],
      });
    }
  }, 1000);

  function extractDeal(group) {
    const economyButton = [...group.querySelectorAll("button")].find((button) =>
      button.innerText.trim().startsWith("Эконом"),
    );
    if (!economyButton || economyButton.disabled) return null;

    const priceMatch = economyButton.innerText.match(PRICE_PATTERN);
    if (!priceMatch) return null;

    const card = group.parentElement?.parentElement;
    const cardText = card?.innerText || "";
    const flightNumbers = [...new Set((cardText.match(FLIGHT_PATTERN) || []).map(normalizeFlightNumber))];

    return {
      price: Number(priceMatch[1].replace(/\D/g, "")),
      flight_number: flightNumbers.join(" + ") || null,
      transfers: Math.max(0, flightNumbers.length - 1),
    };
  }

  function normalizeFlightNumber(value) {
    return value.replace(/\s/g, "");
  }
})();
