# Checkout Agent Starter

أجينت بسيط يعمل Test Order على متاجرك، يقرأ قائمة المتاجر من Google Sheet، ويكتب نتيجة التشغيل في Google Sheet.

## 1) جهز Google Sheet

اعمل Spreadsheet فيه شيتين بالأسماء التالية بالظبط:

### Stores

Headers:

Active | Store Name | Website URL | Product URL | Payment Method | Test Name | Test Phone | Test Email | Test Address1 | Test City | Test Notes | Last Test Order | Last Run Status | Last Run Date | Last Error

### Runs Log

Headers:

Timestamp | Run ID | Store Name | Previous Test Order | Current Test Order | Difference | Estimated Orders Since Last Test | Status | Failed Step | Error Message | Screenshot Path

## 2) Apps Script

افتح Extensions > Apps Script، وانسخ الكود الموجود في:

apps-script/Code.gs

بعدها Deploy > New deployment > Web app:
- Execute as: Me
- Who has access: Anyone with the link

انسخ Web App URL وضعه في ملف .env.

## 3) تثبيت المشروع

```bash
npm install
npm run install:browsers
copy .env.example .env
```

افتح .env وحط WEBAPP_URL.

## 4) التشغيل اليدوي

```bash
npm run run
```

لو عايز تشوف البراوزر وهو بيشتغل:

```bash
npm run run:headed
```

على Windows لو السكريبت `run:headed` اشتغلش بسبب صيغة المتغيرات، خلي HEADLESS=false في ملف .env وشغل:

```bash
npm run run
```

## ملاحظات مهمة

- أول نسخة Generic، يعني بتدور على أزرار Add to cart / Checkout / Place order بالعربي والإنجليزي.
- لازم بيانات التست تكون واضحة: TEST ORDER - DO NOT SHIP.
- لا تستخدم بيانات عملاء حقيقية.
- أفضل أول تجربة تكون على منتج مخفي أو منتج بسعر بسيط وطريقة دفع Test/COD.
