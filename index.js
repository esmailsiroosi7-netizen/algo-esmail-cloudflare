const BASE_URL = "https://api.toobit.com";

const TIMEOUT_MS = 7000;

// --------------------------------------------------
// تنظیمات
// --------------------------------------------------

const PAPER_BUDGET = 100;
const RISK_PERCENT = 1;

const TOP_OPPORTUNITIES = 5;

// تعداد ارزهایی که در هر اسکن تحلیل می‌شوند
const MAX_ANALYSIS_SYMBOLS = 10;

// تعداد همزمان تحلیل‌ها
const ANALYSIS_BATCH = 3;

// حداقل امتیاز سیگنال
const MIN_SIGNAL_SCORE = 70;

// --------------------------------------------------
// ابزارهای عمومی
// --------------------------------------------------

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function log(message, data = "") {
  console.log(
    `[ALGO ESMAIL] ${message}`,
    data
  );
}

// --------------------------------------------------
// درخواست API با Timeout
// --------------------------------------------------

async function fetchWithTimeout(
  url,
  options = {}
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(
  url,
  options = {}
) {
  const response =
    await fetchWithTimeout(
      url,
      options
    );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return await response.json();
}

// --------------------------------------------------
// دریافت کندل‌ها
// --------------------------------------------------

async function getKlines(
  symbol,
  interval,
  limit = 200
) {
  const url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}` +
    `&limit=${limit}`;

  const data =
    await getJson(url);

  if (!Array.isArray(data)) {
    throw new Error(
      `داده کندل ${symbol} ${interval} نامعتبر است`
    );
  }

  return data
    .map(c => ({
      time: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5])
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    );
}

// --------------------------------------------------
// Funding Rate
// --------------------------------------------------

async function getFundingRate(
  symbol
) {
  try {
    const data =
      await getJson(
        `${BASE_URL}/api/v1/futures/fundingRate?symbol=${encodeURIComponent(symbol)}`
      );

    if (
      !Array.isArray(data) ||
      !data.length
    ) {
      return 0;
    }

    return Number(
      data[0].rate || 0
    );
  } catch (error) {
    log(
      `Funding ناموفق: ${symbol}`,
      error.message
    );

    return 0;
  }
}

// --------------------------------------------------
// Open Interest
// --------------------------------------------------

async function getOpenInterest(
  symbol
) {
  try {
    const data =
      await getJson(
        `${BASE_URL}/quote/v1/openInterest?symbol=${encodeURIComponent(symbol)}`
      );

    if (
      data &&
      Array.isArray(
        data.openInterestList
      ) &&
      data.openInterestList.length
    ) {
      return Number(
        data.openInterestList[0].size || 0
      );
    }

    return 0;
  } catch (error) {
    log(
      `OI ناموفق: ${symbol}`,
      error.message
    );

    return 0;
  }
}

// --------------------------------------------------
// Long / Short
// --------------------------------------------------

async function getLongShortRatio(
  symbol
) {
  try {
    const url =
      `${BASE_URL}/quote/v1/globalLongShortAccountRatio` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&period=1h` +
      `&limit=1`;

    const data =
      await getJson(url);

    if (
      !Array.isArray(data) ||
      !data.length
    ) {
      return 1;
    }

    return Number(
      data[0].longShortRatio || 1
    );
  } catch (error) {
    log(
      `LongShort ناموفق: ${symbol}`,
      error.message
    );

    return 1;
  }
}

// --------------------------------------------------
// نمادهای فعال
// --------------------------------------------------

async function getSymbols() {
  log("دریافت نمادهای فعال...");

  const data =
    await getJson(
      `${BASE_URL}/api/v1/exchangeInfo`
    );

  const contracts =
    Array.isArray(data.contracts)
      ? data.contracts
      : [];

  const symbols =
    contracts
      .filter(c =>
        c &&
        c.status === "TRADING" &&
        c.marginToken === "USDT" &&
        c.symbol &&
        c.symbol.endsWith(
          "-SWAP-USDT"
        )
      )
      .map(c => c.symbol);

  log(
    `تعداد نمادهای فعال: ${symbols.length}`
  );

  return symbols;
}

// --------------------------------------------------
// تیکر 24 ساعته
// --------------------------------------------------

async function getTickers() {
  try {
    const data =
      await getJson(
        `${BASE_URL}/quote/v1/contract/ticker/24hr`
      );

    if (!Array.isArray(data)) {
      return [];
    }

    return data;
  } catch (error) {
    log(
      "دریافت تیکر ناموفق",
      error.message
    );

    return [];
  }
}

// --------------------------------------------------
// انتخاب بهترین ارزها
// --------------------------------------------------

async function getBestSymbols() {
  log("انتخاب ارزهای مناسب...");

  const [
    symbols,
    tickers
  ] = await Promise.all([
    getSymbols(),
    getTickers()
  ]);

  const tickerMap =
    new Map();

  for (const ticker of tickers) {
    if (!ticker.s) {
      continue;
    }

    tickerMap.set(
      ticker.s,
      {
        volume:
          Number(ticker.v || 0),

        quoteVolume:
          Number(ticker.qv || 0),

        change:
          Number(ticker.pcp || 0)
      }
    );
  }

  const ranked =
    symbols
      .map(symbol => ({
        symbol,

        ...(tickerMap.get(
          symbol
        ) || {
          volume: 0,
          quoteVolume: 0,
          change: 0
        })
      }))
      .filter(
        x =>
          x.quoteVolume > 0
      )
      .sort(
        (a, b) =>
          b.quoteVolume -
          a.quoteVolume
      );

  const selected =
    ranked
      .slice(
        0,
        MAX_ANALYSIS_SYMBOLS
      )
      .map(
        x => x.symbol
      );

  log(
    `تعداد ارز انتخاب‌شده: ${selected.length}`,
    selected.join(", ")
  );

  return selected;
}

// --------------------------------------------------
// EMA
// --------------------------------------------------

function ema(
  values,
  period
) {
  if (!values.length) {
    return 0;
  }

  const multiplier =
    2 /
    (period + 1);

  let result =
    values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    result =
      (
        values[i] -
        result
      ) *
        multiplier +
      result;
  }

  return result;
}

// --------------------------------------------------
// RSI
// --------------------------------------------------

function calculateRSI(
  closes,
  period = 14
) {
  if (
    closes.length <= period
  ) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      closes[i] -
      closes[i - 1];

    if (change > 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  for (
    let i =
      period + 1;
    i < closes.length;
    i++
  ) {
    const change =
      closes[i] -
      closes[i - 1];

    const currentGain =
      Math.max(
        change,
        0
      );

    const currentLoss =
      Math.max(
        -change,
        0
      );

    avgGain =
      (
        avgGain *
          (period - 1) +
        currentGain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        currentLoss
      ) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 /
      (1 + rs)
  );
}

// --------------------------------------------------
// ATR
// --------------------------------------------------

function calculateATR(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return 0;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    const tr =
      Math.max(
        c.high -
          c.low,

        Math.abs(
          c.high -
          p.close
        ),

        Math.abs(
          c.low -
          p.close
        )
      );

    trs.push(tr);
  }

  const recent =
    trs.slice(-period);

  return (
    recent.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    recent.length
  );
}

// --------------------------------------------------
// MACD
// --------------------------------------------------

function calculateMACD(
  closes
) {
  if (
    closes.length < 35
  ) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0
    };
  }

  const macdValues = [];

  for (
    let i = 25;
    i < closes.length;
    i++
  ) {
    const slice =
      closes.slice(
        0,
        i + 1
      );

    const fast =
      ema(slice, 12);

    const slow =
      ema(slice, 26);

    macdValues.push(
      fast - slow
    );
  }

  const macd =
    macdValues[
      macdValues.length - 1
    ];

  const signal =
    ema(
      macdValues.slice(
        -9
      ),
      9
    );

  return {
    macd,
    signal,
    histogram:
      macd - signal
  };
}

// --------------------------------------------------
// ADX تقریبی
// --------------------------------------------------

function calculateADX(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 2
  ) {
    return 20;
  }

  let plusDM = 0;
  let minusDM = 0;
  let trSum = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    const up =
      c.high -
      p.high;

    const down =
      p.low -
      c.low;

    if (
      up > down &&
      up > 0
    ) {
      plusDM += up;
    }

    if (
      down > up &&
      down > 0
    ) {
      minusDM += down;
    }

    trSum +=
      Math.max(
        c.high -
          c.low,

        Math.abs(
          c.high -
          p.close
        ),

        Math.abs(
          c.low -
          p.close
        )
      );
  }

  if (trSum === 0) {
    return 0;
  }

  const plusDI =
    100 *
    plusDM /
    trSum;

  const minusDI =
    100 *
    minusDM /
    trSum;

  if (
    plusDI +
      minusDI ===
    0
  ) {
    return 0;
  }

  return (
    100 *
    Math.abs(
      plusDI -
        minusDI
    ) /
    (
      plusDI +
      minusDI
    )
  );
}

// --------------------------------------------------
// روند
// --------------------------------------------------

function getTrend(
  candles
) {
  if (
    !candles ||
    candles.length < 50
  ) {
    return "نامشخص";
  }

  const closes =
    candles.map(
      c => c.close
    );

  const price =
    closes[
      closes.length - 1
    ];

  const ema20 =
    ema(
      closes.slice(
        -80
      ),
      20
    );

  const ema50 =
    ema(
      closes.slice(
        -120
      ),
      50
    );

  const ema200 =
    ema(
      closes,
      200
    );

  if (
    price > ema20 &&
    ema20 > ema50 &&
    ema50 > ema200
  ) {
    return "صعودی قوی";
  }

  if (
    price > ema50 &&
    ema50 > ema200
  ) {
    return "صعودی";
  }

  if (
    price < ema20 &&
    ema20 < ema50 &&
    ema50 < ema200
  ) {
    return "نزولی قوی";
  }

  if (
    price < ema50 &&
    ema50 < ema200
  ) {
    return "نزولی";
  }

  return "خنثی";
}

// --------------------------------------------------
// حمایت و مقاومت
// --------------------------------------------------

function getSupportResistance(
  candles
) {
  const recent =
    candles.slice(-40);

  return {
    support:
      Math.min(
        ...recent.map(
          c => c.low
        )
      ),

    resistance:
      Math.max(
        ...recent.map(
          c => c.high
        )
      )
  };
}

// --------------------------------------------------
// تحلیل حجم
// --------------------------------------------------

function volumeAnalysis(
  candles
) {
  if (
    candles.length < 21
  ) {
    return {
      ratio: 1,
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -21,
      -1
    );

  const average =
    previous.reduce(
      (sum, c) =>
        sum + c.volume,
      0
    ) /
    previous.length;

  const ratio =
    average > 0
      ? current.volume /
        average
      : 1;

  return {
    ratio,

    bullish:
      ratio >= 1.2 &&
      current.close >
        current.open,

    bearish:
      ratio >= 1.2 &&
      current.close <
        current.open
  };
}

// --------------------------------------------------
// شکست
// --------------------------------------------------

function breakoutAnalysis(
  candles
) {
  if (
    candles.length < 25
  ) {
    return {
      bullish: false,
      bearish: false,
      falseBreakoutBull: false,
      falseBreakoutBear: false
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -21,
      -1
    );

  const high =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );

  return {
    bullish:
      current.close >
      high,

    bearish:
      current.close <
      low,

    falseBreakoutBull:
      current.high >
        high &&
      current.close <
        high,

    falseBreakoutBear:
      current.low <
        low &&
      current.close >
        low
  };
}

// --------------------------------------------------
// الگوهای کندلی
// --------------------------------------------------

function candlePatterns(
  candles
) {
  if (
    candles.length < 5
  ) {
    return {
      bullish: [],
      bearish: [],
      scoreLong: 0,
      scoreShort: 0
    };
  }

  const c =
    candles[
      candles.length - 1
    ];

  const p =
    candles[
      candles.length - 2
    ];

  const body =
    Math.abs(
      c.close -
      c.open
    );

  const range =
    c.high -
    c.low;

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
    ) -
    c.low;

  const bullish = [];
  const bearish = [];

  let scoreLong = 0;
  let scoreShort = 0;

  // دوجی
  if (
    range > 0 &&
    body / range < 0.1
  ) {
    bullish.push(
      "دوجی"
    );

    bearish.push(
      "دوجی"
    );
  }

  // چکش
  if (
    range > 0 &&
    lower >= body * 2 &&
    upper <= body
  ) {
    bullish.push(
      "چکش"
    );

    scoreLong += 5;
  }

  // شوتینگ استار
  if (
    range > 0 &&
    upper >= body * 2 &&
    lower <= body
  ) {
    bearish.push(
      "شوتینگ‌استار"
    );

    scoreShort += 5;
  }

  // پوشای صعودی
  if (
    p.close < p.open &&
    c.close > c.open &&
    c.open <= p.close &&
    c.close >= p.open
  ) {
    bullish.push(
      "پوشای صعودی"
    );

    scoreLong += 8;
  }

  // پوشای نزولی
  if (
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    bearish.push(
      "پوشای نزولی"
    );

    scoreShort += 8;
  }

  // پین‌بار صعودی
  if (
    lower >=
      body * 2.5 &&
    lower >
      upper * 1.5
  ) {
    bullish.push(
      "پین‌بار صعودی"
    );

    scoreLong += 4;
  }

  // پین‌بار نزولی
  if (
    upper >=
      body * 2.5 &&
    upper >
      lower * 1.5
  ) {
    bearish.push(
      "پین‌بار نزولی"
    );

    scoreShort += 4;
  }

  return {
    bullish,
    bearish,
    scoreLong,
    scoreShort
  };
}

// --------------------------------------------------
// ساختار بازار
// --------------------------------------------------

function marketStructure(
  candles
) {
  if (
    candles.length < 12
  ) {
    return {
      bullish: false,
      bearish: false,
      scoreLong: 0,
      scoreShort: 0
    };
  }

  const recent =
    candles.slice(-12);

  const mid =
    Math.floor(
      recent.length / 2
    );

  const first =
    recent.slice(
      0,
      mid
    );

  const second =
    recent.slice(
      mid
    );

  const high1 =
    Math.max(
      ...first.map(
        c => c.high
      )
    );

  const high2 =
    Math.max(
      ...second.map(
        c => c.high
      )
    );

  const low1 =
    Math.min(
      ...first.map(
        c => c.low
      )
    );

  const low2 =
    Math.min(
      ...second.map(
        c => c.low
      )
    );

  let scoreLong = 0;
  let scoreShort = 0;

  if (
    high2 > high1 &&
    low2 > low1
  ) {
    scoreLong = 8;
  }

  if (
    high2 < high1 &&
    low2 < low1
  ) {
    scoreShort = 8;
  }

  return {
    bullish:
      scoreLong > 0,

    bearish:
      scoreShort > 0,

    scoreLong,
    scoreShort
  };
}

// --------------------------------------------------
// BTC Context
// --------------------------------------------------

async function getBTCContext() {
  try {
    log(
      "تحلیل وضعیت BTC..."
    );

    const candles =
      await getKlines(
        "BTC-SWAP-USDT",
        "1h",
        100
      );

    const trend =
      getTrend(candles);

    const rsi =
      calculateRSI(
        candles.map(
          c => c.close
        )
      );

    return {
      trend,
      rsi
    };
  } catch (error) {
    log(
      "BTC Context ناموفق",
      error.message
    );

    return {
      trend: "نامشخص",
      rsi: 50
    };
  }
}

// --------------------------------------------------
// تحلیل یک نماد
// --------------------------------------------------

async function analyzeSymbol(
  symbol,
  btcContext
) {
  log(
    `شروع تحلیل ${symbol}`
  );

  const results =
    await Promise.allSettled([
      getKlines(
        symbol,
        "15m",
        100
      ),

      getKlines(
        symbol,
        "1h",
        160
      ),

      getKlines(
        symbol,
        "4h",
        160
      ),

      getFundingRate(
        symbol
      ),

      getOpenInterest(
        symbol
      ),

      getLongShortRatio(
        symbol
      )
    ]);

  const [
    m15Result,
    h1Result,
    h4Result,
    fundingResult,
    oiResult,
    ratioResult
  ] = results;

  if (
    h1Result.status !==
      "fulfilled" ||
    h4Result.status !==
      "fulfilled"
  ) {
    throw new Error(
      `کندل کافی برای ${symbol}`
    );
  }

  const h1 =
    h1Result.value;

  const h4 =
    h4Result.value;

  const m15 =
    m15Result.status ===
    "fulfilled"
      ? m15Result.value
      : h1;

  if (
    h1.length < 50 ||
    h4.length < 50
  ) {
    throw new Error(
      `تعداد کندل کم برای ${symbol}`
    );
  }

  const price =
    h1[
      h1.length - 1
    ].close;

  const trend15 =
    getTrend(m15);

  const trend1 =
    getTrend(h1);

  const trend4 =
    getTrend(h4);

  const closes =
    h1.map(
      c => c.close
    );

  const rsi =
    calculateRSI(
      closes
    );

  const macd =
    calculateMACD(
      closes
    );

  const atr =
    calculateATR(
      h1
    );

  const adx =
    calculateADX(
      h1
    );

  const volume =
    volumeAnalysis(
      h1
    );

  const breakout =
    breakoutAnalysis(
      h1
    );

  const structure =
    marketStructure(
      h1
    );

  const patterns =
    candlePatterns(
      h1
    );

  const levels =
    getSupportResistance(
      h1
    );

  const funding =
    fundingResult.status ===
    "fulfilled"
      ? fundingResult.value
      : 0;

  const openInterest =
    oiResult.status ===
    "fulfilled"
      ? oiResult.value
      : 0;

  const longShortRatio =
    ratioResult.status ===
    "fulfilled"
      ? ratioResult.value
      : 1;

  let longScore = 0;
  let shortScore = 0;

  // ------------------------------------------------
  // روند 4 ساعته
  // ------------------------------------------------

  if (
    trend4 ===
    "صعودی قوی"
  ) {
    longScore += 20;
  } else if (
    trend4 ===
    "صعودی"
  ) {
    longScore += 14;
  } else if (
    trend4 ===
    "نزولی قوی"
  ) {
    shortScore += 20;
  } else if (
    trend4 ===
    "نزولی"
  ) {
    shortScore += 14;
  }

  // ------------------------------------------------
  // روند 1 ساعته
  // ------------------------------------------------

  if (
    trend1 ===
    "صعودی قوی"
  ) {
    longScore += 18;
  } else if (
    trend1 ===
    "صعودی"
  ) {
    longScore += 13;
  } else if (
    trend1 ===
    "نزولی قوی"
  ) {
    shortScore += 18;
  } else if (
    trend1 ===
    "نزولی"
  ) {
    shortScore += 13;
  }

  // ------------------------------------------------
  // روند 15 دقیقه
  // ------------------------------------------------

  if (
    trend15.includes(
      "صعودی"
    )
  ) {
    longScore += 8;
  }

  if (
    trend15.includes(
      "نزولی"
    )
  ) {
    shortScore += 8;
  }

  // ------------------------------------------------
  // RSI
  // ------------------------------------------------

  if (
    rsi >= 52 &&
    rsi <= 68
  ) {
    longScore += 8;
  }

  if (
    rsi >= 32 &&
    rsi <= 48
  ) {
    shortScore += 8;
  }

  // ------------------------------------------------
  // MACD
  // ------------------------------------------------

  if (
    macd.histogram > 0
  ) {
    longScore += 7;
  }

  if (
    macd.histogram < 0
  ) {
    shortScore += 7;
  }

  // ------------------------------------------------
  // ADX
  // ------------------------------------------------

  if (
    adx >= 25
  ) {
    if (
      trend1.includes(
        "صعودی"
      )
    ) {
      longScore += 7;
    }

    if (
      trend1.includes(
        "نزولی"
      )
    ) {
      shortScore += 7;
    }
  }

  // ------------------------------------------------
  // حجم
  // ------------------------------------------------

  if (
    volume.bullish
  ) {
    longScore += 6;
  }

  if (
    volume.bearish
  ) {
    shortScore += 6;
  }

  // ------------------------------------------------
  // شکست
  // ------------------------------------------------

  if (
    breakout.bullish
  ) {
    longScore += 8;

    if (
      volume.ratio >= 1.2
    ) {
      longScore += 4;
    }
  }

  if (
    breakout.bearish
  ) {
    shortScore += 8;

    if (
      volume.ratio >= 1.2
    ) {
      shortScore += 4;
    }
  }

  // ------------------------------------------------
  // شکست جعلی
  // ------------------------------------------------

  if (
    breakout.falseBreakoutBull
  ) {
    shortScore += 5;
  }

  if (
    breakout.falseBreakoutBear
  ) {
    longScore += 5;
  }

  // ------------------------------------------------
  // ساختار بازار
  // ------------------------------------------------

  longScore +=
    structure.scoreLong;

  shortScore +=
    structure.scoreShort;

  // ------------------------------------------------
  // الگوهای کندلی
  // ------------------------------------------------

  longScore +=
    patterns.scoreLong;

  shortScore +=
    patterns.scoreShort;

  // ------------------------------------------------
  // BTC Context
  // ------------------------------------------------

  if (
    symbol !==
    "BTC-SWAP-USDT"
  ) {
    if (
      btcContext.trend.includes(
        "نزولی"
      )
    ) {
      longScore -= 5;
    }

    if (
      btcContext.trend.includes(
        "صعودی"
      )
    ) {
      longScore += 3;
    }

    if (
      btcContext.trend.includes(
        "صعودی"
      )
    ) {
      shortScore -= 3;
    }

    if (
      btcContext.trend.includes(
        "نزولی"
      )
    ) {
      shortScore += 3;
    }
  }

  // ------------------------------------------------
  // Funding
  // ------------------------------------------------

  if (
    funding > 0.0015
  ) {
    shortScore += 4;
  }

  if (
    funding < -0.0015
  ) {
    longScore += 4;
  }

  // ------------------------------------------------
  // Long / Short
  // ------------------------------------------------

  if (
    longShortRatio > 1.6
  ) {
    shortScore += 3;
  }

  if (
    longShortRatio < 0.65
  ) {
    longScore += 3;
  }

  // ------------------------------------------------
  // محدود کردن امتیاز
  // ------------------------------------------------

  longScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          longScore
        )
      )
    );

  shortScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          shortScore
        )
      )
    );

  const bestScore =
    Math.max(
      longScore,
      shortScore
    );

  let signal =
    "بدون سیگنال";

  if (
    longScore >=
      MIN_SIGNAL_SCORE &&
    longScore >
      shortScore + 8
  ) {
    signal =
      "فرصت خرید";
  }

  if (
    shortScore >=
      MIN_SIGNAL_SCORE &&
    shortScore >
      longScore + 8
  ) {
    signal =
      "فرصت فروش";
  }

  // ------------------------------------------------
  // مدیریت معامله
  // ------------------------------------------------

  let stop = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  let riskPerUnit = 0;

  if (
    signal ===
      "فرصت خرید" &&
    atr > 0
  ) {
    stop =
      price -
      atr * 1.2;

    riskPerUnit =
      price -
      stop;

    tp1 =
      price +
      riskPerUnit *
        1.2;

    tp2 =
      price +
      riskPerUnit *
        2;

    tp3 =
      price +
      riskPerUnit *
        3;
  }

  if (
    signal ===
      "فرصت فروش" &&
    atr > 0
  ) {
    stop =
      price +
      atr * 1.2;

    riskPerUnit =
      stop -
      price;

    tp1 =
      price -
      riskPerUnit *
        1.2;

    tp2 =
      price -
      riskPerUnit *
        2;

    tp3 =
      price -
      riskPerUnit *
        3;
  }

  // ------------------------------------------------
  // اندازه معامله
  // ------------------------------------------------

  const maxLoss =
    PAPER_BUDGET *
    (
      RISK_PERCENT /
      100
    );

  let positionSize = 0;

  if (
    riskPerUnit > 0
  ) {
    positionSize =
      maxLoss /
      riskPerUnit;
  }

  // ------------------------------------------------
  // لوریج
  // ------------------------------------------------

  let leverage = 1;

  if (
    signal !==
    "بدون سیگنال"
  ) {
    const volatility =
      atr / price;

    if (
      volatility < 0.008
    ) {
      leverage = 5;
    } else if (
      volatility < 0.015
    ) {
      leverage = 4;
    } else if (
      volatility < 0.03
    ) {
      leverage = 3;
    } else {
      leverage = 2;
    }
  }

  const result = {
    symbol,
    price,

    signal,

    longScore,
    shortScore,
    bestScore,

    trend15,
    trend1,
    trend4,

    rsi,
    adx,

    macdHistogram:
      macd.histogram,

    volumeRatio:
      volume.ratio,

    support:
      levels.support,

    resistance:
      levels.resistance,

    atr,

    candleBullish:
      patterns.bullish,

    candleBearish:
      patterns.bearish,

    marketStructure:
      structure.bullish
        ? "صعودی"
        : structure.bearish
        ? "نزولی"
        : "خنثی",

    breakoutBullish:
      breakout.bullish,

    breakoutBearish:
      breakout.bearish,

    falseBreakoutBull:
      breakout.falseBreakoutBull,

    falseBreakoutBear:
      breakout.falseBreakoutBear,

    fundingRate:
      funding,

    openInterest,

    longShortRatio,

    btcTrend:
      btcContext.trend,

    btcRSI:
      btcContext.rsi,

    stop,
    tp1,
    tp2,
    tp3,

    positionSize,
    leverage
  };

  log(
    `پایان تحلیل ${symbol}`,
    `Score=${bestScore} Signal=${signal}`
  );

  return result;
}

// --------------------------------------------------
// فرمت قیمت
// --------------------------------------------------

function formatPrice(
  value
) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value)
  ) {
    return "—";
  }

  if (value >= 1000) {
    return value.toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 2
      }
    );
  }

  if (value >= 1) {
    return value.toFixed(4);
  }

  if (value >= 0.01) {
    return value.toFixed(6);
  }

  return value.toFixed(8);
}

// --------------------------------------------------
// درصد
// --------------------------------------------------

function formatPercent(
  value
) {
  return (
    (
      Number(value) *
      100
    ).toFixed(3) +
    "%"
  );
}

// --------------------------------------------------
// KV
// --------------------------------------------------

function getKV(env) {
  if (
    !env.ALGO_ESMAIL_KV
  ) {
    throw new Error(
      "KV متصل نیست"
    );
  }

  return env.ALGO_ESMAIL_KV;
}

// --------------------------------------------------
// Chat
// --------------------------------------------------

async function saveChat(
  env,
  chatId
) {
  const kv =
    getKV(env);

  await kv.put(
    `chat:${chatId}`,
    "active"
  );
}

async function removeChat(
  env,
  chatId
) {
  const kv =
    getKV(env);

  await kv.delete(
    `chat:${chatId}`
  );
}

async function getSubscribedChats(
  env
) {
  const kv =
    getKV(env);

  const list =
    await kv.list({
      prefix: "chat:"
    });

  return list.keys.map(
    key =>
      key.name.replace(
        "chat:",
        ""
      )
  );
}

// --------------------------------------------------
// معامله باز
// --------------------------------------------------

async function getOpenTrade(
  env,
  symbol
) {
  const kv =
    getKV(env);

  const list =
    await kv.list({
      prefix: "trade:"
    });

  for (
    const key of list.keys
  ) {
    const raw =
      await kv.get(
        key.name
      );

    if (!raw) {
      continue;
    }

    try {
      const trade =
        JSON.parse(raw);

      if (
        trade.symbol ===
          symbol &&
        trade.status ===
          "open"
      ) {
        return trade;
      }
    } catch {}
  }

  return null;
}

// --------------------------------------------------
// Paper Trade
// --------------------------------------------------

async function savePaperTrade(
  env,
  result
) {
  if (
    result.signal ===
    "بدون سیگنال"
  ) {
    return null;
  }

  const existing =
    await getOpenTrade(
      env,
      result.symbol
    );

  if (existing) {
    return existing;
  }

  const kv =
    getKV(env);

  const id =
    `${Date.now()}-${result.symbol}`;

  const trade = {
    id,

    time:
      new Date().toISOString(),

    symbol:
      result.symbol,

    direction:
      result.signal,

    entry:
      result.price,

    stop:
      result.stop,

    tp1:
      result.tp1,

    tp2:
      result.tp2,

    tp3:
      result.tp3,

    score:
      result.bestScore,

    leverage:
      result.leverage,

    positionSize:
      result.positionSize,

    riskAmount:
      PAPER_BUDGET *
      (
        RISK_PERCENT /
        100
      ),

    status:
      "open",

    target1Hit:
      false,

    target2Hit:
      false,

    target3Hit:
      false,

    maxFavorable:
      0,

    maxAdverse:
      0,

    factors: {
      trend15:
        result.trend15,

      trend1:
        result.trend1,

      trend4:
        result.trend4,

      rsi:
        result.rsi,

      adx:
        result.adx,

      macdHistogram:
        result.macdHistogram,

      volumeRatio:
        result.volumeRatio,

      fundingRate:
        result.fundingRate,

      longShortRatio:
        result.longShortRatio,

      candleBullish:
        result.candleBullish,

      candleBearish:
        result.candleBearish,

      marketStructure:
        result.marketStructure,

      breakoutBullish:
        result.breakoutBullish,

      breakoutBearish:
        result.breakoutBearish
    }
  };

  await kv.put(
    `trade:${id}`,
    JSON.stringify(trade)
  );

  return trade;
}

// --------------------------------------------------
// بررسی معاملات
// --------------------------------------------------

async function updatePaperTrades(
  env
) {
  const kv =
    getKV(env);

  const list =
    await kv.list({
      prefix: "trade:"
    });

  let updated = 0;

  for (
    const key of list.keys
  ) {
    const raw =
      await kv.get(
        key.name
      );

    if (!raw) {
      continue;
    }

    let trade;

    try {
      trade =
        JSON.parse(raw);
    } catch {
      continue;
    }

    if (
      trade.status !==
      "open"
    ) {
      continue;
    }

    try {
      const candles =
        await getKlines(
          trade.symbol,
          "1m",
          3
        );

      if (
        !candles.length
      ) {
        continue;
      }

      const latest =
        candles[
          candles.length - 1
        ];

      const price =
        latest.close;

      let favorable = 0;
      let adverse = 0;

      if (
        trade.direction ===
        "فرصت خرید"
      ) {
        favorable =
          Math.max(
            0,
            price -
              trade.entry
          );

        adverse =
          Math.max(
            0,
            trade.entry -
              price
          );
      } else {
        favorable =
          Math.max(
            0,
            trade.entry -
              price
          );

        adverse =
          Math.max(
            0,
            price -
              trade.entry
          );
      }

      trade.maxFavorable =
        Math.max(
          trade.maxFavorable ||
            0,
          favorable
        );

      trade.maxAdverse =
        Math.max(
          trade.maxAdverse ||
            0,
          adverse
        );

      let result =
        null;

      // ------------------------------
      // Long
      // ------------------------------

      if (
        trade.direction ===
        "فرصت خرید"
      ) {
        if (
          latest.low <=
          trade.stop
        ) {
          result = {
            status: "loss",
            exit:
              trade.stop,
            reason:
              "حد ضرر"
          };
        } else if (
          latest.high >=
          trade.tp3
        ) {
          result = {
            status: "win",
            exit:
              trade.tp3,
            reason:
              "هدف سوم"
          };
        } else if (
          latest.high >=
          trade.tp2
        ) {
          trade.target2Hit =
            true;
        } else if (
          latest.high >=
          trade.tp1
        ) {
          trade.target1Hit =
            true;
        }
      }

      // ------------------------------
      // Short
      // ------------------------------

      if (
        trade.direction ===
        "فرصت فروش"
      ) {
        if (
          latest.high >=
          trade.stop
        ) {
          result = {
            status: "loss",
            exit:
              trade.stop,
            reason:
              "حد ضرر"
          };
        } else if (
          latest.low <=
          trade.tp3
        ) {
          result = {
            status: "win",
            exit:
              trade.tp3,
            reason:
              "هدف سوم"
          };
        } else if (
          latest.low <=
          trade.tp2
        ) {
          trade.target2Hit =
            true;
        } else if (
          latest.low <=
          trade.tp1
        ) {
          trade.target1Hit =
            true;
        }
      }

      if (result) {
        trade.status =
          result.status;

        trade.exit =
          result.exit;

        trade.reason =
          result.reason;

        trade.closeTime =
          new Date().toISOString();

        if (
          trade.direction ===
          "فرصت خرید"
        ) {
          trade.pnl =
            (
              result.exit -
              trade.entry
            ) *
            trade.positionSize *
            trade.leverage;
        } else {
          trade.pnl =
            (
              trade.entry -
              result.exit
            ) *
            trade.positionSize *
            trade.leverage;
        }

        trade.pnlPercent =
          (
            trade.pnl /
            PAPER_BUDGET
          ) *
          100;
      }

      await kv.put(
        key.name,
        JSON.stringify(
          trade
        )
      );

      updated++;

    } catch (error) {
      log(
        `خطای پیگیری ${trade.symbol}`,
        error.message
      );
    }
  }

  return updated;
}

// --------------------------------------------------
// آمار معاملات
// --------------------------------------------------

async function getTradeStats(
  env
) {
  const kv =
    getKV(env);

  const list =
    await kv.list({
      prefix: "trade:"
    });

  const trades = [];

  for (
    const key of list.keys
  ) {
    const raw =
      await kv.get(
        key.name
      );

    if (!raw) {
      continue;
    }

    try {
      trades.push(
        JSON.parse(raw)
      );
    } catch {}
  }

  const closed =
    trades.filter(
      t =>
        t.status ===
          "win" ||
        t.status ===
          "loss"
    );

  const wins =
    closed.filter(
      t =>
        t.status ===
        "win"
    );

  const losses =
    closed.filter(
      t =>
        t.status ===
        "loss"
    );

  const pnl =
    closed.reduce(
      (sum, t) =>
        sum +
        Number(
          t.pnl || 0
        ),
      0
    );

  const winRate =
    closed.length
      ? (
          wins.length /
          closed.length
        ) *
        100
      : 0;

  const groups = {
    "70-79": [],
    "80-89": [],
    "90-100": []
  };

  for (
    const t of closed
  ) {
    if (
      t.score >= 70 &&
      t.score < 80
    ) {
      groups[
        "70-79"
      ].push(t);
    } else if (
      t.score >= 80 &&
      t.score < 90
    ) {
      groups[
        "80-89"
      ].push(t);
    } else if (
      t.score >= 90
    ) {
      groups[
        "90-100"
      ].push(t);
    }
  }

  const groupStats = {};

  for (
    const [
      name,
      arr
    ] of Object.entries(
      groups
    )
  ) {
    const gwins =
      arr.filter(
        t =>
          t.status ===
          "win"
      ).length;

    groupStats[name] = {
      count:
        arr.length,

      winRate:
        arr.length
          ? (
              gwins /
              arr.length
            ) *
            100
          : 0
    };
  }

  return {
    total:
      trades.length,

    open:
      trades.filter(
        t =>
          t.status ===
          "open"
      ).length,

    closed:
      closed.length,

    wins:
      wins.length,

    losses:
      losses.length,

    winRate,

    pnl,

    groupStats
  };
}

// --------------------------------------------------
// گزارش آمار
// --------------------------------------------------

async function makeStatsReport(
  env
) {
  const stats =
    await getTradeStats(
      env
    );

  return `
📊 *گزارش عملکرد Algo Esmail*

📁 کل معاملات:
${stats.total}

🟡 باز:
${stats.open}

📕 بسته‌شده:
${stats.closed}

🟢 موفق:
${stats.wins}

🔴 ناموفق:
${stats.losses}

🎯 نرخ موفقیت:
${stats.winRate.toFixed(1)}٪

💰 سود/ضرر فرضی:
${stats.pnl.toFixed(2)} USDT

━━━━━━━━━━━━━━

📈 عملکرد بر اساس امتیاز

⭐ 70 تا 79:
${stats.groupStats["70-79"].count} معامله
موفقیت:
${stats.groupStats["70-79"].winRate.toFixed(1)}٪

⭐ 80 تا 89:
${stats.groupStats["80-89"].count} معامله
موفقیت:
${stats.groupStats["80-89"].winRate.toFixed(1)}٪

⭐ 90 تا 100:
${stats.groupStats["90-100"].count} معامله
موفقیت:
${stats.groupStats["90-100"].winRate.toFixed(1)}٪

🧪 تمام نتایج آزمایشی هستند.
`;
}

// --------------------------------------------------
// اسکن بازار
// --------------------------------------------------

async function scanMarket() {
  const started =
    Date.now();

  log(
    "========== شروع اسکن =========="
  );

  const symbols =
    await getBestSymbols();

  if (
    !symbols.length
  ) {
    throw new Error(
      "هیچ نماد فعالی برای اسکن پیدا نشد"
    );
  }

  log(
    `تعداد ارزهای اسکن: ${symbols.length}`
  );

  const btcContext =
    await getBTCContext();

  const results = [];

  for (
    let i = 0;
    i < symbols.length;
    i += ANALYSIS_BATCH
  ) {
    const batch =
      symbols.slice(
        i,
        i +
          ANALYSIS_BATCH
      );

    log(
      `Batch ${Math.floor(i / ANALYSIS_BATCH) + 1} شروع شد`,
      batch.join(", ")
    );

    const batchResults =
      await Promise.all(
        batch.map(
          async symbol => {
            try {
              return await analyzeSymbol(
                symbol,
                btcContext
              );
            } catch (error) {
              log(
                `خطا در تحلیل ${symbol}`,
                error.message
              );

              return null;
            }
          }
        )
      );

    results.push(
      ...batchResults.filter(
        Boolean
      )
    );

    log(
      `پیشرفت اسکن: ${results.length}/${symbols.length}`
    );
  }

  results.sort(
    (a, b) =>
      b.bestScore -
      a.bestScore
  );

  log(
    `========== پایان اسکن | ${Date.now() - started}ms ==========`
  );

  return results;
}

// --------------------------------------------------
// گزارش اسکن
// --------------------------------------------------

function makeScanReport(
  results
) {
  if (
    !results.length
  ) {
    return `
❌ *اسکن انجام نشد*

هیچ اطلاعات قابل استفاده‌ای از بازار دریافت نشد.
`;
  }

  let message = `
🔎 *تحلیل بازار توبیت*

💵 بودجه آزمایشی:
${PAPER_BUDGET} USDT

📊 تعداد ارزهای بررسی‌شده:
${results.length}

`;

  results
    .slice(
      0,
      TOP_OPPORTUNITIES
    )
    .forEach(
      (r, index) => {
        let signal =
          "⏳ بدون سیگنال";

        if (
          r.signal ===
          "فرصت خرید"
        ) {
          signal =
            "🟢 فرصت خرید";
        }

        if (
          r.signal ===
          "فرصت فروش"
        ) {
          signal =
            "🔴 فرصت فروش";
        }

        message += `
*${index + 1}. ${r.symbol}*

${signal}

⭐ امتیاز:
${r.bestScore} از 100

🟢 امتیاز خرید:
${r.longScore}

🔴 امتیاز فروش:
${r.shortScore}

📈 روند ۴ ساعته:
${r.trend4}

📈 روند ۱ ساعته:
${r.trend1}

⏱ روند ۱۵ دقیقه:
${r.trend15}

💪 قدرت روند:
${r.adx.toFixed(1)}

📊 شاخص قدرت بازار:
${r.rsi.toFixed(1)}

📊 حجم:
${r.volumeRatio.toFixed(2)} برابر

🕯️ الگوی کندلی:
${
  r.signal ===
  "فرصت خرید"
    ? (
        r.candleBullish.join(
          "، "
        ) ||
        "مورد مهمی دیده نشد"
      )
    : (
        r.candleBearish.join(
          "، "
        ) ||
        "مورد مهمی دیده نشد"
      )
}

📐 ساختار بازار:
${r.marketStructure}

💸 نرخ تأمین:
${formatPercent(
  r.fundingRate
)}

👥 نسبت خریداران به فروشندگان:
${r.longShortRatio.toFixed(2)}

💰 قیمت:
${formatPrice(
  r.price
)}
`;

        if (
          r.signal !==
          "بدون سیگنال"
        ) {
          message += `
━━━━━━━━━━━━━━

🎯 نقطه ورود:
${formatPrice(
  r.price
)}

🛑 حد ضرر:
${formatPrice(
  r.stop
)}

🎯 هدف اول:
${formatPrice(
  r.tp1
)}

🎯 هدف دوم:
${formatPrice(
  r.tp2
)}

🎯 هدف سوم:
${formatPrice(
  r.tp3
)}

💵 حجم پیشنهادی:
${r.positionSize.toFixed(
  4
)}

⚙️ لوریج آزمایشی:
${r.leverage}x

🧪 وضعیت:
ثبت در معاملات آزمایشی
`;
        }

        message +=
          "\n━━━━━━━━━━━━━━\n";
      }
    );

  message += `
⚠️ معاملات این نسخه واقعی نیستند.
`;

  return message;
}

// --------------------------------------------------
// گزارش ساعتی
// --------------------------------------------------

function makeHourlyReport(
  results
) {
  const strong =
    results
      .filter(
        r =>
          r.signal !==
          "بدون سیگنال"
      )
      .slice(
        0,
        TOP_OPPORTUNITIES
      );

  if (
    !strong.length
  ) {
    return `
⏰ *گزارش ساعتی بازار*

در حال حاضر فرصت معاملاتی قدرتمندی پیدا نشد.

🔎 بازار همچنان تحت نظر است.
`;
  }

  let message = `
🚨 *گزارش ساعتی بازار*

بهترین فرصت‌های فعلی:

`;

  strong.forEach(
    (r, index) => {
      message += `
${index + 1}. *${r.symbol}*

${
  r.signal ===
  "فرصت خرید"
    ? "🟢 فرصت خرید"
    : "🔴 فرصت فروش"
}

⭐ امتیاز:
${r.bestScore} از 100

💰 قیمت:
${formatPrice(
  r.price
)}

🛑 حد ضرر:
${formatPrice(
  r.stop
)}

🎯 هدف اول:
${formatPrice(
  r.tp1
)}

🎯 هدف دوم:
${formatPrice(
  r.tp2
)}

⚙️ لوریج آزمایشی:
${r.leverage}x

━━━━━━━━━━━━━━
`;
    }
  );

  return (
    message +
    `
🧪 معاملات فعلاً آزمایشی هستند.
`
  );
}

// --------------------------------------------------
// Telegram
// --------------------------------------------------

async function sendTelegram(
  token,
  chatId,
  text
) {
  if (
    !token ||
    !chatId
  ) {
    throw new Error(
      "Telegram token یا chatId موجود نیست"
    );
  }

  const response =
    await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id:
              chatId,

            text,

            parse_mode:
              "Markdown",

            disable_web_page_preview:
              true
          })
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      data.description ||
        "خطای تلگرام"
    );
  }

  return data;
}

// --------------------------------------------------
// پردازش /scan
// --------------------------------------------------

async function processScan(
  env,
  token,
  chatId
) {
  try {
    log(
      `پردازش اسکن برای ${chatId}`
    );

    // بررسی معاملات قبلی
    try {
      await updatePaperTrades(
        env
      );
    } catch (error) {
      log(
        "خطا در updatePaperTrades",
        error.message
      );
    }

    // اسکن
    const results =
      await scanMarket();

    log(
      `اسکن کامل شد. نتایج: ${results.length}`
    );

    // ثبت معاملات آزمایشی
    for (
      const result of results
    ) {
      try {
        await savePaperTrade(
          env,
          result
        );
      } catch (error) {
        log(
          `خطای ذخیره ${result.symbol}`,
          error.message
        );
      }
    }

    // ارسال گزارش
    const report =
      makeScanReport(
        results
      );

    await sendTelegram(
      token,
      chatId,
      report
    );

    log(
      `گزارش اسکن برای ${chatId} ارسال شد`
    );

  } catch (error) {
    log(
      "SCAN BACKGROUND ERROR",
      error.stack ||
        error.message
    );

    try {
      await sendTelegram(
        token,
        chatId,
        `
❌ *اسکن بازار با خطا متوقف شد.*

🔎 مرحله اسکن نتوانست کامل شود.

🛠️ خطا:
${String(
  error.message ||
    "خطای نامشخص"
).slice(
  0,
  500
)}

لطفاً دوباره /scan را امتحان کنید.
`
      );
    } catch (
      telegramError
    ) {
      log(
        "ارسال خطای اسکن به تلگرام ناموفق",
        telegramError.message
      );
    }
  }
}

// --------------------------------------------------
// پردازش پیام
// --------------------------------------------------

async function handleUpdate(
  update,
  env,
  ctx
) {
  if (
    !update ||
    !update.message
  ) {
    return;
  }

  const token =
    env.BOT_TOKEN;

  if (!token) {
    throw new Error(
      "BOT_TOKEN تنظیم نشده"
    );
  }

  const chatId =
    update.message.chat.id;

  const text =
    update.message.text ||
    "";

  // ------------------------------------------------
  // START
  // ------------------------------------------------

  if (
    text ===
    "/start"
  ) {
    await sendTelegram(
      token,
      chatId,
      `
🤖 *Algo Esmail V5*

ربات با موفقیت فعال است. 🚀

/scan
🔎 تحلیل بازار

/signal BTC
📊 تحلیل یک ارز

/subscribe
⏰ گزارش خودکار ساعتی

/unsubscribe
❌ لغو گزارش خودکار

/stats
📊 عملکرد معاملات آزمایشی

/help
📚 راهنما

🧪 معاملات واقعی غیرفعال هستند.
`
    );

    return;
  }

  // ------------------------------------------------
  // HELP
  // ------------------------------------------------

  if (
    text ===
    "/help"
  ) {
    await sendTelegram(
      token,
      chatId,
      `
📚 *راهنمای Algo Esmail V5*

/scan
بررسی بازار و پیدا کردن فرصت‌ها

/signal BTC
تحلیل بیت‌کوین یا ارز دلخواه

/subscribe
گزارش خودکار ساعتی

/unsubscribe
لغو گزارش ساعتی

/stats
گزارش عملکرد Paper Trading

🧪 معاملات واقعی غیرفعال هستند.
`
    );

    return;
  }

  // ------------------------------------------------
  // SUBSCRIBE
  // ------------------------------------------------

  if (
    text ===
    "/subscribe"
  ) {
    await saveChat(
      env,
      chatId
    );

    await sendTelegram(
      token,
      chatId,
      `
✅ *گزارش خودکار فعال شد.*

ربات هر ساعت بازار را بررسی می‌کند.

🧪 معاملات فعلاً آزمایشی هستند.
`
    );

    return;
  }

  // ------------------------------------------------
  // UNSUBSCRIBE
  // ------------------------------------------------

  if (
    text ===
    "/unsubscribe"
  ) {
    await removeChat(
      env,
      chatId
    );

    await sendTelegram(
      token,
      chatId,
      `
✅ گزارش خودکار غیرفعال شد.
`
    );

    return;
  }

  // ------------------------------------------------
  // STATS
  // ------------------------------------------------

  if (
    text ===
    "/stats"
  ) {
    try {
      await updatePaperTrades(
        env
      );

      const report =
        await makeStatsReport(
          env
        );

      await sendTelegram(
        token,
        chatId,
        report
      );

    } catch (error) {
      log(
        "STATS ERROR",
        error.message
      );

      await sendTelegram(
        token,
        chatId,
        `
❌ دریافت آمار با خطا مواجه شد.

🛠️ خطا:
${String(
  error.message ||
    "خطای نامشخص"
).slice(
  0,
  400
)}
`
      );
    }

    return;
  }

  // ------------------------------------------------
  // SCAN
  // ------------------------------------------------

  if (
    text ===
    "/scan"
  ) {
    // پیام فقط یک بار ارسال می‌شود
    await sendTelegram(
      token,
      chatId,
      `
🔎 *در حال بررسی بازار توبیت...*

⏳ لطفاً چند لحظه صبر کنید.

نتیجه پس از پایان اسکن ارسال می‌شود.
`
    );

    // اجرای اسکن در پس‌زمینه
    ctx.waitUntil(
      processScan(
        env,
        token,
        chatId
      )
    );

    return;
  }

  // ------------------------------------------------
  // SIGNAL
  // ------------------------------------------------

  if (
    text.startsWith(
      "/signal"
    )
  ) {
    let symbol =
      text
        .replace(
          "/signal",
          ""
        )
        .trim()
        .toUpperCase();

    if (!symbol) {
      symbol =
        "BTC";
    }

    if (
      !symbol.includes(
        "-SWAP-USDT"
      )
    ) {
      symbol =
        `${symbol}-SWAP-USDT`;
    }

    await sendTelegram(
      token,
      chatId,
      `🔎 در حال تحلیل ${symbol}...`
    );

    try {
      const btcContext =
        await getBTCContext();

      const result =
        await analyzeSymbol(
          symbol,
          btcContext
        );

      await savePaperTrade(
        env,
        result
      );

      await sendTelegram(
        token,
        chatId,
        makeScanReport(
          [result]
        )
      );

    } catch (error) {
      log(
        `SIGNAL ERROR ${symbol}`,
        error.message
      );

      await sendTelegram(
        token,
        chatId,
        `
❌ تحلیل ${symbol} انجام نشد.

🛠️ خطا:
${String(
  error.message ||
    "خطای نامشخص"
).slice(
  0,
  400
)}
`
      );
    }

    return;
  }
}

// --------------------------------------------------
// Worker
// --------------------------------------------------

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    // GET
    if (
      request.method ===
      "GET"
    ) {
      return new Response(
        "Algo Esmail V5 is running!"
      );
    }

    // فقط POST
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

    try {

      const update =
        await request.json();

      // پردازش پیام در پس‌زمینه
      ctx.waitUntil(
        handleUpdate(
          update,
          env,
          ctx
        ).catch(error => {

          console.error(
            "[ALGO ESMAIL] UPDATE ERROR:",
            error.stack ||
              error.message
          );

        })
      );

      // پاسخ فوری به Telegram
      return new Response(
        "OK",
        {
          status: 200
        }
      );

    } catch (error) {

      console.error(
        "[ALGO ESMAIL] WORKER ERROR:",
        error.stack ||
          error.message
      );

      return new Response(
        "Internal Server Error",
        {
          status: 500
        }
      );
    }
  },

  // ------------------------------------------------
  // اجرای خودکار ساعتی
  // ------------------------------------------------

  async scheduled(
    event,
    env,
    ctx
  ) {

    log(
      "========== شروع اجرای ساعتی =========="
    );

    try {

      // بررسی معاملات قبلی
      try {
        await updatePaperTrades(
          env
        );
      } catch (error) {
        log(
          "خطا در بررسی معاملات قبلی",
          error.message
        );
      }

      const chats =
        await getSubscribedChats(
          env
        );

      if (
        !chats.length
      ) {
        log(
          "کاربر مشترکی وجود ندارد"
        );

        return;
      }

      // اسکن
      const results =
        await scanMarket();

      // ذخیره Paper Trade
      for (
        const result of results
      ) {
        try {
          await savePaperTrade(
            env,
            result
          );
        } catch (error) {
          log(
            `خطای ذخیره ${result.symbol}`,
            error.message
          );
        }
      }

      // گزارش
      const report =
        makeHourlyReport(
          results
        );

      // ارسال به کاربران
      for (
        const chatId of chats
      ) {
        try {

          await sendTelegram(
            env.BOT_TOKEN,
            chatId,
            report
          );

        } catch (error) {

          log(
            `خطا در ارسال گزارش به ${chatId}`,
            error.message
          );

        }
      }

      log(
        "========== اجرای ساعتی تمام شد =========="
      );

    } catch (error) {

      log(
        "SCHEDULE ERROR",
        error.stack ||
          error.message
      );
    }
  }
};
