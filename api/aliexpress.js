export async function queryAliExpress({ country, language, budget_bucket, interests, page = 1 }) {
  if (!APP_KEY || !APP_SECRET || !TRACK_ID) {
    throw new Error("AliExpress credentials are not set");
  }

  const kwList = pickKeywords(interests);
  const kwJoined = kwList.join(" ");
  const { min, max } = BUDGETS[budget_bucket] || { min: 0, max: null };
  const langPTorRU = language?.startsWith("pt") ? "pt" : (language === "ru" ? "ru" : "en");

  // Попытка 1 — «строгая»: язык из квиза, с ценой и доставкой
  const try1 = await callTop("aliexpress.affiliate.product.query", {
    keywords: kwJoined || "gift present",
    target_language: langPTorRU,
    page_size: "40",
    page_no: String(page),
    ship_to_country: country,
    sort: "SALE_PRICE_ASC",
    tracking_id: TRACK_ID,
    min_price: min != null ? String(min) : undefined,
    max_price: max != null ? String(max) : undefined
  });
  if (try1.items.length) return try1.items;

  // Попытка 2 — «релакс А»: без цены и доставки, сортируем по популярности
  const try2 = await callTop("aliexpress.affiliate.product.query", {
    keywords: kwJoined || "gift present",
    target_language: langPTorRU,
    page_size: "100",
    page_no: String(page),
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID
  });
  if (try2.items.length) return try2.items;

  // Попытка 3 — «релакс B»: принудительно язык EN (часто даёт больше)
  const try3 = await callTop("aliexpress.affiliate.product.query", {
    keywords: kwJoined || "gift present",
    target_language: "en",
    page_size: "100",
    page_no: String(page),
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID
  });
  if (try3.items.length) return try3.items;

  // Попытка 4 — «расширить ключевики»: универсальные подарочные запросы
  const fallbackKeywords = ["gift", "present", "gadget", "accessories", "home decor"].join(" ");
  const try4 = await callTop("aliexpress.affiliate.product.query", {
    keywords: fallbackKeywords,
    target_language: "en",
    page_size: "100",
    page_no: String(page),
    sort: "VOLUME_DESC",
    tracking_id: TRACK_ID
  });
  return try4.items; // может быть пусто — тогда фронт покажет пустую выдачу
}
