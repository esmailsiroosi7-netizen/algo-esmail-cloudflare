const BASE_URL = "https://api.toobit.com";

const TIMEOUT_MS = 8000;

// بودجه فرضی
const PAPER_BUDGET = 100;

// حداکثر ریسک هر معامله
const RISK_PERCENT = 1;

// تعداد فرصت‌هایی که در گزارش نشان داده می‌شود
const TOP_OPPORTUNITIES = 5;

// --------------------------------------------------
// ارتباط با Toobit
// --------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getKlines(symbol, interval, limit = 200) {
  const url =
    `${BASE_URL}/quote/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}` +
    `&limit=${limit}`;

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(
      `خطای Toobit: ${response.status}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("داده کندل نامعتبر است");
  }

  return data.map(c => ({
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

// --------------------------------------------------
// اندیکاتورها
// --------------------------------------------------

function ema(values, period) {
  if (!values.length) return 0;

  const multiplier = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier +
      result;
  }

  return result;
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      closes[i] - closes[i - 1];

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
    i < closes.length;
    i++
  ) {
    const change =
      closes[i] - closes[i - 1];

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

  return 100 -
    100 / (1 + rs);
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

function calculateMACD(
  closes
) {
  if (closes.length < 35) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0
    };
  }

  const macdValues = [];

  for (
    let i = 0;
    i < closes.length;
    i++
  ) {
    const slice =
      closes.slice(
        0,
        i + 1
      );

    if (slice.length < 26) {
      continue;
    }

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
      macdValues.slice(-9),
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
    period * 2
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
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const up =
      current.high -
      previous.high;

    const down =
      previous.low -
      current.low;

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

    trSum += Math.max(
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
      plusDI - minusDI
    ) /
    (plusDI + minusDI)
  );
}

// --------------------------------------------------
// روند
// --------------------------------------------------

function getTrend(candles) {
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
      closes.slice(-100),
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
    candles.slice(-30);

  const support =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  const resistance =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  return {
    support,
    resistance
  };
}

// --------------------------------------------------
// حجم
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
      low
  };
}

// --------------------------------------------------
// تحلیل کامل
// --------------------------------------------------

async function analyzeSymbol(
  symbol
) {
  const [
    m15Result,
    h1Result,
    h4Result
  ] =
    await Promise.allSettled([
      getKlines(
        symbol,
        "15m",
        150
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
      )
    ]);

  if (
    h1Result.status !==
      "fulfilled" ||
    h4Result.status !==
      "fulfilled"
  ) {
    throw new Error(
      "اطلاعات کافی دریافت نشد"
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
    calculateRSI(
      closes
    );

  const macd =
    calculateMACD(
      closes
    );

  const atr =
    calculateATR(h1);

  const adx =
    calculateADX(h1);

  const volume =
    volumeAnalysis(
      h1
    );

  const breakout =
    breakoutAnalysis(
      h1
    );

  const levels =
    getSupportResistance(
      h1
    );

  let longScore = 0;
  let shortScore = 0;

  // روند 4 ساعته
  if (
    trend4 ===
    "صعودی قوی"
  ) {
    longScore += 25;
  } else if (
    trend4 ===
    "صعودی"
  ) {
    longScore += 18;
  } else if (
    trend4 ===
    "نزولی قوی"
  ) {
    shortScore += 25;
  } else if (
    trend4 ===
    "نزولی"
  ) {
    shortScore += 18;
  }

  // روند 1 ساعته
  if (
    trend1 ===
    "صعودی قوی"
  ) {
    longScore += 20;
  } else if (
    trend1 ===
    "صعودی"
  ) {
    longScore += 14;
  } else if (
    trend1 ===
    "نزولی قوی"
  ) {
    shortScore += 20;
  } else if (
    trend1 ===
    "نزولی"
  ) {
    shortScore += 14;
  }

  // روند 15 دقیقه
  if (
    trend15.includes(
      "صعودی"
    )
  ) {
    longScore += 10;
  }

  if (
    trend15.includes(
      "نزولی"
    )
  ) {
    shortScore += 10;
  }

  // RSI
  if (
    rsi >= 52 &&
    rsi <= 68
  ) {
    longScore += 10;
  }

  if (
    rsi >= 32 &&
    rsi <= 48
  ) {
    shortScore += 10;
  }

  // MACD
  if (
    macd.histogram > 0
  ) {
    longScore += 10;
  }

  if (
    macd.histogram < 0
  ) {
    shortScore += 10;
  }

  // قدرت روند
  if (adx >= 25) {
    if (
      trend1.includes(
        "صعودی"
      )
    ) {
      longScore += 8;
    }

    if (
      trend1.includes(
        "نزولی"
      )
    ) {
      shortScore += 8;
    }
  }

  // حجم
  if (
    volume.bullish
  ) {
    longScore += 7;
  }

  if (
    volume.bearish
  ) {
    shortScore += 7;
  }

  // شکست
  if (
    breakout.bullish
  ) {
    longScore += 10;
  }

  if (
    breakout.bearish
  ) {
    shortScore += 10;
  }

  // محدود کردن امتیاز
  longScore =
    Math.min(
      longScore,
      100
    );

  shortScore =
    Math.min(
      shortScore,
      100
    );

  let signal =
    "بدون سیگنال";

  const best =
    Math.max(
      longScore,
      shortScore
    );

  if (
    longScore >= 70 &&
    longScore >
      shortScore + 10
  ) {
    signal =
      "فرصت خرید";
  }

  if (
    shortScore >= 70 &&
    shortScore >
      longScore + 10
  ) {
    signal =
      "فرصت فروش";
  }

  // --------------------------------------------
  // مدیریت معامله
  // --------------------------------------------

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
      stop - price;

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

  // --------------------------------------------
  // محاسبه حجم
  // --------------------------------------------

  const maxLoss =
    PAPER_BUDGET *
    (RISK_PERCENT / 100);

  let positionSize = 0;

  if (
    riskPerUnit > 0
  ) {
    positionSize =
      maxLoss /
      riskPerUnit;
  }

  // --------------------------------------------
  // تعیین لوریج
  // --------------------------------------------

  let leverage = 1;

  if (
    signal !==
    "بدون سیگنال"
  ) {
    if (
      atr / price <
      0.01
    ) {
      leverage = 5;
    } else if (
      atr / price <
      0.02
    ) {
      leverage = 4;
    } else if (
      atr / price <
      0.04
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
    bestScore: best,

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

    stop,
    tp1,
    tp2,
    tp3,

    positionSize,
    leverage
  };
}

// --------------------------------------------------
// فرمت قیمت
// --------------------------------------------------

function formatPrice(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "—";
  }

  if (
    value >= 1000
  ) {
    return value.toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 2
      }
    );
  }

  if (
    value >= 1
  ) {
    return value.toFixed(3);
  }

  return value.toFixed(6);
}

// --------------------------------------------------
// KV
// --------------------------------------------------

async function saveChat(
  env,
  chatId
) {
  if (
    !env.ALGO_ESMAIL_KV
  ) {
    throw new Error(
      "KV متصل نیست"
    );
  }

  await env.ALGO_ESMAIL_KV.put(
    `chat:${chatId}`,
    "active"
  );
}

async function removeChat(
  env,
  chatId
) {
  await env.ALGO_ESMAIL_KV.delete(
    `chat:${chatId}`
  );
}

async function getSubscribedChats(
  env
) {
  const list =
    await env.ALGO_ESMAIL_KV.list(
      {
        prefix: "chat:"
      }
    );

  return list.keys.map(
    key =>
      key.name.replace(
        "chat:",
        ""
      )
  );
}

// --------------------------------------------------
// ثبت Paper Trade
// --------------------------------------------------

async function savePaperTrade(
  env,
  result
) {
  if (
    result.signal ===
    "بدون سیگنال"
  ) {
    return;
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

    status:
      "open"
  };

  await env.ALGO_ESMAIL_KV.put(
    `trade:${id}`,
    JSON.stringify(trade)
  );
}

// --------------------------------------------------
// اسکن بازار
// --------------------------------------------------

async function getSymbols() {
  // فعلاً برای اطمینان از پایداری
  // این نمادها را بررسی می‌کنیم.
  //
  // در مرحله بعد این قسمت را
  // به دریافت خودکار نمادهای Toobit
  // تبدیل می‌کنیم.

  return [
    "BTC-SWAP-USDT",
    "ETH-SWAP-USDT",
    "SOL-SWAP-USDT",
    "XRP-SWAP-USDT",
    "BNB-SWAP-USDT",

    "DOGE-SWAP-USDT",
    "ADA-SWAP-USDT",
    "AVAX-SWAP-USDT",
    "LINK-SWAP-USDT",
    "LTC-SWAP-USDT",
    "TRX-SWAP-USDT",
    "DOT-SWAP-USDT",
    "NEAR-SWAP-USDT",
    "ATOM-SWAP-USDT",
    "SUI-SWAP-USDT"
  ];
}

async function scanMarket() {
  const symbols =
    await getSymbols();

  const results = [];

  // همزمان فقط چند ارز
  // تا Worker بیش از حد تحت فشار قرار نگیرد

  const batchSize = 3;

  for (
    let i = 0;
    i < symbols.length;
    i += batchSize
  ) {
    const batch =
      symbols.slice(
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
            } catch (
              error
            ) {
              console.error(
                `خطا در ${symbol}:`,
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
// گزارش /scan
// --------------------------------------------------

function makeScanReport(
  results
) {
  if (
    !results.length
  ) {
    return `
❌ *اسکن انجام نشد*

اطلاعات کافی از توبیت دریافت نشد.
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

🟢 خرید:
${r.longScore}

🔴 فروش:
${r.shortScore}

📈 روند ۴ ساعته:
${r.trend4}

📈 روند ۱ ساعته:
${r.trend1}

⏱ روند ۱۵ دقیقه:
${r.trend15}

💪 قدرت بازار:
${r.rsi.toFixed(1)}

📊 قدرت روند:
${r.adx.toFixed(1)}

📊 حجم:
${r.volumeRatio.toFixed(2)} برابر

💰 قیمت:
${formatPrice(r.price)}
`;

        if (
          r.signal !==
          "بدون سیگنال"
        ) {
          message += `
━━━━━━━━━━━━━━

🎯 ورود:
${formatPrice(r.price)}

🛑 حد ضرر:
${formatPrice(r.stop)}

🎯 هدف اول:
${formatPrice(r.tp1)}

🎯 هدف دوم:
${formatPrice(r.tp2)}

🎯 هدف سوم:
${formatPrice(r.tp3)}

💵 حجم پیشنهادی:
${r.positionSize.toFixed(4)}

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

در حال حاضر فرصت باکیفیتی پیدا نشد.

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
${formatPrice(r.price)}

🛑 حد ضرر:
${formatPrice(r.stop)}

🎯 هدف اول:
${formatPrice(r.tp1)}

🎯 هدف دوم:
${formatPrice(r.tp2)}

⚙️ لوریج آزمایشی:
${r.leverage}x

━━━━━━━━━━━━━━
`;
    }
  );

  message += `
🧪 معاملات فعلاً آزمایشی هستند.
`;

  return message;
}

// --------------------------------------------------
// تلگرام
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
        method:
          "POST",

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
              "Markdown"
          })
      }
    );

  const data =
    await response.json();

  if (
    !data.ok
  ) {
    throw new Error(
      data.description ||
        "خطای تلگرام"
    );
  }

  return data;
}

// --------------------------------------------------
// پردازش پیام
// --------------------------------------------------

async function handleUpdate(
  update,
  env
) {
  if (
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

  // START
  if (
    text ===
    "/start"
  ) {
    await sendTelegram(
      token,
      chatId,
      `
🤖 *الگو اسماعیل V3*

ربات با موفقیت فعال است. 🚀

دستورات:

/scan
🔎 تحلیل کامل بازار

/signal BTC
📊 تحلیل یک ارز

/subscribe
⏰ گزارش خودکار ساعتی

/unsubscribe
❌ لغو گزارش خودکار

/help
📚 راهنما

🧪 معاملات فعلاً آزمایشی هستند.
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
📚 *راهنمای الگو اسماعیل V3*

/scan
بررسی بهترین فرصت‌های بازار

/signal BTC
تحلیل بیت‌کوین

/subscribe
فعال‌سازی گزارش ساعتی

/unsubscribe
لغو گزارش ساعتی

🧪 هیچ معامله واقعی انجام نمی‌شود.
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
✅ *گزارش خودکار فعال شد.*

ربات بازار را بررسی می‌کند و فرصت‌های مناسب را برایت می‌فرستد.

🧪 معاملات فعلاً آزمایشی هستند.
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
      `
✅ گزارش خودکار غیرفعال شد.
`
    );

    return;
  }

  // SCAN
  if (
    text ===
    "/scan"
  ) {
    await sendTelegram(
      token,
      chatId,
      "🔎 در حال بررسی بازار توبیت..."
    );

    try {
      const results =
        await scanMarket();

      // ثبت فرصت‌های واقعی
      for (
        const result of results
      ) {
        await savePaperTrade(
          env,
          result
        );
      }

      await sendTelegram(
        token,
        chatId,
        makeScanReport(
          results
        )
      );
    } catch (
      error
    ) {
      console.error(
        "SCAN ERROR:",
        error
      );

      await sendTelegram(
        token,
        chatId,
        `
❌ اسکن بازار با خطا مواجه شد.

جزئیات در گزارش Worker ثبت شد.
`
      );
    }

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

    try {
      const result =
        await analyzeSymbol(
          symbol
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
    } catch (
      error
    ) {
      console.error(
        "SIGNAL ERROR:",
        error
      );

      await sendTelegram(
        token,
        chatId,
        `
❌ تحلیل ${symbol} انجام نشد.
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
    env
  ) {
    if (
      request.method ===
      "GET"
    ) {
      return new Response(
        "Algo Esmail V3 is running!"
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

      await handleUpdate(
        update,
        env
      );

      return new Response(
        "OK"
      );
    } catch (
      error
    ) {
      console.error(
        "WORKER ERROR:",
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

  async scheduled(
    event,
    env,
    ctx
  ) {
    console.log(
      "شروع گزارش خودکار"
    );

    try {
      const chats =
        await getSubscribedChats(
          env
        );

      if (
        !chats.length
      ) {
        console.log(
          "کاربر فعالی وجود ندارد"
        );

        return;
      }

      const results =
        await scanMarket();

      for (
        const result of results
      ) {
        await savePaperTrade(
          env,
          result
        );
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
        } catch (
          error
        ) {
          console.error(
            `خطا در ارسال به ${chatId}:`,
            error
          );
        }
      }

    } catch (
      error
    ) {
      console.error(
        "SCHEDULE ERROR:",
        error
      );
    }
  }
};
