// api/aliexpress.js
// AliExpress Affiliate API client (TOP protocol).
// Подписывает запрос по MD5 (secret + keyvalue + secret) и возвращает товары.
// Если AliExpress вернёт ошибку — бросаем исключение, а вызывающий код отдаст моки.

import crypto from "crypto";

const GATEWAY = "https://api-sg.aliexpress.com/sync"; // TOP Open Platform gateway
const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACK_ID = process.env.AE_TRACKING_ID;

// Наши бюджетные корзины → min/max в USD (упрощённо)
const BUDGETS = {
  "$0-10":    { min: 0,   max: 10 },
  "$11-49":   { min: 11,  max: 49 },
  "$50-99":   { min: 50,  max: 99 },
  "$100-499": { min: 100, max: 499 },
  "$500-999": { min: 500, max: 999 },
  "$1000+":   { min: 1000, max: null }
};

// Мини-словарь ключевых слов по интересам (можно расширять)
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

  // Базовые TOP-параметры + бизнес-поля метода
  // В некоторых аккаунтах требуется ещё "v":"1.0" — добавим для совместимости.
  const params = {
    method: "aliexpress.affiliate.product.query",
    app_key: APP_KEY,
    timestamp: Date.now().toString(), // TOP принимает мс, строкой
    sign_method: "md5",
    format: "json",
    v: "1.0",

    // бизнес-параметры:
    keywords: kw.join(" "),
    target_language: language?.startsWith("pt") ? "pt" : (language === "ru" ? "ru" : "en"),
    page_size: "40",
    page_no: String(page),
    ship_to_country: country,               // "RU" или "BR"
    sort: "SALE_PRICE_ASC",
    min_price: min != null ? String(min) : undefined,
    max_price: max != null ? String(max) : undefined,
    tracking_id: TRACK_ID
  };

  // Удаляем undefined, считаем подпись и отправляем
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
  const sign = signParamsMD5(clean, APP_SECRET);
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

  // Если TOP вернул ошибку — поднимем её наверх
  if (data?.error_response) {
    // у Ali часто поля: code / msg / sub_msg
    const er = data.error_response;
    const msg = er.sub_msg || er.msg || JSON.stringify(er);
    throw new Error(`AE error: ${msg}`);
  }

  // Разные версии/гейтвеи возвращают товары в разных ветках —
  // попробуем несколько «безопасных» путей.
  const list =
    data?.result?.result_list?.products ||
    data?.result?.result_list ||
    data?.data?.result_list ||
    data?.products ||
    [];

  return (Array.isArray(list) ? list : []).map(toItem(language)).filter(Boolean);
}

// ---------- helpers ----------

function pickKeywords(interests = []) {
  const out = [];
  for (const i of interests) {
    const ks = INTEREST_KEYWORDS[i];
    if (ks) out.push(...ks);
  }
  return out.length ? out : ["gift", "present"];
}

// TOP MD5: md5(secret + (k1v1k2v2...) + secret), где k* — ключи, отсортированные по ASCII
function signParamsMD5(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.map(k => `${k}${params[k]}`).join("");
  const str = `${secret}${concatenated}${secret}`;
  return crypto.createHash("md5").update(str, "utf8").digest("hex").toUpperCase();
}

// Нормализация товара в формат фронта Giftdrift
function toItem(lang) {
  return (p) => {
    const title =
      p?.product_title || p?.title || p?.item_title;
    const image =
      p?.product_main_image_url || p?.image_url || p?.product_image || p?.product_small_image_urls?.[0];
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
        ru: "Под интересы и бюджет. Доставка в ваш регион.",
        "pt-BR": "Alinha interesses e orçamento. Envio para sua região."
      },
      tags: [],
      budget_hint: ""
    };
  };
}

function formatPrice(v, cur) {
  if (cur === "BRL") return `R$${v}`;
  if (cur === "RUB") return `${v} ₽`;
  return `$${v}`;
}
