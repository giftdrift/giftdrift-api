// api/recommendations.js
// Без моков: всегда пробуем AliExpress. Если AliExpress упал — вернём пустой список и описание ошибки (в debug при ?debug=1).

import { queryAliExpress } from "./aliexpress.js";

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

    // Проверим наличие ключей
    const envOk =
      !!process.env.AE_APP_KEY &&
      !!process.env.AE_APP_SECRET &&
      !!process.env.AE_TRACKING_ID;

    if (!envOk) {
      const payload = { items: [], alt_count: 0 };
      if (debugFlag) payload.debug = { envOk, aeError: "AliExpress credentials are missing" };
      return res.status(200).json(payload);
    }

    // Нормализуем вход
    const country = body.country || "BR";        // "RU" или "BR"
    const language = body.language || "pt-BR";   // "ru" или "pt-BR"
    const budget_bucket = body.budget_bucket || "$11-49";
    const interests = Array.isArray(body.interests) && body.interests.length
      ? body.interests
      : ["Tech & Gadgets"];

    // Запрашиваем AliExpress
    let items = [];
    let aeError = null;
    try {
      items = await queryAliExpress({ country, language, budget_bucket, interests, page });
    } catch (e) {
      aeError = e?.message || String(e);
      items = [];
    }

    const payload = { items: items.slice(0, 6), alt_count: Math.max(0, items.length - 6) };
    if (debugFlag) payload.debug = { envOk, aeCount: items.length, aeError };
    return res.status(200).json(payload);

  } catch (e) {
    console.error("recommendations error:", e);
    return res.status(500).json({ error: "server error" });
  }
}

// -------- helpers --------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
