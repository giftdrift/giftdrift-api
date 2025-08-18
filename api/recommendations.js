// api/recommendations.js
// Возвращает товары из AliExpress и жестко фильтрует их по выбранному ценовому диапазону.

import { queryAliExpress } from "./aliexpress.js";

// те же бакеты, что в квизе
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
    const page = Number(qs.get("page") || "1");
    const debugFlag = qs.get("debug") === "1";

    const envOk = !!process.env.AE_APP_KEY && !!process.env.AE_APP_SECRET && !!process.env.AE_TRACKING_ID;

    // входные данные из квиза
    const country = body.country || "BR";           // "RU" | "BR"
    const language = body.language || "pt-BR";      // "ru" | "pt-BR" | "en"
    const budget_bucket = body.budget_bucket || "$11-49";
    const interests = Array.isArray(body.interests) && body.interests.length ? body.interests : ["Tech & Gadgets"];

    // 1) тянем товары из AliExpress (внутри уже есть fallback-стратегии)
    let raw = [];
    let aeError = null;
    try {
      raw = await queryAliExpress({ country, language, budget_bucket, interests, page });
    } catch (e) {
      aeError = e?.message || String(e);
      raw = [];
    }

    // 2) серверная фильтрация по цене (на случай, если Ali вернул что-то вне диапазона)
    const range = BUDGETS[budget_bucket] || BUDGETS["$11-49"];
    const items = filterByBudget(raw, range);

    const payload = { items: items.slice(0, 6), alt_count: Math.max(0, items.length - 6) };
    if (debugFlag) {
      payload.debug = {
        envOk,
        page,
        budget_bucket,
        fetched: raw.length,
        kept: items.length,
        aeError
      };
    }
    return res.status(200).json(payload);
  } catch (e) {
    console.error("recommendations error:", e);
    return res.status(500).json({ error: "server error" });
  }
}

// --- helpers ---

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

// Фильтруем товары по цене. max=null означает «без верхней границы».
function filterByBudget(items, { min, max }) {
  return (items || []).filter(it => {
    const v = Number(it?.price?.value);
    if (!isFinite(v)) return false;
    if (v < min) return false;
    if (max != null && v > max) return false;
    return true;
  });
}
