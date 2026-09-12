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

  const candleMs =
    intervalMsMap[interval] ||
    60 * 1000;

  const now = Date.now();

  const effectiveEnd =
    endTime != null
      ? safeNumber(endTime)
      : now;

  const effectiveStart =
    startTime != null
      ? safeNumber(startTime)
      : effectiveEnd -
        candleMs *
        Math.max(limit + 5, 210);

  let url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&startTime=${effectiveStart}` +
    `&endTime=${effectiveEnd}` +
    `&limit=${Math.min(
      Math.max(limit, 1),
      1000
    )}`;

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

  for (
    let i = 0;
    i < period;
    i++
  ) {
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
// حمایت و مقاومت
// ============================================================

function supportResistance(candles) {
  if (candles.length < 20) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    candles.slice(-50);

  const highs =
    recent.map(x => x.high);

  const lows =
    recent.map(x => x.low);

  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs)
  };
}

// ============================================================
// VOLUME
// ============================================================

function volumeRatio(candles, period = 20) {
  if (
    candles.length <= period
  ) {
    return 1;
  }

  const current =
    candles[candles.length - 2]
      .volume;

  const previous =
    candles
      .slice(
        candles.length - 2 - period,
        candles.length - 2
      )
      .map(x => x.volume);

  const avg =
    average(previous);

  if (!avg) {
    return 1;
  }

  return current / avg;
}

// ============================================================
// ADX
// ============================================================

function adx(candles, period = 14) {
  const result =
    new Array(candles.length).fill(null);

  if (
    candles.length <
    period * 2 + 2
  ) {
    return result;
  }

  const tr =
    new Array(candles.length).fill(0);

  const plusDM =
    new Array(candles.length).fill(0);

  const minusDM =
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

    const prevHigh =
      candles[i - 1].high;

    const prevLow =
      candles[i - 1].low;

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

    const upMove =
      high - prevHigh;

    const downMove =
      prevLow - low;

    if (
      upMove > downMove &&
      upMove > 0
    ) {
      plusDM[i] = upMove;
    }

    if (
      downMove > upMove &&
      downMove > 0
    ) {
      minusDM[i] = downMove;
    }
  }

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    trSum += tr[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }

  const dx = [];

  for (
    let i = period + 1;
    i < candles.length;
    i++
  ) {
    trSum =
      trSum -
      trSum / period +
      tr[i];

    plusSum =
      plusSum -
      plusSum / period +
      plusDM[i];

    minusSum =
      minusSum -
      minusSum / period +
      minusDM[i];

    if (!trSum) {
      continue;
    }

    const plusDI =
      100 * plusSum / trSum;

    const minusDI =
      100 * minusSum / trSum;

    const denominator =
      plusDI + minusDI;

    if (!denominator) {
      continue;
    }

    const dxValue =
      100 *
      Math.abs(
        plusDI - minusDI
      ) /
      denominator;

    dx.push({
      index: i,
      value: dxValue,
      plusDI,
      minusDI
    });
  }

  if (
    dx.length <
    period
  ) {
    return result;
  }

  let adxSum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    adxSum += dx[i].value;
  }

  let adxValue =
    adxSum / period;

  result[
    dx[period - 1].index
  ] = adxValue;

  for (
    let i = period;
    i < dx.length;
    i++
  ) {
    adxValue =
      (
        adxValue * (period - 1) +
        dx[i].value
      ) / period;

    result[
      dx[i].index
    ] = adxValue;
  }

  return result;
}

// ============================================================
// تحلیل تایم‌فریم
// ============================================================

function analyzeTimeframe(
  candles,
  interval
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 60
  ) {
    throw new Error(
      `${interval}: داده کندل کافی نیست (${candles?.length || 0})`
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

  const rsi14 =
    rsi(closes, 14);

  const atr14 =
    atr(candles, 14);

  const macdData =
    macd(closes);

  const adx14 =
    adx(candles, 14);

  // از کندل بسته‌شده استفاده می‌کنیم
  const i =
    candles.length - 2;

  const close =
    closes[i];

  const e20 =
    ema20[i];

  const e50 =
    ema50[i];

  const e200 =
    ema200[i];

  const rsiValue =
    rsi14[i];

  const atrValue =
    atr14[i];

  const macdLine =
    macdData.line[i];

  const macdSignal =
    macdData.signal[i];

  const macdHistogram =
    macdData.histogram[i];

  const adxValue =
    adx14[i];

  if (e20 == null) {
    throw new Error(
      `${interval}: EMA20 داده کافی ندارد.`
    );
  }

  if (e50 == null) {
    throw new Error(
      `${interval}: EMA50 داده کافی ندارد.`
    );
  }

  if (e200 == null) {
    throw new Error(
      `${interval}: EMA200 داده کافی ندارد.`
    );
  }

  if (rsiValue == null) {
    throw new Error(
      `${interval}: RSI داده کافی ندارد.`
    );
  }

  if (atrValue == null) {
    throw new Error(
      `${interval}: ATR داده کافی ندارد.`
    );
  }

  let bull = 0;
  let bear = 0;

  // EMA trend
  if (
    close > e20 &&
    e20 > e50 &&
    e50 > e200
  ) {
    bull += 30;
  } else if (
    close < e20 &&
    e20 < e50 &&
    e50 < e200
  ) {
    bear += 30;
  } else {
    if (close > e20) {
      bull += 10;
    }

    if (close < e20) {
      bear += 10;
    }

    if (e20 > e50) {
      bull += 8;
    }

    if (e20 < e50) {
      bear += 8;
    }

    if (e50 > e200) {
      bull += 7;
    }

    if (e50 < e200) {
      bear += 7;
    }
  }

  // RSI
  if (rsiValue >= 55) {
    bull += 12;
  } else if (rsiValue <= 45) {
    bear += 12;
  }

  // MACD
  if (
    macdLine != null &&
    macdSignal != null
  ) {
    if (
      macdLine > macdSignal &&
      macdHistogram > 0
    ) {
      bull += 12;
    } else if (
      macdLine < macdSignal &&
      macdHistogram < 0
    ) {
      bear += 12;
    }
  }

  // ADX
  if (
    adxValue != null &&
    adxValue >= 20
  ) {
    if (bull > bear) {
      bull += 8;
    } else if (bear > bull) {
      bear += 8;
    }
  }

  // Volume
  const volRatio =
    volumeRatio(candles, 20);

  if (volRatio >= 1.2) {
    if (bull > bear) {
      bull += 6;
    } else if (bear > bull) {
      bear += 6;
    }
  }

  const structure =
    marketStructure(candles);

  if (structure === "صعودی") {
    bull += 10;
  }

  if (structure === "نزولی") {
    bear += 10;
  }

  const sr =
    supportResistance(candles);

  const patterns =
    candlePatterns(candles);

  let patternBull = false;
  let patternBear = false;

  for (const p of patterns) {
    if (
      [
        "چکش",
        "پوشای صعودی",
        "پین‌بار صعودی"
      ].includes(p)
    ) {
      patternBull = true;
    }

    if (
      [
        "شهاب‌سنگ",
        "پوشای نزولی",
        "پین‌بار نزولی"
      ].includes(p)
    ) {
      patternBear = true;
    }
  }

  if (patternBull) {
    bull += 5;
  }

  if (patternBear) {
    bear += 5;
  }

  const total =
    bull + bear;

  let direction =
    "خنثی";

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

  const strength =
    total > 0
      ? Math.abs(bull - bear) / total
      : 0;

  const score =
    Math.round(
      clamp(
        50 + strength * 40,
        0,
        95
      )
    );

  return {
    interval,
    direction,
    score,
    bull,
    bear,
    close,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    rsi: rsiValue,
    atr: atrValue,
    macd: macdLine,
    macdSignal,
    macdHistogram,
    adx: adxValue,
    volumeRatio: volRatio,
    structure,
    support: sr.support,
    resistance: sr.resistance,
    patterns,
    candleTime:
      candles[i].time
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

  const total =
    bull + bear;

  const edge =
    Math.abs(bull - bear);

  let direction =
    "خنثی";

  if (
    bull > bear &&
    edge >= 10
  ) {
    direction = "خرید";
  }

  if (
    bear > bull &&
    edge >= 10
  ) {
    direction = "فروش";
  }

  const edgeScore =
    total > 0
      ? clamp(
          edge / total,
          0,
          1
        ) * 35
      : 0;

  const directionScore =
    direction === "خنثی"
      ? 0
      : 15;

  const score =
    Math.round(
      clamp(
        50 +
        edgeScore +
        directionScore,
        0,
        95
      )
    );

  return {
    direction,
    score,
    bull,
    bear
  };
}

// ============================================================
// جهت تایم‌فریم پایین‌تر
// ============================================================

function lowerTfAlignment(
  a5m,
  a15
) {
  let buy = 0;
  let sell = 0;

  if (a5m.direction === "خرید") {
    buy++;
  }

  if (a15.direction === "خرید") {
    buy++;
  }

  if (a5m.direction === "فروش") {
    sell++;
  }

  if (a15.direction === "فروش") {
    sell++;
  }

  if (
    buy >= MIN_LOWER_TF_ALIGNMENT &&
    buy > sell
  ) {
    return {
      direction: "خرید",
      count: buy
    };
  }

  if (
    sell >= MIN_LOWER_TF_ALIGNMENT &&
    sell > buy
  ) {
    return {
      direction: "فروش",
      count: sell
    };
  }

  return {
    direction: "خنثی",
    count: 0
  };
}

// ============================================================
// BTC CONTEXT
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
      analyzeTimeframe(
        h1,
        "BTC 1h"
      );

    const a4 =
      analyzeTimeframe(
        h4,
        "BTC 4h"
      );

    const combined =
      combineAnalysis(
        {
          ...a1,
          bull: a1.bull,
          bear: a1.bear
        },
        {
          ...a1,
          bull: a1.bull,
          bear: a1.bear
        },
        a1,
        a4
      );

    return {
      direction:
        combined.direction,
      score:
        combined.score,
      bull:
        combined.bull,
      bear:
        combined.bear,
      h1: a1,
      h4: a4
    };
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
// DERIVATIVES
// ============================================================

async function getFundingRate(symbol) {
  try {
    const data =
      await fetchJson(
        `${BASE_URL}/quote/v1/contract/fundingRate` +
        `?symbol=${encodeURIComponent(symbol)}`
      );

    const value =
      data?.fundingRate ??
      data?.data?.fundingRate ??
      data?.rate ??
      data?.data?.rate;

    return safeNumber(value, null);
  } catch (error) {
    console.error(
      "funding error",
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
        `${BASE_URL}/quote/v1/contract/openInterest` +
        `?symbol=${encodeURIComponent(symbol)}`
      );

    const value =
      data?.openInterest ??
      data?.data?.openInterest ??
      data?.oi ??
      data?.data?.oi;

    return safeNumber(value, null);
  } catch (error) {
    console.error(
      "open interest error",
      symbol,
      error
    );

    return null;
  }
}

async function getLongShortRatio(symbol) {
  try {
    const data =
      await fetchJson(
        `${BASE_URL}/quote/v1/contract/accountRatio` +
        `?symbol=${encodeURIComponent(symbol)}`
      );

    const value =
      data?.longShortRatio ??
      data?.data?.longShortRatio ??
      data?.ratio ??
      data?.data?.ratio;

    return safeNumber(value, null);
  } catch (error) {
    console.error(
      "long short error",
      symbol,
      error
    );

    return null;
  }
}

async function enrichDerivatives(
  items
) {
  const targets =
    items
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

  if (!targets.length) {
    return items;
  }

  const map =
    new Map();

  await Promise.all(
    targets.map(
      async item => {
        const [
          funding,
          openInterest,
          longShort
        ] = await Promise.all([
          getFundingRate(
            item.symbol
          ),
          getOpenInterest(
            item.symbol
          ),
          getLongShortRatio(
            item.symbol
          )
        ]);

        map.set(
          item.symbol,
          {
            funding,
            openInterest,
            longShort
          }
        );
      }
    )
  );

  return items.map(
    item => ({
      ...item,
      derivatives:
        map.get(item.symbol) || null
    })
  );
}

// ============================================================
// پیشنهاد اهرم آزمایشی
// ============================================================

function trialLeverage(
  score,
  atrPercent,
  direction
) {
  if (
    direction === "خنثی"
  ) {
    return 1;
  }

  let leverage = 2;

  if (score >= 90) {
    leverage = 5;
  } else if (score >= 85) {
    leverage = 4;
  } else if (score >= 78) {
    leverage = 3;
  }

  if (
    atrPercent > 5
  ) {
    leverage = Math.max(
      1,
      leverage - 1
    );
  }

  if (
    atrPercent > 8
  ) {
    leverage = 1;
  }

  return leverage;
}

// ============================================================
// ENTRY / SL / TP
// ============================================================

function buildTradeLevels(
  item
) {
  const price =
    safeNumber(
      item.price ??
      item.a15?.close ??
      item.a5?.close
    );

  if (!price) {
    return null;
  }

  const atrValue =
    safeNumber(
      item.a15?.atr ??
      item.a5?.atr
    );

  if (!atrValue) {
    return null;
  }

  const atrPercent =
    (atrValue / price) * 100;

  const direction =
    item.direction;

  let entry = price;
  let sl;
  let tp1;
  let tp2;

  if (
    direction === "خرید"
  ) {
    sl =
      price -
      atrValue * 1.5;

    tp1 =
      price +
      atrValue * 1.5;

    tp2 =
      price +
      atrValue * 2.5;
  } else if (
    direction === "فروش"
  ) {
    sl =
      price +
      atrValue * 1.5;

    tp1 =
      price -
      atrValue * 1.5;

    tp2 =
      price -
      atrValue * 2.5;
  } else {
    return null;
  }

  const risk =
    Math.abs(
      entry - sl
    );

  const reward1 =
    Math.abs(
      tp1 - entry
    );

  const reward2 =
    Math.abs(
      tp2 - entry
    );

  const rr1 =
    risk > 0
      ? reward1 / risk
      : 0;

  const rr2 =
    risk > 0
      ? reward2 / risk
      : 0;

  const leverage =
    trialLeverage(
      item.score,
      atrPercent,
      direction
    );

  return {
    entry,
    sl,
    tp1,
    tp2,
    atr: atrValue,
    atrPercent,
    rr1,
    rr2,
    leverage
  };
}

// ============================================================
// RISK / POSITION SIZE
// ============================================================

function calculatePosition(
  trade
) {
  const budget =
    PAPER_BUDGET;

  const riskCapital =
    budget *
    (RISK_PERCENT / 100);

  const riskPerUnit =
    Math.abs(
      trade.entry -
      trade.sl
    );

  if (
    riskPerUnit <= 0 ||
    !trade.entry
  ) {
    return {
      margin: 0,
      positionValue: 0,
      quantity: 0
    };
  }

  const quantity =
    riskCapital /
    riskPerUnit;

  const positionValue =
    quantity *
    trade.entry;

  const margin =
    positionValue /
    Math.max(
      1,
      trade.leverage
    );

  return {
    riskCapital,
    quantity,
    positionValue,
    margin
  };
}

// ============================================================
// FEES
// ============================================================

function estimateEntryFee(
  positionValue
) {
  return (
    Math.abs(positionValue) *
    PAPER_ENTRY_FEE
  );
}

function estimateExitFee(
  positionValue
) {
  return (
    Math.abs(positionValue) *
    PAPER_EXIT_FEE
  );
}

function estimateFunding(
  positionValue,
  fundingRate,
  durationHours
) {
  if (
    !Number.isFinite(
      fundingRate
    ) ||
    !Number.isFinite(
      durationHours
    )
  ) {
    return 0;
  }

  const intervals =
    durationHours /
    FUNDING_INTERVAL_HOURS;

  return (
    Math.abs(positionValue) *
    fundingRate *
    intervals
  );
}

// ============================================================
// PAPER PNL
// ============================================================

function calculateGrossPnl(
  direction,
  entry,
  exit,
  quantity
) {
  if (
    direction === "خرید"
  ) {
    return (
      (exit - entry) *
      quantity
    );
  }

  if (
    direction === "فروش"
  ) {
    return (
      (entry - exit) *
      quantity
    );
  }

  return 0;
}

function calculateNetPnl(
  trade,
  exitPrice,
  exitTime,
  fundingRate = null
) {
  const entry =
    safeNumber(
      trade.entryPrice
    );

  const quantity =
    safeNumber(
      trade.quantity
    );

  const positionValue =
    safeNumber(
      trade.positionValue
    );

  const gross =
    calculateGrossPnl(
      trade.direction,
      entry,
      exitPrice,
      quantity
    );

  const entryFee =
    safeNumber(
      trade.entryFee
    );

  const exitFee =
    estimateExitFee(
      positionValue
    );

  const durationHours =
    Math.max(
      0,
      (
        safeNumber(exitTime) -
        safeNumber(
          trade.entryTime
        )
      ) / 3600000
    );

  let funding = 0;

  if (
    fundingRate != null
  ) {
    funding =
      estimateFunding(
        positionValue,
        fundingRate,
        durationHours
      );
  }

  const net =
    gross -
    entryFee -
    exitFee -
    funding;

  const margin =
    safeNumber(
      trade.margin
    );

  const returnOnMargin =
    margin > 0
      ? (
          net / margin
        ) * 100
      : 0;

  return {
    gross,
    entryFee,
    exitFee,
    funding,
    net,
    returnOnMargin,
    durationHours
  };
}

// ============================================================
// KV HELPERS
// ============================================================

const KV_KEY_OPEN =
  "paper_open_trades";

const KV_KEY_CLOSED =
  "paper_closed_trades";

const KV_KEY_STATS =
  "paper_stats";

const KV_KEY_LAST_SCAN =
  "last_scan";

async function kvGetJson(
  env,
  key,
  fallback
) {
  if (
    !env.ALGO_ESMAIL_KV
  ) {
    return fallback;
  }

  try {
    const value =
      await env.ALGO_ESMAIL_KV.get(
        key
      );

    if (!value) {
      return fallback;
    }

    return JSON.parse(value);
  } catch (error) {
    console.error(
      "KV get error",
      key,
      error
    );

    return fallback;
  }
}

async function kvPutJson(
  env,
  key,
  value
) {
  if (
    !env.ALGO_ESMAIL_KV
  ) {
    throw new Error(
      "ALGO_ESMAIL_KV تنظیم نشده است."
    );
  }

  await env.ALGO_ESMAIL_KV.put(
    key,
    JSON.stringify(value)
  );
}

// ============================================================
// PAPER TRADE STORAGE
// ============================================================

async function getOpenTrades(env) {
  return kvGetJson(
    env,
    KV_KEY_OPEN,
    []
  );
}

async function getClosedTrades(env) {
  return kvGetJson(
    env,
    KV_KEY_CLOSED,
    []
  );
}

async function saveOpenTrades(
  env,
  trades
) {
  return kvPutJson(
    env,
    KV_KEY_OPEN,
    trades
  );
}

async function saveClosedTrades(
  env,
  trades
) {
  return kvPutJson(
    env,
    KV_KEY_CLOSED,
    trades
  );
}

// ============================================================
// STATS
// ============================================================

function calculateStats(
  closedTrades
) {
  const trades =
    Array.isArray(
      closedTrades
    )
      ? closedTrades
      : [];

  let wins = 0;
  let losses = 0;
  let breakeven = 0;

  let pnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (
    const trade of trades
  ) {
    const net =
      safeNumber(
        trade.netPnl
      );

    pnl += net;

    if (net > 0) {
      wins++;
      grossProfit += net;
    } else if (net < 0) {
      losses++;
      grossLoss += Math.abs(net);
    } else {
      breakeven++;
    }
  }

  const total =
    trades.length;

  const winRate =
    total > 0
      ? (
          wins / total
        ) * 100
      : 0;

  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;

  return {
    total,
    wins,
    losses,
    breakeven,
    winRate,
    pnl,
    grossProfit,
    grossLoss,
    profitFactor
  };
}

async function saveStats(
  env,
  stats
) {
  await kvPutJson(
    env,
    KV_KEY_STATS,
    stats
  );
}

async function getStats(env) {
  const closed =
    await getClosedTrades(
      env
    );

  return calculateStats(
    closed
  );
}

// ============================================================
// SIGNAL OBJECT
// ============================================================

function buildSignal(
  symbol,
  ticker,
  a5,
  a15,
  a1,
  a4,
  combined,
  btcContext
) {
  const lower =
    lowerTfAlignment(
      a5,
      a15
    );

  let direction =
    combined.direction;

  if (
    lower.direction !== "خنثی" &&
    direction !== lower.direction
  ) {
    direction = "خنثی";
  }

  const item = {
    symbol,
    price:
      safeNumber(
        ticker?.price
      ),
    volume:
      safeNumber(
        ticker?.volume
      ),
    change:
      safeNumber(
        ticker?.change
      ),
    direction,
    score:
      combined.score,
    bull:
      combined.bull,
    bear:
      combined.bear,
    lowerAlignment:
      lower.count,
    a5,
    a15,
    a1,
    a4,
    btcContext
  };

  const levels =
    buildTradeLevels(
      item
    );

  if (levels) {
    Object.assign(
      item,
      levels
    );

    const position =
      calculatePosition(
        levels
      );

    Object.assign(
      item,
      position
    );
  }

  return item;
}

// ============================================================
// ANALYZE SYMBOL
// ============================================================

async function analyzeSymbol(
  symbol,
  ticker,
  btcContext
) {
  try {
    const results =
      await Promise.allSettled([
        getKlines(
          symbol,
          "5m",
          160
        ),
        getKlines(
          symbol,
          "15m",
          160
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

    const timeframeNames = [
      "5m",
      "15m",
      "1h",
      "4h"
    ];

    const failedFrames =
      results
        .map(
          (result, index) => {
            if (
              result.status !==
              "rejected"
            ) {
              return null;
            }

            const reason =
              result.reason;

            return (
              `${timeframeNames[index]}: ` +
              `${
                reason?.message ??
                String(reason)
              }`
            );
          }
        )
        .filter(Boolean);

    if (
      failedFrames.length
    ) {
      throw new Error(
        failedFrames.join(
          " | "
        )
      );
    }

    const [
      c5,
      c15,
      c1,
      c4
    ] =
      results.map(
        x => x.value
      );

    const a5 =
      analyzeTimeframe(
        c5,
        "5m"
      );

    const a15 =
      analyzeTimeframe(
        c15,
        "15m"
      );

    const a1 =
      analyzeTimeframe(
        c1,
        "1h"
      );

    const a4 =
      analyzeTimeframe(
        c4,
        "4h"
      );

    const combined =
      combineAnalysis(
        a5,
        a15,
        a1,
        a4
      );

    return buildSignal(
      symbol,
      ticker,
      a5,
      a15,
      a1,
      a4,
      combined,
      btcContext
    );
  } catch (error) {
    console.error(
      "analyzeSymbol error",
      symbol,
      error
    );

    return {
      symbol,
      price:
        safeNumber(
          ticker?.price
        ),
      volume:
        safeNumber(
          ticker?.volume
        ),
      change:
        safeNumber(
          ticker?.change
        ),
      direction: "خنثی",
      score: 0,
      bull: 0,
      bear: 0,
      failed: true,
      error:
        error?.message ??
        String(error)
    };
  }
}

// ============================================================
// SCAN
// ============================================================

async function performScan(
  env
) {
  const started =
    Date.now();

  const symbols =
    await getBestSymbols();

  const btcPromise =
    getBTCContext();

  const results = [];

  for (
    let i = 0;
    i < symbols.length;
    i += ANALYSIS_BATCH
  ) {
    const batch =
      symbols.slice(
        i,
        i + ANALYSIS_BATCH
      );

    const batchResults =
      await Promise.all(
        batch.map(
          item =>
            analyzeSymbol(
              item.symbol,
              item,
              null
            )
        )
      );

    results.push(
      ...batchResults
    );
  }

  const btcContext =
    await btcPromise;

  const enriched =
    await enrichDerivatives(
      results.map(
        x => ({
          ...x,
          btcContext
        })
      )
    );

  const elapsed =
    Date.now() - started;

  return {
    symbols,
    results: enriched,
    btcContext,
    elapsed
  };
}

// ============================================================
// PAPER TRADE
// ============================================================

function makePaperTrade(
  item
) {
  if (
    item.failed ||
    item.direction === "خنثی" ||
    item.score <
      MIN_SIGNAL_SCORE
  ) {
    return null;
  }

  if (
    !item.entry ||
    !item.sl ||
    !item.tp1 ||
    !item.tp2
  ) {
    return null;
  }

  const now =
    Date.now();

  const position =
    calculatePosition(
      item
    );

  const entryFee =
    estimateEntryFee(
      position.positionValue
    );

  return {
    id:
      `${item.symbol}-${now}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    symbol:
      item.symbol,

    direction:
      item.direction,

    score:
      item.score,

    entryPrice:
      item.entry,

    sl:
      item.sl,

    tp1:
      item.tp1,

    tp2:
      item.tp2,

    leverage:
      item.leverage,

    quantity:
      position.quantity,

    positionValue:
      position.positionValue,

    margin:
      position.margin,

    riskCapital:
      position.riskCapital,

    entryFee,

    entryTime:
      now,

    status:
      "open",

    exitPrice:
      null,

    exitTime:
      null,

    closeReason:
      null,

    grossPnl:
      null,

    exitFee:
      null,

    funding:
      null,

    netPnl:
      null,

    returnOnMargin:
      null,

    durationHours:
      null,

    createdAt:
      now
  };
}

function hasSimilarOpenTrade(
  openTrades,
  item
) {
  return openTrades.some(
    trade =>
      trade.symbol ===
        item.symbol &&
      trade.direction ===
        item.direction &&
      trade.status === "open"
  );
}

async function recordPaperTrades(
  results,
  env
) {
  const openTrades =
    await getOpenTrades(
      env
    );

  const candidates =
    results
      .filter(
        x =>
          !x.failed &&
          x.direction !==
            "خنثی" &&
          x.score >=
            MIN_SIGNAL_SCORE
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, 5);

  let saved = 0;
  let skipped = 0;

  for (
    const item of candidates
  ) {
    if (
      hasSimilarOpenTrade(
        openTrades,
        item
      )
    ) {
      skipped++;
      continue;
    }

    const trade =
      makePaperTrade(
        item
      );

    if (!trade) {
      skipped++;
      continue;
    }

    openTrades.push(
      trade
    );

    saved++;
  }

  if (saved > 0) {
    await saveOpenTrades(
      env,
      openTrades
    );
  }

  return {
    saved,
    skipped
  };
}

// ============================================================
// CHECK PAPER TRADES
// ============================================================

function isTradeClosedByPrice(
  trade,
  candle
) {
  if (
    trade.direction ===
    "خرید"
  ) {
    const hitSl =
      candle.low <=
      trade.sl;

    const hitTp =
      candle.high >=
      trade.tp1;

    if (
      hitSl &&
      hitTp
    ) {
      // در یک کندل که هر دو سطح لمس شده‌اند،
      // حالت محافظه‌کارانه: SL اول فرض می‌شود.
      return {
        closed: true,
        price:
          trade.sl,
        reason:
          "SL"
      };
    }

    if (hitSl) {
      return {
        closed: true,
        price:
          trade.sl,
        reason:
          "SL"
      };
    }

    if (hitTp) {
      return {
        closed: true,
        price:
          trade.tp1,
        reason:
          "TP1"
      };
    }
  }

  if (
    trade.direction ===
    "فروش"
  ) {
    const hitSl =
      candle.high >=
      trade.sl;

    const hitTp =
      candle.low <=
      trade.tp1;

    if (
      hitSl &&
      hitTp
    ) {
      return {
        closed: true,
        price:
          trade.sl,
        reason:
          "SL"
      };
    }

    if (hitSl) {
      return {
        closed: true,
        price:
          trade.sl,
        reason:
          "SL"
      };
    }

    if (hitTp) {
      return {
        closed: true,
        price:
          trade.tp1,
        reason:
          "TP1"
      };
    }
  }

  return {
    closed: false
  };
}

async function checkPaperTrades(
  env
) {
  const openTrades =
    await getOpenTrades(
      env
    );

  if (!openTrades.length) {
    return {
      checked: 0,
      closed: [],
      remaining: []
    };
  }

  const now =
    Date.now();

  const remaining = [];
  const closed = [];

  for (
    const trade of openTrades
  ) {
    if (
      trade.status !== "open"
    ) {
      continue;
    }

    const ageHours =
      (
        now -
        safeNumber(
          trade.entryTime
        )
      ) / 3600000;

    if (
      ageHours >=
      MAX_OPEN_TRADE_AGE_HOURS
    ) {
      let lastPrice =
        trade.entryPrice;

      try {
        const candles =
          await getKlines(
            trade.symbol,
            "15m",
            5
          );

        if (
          candles.length
        ) {
          lastPrice =
            candles[
              candles.length - 1
            ].close;
        }
      } catch (
        error
      ) {
        console.error(
          "timeout price error",
          trade.symbol,
          error
        );
      }

      const pnl =
        calculateNetPnl(
          trade,
          lastPrice,
          now,
          null
        );

      const closedTrade =
        {
          ...trade,
          status:
            "closed",
          exitPrice:
            lastPrice,
          exitTime:
            now,
          closeReason:
            "TIMEOUT",
          grossPnl:
            pnl.gross,
          exitFee:
            pnl.exitFee,
          funding:
            pnl.funding,
          netPnl:
            pnl.net,
          returnOnMargin:
            pnl.returnOnMargin,
          durationHours:
            pnl.durationHours
        };

      closed.push(
        closedTrade
      );

      continue;
    }

    try {
      const candles =
        await getKlines(
          trade.symbol,
          "15m",
          PAPER_CHECK_CANDLES,
          trade.entryTime
        );

      let closeResult =
        null;

      for (
        const candle of candles
      ) {
        if (
          candle.time <=
          trade.entryTime
        ) {
          continue;
        }

        const result =
          isTradeClosedByPrice(
            trade,
            candle
          );

        if (
          result.closed
        ) {
          closeResult =
            {
              ...result,
              time:
                candle.time
            };

          break;
        }
      }

      if (
        closeResult
      ) {
        const pnl =
          calculateNetPnl(
            trade,
            closeResult.price,
            closeResult.time,
            null
          );

        const closedTrade =
          {
            ...trade,
            status:
              "closed",
            exitPrice:
              closeResult.price,
            exitTime:
              closeResult.time,
            closeReason:
              closeResult.reason,
            grossPnl:
              pnl.gross,
            exitFee:
              pnl.exitFee,
            funding:
              pnl.funding,
            netPnl:
              pnl.net,
            returnOnMargin:
              pnl.returnOnMargin,
            durationHours:
              pnl.durationHours
          };

        closed.push(
          closedTrade
        );
      } else {
        remaining.push(
          trade
        );
      }
    } catch (
      error
    ) {
      console.error(
        "paper check error",
        trade.symbol,
        error
      );

      remaining.push(
        trade
      );
    }
  }

  await saveOpenTrades(
    env,
    remaining
  );

  if (
    closed.length
  ) {
    const previous =
      await getClosedTrades(
        env
      );

    const merged =
      [
        ...previous,
        ...closed
      ].slice(
        -500
      );

    await saveClosedTrades(
      env,
      merged
    );

    await saveStats(
      env,
      calculateStats(
        merged
      )
    );
  }

  return {
    checked:
      openTrades.length,
    closed,
    remaining
  };
}

// ============================================================
// گزارش بسته‌شدن معاملات
// ============================================================

function buildClosedTradeMessage(
  trade
) {
  const result =
    trade.netPnl > 0
      ? "🟢 سود"
      : trade.netPnl < 0
        ? "🔴 زیان"
        : "⚪ سر‌به‌سر";

  return (
    `🚨 *بسته‌شدن معامله آزمایشی*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `ارز: \`${trade.symbol}\`\n` +
    `جهت: *${trade.direction}*\n` +
    `امتیاز: ${trade.score}/100\n` +
    `اهرم: ${trade.leverage}x\n\n` +
    `ورود: ${formatNumber(
      trade.entryPrice
    )}\n` +
    `خروج: ${formatNumber(
      trade.exitPrice
    )}\n` +
    `علت: *${trade.closeReason}*\n\n` +
    `سود/زیان ناخالص: ${formatNumber(
      trade.grossPnl
    )} USDT\n` +
    `کارمزد خروج: ${formatNumber(
      trade.exitFee
    )} USDT\n` +
    `Funding: ${formatNumber(
      trade.funding
    )} USDT\n\n` +
    `${result}: *${formatNumber(
      trade.netPnl
    )} USDT*\n` +
    `بازده روی مارجین: *${percent(
      trade.returnOnMargin
    )}*\n` +
    `مدت معامله: ${formatDuration(
      trade.entryTime,
      trade.exitTime
    )}`
  );
}

// ============================================================
// SCAN REPORT
// ============================================================

function buildScanReport(
  scan,
  paperResult,
  paperCheck
) {
  const {
    symbols,
    results,
    btcContext,
    elapsed
  } = scan;

  const successful =
    results.filter(
      x => !x.failed
    );

  const failed =
    results.filter(
      x => x.failed
    );

  const opportunities =
    successful
      .filter(
        x =>
          x.direction !==
            "خنثی" &&
          x.score >=
            MIN_SIGNAL_SCORE
      )
      .sort(
        (a, b) =>
          b.score - a.score
      );

  const repeated =
    successful.filter(
      x =>
        x.direction !==
          "خنثی" &&
        x.score >=
          MIN_SIGNAL_SCORE
    ).length -
    paperResult.saved;

  const failureSummary =
    failed
      .slice(0, 5)
      .map(
        x =>
          `${x.symbol}: ${
            x.error ||
            "خطای نامشخص"
          }`
      )
      .join("\n");

  let text =
    `🤖 *ALGO FJM V5.3*\n\n` +
    `اسکن بازار توبیت تمام شد.\n\n` +
    `⏱ زمان اسکن: ${
      (elapsed / 1000).toFixed(1)
    } ثانیه\n` +
    `💰 ارزهای بررسی‌شده: ${
      symbols.length
    }\n` +
    `✅ تحلیل موفق: ${
      successful.length
    }\n` +
    `❌ ناموفق: ${
      failed.length
    }\n` +
    `₿ وضعیت کلی BTC: *${
      btcContext.direction
    }*\n` +
    `🎯 معاملات آزمایشی جدید: ${
      paperResult.saved
    }\n` +
    `🔁 سیگنال‌های تکراری: ${
      Math.max(0, repeated)
    }\n` +
    `📊 معاملات قبلی بررسی‌شده: ${
      paperCheck.checked
    }\n`;

  if (
    opportunities.length
  ) {
    text +=
      `\n━━━━━━━━━━━━━━━━━━\n\n` +
      `🔥 *فرصت‌های برتر*\n`;

    for (
      const item of
      opportunities.slice(
        0,
        5
      )
    ) {
      text +=
        `\n🟢 ${item.symbol}\n` +
        `↳ جهت: *${item.direction}*\n` +
        `↳ امتیاز: *${item.score}/100*\n` +
        `↳ ورود: ${formatNumber(
          item.entry
        )}\n` +
        `↳ حد ضرر: ${formatNumber(
          item.sl
        )}\n` +
        `↳ هدف اول: ${formatNumber(
          item.tp1
        )}\n` +
        `↳ هدف دوم: ${formatNumber(
          item.tp2
        )}\n` +
        `↳ اهرم آزمایشی: ${
          item.leverage
        }x\n` +
        `↳ R:R اول: ${
          item.rr1.toFixed(2)
        }\n`;
    }
  } else {
    text +=
      `\n━━━━━━━━━━━━━━━━━━\n\n` +
      `⚪ *در حال حاضر فرصت قدرتمند پیدا نشد.*\n\n` +
      `امتیاز حداقل سیگنال: ${MIN_SIGNAL_SCORE}/100\n\n` +
      `بازار فعلاً شرایط مناسبی برای ورود پرریسک نشان نمی‌دهد.`;
  }

  if (
    failed.length
  ) {
    text +=
      `\n━━━━━━━━━━━━━━━━━━\n\n` +
      `🧪 *جزئیات خطاهای تحلیل*\n`;

    for (
      const item of
      failed.slice(0, 8)
    ) {
      const reason =
        String(
          item.error ||
          "خطای نامشخص"
        )
          .replace(
            /\s+/g,
            " "
          )
          .slice(
            0,
            300
          );

      text +=
        `\n❌ ${item.symbol}\n` +
        `↳ ${reason}\n`;
    }
  }

  return text;
}

// ============================================================
// DASHBOARD
// ============================================================

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🔍 اسکن بازار",
          callback_data: "scan"
        },
        {
          text: "📊 آمار",
          callback_data: "stats"
        }
      ],
      [
        {
          text: "📈 معاملات باز",
          callback_data: "open"
        },
        {
          text: "📜 تاریخچه",
          callback_data: "history"
        }
      ],
      [
        {
          text: "⚙️ وضعیت ربات",
          callback_data: "status"
        }
      ]
    ]
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🔙 بازگشت",
          callback_data: "menu"
        }
      ]
    ]
  };
}

function dashboardText() {
  return (
    `🤖 *ALGO FJM V5.3*\n\n` +
    `سیستم تحلیل و Paper Trade معاملات Futures توبیت\n\n` +
    `از منوی زیر انتخاب کن:`
  );
}

async function showDashboard(
  chatId,
  env,
  messageId = null
) {
  const data = {
    chat_id:
      chatId,
    text:
      dashboardText(),
    parse_mode:
      "Markdown",
    reply_markup:
      mainKeyboard()
  };

  if (
    messageId
  ) {
    data.message_id =
      messageId;

    return telegram(
      "editMessageText",
      data,
      env
    );
  }

  return sendMessage(
    chatId,
    dashboardText(),
    env,
    {
      parse_mode:
        "Markdown",
      reply_markup:
        mainKeyboard()
    }
  );
}

// ============================================================
// STATUS
// ============================================================

async function buildStatus(
  env
) {
  const open =
    await getOpenTrades(
      env
    );

  const closed =
    await getClosedTrades(
      env
    );

  return (
    `⚙️ *وضعیت ALGO FJM V5.3*\n\n` +
    `🟢 وضعیت: فعال\n` +
    `📡 بازار: Toobit Futures\n` +
    `📊 نمادهای اسکن: ${MAX_ANALYSIS_SYMBOLS}\n` +
    `🎯 حداقل امتیاز: ${MIN_SIGNAL_SCORE}/100\n` +
    `💼 معاملات باز: ${open.length}\n` +
    `📜 معاملات بسته: ${closed.length}\n` +
    `💰 بودجه Paper: ${PAPER_BUDGET} USDT\n` +
    `⚠️ ریسک هر معامله: ${RISK_PERCENT}%`
  );
}

// ============================================================
// OPEN TRADES REPORT
// ============================================================

function buildOpenTradesReport(
  trades
) {
  if (
    !trades.length
  ) {
    return (
      `📈 *معاملات باز*\n\n` +
      `در حال حاضر معامله آزمایشی بازی وجود ندارد.`
    );
  }

  let text =
    `📈 *معاملات باز*\n\n`;

  for (
    const trade of trades
  ) {
    text +=
      `━━━━━━━━━━━━━━━━━━\n` +
      `💰 ${trade.symbol}\n` +
      `↳ جهت: *${trade.direction}*\n` +
      `↳ امتیاز: ${trade.score}/100\n` +
      `↳ ورود: ${formatNumber(
        trade.entryPrice
      )}\n` +
      `↳ SL: ${formatNumber(
        trade.sl
      )}\n` +
      `↳ TP1: ${formatNumber(
        trade.tp1
      )}\n` +
      `↳ TP2: ${formatNumber(
        trade.tp2
      )}\n` +
      `↳ اهرم: ${trade.leverage}x\n` +
      `↳ مارجین: ${formatNumber(
        trade.margin
      )} USDT\n` +
      `↳ زمان ورود: ${
        formatDate(
          trade.entryTime
        )
      }\n`;
  }

  return text;
}

// ============================================================
// STATS REPORT
// ============================================================

function buildStatsReport(
  stats
) {
  const pf =
    Number.isFinite(
      stats.profitFactor
    )
      ? stats.profitFactor.toFixed(2)
      : "∞";

  return (
    `📊 *آمار Paper Trade*\n\n` +
    `معاملات بسته: ${stats.total}\n` +
    `🟢 برد: ${stats.wins}\n` +
    `🔴 باخت: ${stats.losses}\n` +
    `⚪ سر‌به‌سر: ${stats.breakeven}\n\n` +
    `نرخ برد: *${stats.winRate.toFixed(1)}%*\n` +
    `سود/زیان خالص: *${formatNumber(
      stats.pnl
    )} USDT*\n` +
    `Profit Factor: *${pf}*`
  );
}

// ============================================================
// HISTORY REPORT
// ============================================================

function buildHistoryReport(
  trades,
  limit = DEFAULT_HISTORY_LIMIT
) {
  const safeLimit =
    clamp(
      safeNumber(
        limit,
        DEFAULT_HISTORY_LIMIT
      ),
      1,
      MAX_HISTORY_LIMIT
    );

  const recent =
    trades.slice(
      -safeLimit
    ).reverse();

  if (
    !recent.length
  ) {
    return (
      `📜 *تاریخچه معاملات*\n\n` +
      `هنوز معامله بسته‌شده‌ای ثبت نشده است.`
    );
  }

  let text =
    `📜 *آخرین ${recent.length} معامله*\n\n`;

  for (
    const trade of recent
  ) {
    const icon =
      safeNumber(
        trade.netPnl
      ) >= 0
        ? "🟢"
        : "🔴";

    text +=
      `${icon} ${trade.symbol} | ` +
      `${trade.direction}\n` +
      `سود/زیان: *${formatNumber(
        trade.netPnl
      )} USDT*\n` +
      `علت: ${trade.closeReason}\n` +
      `زمان: ${formatDate(
        trade.exitTime
      )}\n\n`;
  }

  return text.trim();
}

// ============================================================
// SIGNAL DETAIL
// ============================================================

function buildSignalDetail(
  item
) {
  if (
    !item ||
    item.failed
  ) {
    return (
      `❌ اطلاعات تحلیل در دسترس نیست.`
    );
  }

  const derivatives =
    item.derivatives;

  return (
    `🔍 *جزئیات سیگنال ${item.symbol}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `جهت نهایی: *${item.direction}*\n` +
    `امتیاز: *${item.score}/100*\n` +
    `قدرت خرید: ${formatNumber(
      item.bull
    )}\n` +
    `قدرت فروش: ${formatNumber(
      item.bear
    )}\n\n` +

    `📊 *تایم‌فریم‌ها*\n` +
    `5m: ${item.a5.direction} | ${item.a5.score}/100\n` +
    `15m: ${item.a15.direction} | ${item.a15.score}/100\n` +
    `1h: ${item.a1.direction} | ${item.a1.score}/100\n` +
    `4h: ${item.a4.direction} | ${item.a4.score}/100\n\n` +

    `📐 *سطوح معامله*\n` +
    `ورود: ${formatNumber(
      item.entry
    )}\n` +
    `SL: ${formatNumber(
      item.sl
    )}\n` +
    `TP1: ${formatNumber(
      item.tp1
    )}\n` +
    `TP2: ${formatNumber(
      item.tp2
    )}\n` +
    `R:R اول: ${safeNumber(
      item.rr1
    ).toFixed(2)}\n` +
    `R:R دوم: ${safeNumber(
      item.rr2
    ).toFixed(2)}\n` +
    `اهرم آزمایشی: ${item.leverage}x\n\n` +

    `📈 *تکنیکال 15m*\n` +
    `RSI: ${safeNumber(
      item.a15.rsi
    ).toFixed(2)}\n` +
    `ADX: ${safeNumber(
      item.a15.adx
    ).toFixed(2)}\n` +
    `ساختار: ${item.a15.structure}\n` +
    `حجم: ${safeNumber(
      item.a15.volumeRatio
    ).toFixed(2)}x\n` +
    `الگو: ${
      item.a15.patterns.length
        ? item.a15.patterns.join(
            "، "
          )
        : "ندارد"
    }\n\n` +

    `₿ *BTC Context*\n` +
    `جهت: ${
      item.btcContext?.direction ??
      "نامشخص"
    }\n` +
    `امتیاز: ${
      item.btcContext?.score ??
      0
    }/100\n\n` +

    `📌 *مشتقات*\n` +
    `Funding: ${
      derivatives?.funding != null
        ? derivatives.funding
        : "نامشخص"
    }\n` +
    `Open Interest: ${
      derivatives?.openInterest != null
        ? formatNumber(
            derivatives.openInterest
          )
        : "نامشخص"
    }\n` +
    `Long/Short: ${
      derivatives?.longShort != null
        ? derivatives.longShort
        : "نامشخص"
    }`
  );
}

// ============================================================
// ANALYZE COMMAND
// ============================================================

async function analyzeSpecificSymbol(
  symbol,
  env
) {
  const tickers =
    await getAllTickers();

  const ticker =
    tickers.find(
      t =>
        tickerSymbol(t) ===
        symbol
    );

  const btc =
    await getBTCContext();

  const result =
    await analyzeSymbol(
      symbol,
      {
        symbol,
        price:
          tickerPrice(
            ticker || {}
          ),
        volume:
          tickerVolume(
            ticker || {}
          ),
        change:
          tickerChange(
            ticker || {}
          )
      },
      btc
    );

  if (
    result.failed
  ) {
    return (
      `❌ تحلیل ${symbol} ناموفق بود.\n\n` +
      `خطا:\n${result.error}`
    );
  }

  return buildSignalDetail(
    result
  );
}

// ============================================================
// CALLBACK QUERY ANSWER
// ============================================================

async function answerCallback(
  callbackQuery,
  env
) {
  try {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id:
          callbackQuery.id
      },
      env
    );
  } catch (
    error
  ) {
    console.error(
      "callback answer error",
      error
    );
  }
}

// ============================================================
// CALLBACK HANDLER
// ============================================================

async function handleCallback(
  callbackQuery,
  env
) {
  const data =
    callbackQuery.data;

  const chatId =
    callbackQuery.message
      ?.chat?.id;

  const messageId =
    callbackQuery.message
      ?.message_id;

  if (!chatId) {
    return;
  }

  await answerCallback(
    callbackQuery,
    env
  );

  if (
    data === "menu"
  ) {
    await showDashboard(
      chatId,
      env,
      messageId
    );

    return;
  }

  if (
    data === "status"
  ) {
    const text =
      await buildStatus(
        env
      );

    await telegram(
      "editMessageText",
      {
        chat_id:
          chatId,
        message_id:
          messageId,
        text,
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      },
      env
    );

    return;
  }

  if (
    data === "stats"
  ) {
    const stats =
      await getStats(
        env
      );

    await telegram(
      "editMessageText",
      {
        chat_id:
          chatId,
        message_id:
          messageId,
        text:
          buildStatsReport(
            stats
          ),
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      },
      env
    );

    return;
  }

  if (
    data === "open"
  ) {
    const open =
      await getOpenTrades(
        env
      );

    await telegram(
      "editMessageText",
      {
        chat_id:
          chatId,
        message_id:
          messageId,
        text:
          buildOpenTradesReport(
            open
          ),
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      },
      env
    );

    return;
  }

  if (
    data === "history"
  ) {
    const closed =
      await getClosedTrades(
        env
      );

    await telegram(
      "editMessageText",
      {
        chat_id:
          chatId,
        message_id:
          messageId,
        text:
          buildHistoryReport(
            closed,
            DEFAULT_HISTORY_LIMIT
          ),
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      },
      env
    );

    return;
  }

  if (
    data === "scan"
  ) {
    await sendMessage(
      chatId,
      "🔄 در حال اسکن بازار توبیت...",
      env
    );

    try {
      const paperCheck =
        await checkPaperTrades(
          env
        );

      const scan =
        await performScan(
          env
        );

      const paperResult =
        await recordPaperTrades(
          scan.results,
          env
        );

      const report =
        buildScanReport(
          scan,
          paperResult,
          paperCheck
        );

      await sendLongMessage(
        chatId,
        report,
        env,
        {
          parse_mode:
            "Markdown"
        }
      );

      for (
        const closedTrade of
        paperCheck.closed
      ) {
        await sendMessage(
          chatId,
          buildClosedTradeMessage(
            closedTrade
          ),
          env,
          {
            parse_mode:
              "Markdown"
          }
        );
      }
    } catch (
      error
    ) {
      await sendMessage(
        chatId,
        `❌ خطا در اسکن:\n${error.message}`,
        env
      );
    }

    return;
  }
}

// ============================================================
// COMMAND HANDLER
// ============================================================

async function handleCommand(
  message,
  env
) {
  const chatId =
    message.chat?.id;

  const text =
    String(
      message.text || ""
    ).trim();

  if (!chatId) {
    return;
  }

  if (
    text === "/start" ||
    text === "/menu"
  ) {
    await showDashboard(
      chatId,
      env
    );

    return;
  }

  if (
    text === "/scan"
  ) {
    await sendMessage(
      chatId,
      "🔄 در حال اسکن بازار توبیت...",
      env
    );

    try {
      const paperCheck =
        await checkPaperTrades(
          env
        );

      const scan =
        await performScan(
          env
        );

      const paperResult =
        await recordPaperTrades(
          scan.results,
          env
        );

      const report =
        buildScanReport(
          scan,
          paperResult,
          paperCheck
        );

      await sendLongMessage(
        chatId,
        report,
        env,
        {
          parse_mode:
            "Markdown"
        }
      );

      for (
        const closedTrade of
        paperCheck.closed
      ) {
        await sendMessage(
          chatId,
          buildClosedTradeMessage(
            closedTrade
          ),
          env,
          {
            parse_mode:
              "Markdown"
          }
        );
      }
    } catch (
      error
    ) {
      await sendMessage(
        chatId,
        `❌ خطا در اسکن:\n${error.message}`,
        env
      );
    }

    return;
  }

  if (
    text === "/stats"
  ) {
    const stats =
      await getStats(
        env
      );

    await sendMessage(
      chatId,
      buildStatsReport(
        stats
      ),
      env,
      {
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      }
    );

    return;
  }

  if (
    text === "/open"
  ) {
    const open =
      await getOpenTrades(
        env
      );

    await sendMessage(
      chatId,
      buildOpenTradesReport(
        open
      ),
      env,
      {
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      }
    );

    return;
  }

  if (
    text === "/history"
  ) {
    const closed =
      await getClosedTrades(
        env
      );

    await sendLongMessage(
      chatId,
      buildHistoryReport(
        closed
      ),
      env,
      {
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      }
    );

    return;
  }

  if (
    text === "/status"
  ) {
    await sendMessage(
      chatId,
      await buildStatus(
        env
      ),
      env,
      {
        parse_mode:
          "Markdown",
        reply_markup:
          backKeyboard()
      }
    );

    return;
  }

  if (
    text.startsWith(
      "/analyze "
    )
  ) {
    const symbol =
      text
        .slice(
          9
        )
        .trim()
        .toUpperCase();

    if (!symbol) {
      await sendMessage(
        chatId,
        "❌ نماد را وارد کن.",
        env
      );

      return;
    }

    try {
      await sendMessage(
        chatId,
        await analyzeSpecificSymbol(
          symbol,
          env
        ),
        env,
        {
          parse_mode:
            "Markdown",
          reply_markup:
            backKeyboard()
        }
      );
    } catch (
      error
    ) {
      await sendMessage(
        chatId,
        `❌ خطا:\n${error.message}`,
        env
      );
    }

    return;
  }

  await showDashboard(
    chatId,
    env
  );
}

// ============================================================
// WEBHOOK
// ============================================================

async function handleWebhook(
  request,
  env
) {
  let update;

  try {
    update =
      await request.json();
  } catch (
    error
  ) {
    return new Response(
      "Bad Request",
      {
        status: 400
      }
    );
  }

  if (
    update.callback_query
  ) {
    await handleCallback(
      update.callback_query,
      env
    );

    return new Response(
      "OK"
    );
  }

  if (
    update.message
  ) {
    await handleCommand(
      update.message,
      env
    );

    return new Response(
      "OK"
    );
  }

  return new Response(
    "OK"
  );
}

// ============================================================
// TELEGRAM WEBHOOK SETUP
// ============================================================

async function setWebhook(
  request,
  env
) {
  if (
    !env.BOT_TOKEN
  ) {
    return new Response(
      "BOT_TOKEN تنظیم نشده است.",
      {
        status: 500
      }
    );
  }

  const url =
    new URL(request.url);

  const webhookUrl =
    `${url.origin}/telegram`;

  const result =
    await telegram(
      "setWebhook",
      {
        url:
          webhookUrl
      },
      env
    );

  return new Response(
    JSON.stringify(
      result
    ),
    {
      headers: {
        "Content-Type":
          "application/json"
      }
    }
  );
}

// ============================================================
// HEALTH
// ============================================================

async function health(
  env
) {
  let kv = false;

  try {
    if (
      env.ALGO_ESMAIL_KV
    ) {
      await env.ALGO_ESMAIL_KV.get(
        KV_KEY_STATS
      );

      kv = true;
    }
  } catch (
    error
  ) {
    console.error(
      "health KV error",
      error
    );
  }

  return {
    ok: true,
    version:
      "V5.3",
    futures:
      true,
    kv
  };
}

// ============================================================
// SCHEDULED SCAN
// ============================================================

async function scheduledScan(
  env
) {
  try {
    const paperCheck =
      await checkPaperTrades(
        env
      );

    const scan =
      await performScan(
        env
      );

    const paperResult =
      await recordPaperTrades(
        scan.results,
        env
      );

    const report =
      buildScanReport(
        scan,
        paperResult,
        paperCheck
      );

    const chatId =
      env.TELEGRAM_CHAT_ID;

    if (
      chatId
    ) {
      await sendLongMessage(
        chatId,
        report,
        env,
        {
          parse_mode:
            "Markdown"
        }
      );

      for (
        const closedTrade of
        paperCheck.closed
      ) {
        await sendMessage(
          chatId,
          buildClosedTradeMessage(
            closedTrade
          ),
          env,
          {
            parse_mode:
              "Markdown"
          }
        );
      }
    }

    await kvPutJson(
      env,
      KV_KEY_LAST_SCAN,
      {
        timestamp:
          Date.now(),
        elapsed:
          scan.elapsed,
        results:
          scan.results
      }
    );

    return {
      ok: true,
      report
    };
  } catch (
    error
  ) {
    console.error(
      "scheduled scan error",
      error
    );

    const chatId =
      env.TELEGRAM_CHAT_ID;

    if (
      chatId
    ) {
      try {
        await sendMessage(
          chatId,
          `❌ خطا در اسکن زمان‌بندی‌شده:\n${error.message}`,
          env
        );
      } catch (
        sendError
      ) {
        console.error(
          "scheduled error notification failed",
          sendError
        );
      }
    }

    return {
      ok: false,
      error:
        error.message
    };
  }
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(
        request.url
      );

    if (
      url.pathname ===
      "/telegram"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return new Response(
          "Method Not Allowed",
          {
            status: 405
          }
        );
      }

      return handleWebhook(
        request,
        env
      );
    }

    if (
      url.pathname ===
      "/set-webhook"
    ) {
      return setWebhook(
        request,
        env
      );
    }

    if (
      url.pathname ===
      "/health"
    ) {
      return new Response(
        JSON.stringify(
          await health(
            env
          )
        ),
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    if (
      url.pathname ===
      "/scan"
    ) {
      try {
        const result =
          await scheduledScan(
            env
          );

        return new Response(
          JSON.stringify(
            result
          ),
          {
            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );
      } catch (
        error
      ) {
        return new Response(
          JSON.stringify({
            ok: false,
            error:
              error.message
          }),
          {
            status: 500,
            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );
      }
    }

    return new Response(
      "ALGO FJM V5.3 OK"
    );
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scheduledScan(
        env
      )
    );
  }
};
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
              const exitPrice =
                safeNumber(
                  result.exitPrice
                );

              if (
                trade.direction === "خرید"
              ) {
                priceMovePercent =
                  (
                    (exitPrice - entry) /
                    entry
                  ) * 100;
              } else {
                priceMovePercent =
                  (
                    (entry - exitPrice) /
                    entry
                  ) * 100;
              }

              grossPnl =
                (priceMovePercent / 100) *
                safeNumber(
                  trade.positionNotional
                );

              const exitNotional =
                safeNumber(
                  trade.positionNotional
                ) *
                (
                  exitPrice /
                  entry
                );

              const entryFee =
                safeNumber(
                  trade.positionNotional
                ) *
                PAPER_ENTRY_FEE;

              const exitFee =
                exitNotional *
                PAPER_EXIT_FEE;

              totalFees =
                entryFee +
                exitFee;

              const hoursHeld =
                Math.max(
                  0,
                  (
                    now -
                    createdAt
                  ) /
                  3600000
                );

              const fundingPeriods =
                Math.floor(
                  hoursHeld /
                  FUNDING_INTERVAL_HOURS
                );

              const rate =
                safeNumber(
                  trade.funding
                );

              if (
                fundingPeriods > 0 &&
                rate !== 0
              ) {
                const signed =
                  trade.direction === "خرید"
                    ? -1
                    : 1;

                fundingPnl =
                  signed *
                  rate *
                  safeNumber(
                    trade.positionNotional
                  ) *
                  fundingPeriods;
              }

              pnlUsdt =
                grossPnl -
                totalFees +
                fundingPnl;

              marginReturnPercent =
                safeNumber(
                  trade.margin
                ) > 0
                  ? (
                      pnlUsdt /
                      safeNumber(
                        trade.margin
                      )
                    ) * 100
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
                Number(
                  priceMovePercent.toFixed(4)
                ),

              priceMovePercent:
                Number(
                  priceMovePercent.toFixed(4)
                ),

              grossPnl:
                Number(
                  grossPnl.toFixed(4)
                ),

              totalFees:
                Number(
                  totalFees.toFixed(4)
                ),

              fundingPnl:
                Number(
                  fundingPnl.toFixed(4)
                ),

              marginReturnPercent:
                Number(
                  marginReturnPercent.toFixed(4)
                ),

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

    if (
      command === "/dashboard"
    ) {
      const result = await getDashboard(env);
      await sendMessage(chatId, result, env, { parse_mode: "Markdown" });
      return;
    }

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

            const tradeUpdate =
              await updateOpenPaperTrades(
                env
              );

            console.log(
              "PAPER UPDATE:",
              tradeUpdate
            );

            if (
              tradeUpdate.closedTrades?.length
            ) {
              await notifyClosedTrades(
                tradeUpdate.closedTrades,
                env
              );
            }

            const scan =
              await performScan(
                env
              );

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
    const tradeUpdate =
      await updateOpenPaperTrades(
        env
      );

    console.log(
      "SCHEDULED PAPER UPDATE:",
      tradeUpdate
    );

    if (
      tradeUpdate.closedTrades?.length
    ) {
      await notifyClosedTrades(
        tradeUpdate.closedTrades,
        env
      );
    }

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

    const scan =
      await performScan(
        env
      );

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
