// ============================================================
// ALGO FJM V5.3 - Toobit Futures Analyzer
// Cloudflare Workers + Telegram
// ============================================================

const BASE_URL = "https://api.toobit.com";

const TIMEOUT_MS = 6000;

// ============================================================
// تنظیمات اسکن
// ============================================================

const MAX_ANALYSIS_SYMBOLS = 8;
const ANALYSIS_BATCH = 4;
const SHORTLIST_FOR_DERIVATIVES = 3;

const MIN_SIGNAL_SCORE = 72;

// ALGO FJM V5.3 - Futures-first configuration
// Entry logic uses 5m + 15m for execution and 1h + 4h for context.
const FUTURES_TAKER_FEE = 0.0006;
const FUTURES_MAKER_FEE = 0.0002;
const PAPER_ENTRY_FEE = FUTURES_TAKER_FEE;
const PAPER_EXIT_FEE = FUTURES_TAKER_FEE;
const FUNDING_INTERVAL_HOURS = 8;
const MIN_LOWER_TF_ALIGNMENT = 1;

// ============================================================
// معاملات کاغذی
// ============================================================

const PAPER_BUDGET = 100;
const RISK_PERCENT = 1;

// حداکثر عمر معامله باز
const MAX_OPEN_TRADE_AGE_HOURS = 48;

// تعداد کندل‌های 15 دقیقه‌ای برای بررسی معاملات
const PAPER_CHECK_CANDLES = 200;

// ============================================================
// تاریخچه تشخیصی
// ============================================================

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;

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

  if (!values.length) {
    return 0;
  }

  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatNumber(value, digits = 6) {
  const n = safeNumber(value);

  if (!n) {
    return "0";
  }

  if (Math.abs(n) >= 1000) {
    return n.toFixed(2);
  }

  if (Math.abs(n) >= 1) {
    return n.toFixed(4);
  }

  if (Math.abs(n) >= 0.01) {
    return n.toFixed(5);
  }

  return n.toFixed(digits);
}

function percent(value, digits = 2) {
  return `${safeNumber(value).toFixed(digits)}%`;
}

function formatDate(timestamp) {
  const t = safeNumber(timestamp);

  if (!t) {
    return "نامشخص";
  }

  try {
    return new Date(t).toLocaleString("fa-IR", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return new Date(t).toISOString();
  }
}

function formatDuration(start, end) {
  const s = safeNumber(start);
  const e = safeNumber(end);

  if (!s || !e || e < s) {
    return "نامشخص";
  }

  const minutes = Math.floor((e - s) / 60000);

  if (minutes < 60) {
    return `${minutes} دقیقه`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours < 24) {
    return `${hours} ساعت و ${mins} دقیقه`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  return `${days} روز و ${remainingHours} ساعت`;
}

// ============================================================
// HTTP
// ============================================================

async function fetchJson(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

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
      throw new Error(
        `HTTP ${response.status}: ${text.slice(0, 300)}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response: ${text.slice(0, 300)}`
      );
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

  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}: ${text}`
    );
  }

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      `Telegram پاسخ نامعتبر داد: ${text}`
    );
  }

  if (!result.ok) {
    throw new Error(
      `Telegram error: ${text}`
    );
  }

  return result;
}

async function sendMessage(
  chatId,
  text,
  env,
  options = {}
) {
  return telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...options
    },
    env
  );
}

// ============================================================
// ارسال پیام‌های طولانی تلگرام
// ============================================================
// برای /history 20 و تاریخچه‌های طولانی
// ============================================================

async function sendLongMessage(
  chatId,
  text,
  env,
  options = {}
) {
  if (!text) {
    return;
  }

  // کمی پایین‌تر از محدودیت تلگرام نگه می‌داریم
  const MAX_LENGTH = 3800;

  if (text.length <= MAX_LENGTH) {
    return sendMessage(
      chatId,
      text,
      env,
      options
    );
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf(
      "\n━━━━━━━━━━━━━━━━━━",
      MAX_LENGTH
    );

    if (splitAt < 1000) {
      splitAt = remaining.lastIndexOf(
        "\n",
        MAX_LENGTH
      );
    }

    if (splitAt < 1) {
      splitAt = MAX_LENGTH;
    }

    const chunk = remaining
      .slice(0, splitAt)
      .trim();

    if (chunk) {
      chunks.push(chunk);
    }

    remaining = remaining
      .slice(splitAt)
      .trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];

    if (chunks.length > 1) {
      chunk =
        `📚 بخش ${i + 1} از ${chunks.length}\n\n` +
        chunk;
    }

    await sendMessage(
      chatId,
      chunk,
      env,
      options
    );

    if (i < chunks.length - 1) {
      await sleep(100);
    }
  }
}

// ============================================================
// TOOBIT - SYMBOLS
// ============================================================

async function getExchangeInfo() {
  return fetchJson(
    `${BASE_URL}/api/v1/exchangeInfo`
  );
}

function extractContracts(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data.contracts)) {
    return data.contracts;
  }

  if (Array.isArray(data.data?.contracts)) {
    return data.data.contracts;
  }

  return [];
}

function isValidContract(contract) {
  const symbol = contract?.symbol || "";

  if (!symbol) {
    return false;
  }

  const status = String(
    contract.status || ""
  ).toUpperCase();

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

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.tickers)) {
    return data.tickers;
  }

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
  const [
    exchangeInfo,
    tickers
  ] = await Promise.all([
    getExchangeInfo(),
    getAllTickers()
  ]);

  const contracts =
    extractContracts(exchangeInfo);

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
      if (!x.symbol || !x.price) {
        return false;
      }

      if (
        allowed.size &&
        !allowed.has(x.symbol)
      ) {
        return false;
      }

      return (
        x.symbol.endsWith("-SWAP-USDT") ||
        x.symbol.endsWith("-USDT")
      );
    });

  candidates.sort(
    (a, b) => b.volume - a.volume
  );

  const btc = candidates.find(
    x => x.symbol === "BTC-SWAP-USDT"
  );

  const selected = [];

  if (btc) {
    selected.push(btc);
  }

  for (const item of candidates) {
    if (
      selected.some(
        x => x.symbol === item.symbol
      )
    ) {
      continue;
    }

    selected.push(item);

    if (
      selected.length >=
      MAX_ANALYSIS_SYMBOLS
    ) {
      break;
    }
  }

  return selected;
}

// ============================================================
// KLINES
// ============================================================

async function getKlines(
  symbol,
  interval,
  limit = 150,
  startTime = null,
  endTime = null
) {
  // Toobit may return only the latest candle when neither startTime nor
  // endTime is supplied. Always request an explicit historical window so
  // EMA200 and the other indicators receive the full candle history.
  const intervalMsMap = {
    "1m": 60 * 1000,
    "3m": 3 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "2h": 2 * 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  };

  const candleMs = intervalMsMap[interval] || 60 * 1000;
  const now = Date.now();
  const effectiveEnd = endTime != null ? safeNumber(endTime) : now;
  const effectiveStart =
    startTime != null
      ? safeNumber(startTime)
      : effectiveEnd - candleMs * Math.max(limit + 5, 210);

  let url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&startTime=${effectiveStart}` +
    `&endTime=${effectiveEnd}` +
    `&limit=${Math.min(Math.max(limit, 1), 1000)}`;

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
        time: safeNumber(
          row.time ??
          row.openTime
        ),
        open: safeNumber(row.open),
        high: safeNumber(row.high),
        low: safeNumber(row.low),
        close: safeNumber(row.close),
        volume: safeNumber(row.volume)
      };
    })
    .filter(x =>
      x.time > 0 &&
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
  if (!values.length) {
    return [];
  }

  const result =
    new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  const multiplier =
    2 / (period + 1);

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  result[period - 1] =
    sum / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result[i] =
      (values[i] - result[i - 1]) *
      multiplier +
      result[i - 1];
  }

  return result;
}

function rsi(values, period = 14) {
  const result =
    new Array(values.length).fill(null);

  if (values.length <= period) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs =
      avgGain / avgLoss;

    result[period] =
      100 - 100 / (1 + rs);
  }

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0
        ? Math.abs(diff)
        : 0;

    avgGain =
      (
        avgGain * (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs =
        avgGain / avgLoss;

      result[i] =
        100 - 100 / (1 + rs);
    }
  }

  return result;
}

function atr(candles, period = 14) {
  const result =
    new Array(candles.length).fill(null);

  if (candles.length <= period) {
    return result;
  }

  const tr =
    new Array(candles.length).fill(0);

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const high =
      candles[i].high;

    const low =
      candles[i].low;

    const prevClose =
      candles[i - 1].close;

    tr[i] =
      Math.max(
        high - low,
        Math.abs(
          high - prevClose
        ),
        Math.abs(
          low - prevClose
        )
      );
  }

  let initial = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    initial += tr[i];
  }

  result[period] =
    initial / period;

  for (
    let i = period + 1;
    i < candles.length;
    i++
  ) {
    result[i] =
      (
        result[i - 1] *
        (period - 1) +
        tr[i]
      ) / period;
  }

  return result;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line =
    new Array(values.length).fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      fast[i] != null &&
      slow[i] != null
    ) {
      line[i] =
        fast[i] - slow[i];
    }
  }

  const valid =
    line.filter(x => x != null);

  const signalValid =
    ema(valid, 9);

  const signal =
    new Array(values.length).fill(null);

  let j = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (line[i] != null) {
      signal[i] =
        signalValid[j];
      j++;
    }
  }

  const histogram =
    new Array(values.length).fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      line[i] != null &&
      signal[i] != null
    ) {
      histogram[i] =
        line[i] - signal[i];
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
  if (candles.length < 3) {
    return [];
  }

  const b =
    candles[candles.length - 3];

  const c =
    candles[candles.length - 2];

  const patterns = [];

  const body =
    Math.abs(
      c.close - c.open
    );

  const range =
    c.high - c.low;

  if (
    range > 0 &&
    body / range < 0.1
  ) {
    patterns.push("دوجی");
  }

  const upper =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lower =
    Math.min(
      c.open,
      c.close
    ) - c.low;

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

  if (
    b.close < b.open &&
    c.close > c.open &&
    c.open <= b.close &&
    c.close >= b.open
  ) {
    patterns.push("پوشای صعودی");
  }

  if (
    b.close > b.open &&
    c.close < c.open &&
    c.open >= b.close &&
    c.close <= b.open
  ) {
    patterns.push("پوشای نزولی");
  }

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
  if (candles.length < 20) {
    return "نامشخص";
  }

  const recent =
    candles.slice(-20);

  const highs =
    recent.map(x => x.high);

  const lows =
    recent.map(x => x.low);

  const mid = 10;

  const firstHigh =
    Math.max(
      ...highs.slice(0, mid)
    );

  const secondHigh =
    Math.max(
      ...highs.slice(mid)
    );

  const firstLow =
    Math.min(
      ...lows.slice(0, mid)
    );

  const secondLow =
    Math.min(
      ...lows.slice(mid)
    );

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

  const recent =
    candles.slice(-40);

  return {
    support:
      Math.min(
        ...recent.map(x => x.low)
      ),

    resistance:
      Math.max(
        ...recent.map(x => x.high)
      )
  };
}

// ============================================================
// تحلیل تایم‌فریم
// ============================================================

function analyzeTimeframe(candles) {
  if (
    !candles ||
    candles.length < 60
  ) {
    throw new Error(
      "داده کافی برای تحلیل وجود ندارد."
    );
  }

  const closes =
    candles.map(x => x.close);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const ema200 =
    ema(closes, 200);

  const rsiValues =
    rsi(closes, 14);

  const atrValues =
    atr(candles, 14);

  const macdData =
    macd(closes);

  // Ignore the currently forming candle to reduce repainting.
  const i =
    candles.length - 2;

  const price =
    closes[i];

  const e20 =
    ema20[i];

  const e50 =
    ema50[i];

  const e200 =
    ema200[i] ?? null;

  if (e200 == null) {
    throw new Error("EMA200 داده کافی ندارد.");
  }

  const rsiValue =
    rsiValues[i];

  const atrValue =
    atrValues[i];

  const macdLine =
    macdData.line[i];

  const macdSignal =
    macdData.signal[i];

  const macdHistogram =
    macdData.histogram[i];

  const structure =
    marketStructure(candles);

  const sr =
    supportResistance(candles);

  const recentVolumes =
    candles
      .slice(-21, -1)
      .map(x => x.volume);

  const avgVolume =
    average(recentVolumes);

  const currentVolume =
    candles[i].volume;

  const volumeRatio =
    avgVolume > 0
      ? currentVolume / avgVolume
      : 1;

  let bull = 0;
  let bear = 0;

  // EMA
  if (e20 > e50) {
    bull += 15;
  } else if (e20 < e50) {
    bear += 15;
  }

  // قیمت نسبت به EMA20
  if (price > e20) {
    bull += 8;
  } else {
    bear += 8;
  }

  // EMA200
  if (price > e200) {
    bull += 8;
  } else {
    bear += 8;
  }

  // RSI
  if (
    rsiValue >= 52 &&
    rsiValue <= 70
  ) {
    bull += 12;
  }

  if (
    rsiValue <= 48 &&
    rsiValue >= 30
  ) {
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
  if (structure === "صعودی") {
    bull += 12;
  }

  if (structure === "نزولی") {
    bear += 12;
  }

  // حجم
  if (volumeRatio >= 1.3) {
    if (price > e20) {
      bull += 6;
    } else {
      bear += 6;
    }
  }

  const resistanceDistance =
    sr.resistance > 0
      ? (
          (sr.resistance - price) /
          price
        ) * 100
      : 999;

  const supportDistance =
    sr.support > 0
      ? (
          (price - sr.support) /
          price
        ) * 100
      : 999;

  const patterns =
    candlePatterns(candles);

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
// ترکیب تایم‌فریم‌ها
// ============================================================

function combineAnalysis(
  a5m,
  a15,
  a1h,
  a4h
) {
  // Futures-first weighting: higher timeframes define context,
  // but 5m/15m have the greatest influence on the actual entry.
  let bull = 0;
  let bear = 0;

  bull += a4h.bull * 0.20;
  bear += a4h.bear * 0.20;

  bull += a1h.bull * 0.30;
  bear += a1h.bear * 0.30;

  bull += a15.bull * 0.30;
  bear += a15.bear * 0.30;

  bull += a5m.bull * 0.20;
  bear += a5m.bear * 0.20;

  const total = bull + bear;
  const edge = Math.abs(bull - bear);

  let direction = "خنثی";
  if (bull > bear && edge >= 10) direction = "خرید";
  if (bear > bull && edge >= 10) direction = "فروش";

  // Calibrated-style confidence: the score is no longer a raw dominance ratio.
  // It rewards directional edge, while reserving room for quality filters.
  const edgeScore = total > 0 ? clamp(edge / total, 0, 1) * 35 : 0;
  const directionScore = direction === "خنثی" ? 0 : 15;
  const score = Math.round(clamp(50 + edgeScore + directionScore, 0, 95));

  return {
    direction,
    score,
    bull,
    bear
  };
}

// ============================================================
// مشتقات
// ============================================================

async function getFunding(symbol) {
  try {
    const data =
      await fetchJson(
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
    console.error(
      "Funding error",
      symbol,
      error
    );

    return null;
  }
}

async function getOpenInterest(symbol) {
  try {
    const data =
      await fetchJson(
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
    console.error(
      "OI error",
      symbol,
      error
    );

    return null;
  }
}

async function getLongShort(symbol) {
  try {
    const data =
      await fetchJson(
        `${BASE_URL}/api/v1/futures/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`
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
    console.error(
      "LongShort error",
      symbol,
      error
    );

    return null;
  }
}

// ============================================================
// BTC
// ============================================================

async function getBTCContext() {
  try {
    const [
      h1,
      h4
    ] = await Promise.all([
      getKlines(
        "BTC-SWAP-USDT",
        "1h",
        260
      ),
      getKlines(
        "BTC-SWAP-USDT",
        "4h",
        260
      )
    ]);

    const a1 =
      analyzeTimeframe(h1);

    const a4 =
      analyzeTimeframe(h4);

    const bull = a4.bull * 0.45 + a1.bull * 0.55;
    const bear = a4.bear * 0.45 + a1.bear * 0.55;
    const edge = Math.abs(bull - bear);
    const direction = edge >= 10 ? (bull > bear ? "خرید" : "فروش") : "خنثی";
    const total = bull + bear;
    const score = Math.round(clamp(50 + (total ? edge / total * 35 : 0) + (direction === "خنثی" ? 0 : 15), 0, 95));
    return { direction, score, bull, bear };
  } catch (error) {
    console.error(
      "BTC context error",
      error
    );

    return {
      direction: "خنثی",
      score: 0,
      bull: 0,
      bear: 0
    };
  }
}

// ============================================================
// تحلیل ارز
// ============================================================

async function analyzeSymbol(item) {
  const symbol =
    item.symbol;

  try {
    const results =
      await Promise.allSettled([
        getKlines(
          symbol,
          "5m",
          260
        ),

        getKlines(
          symbol,
          "15m",
          260
        ),

        getKlines(
          symbol,
          "1h",
          260
        ),

        getKlines(
          symbol,
          "4h",
          260
        )
      ]);

    const timeframeNames = ["5m", "15m", "1h", "4h"];
    const failedFrames = results
      .map((result, index) => {
        if (result.status === "fulfilled") {
          return null;
        }

        const reason = result.reason;
        const message =
          reason?.message ||
          String(reason || "خطای نامشخص");

        return `${timeframeNames[index]}: ${message}`;
      })
      .filter(Boolean);

    if (failedFrames.length) {
      throw new Error(
        failedFrames.join(" | ")
      );
    }

    const candles5m =
      results[0].value;

    const candles15 =
      results[1].value;

    const candles1h =
      results[2].value;

    const candles4h =
      results[3].value;

    const a5m =
      analyzeTimeframe(
        candles5m
      );

    const a15 =
      analyzeTimeframe(
        candles15
      );

    const a1h =
      analyzeTimeframe(
        candles1h
      );

    const a4h =
      analyzeTimeframe(
        candles4h
      );

    const combined =
      combineAnalysis(
        a5m,
        a15,
        a1h,
        a4h
      );

    // Execution confirmation: the lower timeframe must agree with the signal.
    const lowerBull =
      (a5m.bull > a5m.bear ? 1 : 0) +
      (a15.bull > a15.bear ? 1 : 0);
    const lowerBear =
      (a5m.bear > a5m.bull ? 1 : 0) +
      (a15.bear > a15.bull ? 1 : 0);

    if (combined.direction === "خرید" && lowerBull < MIN_LOWER_TF_ALIGNMENT) {
      combined.direction = "خنثی";
    }
    if (combined.direction === "فروش" && lowerBear < MIN_LOWER_TF_ALIGNMENT) {
      combined.direction = "خنثی";
    }

    return {
      ...item,
      symbol,
      // Use the latest ticker-derived price when available, not an older candle close.
      price: safeNumber(item.price) || a5m.price,
      analysis5m: a5m,
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
// مشتقات برای برترین‌ها
// ============================================================

async function enrichDerivatives(results) {
  const top =
    results
      .filter(
        x =>
          !x.failed &&
          x.direction !== "خنثی"
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(
        0,
        SHORTLIST_FOR_DERIVATIVES
      );

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

      item.funding =
        funding;

      item.openInterest =
        openInterest;

      item.longShort =
        longShort;

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

      item.score =
        clamp(
          Math.round(item.score),
          0,
          100
        );
    })
  );

  return results;
}

// ============================================================
// Batch
// ============================================================

async function runInBatches(
  items,
  batchSize,
  worker
) {
  const output = [];

  for (
    let i = 0;
    i < items.length;
    i += batchSize
  ) {
    const batch =
      items.slice(
        i,
        i + batchSize
      );

    const results =
      await Promise.all(
        batch.map(
          item => worker(item)
        )
      );

    output.push(...results);
  }

  return output;
}

// ============================================================
// PAPER TRADE - محاسبه
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
  const atr5m = result.analysis5m?.atr || entry * 0.002;
  const atr15m = result.analysis15?.atr || entry * 0.003;
  const atrValue = Math.max(atr5m * 1.8, atr15m * 0.8, entry * 0.0015);
  const riskDistance = Math.max(atrValue, entry * 0.002);

  let stop, tp1, tp2, tp3;

  if (result.direction === "خرید") {
    stop = entry - riskDistance;
    tp1 = entry + riskDistance * 1.8;
    tp2 = entry + riskDistance * 2.8;
    tp3 = entry + riskDistance * 4.0;
  } else {
    stop = entry + riskDistance;
    tp1 = entry - riskDistance * 1.8;
    tp2 = entry - riskDistance * 2.8;
    tp3 = entry - riskDistance * 4.0;
  }

  const volatility = entry > 0 ? atr15m / entry : 0.01;
  let leverage = 3;
  if (volatility < 0.004) leverage = 5;
  else if (volatility < 0.008) leverage = 4;
  else if (volatility > 0.02) leverage = 2;

  const riskAmount = PAPER_BUDGET * (RISK_PERCENT / 100);
  const stopPercent = Math.abs(entry - stop) / entry;
  const positionNotional = stopPercent > 0 ? riskAmount / stopPercent : PAPER_BUDGET;
  const margin = positionNotional / leverage;

  const priceMoveToTP1 = Math.abs(tp1 - entry) / entry;
  const grossTp1Pnl = priceMoveToTP1 * positionNotional;
  const entryFee = positionNotional * PAPER_ENTRY_FEE;
  const exitFee = (positionNotional * (tp1 / entry)) * PAPER_EXIT_FEE;
  const roundTripFee = entryFee + exitFee;
  const feeBreakEvenMove = roundTripFee / positionNotional;

  return {
    symbol: result.symbol,
    direction: result.direction,
    entry, stop, tp1, tp2, tp3, leverage,
    riskAmount, positionNotional, margin,
    score: result.score,
    rsi1h: safeNumber(result.analysis1h?.rsi),
    volumeRatio: safeNumber(result.analysis15?.volumeRatio),
    structure5m: result.analysis5m?.structure,
    structure15: result.analysis15?.structure,
    structure1h: result.analysis1h?.structure,
    structure4h: result.analysis4h?.structure,
    patterns5m: result.analysis5m?.patterns || [],
    patterns15: result.analysis15?.patterns || [],
    funding: result.funding ?? null,
    longShort: result.longShort ?? null,
    btcDirection: null,
    createdAt: Date.now(),
    priceMoveToTP1,
    grossTp1Pnl,
    entryFee,
    exitFee,
    roundTripFee,
    feeBreakEvenMove,
    feeBreakEvenPriceMovePercent: feeBreakEvenMove * 100,
    expectedTp1NetBeforeFunding: grossTp1Pnl - roundTripFee
  };
}

// ============================================================
// SNAPSHOT تشخیصی
// ============================================================

// این قسمت استراتژی را تغییر نمی‌دهد.
// فقط وضعیت اندیکاتورها در لحظه ورود را ذخیره می‌کند
// تا بعداً بفهمیم چرا معامله برده یا باخته.

// ============================================================

function createSignalSnapshot(
  result,
  btcContext
) {
  if (
    !result ||
    result.failed
  ) {
    return null;
  }

  const snapshot = {
    capturedAt:
      Date.now(),

    symbol:
      result.symbol,

    direction:
      result.direction,

    score:
      safeNumber(
        result.score
      ),

    combinedBull:
      safeNumber(
        result.bull
      ),

    combinedBear:
      safeNumber(
        result.bear
      ),

    // ----------------------------
    // تایم‌فریم 5 دقیقه - نقطه ورود
    // ----------------------------

    timeframe5m: {
      price: safeNumber(result.analysis5m?.price),
      ema20: safeNumber(result.analysis5m?.ema20),
      ema50: safeNumber(result.analysis5m?.ema50),
      ema200: safeNumber(result.analysis5m?.ema200),
      rsi: safeNumber(result.analysis5m?.rsi),
      atr: safeNumber(result.analysis5m?.atr),
      macd: safeNumber(result.analysis5m?.macd),
      macdSignal: safeNumber(result.analysis5m?.macdSignal),
      macdHistogram: safeNumber(result.analysis5m?.macdHistogram),
      volumeRatio: safeNumber(result.analysis5m?.volumeRatio),
      structure: result.analysis5m?.structure ?? "نامشخص",
      support: safeNumber(result.analysis5m?.support),
      resistance: safeNumber(result.analysis5m?.resistance),
      supportDistance: safeNumber(result.analysis5m?.supportDistance),
      resistanceDistance: safeNumber(result.analysis5m?.resistanceDistance),
      patterns: result.analysis5m?.patterns || [],
      bull: safeNumber(result.analysis5m?.bull),
      bear: safeNumber(result.analysis5m?.bear)
    },

    // ----------------------------
    // تایم‌فریم 15 دقیقه
    // ----------------------------

    timeframe15: {
      price:
        safeNumber(
          result.analysis15?.price
        ),

      ema20:
        safeNumber(
          result.analysis15?.ema20
        ),

      ema50:
        safeNumber(
          result.analysis15?.ema50
        ),

      ema200:
        safeNumber(
          result.analysis15?.ema200
        ),

      rsi:
        safeNumber(
          result.analysis15?.rsi
        ),

      atr:
        safeNumber(
          result.analysis15?.atr
        ),

      macd:
        safeNumber(
          result.analysis15?.macd
        ),

      macdSignal:
        safeNumber(
          result.analysis15?.macdSignal
        ),

      macdHistogram:
        safeNumber(
          result.analysis15?.macdHistogram
        ),

      volumeRatio:
        safeNumber(
          result.analysis15?.volumeRatio
        ),

      structure:
        result.analysis15?.structure ??
        "نامشخص",

      support:
        safeNumber(
          result.analysis15?.support
        ),

      resistance:
        safeNumber(
          result.analysis15?.resistance
        ),

      supportDistance:
        safeNumber(
          result.analysis15?.supportDistance
        ),

      resistanceDistance:
        safeNumber(
          result.analysis15?.resistanceDistance
        ),

      patterns:
        result.analysis15?.patterns ||
        [],

      bull:
        safeNumber(
          result.analysis15?.bull
        ),

      bear:
        safeNumber(
          result.analysis15?.bear
        )
    },

    // ----------------------------
    // تایم‌فریم 1 ساعت
    // ----------------------------

    timeframe1h: {
      price:
        safeNumber(
          result.analysis1h?.price
        ),

      ema20:
        safeNumber(
          result.analysis1h?.ema20
        ),

      ema50:
        safeNumber(
          result.analysis1h?.ema50
        ),

      ema200:
        safeNumber(
          result.analysis1h?.ema200
        ),

      rsi:
        safeNumber(
          result.analysis1h?.rsi
        ),

      atr:
        safeNumber(
          result.analysis1h?.atr
        ),

      macd:
        safeNumber(
          result.analysis1h?.macd
        ),

      macdSignal:
        safeNumber(
          result.analysis1h?.macdSignal
        ),

      macdHistogram:
        safeNumber(
          result.analysis1h?.macdHistogram
        ),

      volumeRatio:
        safeNumber(
          result.analysis1h?.volumeRatio
        ),

      structure:
        result.analysis1h?.structure ??
        "نامشخص",

      support:
        safeNumber(
          result.analysis1h?.support
        ),

      resistance:
        safeNumber(
          result.analysis1h?.resistance
        ),

      supportDistance:
        safeNumber(
          result.analysis1h?.supportDistance
        ),

      resistanceDistance:
        safeNumber(
          result.analysis1h?.resistanceDistance
        ),

      patterns:
        result.analysis1h?.patterns ||
        [],

      bull:
        safeNumber(
          result.analysis1h?.bull
        ),

      bear:
        safeNumber(
          result.analysis1h?.bear
        )
    },

    // ----------------------------
    // تایم‌فریم 4 ساعت
    // ----------------------------

    timeframe4h: {
      price:
        safeNumber(
          result.analysis4h?.price
        ),

      ema20:
        safeNumber(
          result.analysis4h?.ema20
        ),

      ema50:
        safeNumber(
          result.analysis4h?.ema50
        ),

      ema200:
        safeNumber(
          result.analysis4h?.ema200
        ),

      rsi:
        safeNumber(
          result.analysis4h?.rsi
        ),

      atr:
        safeNumber(
          result.analysis4h?.atr
        ),

      macd:
        safeNumber(
          result.analysis4h?.macd
        ),

      macdSignal:
        safeNumber(
          result.analysis4h?.macdSignal
        ),

      macdHistogram:
        safeNumber(
          result.analysis4h?.macdHistogram
        ),

      volumeRatio:
        safeNumber(
          result.analysis4h?.volumeRatio
        ),

      structure:
        result.analysis4h?.structure ??
        "نامشخص",

      support:
        safeNumber(
          result.analysis4h?.support
        ),

      resistance:
        safeNumber(
          result.analysis4h?.resistance
        ),

      supportDistance:
        safeNumber(
          result.analysis4h?.supportDistance
        ),

      resistanceDistance:
        safeNumber(
          result.analysis4h?.resistanceDistance
        ),

      patterns:
        result.analysis4h?.patterns ||
        [],

      bull:
        safeNumber(
          result.analysis4h?.bull
        ),

      bear:
        safeNumber(
          result.analysis4h?.bear
        )
    },

    // ----------------------------
    // مشتقات
    // ----------------------------

    derivatives: {
      funding:
        result.funding ?? null,

      openInterest:
        result.openInterest ?? null,

      longShort:
        result.longShort ?? null
    },

    // ----------------------------
    // وضعیت BTC
    // ----------------------------

    btc: {
      direction:
        btcContext?.direction ??
        "خنثی",

      score:
        safeNumber(
          btcContext?.score
        ),

      bull:
        safeNumber(
          btcContext?.bull
        ),

      bear:
        safeNumber(
          btcContext?.bear
        )
    }
  };

  return snapshot;
}

// ============================================================
// KV HELPERS
// ============================================================

async function listAllKeys(
  env,
  prefix
) {
  if (!env.ALGO_ESMAIL_KV) {
    return [];
  }

  const keys = [];
  let cursor = undefined;

  for (
    let page = 0;
    page < 10;
    page++
  ) {
    const options = {
      prefix,
      limit: 1000
    };

    if (cursor) {
      options.cursor = cursor;
    }

    const result =
      await env.ALGO_ESMAIL_KV.list(
        options
      );

    keys.push(
      ...result.keys
    );

    if (!result.list_complete) {
      cursor =
        result.cursor;

      if (!cursor) {
        break;
      }
    } else {
      break;
    }
  }

  return keys;
}

// ============================================================
// بررسی معامله باز برای یک ارز
// ============================================================

async function hasOpenTrade(
  symbol,
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return false;
  }

  const keys =
    await env.ALGO_ESMAIL_KV.list({
      prefix:
        `trade:${symbol}:`,
      limit: 50
    });

  for (const key of keys.keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(
          key.name
        );

      if (!raw) {
        continue;
      }

      const trade =
        JSON.parse(raw);

      if (
        trade.status === "OPEN"
      ) {
        const ageHours =
          (
            Date.now() -
            safeNumber(
              trade.createdAt
            )
          ) / 3600000;

        if (
          ageHours <=
          MAX_OPEN_TRADE_AGE_HOURS
        ) {
          return true;
        }
      }
    } catch {}
  }

  return false;
}

// ============================================================
// ذخیره Paper Trade
// ============================================================

async function savePaperTrade(
  trade,
  env
) {
  if (
    !env.ALGO_ESMAIL_KV ||
    !trade
  ) {
    return false;
  }

  const id =
    `trade:${trade.symbol}:${trade.createdAt}`;

  try {
    await env.ALGO_ESMAIL_KV.put(
      id,
      JSON.stringify({
        id,
        ...trade,

        status:
          "OPEN",

        result:
          null,

        firstTarget:
          null,

        exitPrice:
          null,

        pnlUsdt:
          0,

        pnl:
          0,

        pnlPercent:
          0,

        closedAt:
          null,

        candleTime:
          null,

        updatedAt:
          Date.now()
      })
    );

    console.log(
      "PAPER TRADE SAVED:",
      id
    );

    return true;
  } catch (error) {
    console.error(
      "KV save trade error",
      error
    );

    return false;
  }
}

// ============================================================
// ثبت Paper Trades جدید
// ============================================================

async function recordPaperTrades(
  results,
  btcContext,
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return {
      saved: 0,
      skipped: 0
    };
  }

  const opportunities =
    results
      .filter(
        x =>
          !x.failed &&
          x.direction !== "خنثی" &&
          x.score >= MIN_SIGNAL_SCORE
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, 5);

  let saved = 0;
  let skipped = 0;

  for (const item of opportunities) {
    try {
      const exists =
        await hasOpenTrade(
          item.symbol,
          env
        );

      if (exists) {
        skipped++;
        continue;
      }

      const trade =
        calculateTrade(item);

      if (!trade) {
        continue;
      }

      trade.btcDirection =
        btcContext?.direction ??
        "خنثی";

      // Snapshot تشخیصی
      trade.signalSnapshot =
        createSignalSnapshot(
          item,
          btcContext
        );

      trade.createdAt =
        Date.now();

      const ok =
        await savePaperTrade(
          trade,
          env
        );

      if (ok) {
        saved++;
      }

      await sleep(50);
    } catch (error) {
      console.error(
        "RECORD PAPER ERROR:",
        item.symbol,
        error
      );
    }
  }

  return {
    saved,
    skipped
  };
}

// ============================================================
// بررسی نتیجه معاملات باز
// ============================================================

async function updateOpenPaperTrades(
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return {
      checked: 0,
      closed: 0,
      expired: 0,
      ambiguous: 0,
      closedTrades: []
    };
  }

  const keys =
    await listAllKeys(
      env,
      "trade:"
    );

  const openTrades = [];

  for (const key of keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(
          key.name
        );

      if (!raw) {
        continue;
      }

      const trade =
        JSON.parse(raw);

      if (
        trade.status === "OPEN"
      ) {
        openTrades.push(trade);
      }
    } catch {}
  }

  let checked = 0;
  let closed = 0;
  let expired = 0;
  let ambiguous = 0;

  const closedTrades = [];

  const batches = [];

  for (
    let i = 0;
    i < openTrades.length;
    i += 4
  ) {
    batches.push(
      openTrades.slice(
        i,
        i + 4
      )
    );
  }

  for (const batch of batches) {
    await Promise.all(
      batch.map(
        async trade => {
          checked++;

          try {
            const createdAt =
              safeNumber(
                trade.createdAt
              );

            if (!createdAt) {
              console.error(
                "INVALID TRADE CREATED AT:",
                trade.id
              );

              return;
            }

            const now =
              Date.now();

            const ageHours =
              (
                now -
                createdAt
              ) / 3600000;

            // ==================================================
            // انقضای معامله
            // ==================================================

            if (
              ageHours >
              MAX_OPEN_TRADE_AGE_HOURS
            ) {
              const updated = {
                ...trade,

                status:
                  "EXPIRED",

                result:
                  "EXPIRED",

                firstTarget:
                  "انقضای زمان",

                exitPrice:
                  null,

                pnlUsdt:
                  0,

                pnl:
                  0,

                pnlPercent:
                  0,

                closedAt:
                  now,

                updatedAt:
                  now
              };

              await env.ALGO_ESMAIL_KV.put(
                trade.id,
                JSON.stringify(
                  updated
                )
              );

              expired++;

              closedTrades.push(
                updated
              );

              console.log(
                "PAPER TRADE EXPIRED:",
                trade.symbol,
                trade.id
              );

              return;
            }

            // ==================================================
            // قیمت‌های معامله
            // ==================================================

            const entry =
              safeNumber(
                trade.entry
              );

            const stop =
              safeNumber(
                trade.stop
              );

            const tp1 =
              safeNumber(
                trade.tp1
              );

            if (
              !entry ||
              !stop ||
              !tp1
            ) {
              console.error(
                "INVALID PAPER TRADE LEVELS:",
                trade.id
              );

              return;
            }

            // ==================================================
            // پیدا کردن کندل ورود
            // ==================================================

            const intervalMs =
              15 * 60 * 1000;

            const entryCandleStart =
              Math.floor(
                createdAt /
                intervalMs
              ) * intervalMs;

            const candles =
              await getKlines(
                trade.symbol,
                "15m",
                PAPER_CHECK_CANDLES,
                entryCandleStart,
                now
              );

            if (!candles.length) {
              console.log(
                "NO CANDLES FOR TRADE:",
                trade.symbol
              );

              return;
            }

            const relevant =
              candles.filter(
                candle => {
                  const candleStart =
                    safeNumber(
                      candle.time
                    );

                  const candleEnd =
                    candleStart +
                    intervalMs;

                  return (
                    candleEnd >
                    createdAt
                  );
                }
              );

            if (!relevant.length) {
              console.log(
                "NO RELEVANT CANDLES:",
                trade.symbol,
                createdAt
              );

              return;
            }

            let result = null;

            // ==================================================
            // بررسی کندل‌ها
            // ==================================================

            for (
              const candle of relevant
            ) {
              const high =
                safeNumber(
                  candle.high
                );

              const low =
                safeNumber(
                  candle.low
                );

              // =================================================
              // خرید
              // =================================================

              if (
                trade.direction === "خرید"
              ) {
                const hitStop =
                  low <= stop;

                const hitTp =
                  high >= tp1;

                if (
                  hitStop &&
                  hitTp
                ) {
                  result = {
                    status:
                      "AMBIGUOUS",

                    firstTarget:
                      "نامشخص",

                    exitPrice:
                      null,

                    candleTime:
                      safeNumber(
                        candle.time
                      )
                  };

                  break;
                }

                if (hitStop) {
                  result = {
                    status:
                      "LOSS",

                    firstTarget:
                      "SL",

                    exitPrice:
                      stop,

                    candleTime:
                      safeNumber(
                        candle.time
                      )
                  };

                  break;
                }

                if (hitTp) {
                  result = {
                    status:
                      "WIN",

                    firstTarget:
                      "TP1",

                    exitPrice:
                      tp1,

                    candleTime:
                      safeNumber(
                        candle.time
                      )
                  };

                  break;
                }
              }

              // =================================================
              // فروش
              // =================================================

              if (
                trade.direction === "فروش"
              ) {
                const hitStop =
                  high >= stop;

                const hitTp =
                  low <= tp1;

                if (
                  hitStop &&
                  hitTp
                ) {
                  result = {
                    status:
                      "AMBIGUOUS",

                    firstTarget:
                      "نامشخص",

                    exitPrice:
                      null,

                    candleTime:
                      safeNumber(
                        candle.time
                      )
                  };

                  break;
                }

                if (hitStop) {
                  result = {
                    status:
                      "LOSS",

                    firstTarget:
                      "SL",

                    exitPrice:
                      stop,

                    candleTime:
                      safeNumber(
                        candle.time
                      )
                  };

                  break;
                }

                if (hitTp) {
                  result = {
                    status:
                      "WIN",

                    firstTarget:
                      "TP1",

                    exitPrice:
                      tp1,

                    candleTime:
                      safeNumber(
                        candle.time
                      )
                  };

                  break;
                }
              }
            }

            // ==================================================
            // هنوز باز است
            // ==================================================

            if (!result) {
              return;
            }

            // ==================================================
            // محاسبه سود / ضرر
            // ==================================================

            let pnlUsdt = 0;
            let priceMovePercent = 0;
            let grossPnl = 0;
            let totalFees = 0;
            let fundingPnl = 0;
            let marginReturnPercent = 0;

            if (
              result.status === "WIN" ||
              result.status === "LOSS"
            ) {
              const exitPrice = safeNumber(result.exitPrice);

              if (trade.direction === "خرید") {
                priceMovePercent = ((exitPrice - entry) / entry) * 100;
              } else {
                priceMovePercent = ((entry - exitPrice) / entry) * 100;
              }

              grossPnl = (priceMovePercent / 100) * safeNumber(trade.positionNotional);

              const exitNotional =
                safeNumber(trade.positionNotional) * (exitPrice / entry);
              const entryFee = safeNumber(trade.positionNotional) * PAPER_ENTRY_FEE;
              const exitFee = exitNotional * PAPER_EXIT_FEE;
              totalFees = entryFee + exitFee;

              const hoursHeld = Math.max(0, (now - createdAt) / 3600000);
              const fundingPeriods = Math.floor(hoursHeld / FUNDING_INTERVAL_HOURS);
              const rate = safeNumber(trade.funding);
              if (fundingPeriods > 0 && rate !== 0) {
                const signed = trade.direction === "خرید" ? -1 : 1;
                fundingPnl = signed * rate * safeNumber(trade.positionNotional) * fundingPeriods;
              }

              pnlUsdt = grossPnl - totalFees + fundingPnl;
              marginReturnPercent = safeNumber(trade.margin) > 0
                ? (pnlUsdt / safeNumber(trade.margin)) * 100
                : 0;
            }

            // ==================================================
            // ذخیره نتیجه
            // ==================================================

            const updated = {
              ...trade,

              status:
                result.status,

              result:
                result.status,

              firstTarget:
                result.firstTarget,

              exitPrice:
                result.exitPrice,

              pnlUsdt:
                Number(
                  pnlUsdt.toFixed(4)
                ),

              pnl:
                Number(
                  pnlUsdt.toFixed(4)
                ),

              pnlPercent:
                Number(priceMovePercent.toFixed(4)),

              priceMovePercent:
                Number(priceMovePercent.toFixed(4)),

              grossPnl:
                Number(grossPnl.toFixed(4)),

              totalFees:
                Number(totalFees.toFixed(4)),

              fundingPnl:
                Number(fundingPnl.toFixed(4)),

              marginReturnPercent:
                Number(marginReturnPercent.toFixed(4)),

              closedAt:
                now,

              candleTime:
                result.candleTime,

              updatedAt:
                now
            };

            await env.ALGO_ESMAIL_KV.put(
              trade.id,
              JSON.stringify(
                updated
              )
            );

            closed++;

            if (
              result.status ===
              "AMBIGUOUS"
            ) {
              ambiguous++;
            }

            closedTrades.push(
              updated
            );

            console.log(
              "================================"
            );

            console.log(
              "PAPER TRADE CLOSED"
            );

            console.log(
              "SYMBOL:",
              trade.symbol
            );

            console.log(
              "DIRECTION:",
              trade.direction
            );

            console.log(
              "RESULT:",
              result.status
            );

            console.log(
              "ENTRY:",
              entry
            );

            console.log(
              "EXIT:",
              result.exitPrice
            );

            console.log(
              "PNL:",
              pnlUsdt
            );

            console.log(
              "================================"
            );
          } catch (error) {
            console.error(
              "UPDATE PAPER TRADE ERROR:",
              trade.symbol,
              error?.stack ||
              error
            );
          }
        }
      )
    );
  }

  return {
    checked,
    closed,
    expired,
    ambiguous,
    closedTrades
  };
}

// ============================================================
// اعلان بسته شدن معاملات
// ============================================================

function formatClosedTradeNotification(
  trade
) {
  if (!trade) {
    return "";
  }

  let emoji = "⚪";

  if (
    trade.status === "WIN"
  ) {
    emoji = "🟢";
  }

  if (
    trade.status === "LOSS"
  ) {
    emoji = "🔴";
  }

  if (
    trade.status === "EXPIRED"
  ) {
    emoji = "⏰";
  }

  if (
    trade.status === "AMBIGUOUS"
  ) {
    emoji = "⚪";
  }

  const pnl =
    safeNumber(
      trade.pnlUsdt ??
      trade.pnl
    );

  const pnlText =
    pnl > 0
      ? `+${pnl.toFixed(2)}`
      : pnl.toFixed(2);

  return `
${emoji} *معامله آزمایشی بسته شد*

🪙 ارز: *${trade.symbol}*

📌 جهت: ${trade.direction}

📊 امتیاز ورود: *${trade.score}/100*

🎯 نتیجه: *${trade.result}*

📍 دلیل: ${trade.firstTarget || "نامشخص"}

💰 ورود: \`${formatNumber(trade.entry)}\`

🚪 خروج: ${
    trade.exitPrice != null
      ? `\`${formatNumber(trade.exitPrice)}\``
      : "نامشخص"
  }

💵 سود/ضرر خالص: *${pnlText} USDT*

📈 حرکت قیمت: ${safeNumber(trade.priceMovePercent ?? trade.pnlPercent).toFixed(2)}%
📊 بازده روی مارجین: ${safeNumber(trade.marginReturnPercent).toFixed(2)}%
💸 کارمزد: ${safeNumber(trade.totalFees).toFixed(3)} USDT
💰 Funding: ${safeNumber(trade.fundingPnl).toFixed(3)} USDT

⏱ مدت معامله: ${formatDuration(
    trade.createdAt,
    trade.closedAt
  )}
`;
}

async function notifyClosedTrades(
  closedTrades,
  env
) {
  if (
    !closedTrades ||
    !closedTrades.length ||
    !env.ALGO_ESMAIL_KV
  ) {
    return;
  }

  const chats =
    await getSubscribedChats(
      env
    );

  if (!chats.length) {
    return;
  }

  for (const trade of closedTrades) {
    const message =
      formatClosedTradeNotification(
        trade
      );

    if (!message) {
      continue;
    }

    for (const chatId of chats) {
      try {
        await sendMessage(
          chatId,
          message,
          env,
          {
            parse_mode: "Markdown"
          }
        );
      } catch (error) {
        console.error(
          "CLOSED TRADE NOTIFICATION ERROR:",
          chatId,
          trade.symbol,
          error
        );
      }

      await sleep(50);
    }
  }
}

// ============================================================
// گزارش فرصت
// ============================================================

function directionEmoji(
  direction
) {
  if (
    direction === "خرید"
  ) {
    return "🟢";
  }

  if (
    direction === "فروش"
  ) {
    return "🔴";
  }

  return "⚪";
}

function formatOpportunity(
  item,
  btcContext
) {
  const trade = calculateTrade(item);
  if (!trade) return "";

  const patterns5m = item.analysis5m?.patterns?.length
    ? item.analysis5m.patterns.join("، ")
    : "الگوی خاصی دیده نشد";
  const patterns15 = item.analysis15?.patterns?.length
    ? item.analysis15.patterns.join("، ")
    : "الگوی خاصی دیده نشد";

  const funding = item.funding == null ? "نامشخص" : item.funding.toFixed(6);
  const ls = item.longShort == null ? "نامشخص" : item.longShort.toFixed(2);

  return `
${directionEmoji(item.direction)} *${item.symbol}*

📊 امتیاز: *${item.score}/100*
💰 قیمت: \`${formatNumber(item.price)}\`

📈 روند 4ساعته: ${item.analysis4h.structure}
📊 روند 1ساعته: ${item.analysis1h.structure}
📉 روند 15دقیقه: ${item.analysis15.structure}
⚡ روند 5دقیقه: ${item.analysis5m.structure}

RSI 1H: ${item.analysis1h.rsi.toFixed(1)}
حجم 15M: ${item.analysis15.volumeRatio.toFixed(2)} برابر میانگین

🕯 الگوی 15M: ${patterns15}
🕯 الگوی 5M: ${patterns5m}
ℹ️ الگو به‌تنهایی جهت معامله را تعیین نمی‌کند.

🎯 ورود: \`${formatNumber(trade.entry)}\`
🛑 حد ضرر: \`${formatNumber(trade.stop)}\`
🥇 هدف 1: \`${formatNumber(trade.tp1)}\`
🥈 هدف 2: \`${formatNumber(trade.tp2)}\`
🥉 هدف 3: \`${formatNumber(trade.tp3)}\`

⚙️ اهرم پیشنهادی: *${trade.leverage}x*
💵 سرمایه آزمایشی: ${PAPER_BUDGET} USDT
💸 ریسک پایه: ${RISK_PERCENT}%

💼 ارزش پوزیشن: ${trade.positionNotional.toFixed(2)} USDT
💵 مارجین: ${trade.margin.toFixed(2)} USDT
💸 کارمزد رفت‌وبرگشت تخمینی: ${trade.roundTripFee.toFixed(3)} USDT
📌 حرکت قیمت سربه‌سر از بابت کارمزد: ${trade.feeBreakEvenPriceMovePercent.toFixed(3)}%
💰 Funding: ${funding}
👥 نسبت لانگ/شورت: ${ls}

🧭 وضعیت BTC: ${btcContext.direction}
`;
}

// ============================================================
// گزارش اسکن
// ============================================================

function buildScanReport(
  results,
  btcContext,
  elapsedMs,
  paperInfo = {},
  tradeUpdate = {}
) {
  const valid =
    results.filter(
      x => !x.failed
    );

  const opportunities =
    valid
      .filter(
        x =>
          x.direction !== "خنثی" &&
          x.score >= MIN_SIGNAL_SCORE
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, 5);

  const failed =
    results.filter(
      x => x.failed
    );

  const failureSummary = failed
    .slice(0, 5)
    .map(x => `${x.symbol}: ${x.error || "خطای نامشخص"}`)
    .join("\n");

  let text = `
🤖 *ALGO FJM V5.3*

✅ اسکن بازار توبیت تمام شد.

⏱ زمان اسکن: ${(elapsedMs / 1000).toFixed(1)} ثانیه

🔎 ارزهای بررسی‌شده: ${results.length}

✅ تحلیل موفق: ${valid.length}

❌ ناموفق: ${failed.length}

🧭 وضعیت کلی BTC: *${btcContext.direction}*

━━━━━━━━━━━━━━━━━━

📝 معاملات آزمایشی جدید: *${paperInfo.saved || 0}*

🔄 سیگنال‌های تکراری: ${paperInfo.skipped || 0}

━━━━━━━━━━━━━━━━━━

📋 بررسی معاملات قبلی:

🔎 بررسی‌شده: ${tradeUpdate.checked || 0}

🟢 بسته‌شده: ${tradeUpdate.closed || 0}

⚪ مبهم: ${tradeUpdate.ambiguous || 0}

⏰ منقضی‌شده: ${tradeUpdate.expired || 0}

━━━━━━━━━━━━━━━━━━
`;

  if (!opportunities.length) {
    text += `
⚪ *در حال حاضر فرصت قدرتمند پیدا نشد.*

امتیاز حداقل سیگنال: ${MIN_SIGNAL_SCORE}/100

بازار فعلاً شرایط مناسبی برای ورود پرریسک نشان نمی‌دهد.
`;

    return text;
  }

  text += `
🔥 *فرصت‌های برتر*
`;

  for (
    const item of opportunities
  ) {
    text +=
      formatOpportunity(
        item,
        btcContext
      );

    text +=
      "\n━━━━━━━━━━━━━━━━━━\n";
  }

  return text;
}

// ============================================================
// اجرای اسکن
// ============================================================

async function performScan(env) {
  const started =
    Date.now();

  console.log(
    "================================"
  );

  console.log(
    "ALGO FJM SCAN START"
  );

  console.log(
    "================================"
  );

  try {
    const symbols =
      await getBestSymbols();

    console.log(
      "Selected symbols:",
      symbols.map(
        x => x.symbol
      )
    );

    if (!symbols.length) {
      throw new Error(
        "هیچ ارز مناسبی از Toobit دریافت نشد."
      );
    }

    const btcPromise =
      getBTCContext();

    const results =
      await runInBatches(
        symbols,
        ANALYSIS_BATCH,
        analyzeSymbol
      );

    const btcContext =
      await btcPromise;

    const enriched =
      await enrichDerivatives(
        results
      );

    const elapsed =
      Date.now() - started;

    console.log(
      "SCAN COMPLETE",
      `${elapsed}ms`
    );

    return {
      results:
        enriched,

      btcContext,

      elapsed
    };
  } catch (error) {
    console.error(
      "SCAN ERROR:",
      error?.stack ||
      error
    );

    throw error;
  }
}

// ============================================================
// اشتراک
// ============================================================

async function subscribe(
  chatId,
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    throw new Error(
      "KV متصل نیست."
    );
  }

  await env.ALGO_ESMAIL_KV.put(
    `chat:${chatId}`,
    JSON.stringify({
      chatId,
      createdAt:
        Date.now()
    })
  );
}

async function unsubscribe(
  chatId,
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    throw new Error(
      "KV متصل نیست."
    );
  }

  await env.ALGO_ESMAIL_KV.delete(
    `chat:${chatId}`
  );
}

async function getSubscribedChats(
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return [];
  }

  const list =
    await env.ALGO_ESMAIL_KV.list({
      prefix: "chat:",
      limit: 100
    });

  return list.keys.map(
    x =>
      x.name.replace(
        "chat:",
        ""
      )
  );
}

// ============================================================
// RESET STATS
// ============================================================

async function resetStats(
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return {
      deleted: 0
    };
  }

  const keys =
    await listAllKeys(
      env,
      "trade:"
    );

  let deleted = 0;

  for (const key of keys) {
    try {
      await env.ALGO_ESMAIL_KV.delete(
        key.name
      );

      deleted++;
    } catch (error) {
      console.error(
        "RESET DELETE ERROR:",
        key.name,
        error
      );
    }
  }

  console.log(
    `RESET STATS COMPLETE: ${deleted}`
  );

  return {
    deleted
  };
}

// ============================================================
// STATS
// ============================================================

async function getStats(
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return "❌ KV متصل نیست.";
  }

  const tradeUpdate =
    await updateOpenPaperTrades(
      env
    );

  // اعلان معاملات بسته‌شده
  if (
    tradeUpdate.closedTrades?.length
  ) {
    await notifyClosedTrades(
      tradeUpdate.closedTrades,
      env
    );
  }

  const keys =
    await listAllKeys(
      env,
      "trade:"
    );

  let total = 0;
  let open = 0;
  let wins = 0;
  let losses = 0;
  let ambiguous = 0;
  let expired = 0;

  let pnl = 0;

  let totalWinPnl = 0;
  let totalLossPnl = 0;

  let highScoreTotal = 0;
  let highScoreWins = 0;

  let midScoreTotal = 0;
  let midScoreWins = 0;

  for (const key of keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(
          key.name
        );

      if (!raw) {
        continue;
      }

      const trade =
        JSON.parse(raw);

      total++;

      const status =
        trade.status;

      if (
        status === "OPEN"
      ) {
        open++;
      }

      if (
        status === "WIN"
      ) {
        wins++;

        const value =
          safeNumber(
            trade.pnlUsdt ??
            trade.pnl
          );

        pnl += value;
        totalWinPnl += value;
      }

      if (
        status === "LOSS"
      ) {
        losses++;

        const value =
          safeNumber(
            trade.pnlUsdt ??
            trade.pnl
          );

        pnl += value;
        totalLossPnl += value;
      }

      if (
        status === "AMBIGUOUS"
      ) {
        ambiguous++;
      }

      if (
        status === "EXPIRED"
      ) {
        expired++;
      }

      const score =
        safeNumber(
          trade.score
        );

      if (score >= 90) {
        highScoreTotal++;

        if (
          status === "WIN"
        ) {
          highScoreWins++;
        }
      }

      if (
        score >= 80 &&
        score < 90
      ) {
        midScoreTotal++;

        if (
          status === "WIN"
        ) {
          midScoreWins++;
        }
      }
    } catch {}
  }

  const closed =
    wins + losses;

  const winRate =
    closed > 0
      ? (wins / closed) * 100
      : 0;

  const highScoreRate =
    highScoreTotal > 0
      ? (
          highScoreWins /
          highScoreTotal
        ) * 100
      : 0;

  const midScoreRate =
    midScoreTotal > 0
      ? (
          midScoreWins /
          midScoreTotal
        ) * 100
      : 0;

  return `
📊 *آمار معاملات آزمایشی ALGO FJM V5.3*

کل معاملات: *${total}*

🟡 باز: ${open}

🟢 برد: ${wins}

🔴 باخت: ${losses}

⚪ مبهم: ${ambiguous}

⏰ منقضی: ${expired}

📈 معاملات بسته‌شده: ${closed}

🎯 نرخ برد: *${winRate.toFixed(1)}%*

💰 سود/زیان: *${pnl.toFixed(2)} USDT*

🟢 مجموع سودها: ${totalWinPnl.toFixed(2)} USDT

🔴 مجموع ضررها: ${totalLossPnl.toFixed(2)} USDT

━━━━━━━━━━━━━━━━━━

📊 عملکرد امتیاز 90+: ${highScoreWins}/${highScoreTotal}

نرخ برد: ${highScoreRate.toFixed(1)}%

📊 عملکرد امتیاز 80 تا 89: ${midScoreWins}/${midScoreTotal}

نرخ برد: ${midScoreRate.toFixed(1)}%

━━━━━━━━━━━━━━━━━━

🔄 آخرین بررسی: ${tradeUpdate.checked || 0} معامله

🟢 بسته‌شده در این بررسی: ${tradeUpdate.closed || 0}

⚪ مبهم: ${tradeUpdate.ambiguous || 0}

⏰ منقضی: ${tradeUpdate.expired || 0}

━━━━━━━━━━━━━━━━━━

💵 سرمایه آزمایشی: ${PAPER_BUDGET} USDT

⚠️ این آمار فقط Paper Trade است.
`;
}

// ============================================================
// HISTORY - دریافت تاریخچه معاملات
// ============================================================

async function getTradeHistory(
  env,
  limit = DEFAULT_HISTORY_LIMIT
) {
  if (!env.ALGO_ESMAIL_KV) {
    return "❌ KV متصل نیست.";
  }

  limit =
    Math.max(
      1,
      Math.min(
        MAX_HISTORY_LIMIT,
        safeNumber(
          limit,
          DEFAULT_HISTORY_LIMIT
        )
      )
    );

  // ابتدا معاملات باز را بررسی می‌کنیم
  const update =
    await updateOpenPaperTrades(
      env
    );

  if (
    update.closedTrades?.length
  ) {
    await notifyClosedTrades(
      update.closedTrades,
      env
    );
  }

  const keys =
    await listAllKeys(
      env,
      "trade:"
    );

  const trades = [];

  for (const key of keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(
          key.name
        );

      if (!raw) {
        continue;
      }

      const trade =
        JSON.parse(raw);

      if (
        trade.status !== "OPEN"
      ) {
        trades.push(trade);
      }
    } catch {}
  }

  trades.sort(
    (a, b) => {
      const aTime =
        safeNumber(
          a.closedAt ??
          a.createdAt
        );

      const bTime =
        safeNumber(
          b.closedAt ??
          b.createdAt
        );

      return bTime - aTime;
    }
  );

  const selected =
    trades.slice(
      0,
      limit
    );

  if (!selected.length) {
    return `
📚 *تاریخچه معاملات ALGO FJM*

هنوز هیچ معامله بسته‌شده‌ای وجود ندارد.
`;
  }

  let text = `
📚 *تاریخچه معاملات ALGO FJM V5.3*

تعداد نمایش: *${selected.length}*

━━━━━━━━━━━━━━━━━━
`;

  selected.forEach(
    (trade, index) => {
      let emoji = "⚪";

      if (
        trade.status === "WIN"
      ) {
        emoji = "🟢";
      }

      if (
        trade.status === "LOSS"
      ) {
        emoji = "🔴";
      }

      if (
        trade.status === "EXPIRED"
      ) {
        emoji = "⏰";
      }

      const pnl =
        safeNumber(
          trade.pnlUsdt ??
          trade.pnl
        );

      const pnlText =
        pnl > 0
          ? `+${pnl.toFixed(2)}`
          : pnl.toFixed(2);

      text += `
${emoji} *#${index + 1} ${trade.symbol}*

${trade.direction} | امتیاز ${trade.score}/100

نتیجه: *${trade.result || trade.status}*

دلیل: ${trade.firstTarget || "نامشخص"}

ورود: \`${formatNumber(trade.entry)}\`

خروج: ${
        trade.exitPrice != null
          ? `\`${formatNumber(trade.exitPrice)}\``
          : "نامشخص"
      }

سود/ضرر: *${pnlText} USDT*

زمان ورود: ${formatDate(
        trade.createdAt
      )}

زمان خروج: ${formatDate(
        trade.closedAt
      )}

مدت: ${formatDuration(
        trade.createdAt,
        trade.closedAt
      )}

━━━━━━━━━━━━━━━━━━
`;
    }
  );

  text += `
💡 برای دیدن معاملات بیشتر:

\`/history 20\`

حداکثر: ${MAX_HISTORY_LIMIT} معامله
`;

  return text;
}

// ============================================================
// HISTORY - تحلیل تشخیصی خلاصه
// ============================================================

async function getHistoryDiagnostics(
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return "❌ KV متصل نیست.";
  }

  const keys =
    await listAllKeys(
      env,
      "trade:"
    );

  const trades = [];

  for (const key of keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(
          key.name
        );

      if (!raw) {
        continue;
      }

      const trade =
        JSON.parse(raw);

      if (
        trade.status !== "OPEN"
      ) {
        trades.push(trade);
      }
    } catch {}
  }

  const closed =
    trades.filter(
      x =>
        x.status === "WIN" ||
        x.status === "LOSS"
    );

  if (!closed.length) {
    return `
🔬 *تحلیل تشخیصی*

هنوز معامله بسته‌شده کافی برای تحلیل وجود ندارد.
`;
  }

  let wins = 0;
  let losses = 0;

  let highScoreWins = 0;
  let highScoreLosses = 0;

  let midScoreWins = 0;
  let midScoreLosses = 0;

  let buyWins = 0;
  let buyLosses = 0;

  let sellWins = 0;
  let sellLosses = 0;

  let totalWin = 0;
  let totalLoss = 0;

  let snapshotCount = 0;

  let bearishPatternLosses = 0;
  let bullishPatternLosses = 0;

  let lowVolumeLosses = 0;

  for (const trade of closed) {
    const pnl =
      safeNumber(
        trade.pnlUsdt ??
        trade.pnl
      );

    if (
      trade.status === "WIN"
    ) {
      wins++;
      totalWin += pnl;
    }

    if (
      trade.status === "LOSS"
    ) {
      losses++;
      totalLoss += pnl;
    }

    if (
      safeNumber(
        trade.score
      ) >= 90
    ) {
      if (
        trade.status === "WIN"
      ) {
        highScoreWins++;
      }

      if (
        trade.status === "LOSS"
      ) {
        highScoreLosses++;
      }
    }

    if (
      safeNumber(
        trade.score
      ) >= 80 &&
      safeNumber(
        trade.score
      ) < 90
    ) {
      if (
        trade.status === "WIN"
      ) {
        midScoreWins++;
      }

      if (
        trade.status === "LOSS"
      ) {
        midScoreLosses++;
      }
    }

    if (
      trade.direction === "خرید"
    ) {
      if (
        trade.status === "WIN"
      ) {
        buyWins++;
      }

      if (
        trade.status === "LOSS"
      ) {
        buyLosses++;
      }
    }

    if (
      trade.direction === "فروش"
    ) {
      if (
        trade.status === "WIN"
      ) {
        sellWins++;
      }

      if (
        trade.status === "LOSS"
      ) {
        sellLosses++;
      }
    }

    if (
      trade.signalSnapshot
    ) {
      snapshotCount++;

      const patterns =
        trade.signalSnapshot
          ?.timeframe15
          ?.patterns ||
        [];

      if (
        trade.status === "LOSS"
      ) {
        const bearish =
          patterns.some(
            p =>
              p.includes("نزولی") ||
              p === "شهاب‌سنگ"
          );

        const bullish =
          patterns.some(
            p =>
              p.includes("صعودی") ||
              p === "چکش"
          );

        if (bearish) {
          bearishPatternLosses++;
        }

        if (bullish) {
          bullishPatternLosses++;
        }

        const volumeRatio =
          safeNumber(
            trade.signalSnapshot
              ?.timeframe1h
              ?.volumeRatio
          );

        if (
          volumeRatio > 0 &&
          volumeRatio < 0.8
        ) {
          lowVolumeLosses++;
        }
      }
    }
  }

  const total =
    wins + losses;

  const winRate =
    total > 0
      ? (wins / total) * 100
      : 0;

  return `
🔬 *تحلیل تشخیصی ALGO FJM*

📊 معاملات بسته: ${total}

🟢 برد: ${wins}

🔴 باخت: ${losses}

🎯 نرخ برد: *${winRate.toFixed(1)}%*

━━━━━━━━━━━━━━━━━━

📈 امتیاز 90+:

🟢 برد: ${highScoreWins}

🔴 باخت: ${highScoreLosses}

📊 امتیاز 80 تا 89:

🟢 برد: ${midScoreWins}

🔴 باخت: ${midScoreLosses}

━━━━━━━━━━━━━━━━━━

🟢 معاملات خرید: ${buyWins} برد / ${buyLosses} باخت

🔴 معاملات فروش: ${sellWins} برد / ${sellLosses} باخت

━━━━━━━━━━━━━━━━━━

💰 مجموع سود: +${totalWin.toFixed(2)} USDT

💸 مجموع ضرر: ${totalLoss.toFixed(2)} USDT

━━━━━━━━━━━━━━━━━━

🔬 Snapshot تشخیصی موجود: ${snapshotCount}/${total}

🕯 باخت‌های دارای الگوی نزولی: ${bearishPatternLosses}

🕯 باخت‌های دارای الگوی صعودی: ${bullishPatternLosses}

📉 باخت با حجم کمتر از 0.8 برابر: ${lowVolumeLosses}

━━━━━━━━━━━━━━━━━━

⚠️ این بخش فقط برای تشخیص مشکل است و هنوز هیچ تغییری در استراتژی ایجاد نمی‌کند.
`;
}

// ============================================================
// PAPER - معاملات باز
// ============================================================

async function getOpenPaperTrades(
  env
) {
  if (!env.ALGO_ESMAIL_KV) {
    return "❌ KV متصل نیست.";
  }

  const update =
    await updateOpenPaperTrades(
      env
    );

  if (
    update.closedTrades?.length
  ) {
    await notifyClosedTrades(
      update.closedTrades,
      env
    );
  }

  const keys =
    await listAllKeys(
      env,
      "trade:"
    );

  const trades = [];

  for (const key of keys) {
    try {
      const raw =
        await env.ALGO_ESMAIL_KV.get(
          key.name
        );

      if (!raw) {
        continue;
      }

      const trade =
        JSON.parse(raw);

      if (
        trade.status === "OPEN"
      ) {
        trades.push(trade);
      }
    } catch {}
  }

  trades.sort(
    (a, b) =>
      safeNumber(
        b.createdAt
      ) -
      safeNumber(
        a.createdAt
      )
  );

  if (!trades.length) {
    return `
📝 *معاملات آزمایشی باز ALGO FJM*

در حال حاضر هیچ معامله آزمایشی بازی وجود ندارد.
`;
  }

  let text = `
📝 *معاملات آزمایشی باز ALGO FJM*

تعداد: *${trades.length}*

━━━━━━━━━━━━━━━━━━
`;

  for (const trade of trades) {
    const ageHours =
      (
        Date.now() -
        safeNumber(
          trade.createdAt
        )
      ) / 3600000;

    text += `
${directionEmoji(
      trade.direction
    )} *${trade.symbol}*

📊 امتیاز: ${trade.score}/100

🎯 ورود: \`${formatNumber(trade.entry)}\`

🛑 حد ضرر: \`${formatNumber(trade.stop)}\`

🥇 هدف 1: \`${formatNumber(trade.tp1)}\`

⚙️ اهرم: ${trade.leverage}x

⏱ عمر معامله: ${ageHours.toFixed(1)} ساعت

━━━━━━━━━━━━━━━━━━
`;
  }

  return text;
}

// ============================================================
// DASHBOARD - خلاصه عملکرد واقعی Paper Futures
// ============================================================

async function getDashboard(env) {
  if (!env.ALGO_ESMAIL_KV) return "❌ KV متصل نیست.";

  const keys = await listAllKeys(env, "trade:");
  const trades = [];
  for (const key of keys) {
    try {
      const raw = await env.ALGO_ESMAIL_KV.get(key.name);
      if (!raw) continue;
      const t = JSON.parse(raw);
      if (t.status !== "OPEN") trades.push(t);
    } catch {}
  }

  const closed = trades.filter(t => t.status === "WIN" || t.status === "LOSS");
  const wins = closed.filter(t => t.status === "WIN");
  const losses = closed.filter(t => t.status === "LOSS");
  const net = closed.reduce((a,t) => a + safeNumber(t.pnlUsdt ?? t.pnl), 0);
  const gross = closed.reduce((a,t) => a + safeNumber(t.grossPnl), 0);
  const fees = closed.reduce((a,t) => a + safeNumber(t.totalFees), 0);
  const funding = closed.reduce((a,t) => a + safeNumber(t.fundingPnl), 0);
  const avgMarginReturn = average(closed.map(t => safeNumber(t.marginReturnPercent)));
  const avgPriceMove = average(closed.map(t => safeNumber(t.priceMovePercent ?? t.pnlPercent)));
  const winRate = closed.length ? wins.length / closed.length * 100 : 0;
  const profitFactor = Math.abs(losses.reduce((a,t) => a + Math.min(0, safeNumber(t.pnlUsdt ?? t.pnl)), 0)) > 0
    ? wins.reduce((a,t) => a + Math.max(0, safeNumber(t.pnlUsdt ?? t.pnl)), 0) /
      Math.abs(losses.reduce((a,t) => a + Math.min(0, safeNumber(t.pnlUsdt ?? t.pnl)), 0))
    : 0;

  return `
📊 *داشبورد ALGO FJM V5.3*

📚 معاملات بسته: ${closed.length}
🟢 برد: ${wins.length}
🔴 باخت: ${losses.length}
🎯 نرخ برد: ${winRate.toFixed(1)}%

💰 PnL خالص: *${net.toFixed(2)} USDT*
📈 PnL خام: ${gross.toFixed(2)} USDT
💸 مجموع کارمزد: ${fees.toFixed(3)} USDT
💰 مجموع Funding: ${funding.toFixed(3)} USDT

📊 میانگین حرکت قیمت: ${avgPriceMove.toFixed(2)}%
📊 میانگین بازده روی مارجین: ${avgMarginReturn.toFixed(2)}%
⚖️ Profit Factor: ${profitFactor.toFixed(2)}

🧠 قانون ارزیابی:
• 5M و 15M برای ورود مهم‌ترند.
• 1H و 4H جهت کلی را فیلتر می‌کنند.
• الگوی کندلی به‌تنهایی سیگنال خرید/فروش نیست.
• PnL بر اساس مارجین + اهرم + کارمزد + Funding محاسبه می‌شود.
`;
}

// ============================================================
// HELP
// ============================================================

function helpText() {
  return `
🤖 *ALGO FJM V5.3*

دستورات:

/scan 🔎 اسکن سریع بازار توبیت

/signal BTC 📊 تحلیل یک ارز

/subscribe 🔔 دریافت گزارش خودکار

/unsubscribe 🔕 توقف گزارش خودکار

/stats 📊 آمار معاملات آزمایشی

/paper 📝 معاملات آزمایشی باز

/history 📚 تاریخچه معاملات بسته‌شده

/history 20 📚 نمایش 20 معامله اخیر

/diagnostics 🔬 تحلیل تشخیصی عملکرد

/dashboard 📊 داشبورد عملکرد فیوچرز

/resetstats 🧹 پاک کردن کامل آمار قبلی

/health 🩺 بررسی وضعیت ربات

/help 📚 راهنما

━━━━━━━━━━━━━━━━━━

⚠️ معاملات فعلاً *آزمایشی* هستند. هیچ معامله واقعی انجام نمی‌شود.

🤖 نام سیستم: *ALGO FJM*
`;
}

// ============================================================
// SIGNAL
// ============================================================

async function singleSignal(
  symbolInput
) {
  let symbol =
    symbolInput.toUpperCase();

  if (!symbol.includes("-")) {
    symbol =
      `${symbol}-SWAP-USDT`;
  }

  const result =
    await analyzeSymbol({
      symbol,
      price: 0,
      volume: 0,
      change: 0
    });

  if (result.failed) {
    throw new Error(
      result.error ||
      "تحلیل انجام نشد."
    );
  }

  const btc =
    symbol === "BTC-SWAP-USDT"
      ? result
      : await getBTCContext();

  await enrichDerivatives(
    [result]
  );

  return formatOpportunity(
    result,
    btc
  );
}

// ============================================================
// HEALTH
// ============================================================

async function healthText(
  env
) {
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
🩺 *وضعیت ALGO FJM*

🤖 Telegram Bot Token: ${botStatus}

💾 Cloudflare KV: ${kvStatus}

📡 Toobit API: ${toobitStatus}

⚙️ نسخه: V5.3

🔎 تعداد اسکن: ${MAX_ANALYSIS_SYMBOLS} ارز

📊 حداقل امتیاز: ${MIN_SIGNAL_SCORE}

💰 معاملات واقعی: ❌ خاموش

📝 Paper Trade: ✅ فعال

🎯 بررسی خودکار TP/SL: ✅ فعال

📚 تاریخچه تشخیصی: ✅ فعال

🔔 اعلان بسته‌شدن معاملات: ✅ فعال

⏱ حداکثر عمر معامله: ${MAX_OPEN_TRADE_AGE_HOURS} ساعت

🕯 تاریخچه بررسی: ${PAPER_CHECK_CANDLES} کندل 15 دقیقه‌ای

⚡ تحلیل ورود: 5M + 15M
🧭 تحلیل روند: 1H + 4H
💸 کارمزد Paper: Taker 0.06% در هر طرف
`;
}

// ============================================================
// پردازش پیام
// ============================================================

async function processUpdate(
  update,
  env,
  ctx
) {
  try {
    if (!update?.message) {
      return;
    }

    const message =
      update.message;

    const chatId =
      message.chat?.id;

    if (!chatId) {
      return;
    }

    const text =
      String(
        message.text || ""
      ).trim();

    if (!text) {
      return;
    }

    const command =
      text
        .split(/\s+/)[0]
        .toLowerCase();

    // ========================================================
    // HELP
    // ========================================================

    if (
      command === "/start" ||
      command === "/help"
    ) {
      await sendMessage(
        chatId,
        helpText(),
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // HEALTH
    // ========================================================

    if (
      command === "/health"
    ) {
      const result =
        await healthText(env);

      await sendMessage(
        chatId,
        result,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // SUBSCRIBE
    // ========================================================

    if (
      command === "/subscribe"
    ) {
      await subscribe(
        chatId,
        env
      );

      await sendMessage(
        chatId,
        "🔔 اشتراک گزارش‌های خودکار فعال شد.",
        env
      );

      return;
    }

    // ========================================================
    // UNSUBSCRIBE
    // ========================================================

    if (
      command === "/unsubscribe"
    ) {
      await unsubscribe(
        chatId,
        env
      );

      await sendMessage(
        chatId,
        "🔕 اشتراک گزارش‌های خودکار غیرفعال شد.",
        env
      );

      return;
    }

    // ========================================================
    // RESET STATS
    // ========================================================

    if (
      command === "/resetstats"
    ) {
      await sendMessage(
        chatId,
        "🧹 در حال پاک کردن کامل آمار معاملات آزمایشی قبلی...",
        env
      );

      const result =
        await resetStats(
          env
        );

      await sendMessage(
        chatId,
        `
✅ *آمار قبلی پاک شد.*

تعداد معاملات حذف‌شده: *${result.deleted}*

📊 سیستم Paper Trade از صفر شروع شد.

🤖 ALGO FJM V5.3

⚠️ از این لحظه اطلاعات جدید ثبت می‌شود.
`,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // DASHBOARD
    // ========================================================

    if (
      command === "/dashboard"
    ) {
      const result = await getDashboard(env);
      await sendMessage(chatId, result, env, { parse_mode: "Markdown" });
      return;
    }

    // ========================================================
    // STATS
    // ========================================================

    if (
      command === "/stats"
    ) {
      const result =
        await getStats(env);

      await sendMessage(
        chatId,
        result,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // PAPER
    // ========================================================

    if (
      command === "/paper"
    ) {
      const result =
        await getOpenPaperTrades(
          env
        );

      await sendMessage(
        chatId,
        result,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // HISTORY
    // ========================================================

    if (
      command === "/history"
    ) {
      const parts =
        text.split(/\s+/);

      const requestedLimit =
        parts[1]
          ? safeNumber(
              parts[1],
              DEFAULT_HISTORY_LIMIT
            )
          : DEFAULT_HISTORY_LIMIT;

      const result =
        await getTradeHistory(
          env,
          requestedLimit
        );

      // مهم:
      // به جای sendMessage از sendLongMessage استفاده شده
      // تا /history 20 در چند پیام ارسال شود.
      await sendLongMessage(
        chatId,
        result,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // DIAGNOSTICS
    // ========================================================

    if (
      command === "/diagnostics"
    ) {
      const result =
        await getHistoryDiagnostics(
          env
        );

      await sendMessage(
        chatId,
        result,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      return;
    }

    // ========================================================
    // SIGNAL
    // ========================================================

    if (
      command === "/signal"
    ) {
      const parts =
        text.split(/\s+/);

      const input =
        parts[1] ||
        "BTC";

      await sendMessage(
        chatId,
        `📊 در حال تحلیل ${input.toUpperCase()}...`,
        env
      );

      try {
        const result =
          await singleSignal(
            input
          );

        await sendMessage(
          chatId,
          result ||
          "سیگنال مناسبی پیدا نشد.",
          env,
          {
            parse_mode: "Markdown"
          }
        );
      } catch (error) {
        console.error(
          "SIGNAL ERROR:",
          error?.stack ||
          error
        );

        await sendMessage(
          chatId,
          `❌ تحلیل انجام نشد.\n\nخطا:\n${error.message}`,
          env
        );
      }

      return;
    }

    // ========================================================
    // SCAN
    // ========================================================

    if (
      command === "/scan"
    ) {
      await sendMessage(
        chatId,
        `🔎 *در حال بررسی بازار توبیت...*

⏳ لطفاً چند لحظه صبر کنید.

نتیجه پس از پایان اسکن ارسال می‌شود.`,
        env,
        {
          parse_mode: "Markdown"
        }
      );

      ctx.waitUntil(
        (async () => {
          try {
            console.log(
              "BACKGROUND SCAN START",
              chatId
            );

            // اول معاملات قبلی
            const tradeUpdate =
              await updateOpenPaperTrades(
                env
              );

            console.log(
              "PAPER UPDATE:",
              tradeUpdate
            );

            // اعلان معاملات بسته‌شده
            if (
              tradeUpdate.closedTrades?.length
            ) {
              await notifyClosedTrades(
                tradeUpdate.closedTrades,
                env
              );
            }

            // سپس بازار
            const scan =
              await performScan(
                env
              );

            // ثبت سیگنال‌های جدید
            const paperInfo =
              await recordPaperTrades(
                scan.results,
                scan.btcContext,
                env
              );

            const report =
              buildScanReport(
                scan.results,
                scan.btcContext,
                scan.elapsed,
                paperInfo,
                tradeUpdate
              );

            await sendMessage(
              chatId,
              report,
              env,
              {
                parse_mode: "Markdown"
              }
            );

            console.log(
              "BACKGROUND SCAN REPORT SENT",
              chatId
            );
          } catch (error) {
            console.error(
              "BACKGROUND SCAN FAILED:",
              error?.stack ||
              error
            );

            try {
              await sendMessage(
                chatId,
                `❌ *اسکن بازار متوقف شد.*

دلیل:
${String(
                  error?.message ||
                  error
                ).slice(0, 700)}

لطفاً /health را بررسی کن.`,
                env,
                {
                  parse_mode: "Markdown"
                }
              );
            } catch (
              telegramError
            ) {
              console.error(
                "ERROR MESSAGE SEND FAILED:",
                telegramError?.stack ||
                telegramError
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
      error?.stack ||
      error
    );

    try {
      if (
        update?.message?.chat?.id
      ) {
        await sendMessage(
          update.message.chat.id,
          `❌ خطایی در پردازش درخواست رخ داد.\n\n${String(
            error.message ||
            error
          ).slice(0, 700)}`,
          env
        );
      }
    } catch (sendError) {
      console.error(
        "FINAL ERROR SEND FAILED:",
        sendError?.stack ||
        sendError
      );
    }
  }
}

// ============================================================
// SCHEDULED
// ============================================================

async function scheduledHandler(
  env
) {
  console.log(
    "ALGO FJM SCHEDULED SCAN START"
  );

  try {
    // ========================================================
    // اول نتیجه معاملات قبلی
    // ========================================================

    const tradeUpdate =
      await updateOpenPaperTrades(
        env
      );

    console.log(
      "SCHEDULED PAPER UPDATE:",
      tradeUpdate
    );

    // اعلان بسته‌شدن معاملات
    if (
      tradeUpdate.closedTrades?.length
    ) {
      await notifyClosedTrades(
        tradeUpdate.closedTrades,
        env
      );
    }

    // ========================================================
    // دریافت مشترک‌ها
    // ========================================================

    const chats =
      await getSubscribedChats(
        env
      );

    if (!chats.length) {
      console.log(
        "No subscribed chats."
      );

      return;
    }

    // ========================================================
    // اسکن بازار
    // ========================================================

    const scan =
      await performScan(
        env
      );

    // ========================================================
    // ثبت معاملات جدید
    // ========================================================

    const paperInfo =
      await recordPaperTrades(
        scan.results,
        scan.btcContext,
        env
      );

    // ========================================================
    // ساخت گزارش
    // ========================================================

    const report =
      buildScanReport(
        scan.results,
        scan.btcContext,
        scan.elapsed,
        paperInfo,
        tradeUpdate
      );

    // ========================================================
    // ارسال
    // ========================================================

    for (
      const chatId of chats
    ) {
      try {
        await sendMessage(
          chatId,
          report,
          env,
          {
            parse_mode: "Markdown"
          }
        );
      } catch (error) {
        console.error(
          "Scheduled Telegram error:",
          chatId,
          error?.stack ||
          error
        );
      }

      await sleep(100);
    }

    console.log(
      "ALGO FJM SCHEDULED SCAN COMPLETE"
    );
  } catch (error) {
    console.error(
      "SCHEDULED SCAN ERROR:",
      error?.stack ||
      error
    );
  }
}

// ============================================================
// CLOUDFLARE WORKER
// ============================================================

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    // ========================================================
    // GET
    // ========================================================

    if (
      request.method === "GET"
    ) {
      return new Response(
        "ALGO FJM V5.3 is LIVE 🤖",
        {
          status: 200,

          headers: {
            "content-type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    // ========================================================
    // POST Telegram
    // ========================================================

    if (
      request.method === "POST"
    ) {
      try {
        const update =
          await request.json();

        ctx.waitUntil(
          processUpdate(
            update,
            env,
            ctx
          )
        );

        return new Response(
          "OK",
          {
            status: 200
          }
        );
      } catch (error) {
        console.error(
          "WEBHOOK ERROR:",
          error?.stack ||
          error
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

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scheduledHandler(env)
    );
  }
};
