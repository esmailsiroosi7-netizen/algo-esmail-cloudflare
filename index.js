// ============================================================
// ALGO FJM V6.2 SCANFIX V3 - Toobit Futures Analyzer
// Cloudflare Workers + Telegram
// ============================================================

const BASE_URL = "https://api.toobit.com";

const TIMEOUT_MS = 6000;

// ============================================================
// تنظیمات اسکن
// ============================================================

const MAX_ANALYSIS_SYMBOLS = 8;
const FAST_CANDIDATE_LIMIT = 45;
const DEEP_ANALYSIS_LIMIT = 8;
const DERIVATIVE_SHORTLIST_LIMIT = 2;
const ANALYSIS_BATCH = 4;
const SHORTLIST_FOR_DERIVATIVES = 2;
const TP1_CLOSE_FRACTION = 0.30;
const TP2_CLOSE_FRACTION = 0.30;
const TP3_CLOSE_FRACTION = 0.40;
const BREAK_EVEN_BUFFER = 0.0003;

const MIN_SIGNAL_SCORE = 78;
const MIN_PRECISION_SCORE = 74;
const MIN_RR = 1.55;
const MIN_VOLUME_RATIO = 0.75;

// ============================================================
// پایداری اجرای اسکن
// ============================================================
const SCAN_LOCK_KEY = "system:scan_lock";
const SCAN_STATUS_KEY = "system:scan_status";
const SCAN_LOCK_TTL_MS = 8 * 60 * 1000;
const PROCESSED_UPDATE_TTL_SECONDS = 24 * 60 * 60;

// ALGO FJM V6.2 SCANFIX V3 - Futures-first configuration
// Entry logic uses 5m + 15m for execution and 1h + 4h for context.
const FUTURES_TAKER_FEE = 0.0006;
const FUTURES_MAKER_FEE = 0.0002;
const PAPER_ENTRY_FEE = FUTURES_TAKER_FEE;
const PAPER_EXIT_FEE = FUTURES_TAKER_FEE;
const FUNDING_INTERVAL_HOURS = 8;
const MIN_LOWER_TF_ALIGNMENT = 2;

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
  const [exchangeInfo, tickers] = await Promise.all([
    getExchangeInfo(),
    getAllTickers()
  ]);
  const contracts = extractContracts(exchangeInfo);
  const allowed = new Set(contracts.filter(isValidContract).map(x => x.symbol));
  let candidates = tickers.map(t => ({
    symbol: tickerSymbol(t), price: tickerPrice(t), volume: tickerVolume(t), change: tickerChange(t)
  })).filter(x => {
    if (!x.symbol || !x.price) return false;
    if (allowed.size && !allowed.has(x.symbol)) return false;
    return x.symbol.endsWith("-SWAP-USDT");
  });
  const marketSymbolCount = candidates.length;
  const maxVol = Math.max(1, ...candidates.map(x => safeNumber(x.volume)));
  candidates = candidates.map(x => {
    const volScore = Math.log10(1 + safeNumber(x.volume)) / Math.log10(1 + maxVol);
    const moveScore = Math.min(Math.abs(safeNumber(x.change)) / 5, 1);
    return { ...x, fastScore: volScore * 0.70 + moveScore * 0.30 };
  }).sort((a,b) => b.fastScore - a.fastScore).slice(0, FAST_CANDIDATE_LIMIT);
  const btc = candidates.find(x => x.symbol === "BTC-SWAP-USDT");
  const selected = [];
  if (btc) selected.push(btc);
  for (const item of candidates) {
    if (selected.some(x => x.symbol === item.symbol)) continue;
    selected.push(item);
    if (selected.length >= DEEP_ANALYSIS_LIMIT) break;
  }
  return { selected, marketSymbolCount, fastCandidateCount: candidates.length };
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
// موتور ساختار و نقطه‌زنی V6
// ============================================================

function bodySize(c) {
  return Math.abs(safeNumber(c.close) - safeNumber(c.open));
}

function candleRange(c) {
  return Math.max(0, safeNumber(c.high) - safeNumber(c.low));
}

function detectSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = safeNumber(candles[i].high);
    const l = safeNumber(candles[i].low);
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (safeNumber(candles[j].high) >= h) isHigh = false;
      if (safeNumber(candles[j].low) <= l) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: h });
    if (isLow) lows.push({ index: i, price: l });
  }
  return { highs, lows };
}

function structureEngine(candles) {
  const swings = detectSwings(candles, 2, 2);
  const highs = swings.highs.slice(-5);
  const lows = swings.lows.slice(-5);
  const last = candles[candles.length - 2];
  const price = safeNumber(last?.close);
  const prevHigh = highs.length >= 2 ? highs[highs.length - 2].price : null;
  const lastHigh = highs.length ? highs[highs.length - 1].price : null;
  const prevLow = lows.length >= 2 ? lows[lows.length - 2].price : null;
  const lastLow = lows.length ? lows[lows.length - 1].price : null;

  let structure = "رنج";
  if (lastHigh != null && prevHigh != null && lastLow != null && prevLow != null) {
    if (lastHigh > prevHigh && lastLow > prevLow) structure = "صعودی";
    else if (lastHigh < prevHigh && lastLow < prevLow) structure = "نزولی";
  }

  const rangeLookback = candles.slice(-25, -1);
  const rangeHigh = rangeLookback.length ? Math.max(...rangeLookback.map(x => safeNumber(x.high))) : 0;
  const rangeLow = rangeLookback.length ? Math.min(...rangeLookback.map(x => safeNumber(x.low))) : 0;
  const atrValue = average(candles.slice(-16, -1).map((x, i, a) => {
    const prev = candles[candles.length - 17 + i];
    const tr = Math.max(safeNumber(x.high) - safeNumber(x.low), Math.abs(safeNumber(x.high) - safeNumber(prev?.close)), Math.abs(safeNumber(x.low) - safeNumber(prev?.close)));
    return tr;
  })) || price * 0.002;

  const brokeUp = rangeHigh > 0 && price > rangeHigh && price - rangeHigh > atrValue * 0.15;
  const brokeDown = rangeLow > 0 && price < rangeLow && rangeLow - price > atrValue * 0.15;
  if (brokeUp) structure = "شکست صعودی";
  if (brokeDown) structure = "شکست نزولی";

  const prevCandle = candles[candles.length - 3];
  const prevPrice = safeNumber(prevCandle?.close);
  const sweepLow = rangeLow > 0 && safeNumber(last?.low) < rangeLow && price > rangeLow && prevPrice >= rangeLow;
  const sweepHigh = rangeHigh > 0 && safeNumber(last?.high) > rangeHigh && price < rangeHigh && prevPrice <= rangeHigh;

  let bos = "ندارد";
  if (lastHigh != null && price > lastHigh) bos = "BOS صعودی";
  else if (lastLow != null && price < lastLow) bos = "BOS نزولی";

  return {
    structure,
    highs,
    lows,
    swingHigh: lastHigh,
    swingLow: lastLow,
    rangeHigh,
    rangeLow,
    bos,
    sweepLow,
    sweepHigh,
    atrReference: atrValue
  };
}

function vwap(candles, lookback = 40) {
  const recent = candles.slice(-lookback - 1, -1);
  let pv = 0;
  let vol = 0;
  for (const c of recent) {
    const typical = (safeNumber(c.high) + safeNumber(c.low) + safeNumber(c.close)) / 3;
    const volume = safeNumber(c.volume);
    pv += typical * volume;
    vol += volume;
  }
  return vol > 0 ? pv / vol : safeNumber(candles[candles.length - 2]?.close);
}

function volatilityRegime(candles, atrValue) {
  const price = safeNumber(candles[candles.length - 2]?.close);
  const pct = price > 0 ? atrValue / price : 0;
  if (pct < 0.0015) return "کم‌نوسان";
  if (pct > 0.012) return "پرنوسان";
  return "عادی";
}

function precisionSetup(candles, structure, direction, volumeRatio, atrValue, rsiValue) {
  const last = candles[candles.length - 2];
  const prev = candles[candles.length - 3];
  const price = safeNumber(last?.close);
  const range = candleRange(last);
  const body = bodySize(last);
  const bodyRatio = range > 0 ? body / range : 0;
  const closeLocation = range > 0 ? (safeNumber(last?.close) - safeNumber(last?.low)) / range : 0.5;
  const prevClose = safeNumber(prev?.close);
  const currClose = safeNumber(last?.close);

  let trigger = false;
  let triggerType = "هیچ‌کدام";
  let quality = 0;

  if (direction === "خرید") {
    if (structure.sweepLow) { quality += 24; trigger = true; triggerType = "جمع‌کردن نقدینگی پایین"; }
    if (structure.bos === "BOS صعودی") { quality += 22; trigger = true; triggerType = "BOS صعودی"; }
    if (currClose > prevClose && closeLocation >= 0.65) { quality += 14; trigger = true; }
    if (bodyRatio >= 0.55) quality += 8;
    if (volumeRatio >= 1.15) quality += 12;
    else if (volumeRatio < MIN_VOLUME_RATIO) quality -= 18;
    if (rsiValue >= 50 && rsiValue <= 68) quality += 8;
  }

  if (direction === "فروش") {
    if (structure.sweepHigh) { quality += 24; trigger = true; triggerType = "جمع‌کردن نقدینگی بالا"; }
    if (structure.bos === "BOS نزولی") { quality += 22; trigger = true; triggerType = "BOS نزولی"; }
    if (currClose < prevClose && closeLocation <= 0.35) { quality += 14; trigger = true; }
    if (bodyRatio >= 0.55) quality += 8;
    if (volumeRatio >= 1.15) quality += 12;
    else if (volumeRatio < MIN_VOLUME_RATIO) quality -= 18;
    if (rsiValue >= 32 && rsiValue <= 50) quality += 8;
  }

  const atrPct = price > 0 ? atrValue / price : 0;
  if (atrPct > 0.02) quality -= 12;
  if (atrPct < 0.001) quality -= 8;

  return {
    ready: trigger && quality >= 42,
    quality: clamp(Math.round(quality), 0, 100),
    triggerType,
    bodyRatio,
    closeLocation
  };
}

// ============================================================
// حمایت / مقاومت
// ============================================================

function supportResistance(candles) {
  if (!candles.length) return { support: 0, resistance: 0 };
  const recent = candles.slice(-60, -1);
  const highs = recent.map(x => safeNumber(x.high));
  const lows = recent.map(x => safeNumber(x.low));
  const structure = structureEngine(candles);
  return {
    support: structure.swingLow || Math.min(...lows),
    resistance: structure.swingHigh || Math.max(...highs)
  };
}

// ============================================================
// MARKET REGIME ENGINE
// ============================================================

function marketRegime(a1h, a4h) {
  if (!a1h || !a4h) return { name: "نامشخص", quality: 0, direction: "خنثی" };

  const h1Bull = a1h.bull > a1h.bear;
  const h4Bull = a4h.bull > a4h.bear;
  const h1Bear = a1h.bear > a1h.bull;
  const h4Bear = a4h.bear > a4h.bull;
  const alignedBull = h1Bull && h4Bull;
  const alignedBear = h1Bear && h4Bear;
  const strength = (safeNumber(a1h.trendStrength) + safeNumber(a4h.trendStrength)) / 2;
  const atr1 = safeNumber(a1h.atr);
  const atr4 = safeNumber(a4h.atr);
  const p1 = safeNumber(a1h.price);
  const p4 = safeNumber(a4h.price);
  const vol1 = p1 > 0 ? atr1 / p1 : 0;
  const vol4 = p4 > 0 ? atr4 / p4 : 0;
  const highVol = vol1 > 0.012 || vol4 > 0.025;
  const lowVol = vol1 < 0.0025 && vol4 < 0.008;
  const breakout = String(a1h.bos || "").includes("BOS") || String(a4h.bos || "").includes("BOS");
  const transition = h1Bull !== h4Bull || h1Bear !== h4Bear ||
    String(a1h.structure || "").includes("نامشخص") || String(a4h.structure || "").includes("نامشخص");

  if (breakout && alignedBull && strength >= 22) return { name: "شکست صعودی", quality: 88, direction: "خرید" };
  if (breakout && alignedBear && strength >= 22) return { name: "شکست نزولی", quality: 88, direction: "فروش" };
  if (alignedBull && strength >= 24 && !lowVol) return { name: "روند صعودی", quality: clamp(Math.round(60 + strength), 60, 95), direction: "خرید" };
  if (alignedBear && strength >= 24 && !lowVol) return { name: "روند نزولی", quality: clamp(Math.round(60 + strength), 60, 95), direction: "فروش" };
  if (transition && strength >= 16) return { name: "گذار / تغییر رژیم", quality: 45, direction: "خنثی" };
  if (lowVol) return { name: "رنج کم‌نوسان", quality: 35, direction: "خنثی" };
  if (highVol && strength < 18) return { name: "نوسان بی‌کیفیت", quality: 25, direction: "خنثی" };
  return { name: "رنج", quality: 40, direction: "خنثی" };
}

// ============================================================
// تحلیل تایم‌فریم
// ============================================================

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 210) throw new Error("داده کافی برای تحلیل وجود ندارد.");
  const closes = candles.map(x => x.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsiValues = rsi(closes, 14);
  const atrValues = atr(candles, 14);
  const macdData = macd(closes);
  const i = candles.length - 2;
  const price = closes[i];
  const e20 = ema20[i], e50 = ema50[i], e200 = ema200[i];
  if (e200 == null) throw new Error("EMA200 داده کافی ندارد.");
  const rsiValue = rsiValues[i], atrValue = atrValues[i];
  const macdLine = macdData.line[i], macdSignal = macdData.signal[i], macdHistogram = macdData.histogram[i];
  const structureData = structureEngine(candles);
  const sr = supportResistance(candles);
  const recentVolumes = candles.slice(-21, -1).map(x => x.volume);
  const volumeRatio = average(recentVolumes) > 0 ? safeNumber(candles[i].volume) / average(recentVolumes) : 1;
  const patterns = candlePatterns(candles);
  const vwapValue = vwap(candles, 40);

  let bull = 0, bear = 0;
  if (e20 > e50) bull += 14; else bear += 14;
  if (price > e20) bull += 7; else bear += 7;
  if (price > e200) bull += 9; else bear += 9;
  if (rsiValue >= 52 && rsiValue <= 68) bull += 9;
  if (rsiValue <= 48 && rsiValue >= 32) bear += 9;
  if (macdLine > macdSignal) bull += 9; else bear += 9;
  if (macdHistogram > 0) bull += 5; else bear += 5;
  if (structureData.structure.includes("صعودی")) bull += 13;
  if (structureData.structure.includes("نزولی")) bear += 13;
  if (price > vwapValue) bull += 7; else bear += 7;
  if (volumeRatio >= 1.15) {
    if (price > e20) bull += 5; else bear += 5;
  } else if (volumeRatio < MIN_VOLUME_RATIO) {
    bull -= 4; bear -= 4;
  }

  for (const pattern of patterns) {
    if (pattern.includes("صعودی") || pattern === "چکش") bull += 2;
    if (pattern.includes("نزولی") || pattern === "شهاب‌سنگ") bear += 2;
  }

  const resistanceDistance = sr.resistance > 0 ? ((sr.resistance - price) / price) * 100 : 999;
  const supportDistance = sr.support > 0 ? ((price - sr.support) / price) * 100 : 999;
  const trendStrength = Math.abs(bull - bear);
  return {
    price, ema20: e20, ema50: e50, ema200: e200, rsi: rsiValue, atr: atrValue,
    macd: macdLine, macdSignal, macdHistogram, volumeRatio,
    structure: structureData.structure, bos: structureData.bos,
    sweepLow: structureData.sweepLow, sweepHigh: structureData.sweepHigh,
    swingHigh: structureData.swingHigh, swingLow: structureData.swingLow,
    rangeHigh: structureData.rangeHigh, rangeLow: structureData.rangeLow,
    vwap: vwapValue, volatilityRegime: volatilityRegime(candles, atrValue),
    support: sr.support, resistance: sr.resistance, resistanceDistance, supportDistance,
    patterns, bull: Math.max(0, bull), bear: Math.max(0, bear), trendStrength
  };
}

// ============================================================
// ترکیب تایم‌فریم‌ها
// ============================================================

function combineAnalysis(a5m, a15, a1h, a4h) {
  const regime = marketRegime(a1h, a4h);
  const bull = a4h.bull * 0.15 + a1h.bull * 0.30 + a15.bull * 0.35 + a5m.bull * 0.20;
  const bear = a4h.bear * 0.15 + a1h.bear * 0.30 + a15.bear * 0.35 + a5m.bear * 0.20;
  const edge = Math.abs(bull - bear);
  const total = bull + bear;
  let direction = "خنثی";
  if (bull > bear && edge >= 9) direction = "خرید";
  if (bear > bull && edge >= 9) direction = "فروش";

  const lowerAligned = direction === "خرید"
    ? (a5m.bull > a5m.bear ? 1 : 0) + (a15.bull > a15.bear ? 1 : 0)
    : direction === "فروش"
      ? (a5m.bear > a5m.bull ? 1 : 0) + (a15.bear > a15.bull ? 1 : 0)
      : 0;

  if (direction !== "خنثی" && lowerAligned < MIN_LOWER_TF_ALIGNMENT) direction = "خنثی";
  if (regime.direction !== "خنثی" && direction !== regime.direction && regime.quality >= 70) direction = "خنثی";
  if (["گذار / تغییر رژیم", "نوسان بی‌کیفیت"].includes(regime.name)) direction = "خنثی";

  const edgeScore = total > 0 ? (edge / total) * 30 : 0;
  const contextBonus = direction === "خرید"
    ? ((a4h.bull > a4h.bear ? 1 : 0) + (a1h.bull > a1h.bear ? 1 : 0)) * 5
    : direction === "فروش"
      ? ((a4h.bear > a4h.bull ? 1 : 0) + (a1h.bear > a1h.bull ? 1 : 0)) * 5
      : 0;
  const setupQuality = direction === "خرید"
    ? precisionSetupProxy(a5m, a15, "خرید")
    : direction === "فروش"
      ? precisionSetupProxy(a5m, a15, "فروش")
      : 0;
  const regimeBonus = direction !== "خنثی" && regime.direction === direction ? Math.round(regime.quality * 0.12) : 0;
  const regimePenalty = ["رنج", "رنج کم‌نوسان"].includes(regime.name) ? 8 : 0;
  const score = Math.round(clamp(45 + edgeScore + contextBonus + setupQuality * 0.30 + regimeBonus - regimePenalty, 0, 100));
  return { direction, score, bull, bear, lowerAligned, setupQuality, marketRegime: regime };
}

function precisionSetupProxy(a5m, a15, direction) {
  const a = direction === "خرید" ? a5m.bull : a5m.bear;
  const b = direction === "خرید" ? a15.bull : a15.bear;
  let q = 0;
  q += a >= 45 ? 25 : 0;
  q += b >= 45 ? 20 : 0;
  q += direction === "خرید" ? (a5m.sweepLow ? 20 : 0) : (a5m.sweepHigh ? 20 : 0);
  q += direction === "خرید" ? (a5m.bos === "BOS صعودی" ? 20 : 0) : (a5m.bos === "BOS نزولی" ? 20 : 0);
  q += direction === "خرید" ? (a15.price > a15.vwap ? 8 : 0) : (a15.price < a15.vwap ? 8 : 0);
  q += a5m.volumeRatio >= 1.0 ? 7 : 0;
  return clamp(q, 0, 100);
}

// ============================================================
// دفتر سفارشات - نقدینگی لحظه‌ای Toobit
// ============================================================

async function getOrderBookLiquidity(symbol) {
  try {
    const data = await fetchJson(
      `${BASE_URL}/quote/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=20`
    );
    const bids = Array.isArray(data?.b) ? data.b : Array.isArray(data?.data?.b) ? data.data.b : [];
    const asks = Array.isArray(data?.a) ? data.a : Array.isArray(data?.data?.a) ? data.data.a : [];
    const bidQty = bids.reduce((sum, x) => sum + safeNumber(x?.[1]), 0);
    const askQty = asks.reduce((sum, x) => sum + safeNumber(x?.[1]), 0);
    const total = bidQty + askQty;
    const imbalance = total > 0 ? (bidQty - askQty) / total : 0;
    const bestBid = safeNumber(bids[0]?.[0]);
    const bestAsk = safeNumber(asks[0]?.[0]);
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
    const spread = mid > 0 ? (bestAsk - bestBid) / mid : 0;
    return { bidQty, askQty, imbalance, bestBid, bestAsk, spread, levels: Math.min(bids.length, asks.length) };
  } catch (error) {
    console.error("Depth error", symbol, error);
    return null;
  }
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

    if (
      results.some(
        x => x.status !== "fulfilled"
      )
    ) {
      throw new Error(
        "دریافت یکی از تایم‌فریم‌ها ناموفق بود."
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

    const preFilterDirection = combined.direction;
    const regime = combined.marketRegime;

    const setup = preFilterDirection !== "خنثی"
      ? precisionSetup(
          candles5m,
          {
            sweepLow: a5m.sweepLow || a15.sweepLow,
            sweepHigh: a5m.sweepHigh || a15.sweepHigh,
            bos: a5m.bos !== "ندارد" ? a5m.bos : a15.bos
          },
          preFilterDirection,
          a5m.volumeRatio,
          a5m.atr,
          a5m.rsi
        )
      : { ready: false, quality: 0, triggerType: "هیچ‌کدام" };

    // Execution confirmation: the lower timeframe must agree with the signal.
    const lowerBull =
      (a5m.bull > a5m.bear ? 1 : 0) +
      (a15.bull > a15.bear ? 1 : 0);
    const lowerBear =
      (a5m.bear > a5m.bull ? 1 : 0) +
      (a15.bear > a15.bull ? 1 : 0);

    const lowerAlignedForDirection =
      preFilterDirection === "خرید" ? lowerBull :
      preFilterDirection === "فروش" ? lowerBear : 0;

    const rejectionReasons = [];

    if (preFilterDirection === "خنثی") {
      rejectionReasons.push("EDGE_LOW_OR_TF_CONFLICT");
    }
    if (preFilterDirection !== "خنثی" && lowerAlignedForDirection < MIN_LOWER_TF_ALIGNMENT) {
      rejectionReasons.push("LOWER_TF_CONFLICT");
      combined.direction = "خنثی";
    }
    if (preFilterDirection !== "خنثی" && regime.direction === "خنثی") {
      rejectionReasons.push(`REGIME_${regime.name}`);
      combined.direction = "خنثی";
    }
    if (preFilterDirection !== "خنثی" && regime.direction !== "خنثی" && regime.direction !== preFilterDirection && regime.quality >= 70) {
      rejectionReasons.push("REGIME_CONFLICT");
      combined.direction = "خنثی";
    }
    if (preFilterDirection !== "خنثی" && ["گذار / تغییر رژیم", "نوسان بی‌کیفیت"].includes(regime.name)) {
      rejectionReasons.push(`REGIME_${regime.name}`);
      combined.direction = "خنثی";
    }
    if (preFilterDirection !== "خنثی" && !setup.ready) rejectionReasons.push("SETUP_NOT_READY");
    if (preFilterDirection !== "خنثی" && setup.ready && combined.setupQuality < MIN_PRECISION_SCORE) rejectionReasons.push("PRECISION_SCORE_LOW");

    const entryReady = Boolean(
      combined.direction !== "خنثی" &&
      setup.ready &&
      combined.setupQuality >= MIN_PRECISION_SCORE &&
      (combined.direction !== "فروش" || setup.quality >= 80)
    );
    if (preFilterDirection !== "خنثی" && !entryReady && !rejectionReasons.includes("SETUP_NOT_READY") && !rejectionReasons.includes("PRECISION_SCORE_LOW")) {
      rejectionReasons.push("ENTRY_FILTER");
    }

    const diagnostic = {
      rawDirection: preFilterDirection,
      finalDirection: combined.direction,
      score: combined.score,
      setupQuality: combined.setupQuality,
      setupReady: Boolean(setup.ready),
      setupTrigger: setup.triggerType || "هیچ‌کدام",
      setupQualityRaw: safeNumber(setup.quality),
      lowerAlignment: lowerAlignedForDirection,
      lowerBull,
      lowerBear,
      regime: regime.name,
      regimeDirection: regime.direction,
      regimeQuality: regime.quality,
      rejectionReasons
    };

    return {
      ...item,
      symbol,
      price: safeNumber(item.price) || a5m.price,
      analysis5m: a5m,
      analysis15: a15,
      analysis1h: a1h,
      analysis4h: a4h,
      ...combined,
      precisionSetup: setup,
      entryReady,
      scanDiagnostic: diagnostic
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
        longShort,
        liquidity
      ] = await Promise.all([
        getFunding(item.symbol),
        getOpenInterest(item.symbol),
        getLongShort(item.symbol),
        getOrderBookLiquidity(item.symbol)
      ]);

      item.funding =
        funding;

      item.openInterest =
        openInterest;

      item.longShort =
        longShort;
      item.orderBook = liquidity;

      let derivativeAdjustment = 0;
      if (funding != null) {
        if (item.direction === "خرید" && funding > 0.001) derivativeAdjustment -= 6;
        if (item.direction === "فروش" && funding < -0.001) derivativeAdjustment -= 6;
      }
      if (item.longShort != null) {
        if (item.direction === "خرید" && item.longShort > 2.2) derivativeAdjustment -= 5;
        if (item.direction === "فروش" && item.longShort < 0.45) derivativeAdjustment -= 5;
      }
      if (liquidity) {
        if (item.direction === "خرید" && liquidity.imbalance > 0.12) derivativeAdjustment += 3;
        if (item.direction === "خرید" && liquidity.imbalance < -0.18) derivativeAdjustment -= 5;
        if (item.direction === "فروش" && liquidity.imbalance < -0.12) derivativeAdjustment += 3;
        if (item.direction === "فروش" && liquidity.imbalance > 0.18) derivativeAdjustment -= 5;
        if (liquidity.spread > 0.0025) derivativeAdjustment -= 5;
      }
      item.derivativeAdjustment = derivativeAdjustment;
      item.score = clamp(Math.round(item.score + derivativeAdjustment), 0, 100);
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
      await Promise.allSettled(
        batch.map(
          item => worker(item)
        )
      );

    for (const result of results) {
      if (result.status === "fulfilled") {
        output.push(result.value);
      } else {
        const item = batch[results.indexOf(result)];
        output.push({
          ...(item || {}),
          failed: true,
          error: String(result.reason?.message || result.reason || "خطای نامشخص")
        });
      }
    }
  }

  return output;
}

// ============================================================
// PAPER TRADE - محاسبه
// ============================================================

function calculateTrade(result) {
  if (!result || result.failed || result.direction === "خنثی" || !result.entryReady) return null;
  const entry = safeNumber(result.price);
  const a5 = result.analysis5m || {};
  const a15 = result.analysis15 || {};
  const atr5 = safeNumber(a5.atr) || entry * 0.002;
  const atr15 = safeNumber(a15.atr) || entry * 0.003;
  const rawSupport = safeNumber(a15.swingLow || a5.swingLow || a15.support);
  const rawResistance = safeNumber(a15.swingHigh || a5.swingHigh || a15.resistance);
  const buffer = Math.max(atr5 * 0.25, entry * 0.0007);
  let stop;
  if (result.direction === "خرید") {
    stop = rawSupport > 0 && rawSupport < entry ? rawSupport - buffer : entry - Math.max(atr5 * 1.4, atr15 * 0.65);
  } else {
    stop = rawResistance > entry ? rawResistance + buffer : entry + Math.max(atr5 * 1.4, atr15 * 0.65);
  }
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;
  const rr = Math.max(MIN_RR, 1.8);
  const opposingLevel = result.direction === "خرید" ? rawResistance : rawSupport;
  if (opposingLevel > 0) {
    const available = result.direction === "خرید" ? opposingLevel - entry : entry - opposingLevel;
    if (available > 0 && available < riskDistance * MIN_RR * 1.05) return null;
  }
  let tp1 = result.direction === "خرید" ? entry + riskDistance * rr : entry - riskDistance * rr;
  if (opposingLevel > 0) {
    const structuralTp = result.direction === "خرید" ? opposingLevel - buffer : opposingLevel + buffer;
    if (result.direction === "خرید" && structuralTp > entry + riskDistance * MIN_RR) tp1 = Math.min(tp1, structuralTp);
    if (result.direction === "فروش" && structuralTp < entry - riskDistance * MIN_RR) tp1 = Math.max(tp1, structuralTp);
  }
  const realizedRr = Math.abs(tp1 - entry) / riskDistance;
  if (realizedRr < MIN_RR) return null;
  const tp2 = result.direction === "خرید" ? entry + riskDistance * 2.8 : entry - riskDistance * 2.8;
  const tp3 = result.direction === "خرید" ? entry + riskDistance * 4.2 : entry - riskDistance * 4.2;
  const initialPositionNotional = positionNotional;
  const riskAmount = PAPER_BUDGET * (RISK_PERCENT / 100);
  const stopPercent = riskDistance / entry;
  const positionNotional = stopPercent > 0 ? riskAmount / stopPercent : PAPER_BUDGET;
  const volatility = entry > 0 ? atr15 / entry : 0.01;
  let leverage = 3;
  if (volatility < 0.004) leverage = 5;
  else if (volatility < 0.008) leverage = 4;
  else if (volatility > 0.02) leverage = 2;
  const margin = positionNotional / leverage;
  const priceMoveToTP1 = Math.abs(tp1 - entry) / entry;
  const entryFee = positionNotional * PAPER_ENTRY_FEE;
  const exitNotional = positionNotional * (tp1 / entry);
  const exitFee = exitNotional * PAPER_EXIT_FEE;
  const roundTripFee = entryFee + exitFee;
  return {
    symbol: result.symbol, direction: result.direction, entry, stop, tp1, tp2, tp3, leverage,
    riskAmount, positionNotional, margin, score: result.score,
    precisionScore: result.setupQuality, triggerType: result.precisionSetup?.triggerType || "",
    rsi1h: safeNumber(result.analysis1h?.rsi), volumeRatio: safeNumber(a15.volumeRatio),
    structure5m: a5.structure, structure15: a15.structure, structure1h: result.analysis1h?.structure, structure4h: result.analysis4h?.structure,
    patterns5m: a5.patterns || [], patterns15: a15.patterns || [], funding: result.funding ?? null, longShort: result.longShort ?? null,
    btcDirection: null, createdAt: Date.now(),
    initialPositionNotional, remainingPositionNotional: positionNotional,
    tp1Fraction: TP1_CLOSE_FRACTION, tp2Fraction: TP2_CLOSE_FRACTION, tp3Fraction: TP3_CLOSE_FRACTION,
    realizedPnlUsdt: 0, realizedFees: 0, realizedGrossPnl: 0, realizedFunding: 0, partialAccountingInitialized: false, tp1Hit: false, tp2Hit: false,
    breakEvenStop: entry * (result.direction === "خرید" ? (1 - BREAK_EVEN_BUFFER) : (1 + BREAK_EVEN_BUFFER)),
    currentStop: stop,
    priceMoveToTP1, grossTp1Pnl: priceMoveToTP1 * positionNotional,
    entryFee, exitFee, roundTripFee, feeBreakEvenMove: roundTripFee / positionNotional,
    feeBreakEvenPriceMovePercent: (roundTripFee / positionNotional) * 100,
    expectedTp1NetBeforeFunding: priceMoveToTP1 * positionNotional - roundTripFee,
    stopDistancePercent: stopPercent * 100, rrTp1: realizedRr, atr15: atr15
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

    precision: result.precisionSetup || null,

    orderBook: result.orderBook || null,

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
          x.entryReady &&
          x.score >= MIN_SIGNAL_SCORE &&
          x.marketRegime &&
          x.marketRegime.direction !== "خنثی" &&
          !["گذار / تغییر رژیم", "نوسان بی‌کیفیت", "رنج کم‌نوسان"].includes(x.marketRegime.name)
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, 8);

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

async function updateOpenPaperTrades(env) {
  if (!env.ALGO_ESMAIL_KV) return { checked: 0, closed: 0, expired: 0, ambiguous: 0, closedTrades: [] };

  const keys = await listAllKeys(env, "trade:");
  const openTrades = [];
  for (const key of keys) {
    try {
      const raw = await env.ALGO_ESMAIL_KV.get(key.name);
      if (!raw) continue;
      const trade = JSON.parse(raw);
      if (trade.status === "OPEN") openTrades.push(trade);
    } catch {}
  }

  let checked = 0, closed = 0, expired = 0, ambiguous = 0;
  const closedTrades = [];
  const milestoneTrades = [];

  for (let i = 0; i < openTrades.length; i += 4) {
    const batch = openTrades.slice(i, i + 4);
    await Promise.allSettled(batch.map(async trade => {
      checked++;
      try {
        const createdAt = safeNumber(trade.createdAt);
        const now = Date.now();
        if (!createdAt) return;
        const ageHours = (now - createdAt) / 3600000;

        if (ageHours > MAX_OPEN_TRADE_AGE_HOURS) {
          const updated = { ...trade, status: "EXPIRED", result: "EXPIRED", firstTarget: "انقضای زمان", exitPrice: null, pnlUsdt: safeNumber(trade.realizedPnlUsdt) + safeNumber(trade.realizedFunding), pnl: safeNumber(trade.realizedPnlUsdt) + safeNumber(trade.realizedFunding), pnlPercent: 0, priceMovePercent: 0, grossPnl: safeNumber(trade.realizedGrossPnl), totalFees: safeNumber(trade.realizedFees), fundingPnl: safeNumber(trade.realizedFunding), marginReturnPercent: safeNumber(trade.margin) > 0 ? safeNumber(trade.realizedPnlUsdt) / safeNumber(trade.margin) * 100 : 0, closedAt: now, updatedAt: now };
          await env.ALGO_ESMAIL_KV.put(trade.id, JSON.stringify(updated));
          expired++; closedTrades.push(updated); return;
        }

        const entry = safeNumber(trade.entry);
        const originalStop = safeNumber(trade.stop);
        if (!entry || !originalStop) return;
        const intervalMs = 15 * 60 * 1000;
        const entryCandleStart = Math.floor(createdAt / intervalMs) * intervalMs;
        const candles = await getKlines(trade.symbol, "15m", PAPER_CHECK_CANDLES, entryCandleStart, now);
        const relevant = candles.filter(c => safeNumber(c.time) + intervalMs > createdAt);
        if (!relevant.length) return;

        let changed = false;
        let finalResult = null;
        let lastProcessed = safeNumber(trade.lastProcessedCandleTime);
        let currentStop = safeNumber(trade.currentStop, originalStop);
        let remaining = safeNumber(trade.remainingPositionNotional, trade.positionNotional);
        const entryFee = safeNumber(trade.entryFee);
        const accountingInitialized = trade.partialAccountingInitialized === true;
        let realized = accountingInitialized ? safeNumber(trade.realizedPnlUsdt) : -entryFee;
        let fees = accountingInitialized ? safeNumber(trade.realizedFees) : entryFee;
        let funding = safeNumber(trade.realizedFunding);
        let realizedGross = safeNumber(trade.realizedGrossPnl);
        let firstTarget = trade.firstTarget || null;
        const initialNotional = safeNumber(trade.initialPositionNotional, trade.positionNotional);
        const targets = [safeNumber(trade.tp1), safeNumber(trade.tp2), safeNumber(trade.tp3)];
        const fractions = [safeNumber(trade.tp1Fraction, TP1_CLOSE_FRACTION), safeNumber(trade.tp2Fraction, TP2_CLOSE_FRACTION), safeNumber(trade.tp3Fraction, TP3_CLOSE_FRACTION)];
        let targetIndex = trade.tp1Hit ? (trade.tp2Hit ? 2 : 1) : 0;

        for (const candle of relevant) {
          const candleTime = safeNumber(candle.time);
          if (candleTime <= lastProcessed) continue;
          const high = safeNumber(candle.high), low = safeNumber(candle.low);
          if (!high || !low) continue;

          const hitStop = trade.direction === "خرید" ? low <= currentStop : high >= currentStop;
          const target = targets[targetIndex];
          const hitTarget = target > 0 && (trade.direction === "خرید" ? high >= target : low <= target);

          // اگر حدضرر و هدف در یک کندل قبل از مشخص بودن ترتیب هر دو لمس شوند، محافظه‌کارانه مبهم.
          if (hitStop && hitTarget) {
            finalResult = { status: "AMBIGUOUS", firstTarget: firstTarget || `TP${targetIndex + 1}`, exitPrice: null, candleTime };
            break;
          }

          if (hitStop) {
            const exitPrice = currentStop;
            const qty = remaining;
            const move = trade.direction === "خرید" ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
            const gross = move * qty;
            const exitFee = qty * (exitPrice / entry) * PAPER_EXIT_FEE;
            const pnl = gross - exitFee;
            realized += pnl; realizedGross += gross; fees += exitFee;
            finalResult = { status: "LOSS", firstTarget: firstTarget || "SL", exitPrice, candleTime, gross, fees: exitFee };
            break;
          }

          if (hitTarget) {
            const milestoneName = `TP${targetIndex + 1}`;
            const closeFraction = Math.min(1, fractions[targetIndex]);
            const qty = targetIndex === 2 ? remaining : Math.min(remaining, initialNotional * closeFraction);
            const exitPrice = target;
            const move = trade.direction === "خرید" ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
            const gross = move * qty;
            const exitFee = qty * (exitPrice / entry) * PAPER_EXIT_FEE;
            const pnl = gross - exitFee;
            realized += pnl; realizedGross += gross; fees += exitFee; remaining = Math.max(0, remaining - qty);
            firstTarget = firstTarget || `TP${targetIndex + 1}`;
            changed = true;
            if (targetIndex === 0) {
              trade.tp1Hit = true; trade.tp1HitAt = candleTime; trade.tp1ExitPrice = exitPrice;
              currentStop = safeNumber(trade.breakEvenStop, entry);
              targetIndex = 1;
            } else if (targetIndex === 1) {
              trade.tp2Hit = true; trade.tp2HitAt = candleTime; trade.tp2ExitPrice = exitPrice;
              currentStop = trade.direction === "خرید" ? Math.max(currentStop, entry + safeNumber(trade.atr15) * 0.15) : Math.min(currentStop, entry - safeNumber(trade.atr15) * 0.15);
              targetIndex = 2;
            } else {
              finalResult = { status: "WIN", firstTarget: "TP3", exitPrice, candleTime, gross, fees: exitFee };
              break;
            }
            milestoneTrades.push({ ...trade, milestone: milestoneName, milestonePrice: exitPrice, milestonePnl: pnl, remainingPositionNotional: remaining, currentStop, realizedPnlUsdt: realized });
          }
          lastProcessed = candleTime;
        }

        if (finalResult) {
          const totalGross = realizedGross;
          const totalFees = fees;
          const hoursHeld = Math.max(0, (now - createdAt) / 3600000);
          const fundingPeriods = Math.floor(hoursHeld / FUNDING_INTERVAL_HOURS);
          const rate = safeNumber(trade.funding);
          if (fundingPeriods > 0 && rate !== 0 && funding === safeNumber(trade.realizedFunding)) {
            const signed = trade.direction === "خرید" ? -1 : 1;
            funding += signed * rate * initialNotional * fundingPeriods;
          }
          const pnlUsdt = realized + funding;
          const priceMovePercent = finalResult.exitPrice && entry ? (trade.direction === "خرید" ? (finalResult.exitPrice - entry) / entry : (entry - finalResult.exitPrice) / entry) * 100 : 0;
          const finalStatus = finalResult.status === "AMBIGUOUS" ? "AMBIGUOUS" : (realized > 0 ? "WIN" : "LOSS");
          const updated = { ...trade, status: finalStatus, result: finalStatus, firstTarget: finalResult.firstTarget, exitPrice: finalResult.exitPrice, pnlUsdt: Number(pnlUsdt.toFixed(4)), pnl: Number(pnlUsdt.toFixed(4)), pnlPercent: Number(priceMovePercent.toFixed(4)), priceMovePercent: Number(priceMovePercent.toFixed(4)), grossPnl: Number(totalGross.toFixed(4)), totalFees: Number(totalFees.toFixed(4)), fundingPnl: Number(funding.toFixed(4)), marginReturnPercent: safeNumber(trade.margin) > 0 ? Number((pnlUsdt / safeNumber(trade.margin) * 100).toFixed(4)) : 0, closedAt: now, candleTime: finalResult.candleTime, remainingPositionNotional: 0, realizedPnlUsdt: Number(pnlUsdt.toFixed(4)), realizedFees: totalFees, realizedGrossPnl: totalGross, realizedFunding: Number(funding.toFixed(4)), partialAccountingInitialized: true, updatedAt: now };
          await env.ALGO_ESMAIL_KV.put(trade.id, JSON.stringify(updated));
          closed++; if (finalStatus === "AMBIGUOUS") ambiguous++; closedTrades.push(updated); return;
        }

        if (changed) {
          const updated = { ...trade, currentStop, remainingPositionNotional: remaining, realizedPnlUsdt: Number(realized.toFixed(4)), realizedFees: Number(fees.toFixed(4)), realizedGrossPnl: Number(realizedGross.toFixed(4)), partialAccountingInitialized: true, lastProcessedCandleTime: lastProcessed, firstTarget, updatedAt: now };
          await env.ALGO_ESMAIL_KV.put(trade.id, JSON.stringify(updated));
        }
      } catch (error) { console.error("UPDATE PAPER TRADE ERROR:", trade.symbol, error?.stack || error); }
    }));
  }
  return { checked, closed, expired, ambiguous, closedTrades, milestoneTrades };
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

async function notifyMilestones(milestones, env) {
  if (!milestones?.length || !env.ALGO_ESMAIL_KV) return;
  const chats = await getSubscribedChats(env);
  if (!chats.length) return;
  for (const t of milestones) {
    const pct = t.milestone === "TP1" ? 30 : t.milestone === "TP2" ? 30 : 40;
    const text = `\n🟢 *برداشت پله‌ای انجام شد*\n\n🪙 ارز: *${t.symbol}*\n📌 جهت: ${t.direction}\n🎯 هدف: *${t.milestone}*\n💰 قیمت برداشت: \`${formatNumber(t.milestonePrice)}\`\n📦 مقدار بسته‌شده: *${pct}%*\n💵 سود/ضرر تحقق‌یافته تا این مرحله: *${safeNumber(t.realizedPnlUsdt).toFixed(2)} USDT*\n📦 پوزیشن باقی‌مانده: ${safeNumber(t.remainingPositionNotional).toFixed(2)} USDT\n🔒 حدضرر فعلی: \`${formatNumber(t.currentStop)}\`\n`;
    for (const chatId of chats) {
      try { await sendMessage(chatId, text, env, { parse_mode: "Markdown" }); } catch (e) { console.error("MILESTONE NOTIFICATION ERROR", chatId, e); }
      await sleep(50);
    }
  }
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
🧠 رژیم بازار: *${item.marketRegime?.name || "نامشخص"}*
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

💰 برداشت پله‌ای: 30% در TP1 → 30% در TP2 → 40% در TP3
🔒 پس از TP1: انتقال حدضرر به حوالی نقطه ورود

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
          x.entryReady &&
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
🤖 *ALGO FJM V6.2 SCANFIX V3*

✅ اسکن بازار توبیت تمام شد.

⏱ زمان اسکن: ${(elapsedMs / 1000).toFixed(1)} ثانیه

🔎 ارزهای بررسی‌شده: ${results.length}

✅ تحلیل موفق: ${valid.length}

❌ ناموفق: ${failed.length}

🧭 وضعیت کلی BTC: *${btcContext.direction}*
🧠 رژیم غالب بازار: *${valid[0]?.marketRegime?.name || "نامشخص"}*

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
  const started = Date.now();
  const diagnostics = {
    marketSymbols: 0,
    fastCandidates: 0,
    deepAnalyzed: 0,
    deepFailed: 0,
    directional: 0,
    regimeRejected: 0,
    setupRejected: 0,
    riskRejected: 0,
    derivativeEnriched: 0,
    finalOpportunities: 0,
    symbols: []
  };

  try {
    const selection = await getBestSymbols();
    const symbols = selection.selected || [];
    diagnostics.marketSymbols = safeNumber(selection.marketSymbolCount);
    diagnostics.fastCandidates = safeNumber(selection.fastCandidateCount);
    diagnostics.deepAnalyzed = symbols.length;

    if (!symbols.length) throw new Error("هیچ ارز مناسبی از Toobit دریافت نشد.");

    const btcPromise = getBTCContext();
    const results = await runInBatches(symbols, ANALYSIS_BATCH, analyzeSymbol);
    diagnostics.deepFailed = results.filter(x => x.failed).length;

    const btcContext = await btcPromise;

    const directionalBeforeDerivatives = results.filter(
      x => !x.failed && x.scanDiagnostic?.rawDirection !== "خنثی"
    );
    diagnostics.directional = directionalBeforeDerivatives.length;

    const pool = results
      .filter(x => !x.failed && x.direction !== "خنثی")
      .sort((a,b) => safeNumber(b.score) - safeNumber(a.score))
      .slice(0, DERIVATIVE_SHORTLIST_LIMIT);

    diagnostics.derivativeEnriched = pool.length;
    const enrichedPool = await enrichDerivatives(pool);
    const bySymbol = new Map(enrichedPool.map(x => [x.symbol, x]));
    const enriched = results.map(x => bySymbol.get(x.symbol) || x);

    for (const item of enriched) {
      const d = item.scanDiagnostic || {};
      const reasons = Array.isArray(d.rejectionReasons) ? [...d.rejectionReasons] : [];

      if (!item.failed && d.rawDirection !== "خنثی") {
        if (d.lowerAlignment < MIN_LOWER_TF_ALIGNMENT && !reasons.includes("LOWER_TF_CONFLICT")) reasons.push("LOWER_TF_CONFLICT");
        if (d.regimeDirection === "خنثی" && !reasons.some(x => x.startsWith("REGIME_"))) reasons.push(`REGIME_${d.regime || "UNKNOWN"}`);
        if (d.regimeDirection !== "خنثی" && d.regimeDirection !== d.rawDirection && safeNumber(d.regimeQuality) >= 70 && !reasons.includes("REGIME_CONFLICT")) reasons.push("REGIME_CONFLICT");
        if (!d.setupReady && !reasons.includes("SETUP_NOT_READY")) reasons.push("SETUP_NOT_READY");
        if (d.setupReady && safeNumber(d.setupQuality) < MIN_PRECISION_SCORE && !reasons.includes("PRECISION_SCORE_LOW")) reasons.push("PRECISION_SCORE_LOW");
        if (safeNumber(item.score) < MIN_SIGNAL_SCORE && !reasons.includes("SCORE_LOW")) reasons.push("SCORE_LOW");
      }

      if (item.failed) reasons.push("ANALYSIS_FAILED");

      item.scanDiagnostic = { ...d, score: safeNumber(item.score), rejectionReasons: reasons };
    }

    diagnostics.setupRejected = enriched.filter(x => !x.failed && x.scanDiagnostic?.rawDirection !== "خنثی" && (!x.entryReady || x.scanDiagnostic?.rejectionReasons?.includes("SETUP_NOT_READY") || x.scanDiagnostic?.rejectionReasons?.includes("PRECISION_SCORE_LOW"))).length;
    diagnostics.regimeRejected = enriched.filter(x => !x.failed && x.scanDiagnostic?.rejectionReasons?.some(r => r.startsWith("REGIME_"))).length;
    diagnostics.riskRejected = enriched.filter(x => !x.failed && x.scanDiagnostic?.rawDirection !== "خنثی" && x.entryReady && safeNumber(x.score) < MIN_SIGNAL_SCORE).length;

    const finalCandidates = enriched
      .filter(x => !x.failed && x.direction !== "خنثی" && x.entryReady && x.score >= MIN_SIGNAL_SCORE && x.marketRegime && x.marketRegime.direction !== "خنثی" && !["گذار / تغییر رژیم", "نوسان بی‌کیفیت", "رنج کم‌نوسان"].includes(x.marketRegime.name))
      .filter(x => calculateTrade(x) !== null);

    diagnostics.finalOpportunities = finalCandidates.length;

    const finalSymbols = new Set(finalCandidates.map(x => x.symbol));
    for (const item of enriched) {
      if (!item.failed && item.scanDiagnostic?.rawDirection !== "خنثی" && !finalSymbols.has(item.symbol)) {
        if (safeNumber(item.score) >= MIN_SIGNAL_SCORE && item.entryReady && !item.scanDiagnostic.rejectionReasons.some(r => r.startsWith("RISK_"))) {
          const trade = calculateTrade(item);
          if (!trade && !item.scanDiagnostic.rejectionReasons.includes("RISK_REJECTED")) item.scanDiagnostic.rejectionReasons.push("RISK_REJECTED");
        }
      }
    }

    diagnostics.symbols = enriched.map(item => ({
      symbol: item.symbol,
      failed: Boolean(item.failed),
      rawDirection: item.scanDiagnostic?.rawDirection || (item.failed ? "ERROR" : "خنثی"),
      finalDirection: item.direction || "خنثی",
      score: safeNumber(item.score),
      setupQuality: safeNumber(item.scanDiagnostic?.setupQuality),
      setupReady: Boolean(item.scanDiagnostic?.setupReady),
      lowerAlignment: safeNumber(item.scanDiagnostic?.lowerAlignment),
      regime: item.scanDiagnostic?.regime || item.marketRegime?.name || "نامشخص",
      reasons: item.scanDiagnostic?.rejectionReasons || []
    }));

    return { results: enriched, btcContext, elapsed: Date.now() - started, diagnostics };
  } catch (error) {
    console.error("SCAN ERROR:", error?.stack || error);
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
📊 *آمار معاملات آزمایشی ALGO FJM V6.2 SCANFIX V3*

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
📚 *تاریخچه معاملات ALGO FJM V6.2 SCANFIX V3*

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

  if (update.milestoneTrades?.length) {
    await notifyMilestones(update.milestoneTrades, env);
  }

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
🥈 هدف 2: \`${formatNumber(trade.tp2)}\`
🥉 هدف 3: \`${formatNumber(trade.tp3)}\`
📦 باقی‌مانده پوزیشن: ${safeNumber(trade.remainingPositionNotional, trade.positionNotional).toFixed(2)} USDT
📍 وضعیت اهداف: ${trade.tp2Hit ? "TP2 انجام شد" : trade.tp1Hit ? "TP1 انجام شد" : "TP1 در انتظار"}

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
📊 *داشبورد ALGO FJM V6.2 SCANFIX V3*

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
// منوی شیشه‌ای / کیبورد پایین تلگرام
// ============================================================

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🔎 اسکن بازار" }, { text: "📊 آمار" }],
      [{ text: "📝 معاملات باز" }, { text: "📚 تاریخچه" }],
      [{ text: "📈 داشبورد" }, { text: "🔬 تشخیص" }],
      [{ text: "🩺 وضعیت ربات" }, { text: "🩺 وضعیت اسکن" }],
      [{ text: "🔔 گزارش خودکار" }, { text: "ℹ️ راهنما" }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "یک گزینه را انتخاب کن"
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callback_data: "menu" }]]
  };
}

async function sendMenu(chatId, env, text = "🤖 *ALGO FJM V6.2 SCANFIX V3*\n\nیک گزینه را انتخاب کن:") {
  return sendMessage(chatId, text, env, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// ============================================================
// HELP
// ============================================================

function helpText() {
  return `
🤖 *ALGO FJM V6.2 SCANFIX V3*

منوی اصلی را از دکمه‌های پایین انتخاب کن.

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

/scanstatus 🩺 وضعیت و علت رد شدن نمادهای آخرین اسکن

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

⚙️ نسخه: V6.2 SCANFIX V3

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
// پایداری اجرای اسکن و جلوگیری از اجرای تکراری
// ============================================================
async function readScanLock(env) {
  if (!env.ALGO_ESMAIL_KV) return null;
  try {
    const raw = await env.ALGO_ESMAIL_KV.get(SCAN_LOCK_KEY);
    if (!raw) return null;
    const lock = JSON.parse(raw);
    if (!lock?.startedAt || Date.now() - safeNumber(lock.startedAt) > SCAN_LOCK_TTL_MS) {
      try { await env.ALGO_ESMAIL_KV.delete(SCAN_LOCK_KEY); } catch {}
      return null;
    }
    return lock;
  } catch { return null; }
}

async function acquireScanLock(env, source = "unknown", chatId = null) {
  if (!env.ALGO_ESMAIL_KV) return { acquired: true, id: `no-kv:${Date.now()}` };
  const existing = await readScanLock(env);
  if (existing) return { acquired: false, existing };
  const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const lock = { id, source, chatId, startedAt: Date.now(), updatedAt: Date.now() };
  await env.ALGO_ESMAIL_KV.put(SCAN_LOCK_KEY, JSON.stringify(lock), { expirationTtl: Math.ceil(SCAN_LOCK_TTL_MS / 1000) });
  const check = await env.ALGO_ESMAIL_KV.get(SCAN_LOCK_KEY);
  try {
    const parsed = JSON.parse(check || "null");
    if (!parsed || parsed.id !== id) return { acquired: false, existing: parsed };
  } catch { return { acquired: false, existing: null }; }
  return { acquired: true, id };
}

async function refreshScanLock(env, id) {
  if (!env.ALGO_ESMAIL_KV || !id) return;
  try {
    const raw = await env.ALGO_ESMAIL_KV.get(SCAN_LOCK_KEY);
    if (!raw) return;
    const lock = JSON.parse(raw);
    if (lock.id !== id) return;
    await env.ALGO_ESMAIL_KV.put(SCAN_LOCK_KEY, JSON.stringify({ ...lock, updatedAt: Date.now() }), { expirationTtl: Math.ceil(SCAN_LOCK_TTL_MS / 1000) });
  } catch (error) { console.error("SCAN LOCK REFRESH ERROR:", error?.stack || error); }
}

async function releaseScanLock(env, id) {
  if (!env.ALGO_ESMAIL_KV || !id) return;
  try {
    const raw = await env.ALGO_ESMAIL_KV.get(SCAN_LOCK_KEY);
    if (!raw) return;
    const lock = JSON.parse(raw);
    if (lock.id === id) await env.ALGO_ESMAIL_KV.delete(SCAN_LOCK_KEY);
  } catch (error) { console.error("SCAN LOCK RELEASE ERROR:", error?.stack || error); }
}

async function setScanStatus(env, patch) {
  if (!env.ALGO_ESMAIL_KV) return;
  try {
    let current = {};
    const raw = await env.ALGO_ESMAIL_KV.get(SCAN_STATUS_KEY);
    if (raw) { try { current = JSON.parse(raw) || {}; } catch {} }
    await env.ALGO_ESMAIL_KV.put(SCAN_STATUS_KEY, JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }), { expirationTtl: 86400 });
  } catch (error) { console.error("SCAN STATUS ERROR:", error?.stack || error); }
}

async function isUpdateProcessed(env, updateId) {
  if (!env.ALGO_ESMAIL_KV || updateId == null) return false;
  try { return Boolean(await env.ALGO_ESMAIL_KV.get(`update:${updateId}`)); } catch { return false; }
}

async function markUpdateProcessed(env, updateId) {
  if (!env.ALGO_ESMAIL_KV || updateId == null) return;
  try { await env.ALGO_ESMAIL_KV.put(`update:${updateId}`, "1", { expirationTtl: PROCESSED_UPDATE_TTL_SECONDS }); } catch (error) { console.error("UPDATE DEDUPE ERROR:", error?.stack || error); }
}

async function getScanStatus(env) {
  if (!env.ALGO_ESMAIL_KV) {
    return null;
  }
  try {
    const raw = await env.ALGO_ESMAIL_KV.get(SCAN_STATUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("SCAN STATUS READ ERROR:", error?.stack || error);
    return null;
  }
}

async function runManualScan(chatId, env) {
  const lock = await acquireScanLock(env, "manual", chatId);
  if (!lock.acquired) {
    await sendMessage(chatId, "⏳ یک اسکن دیگر در حال اجراست. بعد از پایان آن گزارش ارسال می‌شود.", env);
    return;
  }
  const lockId = lock.id;
  const startedAt = Date.now();
  await setScanStatus(env, { state: "RUNNING", source: "manual", chatId, startedAt, finishedAt: null, error: null });
  try {
    await sendMessage(chatId, "🔎 *اسکن بازار شروع شد.*\n\n⏳ نتیجه بعد از پایان اسکن ارسال می‌شود.", env, { parse_mode: "Markdown" });
    console.log("SCAN START", chatId, lockId);
    const scan = await performScan(env);
    await refreshScanLock(env, lockId);
    const paperInfo = await recordPaperTrades(scan.results, scan.btcContext, env);
    await refreshScanLock(env, lockId);
    let tradeUpdate = { checked: 0, closed: 0, ambiguous: 0, expired: 0, closedTrades: [], milestoneTrades: [] };
    try {
      tradeUpdate = await updateOpenPaperTrades(env);
      if (tradeUpdate.milestoneTrades?.length) await notifyMilestones(tradeUpdate.milestoneTrades, env);
      if (tradeUpdate.closedTrades?.length) await notifyClosedTrades(tradeUpdate.closedTrades, env);
    } catch (error) { console.error("MANUAL PAPER UPDATE ERROR:", error?.stack || error); }
    const report = buildScanReport(scan.results, scan.btcContext, scan.elapsed, paperInfo, tradeUpdate);
    await sendMessage(chatId, report, env, { parse_mode: "Markdown" });
    await setScanStatus(env, { state: "COMPLETED", source: "manual", chatId, startedAt, finishedAt: Date.now(), elapsed: scan.elapsed, diagnostics: scan.diagnostics, newTrades: paperInfo.saved, error: null });
    console.log("SCAN COMPLETE", chatId, scan.elapsed);
  } catch (error) {
    console.error("MANUAL SCAN ERROR:", error?.stack || error);
    await setScanStatus(env, { state: "FAILED", source: "manual", chatId, startedAt, finishedAt: Date.now(), error: String(error?.message || error) });
    try { await sendMessage(chatId, `❌ *اسکن بازار ناموفق بود.*\n\nخطا: \`${String(error?.message || error).slice(0, 700)}\`\n\n🔬 وضعیت خطا ثبت شد.`, env, { parse_mode: "Markdown" }); } catch (sendError) { console.error("MANUAL SCAN ERROR SEND FAILED:", sendError?.stack || sendError); }
  } finally {
    await releaseScanLock(env, lockId);
  }
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
    if (update?.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      if (!chatId) return;
      try { await telegram("answerCallbackQuery", { callback_query_id: cq.id }, env); } catch {}
      if (cq.data === "menu") {
        await sendMenu(chatId, env);
        return;
      }
      return;
    }
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

    const menuCommandMap = {
      "🔎 اسکن بازار": "/scan",
      "📊 آمار": "/stats",
      "📝 معاملات باز": "/paper",
      "📚 تاریخچه": "/history",
      "📈 داشبورد": "/dashboard",
      "🔬 تشخیص": "/diagnostics",
      "🩺 وضعیت ربات": "/health",
      "🩺 وضعیت اسکن": "/scanstatus",
      "🔔 گزارش خودکار": "/subscribe",
      "ℹ️ راهنما": "/help"
    };
    const mappedCommand = menuCommandMap[text] || command;

    // ========================================================
    // HELP
    // ========================================================

    if (
      mappedCommand === "/start" ||
      mappedCommand === "/help"
    ) {
      await sendMessage(
        chatId,
        helpText(),
        env,
        {
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard()
        }
      );

      return;
    }

    // ========================================================
    // HEALTH
    // ========================================================

    if (
      mappedCommand === "/health"
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
    // SCAN STATUS
    // ========================================================

    if (mappedCommand === "/scanstatus") {
      const status = await getScanStatus(env);
      if (!status) {
        await sendMessage(chatId, "🩺 هنوز هیچ وضعیت اسکن ثبت نشده است.", env);
        return;
      }

      const stateMap = {
        RECEIVED: "📥 دریافت شد",
        RUNNING: "🔄 در حال اجرا",
        COMPLETED: "✅ تکمیل شد",
        FAILED: "❌ ناموفق"
      };
      const state = stateMap[status.state] || status.state || "نامشخص";
      const elapsed = status.elapsed != null ? `${safeNumber(status.elapsed) / 1000} ثانیه` : "نامشخص";
      const d = status.diagnostics || {};

      const symbolLines = Array.isArray(d.symbols) && d.symbols.length
        ? d.symbols.map(x => {
            const reasons = Array.isArray(x.reasons) && x.reasons.length ? x.reasons.join(", ") : "—";
            return `• ${x.symbol}: ${x.rawDirection} → ${x.finalDirection} | S:${x.score} | Setup:${x.setupQuality} | Align:${x.lowerAlignment}/2 | ${x.regime} | ${reasons}`;
          }).join("\n")
        : "اطلاعات نمادها در این اسکن ثبت نشده است.";

      const text = `🩺 *وضعیت آخرین اسکن*\n\n📌 وضعیت: *${state}*\n🕐 زمان شروع: ${status.startedAt ? new Date(status.startedAt).toISOString() : "نامشخص"}\n⏱ مدت: ${elapsed}\n\n📦 بازار: ${d.marketSymbols ?? "نامشخص"}\n⚡ کاندید سریع: ${d.fastCandidates ?? "نامشخص"}\n🔬 تحلیل عمیق: ${d.deepAnalyzed ?? "نامشخص"}\n❌ تحلیل ناموفق: ${d.deepFailed ?? "نامشخص"}\n🧭 جهت‌دار: ${d.directional ?? "نامشخص"}\n🧪 مشتقات: ${d.derivativeEnriched ?? "نامشخص"}\n🛠 رد رژیم: ${d.regimeRejected ?? "نامشخص"}\n🛠 رد Setup: ${d.setupRejected ?? "نامشخص"}\n🛡 رد ریسک/امتیاز: ${d.riskRejected ?? "نامشخص"}\n🎯 فرصت نهایی: ${d.finalOpportunities ?? "نامشخص"}\n\n🔬 *جزئیات ۸ تحلیل:*\n${symbolLines}\n\n${status.error ? `⚠️ خطا: \`${String(status.error).slice(0, 700)}\`` : ""}`;
      await sendMessage(chatId, text, env, { parse_mode: "Markdown" });
      return;
    }

    // ========================================================
    // SUBSCRIBE
    // ========================================================

    if (
      mappedCommand === "/subscribe"
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
      mappedCommand === "/unsubscribe"
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
      mappedCommand === "/resetstats"
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

🤖 ALGO FJM V6.2 SCANFIX V3

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
      mappedCommand === "/dashboard"
    ) {
      const result = await getDashboard(env);
      await sendMessage(chatId, result, env, { parse_mode: "Markdown" });
      return;
    }

    // ========================================================
    // STATS
    // ========================================================

    if (
      mappedCommand === "/stats"
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
      mappedCommand === "/paper"
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
      mappedCommand === "/history"
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
      mappedCommand === "/diagnostics"
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
      mappedCommand === "/signal"
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

    if (mappedCommand === "/scan") {
      await sendMessage(chatId, "🔎 *اسکن بازار شروع شد.*\n\n⏳ نتیجه بعد از پایان اسکن ارسال می‌شود.", env, { parse_mode: "Markdown" });
      if (ctx?.waitUntil) ctx.waitUntil(runManualScan(chatId, env));
      else await runManualScan(chatId, env);
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

  const lock = await acquireScanLock(env, "scheduled", null);
  if (!lock.acquired) {
    console.log("SCHEDULED SCAN SKIPPED: another scan is running", lock.existing);
    return;
  }
  const lockId = lock.id;
  const startedAt = Date.now();
  await setScanStatus(env, { state: "RUNNING", source: "scheduled", chatId: null, startedAt, finishedAt: null, error: null });

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
    if (tradeUpdate.milestoneTrades?.length) {
      await notifyMilestones(tradeUpdate.milestoneTrades, env);
    }

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
    await refreshScanLock(env, lockId);

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
    await setScanStatus(env, { state: "COMPLETED", source: "scheduled", chatId: null, startedAt, finishedAt: Date.now(), elapsed: scan.elapsed, diagnostics: scan.diagnostics, newTrades: paperInfo.saved, error: null });
  } catch (error) {
    console.error(
      "SCHEDULED SCAN ERROR:",
      error?.stack ||
      error
    );
    await setScanStatus(env, { state: "FAILED", source: "scheduled", chatId: null, startedAt, finishedAt: Date.now(), error: String(error?.message || error) });
  } finally {
    await releaseScanLock(env, lockId);
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
        "ALGO FJM V6.2 SCANFIX V3 is LIVE 🤖",
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

        const updateId = update?.update_id;
        const text = String(update?.message?.text || "").trim();
        const command = text.split(/\s+/)[0].toLowerCase();

        if (command === "/scan" && update?.message?.chat?.id) {
          const chatId = update.message.chat.id;
          const task = (async () => {
            try {
              if (await isUpdateProcessed(env, updateId)) return;
              await setScanStatus(env, { state: "RECEIVED", source: "manual", chatId, receivedAt: Date.now(), startedAt: null, finishedAt: null, error: null });
              await runManualScan(chatId, env);
            } finally {
              await markUpdateProcessed(env, updateId);
            }
          })();
          ctx.waitUntil(task);
        } else {
          if (await isUpdateProcessed(env, updateId)) {
            return new Response("OK", { status: 200 });
          }
          await markUpdateProcessed(env, updateId);
          ctx.waitUntil(processUpdate(update, env, ctx));
        }

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
