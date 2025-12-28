const HOST = "https://open-api.bingx.com";
const WS_URL = "wss://open-api-swap.bingx.com/swap-market ";
const crypto = require("crypto");
require('dotenv').config();
const axios = require('axios');
const WebSocket = require("ws");
let KEY;
let SECRET;
let ws;

async function init() {
    KEY = process.env.KEY;
    SECRET = process.env.SECRET;
}

// подписаться на обновление ордеров
async function subscribeOrderUpdates(onOrderFilled) {

  function sign(message) {
    return crypto.createHmac("sha256", SECRET).update(message).digest("hex");
  }

  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("WS Connected to BingX");

    const timestamp = Date.now().toString();
    const signature = sign(timestamp + KEY);

    // Авторизация
    ws.send(JSON.stringify({
      op: "auth",
      args: {
        apiKey: KEY,
        timestamp,
        signature
      }
    }));

    // Подписка на ордера
    ws.send(JSON.stringify({
      op: "subscribe",
      args: ["order"]
    }));
  });

  ws.on("message", raw => {
    const data = JSON.parse(raw);

    // фильтруем только ордер-ивенты
    if (data.e !== "order") return;

    const event = data.data; 

    // если ордер исполнен
    if (event.status === "FILLED") {
      console.log("ORDER FILLED:", event.orderId);

      // вызываем callback
      if (onOrderFilled) onOrderFilled(event);
    }
  });

  ws.on("close", () => {
    console.log("WS Closed, reconnecting...");
    setTimeout(() => subscribeOrderUpdates(onOrderFilled), 2000);
  });

  ws.on("error", (err) => {
    console.log("WS Error:", err.message);
  });
}


async function parseSignalText(text) {

  if (!text)
    return;  

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
  let startIndex = lines.findIndex(l => /Тейки|Тейк|Teuku/i.test(l));

  if (startIndex !== -1) {
    let tpText = lines[startIndex];

    let i = startIndex + 1;

    // пока НЕ встретили точку в конце блока
    while (
      !tpText.trim().endsWith('.') &&
      i < lines.length
    ) {
      tpText += ' ' + lines[i];
      i++;
    }

    const nums = tpText.match(/[\d.,]+/g) || [];    

    result.takeProfits = nums
      .map(parseNumber)
      .filter(v => v != null)
      .map(v => v.toString());

    console.log(result.takeProfits);
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

function parseNumber(str) {
  if (!str) return null;
  if (str) { if (str.endsWith(".")) { str = str.slice(0, -1); }}
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
    const url = `${HOST}/openApi/swap/v2/trade/order?${query}`;

    const headers = { "X-BX-APIKEY": KEY };
    console.log(url)   
    const res = await axios.post(url, null, { headers });
    console.log(res.data);
    return res.data.data.order;
}

async function buildMarketOrderFromSignal(signal) {
  if (!signal.symbol || !signal.entry) {
    throw new Error("Не удалось определить symbol или entry из сигнала");
  }

  return {
    symbol: signal.symbol,
    side: signal.side,               // BUY или SELL
    positionSide: signal.positionSide, // LONG или SHORT
    type: "MARKET",
    //price: signal.entry,
    // quantity ты решаешь сам — либо фиксированная,
    // либо на основе signal.allocated, плеча и т.п.
    // тут поставлю заглушку:
    quantity: "32",
    marginType: "CROSSED",
    timeInForce: "GTC",
    //takeProfit: signal.takeProfits[0] || undefined,
    //stopLoss: signal.stopLoss || undefined,
    clientOrderId: `signal_${Date.now()}`
  };
}

async function buildPlaceOrderFromSignal(signal) {
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
    quantity: "32",
    marginType: "CROSSED",
    timeInForce: "GTC",
    //takeProfit: signal.takeProfits[0] || undefined,
    //stopLoss: signal.stopLoss || undefined,
    clientOrderId: `signal_${Date.now()}`
  };
}

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
    side,       
    reduceOnly:false,             // 'BUY' (если LONG) или 'SELL' (если SHORT)
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

async function buildTakeProfitOrdersFromSignal(signal, options = {}) {
  signal.quantity = 32;
  let { symbol, positionSide, takeProfits, quantity } = signal;
  

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
    clientOrderId: `TP${idx + 1}_${Date.now()}`,
  }));

  return orders;
}


async function buildStopLossOrderFromSignal(signal, options = {}) {
  signal.quantity = 32;
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
    quantity: quantity.toString(),
    closePosition: true,        // закрываем весь объём
    clientOrderId: options.clientOrderId || `SL_${Date.now()}`,
    workingType: options.workingType || 'MARK_PRICE', // часто биржи используют MARK_PRICE / LAST_PRICE
  };

  return order;
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
  const url = `${HOST}/openApi/swap/v2/trade/closeAllPositions?${signature}`;

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
}

async function closeAllOpenOrders() {
  const timestamp = Date.now();
  const recvWindow = 5000;

  // обязательные параметры
  const params = { timestamp, recvWindow };

  // формируем query строку
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const signature = sign(query, SECRET);

  const url = `${HOST}/openApi/swap/v2/trade/allOpenOrders?${signature}`;

  const headers = {
    "X-BX-APIKEY": KEY
  };

  try {
    const res = await axios.delete(url, { headers });
    console.log("Ответ API:", res.data);
    return res.data.data;
  } catch (err) {
    console.error("Ошибка:", err.response?.data || err.message);
  }
}


async function getPublicIP() {
  try {
    const response = await axios.get("https://api.ipify.org?format=json");
    return response.data.ip;
  } catch (error) {
    console.error("Failed to get public IP:", error.message);
    throw error;
  }
}

async function canOpenOrder(symbol, price, quantity) {
  try {
    // 🔹 1. Получаем список контрактов — там minNotional
    const contracts = await axios.get(`${BASE}/openApi/swap/v2/quote/contracts`);

    const info = contracts.data.data.find((c) => c.symbol === symbol);
    if (!info) throw new Error(`Symbol ${symbol} not found`);

    const minNotional = parseFloat(info.minNotional); // минимум в USDT
    const notional = price * quantity; // стоимость позиции

    if (notional < minNotional) {
      return {
        ok: false,
        reason: `Position value ${notional.toFixed(
          2
        )} USDT < required minimum ${minNotional} USDT`,
      };
    }

    // 🔹 2. Проверяем баланс
    const timestamp = Date.now();
    const balanceParams = { timestamp };
    const signedBalance = sign(balanceParams);   

    const balance = await axios.get(
      `${HOST}/openApi/swap/v2/user/balance?${signedBalance}`,
      { headers: { "X-BX-APIKEY": KEY } }
    );

    const availableBalance = parseFloat(balance.data.data.availableBalance);

    if (availableBalance < notional / 10) {
      // /10 — если будешь ставить плечо 10х (как пример)
      return {
        ok: false,
        reason: `Insufficient balance. Need ~${(
          notional / 10
        ).toFixed(2)} USDT, have ${availableBalance} USDT`,
      };
    }

    return { ok: true, reason: "Can open order" };
  } catch (err) {
    console.log("Error:", err.response?.data || err.message);
    return { ok: false, reason: "Check failed" };
  }
}




module.exports = {
    parseSignalText,
    buildPlaceOrderFromSignal,
    buildEntryOrderFromSignal,
    buildMarketOrderFromSignal,
    placeOrder,
    buildTakeProfitOrdersFromSignal,
    buildStopLossOrderFromSignal,
    closeAllPositions,
    closeAllOpenOrders,
    getPublicIP,
    canOpenOrder,
    init,
    subscribeOrderUpdates
  }