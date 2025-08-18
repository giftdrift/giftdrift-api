// api/recommendations.js
// Возвращает товары из AliExpress и ЖЁСТКО фильтрует их по выбранному ценовому диапазону (в USD).

import { queryAliExpress } from "./aliexpress.js";

// Бюджетные бакеты — строго совпадают с вариантами в квизе
const BUDGETS = {
  "$0-10":    { min: 0,   max: 10 },
  "$11-49":   { min: 11,  max: 49 },
  "$50-99":   { min: 50,  max: 99 },
  "$100-499": { min: 100, max: 499 },
  "$500-999": { min: 500, max: 999 },
  "$1000+":   { min: 1000, max: null } // null = без верхней границы
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

    // Проверка наличия ключей AE в окружении
    const envOk = !!process.env.AE_APP_KEY && !!process.env.AE_APP_SECRET && !!process.env.AE_TRACKING_ID;

    // Входные поля из квиза
    const country = body.country || "BR";         // "RU" | "BR"
    const language = body.language || "pt-BR";    // "ru" | "pt-BR" | "en"
    const budget_bucket = body.budget_bucket || "$11-49";
    const interests = Array.isArray(body.interests) && body.interests.length
      ? body.interests
      : ["Tech & Gadgets"];

    // 1) Тянем товары у AliExpress (внутри aliexpress.js уже есть fallback-стратегии и target_currency: "USD")
    let fetched = [];
    let aeError = null;
    try {
      fetched = await queryAliExpress({ country, language, budget_bucket, interests, page });
    } catch (e) {
      aeError = e?.message || String(e);
      fetched = [];
    }

    // 2) Серверная фильтрация по выбранному ценовому бакету (цены в USD)
    const range = BUDGETS[budget_bucket] || BUDGETS["$11-49"];
    const kept = filterByBudgetUSD(fetched, range);

    // 3) Ответ
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
        samplePrice: fetched[0]?.price, // для быстрой проверки формата
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
 * Фильтруем товары по цене в USD.
 * Ожидается, что aliexpress.js нормализует цену как:
 *   item.price = { value: <number USD>, currency: "USD", display: "$<value>" }
 */
function filterByBudgetUSD(items, { min, max }) {
  return (items || []).filter((it) => {
    const v = Number(it?.price?.value);
    if (!Number.isFinite(v)) return false;
    if (v < min) return false;
    if (max != null && v > max) return false; // включительно на верхней границе
    return true;
  });
}
