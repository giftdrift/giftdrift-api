// Lightweight AliExpress Affiliate client.
// Работает так: собираем параметры вызова метода,
// подписываем их секретом и дергаем gateway. Если не получится — кидаем ошибку.
// В handler мы поймаем ошибку и вернем моки.

import crypto from "crypto";

const GATEWAY = "https://api-sg.aliexpress.com/sync"; // актуальный gateway для Open Platform (Affiliate)
const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACK_ID = process.env.AE_TRACKING_ID;

// Маппинг наших бюджетов → min/max (USD условно)
const BUDGETS = {
  "$0-10":   { min: 0,   max: 10 },
  "$11-49":  { min: 11,  max: 49 },
  "$50-99":  { min: 50,  max: 99 },
  "$100-499":{ min: 100, max: 499 },
  "$500-999":{ min: 500, max: 999 },
  "$1000+":  { min: 1000, max: null }
};

const INTEREST_KEYWORDS = {
  "Sports & Outdoor": ["fitness", "gym accessories", "running", "cycling"],
  "Cooking & Food": ["coffee grinder", "kitchen gadget", "spice kit"],
  "Tech & Gadgets": ["mini projector", "smart lamp", "earbuds", "power bank"],
  "Art & DIY": ["calligraphy kit", "3d pen", "painting set"],
  "Travel & Adventure": ["scratch map", "packing cubes", "travel organizer"],
  "Books & Learning": ["puzzle", "brain teaser"],
  "Fashion & Accessories": ["minimalist wallet", "scarf", "jewelry"],
  "Home & Decor": ["aroma diffuser", "led strip", "desk lamp"]
};

export async function queryAliExpress({ country, language, budget_bucket, interests, page = 1 }) {
  if (!APP_KEY || !APP_SECRET || !TRACK_ID) {
    throw new Error("AliExpress credentials are not set");
  }

  const kw = pickKeywords(interests);
  const { min, max } = BUDGETS[budget_bucket] || { min: 0, max: null };

  // Бизнес‑параметры метода (имена параметров у AliExpress могут отличаться;
  // если у тебя в консоли AliExpress есть "API Explorer" — бери оттуда точные названия.
  // Эта заготовка покрывает типичный вызов aliexpress.affiliate.product.query)
  const params = {
    method: "aliexpress.affiliate.product.query",
    app_key: APP_KEY,
    timestamp: Date.now().toString(),
    sign_method: "HMAC-SHA256",
    // бизнес-поля:
    keywords: kw.join(" "),
    target_language: language.startsWith("pt") ? "pt" : (language === "ru" ? "ru" : "en"),
    page_size: "40",
    page_no: String(page),
    ship_to_country: country, // "RU" или "BR"
    sort: "SALE_PRICE_ASC",
    min_price: min != null ? String(min) : undefined,
    max_price: max != null ? String(max) : undefined,
    tracking_id: TRACK_ID
  };

  // Удаляем undefined и подписываем
  const clean = Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined));
  const sign = signParams(clean, APP_SECRET);
  const body = new URLSearchParams({ ...clean, sign }).toString();

  const rsp = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });

  if (!rsp.ok) {
    const t = await rsp.text();
    throw new Error(`AliExpress HTTP ${rsp.status}: ${t}`);
  }

  const data = await rsp.json();

  // Точная форма ответа зависит от версии API.
  // Ниже — защитное извлечение массива товаров из нескольких возможных мест.
  const list =
    data?.result?.result_list?.products ||
    data?.result?.result_list ||
    data?.data?.result_list ||
    data?.products ||
    [];

  // Приводим товары к нашему фронтовому формату
  return list
    .map(toItem(language))
    .filter(Boolean);
}

function pickKeywords(interests = []) {
  const arr = [];
  for (const i of interests) {
    const ks = INTEREST_KEYWORDS[i];
    if (ks) arr.push(...ks);
  }
  return arr.length ? arr : ["gift", "present"];
}

// Подпись: сортируем параметры по ключу, склеиваем "keyvalue", HMAC-SHA256 + hex upper
function signParams(params, secret) {
  const sorted = Object.keys(params).sort();
  const concatenated = sorted.map(k => `${k}${params[k]}`).join("");
  const h = crypto.createHmac("sha256", secret).update(concatenated).digest("hex").toUpperCase();
  return h;
}

function toItem(lang) {
  return (p) => {
    const title =
      p?.product_title || p?.title || p?.item_title;
    const image =
      p?.product_main_image_url || p?.image_url || p?.product_image ||
      p?.product_small_image_urls?.[0];
    const price =
      p?.target_sale_price || p?.sale_price || p?.app_sale_price || p?.original_price;
    const currency =
      p?.target_sale_price_currency || p?.currency || "USD";
    const url =
      p?.promotion_link || p?.target_url || p?.product_detail_url || p?.detail_url;

    if (!title || !image || !url || !price) return null;

    return {
      id: String(p?.product_id || p?.item_id || Math.random()),
      title,
      image,
      price: { value: Number(price), currency, display: formatPrice(Number(price), currency) },
      merchant: "AliExpress",
      source: "aliexpress",
      url_aff: url,
      delivery_estimate: null,
      badges: [],
      why: {
        "ru": "Под интересы и бюджет. Доставка в ваш регион.",
        "pt-BR": "Alinha interesses e orçamento. Envio para sua região."
      },
      tags: [],
      budget_hint: "" // можно заполнить сопоставлением цены к нашему бакету
    };
  };
}

function formatPrice(v, cur) {
  if (cur === "BRL") return `R$${v}`;
  if (cur === "RUB") return `${v} ₽`;
  return `$${v}`;
}
