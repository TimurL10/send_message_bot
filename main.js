require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const input = require('input');
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const CryptoJS = require('crypto-js');
const crypto = require("crypto");
const axios = require('axios');
const KEY = "pPdvu2PwVJduFqdT86aCSWe5xuyqupWzI9pIUsz2hlMrzbOqLyjxLqcWlf3PJWele71Wfz7Yn2J8Iq1Mu0XA";
const SECRET = "RKfooVzmrETYz3S1V7Ard1ZbhCLHvO9cbCh1g1j6OF154wTGmthOArqmA6ElZEzAhEFrL49nFjahRfXgXA";
const HOST = "https://open-api.bingx.com";
const user_bot = require('./user_bot');

async function ocrImage(imagePath, langs = 'rus+eng') {
  // 2-й аргумент — количество потоков; опции можно передать 3-м аргументом
  const worker = await createWorker(langs, 1);
  try {
    const { data: { text } } = await worker.recognize(imagePath);
    return text;
  } finally {
    await worker.terminate();
  }
}



async function closeAllPositions() {
  const timestamp = Date.now();
  const recvWindow = 5000;

  // обязательные параметры
  const params = { timestamp, recvWindow };

  // формируем query строку
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // создаём подпись
  const signature = sign(query, SECRET);

  // полный URL с params + signature
  const url = `${HOST}/openApi/swap/v2/trade/closeAllPositions?${query}&signature=${signature}`;

  const headers = {
    "X-BX-APIKEY": KEY
  };

  try {
    const res = await axios.post(url, null, { headers });
    console.log("Ответ API:", res.data);
    return res.data;
  } catch (err) {
    console.error("Ошибка:", err.response?.data || err);
  }

  function sign(query, secret) {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}
}

function sign(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}

async function placeOrder(orderParams) {
    const timestamp = Date.now();

    // добавляем обязательные системные параметры
    const params = { ...orderParams, timestamp, recvWindow: 5000 };

    const query = sign(params, SECRET);
    const url = `${HOST}/openApi/swap/v2/trade/order/test?${query}`;

    const headers = { "X-BX-APIKEY": KEY };
    console.log(url)   
    const res = await axios.post(url, null, { headers });
    console.log(res.data);
    return res.data?.status;
}

async function cancelSpotOrder(params) {
  const url = "https://open-api.bingx.com/openApi/spot/v1/trade/cancelOrder";

  // добавляем timestamp
  params.timestamp = Date.now();

  // формируем query string
  const queryString = Object.entries(params)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // подпись
  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(queryString)
    .digest("hex");

  const fullUrl = `${url}?${queryString}&signature=${signature}`;

  try {
    const response = await axios.post(fullUrl, null, {
      headers: { "X-BX-APIKEY": API_KEY }
    });

    return response.data;
  } catch (err) {
    console.error("Cancel error:", err.response?.data || err);
    throw err;
  }
}

function parseNumber(str) {
  if (!str) return null;
  let s = String(str).trim().replace(/\s+/g, '');
  // 27,457.20 -> 27457.20
  if (s.includes('.') && s.includes(',')) {
    s = s.replace(/,/g, '');
  } else if (!s.includes('.') && s.includes(',')) {
    // 0,377 -> 0.377
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function buildPlaceOrderFromSignal(signal) {
  if (!signal.symbol || !signal.entry) {
    throw new Error("Не удалось определить symbol или entry из сигнала");
  }

  return {
    symbol: signal.symbol,
    side: signal.side,               // BUY или SELL
    positionSide: signal.positionSide, // LONG или SHORT
    type: "LIMIT",
    price: signal.entry,
    // quantity ты решаешь сам — либо фиксированная,
    // либо на основе signal.allocated, плеча и т.п.
    // тут поставлю заглушку:
    quantity: "100",
    marginType: "CROSSED",
    timeInForce: "GTC",
    takeProfit: signal.takeProfits[0] || undefined,
    stopLoss: signal.stopLoss || undefined,
    clientOrderId: `signal_${Date.now()}`
  };
}


function parseSignalText1(text) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const result = {
    raw: text,
    symbol: null,
    side: null,
    positionSide: null,
    entry: null,
    takeProfits: [],
    stopLoss: null,
    bank: null,
    allocated: null,
    quantity: null
  };

  // ============================================================
  // 1. SYMBOL + LONG/SHORT
  // Ищем любые пары: BTC/USDT, POPCAT/USDC и т.п.
  // ============================================================

  const pairLine = lines.find(l => /[A-Z0-9]+\/(USDT|USDC)/i.test(l));
  if (pairLine) {
    const m = pairLine.match(/([A-Z0-9]+)\/(USDT|USDC)\s+(LONG|SHORT)/i);
    if (m) {
      const base = m[1].toUpperCase();
      const quote = m[2].toUpperCase();
      const dir = m[3].toUpperCase();

      result.symbol = `${base}-${quote}`;
      result.positionSide = dir;
      result.side = dir === 'LONG' ? 'BUY' : 'SELL';
    }
  }

  // ============================================================
  // 2. ENTRY (точка входа)
  // ============================================================

  const entryLine = lines.find(l => /входа|entry/i.test(l));
  if (entryLine) {
    const cleaned = entryLine.replace(/[.,]$/g, "");
    const m = cleaned.match(/[-–]\s*([\d.,]+)[^\d]*$/);
    if (m) {
      result.entry = parseNumber(m[1])?.toString();
    }
  }

  // ============================================================
  // 3. STOP LOSS
  // ============================================================

  const slLine = lines.find(l => /стоп|stop/i.test(l));
  if (slLine) {
    const cleaned = slLine.replace(/[.,]$/g, "");
    const m = cleaned.match(/[-–]\s*([\d.,]+)[^\d]*$/);
    if (m) {
      result.stopLoss = parseNumber(m[1])?.toString();
    }
  }

   // ---------- TAKE PROFITS ----------
  // 1) сначала пробуем найти строку со словом "Тейки"/"Тейк"
  let tpLine = lines.find(l => /Тейки|Тейк|Teuku/i.test(l));

  // 2) если OCR превратил "Тейки" в "Teuku" и т.п. — делаем fallback:
  // ищем любую строку, где есть >= 2 чисел, но это не "Точка входа", не "Стоп", не "Банк" и т.д.
  if (!tpLine) {
    tpLine = lines.find(l => {
      const lower = l.toLowerCase();

      // отфильтровываем строки, где точно не тейки
      if (
        lower.includes('точка входа') ||
        lower.includes('стоп') ||
        lower.includes('банк') ||
        lower.includes('марафона') ||
        lower.includes('позицию') ||
        lower.includes('маржа') ||
        lower.includes('риск') ||
        lower.includes('%')
      ) {
        return false;
      }

      const nums = l.match(/[\d.,]+/g); // все блоки из цифр/точек/запятых
      return nums && nums.length >= 2;  // минимум 2 числа = похоже на линию с тейками
    });
  }

  if (tpLine) {
    if (tpLine.endsWith(".")) {
      tpLine = tpLine.slice(0, -1);
    }
    const nums = tpLine.match(/[\d.,]+/g) || [];
    
    result.takeProfits = nums
      .map(parseNumber)
      .filter(v => v !=null)
      .map(v => v.toString());

    console.log(result.takeProfits)

  }

  // ============================================================
  // 5. BANK (не обязательно)
  // ============================================================

  const bankLine = lines.find(l => /банк марафон/i.test(l));
  if (bankLine) {
    const m = bankLine.match(/[:\-]\s*([\d.,]+)/);
    if (m) result.bank = parseNumber(m[1])?.toString();
  }

  // ============================================================
  // 6. ALLOCATED (Сколько вложил в позицию)
  // ============================================================

  const allocLine = lines.find(l => /позицию выделил/i.test(l));
  if (allocLine) {
    const m = allocLine.match(/[:\-]\s*([\d.,]+)/);
    if (m) result.allocated = parseNumber(m[1])?.toString();
  }

    // ============================================================
  // 7. QUANTITY — объём позиции из блока "Позиция ... Маржа ... Риск"
  // ============================================================
  // 1) сначала ищем строку, где есть слово "Позиция"
  let posIndex = lines.findIndex(l => /позиция/i.test(l));

  // если нашли "Позиция", предполагаем, что следующая строка — с цифрами
  if (posIndex >= 0 && posIndex + 1 < lines.length) {
    const nums = lines[posIndex + 1].match(/[\d.,]+/g);
    if (nums && nums.length > 0) {
      result.quantity = parseNumber(nums[0])?.toString(); // первое число = позиция
    }
  }

  // 2) fallback: если по слову "Позиция" не нашли, ищем строку с 3 числами и знаком %
  if (!result.quantity) {
    const posLine = lines.find(l => {
      const nums = l.match(/[\d.,]+/g);
      return /%/.test(l) && nums && nums.length >= 3;
    });

    if (posLine) {
      const nums = posLine.match(/[\d.,]+/g);
      if (nums && nums.length > 0) {
        result.quantity = parseNumber(nums[0])?.toString();
      }
    }
  }

  return result;
}

/**
 * Строит payload для ордера ВХОДА в позицию.
 * signal — то, что вернул parseSignalText1(text).
 * options — доп. настройки, например type: 'MARKET' или leverage.
 */
async function buildEntryOrderFromSignal(signal, options = {}) {
  const {
    symbol,
    side,
    positionSide,
    entry,
    quantity,
  } = signal;

  if (!symbol || !side || !positionSide || !entry || !quantity) {
    throw new Error('Для входа не хватает данных в signal');
  }

  const order = {
    symbol,                  // 'ENA-USDT'
    side,                    // 'BUY' (если LONG) или 'SELL' (если SHORT)
    positionSide,            // 'LONG' или 'SHORT'
    type: options.type || 'LIMIT',   // 'LIMIT' или 'MARKET'
    quantity: quantity.toString(),   // общий объём
    timeInForce: 'GTC',      // пока не исполнится (для LIMIT)
    clientOrderId: options.clientOrderId || `ENTRY_${Date.now()}`,
  };

  if (order.type === 'LIMIT') {
    order.price = entry.toString();  // точка входа
  }

  // Если хочешь — можешь подставить сюда плечо и тип маржи:
  if (options.leverage) order.leverage = String(options.leverage);
  if (options.marginType) order.marginType = options.marginType; // 'CROSSED' / 'ISOLATED'

  return order;
}

/**
 * Строит массив из 1–3 ордеров на тейк-профит.
 * Каждый ордер частично закрывает позицию.
 */
async function buildTakeProfitOrdersFromSignal(signal, options = {}) {
  const { symbol, positionSide, takeProfits, quantity } = signal;

  if (!symbol || !positionSide || !takeProfits || takeProfits.length === 0 || !quantity) {
    return []; // нет тейков или количества — нет ордеров
  }

  // Сайд для закрытия:
  // LONG закрываем через SELL,
  // SHORT закрываем через BUY.
  const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

  // Берём максимум 3 тейка (если их больше — можно расширить логику)
  const tps = takeProfits.slice(0, 3);
  const [q1, q2, q3] = splitQtyForTps(quantity);

  const qtyForTp = [q1, q2, q3].slice(0, tps.length);

  const orders = tps.map((tpPrice, idx) => ({
    symbol,
    side: closeSide,
    positionSide,
    type: 'LIMIT',
    price: tpPrice.toString(),
    quantity: qtyForTp[idx].toString(),
    timeInForce: 'GTC',
    reduceOnly: true, // важно: чтобы ордер только уменьшал позицию, а не открывал новую
    clientOrderId: `TP${idx + 1}_${Date.now()}`,
  }));

  return orders;
}

function splitQtyForTps(totalQty) {
  const q = Number(totalQty);
  if (!Number.isFinite(q) || q <= 0) {
    throw new Error('Некорректный quantity в signal.quantity');
  }

  // 1-й тейк — 50%, остальные два — по 25%
  const tp1 = Math.floor(q * 0.5 * 100) / 100;  // округляем до 2 знаков
  const tp2 = Math.floor(q * 0.25 * 100) / 100;
  let tp3 = q - tp1 - tp2;                      // остаток, чтобы сумма = q
  tp3 = Math.round(tp3 * 100) / 100;

  return [tp1, tp2, tp3];
}

/**
 * Строит ордер стоп-лосс для полной позиции.
 * Обычно это STOP_MARKET / STOP, срабатывает по цене stopLoss.
 */
function buildStopLossOrderFromSignal(signal, options = {}) {
  const { symbol, positionSide, stopLoss, quantity } = signal;
  if (!symbol || !positionSide || !stopLoss || !quantity) {
    return null;
  }

  const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

  const order = {
    symbol,
    side: closeSide,
    positionSide,
    type: options.type || 'STOP_MARKET', // зависит от того, как именно BingX ждёт SL
    stopPrice: stopLoss.toString(),      // цена стопа
    quantity: quantity.toString(),       // закрываем весь объём
    reduceOnly: true,
    clientOrderId: options.clientOrderId || `SL_${Date.now()}`,
    workingType: options.workingType || 'MARK_PRICE', // часто биржи используют MARK_PRICE / LAST_PRICE
  };

  return order;
}

async function getOpenSpotOrders(symbol) {
  try {
    const params = {
      symbol,
      timestamp: Date.now(),
    };

    const signedQuery = signQuery(params);

    const url = `${HOST}/openApi/spot/v1/trade/openOrders?${signedQuery}`;

    const res = await axios.get(url, {
      headers: {
        "X-BX-APIKEY": KEY
      }
    });

    if (!res.data.data || res.data.data.length === 0) {
      console.log("Нет открытых ордеров.");
      return [];
    }

    console.log("Открытые ордера:");
    console.log(res.data.data);

    return res.data.data;

  } catch (err) {
    console.error("Ошибка:", err.response?.data || err.message);
    return null;
  }

  function signQuery(params) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(query)
    .digest("hex");

  return `${query}&signature=${signature}`;
}

}


/* ============ MAIN ============ */
(async () => {
try {
    const apiId = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    const stringSession = process.env.TG_STRING_SESSION || '';

    console.log(new Date().toISOString(), 'старт');    

   
   const orderParams = {
    symbol: "BTC-USDT",
    side: "BUY",
    type: "LIMIT",
    price: "10000",
    quantity: "0.0001",
    timeInForce: "GTC"
  };
   
    
    
    let arr_downloaded_files = await user_bot.download_media_from_chanel();   
    
    
    for (let file of arr_downloaded_files) {
      //await new Promise (r => setTimeout(r, 1_000));
      const img = path.resolve(`./pict/${file}`);
      const text = await ocrImage(img);
      console.log('Распознанный текст:\n', text);

      const signal = parseSignalText1(text);
      const orderPayload = buildPlaceOrderFromSignal(signal);
      console.log(signal);
      console.log(orderPayload); 

      //await placeOrder(orderPayload);      

      let first_order =  await buildEntryOrderFromSignal(signal, options = {});
      let order_status = await placeOrder(first_order);
      //if (order_status == 'FILLED') {
      let takes_orders = await buildTakeProfitOrdersFromSignal(signal, options = {});
      for (let order of takes_orders) {
        let order_status = await placeOrder(order);
        console.log(order_status);
      }

      let stop_loss_order = buildStopLossOrderFromSignal (signal, options = {});
      order_status = await placeOrder(stop_loss_order);
      console.log(order_status);      

    }   

      console.log(new Date().toISOString(), 'финиш программы'); 
      process.exit(1);

  } catch (e) {
        console.error('Ошибка:', e);
    }
})();
