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


async function handleLemFi(page, source) {
  await page.goto("https://lemfi.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^GBP$/ }).first().click({ force: true }).catch(async () => {
    await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true });
  });

  let searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("gbp");
  await page.waitForTimeout(1000);
  await page.getByText("United Kingdom", { exact: true }).click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click();
  });

  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^EUR$/ }).first().click({ force: true }).catch(async () => {
    const selectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await selectors.count();
    if (count >= 2) {
      await selectors.nth(1).click({ force: true });
    } else {
      await selectors.first().click({ force: true });
    }
  });

  searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("niger");
  await page.waitForTimeout(1000);

  await page.getByText(/NGN/i).first().click().catch(async () => {
    await page.getByText(/Nigerian Naira/i).first().click();
  });

  await page.waitForTimeout(1500);

  const sendBox = page.getByRole("textbox", { name: /You send/i });
  await sendBox.waitFor({ timeout: 10000 });
  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return payload;
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

async function handleVeloRemit(page, source) {
  const response = await page.goto(
    "https://veloremit.com/en",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }
  ).catch(() => null);

  await page.waitForTimeout(5000);

  const status = response?.status() || null;

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const blocked =
    status === 403 ||
    /403\s*ERROR/i.test(bodyText) ||
    /request could not be satisfied/i.test(bodyText) ||
    /request blocked/i.test(bodyText) ||
    /CloudFront/i.test(bodyText);

  if (blocked) {
    saveDebugText(
      source.provider,
      [
        `HTTP status: ${status || "unknown"}`,
        "VeloRemit blocked the GitHub Actions request.",
        bodyText,
      ].join("\n")
    );

    console.log(
      `SKIP: VeloRemit ${source.origin}->${source.destination} - CloudFront HTTP 403`
    );

    return null;
  }

  await page
    .getByRole("button", {
      name: "Currency Converter",
      exact: true,
    })
    .click({
      timeout: 15000,
      force: true,
    });

  await page.waitForTimeout(1200);

  await page
    .locator("div")
    .filter({ hasText: /^GBP$/ })
    .nth(1)
    .click({
      timeout: 15000,
      force: true,
    });

  await page
    .locator("div")
    .filter({
      hasText: /^United Kingdom - GBP$/,
    })
    .last()
    .click({
      timeout: 15000,
      force: true,
    })
    .catch(() => {});

  await page.waitForTimeout(1200);

  await page
    .locator("div")
    .filter({ hasText: /^GHS$/ })
    .first()
    .dblclick({
      timeout: 15000,
      force: true,
    });

  await page.waitForTimeout(800);

  await page
    .locator("div")
    .filter({
      hasText: /^Nigeria - NGN$/,
    })
    .last()
    .click({
      timeout: 15000,
      force: true,
    });

  await page.waitForTimeout(6000);

  const rateText = await page
    .getByText(
      /(?:Rate\s*)?1?\s*GBP\s*≈\s*[0-9,.]+\s*NGN/i
    )
    .first()
    .innerText()
    .catch(() => "");

  const updatedBodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const combinedText =
    `${rateText}\n${updatedBodyText}`;

  saveDebugText(
    source.provider,
    combinedText
  );

  const patterns = [
    /Rate\s*1\s*GBP\s*≈\s*([0-9,.]+)\s*NGN/i,
    /1\s*GBP\s*≈\s*([0-9,.]+)\s*NGN/i,
    /GBP\s*≈\s*([0-9,.]+)\s*NGN/i,
    /GBP\s*=\s*([0-9,.]+)\s*NGN/i,
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
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `Could not extract VeloRemit GBP/NGN rate. Screenshot: ${file}`
    );
  }

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
      "veloremit_live_gbp_ngn_rate",
  };
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "TransferGo") payload = await handleTransferGo(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    else if (source.provider === "Nala") payload = await handleNala(page, source);
    else if (source.provider === "Roze Remit") payload = await handleRozeRemit(page, source);
    else if (source.provider === "UnityLink") payload = await handleUnityLink(page, source);
else if (source.provider === "Afripay") payload = await handleAfripay(page, source);
else if (source.provider === "Continental Money") payload = await handleContinentalMoney(page, source);
else if (source.provider === "FP Transfer") payload = await handleFPTransfer(page, source);
else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
else if (source.provider === "JubaExpress") payload = await handleJubaExpress(page, source);
else if (source.provider === "Jupay") payload = await handleJupay(page, source);
else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
else if (source.provider === "RemitnGo") payload = await handleRemitnGo(page, source);
else if (source.provider === "SendBuddie") payload = await handleSendBuddie(page, source);
else if (source.provider === "TransferGalaxy") payload = await handleTransferGalaxy(page, source);
else if (source.provider === "VeloRemit") payload = await handleVeloRemit(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

  if (!payload) {
  return;
}

await postQuote(payload);

console.log(
  `OK: ${source.provider} ${source.origin}->${source.destination}`
);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ng.json", "utf8"));
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