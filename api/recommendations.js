// api/recommendations.js
// Многостраничный подбор + rescue: AliExpress → фильтр по бакету → добор со страниц и min-only → «ближайшие к min».

import { queryAliExpress } from "./aliexpress.js";

const BUDGETS = {
  "$0-10":    { min: 0,   max: 10 },
  "$11-49":   { min: 11,  max: 49 },
  "$50-99":   { min: 50,  max: 99 },
  "$100-499": { min: 100, max: 499 },
  "$500-999": { min: 500, max: 999 },
  "$1000+":   { min: 1000, max: null }
};

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = await readBody(req);
    const qs = new URL(req.url, "https://x").searchParams;
    const startPage = Number(qs.get("page") || "1");
    const debugFlag = qs.get("debug") === "1";

    const envOk = !!process.env.AE_APP_KEY && !!process.env.AE_APP_SECRET && !!process.env.AE_TRACKING_ID;

    // Из квиза
    const country = body.country || "BR";
    const language = body.language || "pt-BR";
    const budget_bucket = body.budget_bucket || "$11-49";
    const interests = Array.isArray(body.interests) && body.interests.length ? body.interests : ["Tech & Gadgets"];
    const range = BUDGETS[budget_bucket] || BUDGETS["$11-49"];

    // --- 1) Основной цикл: до 5 страниц + rescue на каждой странице ---
    const TARGET_COUNT = 6;
    const MAX_PAGES = 5;

    let collected = [];
    let fetchedAll = [];         // для debug и fallback ближайших
    let pagesTried = 0;
    let rescueHits = 0;
    let aeError = null;

    for (let p = startPage; p < startPage + MAX_PAGES && collected.length < TARGET_COUNT; p++) {
      pagesTried++;

      // базовый запрос
      let pageItems = [];
      try {
        pageItems = await queryAliExpress({ country, language, budget_bucket, interests, page: p });
      } catch (e) {
        aeError = (aeError ? aeError + " | " : "") + (e?.message || String(e));
      }

      fetchedAll.push(...(pageItems || []));

      // фильтруем по бакету
      const kept = filterByBudgetUSD(pageItems, range);
      collected.push(...kept);

      // если всё ещё мало — rescue (min only) на той же странице
      if (collected.length < TARGET_COUNT) {
        try {
          const rescuePage = await queryAliExpress({ country, language, budget_bucket, interests, page: p, rescueMinOnly: true });
          fetchedAll.push(...(rescuePage || []));
          const keptRescue = filterByBudgetUSD(rescuePage, range);
          if (keptRescue.length) rescueHits++;
          collected.push(...keptRescue);
        } catch (e) {
          aeError = (aeError ? aeError + " | " : "") + (e?.message || String(e));
        }
      }
    }

    // Удалим дубликаты по id/url_aff
    collected = dedupeByKey(collected, (x) => x?.id || x?.url_aff || x?.title);

    // --- 2) Если после всех попыток всё ещё пусто — возьмём ближайшие к нижней границе ---
    if (collected.length === 0 && fetchedAll.length) {
      const floor = typeof range.min === "number" ? range.min : 0;
      collected = nearestToMin(fetchedAll, floor).slice(0, TARGET_COUNT);
    }

    // --- 3) Финальная выборка для ответа ---
    const items = collected.slice(0, TARGET_COUNT);
    const alt_count = Math.max(0, collected.length - TARGET_COUNT);

    const payload = { items, alt_count };

    if (debugFlag) {
      payload.debug = {
        envOk,
        page: startPage,
        pagesTried,
        budget_bucket,
        fetched: fetchedAll.length,
        kept: collected.length,
        rescueHits,
        // первые 10 цен для быстрой проверки
        fetchedPrices: fetchedAll.slice(0, 10).map(x => x?.price?.value),
        keptPrices: collected.slice(0, 10).map(x => x?.price?.value),
        aeError
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error("recommendations error:", e);
    return res.status(500).json({ error: "server error" });
  }
}

// ---------- helpers ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Фильтр по бакету — ожидаем USD number в item.price.value
function filterByBudgetUSD(items, { min, max }) {
  return (items || []).filter((it) => {
    const v = Number(it?.price?.value);
    if (!Number.isFinite(v)) return false;
    if (typeof min === "number" && v < min) return false;
    if (typeof max === "number" && v > max) return false;
    return true;
  });
}

// Ближайшие к нижней границе, отсекём < 60% от min
function nearestToMin(items, floor) {
  const cutoff = Math.max(0, floor * 0.6);
  return (items || [])
    .map(it => ({ it, v: Number(it?.price?.value) }))
    .filter(x => Number.isFinite(x.v) && x.v >= cutoff)
    .sort((a, b) => (Math.abs(a.v - floor) - Math.abs(b.v - floor)))
    .map(x => x.it);
}

// Простая дедупликация
function dedupeByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
