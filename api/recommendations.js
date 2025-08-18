// api/recommendations.js
// AliExpress → жесткий фильтр по бакету → rescue-вызов (min only) → «ближайшие к min», чтобы избежать пустых выдач.

import { queryAliExpress } from "./aliexpress.js";

// Бакеты — должны совпадать с фронтом
const BUDGETS = {
  "$0-10":    { min: 0,   max: 10 },
  "$11-49":   { min: 11,  max: 49 },
  "$50-99":   { min: 50,  max: 99 },
  "$100-499": { min: 100, max: 499 },
  "$500-999": { min: 500, max: 999 },
  "$1000+":   { min: 1000, max: null } // null = без верхнего потолка
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
    const page = Number(qs.get("page") || "1");
    const debugFlag = qs.get("debug") === "1";

    const envOk = !!process.env.AE_APP_KEY && !!process.env.AE_APP_SECRET && !!process.env.AE_TRACKING_ID;

    // Входные поля из квиза
    const country = body.country || "BR";         // "RU" | "BR"
    const language = body.language || "pt-BR";    // "ru" | "pt-BR" | "en"
    const budget_bucket = body.budget_bucket || "$11-49";
    const interests = Array.isArray(body.interests) && body.interests.length
      ? body.interests
      : ["Tech & Gadgets"];

    // Диапазон по бакету
    const range = BUDGETS[budget_bucket] || BUDGETS["$11-49"];

    // 1) Базовый запрос
    let fetched = [];
    let aeError = null;
    try {
      fetched = await queryAliExpress({ country, language, budget_bucket, interests, page });
    } catch (e) {
      aeError = e?.message || String(e);
      fetched = [];
    }

    // 2) Жёсткая фильтрация по бакету (USD number)
    let kept = filterByBudgetUSD(fetched, range);

    // 3) Rescue: если пусто — второй вызов к AE (min only, без max, SALE_PRICE_ASC)
    let rescueUsed = false;
    if (kept.length === 0) {
      try {
        const rescued = await queryAliExpress({
          country,
          language,
          budget_bucket,
          interests,
          page,
          rescueMinOnly: true
        });
        const keptRescue = filterByBudgetUSD(rescued, range);
        if (keptRescue.length) {
          kept = keptRescue;
          rescueUsed = true;
        }
      } catch (e) {
        aeError = (aeError ? aeError + " | " : "") + (e?.message || String(e));
      }
    }

    // 4) «Ближайшие к нижней границе»: чтобы не отдавать пусто
    // Берём товары ≥ 60% от min и сортируем по расстоянию к min
    if (kept.length === 0 && (fetched?.length || 0) > 0) {
      const floor = typeof range.min === "number" ? range.min : 0;
      kept = nearestToMin(fetched, floor).slice(0, 12);
    }

    // 5) Ответ (до 6 карточек)
    const items = kept.slice(0, 6);
    const alt_count = Math.max(0, kept.length - 6);

    const payload = { items, alt_count };
    if (debugFlag) {
      payload.debug = {
        envOk,
        page,
        budget_bucket,
        fetched: fetched.length,
        kept: kept.length,
        rescueUsed,
        // покажем первые 10 цен, чтобы быстро видеть вход
        fetchedPrices: (fetched || []).slice(0, 10).map(x => x?.price?.value),
        // и первые 10 оставшихся после фильтра
        keptPrices: (kept || []).slice(0, 10).map(x => x?.price?.value),
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

/**
 * Фильтр по бакету — использует price.value (ожидается USD number).
 */
function filterByBudgetUSD(items, { min, max }) {
  return (items || []).filter((it) => {
    const v = Number(it?.price?.value);
    if (!Number.isFinite(v)) return false;
    if (typeof min === "number" && v < min) return false;
    if (typeof max === "number" && v > max) return false;
    return true;
  });
}

/**
 * Ближайшие к нижней границе, но отсечём «совсем дешёвку» (< 60% от min).
 */
function nearestToMin(items, floor) {
  const cutoff = Math.max(0, floor * 0.6);
  return (items || [])
    .map(it => ({ it, v: Number(it?.price?.value) }))
    .filter(x => Number.isFinite(x.v) && x.v >= cutoff)
    .sort((a, b) => (Math.abs(a.v - floor) - Math.abs(b.v - floor)))
    .map(x => x.it);
}
