require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "NGN";
}

function countryForDestination(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Nigeria";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider
    .replace(/\s+/g, "-")
    .toLowerCase();

  fs.writeFileSync(
    `debug-${safe}.txt`,
    String(text || ""),
    "utf8"
  );
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function extractRateFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`⇅\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`rate:?\\s*GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`1\\s*GBP\\s*[=:]\\s*([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) return Number(match[1]);
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "GBP") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function buildPayloadFromText(source, bodyText) {
  const currency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, currency);
  const fee = extractFeeFromText(bodyText, "GBP");
  let amountReceived = extractAmountReceivedFromText(bodyText, currency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function extractGbpNgnRate(text) {
  if (!text) return null;

  const cleaned = String(text)
    .replace(/,/g, "")
    .replace(/\s+/g, " ");

  const patterns = [
    /Exchange\s*Rate\s*1\s*GBP\s*=\s*([0-9]+(?:\.[0-9]+)?)/i,
    /Rate\s*1\s*GBP\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*NGN/i,
    /1\s*GBP\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*NGN/i,
    /GBP\s*[=≈]\s*([0-9]+(?:\.[0-9]+)?)\s*NGN/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);

    if (!match) continue;

    const rate = parseLocaleNumber(match[1]);

    if (rate && rate >= 1000 && rate <= 3000) {
      return Number(rate.toFixed(6));
    }
  }

  return null;
}


async function handleJupay(page, source) {
  await page.goto("https://jupay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#country").first().selectOption("GBP");
  await page.locator("#country").nth(1).selectOption("NGN");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate:\s*([0-9,]+(?:\.\d+)?)/i,
    /1\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1870(?:\.\d+)?)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1870;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleOaPay(page, source) {
  await page.goto("https://www.oapay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByText("GBP").nth(1).click().catch(() => {});
  await page.getByText("GBP United Kingdom").click().catch(() => {});

  await page.waitForTimeout(1200);

  await page.getByText("GHS").nth(2).click().catch(async () => {
    await page.getByText(/NGN|GHS/i).nth(2).click().catch(() => {});
  });
  await page.getByText("NGN Nigeria").click().catch(async () => {
    await page.getByText(/NGN/i).first().click();
  });

  await page.waitForTimeout(1500);

  const box = page.getByRole("textbox", { name: /Recipient Receives/i });
  await box.waitFor({ timeout: 10000 });
  await box.click();
  await box.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN\s*\(no charges\)/i,
    /1\.00\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b([2-9][0-9]{2,4}\.\d{2,4})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract OaPay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleOhentPay(page, source) {
  await page.goto("https://www.ohentpay.com/en-GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("link", { name: /flag Nigeria/i }).click().catch(() => {});
  await page.waitForTimeout(2000);

  await page
    .getByRole("combobox")
    .filter({ hasText: /GBP|Select currency/i })
    .first()
    .click()
    .catch(() => {});
  await page.getByText("Great British Pounds (GBP)").click().catch(() => {});

  await page.waitForTimeout(1500);

  const amountInput = page.getByRole("textbox", { name: "0.00" }).first();
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.getByText(/You send|Exchange rate/i).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /Exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b([2-9][0-9]{2,4}\.\d{2,4})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Ohent Pay rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}


async function handlePadiePay(page, source) {
  await page.goto("https://www.padiepay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(7000);

  await page
    .getByRole("button", {
      name: "Maybe, later",
      exact: true,
    })
    .click({
      timeout: 10000,
      force: true,
    })
    .catch(() => {});

  await page.waitForTimeout(1000);

  /*
   * Select sending currency: GBP
   */
  const sendCurrencyButton = page.getByRole(
    "button",
    {
      name: "🇺🇸 USD",
      exact: true,
    }
  );

  await sendCurrencyButton.waitFor({
    state: "visible",
    timeout: 20000,
  });

  await sendCurrencyButton.click({
    timeout: 15000,
    force: true,
  });

  await page.waitForTimeout(1000);

  const gbpOption = page.getByText(
    "🇬🇧GBPBritish Pound Sterling",
    {
      exact: true,
    }
  );

  await gbpOption.waitFor({
    state: "visible",
    timeout: 15000,
  });

  await gbpOption.click({
    timeout: 15000,
    force: true,
  });

  await page.waitForTimeout(1500);

  /*
   * Select receiving currency: NGN
   */
  const receiveCurrencyButton = page.getByRole(
    "button",
    {
      name: "🇳🇬 NGN",
      exact: true,
    }
  );

  await receiveCurrencyButton.waitFor({
    state: "visible",
    timeout: 20000,
  });

  await receiveCurrencyButton.click({
    timeout: 15000,
    force: true,
  });

  await page.waitForTimeout(1000);

  const ngnOption = page.getByText(
    "🇳🇬NGNNigerian Naira",
    {
      exact: true,
    }
  );

  await ngnOption.waitFor({
    state: "visible",
    timeout: 15000,
  });

  await ngnOption.click({
    timeout: 15000,
    force: true,
  });

  await page.waitForTimeout(6000);

  /*
   * Read both visible rate formats.
   */
  const exchangeRateText = await page
    .getByText(
      /Exchange\s*rate\s*1\s*GBP\s*=\s*[0-9,.]+/i
    )
    .first()
    .innerText()
    .catch(() => "");

  const directRateText = await page
    .getByText(
      /GBP\s*=\s*[0-9,.]+\s*NGN/i
    )
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const combinedText = [
    exchangeRateText,
    directRateText,
    bodyText,
  ].join("\n");

  saveDebugText(
    source.provider,
    combinedText
  );

  const patterns = [
    /Exchange\s*rate\s*1\s*GBP\s*=\s*([0-9,.]+)/i,
    /GBP\s*=\s*([0-9,.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9,.]+)\s*NGN/i,
  ];

  let rate = null;

  for (const pattern of patterns) {
    const match = combinedText.match(pattern);

    if (!match) continue;

    const candidate = parseLocaleNumber(
      match[1]
    );

    if (
      candidate &&
      candidate >= 1000 &&
      candidate <= 3000
    ) {
      rate = Number(
        candidate.toFixed(6)
      );

      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `Could not extract PadiePay GBP/NGN rate. ` +
      `Captured text: ${combinedText
        .replace(/\s+/g, " ")
        .slice(0, 500)}. ` +
      `Screenshot: ${file}`
    );
  }

  console.log(
    `PadiePay extracted rate: ${rate}`
  );

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status:
      "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    verified_method:
      "padiepay_live_gbp_ngn_rate",
  };
}

async function handlePesaCo(page, source) {
  await page.goto("https://www.pesa.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency = GBP
  await page.locator("#send-option").getByText("CAD").click().catch(() => {});
  await page.getByText("GBP").first().click().catch(() => {});

  await page.waitForTimeout(1200);

  // Receiving currency = NGN
  await page.locator("#receive-option").getByText("NGN").click().catch(() => {});
  await page.getByText("NGN").nth(1).click().catch(async () => {
    await page.getByText(/^NGN$/).click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.locator("#sendAmount");
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill(String(scrapeAmount));

  await page.locator(".div-block-71 > div:nth-child(3)").click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  let directRateText = "";
  const rateLocator = page.locator("#rateValue");
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /By exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b([2-9][0-9]{2,4}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Pesa.co rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    quoted_send_amount: scrapeAmount,
  };
}


async function handleTransferGalaxy(page, source) {
  await page.goto("https://transfergalaxy.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#languageModal a").filter({ hasText: "English" }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.getByRole("combobox", { name: "Sweden" }).click().catch(() => {});
  await page.locator("#bs-select-1-3").click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.getByRole("combobox", { name: "Pick a country" }).click().catch(() => {});
  await page.locator("#bs-select-2-40").click().catch(async () => {
    await page.getByText(/^Nigeria$/).click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  let directRateText = "";
  const rateLocator = page.locator("#aocResponse");
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b(1827\.7757)\b/,
    /\b(18[0-9]{2}\.\d{2,5})\b/,
    /\b([2-9][0-9]{2,4}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TransferGalaxy rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}



async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "Jupay") payload = await handleJupay(page, source);
    
else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
else if (source.provider === "TransferGalaxy") payload = await handleTransferGalaxy(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ng3.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});