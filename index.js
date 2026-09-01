const BASE_URL = "https://api.toobit.com";

const TIMEOUT_MS = 7000;

const PAPER_BUDGET = 100;
const RISK_PERCENT = 1;

const TOP_OPPORTUNITIES = 5;
const MAX_ANALYSIS_SYMBOLS = 12;
const ANALYSIS_BATCH = 4;
const MIN_SIGNAL_SCORE = 70;

// --------------------------------------------------
// HTTP
// --------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

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

async function getJson(url, options = {}) {
  const response = await fetchWithTimeout(
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
// Telegram
// --------------------------------------------------

async function sendTelegram(
  token,
  chatId,
  text
) {
  const response =
    await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown"
        })
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      data.description ||
        "Telegram error"
    );
  }

  return data;
}

// --------------------------------------------------
// KLINES
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
      "Invalid candle data"
    );
  }

  return data.map(c => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

// --------------------------------------------------
// MARKET INFO
// --------------------------------------------------

async function getSymbols() {
  const data =
    await getJson(
      `${BASE_URL}/api/v1/exchangeInfo`
    );

  const contracts =
    Array.isArray(data.contracts)
      ? data.contracts
      : [];

  return contracts
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
}

async function getTickers() {
  try {
    const data =
      await getJson(
        `${BASE_URL}/quote/v1/contract/ticker/24hr`
      );

    return Array.isArray(data)
      ? data
      : [];
  } catch {
    return [];
  }
}

async function getBestSymbols() {
  const [
    symbols,
    tickers
  ] = await Promise.all([
    getSymbols(),
    getTickers()
  ]);

  const map =
    new Map();

  for (const t of tickers) {
    if (t.s) {
      map.set(
        t.s,
        Number(t.qv || 0)
      );
    }
  }

  return symbols
    .map(symbol => ({
      symbol,
      volume:
        map.get(symbol) || 0
    }))
    .filter(x =>
      x.volume > 0
    )
    .sort(
      (a, b) =>
        b.volume - a.volume
    )
    .slice(
      0,
      MAX_ANALYSIS_SYMBOLS
    )
    .map(x => x.symbol);
}

// --------------------------------------------------
// INDICATORS
// --------------------------------------------------

function ema(
  values,
  period
) {
  if (!values.length) {
    return 0;
  }

  const multiplier =
    2 / (period + 1);

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
    let i = period + 1;
    i < closes.length;
    i++
  ) {
    const change =
      closes[i] -
      closes[i - 1];

    avgGain =
      (
        avgGain *
          (period - 1) +
        Math.max(
          change,
          0
        )
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        Math.max(
          -change,
          0
        )
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

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

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high -
            p.close
        ),
        Math.abs(
          c.low -
            p.close
        )
      )
    );
  }

  const recent =
    trs.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) /
    recent.length
  );
}

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

  const values = [];

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

    values.push(
      ema(slice, 12) -
      ema(slice, 26)
    );
  }

  const macd =
    values[
      values.length - 1
    ];

  const signal =
    ema(
      values.slice(-9),
      9
    );

  return {
    macd,
    signal,
    histogram:
      macd - signal
  };
}

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
      c.high - p.high;

    const down =
      p.low - c.low;

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
        c.high - c.low,
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

  if (!trSum) {
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
// TREND
// --------------------------------------------------

function getTrend(
  candles
) {
  if (
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
      closes.slice(-80),
      20
    );

  const ema50 =
    ema(
      closes.slice(-120),
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
// VOLUME
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
      (s, c) =>
        s + c.volume,
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
// BREAKOUT
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
      falseBull: false,
      falseBear: false
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

    falseBull:
      current.high > high &&
      current.close < high,

    falseBear:
      current.low < low &&
      current.close > low
  };
}

// --------------------------------------------------
// CANDLE PATTERNS
// --------------------------------------------------

function candlePatterns(
  candles
) {
  if (
    candles.length < 3
  ) {
    return {
      bullish: [],
      bearish: [],
      long: 0,
      short: 0
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
      c.close - c.open
    );

  const range =
    c.high - c.low;

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

  let long = 0;
  let short = 0;

  if (
    range > 0 &&
    body / range < 0.1
  ) {
    bullish.push("دوجی");
    bearish.push("دوجی");
  }

  if (
    range > 0 &&
    lower >= body * 2 &&
    upper <= body
  ) {
    bullish.push("چکش");
    long += 5;
  }

  if (
    range > 0 &&
    upper >= body * 2 &&
    lower <= body
  ) {
    bearish.push(
      "شوتینگ‌استار"
    );
    short += 5;
  }

  if (
    p.close < p.open &&
    c.close > c.open &&
    c.open <= p.close &&
    c.close >= p.open
  ) {
    bullish.push(
      "پوشای صعودی"
    );
    long += 8;
  }

  if (
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    bearish.push(
      "پوشای نزولی"
    );
    short += 8;
  }

  if (
    lower >= body * 2.5 &&
    lower > upper * 1.5
  ) {
    bullish.push(
      "پین‌بار صعودی"
    );
    long += 4;
  }

  if (
    upper >= body * 2.5 &&
    upper > lower * 1.5
  ) {
    bearish.push(
      "پین‌بار نزولی"
    );
    short += 4;
  }

  return {
    bullish,
    bearish,
    long,
    short
  };
}

// --------------------------------------------------
// MARKET STRUCTURE
// --------------------------------------------------

function marketStructure(
  candles
) {
  if (
    candles.length < 12
  ) {
    return {
      direction: "خنثی",
      long: 0,
      short: 0
    };
  }

  const recent =
    candles.slice(-12);

  const first =
    recent.slice(0, 6);

  const second =
    recent.slice(6);

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

  if (
    high2 > high1 &&
    low2 > low1
  ) {
    return {
      direction: "صعودی",
      long: 8,
      short: 0
    };
  }

  if (
    high2 < high1 &&
    low2 < low1
  ) {
    return {
      direction: "نزولی",
      long: 0,
      short: 8
    };
  }

  return {
    direction: "خنثی",
    long: 0,
    short: 0
  };
}

// --------------------------------------------------
// BTC
// --------------------------------------------------

async function getBTCContext() {
  try {
    const candles =
      await getKlines(
        "BTC-SWAP-USDT",
        "1h",
        100
      );

    return {
      trend:
        getTrend(candles),

      rsi:
        calculateRSI(
          candles.map(
            c => c.close
          )
        )
    };
  } catch {
    return {
      trend: "نامشخص",
      rsi: 50
    };
  }
}

// --------------------------------------------------
// EXTRA DATA
// --------------------------------------------------

async function getFundingRate(
  symbol
) {
  try {
    const data =
      await getJson(
        `${BASE_URL}/api/v1/futures/fundingRate?symbol=${encodeURIComponent(symbol)}`
      );

    return Array.isArray(data) &&
      data.length
      ? Number(
          data[0].rate || 0
        )
      : 0;
  } catch {
    return 0;
  }
}

async function getLongShortRatio(
  symbol
) {
  try {
    const data =
      await getJson(
        `${BASE_URL}/quote/v1/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`
      );

    return Array.isArray(data) &&
      data.length
      ? Number(
          data[0]
            .longShortRatio || 1
        )
      : 1;
  } catch {
    return 1;
  }
}

// --------------------------------------------------
// ANALYZE SYMBOL
// --------------------------------------------------

async function analyzeSymbol(
  symbol,
  btc
) {
  const [
    m15Result,
    h1Result,
    h4Result,
    fundingResult,
    ratioResult
  ] =
    await Promise.allSettled([
      getKlines(
        symbol,
        "15m",
        100
      ),

      getKlines(
        symbol,
        "1h",
        200
      ),

      getKlines(
        symbol,
        "4h",
        200
      ),

      getFundingRate(symbol),

      getLongShortRatio(symbol)
    ]);

  if (
    h1Result.status !==
      "fulfilled" ||
    h4Result.status !==
      "fulfilled"
  ) {
    throw new Error(
      "داده کافی نیست"
    );
  }

  const m15 =
    m15Result.status ===
    "fulfilled"
      ? m15Result.value
      : h1Result.value;

  const h1 =
    h1Result.value;

  const h4 =
    h4Result.value;

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
    calculateRSI(closes);

  const macd =
    calculateMACD(closes);

  const atr =
    calculateATR(h1);

  const adx =
    calculateADX(h1);

  const volume =
    volumeAnalysis(h1);

  const breakout =
    breakoutAnalysis(h1);

  const patterns =
    candlePatterns(h1);

  const structure =
    marketStructure(h1);

  const funding =
    fundingResult.status ===
    "fulfilled"
      ? fundingResult.value
      : 0;

  const ratio =
    ratioResult.status ===
    "fulfilled"
      ? ratioResult.value
      : 1;

  let longScore = 0;
  let shortScore = 0;

  // 4H
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

  // 1H
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

  // 15M
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

  // RSI
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

  // MACD
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

  // ADX
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

  // Volume
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

  // Breakout
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

  // False breakout
  if (
    breakout.falseBull
  ) {
    shortScore += 5;
  }

  if (
    breakout.falseBear
  ) {
    longScore += 5;
  }

  // Structure
  longScore +=
    structure.long;

  shortScore +=
    structure.short;

  // Candles
  longScore +=
    patterns.long;

  shortScore +=
    patterns.short;

  // BTC
  if (
    symbol !==
    "BTC-SWAP-USDT"
  ) {
    if (
      btc.trend.includes(
        "صعودی"
      )
    ) {
      longScore += 3;
      shortScore -= 3;
    }

    if (
      btc.trend.includes(
        "نزولی"
      )
    ) {
      shortScore += 3;
      longScore -= 5;
    }
  }

  // Funding
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

  // Long / Short
  if (
    ratio > 1.6
  ) {
    shortScore += 3;
  }

  if (
    ratio < 0.65
  ) {
    longScore += 3;
  }

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
  // TRADE MANAGEMENT
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
      price - stop;

    tp1 =
      price +
      riskPerUnit * 1.2;

    tp2 =
      price +
      riskPerUnit * 2;

    tp3 =
      price +
      riskPerUnit * 3;
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
      stop - price;

    tp1 =
      price -
      riskPerUnit * 1.2;

    tp2 =
      price -
      riskPerUnit * 2;

    tp3 =
      price -
      riskPerUnit * 3;
  }

  const maxLoss =
    PAPER_BUDGET *
    (
      RISK_PERCENT /
      100
    );

  const positionSize =
    riskPerUnit > 0
      ? maxLoss /
        riskPerUnit
      : 0;

  let leverage = 1;

  if (
    signal !==
    "بدون سیگنال" &&
    price > 0
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

  return {
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

    atr,

    candleBullish:
      patterns.bullish,

    candleBearish:
      patterns.bearish,

    marketStructure:
      structure.direction,

    breakoutBullish:
      breakout.bullish,

    breakoutBearish:
      breakout.bearish,

    falseBreakoutBull:
      breakout.falseBull,

    falseBreakoutBear:
      breakout.falseBear,

    fundingRate:
      funding,

    longShortRatio:
      ratio,

    btcTrend:
      btc.trend,

    btcRSI:
      btc.rsi,

    stop,
    tp1,
    tp2,
    tp3,

    positionSize,
    leverage
  };
}

// --------------------------------------------------
// SCAN
// --------------------------------------------------

async function scanMarket() {
  const symbols =
    await getBestSymbols();

  if (!symbols.length) {
    throw new Error(
      "هیچ نماد فعالی پیدا نشد"
    );
  }

  const btc =
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
        i + ANALYSIS_BATCH
      );

    const batchResults =
      await Promise.all(
        batch.map(
          async symbol => {
            try {
              return await analyzeSymbol(
                symbol,
                btc
              );
            } catch (error) {
              console.error(
                `ANALYZE ${symbol}`,
                error
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
  }

  return results.sort(
    (a, b) =>
      b.bestScore -
      a.bestScore
  );
}

// --------------------------------------------------
// FORMAT
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

  return value.toFixed(7);
}

function formatPercent(
  value
) {
  return (
    Number(value * 100)
      .toFixed(3) +
    "%"
  );
}

// --------------------------------------------------
// KV
// --------------------------------------------------

function getKV(env) {
  if (!env.ALGO_ESMAIL_KV) {
    throw new Error(
      "KV متصل نیست"
    );
  }

  return env.ALGO_ESMAIL_KV;
}

async function saveChat(
  env,
  chatId
) {
  await getKV(env).put(
    `chat:${chatId}`,
    "active"
  );
}

async function removeChat(
  env,
  chatId
) {
  await getKV(env).delete(
    `chat:${chatId}`
  );
}

async function getSubscribedChats(
  env
) {
  const list =
    await getKV(env).list({
      prefix: "chat:"
    });

  return list.keys.map(
    x =>
      x.name.replace(
        "chat:",
        ""
      )
  );
}

// --------------------------------------------------
// PAPER TRADE
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

    if (!raw) continue;

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
      0
  };

  await getKV(env).put(
    `trade:${id}`,
    JSON.stringify(
      trade
    )
  );

  return trade;
}

// --------------------------------------------------
// UPDATE PAPER TRADES
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

  for (
    const key of list.keys
  ) {
    const raw =
      await kv.get(
        key.name
      );

    if (!raw) continue;

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
          2
        );

      if (!candles.length) {
        continue;
      }

      const c =
        candles[
          candles.length - 1
        ];

      let result = null;

      if (
        trade.direction ===
        "فرصت خرید"
      ) {
        if (
          c.low <=
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
          c.high >=
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
          c.high >=
          trade.tp2
        ) {
          trade.target2Hit =
            true;
        } else if (
          c.high >=
          trade.tp1
        ) {
          trade.target1Hit =
            true;
        }
      } else {
        if (
          c.high >=
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
          c.low <=
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
          c.low <=
          trade.tp2
        ) {
          trade.target2Hit =
            true;
        } else if (
          c.low <=
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
          ) * 100;
      }

      await kv.put(
        key.name,
        JSON.stringify(
          trade
        )
      );
    } catch (error) {
      console.error(
        "TRADE UPDATE",
        error
      );
    }
  }
}

// --------------------------------------------------
// STATS
// --------------------------------------------------

async function getStats(
  env
) {
  const list =
    await getKV(env).list({
      prefix: "trade:"
    });

  const trades = [];

  for (
    const key of list.keys
  ) {
    const raw =
      await getKV(env).get(
        key.name
      );

    if (!raw) continue;

    try {
      trades.push(
        JSON.parse(raw)
      );
    } catch {}
  }

  const closed =
    trades.filter(
      t =>
        t.status === "win" ||
        t.status === "loss"
    );

  const wins =
    closed.filter(
      t =>
        t.status === "win"
    );

  const pnl =
    closed.reduce(
      (s, t) =>
        s + Number(
          t.pnl || 0
        ),
      0
    );

  return {
    total:
      trades.length,

    open:
      trades.filter(
        t =>
          t.status === "open"
      ).length,

    closed:
      closed.length,

    wins:
      wins.length,

    losses:
      closed.length -
      wins.length,

    winRate:
      closed.length
        ? (
            wins.length /
            closed.length
          ) * 100
        : 0,

    pnl
  };
}

// --------------------------------------------------
// SCAN REPORT
// --------------------------------------------------

function makeScanReport(
  results
) {
  if (!results.length) {
    return `
❌ *اسکن انجام شد اما داده کافی برای تحلیل پیدا نشد.*

ممکن است API توبیت موقتاً پاسخ مناسب نداده باشد.
`;
  }

  let message = `
🔎 *تحلیل بازار توبیت*

📊 ارزهای بررسی‌شده:
${results.length}

━━━━━━━━━━━━━━
`;

  results
    .slice(
      0,
      TOP_OPPORTUNITIES
    )
    .forEach(
      (r, i) => {
        const signal =
          r.signal ===
          "فرصت خرید"
            ? "🟢 فرصت خرید"
            : r.signal ===
              "فرصت فروش"
            ? "🔴 فرصت فروش"
            : "⏳ بدون سیگنال";

        message += `
*${i + 1}. ${r.symbol}*

${signal}

⭐ امتیاز:
${r.bestScore}/100

🟢 خرید:
${r.longScore}

🔴 فروش:
${r.shortScore}

📈 روند 4H:
${r.trend4}

📈 روند 1H:
${r.trend1}

⏱ روند 15M:
${r.trend15}

💪 ADX:
${r.adx.toFixed(1)}

📊 RSI:
${r.rsi.toFixed(1)}

📊 حجم:
${r.volumeRatio.toFixed(2)}x

🕯️ کندل صعودی:
${
  r.candleBullish.join(
    "، "
  ) || "—"
}

🕯️ کندل نزولی:
${
  r.candleBearish.join(
    "، "
  ) || "—"
}

📐 ساختار:
${r.marketStructure}

💸 Funding:
${formatPercent(
  r.fundingRate
)}

👥 Long/Short:
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
🎯 ورود:
${formatPrice(
  r.price
)}

🛑 حد ضرر:
${formatPrice(
  r.stop
)}

🎯 TP1:
${formatPrice(
  r.tp1
)}

🎯 TP2:
${formatPrice(
  r.tp2
)}

🎯 TP3:
${formatPrice(
  r.tp3
)}

⚙️ لوریج آزمایشی:
${r.leverage}x
`;
        }

        message +=
          "\n━━━━━━━━━━━━━━\n";
      }
    );

  message +=
    "\n🧪 معاملات کاملاً آزمایشی هستند.";

  return message;
}

// --------------------------------------------------
// HOURLY REPORT
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

  if (!strong.length) {
    return `
⏰ *گزارش ساعتی*

در حال حاضر سیگنال قدرتمندی پیدا نشد.

🔎 بازار همچنان تحت نظر است.
`;
  }

  let message = `
🚨 *گزارش ساعتی Algo Esmail*

`;

  strong.forEach(
    (r, i) => {
      message += `
${i + 1}. *${r.symbol}*

${
  r.signal ===
  "فرصت خرید"
    ? "🟢 فرصت خرید"
    : "🔴 فرصت فروش"
}

⭐ امتیاز:
${r.bestScore}/100

💰 قیمت:
${formatPrice(
  r.price
)}

🛑 حد ضرر:
${formatPrice(
  r.stop
)}

🎯 TP1:
${formatPrice(
  r.tp1
)}

🎯 TP2:
${formatPrice(
  r.tp2
)}

⚙️ ${r.leverage}x

━━━━━━━━━━━━━━
`;
    }
  );

  return (
    message +
    "\n🧪 معاملات آزمایشی هستند."
  );
}

// --------------------------------------------------
// BACKGROUND SCAN
// --------------------------------------------------

async function runBackgroundScan(
  env,
  token,
  chatId
) {
  try {
    await updatePaperTrades(
      env
    );

    const results =
      await scanMarket();

    for (
      const result of results
    ) {
      try {
        await savePaperTrade(
          env,
          result
        );
      } catch (error) {
        console.error(
          "SAVE TRADE",
          error
        );
      }
    }

    await sendTelegram(
      token,
      chatId,
      makeScanReport(
        results
      )
    );
  } catch (error) {
    console.error(
      "BACKGROUND SCAN ERROR:",
      error
    );

    try {
      await sendTelegram(
        token,
        chatId,
        `
❌ *اسکن بازار با خطا مواجه شد.*

جزئیات خطا در Cloudflare Worker ثبت شده است.
`
      );
    } catch {}
  }
}

// --------------------------------------------------
// HANDLE UPDATE
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
    (
      update.message.text ||
      ""
    ).trim();

  // START
  if (
    text ===
    "/start"
  ) {
    await sendTelegram(
      token,
      chatId,
      `
🤖 *Algo Esmail V4*

ربات فعال است 🚀

/scan
🔎 اسکن بازار

/signal BTC
📊 تحلیل یک ارز

/subscribe
⏰ گزارش ساعتی

/unsubscribe
❌ لغو گزارش

/stats
📊 آمار Paper Trading

/help
📚 راهنما

🧪 معاملات واقعی غیرفعال هستند.
`
    );

    return;
  }

  // HELP
  if (
    text ===
    "/help"
  ) {
    await sendTelegram(
      token,
      chatId,
      `
📚 *راهنمای Algo Esmail*

/scan
اسکن بازار

/signal BTC
تحلیل بیت‌کوین یا هر ارز

/subscribe
گزارش خودکار ساعتی

/unsubscribe
لغو گزارش

/stats
آمار معاملات آزمایشی

🧪 معاملات واقعی غیرفعال هستند.
`
    );

    return;
  }

  // SUBSCRIBE
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
✅ *گزارش ساعتی فعال شد.*

ربات هر ساعت بازار را بررسی می‌کند.

🧪 معاملات آزمایشی هستند.
`
    );

    return;
  }

  // UNSUBSCRIBE
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
      "✅ گزارش ساعتی غیرفعال شد."
    );

    return;
  }

  // STATS
  if (
    text ===
    "/stats"
  ) {
    try {
      await updatePaperTrades(
        env
      );

      const s =
        await getStats(
          env
        );

      await sendTelegram(
        token,
        chatId,
        `
📊 *عملکرد Algo Esmail*

📁 کل معاملات:
${s.total}

🟡 باز:
${s.open}

📕 بسته:
${s.closed}

🟢 موفق:
${s.wins}

🔴 ناموفق:
${s.losses}

🎯 نرخ موفقیت:
${s.winRate.toFixed(1)}٪

💰 سود/ضرر فرضی:
${s.pnl.toFixed(2)} USDT

🧪 Paper Trading
`
      );
    } catch (error) {
      console.error(
        "STATS ERROR",
        error
      );

      await sendTelegram(
        token,
        chatId,
        "❌ دریافت آمار ناموفق بود."
      );
    }

    return;
  }

  // SCAN
  if (
    text ===
    "/scan"
  ) {
    /*
     * مهم:
     * اسکن دیگر داخل request اصلی اجرا نمی‌شود.
     * ابتدا پاسخ سریع داده می‌شود،
     * سپس اسکن با waitUntil در پس‌زمینه انجام می‌شود.
     */

    await sendTelegram(
      token,
      chatId,
      `
🔎 *در حال بررسی بازار توبیت...*

⏳ لطفاً چند لحظه صبر کنید.
نتیجه پس از پایان اسکن ارسال می‌شود.
`
    );

    ctx.waitUntil(
      runBackgroundScan(
        env,
        token,
        chatId
      )
    );

    return;
  }

  // SIGNAL
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

    ctx.waitUntil(
      (async () => {
        try {
          const btc =
            await getBTCContext();

          const result =
            await analyzeSymbol(
              symbol,
              btc
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
          console.error(
            "SIGNAL ERROR",
            error
          );

          try {
            await sendTelegram(
              token,
              chatId,
              `
❌ تحلیل ${symbol} انجام نشد.
`
            );
          } catch {}
        }
      })()
    );

    return;
  }
}

// --------------------------------------------------
// SCHEDULED
// --------------------------------------------------

async function scheduledJob(
  env
) {
  try {
    await updatePaperTrades(
      env
    );

    const chats =
      await getSubscribedChats(
        env
      );

    if (!chats.length) {
      console.log(
        "No subscribed users"
      );

      return;
    }

    const results =
      await scanMarket();

    for (
      const result of results
    ) {
      try {
        await savePaperTrade(
          env,
          result
        );
      } catch {}
    }

    const report =
      makeHourlyReport(
        results
      );

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
        console.error(
          "SEND HOURLY",
          error
        );
      }
    }
  } catch (error) {
    console.error(
      "SCHEDULE ERROR",
      error
    );
  }
}

// --------------------------------------------------
// WORKER
// --------------------------------------------------

export default {

  async fetch(
    request,
    env,
    ctx
  ) {
    if (
      request.method ===
      "GET"
    ) {
      return new Response(
        "Algo Esmail V4 is running!"
      );
    }

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

      /*
       * نکته بسیار مهم:
       *
       * handleUpdate را await نمی‌کنیم.
       * Worker باید سریع پاسخ 200 بدهد.
       *
       * اسکن‌های سنگین با waitUntil
       * در پس‌زمینه ادامه پیدا می‌کنند.
       */

      ctx.waitUntil(
        handleUpdate(
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
        "WORKER ERROR",
        error
      );

      return new Response(
        "OK",
        {
          status: 200
        }
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scheduledJob(env)
    );
  }
};
