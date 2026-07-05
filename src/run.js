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

const addToCartTexts = [/add\s*to\s*cart/i, /أضف\s*إلى\s*السلة/i, /اضف\s*الى\s*السلة/i, /إضافة\s*للسلة/i];
const buyNowTexts = [/buy\s*now/i, /checkout\s*now/i, /اشتري\s*الآن/i, /اشتري\s*الان/i, /اشتر\s*الآن/i, /اشتر\s*الان/i, /شراء\s*الآن/i, /شراء\s*الان/i, /اطلب\s*الآن/i, /اطلب\s*الان/i];
const checkoutTexts = [/checkout/i, /go\s*to\s*checkout/i, /إتمام\s*الطلب/i, /اتمام\s*الطلب/i, /الدفع/i, /تابع\s*الدفع/i, /إكمال\s*الشراء/i, /اكمال\s*الشراء/i];
const placeOrderTexts = [/place\s*order/i, /complete\s*order/i, /confirm\s*order/i, /submit\s*order/i, /order\s*now/i, /الطلب\s*الكامل/i, /تأكيد\s*الطلب/i, /تاكيد\s*الطلب/i, /إرسال\s*الطلب/i, /ارسال\s*الطلب/i, /إتمام\s*الطلب/i, /اتمام\s*الطلب/i, /إكمال\s*الطلب/i, /اكمال\s*الطلب/i, /تنفيذ\s*الطلب/i, /تقديم\s*الطلب/i, /اطلب\s*الآن/i, /اطلب\s*الان/i];
const codTexts = [/cash\s*on\s*delivery/i, /\bCOD\b/i, /الدفع\s*عند\s*الاستلام/i, /عند\s*الاستلام/i, /كاش/i];
const unsafePaymentTexts = [/card\s*number/i, /credit\s*card/i, /visa/i, /mastercard/i, /pay\s*now/i, /ادفع\s*الآن/i, /ادفع\s*الان/i, /رقم\s*البطاقة/i, /بطاقة\s*ائتمان/i];
const outOfStockTexts = [/out\s*of\s*stock/i, /sold\s*out/i, /unavailable/i, /variant\s*sold\s*out/i, /غير\s*متوفر/i, /غير\s*متاح/i, /نفدت\s*الكمية/i, /انتهت\s*الكمية/i];
const optionPlaceholderTexts = [/اختر/i, /اختار/i, /select/i, /choose/i, /الرجاء/i];

async function main() {
  const stores = await fetchStores();
  const selectedStores = stores.filter(store => /^true$/i.test(String(store.Active || '').trim()) && (!ONLY_STORE || String(store['Store Name']).trim() === ONLY_STORE));
  if (!selectedStores.length) {
    console.log('No active stores found. Check the Stores sheet or ONLY_STORE value.');
    return;
  }
  console.log(`Run ${RUN_ID}: ${selectedStores.length} active store(s)`);
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO_MS });
  try {
    for (const store of selectedStores) {
      const result = await runStore(browser, store);
      await logResult(result);
      console.log(`${result.storeName}: ${result.status} | order=${result.currentOrder || '-'} | estimated=${result.estimatedOrders ?? '-'}`);
    }
  } finally {
    await browser.close();
  }
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
    if (!storeUrl && !configuredProductUrl) throw new Error('Missing Website URL in Stores sheet');
    await page.goto(configuredProductUrl || storeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitAndDismiss(page, 1500);

    failedStep = 'product_to_checkout';
    await startCheckoutFromStore(page, storeUrl, configuredProductUrl);
    await saveDebugCheckpoint(page, storeName, '01_after_product_to_checkout');
    if (!(await isStrictCheckoutPage(page))) throw new Error(`Did not reach real checkout after product selection. ${await getPageDebugInfo(page)}`);

    failedStep = 'fill_checkout_form';
    await saveDebugCheckpoint(page, storeName, '02_before_fill_checkout');
    await fillCheckoutForm(page, store);
    await selectShippingProvince(page, store);
    await waitAndDismiss(page, 2000);
    await saveDebugCheckpoint(page, storeName, '03_after_fill_checkout');

    failedStep = 'select_payment';
    await saveDebugCheckpoint(page, storeName, '04_before_select_payment');
    await selectPayment(page, String(store['Payment Method'] || ''));
    await waitAndDismiss(page, 2000);
    await assertSafeCodSelected(page);
    await saveDebugCheckpoint(page, storeName, '05_after_select_payment');

    failedStep = 'place_order';
    const orderSubmittedAt = new Date().toISOString();
    await saveDebugCheckpoint(page, storeName, '06_before_place_order');
    await clickPlaceOrder(page);
    await waitForCheckoutProgress(page);
    await saveDebugCheckpoint(page, storeName, '07_after_place_order_click');

    failedStep = 'extract_order_email';
    console.log(`${storeName}: waiting for order number from confirmation email only...`);
    const currentOrder = await waitForOrderNumberFromEmail(store, orderSubmittedAt, 120000);
    if (!currentOrder) throw new Error(`Could not find order number in confirmation email. Email is the only source of truth. ${await getPageDebugInfo(page)}`);
    console.log(`${storeName}: email order number found: ${currentOrder}`);

    const currentClean = cleanOrderNumber(currentOrder);
    const previousClean = cleanOrderNumber(previousOrder);
    const currentNumeric = /^\d+$/.test(currentClean) ? Number(currentClean) : NaN;
    const previousNumeric = /^\d+$/.test(previousClean) ? Number(previousClean) : NaN;
    const difference = Number.isFinite(previousNumeric) && Number.isFinite(currentNumeric) ? currentNumeric - previousNumeric : '';
    const estimatedOrders = typeof difference === 'number' && difference > 0 ? difference - 1 : '';
    return { timestamp: new Date().toISOString(), runId: RUN_ID, storeName, previousOrder: previousClean || '', currentOrder: currentClean || currentOrder, difference, estimatedOrders, status: 'Success', failedStep: '', errorMessage: '' };
  } catch (err) {
    const screenshotPath = await saveDebugScreenshot(page, storeName, failedStep);
    return { timestamp: new Date().toISOString(), runId: RUN_ID, storeName, previousOrder: previousOrder || '', currentOrder: '', difference: '', estimatedOrders: '', status: 'Failed', failedStep, errorMessage: String(err && err.message ? err.message : err), screenshotPath: screenshotPath || '' };
  } finally {
    await context.close();
  }
}

async function startCheckoutFromStore(page, storeUrl, configuredProductUrl) {
  const origin = new URL(storeUrl || page.url()).origin;
  if (configuredProductUrl) {
    const ok = await tryProductAndStartCheckout(page, configuredProductUrl, origin);
    if (!ok) throw new Error('Configured product could not be ordered. It may be out of stock or has unavailable options.');
    return true;
  }
  const candidates = await collectProductCandidates(page, storeUrl);
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
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitAndDismiss(page, 2500);
  await selectProductOptions(page);
  await waitAndDismiss(page, 1000);
  if (await isProductUnavailable(page)) return false;
  if (await clickByTexts(page, buyNowTexts, 'Buy now', { optional: true })) {
    await waitAfterProductAction(page);
    if (await isStrictCheckoutPage(page)) return true;
    if (await moveFromCartOrDrawerToCheckout(page, origin)) return true;
  }
  await waitAndDismiss(page, 1000);
  if (!(await clickAddToCart(page))) return false;
  await waitAfterProductAction(page);
  if (await isStrictCheckoutPage(page)) return true;
  if (await moveFromCartOrDrawerToCheckout(page, origin)) return true;
  if (await openCartThenCheckout(page, origin)) return true;
  if (isProductPageUrl(page.url())) return false;
  return await isStrictCheckoutPage(page);
}

async function collectProductCandidates(page, storeUrl) {
  const origin = new URL(storeUrl || page.url()).origin;
  const listingUrls = [storeUrl, `${origin}/collections/all`, `${origin}/collections/frontpage`, `${origin}/collections/best-selling`, `${origin}/products`, `${origin}/shop`, `${origin}/store`, `${origin}/ar`, `${origin}/en`];
  const all = [];
  const seenPages = new Set();
  for (const url of listingUrls) {
    if (!url || seenPages.has(url)) continue;
    seenPages.add(url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await waitAndDismiss(page, 1500);
      all.push(...await extractCandidateLinks(page, origin));
    } catch (_) {}
    if (uniqueByUrl(all).length >= 25) break;
  }
  return uniqueByUrl(all).sort((a, b) => b.score - a.score).slice(0, 35).map(x => x.url);
}

async function extractCandidateLinks(page, origin) {
  const rawLinks = await page.$$eval('a[href]', anchors => anchors.map(a => {
    const parent = a.closest('article, li, .product, .product-card, .grid__item, .card, .item, [class*="product"]') || a.parentElement;
    return { href: a.href, text: (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim(), parentText: parent ? (parent.innerText || '').slice(0, 700) : '', hasImage: !!a.querySelector('img'), classes: String(a.className || '') };
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
      const combined = `${link.text} ${link.parentText} ${link.classes}`;
      let score = 0;
      if (/\/products?\//i.test(url.pathname)) score += 30;
      if (/\/product\//i.test(url.pathname)) score += 25;
      if (/\/p\//i.test(url.pathname)) score += 18;
      if (/(LE|EGP|جنيه|ريال|SAR|AED|درهم|price|السعر)/i.test(combined)) score += 12;
      if (/(أضف|اضف|شراء|اشتري|منتج|product|add to cart|buy|اختر المقاس)/i.test(combined)) score += 8;
      if (/(sold out|out of stock|نفدت|غير متوفر|unavailable)/i.test(combined)) score -= 16;
      if (link.hasImage) score += 4;
      if ((url.pathname.match(/\//g) || []).length <= 3) score += 2;
      if (score >= 10) candidates.push({ url: clean, score });
    } catch (_) {}
  }
  return candidates;
}

async function selectProductOptions(page) {
  await selectNativeOptions(page);
  await selectShopifyVariantFromJson(page);
  await selectVisibleOptionGroups(page);
}

async function selectNativeOptions(page) {
  const selects = page.locator('select:visible');
  const selectCount = await selects.count().catch(() => 0);
  for (let i = 0; i < selectCount; i++) {
    const select = selects.nth(i);
    try {
      const options = await select.locator('option').evaluateAll((opts, placeholders) => opts.map(o => ({ value: o.value, text: o.textContent || '', disabled: o.disabled })).filter(o => o.value && !o.disabled && !placeholders.some(p => new RegExp(p.source, p.flags).test(o.text)) && !/sold|unavailable|out of stock|غير متوفر|نفدت/i.test(o.text)), optionPlaceholderTexts.map(p => ({ source: p.source, flags: p.flags })));
      if (options.length) {
        await select.selectOption(options[0].value, { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch (_) {}
  }
}

async function selectShopifyVariantFromJson(page) {
  const variant = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script:not([src])'));
    const texts = scripts.map(s => s.textContent || '').filter(t => /"variants"|available/.test(t));
    function findAvailable(value) {
      if (!value) return null;
      if (Array.isArray(value)) return value.find(v => v && v.available && Array.isArray(v.options)) || null;
      if (Array.isArray(value.variants)) return value.variants.find(v => v && v.available && Array.isArray(v.options)) || null;
      if (value.product && Array.isArray(value.product.variants)) return value.product.variants.find(v => v && v.available && Array.isArray(v.options)) || null;
      return null;
    }
    for (const text of texts) {
      const trimmed = text.trim();
      const candidates = [trimmed];
      const objectMatch = trimmed.match(/\{[\s\S]*"variants"[\s\S]*\}/);
      if (objectMatch) candidates.push(objectMatch[0]);
      for (const candidate of candidates) {
        try {
          const found = findAvailable(JSON.parse(candidate));
          if (found) return { id: String(found.id || ''), options: found.options.map(String) };
        } catch (_) {}
      }
    }
    if (window.meta && window.meta.product && Array.isArray(window.meta.product.variants)) {
      const found = window.meta.product.variants.find(v => v && v.available && Array.isArray(v.options));
      if (found) return { id: String(found.id || ''), options: found.options.map(String) };
    }
    return null;
  }).catch(() => null);
  if (!variant) return false;
  if (variant.id) {
    await page.locator('input[name="id"], select[name="id"]').evaluateAll((nodes, id) => {
      for (const node of nodes) {
        node.value = id;
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, variant.id).catch(() => {});
  }
  for (const option of variant.options || []) await clickOptionByText(page, option);
  await page.waitForTimeout(1000);
  return true;
}

async function selectVisibleOptionGroups(page) {
  const groups = page.locator('variant-radios fieldset, variant-selects fieldset, fieldset, .product-form__input, .variant-picker, [class*="variant"], [class*="swatch"]');
  const groupCount = await groups.count().catch(() => 0);
  for (let i = 0; i < Math.min(groupCount, 8); i++) {
    const group = groups.nth(i);
    if (await clickFirstGoodOption(group, page)) await page.waitForTimeout(600);
  }
  const looseOptions = page.locator('label:has(input[type="radio"]:not(:disabled)), button[data-option-value], button[data-value], [role="radio"]:not([aria-disabled="true"])');
  const count = await looseOptions.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 30); i++) {
    const opt = looseOptions.nth(i);
    if (await optionLooksSelectable(opt)) {
      await opt.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await opt.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(400);
      if (!(await isProductUnavailable(page))) break;
    }
  }
}

async function clickFirstGoodOption(group, page) {
  const options = group.locator('label:has(input[type="radio"]:not(:disabled)), button:not([disabled]), [role="radio"]:not([aria-disabled="true"])');
  const count = await options.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 30); i++) {
    const opt = options.nth(i);
    if (!(await optionLooksSelectable(opt))) continue;
    await opt.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    await opt.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function optionLooksSelectable(locator) {
  try {
    if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) return false;
    const meta = await locator.evaluate(node => [node.innerText, node.textContent, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('class'), node.getAttribute('aria-disabled'), node.getAttribute('disabled')].filter(Boolean).join(' '));
    if (isActionText(meta)) return false;
    if (/sold|unavailable|disabled|out of stock|variant sold out|غير متوفر|نفدت|غير متاح/i.test(meta)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

async function clickOptionByText(page, text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const patterns = [new RegExp(`^\\s*${escapeRegExp(clean)}\\s*$`, 'i'), new RegExp(escapeRegExp(clean), 'i')];
  for (const pattern of patterns) {
    const locators = [page.getByRole('radio', { name: pattern }), page.getByRole('button', { name: pattern }), page.locator('label, button, [role="radio"]').filter({ hasText: pattern })];
    for (const locator of locators) {
      try {
        if ((await locator.count()) && await optionLooksSelectable(locator.first())) {
          await locator.first().scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
          await locator.first().click({ timeout: 2500 });
          return true;
        }
      } catch (_) {}
    }
  }
  return false;
}

async function clickAddToCart(page) {
  if (await clickByTexts(page, addToCartTexts, 'Add to cart', { optional: true })) return true;
  const selectors = ['form[action*="/cart/add"] button[type="submit"]', 'form[action*="/cart/add"] input[type="submit"]', 'button[name="add"]', '[data-add-to-cart]', '.product-form__submit', 'button[type="submit"]'];
  for (const selector of selectors) {
    const locators = page.locator(selector);
    const count = await locators.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = locators.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const meta = await el.evaluate(node => [node.innerText, node.textContent, node.value, node.getAttribute('aria-label'), node.getAttribute('class'), node.getAttribute('disabled'), node.getAttribute('aria-disabled')].filter(Boolean).join(' '));
        if (/sold|unavailable|disabled|نفدت|غير متوفر/i.test(meta)) continue;
        await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await el.click({ timeout: 8000 });
        return true;
      } catch (_) {}
    }
  }
  return false;
}

async function selectPayment(page, paymentMethod) {
  const customPatterns = paymentMethod ? [new RegExp(escapeRegExp(paymentMethod), 'i')] : [];
  const clicked = await clickByTexts(page, [...customPatterns, ...codTexts], 'Payment method', { optional: true });
  if (!clicked) throw new Error('Cash on Delivery payment method not found. Store stopped for payment safety.');
  return true;
}

async function assertSafeCodSelected(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const compact = String(text || '').replace(/\s+/g, ' ');
  if (!codTexts.some(pattern => pattern.test(compact))) throw new Error('Cash on Delivery is not visible on checkout. Store stopped for payment safety.');
  const unsafeFieldVisible = await page.locator('input[name*="card" i], input[id*="card" i], input[autocomplete="cc-number"]').first().isVisible({ timeout: 1000 }).catch(() => false);
  const onlyUnsafeVisible = unsafePaymentTexts.some(pattern => pattern.test(compact)) && !codTexts.some(pattern => pattern.test(compact));
  if (unsafeFieldVisible || onlyUnsafeVisible) throw new Error('Checkout appears to require card payment. Store stopped for payment safety.');
}

async function clickPlaceOrder(page) {
  if (await clickByTexts(page, placeOrderTexts, 'Place order', { optional: true })) return true;
  const selectors = ['button#place_order', 'input#place_order', 'button[name="woocommerce_checkout_place_order"]', 'input[name="woocommerce_checkout_place_order"]', '.woocommerce-checkout-payment button[type="submit"]', 'form.checkout button[type="submit"]', 'form[action*="checkout"] button[type="submit"]', 'main button[type="submit"]', 'form button[type="submit"]'];
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    try {
      if ((await locator.count()) && await locator.isVisible({ timeout: 800 }).catch(() => false)) {
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await locator.click({ timeout: 8000 });
        return true;
      }
    } catch (_) {}
  }
  throw new Error('Place order button not found');
}

async function moveFromCartOrDrawerToCheckout(page, origin) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await isStrictCheckoutPage(page)) return true;
    await waitAndDismiss(page, 1000);
    if (await clickByTexts(page, checkoutTexts, 'Checkout', { optional: true })) {
      await waitAfterProductAction(page);
      if (await isStrictCheckoutPage(page)) return true;
    }
  }
  return false;
}

async function openCartThenCheckout(page, origin) {
  try {
    await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitAndDismiss(page, 2500);
    const cartText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/cart\s*is\s*empty|empty\s*cart|سلة\s*التسوق\s*فارغة|السلة\s*فارغة|لا\s*توجد\s*منتجات/i.test(cartText)) return false;
    if (await isStrictCheckoutPage(page)) return true;
    if (await clickByTexts(page, checkoutTexts, 'Checkout from cart', { optional: true })) {
      await waitAfterProductAction(page);
      if (await isStrictCheckoutPage(page)) return true;
    }
    await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await waitAfterProductAction(page);
    return await isStrictCheckoutPage(page);
  } catch (_) {
    return false;
  }
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
  await fillFirst(page, ['input[name*="first" i]', 'input[id*="first" i]', 'input[autocomplete="given-name"]'], firstName);
  await fillFirst(page, ['input[name*="last" i]', 'input[id*="last" i]', 'input[autocomplete="family-name"]'], lastName);
  await fillFirst(page, ['input[name*="name" i]', 'input[id*="name" i]', 'input[autocomplete="name"]'], fullName);
  await fillFirst(page, ['input[type="tel"]', 'input[name*="phone" i]', 'input[id*="phone" i]', 'input[name*="mobile" i]', 'input[autocomplete="tel"]'], phone);
  await fillFirst(page, ['input[name*="address" i]', 'input[id*="address" i]', 'input[name*="street" i]', 'input[autocomplete="address-line1"]'], address);
  await fillFirst(page, ['input[name*="city" i]', 'input[id*="city" i]', 'input[autocomplete="address-level2"]'], city);
  await fillFirst(page, ['textarea[name*="note" i]', 'textarea[id*="note" i]', 'textarea[name*="comment" i]', 'textarea'], notes);
}

async function selectShippingProvince(page, store) {
  const preferredProvince = String(store['Test Province'] || store['Test State'] || store['Test Governorate'] || 'محافظة القاهرة').trim();
  const preferredPatterns = [new RegExp(escapeRegExp(preferredProvince), 'i'), /محافظة\s*القاهرة/i, /القاهرة/i, /cairo/i];
  const selectors = ['select[name="zone"]', 'select[id*="zone" i]', 'select[name*="province" i]', 'select[name*="state" i]', 'select[autocomplete*="address-level1" i]', 'select'];
  for (const selector of selectors) {
    const selects = page.locator(selector);
    const count = await selects.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 20); i++) {
      const select = selects.nth(i);
      try {
        if (!(await select.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const meta = await select.evaluate(node => {
          const id = node.getAttribute('id') || '';
          const name = node.getAttribute('name') || '';
          const autocomplete = node.getAttribute('autocomplete') || '';
          const aria = node.getAttribute('aria-label') || '';
          const optionsText = Array.from(node.options || []).map(o => o.textContent || '').join(' ');
          return [id, name, autocomplete, aria, optionsText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        });
        if (!/zone|province|state|address-level1|محافظة|القاهرة|الإسكندرية|الجيزة/i.test(meta)) continue;
        const options = await select.locator('option').evaluateAll(opts => opts.map(o => ({ value: o.value, text: (o.textContent || '').replace(/\s+/g, ' ').trim(), disabled: o.disabled })));
        const validOptions = options.filter(o => o.value && !o.disabled && !/select|choose|اختر|اختار|province|state|الرجاء/i.test(o.text));
        if (!validOptions.length) continue;
        const chosen = validOptions.find(o => preferredPatterns.some(pattern => pattern.test(o.text) || pattern.test(o.value))) || validOptions[0];
        await select.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await select.selectOption(chosen.value, { timeout: 5000 });
        await page.waitForTimeout(1500);
        console.log(`Selected province/state: ${chosen.text || chosen.value}`);
        return true;
      } catch (_) {}
    }
  }
  throw new Error('Could not select shipping province/state');
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && await locator.isVisible().catch(() => false)) {
        const type = await locator.getAttribute('type').catch(() => '');
        if (/hidden|submit|button|radio|checkbox/i.test(type || '')) continue;
        await locator.fill(String(value), { timeout: 5000 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function clickByTexts(page, patterns, label, options = {}) {
  for (const pattern of patterns) {
    const locators = [page.getByRole('button', { name: pattern }), page.getByRole('link', { name: pattern }), page.locator('input[type="submit"], input[type="button"]').filter({ hasText: pattern }), page.locator('button, a, [role="button"], label').filter({ hasText: pattern })];
    for (const locator of locators) {
      try {
        if ((await locator.count()) > 0 && await locator.first().isVisible({ timeout: 1000 }).catch(() => false)) {
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

async function isProductUnavailable(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const hasOutText = outOfStockTexts.some(p => p.test(bodyText));
  const hasBuyOrCart = await hasClickableText(page, [...buyNowTexts, ...addToCartTexts]);
  if (hasOutText && !hasBuyOrCart) return true;
  const buttons = page.locator('button, a[role="button"], input[type="button"], input[type="submit"]');
  const count = await buttons.count().catch(() => 0);
  let actionButtons = 0;
  let enabledActions = 0;
  for (let i = 0; i < Math.min(count, 100); i++) {
    const el = buttons.nth(i);
    try {
      const label = await el.evaluate(node => [node.innerText, node.textContent, node.value, node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' '));
      if (![...buyNowTexts, ...addToCartTexts].some(p => p.test(label))) continue;
      actionButtons += 1;
      const disabled = await el.evaluate(node => !!node.disabled || node.getAttribute('aria-disabled') === 'true' || /disabled|unavailable|sold/i.test(node.className || ''));
      if (!disabled && await el.isVisible({ timeout: 300 }).catch(() => false)) enabledActions += 1;
    } catch (_) {}
  }
  return actionButtons > 0 && enabledActions === 0;
}

async function hasClickableText(page, patterns) {
  for (const pattern of patterns) {
    const locator = page.locator('button, a, [role="button"], input[type="submit"], input[type="button"]').filter({ hasText: pattern });
    try {
      if ((await locator.count()) > 0 && await locator.first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
    } catch (_) {}
  }
  return false;
}

async function isStrictCheckoutPage(page) {
  const url = page.url();
  if (isProductPageUrl(url) || /\/collections?(\/|$|\?)/i.test(url)) return false;
  if (/\/checkouts?(\/|$|\?)|\/checkout(\/|$|\?)|checkout\.shopify\.com/i.test(url)) return true;
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const hasCheckoutTitle = /(الدفع|checkout|shipping|payment|billing|إتمام\s*الطلب|اتمام\s*الطلب)/i.test(compact);
  const hasContactField = /(البريد\s*الإلكتروني|email|e-mail|رقم\s*الهاتف|هاتف|phone|mobile)/i.test(compact);
  const hasAddressField = /(العنوان|address|city|مدينة|محافظة|state|province|country|البلد|المنطقة)/i.test(compact);
  const hasSubmitLike = /(الطلب\s*الكامل|تأكيد\s*الطلب|تاكيد\s*الطلب|إتمام\s*الطلب|اتمام\s*الطلب|complete\s*order|place\s*order|pay\s*now)/i.test(compact);
  return hasCheckoutTitle && hasContactField && hasAddressField && hasSubmitLike;
}

async function waitAfterProductAction(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await waitAndDismiss(page, 4000);
}

async function waitForCheckoutProgress(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(15000);
}

async function waitAndDismiss(page, ms) {
  await page.waitForTimeout(ms);
  await dismissPopups(page);
}

async function dismissPopups(page) {
  const patterns = [/accept/i, /agree/i, /close/i, /قبول/i, /موافق/i, /اغلاق/i, /إغلاق/i, /^x$/i, /^×$/i];
  for (const pattern of patterns) {
    try {
      const locator = page.locator('button, a, [role="button"]').filter({ hasText: pattern });
      if (await locator.count()) await locator.first().click({ timeout: 1500 }).catch(() => {});
    } catch (_) {}
  }
}

async function saveDebugCheckpoint(page, storeName, stepName) {
  if (!DEBUG_SCREENSHOTS) return;
  await saveViewportDebugScreenshot(page, storeName, `${stepName}_viewport`).catch(err => console.log(`${storeName}: viewport screenshot failed at ${stepName}: ${err && err.message ? err.message : err}`));
  await saveDebugScreenshot(page, storeName, `${stepName}_fullpage`).catch(err => console.log(`${storeName}: fullpage screenshot failed at ${stepName}: ${err && err.message ? err.message : err}`));
  await saveCheckoutDebugDump(page, storeName, stepName).catch(err => console.log(`${storeName}: debug dump failed at ${stepName}: ${err && err.message ? err.message : err}`));
}

async function saveDebugScreenshot(page, storeName, failedStep) {
  if (!DEBUG_SCREENSHOTS) return '';
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const screenshotPath = `${DEBUG_DIR}/${RUN_ID}_${safeName(storeName)}_${safeName(failedStep)}_${timestampSlug()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`${storeName}: debug screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  } catch (err) {
    console.log(`${storeName}: could not save debug screenshot: ${err && err.message ? err.message : err}`);
    return '';
  }
}

async function saveViewportDebugScreenshot(page, storeName, stepName) {
  if (!DEBUG_SCREENSHOTS) return '';
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const screenshotPath = `${DEBUG_DIR}/${RUN_ID}_${safeName(storeName)}_${safeName(stepName)}_${timestampSlug()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`${storeName}: viewport screenshot saved: ${screenshotPath}`);
  return screenshotPath;
}

async function saveCheckoutDebugDump(page, storeName, stepName) {
  if (!DEBUG_SCREENSHOTS) return '';
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const dumpPath = `${DEBUG_DIR}/${RUN_ID}_${safeName(storeName)}_${safeName(stepName)}_${timestampSlug()}.txt`;
  const data = await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function info(el, index) {
      return { index, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', id: el.getAttribute('id') || '', name: el.getAttribute('name') || '', autocomplete: el.getAttribute('autocomplete') || '', placeholder: el.getAttribute('placeholder') || '', ariaLabel: el.getAttribute('aria-label') || '', text: (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 220), value: el.value || '', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', className: String(el.className || '') };
    }
    return { url: location.href, title: document.title, fields: Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).map(info), buttons: Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')).filter(visible).map(info), alerts: Array.from(document.querySelectorAll('[role="alert"], [aria-live], .error, .errors, .message, .notice')).filter(visible).map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 50), bodyTextStart: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 1500) };
  });
  await fs.writeFile(dumpPath, [`RUN_ID: ${RUN_ID}`, `STORE: ${storeName}`, `STEP: ${stepName}`, `URL: ${data.url}`, `TITLE: ${data.title}`, '', 'VISIBLE FIELDS:', JSON.stringify(data.fields, null, 2), '', 'VISIBLE BUTTONS:', JSON.stringify(data.buttons, null, 2), '', 'ALERTS / VALIDATION TEXTS:', JSON.stringify(data.alerts, null, 2), '', 'BODY TEXT START:', data.bodyTextStart].join('\n'), 'utf8');
  console.log(`${storeName}: checkout debug dump saved: ${dumpPath}`);
  return dumpPath;
}

async function fetchStores() {
  const res = await fetch(`${WEBAPP_URL}?action=stores`);
  if (!res.ok) throw new Error(`Failed to fetch stores: ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Apps Script returned error');
  return data.stores || [];
}

async function logResult(result) {
  const res = await fetch(WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'log_result', result }) });
  if (!res.ok) throw new Error(`Failed to log result: ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Apps Script log error');
}

async function waitForOrderNumberFromEmail(store, sinceIso, timeoutMs = 90000) {
  const email = String(store['Test Email'] || '').trim();
  const storeName = String(store['Store Name'] || '').trim();
  if (!email || !/@/.test(email)) return '';
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const params = new URLSearchParams({ action: 'find_order_email', email, storeName, since: sinceIso });
      const res = await fetch(`${WEBAPP_URL}?${params.toString()}`);
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      } else {
        const data = JSON.parse(text);
        if (data.ok && data.orderNumber) {
          const value = cleanOrderNumber(data.orderNumber);
          if (isLikelyOrderNumber(value)) return value;
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

async function getPageDebugInfo(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return `url=${url} | title=${title} | text=${String(text).replace(/\s+/g, ' ').trim().slice(0, 700)}`;
}

function isActionText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return [...addToCartTexts, ...buyNowTexts, ...checkoutTexts, ...placeOrderTexts, /الرئيسية/i, /القائمة/i, /بحث/i, /search/i].some(p => p.test(value));
}

function isProductPageUrl(url) {
  return /\/products?\//i.test(String(url || ''));
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

function normalizeOptionalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/حط_|ضع_|product_url|product url|example|placeholder/i.test(raw)) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw;
}

function cleanOrderNumber(value) {
  return String(value || '').toUpperCase().replace(/^#+/, '').replace(/[.,،:;]+$/g, '').replace(/[^A-Z0-9_-]/g, '').trim();
}

function isLikelyOrderNumber(value) {
  const v = cleanOrderNumber(value);
  if (!v || v.length < 2 || v.length > 30) return false;
  const badWords = ['CONFIRMED', 'CONFIRM', 'CONFIRMATION', 'ORDER', 'ORDERS', 'THANK', 'THANKYOU', 'STORE', 'EMAIL', 'SHIPPED', 'DELIVERED', 'PROFILE', 'PAYMENT', 'SHIPPING'];
  if (badWords.includes(v)) return false;
  if (['FFFFFF', 'F1F1F1', '000000'].includes(v)) return false;
  const digitCount = (v.match(/\d/g) || []).length;
  if (digitCount < 2) return false;
  if (/^0?1\d{9}$/.test(v) || /^05\d{8}$/.test(v)) return false;
  if (/^\d{9,}$/.test(v)) return false;
  if (/^(16|17|18|19|20)\d{8,}$/.test(v)) return false;
  return /^[A-Z0-9][A-Z0-9_-]{1,30}$/i.test(v);
}

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeName(value) {
  return String(value || 'item').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'item';
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
