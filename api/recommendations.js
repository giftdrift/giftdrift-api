// api/recommendations.js
// AliExpress → фильтр по бакету → если пусто, делаем rescue-вызов (min only) → снова фильтр.

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
    let kept = filterByBudgetUSD(fetched, range);
    let rescueUsed = false;

    // Если пусто — делаем спасательный вызов (min only)
    if (kept.length === 0) {
      try {
        const fetchedRescue = await queryAliExpress({ country, language, budget_bucket, interests, page, rescueMinOnly: true });
        const keptRescue = filterByBudgetUSD(fetchedRescue, range);
        if (keptRescue.length) {
          kept = keptRescue;
          rescueUsed = true;
        }
      } catch (e) {
        aeError = (aeError ? aeError + " | " : "") + (e?.message || String(e));
      }
    }

    // Если всё ещё пусто — отдадим ближайшие к нижней границе (чтобы не показывать пустой экран)
    if (kept.length === 0 && (fetched?.length || 0) > 0) {
      kept = nearestToMin(fetched, range.min ?? 0).slice(0, 6);
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
        rescueUsed,
        samplePrice: fetched[0]?.price,
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

function nearestToMin(items, floor) {
  return (items || [])
    .map(it => ({ it, v: Number(it?.price?.value) }))
    .filter(x => Number.isFinite(x.v))
    .sort((a, b) => (Math.abs(a.v - floor) - Math.abs(b.v - floor)))
    .map(x => x.it);
}
