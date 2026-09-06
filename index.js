// ============================================================
// ALGO ESMAIL V5 - Toobit Market Analyzer
// Cloudflare Workers + Telegram
// ============================================================

const BASE_URL = "https://api.toobit.com";

const TIMEOUT_MS = 6000;

// تنظیمات اسکن
const MAX_ANALYSIS_SYMBOLS = 8;
const ANALYSIS_BATCH = 4;
const SHORTLIST_FOR_DERIVATIVES = 3;

const MIN_SIGNAL_SCORE = 65;

// معاملات کاغذی
const PAPER_BUDGET = 100;
const RISK_PERCENT = 1;

// ============================================================
// عمومی
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(arr) {
  const values = arr.filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatNumber(value, digits = 6) {
  const n = safeNumber(value);
  if (!n) return "0";

  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.01) return n.toFixed(5);

  return n.toFixed(digits);
}

function percent(value, digits = 2) {
  return `${safeNumber(value).toFixed(digits)}%`;
}

function escapeMarkdown(text) {
  return String(text)
    .replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

// ============================================================
// HTTP
// ============================================================

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function telegram(method, data, env) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN تنظیم نشده است.");
  }

  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}: ${text}`);
  }

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Telegram پاسخ نامعتبر داد: ${text}`);
  }

  if (!result.ok) {
    throw new Error(`Telegram error: ${text}`);
  }

  return result;
}

async function sendMessage(chatId, text, env, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options
  }, env);
}

// ============================================================
// TOOBIT - SYMBOLS
// ============================================================

async function getExchangeInfo() {
  return fetchJson(`${BASE_URL}/api/v1/exchangeInfo`);
}

function extractContracts(data) {
  if (!data) return [];

  if (Array.isArray(data.contracts)) return data.contracts;
  if (Array.isArray(data.data?.contracts)) return data.data.contracts;

  return [];
}

function isValidContract(contract) {
  const symbol = contract?.symbol || "";

  if (!symbol) return false;

  const status = String(contract.status || "").toUpperCase();

  if (
    status &&
    !["TRADING", "NORMAL", "ONLINE"].includes(status)
  ) {
    return false;
  }

  return (
    symbol.endsWith("-SWAP-USDT") ||
    symbol.endsWith("-USDT")
  );
}

// ============================================================
// TOOBIT - TICKERS
// ============================================================

async function getAllTickers() {
  const data = await fetchJson(
    `${BASE_URL}/quote/v1/contract/ticker/24hr`
  );

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.tickers)) return data.tickers;

  return [];
}

function tickerSymbol(t) {
  return t.symbol || t.s || "";
}

function tickerPrice(t) {
  return safeNumber(
    t.lastPrice ??
    t.last ??
    t.price ??
    t.c
  );
}

function tickerVolume(t) {
  return safeNumber(
    t.quoteVolume ??
    t.volume24h ??
    t.quoteVolume24h ??
    t.qv ??
    t.volume
  );
}

function tickerChange(t) {
  return safeNumber(
    t.priceChangePercent ??
    t.changePercent ??
    t.p
  );
}

// ============================================================
// انتخاب ارزهای مناسب
// ============================================================

async function getBestSymbols() {
  const [exchangeInfo, tickers] = await Promise.all([
    getExchangeInfo(),
    getAllTickers()
  ]);

  const contracts = extractContracts(exchangeInfo);

  const allowed = new Set(
    contracts
      .filter(isValidContract)
      .map(x => x.symbol)
  );

  let candidates = tickers
    .map(t => ({
      symbol: tickerSymbol(t),
      price: tickerPrice(t),
      volume: tickerVolume(t),
      change: tickerChange(t)
    }))
    .filter(x => {
      if (!x.symbol || !x.price) return false;

      if (allowed.size && !allowed.has(x.symbol)) {
        return false;
      }

      return (
        x.symbol.endsWith("-SWAP-USDT") ||
        x.symbol.endsWith("-USDT")
      );
    });

  // اولویت با حجم معاملات
  candidates.sort((a, b) => b.volume - a.volume);

  // BTC را حتماً در صورت وجود نگه می‌داریم
  const btc = candidates.find(x =>
    x.symbol === "BTC-SWAP-USDT"
  );

  const selected = [];

  if (btc) selected.push(btc);

  for (const item of candidates) {
    if (selected.some(x => x.symbol === item.symbol)) continue;

    selected.push(item);

    if (selected.length >= MAX_ANALYSIS_SYMBOLS) {
      break;
    }
  }

  return selected;
}

// ============================================================
// KLINES
// ============================================================

async function getKlines(symbol, interval, limit = 150) {
  const url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&limit=${limit}`;

  const data = await fetchJson(url);

  let rows = [];

  if (Array.isArray(data)) {
    rows = data;
  } else if (Array.isArray(data.data)) {
    rows = data.data;
  }

  return rows
    .map(row => {
      if (Array.isArray(row)) {
        return {
          time: safeNumber(row[0]),
          open: safeNumber(row[1]),
          high: safeNumber(row[2]),
          low: safeNumber(row[3]),
          close: safeNumber(row[4]),
          volume: safeNumber(row[5])
        };
      }

      return {
        time: safeNumber(row.time ?? row.openTime),
        open: safeNumber(row.open),
        high: safeNumber(row.high),
        low: safeNumber(row.low),
        close: safeNumber(row.close),
        volume: safeNumber(row.volume)
      };
    })
    .filter(x =>
      x.open > 0 &&
      x.high > 0 &&
      x.low > 0 &&
      x.close > 0
    );
}

// ============================================================
// INDICATORS
// ============================================================

function ema(values, period) {
  if (!values.length) return [];

  const result = new Array(values.length).fill(null);

  if (values.length < period) return result;

  const multiplier = 2 / (period + 1);

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] =
      (values[i] - result[i - 1]) * multiplier +
      result[i - 1];
  }

  return result;
}

function rsi(values, period = 14) {
  const result = new Array(values.length).fill(null);

  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

function atr(candles, period = 14) {
  const result = new Array(candles.length).fill(null);

  if (candles.length <= period) return result;

  const tr = new Array(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    tr[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
  }

  let initial = 0;

  for (let i = 1; i <= period; i++) {
    initial += tr[i];
  }

  result[period] = initial / period;

  for (let i = period + 1; i < candles.length; i++) {
    result[i] =
      ((result[i - 1] * (period - 1)) + tr[i]) /
      period;
  }

  return result;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    if (fast[i] != null && slow[i] != null) {
      line[i] = fast[i] - slow[i];
    }
  }

  const valid = line.filter(x => x != null);

  const signalValid = ema(valid, 9);

  const signal = new Array(values.length).fill(null);

  let j = 0;

  for (let i = 0; i < values.length; i++) {
    if (line[i] != null) {
      signal[i] = signalValid[j];
      j++;
    }
  }

  const histogram = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    if (line[i] != null && signal[i] != null) {
      histogram[i] = line[i] - signal[i];
    }
  }

  return {
    line,
    signal,
    histogram
  };
}

// ============================================================
// CANDLE PATTERNS
// ============================================================

function candlePatterns(candles) {
  if (candles.length < 3) return [];

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  const patterns = [];

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;

  if (range > 0 && body / range < 0.1) {
    patterns.push("دوجی");
  }

  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  if (
    lower > body * 2 &&
    upper < body
  ) {
    patterns.push("چکش");
  }

  if (
    upper > body * 2 &&
    lower < body
  ) {
    patterns.push("شهاب‌سنگ");
  }

  // Engulfing صعودی
  if (
    b.close < b.open &&
    c.close > c.open &&
    c.open <= b.close &&
    c.close >= b.open
  ) {
    patterns.push("پوشای صعودی");
  }

  // Engulfing نزولی
  if (
    b.close > b.open &&
    c.close < c.open &&
    c.open >= b.close &&
    c.close <= b.open
  ) {
    patterns.push("پوشای نزولی");
  }

  // Pin bar
  if (
    lower > body * 2 &&
    lower > upper * 2
  ) {
    patterns.push("پین‌بار صعودی");
  }

  if (
    upper > body * 2 &&
    upper > lower * 2
  ) {
    patterns.push("پین‌بار نزولی");
  }

  return patterns;
}

// ============================================================
// ساختار بازار
// ============================================================

function marketStructure(candles) {
  if (candles.length < 20) return "نامشخص";

  const recent = candles.slice(-20);

  const highs = recent.map(x => x.high);
  const lows = recent.map(x => x.low);

  const mid = 10;

  const firstHigh = Math.max(...highs.slice(0, mid));
  const secondHigh = Math.max(...highs.slice(mid));

  const firstLow = Math.min(...lows.slice(0, mid));
  const secondLow = Math.min(...lows.slice(mid));

  if (
    secondHigh > firstHigh &&
    secondLow > firstLow
  ) {
    return "صعودی";
  }

  if (
    secondHigh < firstHigh &&
    secondLow < firstLow
  ) {
    return "نزولی";
  }

  return "رنج";
}

// ============================================================
// حمایت / مقاومت
// ============================================================

function supportResistance(candles) {
  if (!candles.length) {
    return {
      support: 0,
      resistance: 0
    };
  }

  const recent = candles.slice(-40);

  return {
    support: Math.min(...recent.map(x => x.low)),
    resistance: Math.max(...recent.map(x => x.high))
  };
}

// ============================================================
// تحلیل یک تایم‌فریم
// ============================================================

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 60) {
    throw new Error("داده کافی برای تحلیل وجود ندارد.");
  }

  const closes = candles.map(x => x.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const rsiValues = rsi(closes, 14);
  const atrValues = atr(candles, 14);
  const macdData = macd(closes);

  const i = candles.length - 1;

  const price = closes[i];

  const e20 = ema20[i];
  const e50 = ema50[i];

  const e200 =
    ema200[i] ??
    ema50[i];

  const rsiValue = rsiValues[i];
  const atrValue = atrValues[i];

  const macdLine = macdData.line[i];
  const macdSignal = macdData.signal[i];
  const macdHistogram = macdData.histogram[i];

  const structure = marketStructure(candles);
  const sr = supportResistance(candles);

  const recentVolumes = candles
    .slice(-21, -1)
    .map(x => x.volume);

  const avgVolume = average(recentVolumes);

  const currentVolume = candles[i].volume;

  const volumeRatio =
    avgVolume > 0
      ? currentVolume / avgVolume
      : 1;

  let bull = 0;
  let bear = 0;

  // EMA
  if (e20 > e50) bull += 15;
  else if (e20 < e50) bear += 15;

  // قیمت نسبت به EMA
  if (price > e20) bull += 8;
  else bear += 8;

  // EMA 200
  if (price > e200) bull += 8;
  else bear += 8;

  // RSI
  if (rsiValue >= 52 && rsiValue <= 70) {
    bull += 12;
  }

  if (rsiValue <= 48 && rsiValue >= 30) {
    bear += 12;
  }

  // MACD
  if (
    macdLine != null &&
    macdSignal != null
  ) {
    if (macdLine > macdSignal) {
      bull += 12;
    } else {
      bear += 12;
    }

    if (macdHistogram > 0) {
      bull += 5;
    } else {
      bear += 5;
    }
  }

  // ساختار
  if (structure === "صعودی") bull += 12;
  if (structure === "نزولی") bear += 12;

  // حجم
  if (volumeRatio >= 1.3) {
    if (price > e20) bull += 6;
    else bear += 6;
  }

  // نزدیک مقاومت/حمایت
  const resistanceDistance =
    sr.resistance > 0
      ? ((sr.resistance - price) / price) * 100
      : 999;

  const supportDistance =
    sr.support > 0
      ? ((price - sr.support) / price) * 100
      : 999;

  const patterns = candlePatterns(candles);

  for (const pattern of patterns) {
    if (
      pattern.includes("صعودی") ||
      pattern === "چکش"
    ) {
      bull += 5;
    }

    if (
      pattern.includes("نزولی") ||
      pattern === "شهاب‌سنگ"
    ) {
      bear += 5;
    }
  }

  return {
    price,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    rsi: rsiValue,
    atr: atrValue,
    macd: macdLine,
    macdSignal,
    macdHistogram,
    volumeRatio,
    structure,
    support: sr.support,
    resistance: sr.resistance,
    resistanceDistance,
    supportDistance,
    patterns,
    bull,
    bear
  };
}

// ============================================================
// تحلیل چند تایم‌فریم
// ============================================================

function combineAnalysis(a15, a1h, a4h) {
  let bull = 0;
  let bear = 0;

  // 4H مهم‌تر
  bull += a4h.bull * 0.45;
  bear += a4h.bear * 0.45;

  // 1H
  bull += a1h.bull * 0.35;
  bear += a1h.bear * 0.35;

  // 15M
  bull += a15.bull * 0.20;
  bear += a15.bear * 0.20;

  const total = bull + bear;

  let direction = "خنثی";

  if (
    bull > bear &&
    bull - bear >= 8
  ) {
    direction = "خرید";
  }

  if (
    bear > bull &&
    bear - bull >= 8
  ) {
    direction = "فروش";
  }

  const score =
    total > 0
      ? Math.round(
          (Math.max(bull, bear) / total) * 100
        )
      : 0;

  return {
    direction,
    score,
    bull,
    bear
  };
}

// ============================================================
// داده‌های مشتقه
// ============================================================

async function getFunding(symbol) {
  try {
    const data = await fetchJson(
      `${BASE_URL}/api/v1/futures/fundingRate?symbol=${encodeURIComponent(symbol)}`
    );

    const item =
      data?.data ??
      data?.result ??
      data;

    if (Array.isArray(item)) {
      return safeNumber(
        item[0]?.fundingRate ??
        item[0]?.rate
      );
    }

    return safeNumber(
      item?.fundingRate ??
      item?.rate
    );
  } catch (error) {
    console.error("Funding error", symbol, error);
    return null;
  }
}

async function getOpenInterest(symbol) {
  try {
    const data = await fetchJson(
      `${BASE_URL}/quote/v1/openInterest?symbol=${encodeURIComponent(symbol)}`
    );

    const item =
      data?.data ??
      data?.result ??
      data;

    if (Array.isArray(item)) {
      return safeNumber(
        item[0]?.openInterest ??
        item[0]?.value
      );
    }

    return safeNumber(
      item?.openInterest ??
      item?.value
    );
  } catch (error) {
    console.error("OI error", symbol, error);
    return null;
  }
}

async function getLongShort(symbol) {
  try {
    const data = await fetchJson(
      `${BASE_URL}/quote/v1/globalLongShortAccountRatio` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&period=1h&limit=1`
    );

    const item =
      data?.data ??
      data?.result ??
      data;

    if (Array.isArray(item)) {
      return safeNumber(
        item[0]?.longShortRatio ??
        item[0]?.ratio
      );
    }

    return safeNumber(
      item?.longShortRatio ??
      item?.ratio
    );
  } catch (error) {
    console.error("LongShort error", symbol, error);
    return null;
  }
}

// ============================================================
// تحلیل BTC
// ============================================================

async function getBTCContext() {
  try {
    const [h1, h4] = await Promise.all([
      getKlines("BTC-SWAP-USDT", "1h", 100),
      getKlines("BTC-SWAP-USDT", "4h", 100)
    ]);

    const a1 = analyzeTimeframe(h1);
    const a4 = analyzeTimeframe(h4);

    return combineAnalysis(
      a1,
      a1,
      a4
    );
  } catch (error) {
    console.error("BTC context error", error);

    return {
      direction: "خنثی",
      score: 0,
      bull: 0,
      bear: 0
    };
  }
}

// ============================================================
// تحلیل یک ارز
// ============================================================

async function analyzeSymbol(item) {
  const symbol = item.symbol;

  try {
    // سه تایم‌فریم به صورت همزمان
    const results = await Promise.allSettled([
      getKlines(symbol, "15m", 100),
      getKlines(symbol, "1h", 120),
      getKlines(symbol, "4h", 120)
    ]);

    if (
      results[0].status !== "fulfilled" ||
      results[1].status !== "fulfilled" ||
      results[2].status !== "fulfilled"
    ) {
      throw new Error("دریافت یکی از تایم‌فریم‌ها ناموفق بود.");
    }

    const candles15 = results[0].value;
    const candles1h = results[1].value;
    const candles4h = results[2].value;

    const a15 = analyzeTimeframe(candles15);
    const a1h = analyzeTimeframe(candles1h);
    const a4h = analyzeTimeframe(candles4h);

    const combined = combineAnalysis(
      a15,
      a1h,
      a4h
    );

    return {
      ...item,
      symbol,
      price: a1h.price,
      analysis15: a15,
      analysis1h: a1h,
      analysis4h: a4h,
      ...combined
    };
  } catch (error) {
    console.error(
      "Symbol analysis error",
      symbol,
      error
    );

    return {
      ...item,
      symbol,
      failed: true,
      error: error.message
    };
  }
}

// ============================================================
// داده‌های عمیق برای گزینه‌های برتر
// ============================================================

async function enrichDerivatives(results) {
  const top = results
    .filter(x =>
      !x.failed &&
      x.direction !== "خنثی"
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_FOR_DERIVATIVES);

  await Promise.all(
    top.map(async item => {
      const [
        funding,
        openInterest,
        longShort
      ] = await Promise.all([
        getFunding(item.symbol),
        getOpenInterest(item.symbol),
        getLongShort(item.symbol)
      ]);

      item.funding = funding;
      item.openInterest = openInterest;
      item.longShort = longShort;

      // تأثیر جزئی داده‌های مشتقه
      if (funding != null) {
        if (
          item.direction === "خرید" &&
          funding < 0.0005
        ) {
          item.score += 3;
        }

        if (
          item.direction === "فروش" &&
          funding > 0.0005
        ) {
          item.score += 3;
        }
      }

      item.score = clamp(
        Math.round(item.score),
        0,
        100
      );
    })
  );

  return results;
}

// ============================================================
// مدیریت حجم کار
// ============================================================

async function runInBatches(items, batchSize, worker) {
  const output = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(
      i,
      i + batchSize
    );

    const results = await Promise.all(
      batch.map(item => worker(item))
    );

    output.push(...results);
  }

  return output;
}

// ============================================================
// Paper Trade
// ============================================================

function calculateTrade(result) {
  if (
    !result ||
    result.failed ||
    result.direction === "خنثی"
  ) {
    return null;
  }

  const entry = result.price;

  const atrValue =
    result.analysis1h?.atr ||
    entry * 0.01;

  const riskDistance =
    Math.max(
      atrValue * 1.5,
      entry * 0.003
    );

  let stop;
  let tp1;
  let tp2;
  let tp3;

  if (result.direction === "خرید") {
    stop = entry - riskDistance;
    tp1 = entry + riskDistance * 1.5;
    tp2 = entry + riskDistance * 2.5;
    tp3 = entry + riskDistance * 4;
  } else {
    stop = entry + riskDistance;
    tp1 = entry - riskDistance * 1.5;
    tp2 = entry - riskDistance * 2.5;
    tp3 = entry - riskDistance * 4;
  }

  const volatility =
    entry > 0
      ? atrValue / entry
      : 0.01;

  let leverage = 3;

  if (volatility < 0.005) {
    leverage = 5;
  } else if (volatility < 0.01) {
    leverage = 4;
  } else if (volatility > 0.025) {
    leverage = 2;
  }

  const riskAmount =
    PAPER_BUDGET * (RISK_PERCENT / 100);

  const stopPercent =
    Math.abs(entry - stop) / entry;

  const positionNotional =
    stopPercent > 0
      ? riskAmount / stopPercent
      : PAPER_BUDGET;

  const margin =
    positionNotional / leverage;

  return {
    symbol: result.symbol,
    direction: result.direction,
    entry,
    stop,
    tp1,
    tp2,
    tp3,
    leverage,
    riskAmount,
    positionNotional,
    margin,
    createdAt: Date.now()
  };
}

// ============================================================
// KV - Paper Trades
// ============================================================

async function savePaperTrade(trade, env) {
  if (!env.ALGO_ESMAIL_KV || !trade) return;

  const id =
    `trade:${trade.symbol}:${trade.createdAt}`;

  try {
    await env.ALGO_ESMAIL_KV.put(
      id,
      JSON.stringify({
        id,
        ...trade,
        status: "OPEN"
      })
    );
  } catch (error) {
    console.error(
      "KV save trade error",
      error
    );
  }
}

// ============================================================
// گزارش
// ============================================================

function directionEmoji(direction) {
  if (direction === "خرید") return "🟢";
  if (direction === "فروش") return "🔴";
  return "⚪";
}

function formatOpportunity(item, btcContext) {
  const trade = calculateTrade(item);

  if (!trade) return "";

  const patterns =
    item.analysis15?.patterns?.length
      ? item.analysis15.patterns.join("، ")
      : "الگوی خاصی دیده نشد";

  const funding =
    item.funding == null
      ? "نامشخص"
      : item.funding.toFixed(6);

  const ls =
    item.longShort == null
      ? "نامشخص"
      : item.longShort.toFixed(2);

  return `
${directionEmoji(item.direction)} *${item.symbol}*

📊 امتیاز: *${item.score}/100*
💰 قیمت: \`${formatNumber(item.price)}\`

📈 روند 4ساعته: ${item.analysis4h.structure}
📊 روند 1ساعته: ${item.analysis1h.structure}
📉 روند 15دقیقه: ${item.analysis15.structure}

RSI 1H: ${item.analysis1h.rsi.toFixed(1)}
حجم: ${item.analysis1h.volumeRatio.toFixed(2)} برابر میانگین

🕯 الگو:
${patterns}

🎯 ورود: \`${formatNumber(trade.entry)}\`
🛑 حد ضرر: \`${formatNumber(trade.stop)}\`
🥇 هدف 1: \`${formatNumber(trade.tp1)}\`
🥈 هدف 2: \`${formatNumber(trade.tp2)}\`
🥉 هدف 3: \`${formatNumber(trade.tp3)}\`

⚙️ اهرم پیشنهادی: *${trade.leverage}x*

💵 سرمایه آزمایشی: ${PAPER_BUDGET} USDT
💸 ریسک: ${RISK_PERCENT}%

💰 Funding: ${funding}
👥 نسبت لانگ/شورت: ${ls}

🧭 وضعیت BTC: ${btcContext.direction}
`;
}

function buildScanReport(
  results,
  btcContext,
  elapsedMs
) {
  const valid = results.filter(x => !x.failed);

  const opportunities = valid
    .filter(x =>
      x.direction !== "خنثی" &&
      x.score >= MIN_SIGNAL_SCORE
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const failed = results.filter(x => x.failed);

  let text = `
🤖 *ALGO ESMAIL V5*

✅ اسکن بازار توبیت تمام شد.

⏱ زمان اسکن: ${(elapsedMs / 1000).toFixed(1)} ثانیه

🔎 ارزهای بررسی‌شده: ${results.length}
✅ تحلیل موفق: ${valid.length}
❌ ناموفق: ${failed.length}

🧭 وضعیت کلی BTC: *${btcContext.direction}*

━━━━━━━━━━━━━━━━━━
`;

  if (!opportunities.length) {
    text += `
⚪ *در حال حاضر فرصت قدرتمند پیدا نشد.*

امتیاز حداقل سیگنال:
${MIN_SIGNAL_SCORE}/100

بازار فعلاً شرایط مناسبی برای ورود پرریسک نشان نمی‌دهد.
`;

    return text;
  }

  text += `
🔥 *فرصت‌های برتر*
`;

  for (const item of opportunities) {
    text += formatOpportunity(
      item,
      btcContext
    );
    text += "\n━━━━━━━━━━━━━━━━━━\n";
  }

  return text;
}

// ============================================================
// اجرای اسکن
// ============================================================

async function performScan(env) {
  const started = Date.now();

  console.log("================================");
  console.log("SCAN START");
  console.log("================================");

  try {
    const symbols = await getBestSymbols();

    console.log(
      "Selected symbols:",
      symbols.map(x => x.symbol)
    );

    if (!symbols.length) {
      throw new Error(
        "هیچ ارز مناسبی از Toobit دریافت نشد."
      );
    }

    // BTC و تحلیل ارزها همزمان شروع می‌شوند
    const btcPromise = getBTCContext();

    const results = await runInBatches(
      symbols,
      ANALYSIS_BATCH,
      analyzeSymbol
    );

    const btcContext = await btcPromise;

    console.log(
      "Technical analysis completed:",
      results.length
    );

    const enriched =
      await enrichDerivatives(results);

    const elapsed =
      Date.now() - started;

    console.log(
      "SCAN COMPLETE",
      `${elapsed}ms`
    );

    return {
      results: enriched,
      btcContext,
      elapsed
    };

  } catch (error) {
    console.error(
      "================================"
    );

    console.error(
      "SCAN ERROR:",
      error?.stack || error
    );

    console.error(
      "================================"
    );

    throw error;
  }
}

// ============================================================
// اشتراک
// ============================================================

async function subscribe(chatId, env) {
  if (!env.ALGO_ESMAIL_KV) {
    throw new Error("KV متصل نیست.");
  }

  await env.ALGO_ESMAIL_KV.put(
    `chat:${chatId}`,
    JSON.stringify({
      chatId,
      createdAt: Date.now()
    })
  );
}

async function unsubscribe(chatId, env) {
  if (!env.ALGO_ESMAIL_KV) {
    throw new Error("KV متصل نیست.");
  }

  await env.ALGO_ESMAIL_KV.delete(
    `chat:${chatId}`
  );
}

async function getSubscribedChats(env) {
  if (!env.ALGO_ESMAIL_KV) return [];

  const list =
    await env.ALGO_ESMAIL_KV.list({
      prefix: "chat:",
      limit: 100
    });

  return list.keys.map(x =>
    x.name.replace("chat:", "")
  );
}

// ============================================================
// STATS
// ============================================================

async function getStats(env) {
  if (!env.ALGO_ESMAIL_KV) {
    return "❌ KV متصل نیست.";
  }

  const list =
    await env.ALGO_ESMAIL_KV.list({
      prefix: "trade:",
      limit: 200
    });

  let total = 0;
  let open = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;

  for (const key of list.keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(key.name);

      if (!raw) continue;

      const trade = JSON.parse(raw);

      total++;

      if (trade.status === "OPEN") {
        open++;
      }

      if (trade.status === "WIN") {
        wins++;
      }

      if (trade.status === "LOSS") {
        losses++;
      }

      pnl += safeNumber(trade.pnl);
    } catch {}
  }

  const closed =
    wins + losses;

  const winRate =
    closed > 0
      ? (wins / closed) * 100
      : 0;

  return `
📊 *آمار معاملات آزمایشی*

کل معاملات: ${total}
باز: ${open}
برد: ${wins}
باخت: ${losses}

نرخ برد: *${winRate.toFixed(1)}%*

سود/زیان:
*${pnl.toFixed(2)} USDT*
`;
}

// ============================================================
// HELP
// ============================================================

function helpText() {
  return `
🤖 *ALGO ESMAIL V5*

دستورات:

/scan
🔎 اسکن سریع بازار توبیت

/signal BTC
📊 تحلیل بیت‌کوین

/subscribe
🔔 دریافت گزارش خودکار

/unsubscribe
🔕 توقف گزارش خودکار

/stats
📊 آمار معاملات آزمایشی

/health
🩺 بررسی وضعیت ربات

/help
📚 راهنما

⚠️ معاملات فعلاً *آزمایشی* هستند.
`;
}

// ============================================================
// SIGNAL
// ============================================================

async function singleSignal(symbolInput) {
  let symbol = symbolInput.toUpperCase();

  if (!symbol.includes("-")) {
    symbol = `${symbol}-SWAP-USDT`;
  }

  const result = await analyzeSymbol({
    symbol,
    price: 0,
    volume: 0,
    change: 0
  });

  if (result.failed) {
    throw new Error(
      result.error || "تحلیل انجام نشد."
    );
  }

  const btc =
    symbol === "BTC-SWAP-USDT"
      ? result
      : await getBTCContext();

  await enrichDerivatives([result]);

  return formatOpportunity(
    result,
    btc
  );
}

// ============================================================
// HEALTH
// ============================================================

async function healthText(env) {
  let kvStatus = "❌";

  if (env.ALGO_ESMAIL_KV) {
    try {
      await env.ALGO_ESMAIL_KV.put(
        "health:last",
        String(Date.now()),
        {
          expirationTtl: 300
        }
      );

      kvStatus = "✅";
    } catch {
      kvStatus = "❌";
    }
  }

  const botStatus =
    env.BOT_TOKEN
      ? "✅"
      : "❌";

  let toobitStatus = "❌";

  try {
    const response =
      await fetch(
        `${BASE_URL}/api/v1/exchangeInfo`,
        {
          method: "GET"
        }
      );

    if (response.ok) {
      toobitStatus = "✅";
    }
  } catch {}

  return `
🩺 *وضعیت ALGO ESMAIL*

🤖 Telegram Bot Token: ${botStatus}
💾 Cloudflare KV: ${kvStatus}
📡 Toobit API: ${toobitStatus}

⚙️ نسخه: V5
🔎 تعداد اسکن: ${MAX_ANALYSIS_SYMBOLS} ارز
📊 حداقل امتیاز: ${MIN_SIGNAL_SCORE}
💰 معاملات واقعی: ❌ خاموش
`;
}

// ============================================================
// پردازش پیام تلگرام
// ============================================================

async function processUpdate(update, env, ctx) {
  try {
    if (!update?.message) return;

    const message = update.message;
    const chatId = message.chat?.id;

    if (!chatId) return;

    const text =
      String(message.text || "").trim();

    if (!text) return;

    const command =
      text.split(/\s+/)[0].toLowerCase();

    // ------------------------------------------
    // HELP
    // ------------------------------------------

    if (
      command === "/start" ||
      command === "/help"
    ) {
      await sendMessage(
        chatId,
        helpText(),
        env,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ------------------------------------------
    // HEALTH
    // ------------------------------------------

    if (command === "/health") {
      const text =
        await healthText(env);

      await sendMessage(
        chatId,
        text,
        env,
        { parse_mode: "Markdown" }
      );

      return;
    }

    // ------------------------------------------
    // SUBSCRIBE
    // ------------------------------------------

    if (command === "/subscribe") {
      await subscribe(chatId, env);

      await sendMessage(
        chatId,
        "🔔 اشتراک گزارش‌های خودکار فعال شد.",
        env
      );

      return;
    }

    // ------------------------------------------
    // UNSUBSCRIBE
    // ------------------------------------------

    if (command === "/unsubscribe") {
      await unsubscribe(chatId, env);

      await sendMessage(
        chatId,
        "🔕 اشتراک گزارش‌های خودکار غیرفعال شد.",
        env
      );

      return;
    }

    // ------------------------------------------
    // STATS
    // ------------------------------------------

    if (command === "/stats") {
      const text =
        await getStats(env);

      await sendMessage(
        chatId,
        text,
        env,
        { parse_mode: "Markdown" }
      );

      return;
    }

    // ------------------------------------------
    // SIGNAL
    // ------------------------------------------

    if (command === "/signal") {
      const parts =
        text.split(/\s+/);

      const input =
        parts[1] || "BTC";

      await sendMessage(
        chatId,
        `📊 در حال تحلیل ${input.toUpperCase()}...`,
        env
      );

      try {
        const result =
          await singleSignal(input);

        await sendMessage(
          chatId,
          result || "سیگنال مناسبی پیدا نشد.",
          env,
          { parse_mode: "Markdown" }
        );

      } catch (error) {
        console.error(
          "SIGNAL ERROR:",
          error?.stack || error
        );

        await sendMessage(
          chatId,
          `❌ تحلیل انجام نشد.\n\nخطا:\n${error.message}`,
          env
        );
      }

      return;
    }

    // ------------------------------------------
    // SCAN
    // ------------------------------------------

    if (command === "/scan") {

      // بسیار مهم:
      // پیام اولیه بلافاصله ارسال می‌شود
      await sendMessage(
        chatId,
        "🔎 *در حال بررسی بازار توبیت...*\n\n⏳ لطفاً چند لحظه صبر کنید.\n\nنتیجه پس از پایان اسکن ارسال می‌شود.",
        env,
        { parse_mode: "Markdown" }
      );

      // عملیات سنگین را به پس‌زمینه می‌فرستیم
      ctx.waitUntil(
        (async () => {
          try {
            console.log(
              "BACKGROUND SCAN START",
              chatId
            );

            const scan =
              await performScan(env);

            const report =
              buildScanReport(
                scan.results,
                scan.btcContext,
                scan.elapsed
              );

            await sendMessage(
              chatId,
              report,
              env,
              { parse_mode: "Markdown" }
            );

            console.log(
              "BACKGROUND SCAN REPORT SENT",
              chatId
            );

          } catch (error) {

            console.error(
              "BACKGROUND SCAN FAILED:",
              error?.stack || error
            );

            // این قسمت مهم است:
            // حتی اگر اسکن شکست بخورد،
            // کاربر پیام خطا می‌گیرد.
            try {
              await sendMessage(
                chatId,
                `❌ *اسکن بازار متوقف شد.*\n\nدلیل:\n\`${String(error?.message || error).slice(0, 700)}\`\n\nلطفاً دستور /health را هم بزن تا وضعیت Worker را بررسی کنیم.`,
                env,
                { parse_mode: "Markdown" }
              );
            } catch (telegramError) {
              console.error(
                "ERROR MESSAGE SEND FAILED:",
                telegramError?.stack || telegramError
              );
            }
          }
        })()
      );

      return;
    }

  } catch (error) {
    console.error(
      "PROCESS UPDATE ERROR:",
      error?.stack || error
    );

    try {
      if (update?.message?.chat?.id) {
        await sendMessage(
          update.message.chat.id,
          `❌ خطایی در پردازش درخواست رخ داد.\n\n${String(error.message || error).slice(0, 700)}`,
          env
        );
      }
    } catch (sendError) {
      console.error(
        "FINAL ERROR SEND FAILED:",
        sendError?.stack || sendError
      );
    }
  }
}

// ============================================================
// Scheduled
// ============================================================

async function scheduledHandler(env) {
  console.log("SCHEDULED SCAN START");

  try {
    const chats =
      await getSubscribedChats(env);

    if (!chats.length) {
      console.log(
        "No subscribed chats."
      );
      return;
    }

    const scan =
      await performScan(env);

    const report =
      buildScanReport(
        scan.results,
        scan.btcContext,
        scan.elapsed
      );

    for (const chatId of chats) {
      try {
        await sendMessage(
          chatId,
          report,
          env,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.error(
          "Scheduled Telegram error:",
          chatId,
          error?.stack || error
        );
      }

      // جلوگیری از فشار به Telegram
      await sleep(100);
    }

    console.log(
      "SCHEDULED SCAN COMPLETE"
    );

  } catch (error) {
    console.error(
      "SCHEDULED SCAN ERROR:",
      error?.stack || error
    );
  }
}

// ============================================================
// CLOUDFLARE WORKER
// ============================================================

export default {

  async fetch(request, env, ctx) {

    const url =
      new URL(request.url);

    // ------------------------------------------
    // GET
    // ------------------------------------------

    if (request.method === "GET") {

      return new Response(
        "ALGO ESMAIL V5 is LIVE 🤖",
        {
          status: 200,
          headers: {
            "content-type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    // ------------------------------------------
    // POST Telegram Webhook
    // ------------------------------------------

    if (request.method === "POST") {

      try {

        const update =
          await request.json();

        // بسیار مهم:
        // دیگر منتظر پردازش نمی‌مانیم.
        ctx.waitUntil(
          processUpdate(
            update,
            env,
            ctx
          )
        );

        // Telegram بلافاصله 200 می‌گیرد
        return new Response(
          "OK",
          {
            status: 200
          }
        );

      } catch (error) {

        console.error(
          "WEBHOOK ERROR:",
          error?.stack || error
        );

        return new Response(
          "Bad Request",
          {
            status: 400
          }
        );
      }
    }

    return new Response(
      "Method Not Allowed",
      {
        status: 405
      }
    );
  },

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      scheduledHandler(env)
    );
  }
};
