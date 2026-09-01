const BASE_URL = "https://api.toobit.com";

async function getKlines(interval, limit = 250) {
  const url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Toobit API error: ${response.status}`);
  }

  return await response.json();
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function calculateRSI(closes, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      (avgGain * (period - 1) + gain) / period;

    avgLoss =
      (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function calculateATR(candles, period = 14) {
  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  return (
    recent.reduce(
      (sum, value) => sum + value,
      0
    ) / recent.length
  );
}

function convertCandles(data) {
  return data.map(c => ({
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

async function analyzeBTC() {
  const [oneHourRaw, fourHourRaw] =
    await Promise.all([
      getKlines("1h"),
      getKlines("4h")
    ]);

  const oneHour =
    convertCandles(oneHourRaw);

  const fourHour =
    convertCandles(fourHourRaw);

  const closes1H =
    oneHour.map(c => c.close);

  const closes4H =
    fourHour.map(c => c.close);

  const price =
    closes1H[closes1H.length - 1];

  const ema50 =
    ema(closes4H.slice(-200), 50);

  const ema200 =
    ema(closes4H, 200);

  let trend = "NEUTRAL";

  if (
    price > ema50 &&
    ema50 > ema200
  ) {
    trend = "BULLISH";
  }

  if (
    price < ema50 &&
    ema50 < ema200
  ) {
    trend = "BEARISH";
  }

  const rsi =
    calculateRSI(closes1H);

  const previousCandles =
    oneHour.slice(-21, -1);

  const recentVolume =
    previousCandles.reduce(
      (sum, candle) =>
        sum + candle.volume,
      0
    ) / previousCandles.length;

  const current =
    oneHour[oneHour.length - 1];

  const currentVolume =
    current.volume;

  const volumeStrong =
    currentVolume > recentVolume;

  const previousHigh =
    Math.max(
      ...previousCandles.map(
        c => c.high
      )
    );

  const previousLow =
    Math.min(
      ...previousCandles.map(
        c => c.low
      )
    );

  const bullishBreak =
    current.close > previousHigh;

  const bearishBreak =
    current.close < previousLow;

  const c1 =
    oneHour[oneHour.length - 3];

  const c3 =
    oneHour[oneHour.length - 1];

  const bullishFVG =
    c3.low > c1.high;

  const bearishFVG =
    c3.high < c1.low;

  let longScore = 0;
  let shortScore = 0;

  if (trend === "BULLISH") {
    longScore += 25;
  }

  if (trend === "BEARISH") {
    shortScore += 25;
  }

  if (bullishBreak) {
    longScore += 25;
  }

  if (bearishBreak) {
    shortScore += 25;
  }

  if (bullishFVG) {
    longScore += 15;
  }

  if (bearishFVG) {
    shortScore += 15;
  }

  if (rsi > 50) {
    longScore += 15;
  }

  if (rsi < 50) {
    shortScore += 15;
  }

  if (volumeStrong) {
    longScore += 10;
    shortScore += 10;
  }

  const atr =
    calculateATR(oneHour);

  let signal = "NO SIGNAL";

  let entry = price;
  let stop = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (
    longScore >= 75 &&
    trend === "BULLISH"
  ) {
    signal = "LONG";

    stop =
      entry - atr * 0.8;

    const risk =
      entry - stop;

    tp1 =
      entry + risk;

    tp2 =
      entry + risk * 2;

    tp3 =
      entry + risk * 3;
  } else if (
    shortScore >= 75 &&
    trend === "BEARISH"
  ) {
    signal = "SHORT";

    stop =
      entry + atr * 0.8;

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
    signal,
    price,
    trend,
    rsi,
    longScore,
    shortScore,
    entry,
    stop,
    tp1,
    tp2,
    tp3
  };
}

function formatPrice(value) {
  if (value === null) {
    return "—";
  }

  return Number(value)
    .toLocaleString("en-US", {
      maximumFractionDigits: 2
    });
}

function makeMessage(data) {
  let emoji = "⏳";

  if (data.signal === "LONG") {
    emoji = "🟢";
  }

  if (data.signal === "SHORT") {
    emoji = "🔴";
  }

  let message =
`${emoji} *ALGO ESMAIL V1*

₿ BTCUSDT

*Signal:* ${data.signal}

💰 Price:
${formatPrice(data.price)}

📊 Long Score:
${data.longScore}/100

📊 Short Score:
${data.shortScore}/100

📈 4H Trend:
${data.trend}

RSI 1H:
${data.rsi.toFixed(1)}
`;

  if (data.signal !== "NO SIGNAL") {
    message += `
━━━━━━━━━━━━━━

🎯 Entry:
${formatPrice(data.entry)}

🛑 Stop Loss:
${formatPrice(data.stop)}

🎯 TP1:
${formatPrice(data.tp1)}

🎯 TP2:
${formatPrice(data.tp2)}

🎯 TP3:
${formatPrice(data.tp3)}

⚠️ این فقط سیگنال آزمایشی است.
`;
  }

  return message;
}

async function telegramRequest(
  token,
  method,
  body
) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  return await response.json();
}

async function sendMessage(
  token,
  chatId,
  text
) {
  return telegramRequest(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    }
  );
}

async function handleTelegramUpdate(
  update,
  token
) {
  if (!update.message) {
    return;
  }

  const message =
    update.message;

  const chatId =
    message.chat.id;

  const text =
    message.text || "";

  if (text === "/start") {
    await sendMessage(
      token,
      chatId,
`🤖 *Algo Esmail V1*

سلام 👋

من سیستم آزمایشی تحلیل BTC هستم.

دستورهای موجود:

/signal
تحلیل لحظه‌ای BTCUSDT

/help
راهنما

⚠️ فعلاً هیچ معامله‌ای به‌صورت خودکار انجام نمی‌دهم.`
    );

    return;
  }

  if (text === "/help") {
    await sendMessage(
      token,
      chatId,
`📚 *راهنما*

/signal
دریافت آخرین سیگنال BTCUSDT

سیستم از:
• روند 4H
• ساختار 1H
• RSI
• Volume
• FVG
استفاده می‌کند.

بعداً فیلترهای بیشتری اضافه می‌کنیم.`
    );

    return;
  }

  if (text === "/signal") {
    await sendMessage(
      token,
      chatId,
      "🔎 در حال تحلیل BTCUSDT..."
    );

    try {
      const result =
        await analyzeBTC();

      await sendMessage(
        token,
        chatId,
        makeMessage(result)
      );
    } catch (error) {
      console.error(error);

      await sendMessage(
        token,
        chatId,
        "❌ خطا در دریافت اطلاعات Toobit."
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    if (request.method === "GET") {
      return new Response(
        "Algo Esmail Bot is running!",
        {
          status: 200
        }
      );
    }

    if (request.method !== "POST") {
      return new Response(
        "Method Not Allowed",
        {
          status: 405
        }
      );
    }

    const token =
      env.BOT_TOKEN;

    if (!token) {
      return new Response(
        "BOT_TOKEN is missing",
        {
          status: 500
        }
      );
    }

    try {
      const update =
        await request.json();

      await handleTelegramUpdate(
        update,
        token
      );

      return new Response(
        "OK",
        {
          status: 200
        }
      );
    } catch (error) {
      console.error(error);

      return new Response(
        "Internal Server Error",
        {
          status: 500
        }
      );
    }
  }
};
