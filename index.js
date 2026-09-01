const BASE_URL = "https://api.toobit.com";

const SYMBOLS = [
  "BTC-SWAP-USDT",
  "ETH-SWAP-USDT",
  "SOL-SWAP-USDT",
  "XRP-SWAP-USDT",
  "BNB-SWAP-USDT"
];

const TIMEFRAMES = ["15m", "1h", "4h"];

const TIMEOUT_MS = 8000;

// =========================
// FETCH WITH TIMEOUT
// =========================

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    return response;
  } finally {
    clearTimeout(timer);
  }
}

// =========================
// TOOBIT API
// =========================

async function getKlines(symbol, interval, limit = 100) {
  const url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}` +
    `&limit=${limit}`;

  const response =
    await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(
      `Toobit ${response.status}`
    );
  }

  const data =
    await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Invalid klines");
  }

  return data.map(c => ({
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

// =========================
// INDICATORS
// =========================

function ema(values, period) {
  if (!values.length) return 0;

  const multiplier =
    2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      (values[i] - result) *
        multiplier +
      result;
  }

  return result;
}

function calculateRSI(
  closes,
  period = 14
) {
  if (closes.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      closes[i] -
      closes[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {
    const change =
      closes[i] -
      closes[i - 1];

    const gain =
      Math.max(change, 0);

    const loss =
      Math.max(-change, 0);

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
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function calculateATR(
  candles,
  period = 14
) {
  if (candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
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

// =========================
// TREND
// =========================

function analyzeTrend(candles) {
  const closes =
    candles.map(
      c => c.close
    );

  const price =
    closes[closes.length - 1];

  const ema50 =
    ema(
      closes.slice(-100),
      50
    );

  const ema200 =
    ema(
      closes,
      200
    );

  if (
    price > ema50 &&
    ema50 > ema200
  ) {
    return "BULLISH";
  }

  if (
    price < ema50 &&
    ema50 < ema200
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// =========================
// BREAKOUT
// =========================

function breakout(candles) {
  if (candles.length < 21) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(-21, -1);

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
      current.close > high,

    bearish:
      current.close < low
  };
}

// =========================
// VOLUME
// =========================

function volumeStrength(candles) {
  if (candles.length < 21) {
    return {
      ratio: 1,
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(-21, -1);

  const average =
    previous.reduce(
      (sum, c) =>
        sum + c.volume,
      0
    ) / previous.length;

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

// =========================
// ANALYZE SYMBOL
// =========================

async function analyzeSymbol(
  symbol
) {
  const results = {};

  // فقط 3 درخواست همزمان برای هر ارز
  const responses =
    await Promise.allSettled(
      TIMEFRAMES.map(
        timeframe =>
          getKlines(
            symbol,
            timeframe
          )
      )
    );

  for (
    let i = 0;
    i < TIMEFRAMES.length;
    i++
  ) {
    const result =
      responses[i];

    if (
      result.status ===
      "fulfilled"
    ) {
      results[
        TIMEFRAMES[i]
      ] = result.value;
    }
  }

  if (
    !results["1h"] ||
    !results["4h"]
  ) {
    throw new Error(
      "Missing market data"
    );
  }

  const h1 =
    results["1h"];

  const h4 =
    results["4h"];

  const m15 =
    results["15m"] ||
    h1;

  const price =
    h1[h1.length - 1]
      .close;

  const trend4H =
    analyzeTrend(h4);

  const trend1H =
    analyzeTrend(h1);

  const trend15M =
    analyzeTrend(m15);

  const rsi =
    calculateRSI(
      h1.map(c => c.close)
    );

  const atr =
    calculateATR(h1);

  const br =
    breakout(m15);

  const volume =
    volumeStrength(m15);

  let longScore = 0;
  let shortScore = 0;

  if (
    trend4H === "BULLISH"
  ) {
    longScore += 30;
  }

  if (
    trend4H === "BEARISH"
  ) {
    shortScore += 30;
  }

  if (
    trend1H === "BULLISH"
  ) {
    longScore += 20;
  }

  if (
    trend1H === "BEARISH"
  ) {
    shortScore += 20;
  }

  if (
    trend15M === "BULLISH"
  ) {
    longScore += 10;
  }

  if (
    trend15M === "BEARISH"
  ) {
    shortScore += 10;
  }

  if (
    rsi > 52 &&
    rsi < 70
  ) {
    longScore += 15;
  }

  if (
    rsi < 48 &&
    rsi > 30
  ) {
    shortScore += 15;
  }

  if (br.bullish) {
    longScore += 15;
  }

  if (br.bearish) {
    shortScore += 15;
  }

  if (volume.bullish) {
    longScore += 10;
  }

  if (volume.bearish) {
    shortScore += 10;
  }

  let signal =
    "NO SIGNAL";

  if (
    longScore >= 70 &&
    longScore >
      shortScore + 10 &&
    trend4H === "BULLISH"
  ) {
    signal = "LONG";
  }

  if (
    shortScore >= 70 &&
    shortScore >
      longScore + 10 &&
    trend4H === "BEARISH"
  ) {
    signal = "SHORT";
  }

  let stop = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (
    signal === "LONG" &&
    atr > 0
  ) {
    stop =
      price -
      atr * 0.8;

    const risk =
      price - stop;

    tp1 =
      price + risk;

    tp2 =
      price + risk * 2;

    tp3 =
      price + risk * 3;
  }

  if (
    signal === "SHORT" &&
    atr > 0
  ) {
    stop =
      price +
      atr * 0.8;

    const risk =
      stop - price;

    tp1 =
      price - risk;

    tp2 =
      price - risk * 2;

    tp3 =
      price - risk * 3;
  }

  return {
    symbol,
    price,
    signal,

    longScore,
    shortScore,

    trend4H,
    trend1H,
    trend15M,

    rsi,
    atr,

    volumeRatio:
      volume.ratio,

    stop,
    tp1,
    tp2,
    tp3
  };
}

// =========================
// FORMAT
// =========================

function formatPrice(
  value
) {
  if (
    value === null ||
    value === undefined
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
    return value.toFixed(3);
  }

  return value.toFixed(6);
}

function makeSignalMessage(
  result
) {
  const emoji =
    result.signal === "LONG"
      ? "🟢"
      : result.signal === "SHORT"
      ? "🔴"
      : "⏳";

  return `
${emoji} *ALGO ESMAIL V2*

*${result.symbol}*

Signal:
*${result.signal}*

💰 Price:
${formatPrice(result.price)}

📊 Long:
${result.longScore}/100

📊 Short:
${result.shortScore}/100

📈 4H:
${result.trend4H}

📈 1H:
${result.trend1H}

⏱ 15M:
${result.trend15M}

RSI:
${result.rsi.toFixed(1)}

Volume:
x${result.volumeRatio.toFixed(2)}

${
  result.signal !== "NO SIGNAL"
    ? `
━━━━━━━━━━━━━━

🎯 Entry:
${formatPrice(result.price)}

🛑 Stop:
${formatPrice(result.stop)}

🎯 TP1:
${formatPrice(result.tp1)}

🎯 TP2:
${formatPrice(result.tp2)}

🎯 TP3:
${formatPrice(result.tp3)}
`
    : ""
}
⚠️ Experimental signal.
`;
}

// =========================
// SCAN
// =========================

async function scanMarket() {
  const results = [];

  // فقط دو ارز همزمان
  // تا Worker تحت فشار نرود
  const batchSize = 2;

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
        batch.map(
          async symbol => {
            try {
              return await analyzeSymbol(
                symbol
              );
            } catch (error) {
              console.error(
                `ERROR ${symbol}`,
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
      Math.max(
        b.longScore,
        b.shortScore
      ) -
      Math.max(
        a.longScore,
        a.shortScore
      )
  );
}

// =========================
// TELEGRAM
// =========================

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

  return response.json();
}

// =========================
// TELEGRAM UPDATE
// =========================

async function handleUpdate(
  update,
  env
) {
  if (!update.message) {
    return;
  }

  if (!env.BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN missing"
    );
  }

  const chatId =
    update.message.chat.id;

  const text =
    update.message.text || "";

  if (text === "/start") {
    await sendTelegram(
      env.BOT_TOKEN,
      chatId,
      `🤖 *Algo Esmail V2*

✅ ربات آنلاین است.

دستورات:

/scan
اسکن بازار

/signal BTC
تحلیل BTC

/help
راهنما`
    );

    return;
  }

  if (text === "/help") {
    await sendTelegram(
      env.BOT_TOKEN,
      chatId,
      `📚 *راهنما*

/scan
اسکن چند ارز

/signal BTC
تحلیل بیت‌کوین

/signal ETH
تحلیل اتریوم`
    );

    return;
  }

  if (text === "/scan") {

    await sendTelegram(
      env.BOT_TOKEN,
      chatId,
      "🔎 در حال اسکن بازار Toobit..."
    );

    const results =
      await scanMarket();

    if (!results.length) {
      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        "❌ هیچ داده‌ای از Toobit دریافت نشد."
      );

      return;
    }

    let message =
      "🔥 *ALGO ESMAIL V2*\n\n";

    results.forEach(
      (r, index) => {
        const score =
          Math.max(
            r.longScore,
            r.shortScore
          );

        message +=
`${index + 1}. *${r.symbol}*

${r.signal === "LONG"
  ? "🟢"
  : r.signal === "SHORT"
  ? "🔴"
  : "⏳"} ${r.signal}

Score: ${score}/100
4H: ${r.trend4H}
1H: ${r.trend1H}
RSI: ${r.rsi.toFixed(1)}

━━━━━━━━━━━━━━
`;
      }
    );

    await sendTelegram(
      env.BOT_TOKEN,
      chatId,
      message
    );

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
      symbol = "BTC";
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
      env.BOT_TOKEN,
      chatId,
      `🔎 در حال تحلیل ${symbol}...`
    );

    try {
      const result =
        await analyzeSymbol(
          symbol
        );

      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        makeSignalMessage(
          result
        )
      );
    } catch (error) {
      console.error(error);

      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        `❌ تحلیل ${symbol} انجام نشد.`
      );
    }
  }
}

// =========================
// WORKER
// =========================

export default {

  async fetch(
    request,
    env
  ) {
    if (
      request.method === "GET"
    ) {
      return new Response(
        "Algo Esmail V2 is running!"
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
        "OK"
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
