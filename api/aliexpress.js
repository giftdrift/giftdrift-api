// api/recommendations.js
// AliExpress → жёсткий фильтр по бакету → умный фолбэк, чтобы не отдавать пусто.

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
    const page = Number(qs.get("page") || "1");
    const debugFlag = qs.get("debug") === "1";

    const envOk = !!process.env.AE_APP_KEY && !!process.env.AE_APP_SECRET && !!process.env.AE_TRACKING_ID;

    const country = body.country || "BR";
    const language = body.language || "pt-BR";
    const budget_bucket = body.budget_bucket || "$11-49";
    const interests = Array.isArray(body.interests) && body.interests.length ? body.interests : ["Tech & Gadgets"];

    let fetched = [];
    let aeError = null;
    try {
      fetched = await queryAliExpress({ country, language, budget_bucket, interests, page });
    } catch (e) {
      aeError = e?.message || String(e);
      fetched = [];
    }

    const range = BUDGETS[budget_bucket] || BUDGETS["$11-49"];
    const keptStrict = filterByBudgetUSD(fetched, range);

    // Фолбэк 1: расширяем окно на ±20%
    let kept = keptStrict;
    let fallback = null;
    if (kept.length === 0 && fetched.length) {
      const widened = widenRange(range, 0.2); // ±20%
      const keptWiden = filterByBudgetUSD(fetched, widened);
      if (keptWiden.length) {
        kept = keptWiden;
        fallback = { type: "widen", range: widened };
      }
    }

    // Фолбэк 2: если всё ещё пусто — берём ближайшие к нижней границе бакета (минимум),
    // чтобы показать «почти подходящие» вместо пустой выдачи.
    if (kept.length === 0 && fetched.length) {
      const floor = range.min ?? 0;
      const near = fetched
        .filter(it => Number.isFinite(Number(it?.price?.value)))
        .map(it => ({ it, v: Number(it.price.value) }))
        .filter(({ v }) => v >= floor * 0.6)               // отсечь явный мусор ниже 60% от min
        .sort((a, b) => (a.v - floor) - (b.v - floor))     // ближе к min — выше
        .slice(0, 12)
        .map(({ it }) => it);
      if (near.length) {
        kept = near;
        fallback = { type: "nearest_to_min", floor };
      }
    }

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
        samplePrice: fetched[0]?.price,
        fallback,
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
    req.on("data", c => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function filterByBudgetUSD(items, { min, max }) {
  return (items || []).filter(it => {
    const v = Number(it?.price?.value);
    if (!Number.isFinite(v)) return false;
    if (v < min) return false;
    if (max != null && v > max) return false;
    return true;
  });
}

function widenRange({ min, max }, pct = 0.2) {
  const widen = (v, s) => Math.max(0, Math.round((v + s * v * pct) * 100) / 100);
  const out = { min, max };
  if (min != null) out.min = widen(min, -1); // -20%
  if (max != null) out.max = widen(max, +1); // +20%
  return out;
}
