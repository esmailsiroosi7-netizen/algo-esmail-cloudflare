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
// درخواست با محدودیت زمانی
// =========================

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

// =========================
// دریافت کندل
// =========================

async function getKlines(symbol, interval, limit = 100) {
  const url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}` +
    `&limit=${limit}`;

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`خطای توبیت: ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("داده دریافتی از توبیت نامعتبر است");
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
// میانگین متحرک نمایی
// =========================

function ema(values, period) {
  if (!values.length) {
    return 0;
  }

  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier +
      result;
  }

  return result;
}

// =========================
// قدرت نسبی بازار
// =========================

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      closes[i] - closes[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change =
      closes[i] - closes[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

// =========================
// دامنه واقعی بازار
// =========================

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
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

// =========================
// تشخیص روند
// =========================

function getTrend(candles) {
  const closes =
    candles.map(c => c.close);

  const price =
    closes[closes.length - 1];

  const ema50 =
    ema(closes.slice(-100), 50);

  const ema200 =
    ema(closes, 200);

  if (
    price > ema50 &&
    ema50 > ema200
  ) {
    return "صعودی";
  }

  if (
    price < ema50 &&
    ema50 < ema200
  ) {
    return "نزولی";
  }

  return "خنثی";
}

// =========================
// تشخیص شکست
// =========================

function detectBreakout(candles) {
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

// =========================
// بررسی حجم
// =========================

function analyzeVolume(candles) {
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
      (sum, c) => sum + c.volume,
      0
    ) / previous.length;

  const ratio =
    average > 0
      ? current.volume / average
      : 1;

  return {
    ratio,

    bullish:
      ratio >= 1.2 &&
      current.close > current.open,

    bearish:
      ratio >= 1.2 &&
      current.close < current.open
  };
}

// =========================
// تحلیل یک ارز
// =========================

async function analyzeSymbol(symbol) {
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

  const candles = {};

  for (
    let i = 0;
    i < TIMEFRAMES.length;
    i++
  ) {
    if (
      responses[i].status ===
      "fulfilled"
    ) {
      candles[TIMEFRAMES[i]] =
        responses[i].value;
    }
  }

  if (
    !candles["1h"] ||
    !candles["4h"]
  ) {
    throw new Error(
      "اطلاعات کافی دریافت نشد"
    );
  }

  const h1 = candles["1h"];
  const h4 = candles["4h"];
  const m15 = candles["15m"] || h1;

  const price =
    h1[h1.length - 1].close;

  const trend4H =
    getTrend(h4);

  const trend1H =
    getTrend(h1);

  const trend15M =
    getTrend(m15);

  const rsi =
    calculateRSI(
      h1.map(c => c.close)
    );

  const atr =
    calculateATR(h1);

  const breakout =
    detectBreakout(m15);

  const volume =
    analyzeVolume(m15);

  let longScore = 0;
  let shortScore = 0;

  // روند ۴ ساعته
  if (trend4H === "صعودی") {
    longScore += 30;
  }

  if (trend4H === "نزولی") {
    shortScore += 30;
  }

  // روند یک ساعته
  if (trend1H === "صعودی") {
    longScore += 20;
  }

  if (trend1H === "نزولی") {
    shortScore += 20;
  }

  // روند ۱۵ دقیقه
  if (trend15M === "صعودی") {
    longScore += 10;
  }

  if (trend15M === "نزولی") {
    shortScore += 10;
  }

  // قدرت نسبی
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

  // شکست
  if (breakout.bullish) {
    longScore += 15;
  }

  if (breakout.bearish) {
    shortScore += 15;
  }

  // حجم
  if (volume.bullish) {
    longScore += 10;
  }

  if (volume.bearish) {
    shortScore += 10;
  }

  let signal = "بدون سیگنال";

  if (
    longScore >= 70 &&
    longScore >
      shortScore + 10 &&
    trend4H === "صعودی"
  ) {
    signal = "فرصت خرید";
  }

  if (
    shortScore >= 70 &&
    shortScore >
      longScore + 10 &&
    trend4H === "نزولی"
  ) {
    signal = "فرصت فروش";
  }

  let stop = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (
    signal === "فرصت خرید" &&
    atr > 0
  ) {
    stop =
      price - atr * 0.8;

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
    signal === "فرصت فروش" &&
    atr > 0
  ) {
    stop =
      price + atr * 0.8;

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
    volumeRatio: volume.ratio,
    stop,
    tp1,
    tp2,
    tp3
  };
}

// =========================
// نمایش قیمت
// =========================

function formatPrice(value) {
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

// =========================
// پیام تحلیل
// =========================

function makeSignalMessage(result) {
  const emoji =
    result.signal === "فرصت خرید"
      ? "🟢"
      : result.signal === "فرصت فروش"
      ? "🔴"
      : "⏳";

  let message = `
${emoji} *الگو اسماعیل V2*

ارز:
*${result.symbol}*

نتیجه:
*${result.signal}*

💰 قیمت:
${formatPrice(result.price)}

📊 امتیاز خرید:
${result.longScore} از 100

📊 امتیاز فروش:
${result.shortScore} از 100

📈 روند ۴ ساعته:
${result.trend4H}

📈 روند ۱ ساعته:
${result.trend1H}

⏱ روند ۱۵ دقیقه:
${result.trend15M}

قدرت بازار:
${result.rsi.toFixed(1)}

حجم معاملات:
${result.volumeRatio.toFixed(2)} برابر
`;

  if (
    result.signal !==
    "بدون سیگنال"
  ) {
    message += `
━━━━━━━━━━━━━━

🎯 نقطه ورود:
${formatPrice(result.price)}

🛑 حد ضرر:
${formatPrice(result.stop)}

🎯 هدف اول:
${formatPrice(result.tp1)}

🎯 هدف دوم:
${formatPrice(result.tp2)}

🎯 هدف سوم:
${formatPrice(result.tp3)}
`;
  }

  message += `
⚠️ این تحلیل آزمایشی است و توصیه مالی نیست.`;

  return message;
}

// =========================
// ارسال پیام تلگرام
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
// اسکن بازار
// =========================

async function scanMarket() {
  const results = [];

  // فعلاً ۵ ارز آزمایشی
  // بعداً خودکار از توبیت دریافت می‌کنیم.

  for (
    let i = 0;
    i < SYMBOLS.length;
    i += 2
  ) {
    const batch =
      SYMBOLS.slice(i, i + 2);

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
                symbol,
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
// گزارش بازار
// =========================

function makeMarketReport(
  results
) {
  const strong =
    results.filter(
      r =>
        r.signal !==
        "بدون سیگنال"
    );

  if (!strong.length) {
    return `
⏰ *گزارش ساعتی بازار*

در حال حاضر فرصت معاملاتی قدرتمندی پیدا نشد.

بازار همچنان تحت نظر است 👀

گزارش بعدی یک ساعت دیگر.
`;
  }

  let message = `
🚨 *گزارش ساعتی بازار*

فرصت‌های قابل توجه:

`;

  strong.forEach(
    (r, index) => {
      const score =
        Math.max(
          r.longScore,
          r.shortScore
        );

      message += `
${index + 1}. *${r.symbol}*

${
  r.signal === "فرصت خرید"
    ? "🟢 خرید"
    : "🔴 فروش"
}

امتیاز:
${score} از 100

روند ۴ ساعته:
${r.trend4H}

روند ۱ ساعته:
${r.trend1H}

قدرت بازار:
${r.rsi.toFixed(1)}

━━━━━━━━━━━━━━
`;
    }
  );

  message += `
⚠️ تحلیل آزمایشی است.`;

  return message;
}

// =========================
// پردازش پیام تلگرام
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
      "BOT_TOKEN تنظیم نشده است"
    );
  }

  const chatId =
    update.message.chat.id;

  const text =
    update.message.text || "";

  // ثبت اشتراک
  if (text === "/subscribe") {
    return sendTelegram(
      env.BOT_TOKEN,
      chatId,
      `
✅ اشتراک گزارش ساعتی فعال شد.

از این به بعد ربات گزارش بازار را به‌صورت خودکار برای شما ارسال می‌کند.

⚠️ در مرحله فعلی گزارش‌ها آزمایشی هستند.
`
    );
  }

  // لغو اشتراک
  if (text === "/unsubscribe") {
    return sendTelegram(
      env.BOT_TOKEN,
      chatId,
      `
✅ اشتراک گزارش ساعتی لغو شد.

برای فعال‌سازی دوباره:
 /subscribe
`
    );
  }

  // شروع
  if (text === "/start") {
    return sendTelegram(
      env.BOT_TOKEN,
      chatId,
      `
🤖 *الگو اسماعیل V2*

سلام 👋

ربات با موفقیت فعال است.

دستورات:

/scan
بررسی بازار

/signal BTC
تحلیل بیت‌کوین

/subscribe
فعال‌سازی گزارش ساعتی

/unsubscribe
لغو گزارش ساعتی

/help
راهنما

⏰ گزارش بازار به‌صورت خودکار بررسی می‌شود.
`
    );
  }

  // راهنما
  if (text === "/help") {
    return sendTelegram(
      env.BOT_TOKEN,
      chatId,
      `
📚 *راهنمای ربات*

/scan
بررسی بازار

/signal BTC
تحلیل بیت‌کوین

/signal ETH
تحلیل اتریوم

/subscribe
فعال‌سازی گزارش خودکار

/unsubscribe
لغو گزارش خودکار

در نسخه‌های بعدی تعداد ارزهای بررسی‌شده افزایش پیدا می‌کند.
`
    );
  }

  // اسکن
  if (text === "/scan") {
    await sendTelegram(
      env.BOT_TOKEN,
      chatId,
      "🔎 در حال بررسی بازار..."
    );

    try {
      const results =
        await scanMarket();

      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        makeMarketReport(
          results
        )
      );
    } catch (error) {
      console.error(error);

      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        "❌ بررسی بازار با خطا مواجه شد."
      );
    }

    return;
  }

  // تحلیل یک ارز
  if (
    text.startsWith("/signal")
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
      `🔎 در حال بررسی ${symbol}...`
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
        `❌ اطلاعات ${symbol} دریافت نشد.`
      );
    }
  }
}

// =========================
// اجرای اصلی Worker
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
  },

  // =========================
  // اجرای خودکار هر ساعت
  // =========================

  async scheduled(
    event,
    env,
    ctx
  ) {
    console.log(
      "شروع بررسی خودکار بازار"
    );

    if (!env.BOT_TOKEN) {
      console.error(
        "BOT_TOKEN تنظیم نشده است"
      );

      return;
    }

    /*
      فعلاً Cron فقط بازار را بررسی می‌کند.

      برای ارسال واقعی گزارش،
      باید شناسه چت در KV ذخیره شود.

      این قسمت در مرحله بعد
      به KV متصل می‌شود.
    */

    try {
      const results =
        await scanMarket();

      console.log(
        "بررسی خودکار انجام شد",
        results
      );
    } catch (error) {
      console.error(
        "خطا در بررسی خودکار",
        error
      );
    }
  }
};
