// api/ae-test.js
// Временный диагностический эндпоинт: зовёт AliExpress и показывает,
// где лежит список товаров, без моков и без секретов.

import crypto from "crypto";

const GATEWAY = "https://api-sg.aliexpress.com/sync";
const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACK_ID = process.env.AE_TRACKING_ID;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    const qs = new URL(req.url, "https://x").searchParams;
    const keywords = qs.get("kw") || body.keywords || "gift present";
    const lang = qs.get("lang") || body.lang || "en";
    const page = qs.get("page") || "1";
    const priced = qs.get("priced") === "1";
    const ship = qs.get("ship") || ""; // "RU" | "BR" или пусто

    if (!APP_KEY || !APP_SECRET || !TRACK_ID) {
      return res.status(200).json({ error: "Missing AE env", info: { APP_KEY: !!APP_KEY, APP_SECRET: !!APP_SECRET, TRACK_ID: !!TRACK_ID }});
    }

    const bizParams = {
      keywords,
      target_language: lang,
      page_size: "40",
      page_no: String(page),
      sort: "VOLUME_DESC",
      tracking_id: TRACK_ID,
      ...(ship ? { ship_to_country: ship } : {}),
      ...(priced ? { min_price: "11", max_price: "99" } : {})
    };

    const data = await callTop("aliexpress.affiliate.product.query", bizParams);

    // Попробуем найти массив товаров из распространённых мест
    const products = extractProducts(data);
    const sample = Array.isArray(products) && products.length ? products[0] : null;

    // Супер-компактный ответ для диагностики
    return res.status(200).json({
      meta: { lang, page, ship: !!ship, priced, keywords },
      sizes: sizesSnapshot(data),
      foundCount: Array.isArray(products) ? products.length : 0,
      sampleKeys: sample ? Object.keys(sample).slice(0, 20) : [],
      sampleTitle: sample?.product_title || sample?.title || sample?.item_title || null
    });

  } catch (e) {
    return res.status(200).json({ error: e?.message || String(e) });
  }
}

function sizesSnapshot(obj, depth = 0) {
  // покажем, где есть массивы и их размер — чтобы глазами понять структуру
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  if (Array.isArray(obj)) return { __type: "array", len: obj.length };
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      if (Array.isArray(v)) out[k] = { __type: "array", len: v.length };
      else out[k] = sizesSnapshot(v, depth + 1);
    }
  }
  return out;
}

function extractProducts(data) {
  let node =
    data?.aliexpress_affiliate_product_query_response?.resp_result?.result ??
    data?.aliexpress_affiliate_product_query_response?.result ??
    data?.result ?? data?.data ?? data;

  if (typeof node === "string") {
    try { node = JSON.parse(node); } catch {}
  }

  let list =
    node?.result_list?.products ??
    node?.result_list?.product ??
    node?.products ?? node?.items;

  if (Array.isArray(list)) return list;
  const deep = deepFindFirstArray(node);
  return Array.isArray(deep) ? deep : [];
}

function deepFindFirstArray(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  if (Array.isArray(obj)) return obj;
  for (const k of Object.keys(obj)) {
    const r = deepFindFirstArray(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

async function callTop(method, bizParams) {
  const params = {
    method,
    app_key: APP_KEY,
    sign_method: "md5",
    format: "json",
    v: "1.0",
    timestamp: topTimestampCN(),
    ...bizParams
  };
  const clean = Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined));
  const sign = signParamsMD5(clean, APP_SECRET);
  const body = new URLSearchParams({ ...clean, sign }).toString();

  const rsp = await fetch(GATEWAY, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body });
  if (!rsp.ok) throw new Error(`HTTP ${rsp.status}: ${await rsp.text()}`);
  const data = await rsp.json();
  if (data?.error_response) {
    const er = data.error_response;
    throw new Error(er.sub_msg || er.msg || JSON.stringify(er));
  }
  return data;
}

function signParamsMD5(params, secret) {
  const sorted = Object.keys(params).sort();
  const concatenated = sorted.map(k => `${k}${params[k]}`).join("");
  return crypto.createHash("md5").update(`${secret}${concatenated}${secret}`, "utf8").digest("hex").toUpperCase();
}

function topTimestampCN(d = new Date()) {
  const offsetMin = 8 * 60;
  const local = new Date(d.getTime() + (offsetMin - d.getTimezoneOffset()) * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ""; req.on("data", c => data += c);
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
