const BASE_URL = "https://api.toobit.com";

// ======================================================
// ALGO ESMAIL V2
// Multi Coin / Multi Timeframe / Futures Scanner
// ======================================================

const SYMBOLS = [
  "BTC-SWAP-USDT",
  "ETH-SWAP-USDT",
  "SOL-SWAP-USDT",
  "XRP-SWAP-USDT",
  "BNB-SWAP-USDT",
  "DOGE-SWAP-USDT",
  "ADA-SWAP-USDT",
  "AVAX-SWAP-USDT",
  "LINK-SWAP-USDT",
  "SUI-SWAP-USDT"
];

const TIMEFRAMES = {
  M15: "15m",
  H1: "1h",
  H4: "4h",
  D1: "1d"
};

// ======================================================
// HTTP
// ======================================================

async function apiGet(path, params = {}) {
  const url = new URL(BASE_URL + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString());

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Toobit ${response.status}: ${text.slice(0, 300)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON from Toobit");
  }
}

// ======================================================
// KLINES
// ======================================================

async function getKlines(symbol, interval, limit = 220) {
  const data = await apiGet("/quote/v1/klines", {
    symbol,
    interval,
    limit
  });

  if (!Array.isArray(data)) {
    throw new Error(`Invalid klines for ${symbol} ${interval}`);
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

// ======================================================
// FUTURES MARKET DATA
// ======================================================

async function getTicker(symbol) {
  const data = await apiGet(
    "/quote/v1/contract/ticker/24hr",
    { symbol }
  );

  const item = Array.isArray(data)
    ? data[0]
    : data;

  return {
    price: Number(item?.c ?? 0),
    change24h: Number(item?.pcp ?? 0),
    volume: Number(item?.v ?? 0),
    quoteVolume: Number(item?.qv ?? 0)
  };
}

async function getOpenInterest(symbol) {
  try {
    const data = await apiGet(
      "/quote/v1/openInterest",
      { symbol }
    );

    const item =
      data?.openInterestList?.[0] ||
      data?.[0] ||
      data;

    return Number(
      item?.size ??
      item?.openInterest ??
      0
    );
  } catch {
    return 0;
  }
}

async function getFunding(symbol) {
  try {
    const data = await apiGet(
      "/api/v1/futures/fundingRate",
      { symbol }
    );

    const item = Array.isArray(data)
      ? data[0]
      : data;

    return Number(
      item?.rate ??
      item?.fundingRate ??
      0
    );
  } catch {
    return 0;
  }
}

async function getLongShort(symbol) {
  try {
    const data = await apiGet(
      "/quote/v1/globalLongShortAccountRatio",
      { symbol }
    );

    const item = Array.isArray(data)
      ? data[0]
      : data;

    return Number(
      item?.longShortRatio ??
      1
    );
  } catch {
    return 1;
  }
}

// ======================================================
// INDICATORS
// ======================================================

function ema(values, period) {
  if (!values.length) return 0;

  const multiplier = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      (values[i] - result) *
      multiplier +
      result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] -
      values[i - 1];

    if (change > 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const currentGain =
      Math.max(change, 0);

    const currentLoss =
      Math.max(-change, 0);

    avgGain =
      (avgGain * (period - 1) +
        currentGain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) +
        currentLoss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trs.push(tr);
  }

  const recent =
    trs.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) / recent.length
  );
}

function averageVolume(
  candles,
  count = 20
) {
  const recent =
    candles.slice(-count);

  if (!recent.length) {
    return 0;
  }

  return (
    recent.reduce(
      (sum, c) =>
        sum + c.volume,
      0
    ) / recent.length
  );
}

// ======================================================
// STRUCTURE
// ======================================================

function getTrend(candles) {
  const closes =
    candles.map(c => c.close);

  const ema50 =
    ema(closes.slice(-200), 50);

  const ema200 =
    ema(closes, 200);

  const price =
    closes[closes.length - 1];

  if (
    price > ema50 &&
    ema50 > ema200
  ) {
    return {
      trend: "BULLISH",
      ema50,
      ema200
    };
  }

  if (
    price < ema50 &&
    ema50 < ema200
  ) {
    return {
      trend: "BEARISH",
      ema50,
      ema200
    };
  }

  return {
    trend: "NEUTRAL",
    ema50,
    ema200
  };
}

function detectBreakout(candles) {
  if (candles.length < 25) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const previous =
    candles.slice(-21, -1);

  const current =
    candles[candles.length - 1];

  const high =
    Math.max(
      ...previous.map(c => c.high)
    );

  const low =
    Math.min(
      ...previous.map(c => c.low)
    );

  return {
    bullish:
      current.close > high,

    bearish:
      current.close < low
  };
}

function detectRetest(candles) {
  if (candles.length < 25) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const resistance =
    Math.max(
      ...candles
        .slice(-22, -2)
        .map(c => c.high)
    );

  const support =
    Math.min(
      ...candles
        .slice(-22, -2)
        .map(c => c.low)
    );

  const bullish =
    previous.close > resistance &&
    current.low <= resistance &&
    current.close > resistance;

  const bearish =
    previous.close < support &&
    current.high >= support &&
    current.close < support;

  return {
    bullish,
    bearish
  };
}

function detectFVG(candles) {
  if (candles.length < 3) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const a =
    candles[candles.length - 3];

  const c =
    candles[candles.length - 1];

  return {
    bullish:
      c.low > a.high,

    bearish:
      c.high < a.low
  };
}

// ======================================================
// VOLUME
// ======================================================

function volumeAnalysis(candles) {
  if (candles.length < 22) {
    return {
      strong: false,
      bullish: false,
      bearish: false,
      ratio: 1
    };
  }

  const current =
    candles[candles.length - 1];

  const avg =
    averageVolume(
      candles.slice(0, -1),
      20
    );

  const ratio =
    avg > 0
      ? current.volume / avg
      : 1;

  return {
    strong: ratio >= 1.2,

    bullish:
      ratio >= 1.2 &&
      current.close > current.open,

    bearish:
      ratio >= 1.2 &&
      current.close < current.open,

    ratio
  };
}

// ======================================================
// TIMEFRAME ANALYSIS
// ======================================================

function analyzeTimeframe(candles) {
  const closes =
    candles.map(c => c.close);

  const trend =
    getTrend(candles);

  const current =
    candles[candles.length - 1];

  const rsiValue =
    rsi(closes);

  const breakout =
    detectBreakout(candles);

  const retest =
    detectRetest(candles);

  const fvg =
    detectFVG(candles);

  const volume =
    volumeAnalysis(candles);

  return {
    price: current.close,
    trend: trend.trend,
    ema50: trend.ema50,
    ema200: trend.ema200,
    rsi: rsiValue,
    breakout,
    retest,
    fvg,
    volume
  };
}

// ======================================================
// SCORE
// ======================================================

function scoreSignal(data) {
  let longScore = 0;
  let shortScore = 0;

  const reasonsLong = [];
  const reasonsShort = [];

  // Daily trend: 15
  if (data.D1.trend === "BULLISH") {
    longScore += 15;
    reasonsLong.push("Daily bullish");
  }

  if (data.D1.trend === "BEARISH") {
    shortScore += 15;
    reasonsShort.push("Daily bearish");
  }

  // 4H trend: 20
  if (data.H4.trend === "BULLISH") {
    longScore += 20;
    reasonsLong.push("4H bullish");
  }

  if (data.H4.trend === "BEARISH") {
    shortScore += 20;
    reasonsShort.push("4H bearish");
  }

  // 1H trend: 15
  if (data.H1.trend === "BULLISH") {
    longScore += 15;
    reasonsLong.push("1H bullish");
  }

  if (data.H1.trend === "BEARISH") {
    shortScore += 15;
    reasonsShort.push("1H bearish");
  }

  // RSI: 10
  if (
    data.H1.rsi > 52 &&
    data.H1.rsi < 68
  ) {
    longScore += 10;
    reasonsLong.push("RSI bullish");
  }

  if (
    data.H1.rsi < 48 &&
    data.H1.rsi > 32
  ) {
    shortScore += 10;
    reasonsShort.push("RSI bearish");
  }

  // 15m momentum: 10
  if (data.M15.trend === "BULLISH") {
    longScore += 10;
    reasonsLong.push("15m bullish");
  }

  if (data.M15.trend === "BEARISH") {
    shortScore += 10;
    reasonsShort.push("15m bearish");
  }

  // Breakout: 10
  if (data.M15.breakout.bullish) {
    longScore += 10;
    reasonsLong.push("15m breakout");
  }

  if (data.M15.breakout.bearish) {
    shortScore += 10;
    reasonsShort.push("15m breakdown");
  }

  // Retest: 10
  if (data.M15.retest.bullish) {
    longScore += 10;
    reasonsLong.push("15m retest");
  }

  if (data.M15.retest.bearish) {
    shortScore += 10;
    reasonsShort.push("15m retest");
  }

  // FVG: 5
  if (data.H1.fvg.bullish) {
    longScore += 5;
    reasonsLong.push("1H bullish FVG");
  }

  if (data.H1.fvg.bearish) {
    shortScore += 5;
    reasonsShort.push("1H bearish FVG");
  }

  // Directional volume: 5
  if (data.M15.volume.bullish) {
    longScore += 5;
    reasonsLong.push(
      `Volume x${data.M15.volume.ratio.toFixed(1)}`
    );
  }

  if (data.M15.volume.bearish) {
    shortScore += 5;
    reasonsShort.push(
      `Volume x${data.M15.volume.ratio.toFixed(1)}`
    );
  }

  // Futures data: up to 10
  if (data.openInterest > 0) {

    if (
      data.H1.trend === "BULLISH" &&
      data.longShortRatio > 1.05
    ) {
      longScore += 5;
      reasonsLong.push("Long/Short bullish");
    }

    if (
      data.H1.trend === "BEARISH" &&
      data.longShortRatio < 0.95
    ) {
      shortScore += 5;
      reasonsShort.push("Long/Short bearish");
    }

    // Funding is used as a sentiment filter,
    // not as a blind directional signal.
    if (
      data.funding > -0.0005 &&
      data.funding < 0.0008
    ) {
      if (longScore > shortScore) {
        longScore += 5;
        reasonsLong.push("Funding healthy");
      }

      if (shortScore > longScore) {
        shortScore += 5;
        reasonsShort.push("Funding healthy");
      }
    }
  }

  longScore =
    Math.min(longScore, 100);

  shortScore =
    Math.min(shortScore, 100);

  let signal = "NO SIGNAL";

  if (
    longScore >= 70 &&
    longScore >= shortScore + 10 &&
    data.H4.trend === "BULLISH"
  ) {
    signal = "LONG";
  }

  if (
    shortScore >= 70 &&
    shortScore >= longScore + 10 &&
    data.H4.trend === "BEARISH"
  ) {
    signal = "SHORT";
  }

  return {
    signal,
    longScore,
    shortScore,
    reasonsLong,
    reasonsShort
  };
}

// ======================================================
// COMPLETE SYMBOL ANALYSIS
// ======================================================

async function analyzeSymbol(symbol) {

  const [
    m15,
    h1,
    h4,
    d1,
    ticker,
    openInterest,
    funding,
    longShortRatio
  ] = await Promise.all([
    getKlines(symbol, TIMEFRAMES.M15, 220),
    getKlines(symbol, TIMEFRAMES.H1, 220),
    getKlines(symbol, TIMEFRAMES.H4, 220),
    getKlines(symbol, TIMEFRAMES.D1, 220),
    getTicker(symbol),
    getOpenInterest(symbol),
    getFunding(symbol),
    getLongShort(symbol)
  ]);

  const data = {
    M15: analyzeTimeframe(m15),
    H1: analyzeTimeframe(h1),
    H4: analyzeTimeframe(h4),
    D1: analyzeTimeframe(d1),

    price: ticker.price,
    change24h: ticker.change24h,
    quoteVolume: ticker.quoteVolume,

    openInterest,
    funding,
    longShortRatio
  };

  const score =
    scoreSignal(data);

  const atrValue =
    atr(h1);

  let entry = ticker.price;
  let stop = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (score.signal === "LONG") {

    stop =
      entry - atrValue * 0.8;

    const risk =
      entry - stop;

    tp1 =
      entry + risk;

    tp2 =
      entry + risk * 2;

    tp3 =
      entry + risk * 3;
  }

  if (score.signal === "SHORT") {

    stop =
      entry + atrValue * 0.8;

    const risk =
      stop - entry;

    tp1 =
      entry - risk;

    tp2 =
      entry - risk * 2;

    tp3 =
      entry - risk * 3;
  }

  return {
    symbol,
    ...data,
    ...score,

    entry,
    stop,
    tp1,
    tp2,
    tp3
  };
}

// ======================================================
// FORMAT
// ======================================================

function shortSymbol(symbol) {
  return symbol
    .replace("-SWAP-USDT", "");
}

function price(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "—";
  }

  if (value >= 1000) {
    return value.toLocaleString(
      "en-US",
      { maximumFractionDigits: 2 }
    );
  }

  if (value >= 1) {
    return value.toFixed(3);
  }

  return value.toFixed(6);
}

function percent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signalEmoji(signal) {
  if (signal === "LONG") return "🟢";
  if (signal === "SHORT") return "🔴";
  return "⏳";
}

function makeSignalMessage(result) {

  const emoji =
    signalEmoji(result.signal);

  let text =
`${emoji} *ALGO ESMAIL V2*

*${shortSymbol(result.symbol)}*

*Signal:* ${result.signal}

💰 Price:
${price(result.price)}

📊 Long:
${result.longScore}/100

📊 Short:
${result.shortScore}/100

📈 Daily:
${result.D1.trend}

📈 4H:
${result.H4.trend}

📈 1H:
${result.H1.trend}

⏱ 15M:
${result.M15.trend}

RSI 1H:
${result.H1.rsi.toFixed(1)}

24H:
${percent(result.change24h)}

Funding:
${(result.funding * 100).toFixed(4)}%

Long/Short:
${result.longShortRatio.toFixed(2)}
`;

  if (
    result.signal !== "NO SIGNAL"
  ) {
    text +=
`
━━━━━━━━━━━━━━

🎯 Entry:
${price(result.entry)}

🛑 SL:
${price(result.stop)}

🎯 TP1:
${price(result.tp1)}

🎯 TP2:
${price(result.tp2)}

🎯 TP3:
${price(result.tp3)}

━━━━━━━━━━━━━━

*Reasons:*
${(
  result.signal === "LONG"
    ? result.reasonsLong
    : result.reasonsShort
)
  .map(x => `• ${x}`)
  .join("\n")}
`;
  }

  text +=
`
⚠️ Experimental signal — not financial advice.`;

  return text;
}

// ======================================================
// TELEGRAM
// ======================================================

async function telegram(
  token,
  method,
  body
) {
  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify(body)
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram error: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function sendMessage(
  token,
  chatId,
  text
) {
  return telegram(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    }
  );
}

// ======================================================
// SCANNER
// ======================================================

async function scanMarket() {

  const results = [];

  // Sequential batches prevent hammering API.
  const batchSize = 3;

  for (
    let i = 0;
    i < SYMBOLS.length;
    i += batchSize
  ) {

    const batch =
      SYMBOLS.slice(
        i,
        i + batchSize
      );

    const batchResults =
      await Promise.all(
        batch.map(async symbol => {
          try {
            return await analyzeSymbol(
              symbol
            );
          } catch (error) {
            console.error(
              `SCAN ERROR ${symbol}`,
              error
            );

            return null;
          }
        })
      );

    for (const result of batchResults) {
      if (result) {
        results.push(result);
      }
    }
  }

  return results.sort(
    (a, b) => {

      const scoreA =
        Math.max(
          a.longScore,
          a.shortScore
        );

      const scoreB =
        Math.max(
          b.longScore,
          b.shortScore
        );

      return scoreB - scoreA;
    }
  );
}

// ======================================================
// TOP MESSAGE
// ======================================================

function makeTopMessage(results) {

  const top =
    results.slice(0, 5);

  let text =
`🔥 *ALGO ESMAIL V2*

*TOP MARKET SCAN*

`;

  top.forEach(
    (r, index) => {

      const score =
        Math.max(
          r.longScore,
          r.shortScore
        );

      text +=
`${index + 1}. ${shortSymbol(r.symbol)}

${signalEmoji(r.signal)}
${r.signal} — ${score}/100

4H: ${r.H4.trend}
1H: ${r.H1.trend}
15M: ${r.M15.trend}
RSI: ${r.H1.rsi.toFixed(1)}
24H: ${percent(r.change24h)}

━━━━━━━━━━━━━━
`;
    }
  );

  text +=
`
⚠️ Experimental scanner.`;

  return text;
}

// ======================================================
// TELEGRAM UPDATE
// ======================================================

async function handleUpdate(
  update,
  env
) {
  if (!update.message) {
    return;
  }

  const token =
    env.BOT_TOKEN;

  if (!token) {
    throw new Error(
      "BOT_TOKEN is missing"
    );
  }

  const chatId =
    update.message.chat.id;

  const text =
    update.message.text || "";

  if (text === "/start") {

    await sendMessage(
      token,
      chatId,
`🤖 *ALGO ESMAIL V2*

سلام 👋

نسخه جدید سیستم تحلیل آماده است.

دستورات:

/scan
اسکن چندارزی بازار

/top
نمایش بهترین فرصت‌ها

/signal BTC-SWAP-USDT
تحلیل یک ارز

/help
راهنما

⚠️ معامله خودکار هنوز فعال نیست.`
    );

    return;
  }

  if (text === "/help") {

    await sendMessage(
      token,
      chatId,
`📚 *ALGO ESMAIL V2*

سیستم از:

• Daily Trend
• 4H Trend
• 1H Structure
• 15M Momentum
• EMA
• RSI
• ATR
• Breakout
• Retest
• FVG
• Volume
• Funding
• Open Interest
• Long/Short Ratio

استفاده می‌کند.

دستورها:

/scan
/top
/signal BTC-SWAP-USDT`
    );

    return;
  }

  if (
    text === "/scan" ||
    text === "/top"
  ) {

    await sendMessage(
      token,
      chatId,
      "🔎 در حال اسکن بازار Toobit..."
    );

    try {

      const results =
        await scanMarket();

      await sendMessage(
        token,
        chatId,
        makeTopMessage(results)
      );

    } catch (error) {

      console.error(error);

      await sendMessage(
        token,
        chatId,
        "❌ خطا در اسکن بازار."
      );
    }

    return;
  }

  if (
    text.startsWith("/signal")
  ) {

    let symbol =
      text
        .replace("/signal", "")
        .trim()
        .toUpperCase();

    if (!symbol) {
      symbol =
        "BTC-SWAP-USDT";
    }

    if (
      !symbol.endsWith(
        "-SWAP-USDT"
      )
    ) {
      symbol =
        `${symbol}-SWAP-USDT`;
    }

    await sendMessage(
      token,
      chatId,
      `🔎 در حال تحلیل ${symbol}...`
    );

    try {

      const result =
        await analyzeSymbol(
          symbol
        );

      await sendMessage(
        token,
        chatId,
        makeSignalMessage(result)
      );

    } catch (error) {

      console.error(error);

      await sendMessage(
        token,
        chatId,
        `❌ خطا در تحلیل ${symbol}.\n\nممکن است این قرارداد در Toobit موجود نباشد.`
      );
    }
  }
}

// ======================================================
// WORKER
// ======================================================

export default {

  async fetch(
    request,
    env
  ) {

    if (
      request.method === "GET"
    ) {

      return new Response(
        "Algo Esmail V2 is running!",
        {
          status: 200
        }
      );
    }

    if (
      request.method !== "POST"
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

      await handleUpdate(
        update,
        env
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
        "Internal Server Error",
        {
          status: 500
        }
      );
    }
  }
};
