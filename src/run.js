import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const WEBAPP_URL = process.env.WEBAPP_URL;
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const SLOWMO_MS = Number(process.env.SLOWMO_MS || 0);
const ONLY_STORE = String(process.env.ONLY_STORE || '').trim();
const DEBUG_SCREENSHOTS = String(process.env.DEBUG_SCREENSHOTS || 'true').toLowerCase() !== 'false';
const DEBUG_DIR = String(process.env.DEBUG_DIR || 'debug-screenshots').trim();

if (!WEBAPP_URL) {
  console.error('Missing WEBAPP_URL in .env');
  process.exit(1);
}

const RUN_ID = `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

const addToCartTexts = [
  /add\s*to\s*cart/i,
  /buy\s*now/i,
  /أضف\s*إلى\s*السلة/i,
  /اضف\s*الى\s*السلة/i,
  /إضافة\s*للسلة/i,
  /اشتري\s*الآن/i,
  /اشتري\s*الان/i
];

const checkoutTexts = [
  /checkout/i,
  /go\s*to\s*checkout/i,
  /إتمام\s*الطلب/i,
  /اتمام\s*الطلب/i,
  /الدفع/i,
  /تابع\s*الدفع/i,
  /إكمال\s*الشراء/i,
  /اكمال\s*الشراء/i
];

const buyNowTexts = [
  /buy\s*now/i,
  /checkout\s*now/i,
  /اشتري\s*الآن/i,
  /اشتري\s*الان/i,
  /اشتر\s*الآن/i,
  /اشتر\s*الان/i,
  /شراء\s*الآن/i,
  /شراء\s*الان/i,
  /اطلب\s*الآن/i,
  /اطلب\s*الان/i
];

const outOfStockTexts = [
  /out\s*of\s*stock/i,
  /sold\s*out/i,
  /unavailable/i,
  /غير\s*متوفر/i,
  /غير\s*متاح/i,
  /نفدت\s*الكمية/i,
  /انتهت\s*الكمية/i,
  /المنتج\s*غير\s*متوفر/i,
  /كل\s*الخيارات\s*غير\s*متوفرة/i
];

const optionPlaceholderTexts = [
  /اختر/i,
  /اختار/i,
  /select/i,
  /choose/i,
  /الرجاء/i
];

const placeOrderTexts = [
  /place\s*order/i,
  /complete\s*order/i,
  /confirm\s*order/i,
  /submit\s*order/i,
  /pay\s*now/i,
  /order\s*now/i,
  /الطلب\s*الكامل/i,
  /تأكيد\s*الطلب/i,
  /تاكيد\s*الطلب/i,
  /إرسال\s*الطلب/i,
  /ارسال\s*الطلب/i,
  /إتمام\s*الطلب/i,
  /اتمام\s*الطلب/i,
  /إكمال\s*الطلب/i,
  /اكمال\s*الطلب/i,
  /أكمل\s*الطلب/i,
  /اكمل\s*الطلب/i,
  /تنفيذ\s*الطلب/i,
  /تقديم\s*الطلب/i,
  /تأكيد\s*الشراء/i,
  /تاكيد\s*الشراء/i,
  /ادفع\s*الآن/i,
  /ادفع\s*الان/i,
  /اطلب\s*الآن/i,
  /اطلب\s*الان/i
];

const codTexts = [
  /cash\s*on\s*delivery/i,
  /cod/i,
  /الدفع\s*عند\s*الاستلام/i,
  /عند\s*الاستلام/i,
  /كاش/i
];

async function main() {
  const stores = await fetchStores();
  const selectedStores = stores.filter(store => !ONLY_STORE || String(store['Store Name']).trim() === ONLY_STORE);

  if (selectedStores.length === 0) {
    console.log('No active stores found. Check the Stores sheet or ONLY_STORE value.');
    return;
  }

  console.log(`Run ${RUN_ID}: ${selectedStores.length} store(s)`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO_MS });

  for (const store of selectedStores) {
    const result = await runStore(browser, store);
    await logResult(result);
    console.log(`${result.storeName}: ${result.status} | order=${result.currentOrder || '-'} | estimated=${result.estimatedOrders ?? '-'}`);
  }

  await browser.close();
}

async function runStore(browser, store) {
  const storeName = String(store['Store Name'] || 'Unknown Store').trim();
  const previousOrder = cleanOrderNumber(store['Last Test Order']);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  let failedStep = '';

  try {
    failedStep = 'open_store';

    const storeUrl = String(store['Website URL'] || '').trim();
    const configuredProductUrl = normalizeOptionalUrl(store['Product URL']);

    if (!storeUrl && !configuredProductUrl) {
      throw new Error('Missing Website URL in Stores sheet');
    }

    await page.goto(configuredProductUrl || storeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(1500);
    await dismissPopups(page);

    failedStep = 'product_to_checkout';
    await startCheckoutFromStore(page, storeUrl, configuredProductUrl);

    await page.waitForTimeout(2500);
    await dismissPopups(page);

    if (!(await isStrictCheckoutPage(page))) {
      const debugInfo = await getConfirmationDebugInfo(page);
      throw new Error(`Did not reach real checkout after product selection. ${debugInfo}`);
    }

    failedStep = 'fill_checkout_form';
    await fillCheckoutForm(page, store);

    await page.waitForTimeout(1000);

    failedStep = 'select_payment';
    await selectPayment(page, String(store['Payment Method'] || ''));

    await page.waitForTimeout(1000);

    failedStep = 'place_order';

    const orderSubmittedAt = new Date().toISOString();

    await clickPlaceOrder(page);

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(15000);

    failedStep = 'extract_order_number';

    console.log(`${storeName}: extracting order number from confirmation page...`);

    let currentOrder = await extractOrderNumberFromPage(page);

    if (!currentOrder) {
      const debugInfo = await getConfirmationDebugInfo(page);
      throw new Error(
        `Order number not found on confirmation page. Email fallback disabled to avoid old order numbers. ${debugInfo}`
      );
    }

    console.log(`${storeName}: order number found: ${currentOrder}`);

    const currentClean = cleanOrderNumber(currentOrder);
    const previousClean = cleanOrderNumber(previousOrder);

    const currentNumeric = /^\d+$/.test(currentClean) ? Number(currentClean) : NaN;
    const previousNumeric = /^\d+$/.test(previousClean) ? Number(previousClean) : NaN;

    const difference = Number.isFinite(previousNumeric) && Number.isFinite(currentNumeric)
      ? currentNumeric - previousNumeric
      : '';

    const estimatedOrders = typeof difference === 'number' && difference > 0
      ? difference - 1
      : '';

    return {
      timestamp: new Date().toISOString(),
      runId: RUN_ID,
      storeName,
      previousOrder: previousClean || '',
      currentOrder: currentClean || currentOrder,
      difference,
      estimatedOrders,
      status: 'Success',
      failedStep: '',
      errorMessage: ''
    };

  } catch (err) {
    const screenshotPath = await saveDebugScreenshot(page, storeName, failedStep);

    return {
      timestamp: new Date().toISOString(),
      runId: RUN_ID,
      storeName,
      previousOrder: previousOrder || '',
      currentOrder: '',
      difference: '',
      estimatedOrders: '',
      status: 'Failed',
      failedStep,
      errorMessage: String(err && err.message ? err.message : err),
      screenshotPath: screenshotPath || ''
    };

  } finally {
    await context.close();
  }
}


async function saveDebugScreenshot(page, storeName, failedStep) {
  if (!DEBUG_SCREENSHOTS) return '';

  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });

    const safeStore = String(storeName || 'store')
      .replace(/[^a-z0-9_-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'store';

    const safeStep = String(failedStep || 'failed')
      .replace(/[^a-z0-9_-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'failed';

    const ts = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, '')
      .slice(0, 14);

    const screenshotPath = `${DEBUG_DIR}/${RUN_ID}_${safeStore}_${safeStep}_${ts}.png`;

    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });

    console.log(`${storeName}: debug screenshot saved: ${screenshotPath}`);

    return screenshotPath;

  } catch (err) {
    console.log(`${storeName}: could not save debug screenshot: ${err && err.message ? err.message : err}`);
    return '';
  }
}

function normalizeOptionalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/حط_|ضع_|product_url|product url|example|placeholder/i.test(raw)) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw;
}

async function openAnyProduct(page, storeUrl) {
  if (await hasClickableText(page, addToCartTexts)) return true;

  const origin = new URL(storeUrl || page.url()).origin;
  const tried = new Set([page.url().split('#')[0]]);

  let productUrl = await findProductUrlOnPage(page, origin);

  if (productUrl) {
    await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    return true;
  }

  const listingUrls = [
    `${origin}/collections/all`,
    `${origin}/shop`,
    `${origin}/products`,
    `${origin}/store`,
    `${origin}/collections`
  ];

  for (const url of listingUrls) {
    if (tried.has(url)) continue;

    tried.add(url);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await page.waitForTimeout(1200);
      await dismissPopups(page);

      if (await hasClickableText(page, addToCartTexts)) return true;

      productUrl = await findProductUrlOnPage(page, origin);

      if (productUrl) {
        await page.goto(productUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        return true;
      }

    } catch (_) {}
  }

  throw new Error('Could not auto find a product from Website URL. Add one product URL as fallback, or add custom selectors for this store.');
}

async function hasClickableText(page, patterns) {
  for (const pattern of patterns) {
    const candidates = [
      page.getByRole('button', { name: pattern }),
      page.getByRole('link', { name: pattern }),
      page.locator('button, a, [role="button"], input[type="submit"], input[type="button"]').filter({ hasText: pattern })
    ];

    for (const locator of candidates) {
      try {
        if ((await locator.count()) > 0 && await locator.first().isVisible({ timeout: 1000 }).catch(() => false)) {
          return true;
        }
      } catch (_) {}
    }
  }

  return false;
}

async function findProductUrlOnPage(page, origin) {
  const links = await page.$$eval('a[href]', anchors => anchors.map(a => ({
    href: a.href,
    text: (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim()
  })));

  const excluded = /\/(cart|checkout|account|login|register|search|contact|about|blog|pages|policy|privacy|terms)(\/|$)/i;

  const productSignals = [
    /\/products?\//i,
    /\/product\//i,
    /\/p\//i,
    /\/item\//i,
    /\/shop\/[^/?#]+/i
  ];

  const unique = [];
  const seen = new Set();

  for (const link of links) {
    try {
      const url = new URL(link.href);

      if (url.origin !== origin) continue;

      const href = `${url.origin}${url.pathname}`;

      if (seen.has(href)) continue;

      seen.add(href);

      if (excluded.test(url.pathname)) continue;

      if (productSignals.some(pattern => pattern.test(url.pathname))) {
        unique.push(href);
      }

    } catch (_) {}
  }

  unique.sort((a, b) => scoreProductUrl(b) - scoreProductUrl(a));

  return unique[0] || '';
}

function scoreProductUrl(url) {
  let score = 0;

  if (/\/products\//i.test(url)) score += 10;
  if (/\/product\//i.test(url)) score += 10;
  if (/\/shop\/[^/]+/i.test(url)) score += 4;
  if (!/\/collections\//i.test(url)) score += 2;
  if ((url.match(/\//g) || []).length <= 5) score += 1;

  return score;
}

async function startCheckoutFromStore(page, storeUrl, configuredProductUrl) {
  const origin = new URL(storeUrl || page.url()).origin;

  if (configuredProductUrl) {
    const ok = await tryProductAndStartCheckout(page, configuredProductUrl, origin);

    if (!ok) {
      throw new Error('Configured product could not be ordered. It may be out of stock or has unavailable options.');
    }

    return true;
  }

  const candidates = await collectProductCandidates(page, storeUrl);

  if (!candidates.length) {
    const one = await findProductUrlOnPage(page, origin);

    if (one) {
      candidates.push(one);
    }
  }

  const tried = new Set();
  const failures = [];

  for (const productUrl of candidates) {
    if (!productUrl || tried.has(productUrl)) continue;

    tried.add(productUrl);

    const ok = await tryProductAndStartCheckout(page, productUrl, origin).catch(err => {
      failures.push(`${productUrl}: ${err.message || err}`);
      return false;
    });

    if (ok) return true;
  }

  throw new Error(`No orderable product found. Tried ${tried.size} product(s). ${failures.slice(0, 3).join(' | ')}`);
}

async function tryProductAndStartCheckout(page, productUrl, origin) {
  await page.goto(productUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(2500);
  await dismissPopups(page);

  await selectProductOptions(page);

  await page.waitForTimeout(1500);
  await dismissPopups(page);

  if (await isProductUnavailable(page)) {
    return false;
  }

  // 1) Try Buy Now first
  if (await clickByTexts(page, buyNowTexts, 'Buy now', { optional: true })) {
    await waitAfterProductAction(page);

    if (await isStrictCheckoutPage(page)) {
      return true;
    }

    if (await moveFromCartOrDrawerToCheckout(page, origin)) {
      return true;
    }

    // If still on product page, do not pretend success.
    if (isProductPageUrl(page.url())) {
      console.log('Buy now clicked but still on product page. Trying add to cart path...');
    }
  }

  await dismissPopups(page);

  // 2) Try Add to Cart
  const added = await clickByTexts(page, addToCartTexts, 'Add to cart', { optional: true });

  if (!added) {
    return false;
  }

  await waitAfterProductAction(page);

  if (await isStrictCheckoutPage(page)) {
    return true;
  }

  if (await moveFromCartOrDrawerToCheckout(page, origin)) {
    return true;
  }

  // 3) Direct cart fallback after add-to-cart
  if (await openCartThenCheckout(page, origin)) {
    return true;
  }

  // Important: if GitHub is still on /products/, this product failed.
  if (isProductPageUrl(page.url())) {
    console.log('Add to cart did not move to cart/checkout. Product failed:', productUrl);
    return false;
  }

  return await isStrictCheckoutPage(page);
}

async function waitAfterProductAction(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await dismissPopups(page);
}

function isProductPageUrl(url) {
  return /\/products?\//i.test(String(url || ''));
}

function isCollectionPageUrl(url) {
  return /\/collections?\//i.test(String(url || ''));
}

async function isStrictCheckoutPage(page) {
  const url = page.url();

  // Product/listing pages must never be treated as checkout.
  if (isProductPageUrl(url)) return false;
  if (isCollectionPageUrl(url)) return false;

  // Strong checkout URL signals.
  if (/\/checkouts?(\/|$|\?)/i.test(url)) return true;
  if (/\/checkout(\/|$|\?)/i.test(url)) return true;
  if (/checkout\.shopify\.com/i.test(url)) return true;

  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const compact = String(text || '').replace(/\s+/g, ' ').trim();

  const hasCheckoutTitle = /(الدفع|checkout|shipping|payment|billing|إتمام\s*الطلب|اتمام\s*الطلب)/i.test(compact);
  const hasContactField = /(البريد\s*الإلكتروني|البريد الإلكتروني|البريد|email|e-mail|رقم\s*الهاتف|هاتف|phone|mobile)/i.test(compact);
  const hasAddressField = /(العنوان|address|city|مدينة|محافظة|state|province|country|البلد|المنطقة)/i.test(compact);
  const hasSubmitLike = /(الطلب\s*الكامل|تأكيد\s*الطلب|تاكيد\s*الطلب|إتمام\s*الطلب|اتمام\s*الطلب|complete\s*order|place\s*order|pay\s*now)/i.test(compact);

  return hasCheckoutTitle && hasContactField && hasAddressField && hasSubmitLike;
}

async function moveFromCartOrDrawerToCheckout(page, origin) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await isStrictCheckoutPage(page)) {
      return true;
    }

    await dismissPopups(page);

    const clickedCheckout = await clickByTexts(page, checkoutTexts, 'Checkout', { optional: true });

    if (clickedCheckout) {
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);

      if (await isStrictCheckoutPage(page)) {
        return true;
      }
    }

    await page.waitForTimeout(1500);
  }

  return false;
}

async function openCartThenCheckout(page, origin) {
  try {
    await page.goto(`${origin}/cart`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await dismissPopups(page);

    const cartText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

    if (/cart\s*is\s*empty|empty\s*cart|سلة\s*التسوق\s*فارغة|السلة\s*فارغة|لا\s*توجد\s*منتجات/i.test(cartText)) {
      return false;
    }

    if (await isStrictCheckoutPage(page)) {
      return true;
    }

    if (await clickByTexts(page, checkoutTexts, 'Checkout from cart', { optional: true })) {
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);

      if (await isStrictCheckoutPage(page)) {
        return true;
      }
    }

    // Direct checkout fallback only after we opened cart.
    await page.goto(`${origin}/checkout`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }).catch(() => {});

    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);

    return await isStrictCheckoutPage(page);

  } catch (_) {
    return false;
  }
}

async function collectProductCandidates(page, storeUrl) {
  const origin = new URL(storeUrl || page.url()).origin;

  const listingUrls = [
    storeUrl,
    `${origin}/products`,
    `${origin}/collections/all`,
    `${origin}/collections`,
    `${origin}/shop`,
    `${origin}/store`,
    `${origin}/ar`,
    `${origin}/en`
  ];

  const all = [];
  const seenPages = new Set();

  for (const url of listingUrls) {
    if (!url || seenPages.has(url)) continue;

    seenPages.add(url);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 35000
      });

      await page.waitForTimeout(1500);
      await dismissPopups(page);

      const candidates = await extractCandidateLinks(page, origin);
      all.push(...candidates);

    } catch (_) {}

    if (uniqueByUrl(all).length >= 12) break;
  }

  return uniqueByUrl(all)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(x => x.url);
}

async function extractCandidateLinks(page, origin) {
  const rawLinks = await page.$$eval('a[href]', anchors => anchors.map(a => {
    const parent = a.closest('article, li, .product, .product-card, .s-product-card-entry, .salla-product-card, .card, .item') || a.parentElement;

    return {
      href: a.href,
      text: (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim(),
      parentText: parent ? (parent.innerText || '').slice(0, 500) : '',
      hasImage: !!a.querySelector('img'),
      classes: a.className || ''
    };
  }));

  const excluded = /\/(cart|checkout|account|login|register|search|contact|about|blog|pages|policy|privacy|terms|wishlist|compare)(\/|$)/i;
  const social = /(facebook|instagram|twitter|x\.com|tiktok|snapchat|youtube|wa\.me|whatsapp)/i;
  const candidates = [];

  for (const link of rawLinks) {
    try {
      const url = new URL(link.href);

      if (url.origin !== origin) continue;
      if (excluded.test(url.pathname) || social.test(url.hostname + url.pathname)) continue;

      const clean = `${url.origin}${url.pathname}`;
      let score = 0;
      const combined = `${link.text} ${link.parentText} ${link.classes}`;

      if (/\/products?\//i.test(url.pathname)) score += 25;
      if (/\/product\//i.test(url.pathname)) score += 25;
      if (/\/p\//i.test(url.pathname)) score += 18;
      if (/\/item\//i.test(url.pathname)) score += 18;
      if (/\bp\d+\b/i.test(url.pathname)) score += 10;
      if (/(ر\.س|SAR|ريال|EGP|جنيه|د\.ك|KD|AED|درهم|price|السعر)/i.test(combined)) score += 10;
      if (/(أضف|اضف|شراء|اشتري|منتج|product|add to cart|buy)/i.test(combined)) score += 6;
      if (link.hasImage) score += 4;
      if (!/\/(collections?|categories?|category|brand|brands)(\/|$)/i.test(url.pathname)) score += 3;
      if ((url.pathname.match(/\//g) || []).length >= 1) score += 1;

      if (score >= 9) {
        candidates.push({ url: clean, score });
      }

    } catch (_) {}
  }

  return candidates;
}

function uniqueByUrl(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;

    seen.add(item.url);
    out.push(item);
  }

  return out;
}

async function selectProductOptions(page) {
  const selects = page.locator('select:visible');
  const selectCount = await selects.count().catch(() => 0);

  for (let i = 0; i < selectCount; i++) {
    const select = selects.nth(i);

    try {
      const options = await select.locator('option').evaluateAll((opts, placeholders) => opts.map(o => ({
        value: o.value,
        text: o.textContent || '',
        disabled: o.disabled
      })).filter(o => o.value && !o.disabled && !placeholders.some(p => new RegExp(p.source, p.flags).test(o.text))), optionPlaceholderTexts.map(p => ({ source: p.source, flags: p.flags })));

      if (options.length) {
        await select.selectOption(options[0].value, { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
      }

    } catch (_) {}
  }

  const optionSelectors = [
    '.s-product-options-wrapper button:not([disabled])',
    '.s-product-options-wrapper label',
    '.s-product-options button:not([disabled])',
    '.product-options button:not([disabled])',
    '.variant-options button:not([disabled])',
    '[data-option] button:not([disabled])',
    '[data-variant] button:not([disabled])',
    'label:has(input[type="radio"]:not(:disabled))'
  ];

  for (const selector of optionSelectors) {
    const options = page.locator(selector);
    const count = await options.count().catch(() => 0);
    const maxClicks = Math.min(count, 4);

    for (let i = 0; i < maxClicks; i++) {
      const opt = options.nth(i);

      try {
        if (!(await opt.isVisible({ timeout: 500 }).catch(() => false))) continue;

        const text = await opt.innerText({ timeout: 500 }).catch(() => '');

        if (isActionText(text) || outOfStockTexts.some(p => p.test(text))) continue;

        const ariaDisabled = await opt.getAttribute('aria-disabled').catch(() => '');
        const cls = await opt.getAttribute('class').catch(() => '');

        if (/disabled|unavailable|sold|out/i.test(`${ariaDisabled} ${cls}`)) continue;

        await opt.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
        await opt.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(500);

        break;

      } catch (_) {}
    }
  }
}

function isActionText(text) {
  const value = String(text || '').trim();

  if (!value) return false;

  const actions = [
    ...addToCartTexts,
    ...buyNowTexts,
    ...checkoutTexts,
    ...placeOrderTexts,
    /الرئيسية/i,
    /القائمة/i,
    /بحث/i,
    /search/i
  ];

  return actions.some(p => p.test(value));
}

async function isProductUnavailable(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const hasOutText = outOfStockTexts.some(p => p.test(text));
  const hasBuyOrCart = await hasClickableText(page, [...buyNowTexts, ...addToCartTexts]);

  if (hasOutText && !hasBuyOrCart) return true;

  const buttons = page.locator('button, a[role="button"], input[type="button"], input[type="submit"]');
  const count = await buttons.count().catch(() => 0);

  let actionButtons = 0;
  let enabledActions = 0;

  for (let i = 0; i < Math.min(count, 80); i++) {
    const el = buttons.nth(i);

    try {
      const label = await el.evaluate(node => [
        node.innerText,
        node.textContent,
        node.value,
        node.getAttribute('aria-label'),
        node.getAttribute('title')
      ].filter(Boolean).join(' '));

      if (![...buyNowTexts, ...addToCartTexts].some(p => p.test(label))) continue;

      actionButtons += 1;

      const disabled = await el.evaluate(node => !!node.disabled || node.getAttribute('aria-disabled') === 'true' || /disabled|unavailable|sold/i.test(node.className || ''));

      if (!disabled && await el.isVisible({ timeout: 300 }).catch(() => false)) {
        enabledActions += 1;
      }

    } catch (_) {}
  }

  return actionButtons > 0 && enabledActions === 0;
}

function isCheckoutUrl(url) {
  return /checkout|complete-order|order|payment/i.test(String(url || ''));
}

async function looksLikeCheckoutPage(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

  return /(إتمام\s*الطلب|اتمام\s*الطلب|بيانات\s*الشحن|معلومات\s*الشحن|الدفع|checkout|shipping|payment|billing)/i.test(text);
}

async function fetchStores() {
  const url = `${WEBAPP_URL}?action=stores`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch stores: ${res.status}`);
  }

  const data = await res.json();

  if (!data.ok) {
    throw new Error(data.error || 'Apps Script returned error');
  }

  return data.stores || [];
}

async function logResult(result) {
  const res = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'log_result',
      result
    })
  });

  if (!res.ok) {
    throw new Error(`Failed to log result: ${res.status}`);
  }

  const data = await res.json();

  if (!data.ok) {
    throw new Error(data.error || 'Apps Script log error');
  }
}

async function waitForOrderNumberFromEmail(store, sinceIso, timeoutMs = 90000) {
  const email = String(store['Test Email'] || '').trim();
  const storeName = String(store['Store Name'] || '').trim();

  if (!email || !/@/.test(email)) return '';

  const started = Date.now();
  let lastError = '';

  while (Date.now() - started < timeoutMs) {
    try {
      const params = new URLSearchParams({
        action: 'find_order_email',
        email,
        storeName,
        since: sinceIso
      });

      const res = await fetch(`${WEBAPP_URL}?${params.toString()}`);
      const text = await res.text();

      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;

      } else {
        const data = JSON.parse(text);

        if (data.ok && data.orderNumber) {
          const value = cleanOrderNumber(data.orderNumber);

          if (isLikelyOrderNumber(value)) {
            return value;
          }
        }

        lastError = data.error || 'Email order number not found yet';
      }

    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  console.log(`Email order lookup timed out for ${storeName || email}: ${lastError}`);

  return '';
}

async function clickByTexts(page, patterns, label, options = {}) {
  for (const pattern of patterns) {
    const locators = [
      page.getByRole('button', { name: pattern }),
      page.getByRole('link', { name: pattern }),
      page.locator('input[type="submit"], input[type="button"]').filter({ hasText: pattern }),
      page.locator('button, a, [role="button"]').filter({ hasText: pattern })
    ];

    for (const locator of locators) {
      try {
        const count = await locator.count();

        if (count > 0) {
          await locator.first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await locator.first().click({ timeout: 8000 });
          return true;
        }

      } catch (_) {}
    }
  }

  if (options.optional) return false;

  throw new Error(`${label} button not found`);
}


async function waitForCheckoutFields(page) {
  // Shopify checkout can load slowly on GitHub/Xvfb.
  // Wait until real checkout inputs are visible before filling.
  for (let i = 0; i < 20; i++) {
    const fieldsCount = await page.locator('input:visible, textarea:visible, select:visible').count().catch(() => 0);
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');

    const hasContact = /(البريد|email|e-mail|الهاتف|phone|mobile)/i.test(bodyText);
    const hasAddress = /(العنوان|address|مدينة|city|محافظة|province|state)/i.test(bodyText);

    if (fieldsCount >= 5 && hasContact && hasAddress) {
      await page.waitForTimeout(3000);
      return true;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('Checkout fields did not become ready');
}

async function verifyCheckoutFormFilled(page, store) {
  const email = String(store['Test Email'] || '').trim();
  const phone = normalizeCheckoutPhone(String(store['Test Phone'] || '01000000000'));
  const address = String(store['Test Address1'] || 'TEST ADDRESS DO NOT SHIP').trim();
  const city = String(store['Test City'] || 'Cairo').trim();

  // Fill again with robust hint-based method in case normal selectors missed Shopify fields.
  await fillCheckoutFieldByHints(page, [/email/i, /البريد/i, /الايميل/i, /إيميل/i], email);
  await fillCheckoutFieldByHints(page, [/phone/i, /mobile/i, /tel/i, /هاتف/i, /الهاتف/i, /المحمول/i], phone);
  await fillCheckoutFieldByHints(page, [/address/i, /street/i, /العنوان/i], address);
  await fillCheckoutFieldByHints(page, [/city/i, /المدينة/i, /مدينة/i], city);

  // Choose Egypt state/province explicitly. Shopify sometimes leaves it on placeholder in GitHub.
  await chooseCheckoutSelectOption(page, [/province/i, /state/i, /محافظة/i, /state\s*\/\s*province/i], [/القاهرة/i, /cairo/i, /محافظة القاهرة/i]);

  await page.waitForTimeout(2000);

  const validationText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

  if (/Select a state \/ province/i.test(validationText)) {
    throw new Error('Checkout province/state is still not selected');
  }

  return true;
}

function normalizeCheckoutPhone(value) {
  let phone = String(value || '').replace(/\D/g, '');

  if (!phone) return '01000000000';

  if (phone.startsWith('20') && phone.length === 12) {
    phone = '0' + phone.slice(2);
  }

  if (phone.length === 10 && phone.startsWith('1')) {
    phone = '0' + phone;
  }

  if (phone.length < 11) {
    phone = '01000000000';
  }

  return phone;
}

async function fillCheckoutFieldByHints(page, hints, value) {
  const fields = page.locator('input, textarea');
  const count = await fields.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 100); i++) {
    const el = fields.nth(i);

    try {
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;

      const type = await el.getAttribute('type').catch(() => '');
      if (/hidden|checkbox|radio|submit|button/i.test(String(type))) continue;

      const info = await el.evaluate(node => {
        const id = node.getAttribute('id') || '';
        const name = node.getAttribute('name') || '';
        const placeholder = node.getAttribute('placeholder') || '';
        const aria = node.getAttribute('aria-label') || '';
        const autocomplete = node.getAttribute('autocomplete') || '';
        const type = node.getAttribute('type') || '';
        let label = '';

        if (id) {
          const labelEl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (labelEl) label = labelEl.innerText || labelEl.textContent || '';
        }

        const parentText = node.closest('label, div, section')?.innerText || '';

        return [id, name, placeholder, aria, autocomplete, type, label, parentText]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      });

      if (!hints.some(pattern => pattern.test(info))) continue;

      await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await el.click({ timeout: 2000 }).catch(() => {});
      await el.fill(String(value), { timeout: 5000 }).catch(async () => {
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type(String(value), { delay: 25 }).catch(() => {});
      });

      await page.waitForTimeout(500);
      return true;

    } catch (_) {}
  }

  return false;
}

async function chooseCheckoutSelectOption(page, selectHints, preferredOptions) {
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 30); i++) {
    const select = selects.nth(i);

    try {
      if (!(await select.isVisible({ timeout: 500 }).catch(() => false))) continue;

      const meta = await select.evaluate(node => {
        const id = node.getAttribute('id') || '';
        const name = node.getAttribute('name') || '';
        const aria = node.getAttribute('aria-label') || '';
        let label = '';

        if (id) {
          const labelEl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (labelEl) label = labelEl.innerText || labelEl.textContent || '';
        }

        const options = Array.from(node.options || []).map(o => o.textContent || '').join(' ');

        return [id, name, aria, label, options]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      });

      if (!selectHints.some(pattern => pattern.test(meta))) continue;

      const options = await select.locator('option').evaluateAll(opts => opts.map(o => ({
        value: o.value,
        text: o.textContent || '',
        disabled: o.disabled
      })));

      const validOptions = options.filter(o =>
        o.value &&
        !o.disabled &&
        !/select|choose|اختر|اختار|province|state|الرجاء/i.test(o.text)
      );

      if (!validOptions.length) continue;

      let chosen = validOptions.find(o =>
        preferredOptions.some(pattern => pattern.test(o.text) || pattern.test(o.value))
      );

      if (!chosen) chosen = validOptions[0];

      await select.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await select.selectOption(chosen.value, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);

      return true;

    } catch (_) {}
  }

  return false;
}

async function fillCheckoutForm(page, store) {
  const fullName = String(store['Test Name'] || 'TEST ORDER DO NOT SHIP');
  const email = String(store['Test Email'] || 'test@example.com');
  const phone = String(store['Test Phone'] || '01000000000');
  const address = String(store['Test Address1'] || 'TEST ADDRESS DO NOT SHIP');
  const city = String(store['Test City'] || 'Cairo');
  const notes = String(store['Test Notes'] || 'TEST ORDER - DO NOT SHIP');

  const [firstName, ...lastParts] = fullName.split(' ');
  const lastName = lastParts.join(' ') || 'TEST';

  await fillFirst(page, ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]'], email);
  await fillFirst(page, ['input[name*="first" i]', 'input[id*="first" i]'], firstName);
  await fillFirst(page, ['input[name*="last" i]', 'input[id*="last" i]'], lastName);
  await fillFirst(page, ['input[name*="name" i]', 'input[id*="name" i]'], fullName);
  await fillFirst(page, ['input[type="tel"]', 'input[name*="phone" i]', 'input[id*="phone" i]', 'input[name*="mobile" i]'], phone);
  await fillFirst(page, ['input[name*="address" i]', 'input[id*="address" i]', 'input[name*="street" i]'], address);
  await fillFirst(page, ['input[name*="city" i]', 'input[id*="city" i]'], city);
  await fillFirst(page, ['textarea[name*="note" i]', 'textarea[id*="note" i]', 'textarea[name*="comment" i]', 'textarea'], notes);
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();

      if (await locator.count()) {
        const isVisible = await locator.isVisible().catch(() => false);

        if (isVisible) {
          await locator.fill(String(value), { timeout: 5000 });
          return true;
        }
      }

    } catch (_) {}
  }

  return false;
}

async function selectPayment(page, paymentMethod) {
  const customPatterns = paymentMethod ? [new RegExp(escapeRegExp(paymentMethod), 'i')] : [];
  const patterns = [...customPatterns, ...codTexts];

  const clicked = await clickByTexts(page, patterns, 'Payment method', { optional: true });

  return clicked;
}

async function clickPlaceOrder(page) {
  if (await clickByTexts(page, placeOrderTexts, 'Place order', { optional: true })) return true;

  const inputCandidates = page.locator('input[type="submit"], input[type="button"], button[type="submit"], button');
  const count = await inputCandidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = inputCandidates.nth(i);

    try {
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;

      const label = await el.evaluate(node => [
        node.innerText,
        node.textContent,
        node.value,
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
        node.getAttribute('name'),
        node.getAttribute('id')
      ].filter(Boolean).join(' '));

      if (placeOrderTexts.some(pattern => pattern.test(label))) {
        await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await el.click({ timeout: 8000 });
        return true;
      }

    } catch (_) {}
  }

  const knownSelectors = [
    'button#place_order',
    'input#place_order',
    'button[name="woocommerce_checkout_place_order"]',
    'input[name="woocommerce_checkout_place_order"]',
    '.woocommerce-checkout-payment button[type="submit"]',
    'form.checkout button[type="submit"]',
    'form.checkout input[type="submit"]',
    'form[action*="checkout"] button[type="submit"]',
    'form[action*="checkout"] input[type="submit"]'
  ];

  for (const selector of knownSelectors) {
    try {
      const locator = page.locator(selector).first();

      if ((await locator.count()) && await locator.isVisible({ timeout: 800 }).catch(() => false)) {
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await locator.click({ timeout: 8000 });
        return true;
      }

    } catch (_) {}
  }

  const genericSubmits = page.locator('main button[type="submit"], main input[type="submit"], form button[type="submit"], form input[type="submit"]');
  const genericCount = await genericSubmits.count().catch(() => 0);

  for (let i = genericCount - 1; i >= 0; i--) {
    const el = genericSubmits.nth(i);

    try {
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await el.click({ timeout: 8000 });
        return true;
      }

    } catch (_) {}
  }

  throw new Error('Place order button not found');
}

async function dismissPopups(page) {
  const patterns = [
    /accept/i,
    /agree/i,
    /close/i,
    /قبول/i,
    /موافق/i,
    /اغلاق/i,
    /إغلاق/i,
    /x/i
  ];

  for (const pattern of patterns) {
    try {
      const locator = page.locator('button, a, [role="button"]').filter({ hasText: pattern });

      if (await locator.count()) {
        await locator.first().click({ timeout: 1500 }).catch(() => {});
      }

    } catch (_) {}
  }
}

async function extractOrderNumberFromPage(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000).catch(() => {});

  const sources = [];

  const highPrioritySelectors = [
    'h1',
    'h2',
    '[role="heading"]',
    '[class*="order" i]',
    '[id*="order" i]',
    '[class*="confirmation" i]',
    '[id*="confirmation" i]',
    '[class*="thank" i]',
    '[id*="thank" i]',
    'strong',
    'b'
  ];

  for (const selector of highPrioritySelectors) {
    try {
      const items = page.locator(selector);
      const count = await items.count();

      for (let i = 0; i < Math.min(count, 40); i++) {
        const text = await items.nth(i).innerText({ timeout: 700 }).catch(() => '');

        if (text) {
          sources.push(text);
        }
      }

    } catch (_) {}
  }

  const bodyText = await page.locator('body').innerText({ timeout: 20000 }).catch(() => '');

  if (bodyText) {
    sources.push(bodyText);
  }

  const title = await page.title().catch(() => '');

  if (title) {
    sources.push(title);
  }

  for (const source of sources) {
    const found = extractOrderNumber(source);

    if (found) {
      return found;
    }
  }

  return '';
}

async function getConfirmationDebugInfo(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const compactText = String(text).replace(/\s+/g, ' ').trim().slice(0, 700);

  return `url=${url} | title=${title} | text=${compactText}`;
}

function extractOrderNumber(text) {
  const cleanText = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanText) return '';

  const patterns = [
    /(?:الطلب|طلب)\s*#\s*([A-Z0-9][A-Z0-9_\-]{1,30})/i,
    /(?:رقم\s*(?:الطلب|الأوردر|اوردر)\s*)[:：#\-]?\s*#?\s*([A-Z0-9][A-Z0-9_\-]{1,30})/i,
    /(?:طلبك\s*(?:رقم)?|طلب\s*رقم)\s*[:：#\-]?\s*#?\s*([A-Z0-9][A-Z0-9_\-]{1,30})/i,
    /\bORDER\s*#\s*([A-Z0-9][A-Z0-9_\-]{1,30})\b/i,
    /\bOrder\s*#\s*([A-Z0-9][A-Z0-9_\-]{1,30})\b/i,
    /\b(?:order\s*(?:number|no\.?|id)|confirmation\s*(?:number|no\.?|id))\s*[:：#\-]?\s*#?\s*([A-Z0-9][A-Z0-9_\-]{1,30})\b/i,
    /(?:order_id|orderId|order_number|orderNumber|confirmation_number|confirmationNumber)\s*[=:"'\s]+([A-Z0-9][A-Z0-9_\-]{1,30})/i,
    /#\s*([A-Z0-9][A-Z0-9_\-]{1,30})\b/i
  ];

  for (const pattern of patterns) {
    const match = cleanText.match(pattern);

    if (match && match[1]) {
      const value = cleanOrderNumber(match[1]);

      if (isLikelyOrderNumber(value)) {
        return value;
      }
    }
  }

  return '';
}

function isLikelyOrderNumber(value) {
  const v = cleanOrderNumber(value);

  if (!v) return false;
  if (v.length < 2 || v.length > 30) return false;

  const badWords = [
    'CONFIRMED',
    'CONFIRM',
    'CONFIRMATION',
    'ORDER',
    'ORDERS',
    'THANK',
    'THANKYOU',
    'HIMAS',
    'FARM',
    'STORE',
    'EMAIL',
    'SHIPPED',
    'DELIVERED',
    'PROFILE',
    'PAYMENT',
    'SHIPPING'
  ];

  if (badWords.includes(v)) return false;

  const badValues = [
    'FFFFFF',
    'F1F1F1',
    '000000'
  ];

  if (badValues.includes(v)) return false;

  const digitCount = (v.match(/\d/g) || []).length;

  if (digitCount < 2) return false;

  if (/^0?1\d{9}$/.test(v) || /^05\d{8}$/.test(v)) return false;

  if (/^\d{9,}$/.test(v)) return false;

  if (/^(16|17|18|19|20)\d{8,}$/.test(v)) return false;

  return /^[A-Z0-9][A-Z0-9_\-]{1,30}$/i.test(v);
}

function cleanOrderNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/^#+/, '')
    .replace(/[.,،:;]+$/g, '')
    .replace(/[^A-Z0-9_\-]/g, '')
    .trim();
}

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


