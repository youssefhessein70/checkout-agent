const STORES_SHEET_NAME = 'Stores';
const LOG_SHEET_NAME = 'Runs Log';

function doGet(e) {
  const action = (e.parameter.action || '').toLowerCase();
  if (action === 'stores') {
    return jsonResponse({ ok: true, stores: getStores_() });
  }
  return jsonResponse({ ok: true, message: 'Checkout Agent Web App is running' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.action === 'log_result') {
      appendLog_(body.result);
      updateStore_(body.result);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
}

function getStores_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(STORES_SHEET_NAME);
  if (!sheet) throw new Error('Missing sheet: ' + STORES_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).map((row, index) => {
    const item = { rowNumber: index + 2 };
    headers.forEach((header, i) => item[header] = row[i]);
    return item;
  }).filter(s => String(s.Active).toLowerCase() === 'true' || s.Active === true || String(s.Active) === '1');
}

function appendLog_(result) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(LOG_SHEET_NAME);
  if (!sheet) throw new Error('Missing sheet: ' + LOG_SHEET_NAME);
  sheet.appendRow([
    result.timestamp || new Date().toISOString(),
    result.runId || '',
    result.storeName || '',
    result.previousOrder || '',
    result.currentOrder || '',
    result.difference || '',
    result.estimatedOrders || '',
    result.status || '',
    result.failedStep || '',
    result.errorMessage || '',
    result.screenshotPath || ''
  ]);
}

function updateStore_(result) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(STORES_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0].map(String);
  const storeNameCol = headers.indexOf('Store Name');
  const lastOrderCol = headers.indexOf('Last Test Order');
  const statusCol = headers.indexOf('Last Run Status');
  const dateCol = headers.indexOf('Last Run Date');
  const errorCol = headers.indexOf('Last Error');
  if (storeNameCol === -1) return;

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][storeNameCol]).trim() === String(result.storeName).trim()) {
      const rowNumber = r + 1;
      if (lastOrderCol !== -1 && result.currentOrder) sheet.getRange(rowNumber, lastOrderCol + 1).setValue(result.currentOrder);
      if (statusCol !== -1) sheet.getRange(rowNumber, statusCol + 1).setValue(result.status || '');
      if (dateCol !== -1) sheet.getRange(rowNumber, dateCol + 1).setValue(result.timestamp || new Date().toISOString());
      if (errorCol !== -1) sheet.getRange(rowNumber, errorCol + 1).setValue(result.errorMessage || '');
      return;
    }
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
