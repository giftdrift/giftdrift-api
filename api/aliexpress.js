// api/aliexpress.js
// AliExpress Affiliate API (TOP). Подпись MD5 + fallback-запрос, если строгие фильтры дали 0 результатов.

import crypto from "crypto";

const GATEWAY = "https://api-sg.aliexpress.com/sync";
const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACK_ID = process.env.AE_TRACKING_ID;

const BUDGETS = {
  "$0-10":    { min: 0,   max: 10 },
  "$11-49":   { min: 11,  max: 49 },
  "$50-99":   { min: 50,  max: 99 },
  "$100-499": { min: 100, max: 499 },
  "$500-999": { min: 500, max: 999 },
  "$1000+":   { min: 1000, max: null }
};

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

  const keywords = pickKeywords(interests).join(" ");
  const { min, max } = BUDGETS[budget_bucket] || { min: 0, max: null };
  const lang = language?.startsWith("pt") ? "pt" : (language === "ru" ? "ru" : "en");

  // 1) Строгий запрос
  const strictParams = {
    keywords,
    target_language: lang,
    page_size: "40",
    page_no: String(page),
    ship_to_country: country,   // может "убивать" выдачу
    sort: "SALE_PRICE_ASC",
    tracking_id: TRACK_ID,
    min_price: min != null ? String(min) : undefined,
    max_price: max != null ? String(max) : undefined,
  };

  const strict = await callTop("aliexpress.affiliate.product.query", strictParams);
  if (strict.items.length > 0) return strict.items;

  // 2) Релакс-запрос: убираем цену/доставку, сортируем по объёму/популярности
  const relaxedParams = {
    keywords,
    target_language: lang,
    page_size: "40",
    page_no: String(page),
    sort: "VOLUME_DESC",       // популярность
    tracking_id: TRACK_ID
  };

  const relaxed = await callTop("aliexpress.affiliate.product.query", relaxedParams);
  // Чтобы легче дебажить, если снова пусто — поднимем «мягкую» ошибку (её поймает recommendations и покажет debug)
  if (relaxed.items.length === 0) {
    console.warn("AE zero results after relaxed query", {
      kw: keywords, lang, page, country, budget_bucket
    });
  }
  return relaxed.items;
}

// ----------- TOP caller + utils -----------

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

  const clean = Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined));
  const sign = signParamsMD5(clean, APP_SECRET);
  const body = new URLSearchParams({ ...clean, sign }).toString();

  console.log("AE request meta:", {
    method: clean.method,
    sign_method: clean.sign_method,
    timestamp: clean.timestamp,
    hasSign: !!sign,
    // короткий слепок бизнес-параметров
    page_no: clean.page_no,
    page_size: clean.page_size,
    sort: clean.sort,
    ship_to_country: !!clean.ship_to_country,
    priced: (clean.min_price || clean.max_price) ? true : false
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

  const list =
    data?.result?.result_list?.products ||
    data?.result?.result_list ||
    data?.data?.result_list ||
    data?.products ||
    [];

  const items = (Array.isArray(list) ? list : []).map(toItem()).filter(Boolean);
  return { items, rawCount: Array.isArray(list) ? list.length : 0 };
}

function pickKeywords(interests = []) {
  const out = [];
  for (const i of interests) {
    const ks = KW[i];
    if (ks) out.push(...ks);
  }
  return out.length ? out : ["gift", "present"];
}

// TOP MD5: MD5(secret + k1v1k2v2... + secret), ключи по ASCII
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

function toItem() {
  return (p) => {
    const title = p?.product_title || p?.title || p?.item_title;
    const image = p?.product_main_image_url || p?.image_url || p?.product_image || p?.product_small_image_urls?.[0];
    const price = p?.target_sale_price || p?.sale_price || p?.app_sale_price || p?.original_price;
    const currency = p?.target_sale_price_currency || p?.currency || "USD";
    const url = p?.promotion_link || p?.target_url || p?.product_detail_url || p?.detail_url;
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
