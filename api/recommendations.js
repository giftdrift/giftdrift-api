// api/recommendations.js
// Серверный эндпоинт: сначала пробует AliExpress, если не получилось — отдаёт моки.
// Включён режим диагностики: добавь ?debug=1 к URL, чтобы в ответе увидеть, подхватились ли переменные и если была ошибка AE.

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
    const qs = getQuery(req);
    const page = Number(qs.get("page") || "1");
    const debug = qs.get("debug") === "1";

    // Проверим наличие переменных окружения
    const envOk = !!process.env.AE_APP_KEY && !!process.env.AE_APP_SECRET && !!process.env.AE_TRACKING_ID;
    console.log("AE env present:", envOk);

    // --- 1) Пытаемся получить товары с AliExpress ---
    let aeItems = [];
    let aeError = null;
    try {
      aeItems = await queryAliExpress({
        country: body.country || "BR",
        language: body.language || "pt-BR",
        budget_bucket: body.budget_bucket || "$11-49",
        interests: Array.isArray(body.interests) && body.interests.length ? body.interests : ["Tech & Gadgets"],
        page
      });
      console.log("AliExpress items:", aeItems.length);
    } catch (e) {
      aeError = e?.message || String(e);
      console.warn("AliExpress failed:", aeError);
    }

    // --- 2) Если AliExpress что‑то вернул — отдаём его, иначе моки ---
    let itemsToSend = [];
    let altCount = 0;

    if (aeItems && aeItems.length) {
      itemsToSend = aeItems.slice(0, 6);
      altCount = Math.max(0, aeItems.length - 6);
    } else {
      const start = (page - 1) * 6;
      const slice = MOCKS.slice(start, start + 6);
      itemsToSend = slice;
      altCount = Math.max(0, MOCKS.length - (start + 6));
    }

    const payload = { items: itemsToSend, alt_count: altCount };
    if (debug) payload.debug = { envOk, aeCount: aeItems?.length || 0, aeError };
    return res.status(200).json(payload);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}

// ---------- helpers ----------
function getQuery(req) {
  return new URL(req.url, "https://x").searchParams;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
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

// ---------- моки (на случай фолбэка) ----------
const MOCKS = [
  {
    id: "mock_proj",
    title: "Mini smartphone projector",
    image: "https://picsum.photos/seed/proj/600/400",
    price: { value: 49, currency: "USD", display: "$49" },
    merchant: "Generic",
    source: "other",
    url_aff: "#",
    delivery_estimate: "3–7 days",
    badges: ["wow", "tech"],
    why: { ru: "Техно + путешествия, в ваш бюджет $50–99. Компактный «вау».", "pt-BR": "Tec + viagem, dentro de $50–99. Compacto e divertido." },
    tags: ["Tech & Gadgets", "Travel & Adventure"],
    budget_hint: "$50-99"
  },
  {
    id: "mock_perf",
    title: "DIY perfume-making kit",
    image: "https://picsum.photos/seed/perf/600/400",
    price: { value: 65, currency: "USD", display: "$65" },
    merchant: "Generic",
    source: "other",
    url_aff: "#",
    badges: ["personalized", "experience"],
    why: { ru: "Творчество + персонализация, в $50–99. Не банально.", "pt-BR": "Criativo + personalizável, em $50–99. Nada óbvio." },
    tags: ["Art & DIY", "Fashion & Accessories"],
    budget_hint: "$50-99"
  },
  {
    id: "mock_map",
    title: "Illuminated world map",
    image: "https://picsum.photos/seed/map/600/400",
    price: { value: 38, currency: "USD", display: "$38" },
    merchant: "Generic",
    source: "other",
    url_aff: "#",
    badges: ["travel", "decor"],
    why: { ru: "Путешествия + декор, в $11–49. Атмосферно.", "pt-BR": "Viagem + décor, em $11–49. Atmosférico." },
    tags: ["Travel & Adventure", "Home & Decor"],
    budget_hint: "$11-49"
  },
  {
    id: "mock_lamp",
    title: "Voice-controlled smart lamp",
    image: "https://picsum.photos/seed/lamp/600/400",
    price: { value: 42, currency: "USD", display: "$42" },
    merchant: "Generic",
    source: "other",
    url_aff: "#",
    badges: ["home", "tech"],
    why: { ru: "Дом + технологии, в $11–49. Удобно каждый день.", "pt-BR": "Casa + tecnologia, em $11–49. Útil no dia a dia." },
    tags: ["Home & Decor", "Tech & Gadgets"],
    budget_hint: "$11-49"
  },
  {
    id: "mock_sushi",
    title: "Sushi-making workshop",
    image: "https://picsum.photos/seed/sushi/600/400",
    price: { value: 55, currency: "USD", display: "$55" },
    merchant: "Local Studio",
    source: "other",
    url_aff: "#",
    badges: ["experience", "foodie"],
    why: { ru: "Впечатление + еда, в $50–99. Вкусно и активно.", "pt-BR": "Experiência + comida, em $50–99. Gostoso e ativo." },
    tags: ["Cooking & Food", "Experiences"],
    budget_hint: "$50-99"
  },
  {
    id: "mock_sleeve",
    title: "Personalized laptop sleeve",
    image: "https://picsum.photos/seed/sleeve/600/400",
    price: { value: 29, currency: "USD", display: "$29" },
    merchant: "Generic",
    source: "other",
    url_aff: "#",
    badges: ["practical", "personalized"],
    why: { ru: "Практично + персонализация, в $11–49. Аккуратно и со вкусом.", "pt-BR": "Prático + personalizável, em $11–49. Limpo e estiloso." },
    tags: ["Tech & Gadgets", "Fashion & Accessories"],
    budget_hint: "$11-49"
  }
];
