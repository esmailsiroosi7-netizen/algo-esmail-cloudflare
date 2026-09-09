// ============================================================
// ALGO FJM V6.0 - OPTIMIZED & FIXED
// Cloudflare Workers + Telegram + Dashboard API
// ============================================================

const BASE_URL = "https://api.toobit.com";
const TIMEOUT_MS = 5000;
const MAX_ANALYSIS_SYMBOLS = 8;
const ANALYSIS_BATCH = 4;
const SHORTLIST_FOR_DERIVATIVES = 3;
const MIN_SIGNAL_SCORE = 65;
const PAPER_BUDGET = 100;
const RISK_PERCENT = 1;
const MAX_OPEN_TRADE_AGE_HOURS = 24;
const PAPER_CHECK_CANDLES = 200;
const MAX_CONCURRENT_TRADES = 2;
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;

// ============================================================
// UTILITY
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNumber(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function average(arr) { const v = arr.filter(Number.isFinite); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0; }
function formatNumber(v, d = 6) { const n = safeNumber(v); if (!n) return "0"; if (Math.abs(n)>=1000) return n.toFixed(2); if (Math.abs(n)>=1) return n.toFixed(4); if (Math.abs(n)>=0.01) return n.toFixed(5); return n.toFixed(d); }
function percent(v, d=2) { return `${safeNumber(v).toFixed(d)}%`; }
function formatDate(t) { const ts = safeNumber(t); if (!ts) return "نامشخص"; try { return new Date(ts).toLocaleString("fa-IR", {timeZone:"Asia/Tehran", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"}); } catch { return new Date(ts).toISOString(); } }
function formatDuration(s, e) { const start = safeNumber(s), end = safeNumber(e); if (!start || !end || end < start) return "نامشخص"; const minutes = Math.floor((end-start)/60000); if (minutes<60) return `${minutes} دقیقه`; const hours = Math.floor(minutes/60), mins = minutes%60; if (hours<24) return `${hours} ساعت و ${mins} دقیقه`; const days = Math.floor(hours/24), rem = hours%24; return `${days} روز و ${rem} ساعت`; }
function directionEmoji(d) { if (d==="خرید") return "🟢"; if (d==="فروش") return "🔴"; return "⚪"; }

// ============================================================
// HTTP
// ============================================================
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { "Accept": "application/json", ...(options.headers||{}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,300)}`);
    try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.slice(0,300)}`); }
  } finally { clearTimeout(timer); }
}

// ============================================================
// TELEGRAM
// ============================================================
async function telegram(method, data, env) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN not set.");
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.ok) throw new Error(`Telegram error: ${text}`);
  return json;
}
async function sendMessage(chatId, text, env, options = {}) {
  return telegram("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...options }, env);
}
async function sendLongMessage(chatId, text, env, options = {}) {
  if (!text) return;
  const MAX = 3800;
  if (text.length <= MAX) return sendMessage(chatId, text, env, options);
  const chunks = []; let remaining = text;
  while (remaining.length > MAX) {
    let splitAt = remaining.lastIndexOf("\n━━━━━━━━━━━━━━━━━━", MAX);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt < 1) splitAt = MAX;
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  for (let i=0; i<chunks.length; i++) {
    let chunk = chunks[i];
    if (chunks.length > 1) chunk = `📚 بخش ${i+1} از ${chunks.length}\n\n` + chunk;
    await sendMessage(chatId, chunk, env, options);
    if (i < chunks.length-1) await sleep(100);
  }
}

// ============================================================
// TOOBIT API
// ============================================================
async function getExchangeInfo() { return fetchJson(`${BASE_URL}/api/v1/exchangeInfo`); }
function extractContracts(data) { return Array.isArray(data?.contracts) ? data.contracts : Array.isArray(data?.data?.contracts) ? data.data.contracts : []; }
function isValidContract(c) { const s = c?.symbol || ""; if (!s) return false; const st = String(c.status||"").toUpperCase(); if (st && !["TRADING","NORMAL","ONLINE"].includes(st)) return false; return s.endsWith("-SWAP-USDT") || s.endsWith("-USDT"); }
async function getAllTickers() { const data = await fetchJson(`${BASE_URL}/quote/v1/contract/ticker/24hr`); return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.tickers) ? data.tickers : []; }
function tickerSymbol(t) { return t.symbol || t.s || ""; }
function tickerPrice(t) { return safeNumber(t.lastPrice ?? t.last ?? t.price ?? t.c); }
function tickerVolume(t) { return safeNumber(t.quoteVolume ?? t.volume24h ?? t.quoteVolume24h ?? t.qv ?? t.volume); }
function tickerChange(t) { return safeNumber(t.priceChangePercent ?? t.changePercent ?? t.p); }

async function getBestSymbols() {
  const [info, tickers] = await Promise.all([getExchangeInfo(), getAllTickers()]);
  const allowed = new Set(extractContracts(info).filter(isValidContract).map(x=>x.symbol));
  let candidates = tickers.map(t => ({ symbol: tickerSymbol(t), price: tickerPrice(t), volume: tickerVolume(t), change: tickerChange(t) })).filter(x => { if (!x.symbol || !x.price) return false; if (allowed.size && !allowed.has(x.symbol)) return false; return x.symbol.endsWith("-SWAP-USDT") || x.symbol.endsWith("-USDT"); });
  candidates.sort((a,b) => b.volume - a.volume);
  const btc = candidates.find(x => x.symbol === "BTC-SWAP-USDT");
  const selected = btc ? [btc] : [];
  for (const item of candidates) { if (selected.some(x=>x.symbol===item.symbol)) continue; selected.push(item); if (selected.length >= MAX_ANALYSIS_SYMBOLS) break; }
  return selected;
}

async function getKlines(symbol, interval, limit=150, startTime=null, endTime=null) {
  let url = `${BASE_URL}/quote/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  if (startTime != null) url += `&startTime=${safeNumber(startTime)}`;
  if (endTime != null) url += `&endTime=${safeNumber(endTime)}`;
  const data = await fetchJson(url);
  let rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  return rows.map(row => Array.isArray(row) ? { time: safeNumber(row[0]), open: safeNumber(row[1]), high: safeNumber(row[2]), low: safeNumber(row[3]), close: safeNumber(row[4]), volume: safeNumber(row[5]) } : { time: safeNumber(row.time||row.openTime), open: safeNumber(row.open), high: safeNumber(row.high), low: safeNumber(row.low), close: safeNumber(row.close), volume: safeNumber(row.volume) }).filter(x => x.time>0 && x.open>0 && x.high>0 && x.low>0 && x.close>0);
}

// ============================================================
// INDICATORS
// ============================================================
function ema(values, period) {
  if (!values.length || values.length < period) return new Array(values.length).fill(null);
  const result = new Array(values.length).fill(null);
  const mult = 2/(period+1);
  let sum = 0;
  for (let i=0; i<period; i++) sum += values[i];
  result[period-1] = sum/period;
  for (let i=period; i<values.length; i++) result[i] = (values[i]-result[i-1])*mult + result[i-1];
  return result;
}
function rsi(values, period=14) {
  const result = new Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains=0, losses=0;
  for (let i=1; i<=period; i++) { const d = values[i]-values[i-1]; if (d>=0) gains += d; else losses += Math.abs(d); }
  let avgGain = gains/period, avgLoss = losses/period;
  if (avgLoss === 0) { result[period] = 100; } else { result[period] = 100 - 100/(1 + avgGain/avgLoss); }
  for (let i=period+1; i<values.length; i++) { const d = values[i]-values[i-1]; const gain = d>0 ? d : 0; const loss = d<0 ? Math.abs(d) : 0; avgGain = (avgGain*(period-1)+gain)/period; avgLoss = (avgLoss*(period-1)+loss)/period; if (avgLoss === 0) { result[i] = 100; } else { result[i] = 100 - 100/(1 + avgGain/avgLoss); } }
  return result;
}
function atr(candles, period=14) {
  const result = new Array(candles.length).fill(null);
  if (candles.length <= period) return result;
  const tr = new Array(candles.length).fill(0);
  for (let i=1; i<candles.length; i++) { const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close; tr[i] = Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)); }
  let init = 0; for (let i=1; i<=period; i++) init += tr[i];
  result[period] = init/period;
  for (let i=period+1; i<candles.length; i++) result[i] = (result[i-1]*(period-1)+tr[i])/period;
  return result;
}
function macd(values) {
  const fast = ema(values, 12), slow = ema(values, 26);
  const line = new Array(values.length).fill(null);
  for (let i=0; i<values.length; i++) { if (fast[i] != null && slow[i] != null) line[i] = fast[i]-slow[i]; }
  const valid = line.filter(x=>x!=null);
  const signalValid = ema(valid, 9);
  const signal = new Array(values.length).fill(null);
  let j=0;
  for (let i=0; i<values.length; i++) { if (line[i] != null) { signal[i] = signalValid[j]; j++; } }
  const hist = new Array(values.length).fill(null);
  for (let i=0; i<values.length; i++) { if (line[i] != null && signal[i] != null) hist[i] = line[i]-signal[i]; }
  return { line, signal, histogram: hist };
}
function candlePatterns(candles) {
  if (candles.length < 3) return [];
  const b = candles[candles.length-2], c = candles[candles.length-1];
  const patterns = [];
  const body = Math.abs(c.close-c.open), range = c.high-c.low;
  if (range>0 && body/range<0.1) patterns.push("دوجی");
  const upper = c.high - Math.max(c.open,c.close), lower = Math.min(c.open,c.close)-c.low;
  if (lower > body*2 && upper < body) patterns.push("چکش");
  if (upper > body*2 && lower < body) patterns.push("شهاب‌سنگ");
  if (b.close < b.open && c.close > c.open && c.open <= b.close && c.close >= b.open) patterns.push("پوشای صعودی");
  if (b.close > b.open && c.close < c.open && c.open >= b.close && c.close <= b.open) patterns.push("پوشای نزولی");
  if (lower > body*2 && lower > upper*2) patterns.push("پین‌بار صعودی");
  if (upper > body*2 && upper > lower*2) patterns.push("پین‌بار نزولی");
  return patterns;
}
function marketStructure(candles) {
  if (candles.length < 20) return "نامشخص";
  const recent = candles.slice(-20);
  const highs = recent.map(x=>x.high), lows = recent.map(x=>x.low);
  const mid = 10;
  const fh = Math.max(...highs.slice(0,mid)), sh = Math.max(...highs.slice(mid));
  const fl = Math.min(...lows.slice(0,mid)), sl = Math.min(...lows.slice(mid));
  if (sh > fh && sl > fl) return "صعودی";
  if (sh < fh && sl < fl) return "نزولی";
  return "رنج";
}
function supportResistance(candles) {
  if (!candles.length) return { support:0, resistance:0 };
  const recent = candles.slice(-40);
  return { support: Math.min(...recent.map(x=>x.low)), resistance: Math.max(...recent.map(x=>x.high)) };
}

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 60) throw new Error("داده کافی نیست.");
  const closes = candles.map(x=>x.close);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const rsiValues = rsi(closes, 14), atrValues = atr(candles, 14), macdData = macd(closes);
  const i = candles.length-1, price = closes[i];
  const e20 = ema20[i], e50 = ema50[i], e200 = ema200[i] ?? e50;
  const rsiValue = rsiValues[i], atrValue = atrValues[i];
  const macdLine = macdData.line[i], macdSignal = macdData.signal[i], macdHist = macdData.histogram[i];
  const structure = marketStructure(candles), sr = supportResistance(candles);
  const recentVolumes = candles.slice(-21,-1).map(x=>x.volume);
  const avgVolume = average(recentVolumes);
  const currentVolume = candles[i].volume;
  const volumeRatio = avgVolume > 0 ? currentVolume/avgVolume : 1;
  let bull=0, bear=0;
  if (e20 > e50) bull += 15; else bear += 15;
  if (price > e20) bull += 8; else bear += 8;
  if (price > e200) bull += 8; else bear += 8;
  if (rsiValue >= 52 && rsiValue <= 70) bull += 12;
  if (rsiValue <= 48 && rsiValue >= 30) bear += 12;
  if (macdLine != null && macdSignal != null) { if (macdLine > macdSignal) bull += 12; else bear += 12; if (macdHist > 0) bull += 5; else bear += 5; }
  if (structure === "صعودی") bull += 12;
  if (structure === "نزولی") bear += 12;
  if (volumeRatio >= 1.3) { if (price > e20) bull += 6; else bear += 6; }
  const patterns = candlePatterns(candles);
  for (const p of patterns) { if (p.includes("صعودی") || p==="چکش") bull += 5; if (p.includes("نزولی") || p==="شهاب‌سنگ") bear += 5; }
  return { price, ema20:e20, ema50:e50, ema200:e200, rsi:rsiValue, atr:atrValue, macd:macdLine, macdSignal, macdHistogram:macdHist, volumeRatio, structure, support:sr.support, resistance:sr.resistance, patterns, bull, bear };
}

function combineAnalysis(a15, a1h, a4h) {
  let bull = a4h.bull*0.45 + a1h.bull*0.35 + a15.bull*0.20;
  let bear = a4h.bear*0.45 + a1h.bear*0.35 + a15.bear*0.20;
  const total = bull + bear;
  let direction = "خنثی";
  if (bull > bear && bull-bear >= 8) direction = "خرید";
  if (bear > bull && bear-bull >= 8) direction = "فروش";
  const score = total > 0 ? Math.round((Math.max(bull,bear)/total)*100) : 0;
  return { direction, score, bull, bear };
}

// ============================================================
// DERIVATIVES
// ============================================================
async function getFunding(symbol) { try { const data = await fetchJson(`${BASE_URL}/api/v1/futures/fundingRate?symbol=${encodeURIComponent(symbol)}`); const item = data?.data ?? data?.result ?? data; if (Array.isArray(item)) return safeNumber(item[0]?.fundingRate ?? item[0]?.rate); return safeNumber(item?.fundingRate ?? item?.rate); } catch { return null; } }
async function getOpenInterest(symbol) { try { const data = await fetchJson(`${BASE_URL}/quote/v1/openInterest?symbol=${encodeURIComponent(symbol)}`); const item = data?.data ?? data?.result ?? data; if (Array.isArray(item)) return safeNumber(item[0]?.openInterest ?? item[0]?.value); return safeNumber(item?.openInterest ?? item?.value); } catch { return null; } }
async function getLongShort(symbol) { try { const data = await fetchJson(`${BASE_URL}/api/v1/futures/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`); const item = data?.data ?? data?.result ?? data; if (Array.isArray(item)) return safeNumber(item[0]?.longShortRatio ?? item[0]?.ratio); return safeNumber(item?.longShortRatio ?? item?.ratio); } catch { return null; } }

async function getBTCContext() {
  try {
    const [h1, h4] = await Promise.all([getKlines("BTC-SWAP-USDT","1h",100), getKlines("BTC-SWAP-USDT","4h",100)]);
    const a1 = analyzeTimeframe(h1), a4 = analyzeTimeframe(h4);
    return combineAnalysis(a1, a1, a4);
  } catch { return { direction:"خنثی", score:0, bull:0, bear:0 }; }
}

// ============================================================
// ANALYZE SYMBOL
// ============================================================
async function analyzeSymbol(item) {
  const symbol = item.symbol;
  try {
    const results = await Promise.allSettled([getKlines(symbol,"15m",100), getKlines(symbol,"1h",120), getKlines(symbol,"4h",120)]);
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled" || results[2].status !== "fulfilled") throw new Error("دریافت داده ناموفق.");
    const c15 = results[0].value, c1h = results[1].value, c4h = results[2].value;
    const a15 = analyzeTimeframe(c15), a1h = analyzeTimeframe(c1h), a4h = analyzeTimeframe(c4h);
    const combined = combineAnalysis(a15, a1h, a4h);
    return { ...item, symbol, price: a1h.price, analysis15: a15, analysis1h: a1h, analysis4h: a4h, ...combined };
  } catch (error) {
    return { ...item, symbol, failed: true, error: error.message };
  }
}

async function enrichDerivatives(results) {
  const top = results.filter(x => !x.failed && x.direction !== "خنثی").sort((a,b)=>b.score-a.score).slice(0, SHORTLIST_FOR_DERIVATIVES);
  await Promise.all(top.map(async item => {
    const [funding, openInterest, longShort] = await Promise.all([getFunding(item.symbol), getOpenInterest(item.symbol), getLongShort(item.symbol)]);
    item.funding = funding; item.openInterest = openInterest; item.longShort = longShort;
    if (funding != null) { if (item.direction === "خرید" && funding < 0.0003) item.score += 5; if (item.direction === "فروش" && funding > 0.0003) item.score += 5; }
    item.score = clamp(Math.round(item.score), 0, 100);
  }));
  return results;
}

async function runInBatches(items, batchSize, worker) {
  const output = [];
  for (let i=0; i<items.length; i+=batchSize) {
    const batch = items.slice(i, i+batchSize);
    const results = await Promise.all(batch.map(item => worker(item)));
    output.push(...results);
  }
  return output;
}

// ============================================================
// PAPER TRADE - IMPROVED (با فیلترهای جدید)
// ============================================================
function calculateTrade(result, btcContext) {
  if (!result || result.failed || result.direction === "خنثی") return null;
  
  // 1. فیلتر BTC Context (نصف شدن امتیاز)
  if (btcContext && btcContext.direction !== "خنثی" && btcContext.direction !== result.direction) {
    result.score *= 0.5;
  }
  
  // 2. فیلتر حجم (حداقل 1.2 برابر میانگین)
  if (result.analysis1h?.volumeRatio < 1.2) {
    return null;
  }
  
  // 3. غیرفعال کردن خرید (موقت)
  if (result.direction === "خرید") {
    return null;
  }
  
  const entry = result.price;
  const atrValue = result.analysis1h?.atr || entry * 0.01;
  
  // 4. حد ضرر 2.5x ATR
  const riskDistance = Math.max(atrValue * 2.5, entry * 0.005);
  
  let stop, tp1, tp2, tp3;
  if (result.direction === "خرید") {
    // این بخش فعلاً اجرا نمیشه چون خرید غیرفعاله
    stop = entry - riskDistance;
    tp1 = entry + riskDistance * 2.5;
    tp2 = entry + riskDistance * 4.0;
    tp3 = entry + riskDistance * 6.0;
  } else { // فروش
    stop = entry + riskDistance;
    tp1 = entry - riskDistance * 2.5;   // نسبت 1:2.5
    tp2 = entry - riskDistance * 4.0;
    tp3 = entry - riskDistance * 6.0;
  }
  
  const volatility = entry > 0 ? atrValue / entry : 0.01;
  let leverage = 3;
  if (volatility < 0.005) leverage = 5;
  else if (volatility < 0.01) leverage = 4;
  else if (volatility > 0.025) leverage = 2;
  
  // حجم پویا بر اساس امتیاز
  let positionMultiplier = 1;
  if (result.score >= 90) positionMultiplier = 2.5;
  else if (result.score >= 80) positionMultiplier = 2.0;
  else if (result.score >= 70) positionMultiplier = 1.5;
  
  const riskAmount = PAPER_BUDGET * (RISK_PERCENT / 100) * positionMultiplier;
  const stopPercent = Math.abs(entry - stop) / entry;
  const positionNotional = stopPercent > 0 ? riskAmount / stopPercent : PAPER_BUDGET * positionMultiplier;
  const margin = positionNotional / leverage;
  
  return {
    symbol: result.symbol,
    direction: result.direction,
    entry, stop, tp1, tp2, tp3,
    leverage,
    riskAmount,
    positionNotional,
    margin,
    score: result.score,
    rsi1h: safeNumber(result.analysis1h?.rsi),
    volumeRatio: safeNumber(result.analysis1h?.volumeRatio),
    structure15: result.analysis15?.structure,
    structure1h: result.analysis1h?.structure,
    structure4h: result.analysis4h?.structure,
    patterns: result.analysis15?.patterns || [],
    funding: result.funding ?? null,
    longShort: result.longShort ?? null,
    btcDirection: btcContext?.direction || null,
    createdAt: Date.now()
  };
}

// ============================================================
// KV HELPERS
// ============================================================
async function listAllKeys(env, prefix) {
  if (!env.ALGO_ESMAIL_KV) return [];
  const keys = [];
  let cursor = undefined;
  for (let page=0; page<10; page++) {
    const options = { prefix, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const result = await env.ALGO_ESMAIL_KV.list(options);
    keys.push(...result.keys);
    if (!result.list_complete) { cursor = result.cursor; if (!cursor) break; } else break;
  }
  return keys;
}

async function hasOpenTrade(symbol, env) {
  if (!env.ALGO_ESMAIL_KV) return false;
  const keys = await env.ALGO_ESMAIL_KV.list({ prefix: `trade:${symbol}:`, limit: 50 });
  for (const key of keys.keys) {
    try {
      const raw = await env.ALGO_ESMAIL_KV.get(key.name);
      if (!raw) continue;
      const trade = JSON.parse(raw);
      if (trade.status === "OPEN") {
        const ageHours = (Date.now() - safeNumber(trade.createdAt)) / 3600000;
        if (ageHours <= MAX_OPEN_TRADE_AGE_HOURS) return true;
      }
    } catch {}
  }
  return false;
}

async function getOpenTradesCount(env) {
  if (!env.ALGO_ESMAIL_KV) return 0;
  const keys = await listAllKeys(env, "trade:");
  let count = 0;
  for (const key of keys) {
    try {
      const raw = await env.ALGO_ESMAIL_KV.get(key.name);
      if (!raw) continue;
      const trade = JSON.parse(raw);
      if (trade.status === "OPEN") {
        const ageHours = (Date.now() - safeNumber(trade.createdAt)) / 3600000;
        if (ageHours <= MAX_OPEN_TRADE_AGE_HOURS) count++;
      }
    } catch {}
  }
  return count;
}

async function savePaperTrade(trade, env) {
  if (!env.ALGO_ESMAIL_KV || !trade) return false;
  const id = `trade:${trade.symbol}:${trade.createdAt}`;
  try {
    await env.ALGO_ESMAIL_KV.put(id, JSON.stringify({ id, ...trade, status:"OPEN", result:null, firstTarget:null, exitPrice:null, pnlUsdt:0, pnl:0, pnlPercent:0, closedAt:null, candleTime:null, updatedAt:Date.now() }));
    return true;
  } catch { return false; }
}

async function recordPaperTrades(results, btcContext, env) {
  if (!env.ALGO_ESMAIL_KV) return { saved:0, skipped:0 };
  const openCount = await getOpenTradesCount(env);
  if (openCount >= MAX_CONCURRENT_TRADES) return { saved:0, skipped:0 };
  const opportunities = results.filter(x => !x.failed && x.direction !== "خنثی" && x.score >= MIN_SIGNAL_SCORE).sort((a,b)=>b.score-a.score).slice(0, 5);
  let saved=0, skipped=0;
  for (const item of opportunities) {
    try {
      const exists = await hasOpenTrade(item.symbol, env);
      if (exists) { skipped++; continue; }
      const trade = calculateTrade(item, btcContext);
      if (!trade) { skipped++; continue; }
      const ok = await savePaperTrade(trade, env);
      if (ok) saved++;
      await sleep(50);
    } catch { skipped++; }
  }
  return { saved, skipped };
}

// ============================================================
// UPDATE OPEN PAPER TRADES (با خروج پله‌ای)
// ============================================================
async function updateOpenPaperTrades(env) {
  if (!env.ALGO_ESMAIL_KV) return { checked:0, closed:0, expired:0, ambiguous:0, closedTrades:[] };
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
  let checked=0, closed=0, expired=0, ambiguous=0;
  const closedTrades = [];
  const batches = [];
  for (let i=0; i<openTrades.length; i+=4) batches.push(openTrades.slice(i, i+4));
  
  for (const batch of batches) {
    await Promise.all(batch.map(async trade => {
      checked++;
      try {
        const createdAt = safeNumber(trade.createdAt);
        if (!createdAt) return;
        const now = Date.now();
        const ageHours = (now - createdAt) / 3600000;
        if (ageHours > MAX_OPEN_TRADE_AGE_HOURS) {
          const updated = { ...trade, status:"EXPIRED", result:"EXPIRED", firstTarget:"انقضای زمان", exitPrice:null, pnlUsdt:0, pnl:0, pnlPercent:0, closedAt:now, updatedAt:now };
          await env.ALGO_ESMAIL_KV.put(trade.id, JSON.stringify(updated));
          expired++; closedTrades.push(updated);
          return;
        }
        const entry = safeNumber(trade.entry), stop = safeNumber(trade.stop), tp1 = safeNumber(trade.tp1), tp2 = safeNumber(trade.tp2), tp3 = safeNumber(trade.tp3);
        if (!entry || !stop || !tp1) return;
        const intervalMs = 15*60*1000;
        const entryCandleStart = Math.floor(createdAt / intervalMs) * intervalMs;
        const candles = await getKlines(trade.symbol, "15m", PAPER_CHECK_CANDLES, entryCandleStart, now);
        if (!candles.length) return;
        const relevant = candles.filter(c => { const cs = safeNumber(c.time); return (cs + intervalMs) > createdAt; });
        if (!relevant.length) return;
        let result = null;
        let partials = { tp1Hit: false, tp2Hit: false, tp3Hit: false };
        let exitPrice = entry;
        let pnlPercent = 0;
        const positionSize = safeNumber(trade.positionNotional);
        let remainingSize = positionSize;
        for (const candle of relevant) {
          const high = safeNumber(candle.high), low = safeNumber(candle.low);
          if (trade.direction === "فروش") {
            if (high >= stop) {
              result = { status:"LOSS", firstTarget:"SL", exitPrice: stop };
              break;
            }
            if (low <= tp1 && !partials.tp1Hit) {
              partials.tp1Hit = true;
              const exitAmount = remainingSize * 0.5;
              remainingSize -= exitAmount;
              pnlPercent += ((entry - tp1) / entry) * 100 * (exitAmount / positionSize);
              exitPrice = tp1;
            }
            if (low <= tp2 && !partials.tp2Hit && partials.tp1Hit) {
              partials.tp2Hit = true;
              const exitAmount = remainingSize * 0.6;
              remainingSize -= exitAmount;
              pnlPercent += ((entry - tp2) / entry) * 100 * (exitAmount / positionSize);
              exitPrice = tp2;
            }
            if (low <= tp3 && !partials.tp3Hit && partials.tp2Hit) {
              partials.tp3Hit = true;
              const exitAmount = remainingSize;
              remainingSize -= exitAmount;
              pnlPercent += ((entry - tp3) / entry) * 100 * (exitAmount / positionSize);
              exitPrice = tp3;
              result = { status:"WIN", firstTarget:"TP3", exitPrice: tp3 };
              break;
            }
          } else { // خرید (فعلاً غیرفعاله ولی برای آینده)
            if (low <= stop) {
              result = { status:"LOSS", firstTarget:"SL", exitPrice: stop };
              break;
            }
            if (high >= tp1 && !partials.tp1Hit) {
              partials.tp1Hit = true;
              const exitAmount = remainingSize * 0.5;
              remainingSize -= exitAmount;
              pnlPercent += ((tp1 - entry) / entry) * 100 * (exitAmount / positionSize);
              exitPrice = tp1;
            }
            if (high >= tp2 && !partials.tp2Hit && partials.tp1Hit) {
              partials.tp2Hit = true;
              const exitAmount = remainingSize * 0.6;
              remainingSize -= exitAmount;
              pnlPercent += ((tp2 - entry) / entry) * 100 * (exitAmount / positionSize);
              exitPrice = tp2;
            }
            if (high >= tp3 && !partials.tp3Hit && partials.tp2Hit) {
              partials.tp3Hit = true;
              const exitAmount = remainingSize;
              remainingSize -= exitAmount;
              pnlPercent += ((tp3 - entry) / entry) * 100 * (exitAmount / positionSize);
              exitPrice = tp3;
              result = { status:"WIN", firstTarget:"TP3", exitPrice: tp3 };
              break;
            }
          }
        }
        if (!result) return;
        const pnlUsdt = (pnlPercent / 100) * positionSize;
        const updated = { ...trade, status: result.status, result: result.status, firstTarget: result.firstTarget, exitPrice: result.exitPrice, pnlUsdt: Number(pnlUsdt.toFixed(4)), pnl: Number(pnlUsdt.toFixed(4)), pnlPercent: Number(pnlPercent.toFixed(4)), closedAt: now, updatedAt: now };
        await env.ALGO_ESMAIL_KV.put(trade.id, JSON.stringify(updated));
        closed++;
        if (result.status === "AMBIGUOUS") ambiguous++;
        closedTrades.push(updated);
      } catch (error) {
        console.error("UPDATE TRADE ERROR:", trade?.symbol, error);
      }
    }));
  }
  return { checked, closed, expired, ambiguous, closedTrades };
}

// ============================================================
// NOTIFICATIONS & REPORTS
// ============================================================
function formatClosedTradeNotification(trade) {
  if (!trade) return "";
  let emoji = "⚪";
  if (trade.status === "WIN") emoji = "🟢";
  if (trade.status === "LOSS") emoji = "🔴";
  if (trade.status === "EXPIRED") emoji = "⏰";
  if (trade.status === "AMBIGUOUS") emoji = "⚪";
  const pnl = safeNumber(trade.pnlUsdt ?? trade.pnl);
  const pnlText = pnl > 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
  return `${emoji} *معامله آزمایشی بسته شد*\n\n🪙 ارز: *${trade.symbol}*\n📌 جهت: ${trade.direction}\n📊 امتیاز ورود: *${trade.score}/100*\n🎯 نتیجه: *${trade.result}*\n📍 دلیل: ${trade.firstTarget || "نامشخص"}\n💰 ورود: \`${formatNumber(trade.entry)}\`\n🚪 خروج: ${trade.exitPrice != null ? `\`${formatNumber(trade.exitPrice)}\`` : "نامشخص"}\n💵 سود/ضرر: *${pnlText} USDT*\n📈 درصد: ${safeNumber(trade.pnlPercent).toFixed(2)}%\n⏱ مدت: ${formatDuration(trade.createdAt, trade.closedAt)}`;
}

async function notifyClosedTrades(closedTrades, env) {
  if (!closedTrades?.length || !env.ALGO_ESMAIL_KV) return;
  const chats = await getSubscribedChats(env);
  if (!chats.length) return;
  for (const trade of closedTrades) {
    const message = formatClosedTradeNotification(trade);
    if (!message) continue;
    for (const chatId of chats) {
      try { await sendMessage(chatId, message, env, { parse_mode:"Markdown" }); } catch {}
      await sleep(50);
    }
  }
}

function formatOpportunity(item, btcContext) {
  const trade = calculateTrade(item, btcContext);
  if (!trade) return "";
  const patterns = item.analysis15?.patterns?.length ? item.analysis15.patterns.join("، ") : "الگوی خاصی دیده نشد";
  const funding = item.funding == null ? "نامشخص" : item.funding.toFixed(6);
  const ls = item.longShort == null ? "نامشخص" : item.longShort.toFixed(2);
  return `${directionEmoji(item.direction)} *${item.symbol}*\n📊 امتیاز: *${item.score}/100*\n💰 قیمت: \`${formatNumber(item.price)}\`\n📈 روند 4ساعته: ${item.analysis4h.structure}\n📊 روند 1ساعته: ${item.analysis1h.structure}\n📉 روند 15دقیقه: ${item.analysis15.structure}\nRSI 1H: ${item.analysis1h.rsi.toFixed(1)}\nحجم: ${item.analysis1h.volumeRatio.toFixed(2)} برابر میانگین\n🕯 الگو: ${patterns}\n🎯 ورود: \`${formatNumber(trade.entry)}\`\n🛑 حد ضرر: \`${formatNumber(trade.stop)}\`\n🥇 هدف 1: \`${formatNumber(trade.tp1)}\`\n🥈 هدف 2: \`${formatNumber(trade.tp2)}\`\n🥉 هدف 3: \`${formatNumber(trade.tp3)}\`\n⚙️ اهرم پیشنهادی: *${trade.leverage}x*\n💵 سرمایه: ${PAPER_BUDGET} USDT\n💸 ریسک: ${RISK_PERCENT}%\n💰 Funding: ${funding}\n👥 نسبت لانگ/شورت: ${ls}\n🧭 وضعیت BTC: ${btcContext.direction}`;
}

function buildScanReport(results, btcContext, elapsedMs, paperInfo = {}, tradeUpdate = {}) {
  const valid = results.filter(x=>!x.failed);
  const opportunities = valid.filter(x => x.direction !== "خنثی" && x.score >= MIN_SIGNAL_SCORE).sort((a,b)=>b.score-a.score).slice(0,5);
  const failed = results.filter(x=>x.failed);
  let text = `🤖 *ALGO FJM V6.0*\n✅ اسکن کامل شد.\n⏱ زمان: ${(elapsedMs/1000).toFixed(1)} ثانیه\n🔎 ارزهای بررسی‌شده: ${results.length}\n✅ موفق: ${valid.length}\n❌ ناموفق: ${failed.length}\n🧭 BTC: *${btcContext.direction}*\n━━━━━━━━━━━━━━━━━━\n📝 معاملات جدید: *${paperInfo.saved||0}*\n🔄 تکراری: ${paperInfo.skipped||0}\n━━━━━━━━━━━━━━━━━━\n📋 بررسی معاملات قبلی:\n🔎 بررسی: ${tradeUpdate.checked||0}\n🟢 بسته: ${tradeUpdate.closed||0}\n⚪ مبهم: ${tradeUpdate.ambiguous||0}\n⏰ منقضی: ${tradeUpdate.expired||0}\n━━━━━━━━━━━━━━━━━━\n`;
  if (!opportunities.length) {
    text += `⚪ فرصت قدرتمند پیدا نشد.\nامتیاز حداقل: ${MIN_SIGNAL_SCORE}/100`;
  } else {
    text += `🔥 *فرصت‌های برتر*\n`;
    for (const item of opportunities) {
      text += formatOpportunity(item, btcContext) + "\n━━━━━━━━━━━━━━━━━━\n";
    }
  }
  return text;
}

// ============================================================
// SUBSCRIPTION
// ============================================================
async function subscribe(chatId, env) {
  if (!env.ALGO_ESMAIL_KV) throw new Error("KV not available.");
  await env.ALGO_ESMAIL_KV.put(`chat:${chatId}`, JSON.stringify({ chatId, createdAt: Date.now() }));
}
async function unsubscribe(chatId, env) {
  if (!env.ALGO_ESMAIL_KV) throw new Error("KV not available.");
  await env.ALGO_ESMAIL_KV.delete(`chat:${chatId}`);
}
async function getSubscribedChats(env) {
  if (!env.ALGO_ESMAIL_KV) return [];
  const list = await env.ALGO_ESMAIL_KV.list({ prefix:"chat:", limit:100 });
  return list.keys.map(x => x.name.replace("chat:", ""));
}

// ============================================================
// STATS
// ============================================================
async function resetStats(env) {
  if (!env.ALGO_ESMAIL_KV) return { deleted:0 };
  const keys = await listAllKeys(env, "trade:");
  let deleted=0;
  for (const key of keys) {
    try { await env.ALGO_ESMAIL_KV.delete(key.name); deleted++; } catch {}
  }
  return { deleted };
}

async function getStats(env) {
  if (!env.ALGO_ESMAIL_KV) return "❌ KV متصل نیست.";
  const tradeUpdate = await updateOpenPaperTrades(env);
  if (tradeUpdate.closedTrades?.length) await notifyClosedTrades(tradeUpdate.closedTrades, env);
  const keys = await listAllKeys(env, "trade:");
  let total=0, open=0, wins=0, losses=0, ambiguous=0, expired=0, pnl=0, totalWinPnl=0, totalLossPnl=0;
  let highScoreTotal=0, highScoreWins=0, midScoreTotal=0, midScoreWins=0;
  for (const key of keys) {
    try {
      const raw = await env.ALGO_ESMAIL_KV.get(key.name);
      if (!raw) continue;
      const trade = JSON.parse(raw);
      total++;
      const status = trade.status;
      if (status === "OPEN") open++;
      if (status === "WIN") { wins++; const v = safeNumber(trade.pnlUsdt??trade.pnl); pnl += v; totalWinPnl += v; }
      if (status === "LOSS") { losses++; const v = safeNumber(trade.pnlUsdt??trade.pnl); pnl += v; totalLossPnl += v; }
      if (status === "AMBIGUOUS") ambiguous++;
      if (status === "EXPIRED") expired++;
      const score = safeNumber(trade.score);
      if (score >= 90) { highScoreTotal++; if (status === "WIN") highScoreWins++; }
      if (score >= 80 && score < 90) { midScoreTotal++; if (status === "WIN") midScoreWins++; }
    } catch {}
  }
  const closed = wins + losses;
  const winRate = closed > 0 ? (wins/closed)*100 : 0;
  const highScoreRate = highScoreTotal > 0 ? (highScoreWins/highScoreTotal)*100 : 0;
  const midScoreRate = midScoreTotal > 0 ? (midScoreWins/midScoreTotal)*100 : 0;
  return `📊 *آمار معاملات آزمایشی ALGO FJM V6.0*\nکل معاملات: *${total}*\n🟡 باز: ${open}\n🟢 برد: ${wins}\n🔴 باخت: ${losses}\n⚪ مبهم: ${ambiguous}\n⏰ منقضی: ${expired}\n📈 بسته: ${closed}\n🎯 نرخ برد: *${winRate.toFixed(1)}%*\n💰 سود/زیان: *${pnl.toFixed(2)} USDT*\n🟢 مجموع سود: ${totalWinPnl.toFixed(2)} USDT\n🔴 مجموع ضرر: ${totalLossPnl.toFixed(2)} USDT\n━━━━━━━━━━━━━━━━━━\n📊 امتیاز 90+: ${highScoreWins}/${highScoreTotal} (${highScoreRate.toFixed(1)}%)\n📊 امتیاز 80-89: ${midScoreWins}/${midScoreTotal} (${midScoreRate.toFixed(1)}%)\n━━━━━━━━━━━━━━━━━━\n🔄 آخرین بررسی: ${tradeUpdate.checked||0} معامله\n🟢 بسته: ${tradeUpdate.closed||0}\n⚪ مبهم: ${tradeUpdate.ambiguous||0}\n⏰ منقضی: ${tradeUpdate.expired||0}\n━━━━━━━━━━━━━━━━━━\n💵 سرمایه: ${PAPER_BUDGET} USDT\n⚠️ Paper Trade فقط.`;
}

// ============================================================
// SCAN
// ============================================================
async function performScan(env) {
  const started = Date.now();
  try {
    const symbols = await getBestSymbols();
    if (!symbols.length) throw new Error("هیچ ارزی دریافت نشد.");
    const btcPromise = getBTCContext();
    const results = await runInBatches(symbols, ANALYSIS_BATCH, analyzeSymbol);
    const btcContext = await btcPromise;
    const enriched = await enrichDerivatives(results);
    return { results: enriched, btcContext, elapsed: Date.now() - started };
  } catch (error) { throw error; }
}

// ============================================================
// HELP
// ============================================================
function helpText() {
  return `🤖 *ALGO FJM V6.0*\n\n/scan 🔎 اسکن بازار\n/signal BTC 📊 تحلیل ارز\n/subscribe 🔔 گزارش خودکار\n/unsubscribe 🔕 لغو اشتراک\n/stats 📊 آمار\n/paper 📝 معاملات باز\n/history 📚 تاریخچه\n/history 20 📚 ۲۰ معامله\n/diagnostics 🔬 تحلیل تشخیصی\n/resetstats 🧹 پاک کردن آمار\n/health 🩺 وضعیت ربات\n/help 📚 راهنما\n━━━━━━━━━━━━━━━━━━\n⚠️ فقط Paper Trade.`;
}

// ============================================================
// HEALTH
// ============================================================
async function healthText(env) {
  let kvStatus = "❌";
  if (env.ALGO_ESMAIL_KV) { try { await env.ALGO_ESMAIL_KV.put("health:last", String(Date.now()), { expirationTtl:300 }); kvStatus = "✅"; } catch {} }
  const botStatus = env.BOT_TOKEN ? "✅" : "❌";
  let toobitStatus = "❌";
  try { const res = await fetch(`${BASE_URL}/api/v1/exchangeInfo`); if (res.ok) toobitStatus = "✅"; } catch {}
  return `🩺 *وضعیت ALGO FJM V6.0*\nTelegram: ${botStatus}\nKV: ${kvStatus}\nToobit: ${toobitStatus}\nنسخه: V6.0\nحداقل امتیاز: ${MIN_SIGNAL_SCORE}\nمعاملات واقعی: ❌ خاموش\nحداکثر معامله همزمان: ${MAX_CONCURRENT_TRADES}\nحد ضرر: 2.5x ATR\nنسبت ریسک: 1:2.5\nفیلتر حجم: ≥1.2x`;
}

// ============================================================
// DASHBOARD API
// ============================================================
async function handleDashboardAPI(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  
  if (path === "/api/status" && request.method === "GET") {
    try {
      const keys = await listAllKeys(env, "trade:");
      let total=0, open=0, wins=0, losses=0, pnl=0;
      for (const key of keys) {
        try {
          const raw = await env.ALGO_ESMAIL_KV.get(key.name);
          if (!raw) continue;
          const trade = JSON.parse(raw);
          total++;
          if (trade.status === "OPEN") open++;
          if (trade.status === "WIN") { wins++; pnl += safeNumber(trade.pnlUsdt??trade.pnl); }
          if (trade.status === "LOSS") { losses++; pnl += safeNumber(trade.pnlUsdt??trade.pnl); }
        } catch {}
      }
      const closed = wins + losses;
      const winRate = closed > 0 ? (wins/closed)*100 : 0;
      return new Response(JSON.stringify({
        total, open, wins, losses, pnl: Number(pnl.toFixed(2)),
        winRate: Number(winRate.toFixed(1)),
        budget: PAPER_BUDGET,
        maxConcurrent: MAX_CONCURRENT_TRADES,
        status: "running",
        version: "V6.0"
      }), { headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
  }
  
  if (path === "/api/trades" && request.method === "GET") {
    try {
      const urlParams = new URLSearchParams(url.search);
      const status = urlParams.get("status") || "all";
      const limit = parseInt(urlParams.get("limit") || "50");
      const keys = await listAllKeys(env, "trade:");
      const trades = [];
      for (const key of keys) {
        try {
          const raw = await env.ALGO_ESMAIL_KV.get(key.name);
          if (!raw) continue;
          const trade = JSON.parse(raw);
          if (status !== "all" && trade.status !== status) continue;
          trades.push(trade);
        } catch {}
      }
      trades.sort((a,b) => (safeNumber(b.closedAt??b.createdAt) - safeNumber(a.closedAt??a.createdAt)));
      const limited = trades.slice(0, limit);
      return new Response(JSON.stringify(limited), { headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
  }
  
  if (path === "/api/kill" && request.method === "POST") {
    try {
      const keys = await listAllKeys(env, "trade:");
      let killed = 0;
      for (const key of keys) {
        try {
          const raw = await env.ALGO_ESMAIL_KV.get(key.name);
          if (!raw) continue;
          const trade = JSON.parse(raw);
          if (trade.status === "OPEN") {
            const updated = { ...trade, status:"EXPIRED", result:"KILLED", firstTarget:"KILL SWITCH", exitPrice:null, pnlUsdt:0, pnl:0, pnlPercent:0, closedAt:Date.now(), updatedAt:Date.now() };
            await env.ALGO_ESMAIL_KV.put(key.name, JSON.stringify(updated));
            killed++;
          }
        } catch {}
      }
      return new Response(JSON.stringify({ message: `KILL SWITCH activated. ${killed} trades killed.` }), { headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
  }
  
  if (path === "/api/settings" && request.method === "POST") {
    try {
      const body = await request.json();
      if (env.ALGO_ESMAIL_KV) {
        await env.ALGO_ESMAIL_KV.put("settings:current", JSON.stringify(body));
      }
      return new Response(JSON.stringify({ message: "Settings saved", settings: body }), { headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
  }
  
  return new Response("Not found", { status: 404, headers });
}

// ============================================================
// DASHBOARD HTML
// ============================================================
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="fa">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ALGO FJM V6.0 Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
    body { background: #0a0a1a; color: #e0e0ff; padding: 20px; min-height: 100vh; }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 28px; background: linear-gradient(135deg, #7c3aed, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
    .badge { background: #1e1b4b; padding: 4px 12px; border-radius: 20px; font-size: 14px; border: 1px solid #4c1d95; color: #a78bfa; -webkit-text-fill-color: #a78bfa; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #111128; border-radius: 16px; padding: 20px; border: 1px solid #2d2d5e; box-shadow: 0 4px 20px rgba(124,58,237,0.15); }
    .card .label { font-size: 13px; color: #8888bb; text-transform: uppercase; letter-spacing: 1px; }
    .card .value { font-size: 28px; font-weight: 700; margin-top: 8px; }
    .card .sub { font-size: 14px; color: #8888bb; margin-top: 4px; }
    .card.green .value { color: #4ade80; }
    .card.red .value { color: #f87171; }
    .card.blue .value { color: #60a5fa; }
    .card.purple .value { color: #a78bfa; }
    .card.gold .value { color: #fbbf24; }
    .btn { padding: 10px 24px; border: none; border-radius: 12px; font-weight: 600; cursor: pointer; transition: 0.2s; font-size: 14px; }
    .btn-danger { background: #dc2626; color: white; }
    .btn-danger:hover { background: #b91c1c; transform: scale(1.02); }
    .btn-primary { background: #7c3aed; color: white; }
    .btn-primary:hover { background: #6d28d9; transform: scale(1.02); }
    .btn-outline { background: transparent; border: 1px solid #4c1d95; color: #a78bfa; }
    .btn-outline:hover { background: #1e1b4b; }
    .section-title { font-size: 18px; margin: 24px 0 12px; color: #c4b5fd; border-bottom: 1px solid #2d2d5e; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; background: #111128; border-radius: 12px; overflow: hidden; }
    th { background: #1e1b4b; padding: 12px 16px; text-align: right; font-size: 13px; color: #8888bb; font-weight: 600; }
    td { padding: 12px 16px; border-bottom: 1px solid #1e1b4b; font-size: 14px; }
    .status-badge { padding: 2px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-win { background: #064e3b; color: #4ade80; }
    .status-loss { background: #4c0519; color: #f87171; }
    .status-open { background: #1e1b4b; color: #60a5fa; }
    .settings-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
    .settings-row label { color: #c4b5fd; font-size: 14px; }
    .settings-row input, .settings-row select { background: #1e1b4b; border: 1px solid #2d2d5e; color: white; padding: 8px 14px; border-radius: 8px; font-size: 14px; }
    .kill-btn { background: #dc2626; color: white; padding: 14px 32px; border: none; border-radius: 12px; font-size: 18px; font-weight: 700; cursor: pointer; transition: 0.2s; box-shadow: 0 0 30px rgba(220,38,38,0.3); }
    .kill-btn:hover { background: #b91c1c; transform: scale(1.05); box-shadow: 0 0 40px rgba(220,38,38,0.5); }
    .flex { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
    .mt-4 { margin-top: 16px; }
    .mb-4 { margin-bottom: 16px; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr 1fr; } .card .value { font-size: 22px; } }
  </style>
</head>
<body>
<div class="container">
  <h1>⚡ ALGO FJM V6.0 <span class="badge">DASHBOARD</span></h1>
  <div class="grid" id="statsGrid">
    <div class="card blue"><div class="label">موجودی</div><div class="value" id="budget">100</div><div class="sub">USDT</div></div>
    <div class="card purple"><div class="label">معاملات کل</div><div class="value" id="total">0</div><div class="sub">بسته + باز</div></div>
    <div class="card blue"><div class="label">باز</div><div class="value" id="open">0</div><div class="sub">معامله</div></div>
    <div class="card green"><div class="label">برد</div><div class="value" id="wins">0</div><div class="sub">نرخ برد: <span id="winRate">0</span>%</div></div>
    <div class="card red"><div class="label">باخت</div><div class="value" id="losses">0</div><div class="sub">ضرر کل</div></div>
    <div class="card gold"><div class="label">سود/زیان</div><div class="value" id="pnl">0</div><div class="sub">USDT</div></div>
  </div>
  <div class="flex mb-4">
    <button class="btn btn-primary" onclick="refreshData()">🔄 بروزرسانی</button>
    <button class="btn btn-danger" onclick="killSwitch()">🚨 KILL SWITCH</button>
  </div>
  <div class="section-title">📊 معاملات اخیر</div>
  <div style="overflow-x:auto;">
    <table>
      <thead><tr><th>ارز</th><th>جهت</th><th>نتیجه</th><th>سود</th><th>ورود</th><th>خروج</th><th>زمان</th></tr></thead>
      <tbody id="tradesBody">
        <tr><td colspan="7" style="text-align:center;color:#666;">در حال بارگذاری...</td></tr>
      </tbody>
    </table>
  </div>
  <div class="section-title">⚙️ تنظیمات سریع</div>
  <div class="settings-row">
    <label>حداکثر معامله همزمان:</label>
    <input type="number" id="maxConcurrent" value="2" min="1" max="5">
    <button class="btn btn-outline" onclick="saveSetting('maxConcurrent')">ذخیره</button>
  </div>
  <div class="settings-row">
    <label>حداقل امتیاز:</label>
    <input type="number" id="minScore" value="65" min="50" max="90">
    <button class="btn btn-outline" onclick="saveSetting('minScore')">ذخیره</button>
  </div>
  <div class="mt-4" style="color:#555;font-size:12px;">
    ⚠️ همه معاملات Paper Trade هستند. هیچ معامله واقعی انجام نمی‌شود.
  </div>
</div>
<script>
const API_BASE = window.location.origin;
async function fetchAPI(path, opts = {}) {
  const res = await fetch(API_BASE + path, opts);
  return res.json();
}
async function refreshData() {
  try {
    const status = await fetchAPI('/api/status');
    document.getElementById('budget').textContent = status.budget || 100;
    document.getElementById('total').textContent = (status.total || 0);
    document.getElementById('open').textContent = status.open || 0;
    document.getElementById('wins').textContent = status.wins || 0;
    document.getElementById('losses').textContent = status.losses || 0;
    document.getElementById('pnl').textContent = (status.pnl || 0).toFixed(2);
    document.getElementById('winRate').textContent = (status.winRate || 0).toFixed(1);
    const trades = await fetchAPI('/api/trades?limit=20');
    const tbody = document.getElementById('tradesBody');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#666;">هیچ معامله‌ای یافت نشد</td></tr>';
      return;
    }
    tbody.innerHTML = trades.map(t => {
      const statusClass = t.status === 'WIN' ? 'status-win' : t.status === 'LOSS' ? 'status-loss' : 'status-open';
      const pnl = (t.pnlUsdt || t.pnl || 0);
      const pnlStr = pnl > 0 ? '+' + pnl.toFixed(2) : pnl.toFixed(2);
      const dirEmoji = t.direction === 'خرید' ? '🟢' : t.direction === 'فروش' ? '🔴' : '⚪';
      return `<tr>
        <td>${t.symbol}</td>
        <td>${dirEmoji} ${t.direction}</td>
        <td><span class="status-badge ${statusClass}">${t.status}</span></td>
        <td style="color:${pnl>=0?'#4ade80':'#f87171'}">${pnlStr}</td>
        <td>${(t.entry||0).toFixed(4)}</td>
        <td>${t.exitPrice ? t.exitPrice.toFixed(4) : '—'}</td>
        <td>${new Date(t.createdAt).toLocaleTimeString('fa-IR')}</td>
      </tr>`;
    }).join('');
  } catch (e) { console.error('Refresh error:', e); }
}
async function killSwitch() {
  if (!confirm('⚠️ آیا مطمئنی؟ همه معاملات باز بسته می‌شوند!')) return;
  try {
    const res = await fetchAPI('/api/kill', { method: 'POST' });
    alert('✅ ' + (res.message || 'KILL SWITCH فعال شد.'));
    refreshData();
  } catch (e) { alert('❌ خطا: ' + e.message); }
}
async function saveSetting(key) {
  const value = document.getElementById(key === 'maxConcurrent' ? 'maxConcurrent' : 'minScore').value;
  try {
    await fetchAPI('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: parseInt(value) })
    });
    alert('✅ تنظیمات ذخیره شد.');
  } catch (e) { alert('❌ خطا: ' + e.message); }
}
setInterval(refreshData, 30000);
refreshData();
</script>
</body>
</html>`;
}

// ============================================================
// PROCESS TELEGRAM UPDATE
// ============================================================
async function processUpdate(update, env, ctx) {
  try {
    if (!update?.message) return;
    const message = update.message;
    const chatId = message.chat?.id;
    if (!chatId) return;
    const text = String(message.text || "").trim();
    if (!text) return;
    const command = text.split(/\s+/)[0].toLowerCase();
    
    if (command === "/start" || command === "/help") {
      await sendMessage(chatId, helpText(), env, { parse_mode:"Markdown" });
    }
    else if (command === "/health") {
      await sendMessage(chatId, await healthText(env), env, { parse_mode:"Markdown" });
    }
    else if (command === "/subscribe") {
      await subscribe(chatId, env);
      await sendMessage(chatId, "🔔 اشتراک فعال شد.", env);
    }
    else if (command === "/unsubscribe") {
      await unsubscribe(chatId, env);
      await sendMessage(chatId, "🔕 اشتراک لغو شد.", env);
    }
    else if (command === "/resetstats") {
      await sendMessage(chatId, "🧹 در حال پاک کردن آمار...", env);
      const result = await resetStats(env);
      await sendMessage(chatId, `✅ ${result.deleted} معامله حذف شد.`, env);
    }
    else if (command === "/stats") {
      const result = await getStats(env);
      await sendMessage(chatId, result, env, { parse_mode:"Markdown" });
    }
    else if (command === "/paper") {
      const openCount = await getOpenTradesCount(env);
      await sendMessage(chatId, `📝 معاملات باز: ${openCount}`, env);
    }
    else if (command === "/history") {
      await sendMessage(chatId, "📚 برای تاریخچه دقیق، لطفاً از داشبورد استفاده کنید.", env);
    }
    else if (command === "/diagnostics") {
      await sendMessage(chatId, "🔬 تحلیل تشخیصی: لطفاً از داشبورد استفاده کنید.", env);
    }
    else if (command === "/scan") {
      await sendMessage(chatId, "🔎 در حال اسکن بازار...", env);
      ctx.waitUntil((async () => {
        try {
          const tradeUpdate = await updateOpenPaperTrades(env);
          if (tradeUpdate.closedTrades?.length) await notifyClosedTrades(tradeUpdate.closedTrades, env);
          const scan = await performScan(env);
          const paperInfo = await recordPaperTrades(scan.results, scan.btcContext, env);
          const report = buildScanReport(scan.results, scan.btcContext, scan.elapsed, paperInfo, tradeUpdate);
          await sendMessage(chatId, report, env, { parse_mode:"Markdown" });
        } catch (error) {
          await sendMessage(chatId, `❌ اسکن ناموفق: ${error.message}`, env);
        }
      })());
    }
  } catch (error) {
    console.error("Process error:", error);
  }
}

// ============================================================
// SCHEDULED
// ============================================================
async function scheduledHandler(env) {
  try {
    const tradeUpdate = await updateOpenPaperTrades(env);
    if (tradeUpdate.closedTrades?.length) await notifyClosedTrades(tradeUpdate.closedTrades, env);
    const chats = await getSubscribedChats(env);
    if (!chats.length) return;
    const scan = await performScan(env);
    const paperInfo = await recordPaperTrades(scan.results, scan.btcContext, env);
    const report = buildScanReport(scan.results, scan.btcContext, scan.elapsed, paperInfo, tradeUpdate);
    for (const chatId of chats) {
      try { await sendMessage(chatId, report, env, { parse_mode:"Markdown" }); } catch {}
      await sleep(100);
    }
  } catch (error) { console.error("Scheduled error:", error); }
}

// ============================================================
// CLOUDFLARE WORKER EXPORT
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === "/" || path === "/dashboard") {
      return new Response(getDashboardHTML(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    
    if (path.startsWith("/api/")) {
      return handleDashboardAPI(request, env);
    }
    
    if (request.method === "POST") {
      try {
        const update = await request.json();
        ctx.waitUntil(processUpdate(update, env, ctx));
        return new Response("OK", { status: 200 });
      } catch (error) {
        return new Response("Bad Request", { status: 400 });
      }
    }
    
    return new Response("ALGO FJM V6.0 LIVE", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledHandler(env));
  }
};
