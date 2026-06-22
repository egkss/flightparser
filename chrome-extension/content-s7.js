(() => {
  const PRICE_PATTERN = /(?:от\s*)?([\d\s\u00a0\u202f]+)\s*₽/i;
  const FLIGHT_PATTERN = /\bS7\s*[-–]?\s*\d{3,4}\b/gi;
  const startedAt = Date.now();
  let completed = false;

  const heartbeatId = setInterval(() => {
    if (!completed) sendMessage({ type: "provider-progress", provider: "s7" });
  }, 10000);

  const intervalId = setInterval(() => {
    if (completed) return;

    const results = extractDeals();
    if (results.length) {
      finish({ type: "provider-results", provider: "s7", results });
      return;
    }

    if (location.pathname.startsWith("/xpvnsulc/") && Date.now() - startedAt > 20000) {
      finish({
        type: "provider-results",
        provider: "s7",
        error: "S7 запросил антибот-проверку; открой сайт S7 вручную и пройди её",
        blocked: true,
        results: [],
      });
      return;
    }

    if (Date.now() - startedAt > 90000) {
      finish({
        type: "provider-results",
        provider: "s7",
        error: "S7 не показал цены за 90 секунд",
        results: [],
      });
    }
  }, 1000);

  function extractDeals() {
    const deals = [];
    const priceElements = [...document.querySelectorAll("button, [role='button']")].filter((element) =>
      PRICE_PATTERN.test(element.innerText || ""),
    );

    for (const priceElement of priceElements) {
      const priceMatch = (priceElement.innerText || "").match(PRICE_PATTERN);
      if (!priceMatch) continue;

      const card = findFlightCard(priceElement);
      if (!card) continue;
      const cardText = card.innerText || "";
      const flightNumbers = [...new Set((cardText.match(FLIGHT_PATTERN) || []).map(normalizeFlightNumber))];
      const isDirect = /\bпрям(?:ой|ые|ая)\b/i.test(cardText);
      if (!flightNumbers.length && !isDirect) continue;

      deals.push({
        price: Number(priceMatch[1].replace(/\D/g, "")),
        flight_number: flightNumbers.join(" + ") || null,
        transfers: flightNumbers.length ? Math.max(0, flightNumbers.length - 1) : 0,
      });
    }

    const unique = new Map();
    for (const deal of deals) {
      unique.set(`${deal.flight_number || "direct"}:${deal.price}`, deal);
    }
    return [...unique.values()].sort((left, right) => left.price - right.price).slice(0, 10);
  }

  function findFlightCard(element) {
    let current = element.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const text = current.innerText || "";
      if (text.length > 5000) break;
      if (/\bS7\s*[-–]?\s*\d{3,4}\b/i.test(text) || /\bпрям(?:ой|ые|ая)\b/i.test(text)) return current;
    }
    return null;
  }

  function normalizeFlightNumber(value) {
    return value.replace(/[\s–-]/g, "").toUpperCase();
  }

  function finish(message) {
    completed = true;
    clearInterval(intervalId);
    clearInterval(heartbeatId);
    sendMessage(message);
  }

  function sendMessage(message) {
    try {
      const response = chrome.runtime.sendMessage(message);
      if (response?.catch) response.catch(() => {});
    } catch {
      completed = true;
      clearInterval(intervalId);
      clearInterval(heartbeatId);
    }
  }
})();
