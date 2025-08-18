// api/aliexpress.js
// AliExpress Affiliate API (TOP). Подпись MD5, USD-цены, явные min/max во всех попытках, fallback с расширением диапазона.

import crypto from "crypto";

const GATEWAY = "https://api-sg.aliexpress.com/sync";
const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACK_ID = process.env.AE_TRACKING_ID;

// Бакеты бюджета — синхронны с фронтом/рекомендациями
const BUDGETS = {
  "$0-10":    { min: 0,   max: 10 },
  "$11-49":   { min: 11,  max: 49 },
  "$50-99":   { min: 50,  max: 99 },
  "$100-499": { min: 100, max: 499 },
  "$500-999": { min: 500, max: 999 },
  "$1000+":   { min: 1000, max: null }
};

// Ключевики по интересам
const KW = {
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

  const { min, max } = getRange(budget_bucket);
  const keywords = pickKeywords(interests).join(" ");
  const lang = language?.startsWith("pt") ? "pt" : (language === "ru" ? "ru" : "en");

  // Попытка 1 — строгая: локальный язык, доставка, min/max, сортируем по популярности (лучше, чем price asc)
  let r = await callTop("aliexpress.affiliate.product.query", {
    keywords,
    target_language: lang,
    target_currency: "USD",
    page_size: "40",
    page_no: String(page),
    ship_to_country: country,
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID,
    ...(min != null ? { min_price: String(min) } : {}),
    ...(max != null ? { max_price: String(max) } : {})
  });
  if (r.items.length) return r.items;

  // Попытка 2 — без ship_to_country, но с тем же ценовым коридором
  r = await callTop("aliexpress.affiliate.product.query", {
    keywords,
    target_language: lang,
    target_currency: "USD",
    page_size: "60",
    page_no: String(page),
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID,
    ...(min != null ? { min_price: String(min) } : {}),
    ...(max != null ? { max_price: String(max) } : {})
  });
  if (r.items.length) return r.items;

  // Попытка 3 — принудительно EN, тот же диапазон
  r = await callTop("aliexpress.affiliate.product.query", {
    keywords,
    target_language: "en",
    target_currency: "USD",
    page_size: "80",
    page_no: String(page),
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID,
    ...(min != null ? { min_price: String(min) } : {}),
    ...(max != null ? { max_price: String(max) } : {})
  });
  if (r.items.length) return r.items;

  // Попытка 4 — мягкое расширение диапазона (±20%), EN, без доставки
  const widened = widenRange({ min, max }, 0.2);
  r = await callTop("aliexpress.affiliate.product.query", {
    keywords,
    target_language: "en",
    target_currency: "USD",
    page_size: "100",
    page_no: String(page),
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID,
    ...(widened.min != null ? { min_price: String(widened.min) } : {}),
    ...(widened.max != null ? { max_price: String(widened.max) } : {})
  });
  return r.items; // может вернуться пусто — тогда наружный фильтр просто ничего не покажет
}

// ---------- TOP caller + utils ----------

async function callTop(method, bizParams) {
  const ts = topTimestampCN(); // 'YYYY-MM-DD HH:mm:ss' GMT+8
  const params = {
    method,
    app_key: APP_KEY,
    sign_method: "md5",
    format: "json",
    v: "1.0",
    timestamp: ts,
    ...bizParams
  };

  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
  const sign = signParamsMD5(clean, APP_SECRET);
  const body = new URLSearchParams({ ...clean, sign }).toString();

  // Короткий лог для отладки
  console.log("AE request meta:", {
    lang: clean.target_language,
    page_no: clean.page_no,
    sort: clean.sort,
    ship_to: !!clean.ship_to_country,
    priced: !!(clean.min_price || clean.max_price),
    min_price: clean.min_price || null,
    max_price: clean.max_price || null
  });

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
  if (data?.error_response) {
    const er = data.error_response;
    const msg = er.sub_msg || er.msg || JSON.stringify(er);
    throw new Error(`AE error: ${msg}`);
  }

  const products = extractProducts(data);
  console.log("AE parsed items:", products.length);

  const items = products.map(toItem()).filter(Boolean);
  return { items, rawCount: products.length };
}

function extractProducts(data) {
  // TOP-обёртки
  let node =
    data?.aliexpress_affiliate_product_query_response?.resp_result?.result ??
    data?.aliexpress_affiliate_product_query_response?.result ??
    data?.result ?? data?.data ?? data;

  if (typeof node === "string") {
    try { node = JSON.parse(node); } catch {}
  }

  // Точный путь, который показал твой ae-test: products.product[]
  let list =
    node?.products?.product ??
    node?.result_list?.products?.product ??
    node?.result_list?.products ??
    node?.result_list?.product ??
    node?.products ?? node?.items;

  if (Array.isArray(list)) return list;

  // Глубокий поиск массива, похожего на товары
  const deep = deepFindFirstArray(node);
  return Array.isArray(deep) ? deep : [];
}

function deepFindFirstArray(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === "object") {
      const p = obj[0];
      if ("product_id" in p || "item_id" in p || "product_title" in p || "title" in p) return obj;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const r = deepFindFirstArray(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function pickKeywords(interests = []) {
  const out = [];
  for (const i of interests) {
    const ks = KW[i];
    if (ks) out.push(...ks);
  }
  return out.length ? out : ["gift", "present"];
}

// Нормализация товара: цена — число USD
function toItem() {
  return (p) => {
    const title = p?.product_title || p?.title || p?.item_title;
    const image = p?.product_main_image_url || p?.image_url || p?.product_image || p?.product_small_image_urls?.[0];

    const rawPrice =
      p?.target_sale_price ?? p?.target_app_sale_price ??
      p?.app_sale_price ?? p?.sale_price ?? p?.original_price;

    const value = parseAliPrice(rawPrice); // число
    const currency = p?.target_sale_price_currency || "USD";
    const url = p?.promotion_link || p?.target_url || p?.product_detail_url || p?.detail_url;

    if (!title || !image || !url || !Number.isFinite(value)) return null;

    return {
      id: String(p?.product_id || p?.item_id || Math.random()),
      title,
      image,
      price: { value, currency, display: currency === "USD" ? `$${value}` : `${value} ${currency}` },
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

function parseAliPrice(x) {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  // Примеры: "US $58.99", "58.99", "1,234.56"
  const s = String(x).replace(/[^\d.,]/g, "").replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// Подпись TOP MD5: MD5(secret + k1v1k2v2... + secret), ключи по ASCII
function signParamsMD5(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.map(k => `${k}${params[k]}`).join("");
  const str = `${secret}${concatenated}${secret}`;
  return crypto.createHash("md5").update(str, "utf8").digest("hex").toUpperCase();
}

// 'YYYY-MM-DD HH:mm:ss' в GMT+8
function topTimestampCN(date = new Date()) {
  const offsetMin = 8 * 60;
  const local = new Date(date.getTime() + (offsetMin - date.getTimezoneOffset()) * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = local.getFullYear();
  const MM = pad(local.getMonth() + 1);
  const dd = pad(local.getDate());
  const HH = pad(local.getHours());
  const mm = pad(local.getMinutes());
  const ss = pad(local.getSeconds());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

function getRange(bucket) {
  return BUDGETS[bucket] || BUDGETS["$11-49"];
}

function widenRange({ min, max }, pct = 0.2) {
  const widen = (v, sign) => Math.max(0, Math.round((v + sign * v * pct) * 100) / 100);
  const out = { min, max };
  if (min != null) out.min = widen(min, -1);      // -20%
  if (max != null) out.max = widen(max, +1);      // +20%
  return out;
}
