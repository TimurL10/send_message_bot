const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const KEY = process.env.BINGX_KEY;
const SECRET = process.env.BINGX_SECRET;

const HOST = "https://open-api.bingx.com";

const bot = new Telegraf(BOT_TOKEN);

// ---- Подпись запроса ----
function sign(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}

// ---- Функция: закрыть все позиции ----
async function closeAllPositions() {
  const params = {
    timestamp: Date.now(),
    recvWindow: 5000
  };

  const query = sign(params, SECRET);
  const url = `${HOST}/openApi/cswap/v1/trade/closeAllPositions?${query}`;
  const headers = { "X-BX-APIKEY": KEY };

  const res = await axios.post(url, null, { headers });
  return res.data;
}

// ---- Функция: отменить все ордера ----
async function cancelAllOrders() {
  const params = {
    timestamp: Date.now(),
    recvWindow: 5000
  };

  const query = sign(params, SECRET);
  const url = `${HOST}/openApi/cswap/v1/trade/allOpenOrders?${query}`;
  const headers = { "X-BX-APIKEY": KEY };

  const res = await axios.post(url, null, { headers });
  return res.data;
}

// ---- Главное меню ----
const mainMenu = Markup.keyboard([
  ["❌ Закрыть все позиции"],
  ["🛑 Отменить все ордера"]
]).resize();

// ---- /start ----
bot.start((ctx) => {
  ctx.reply("Выберите действие:", mainMenu);
});

// ---- Обработка кнопок ----
bot.hears("❌ Закрыть все позиции", async (ctx) => {
  ctx.reply("⏳ Закрываю все позиции...");
  try {
    const res = await closeAllPositions();
    ctx.reply(`Ответ биржи:\n${JSON.stringify(res, null, 2)}`);
  } catch (err) {
    ctx.reply("Ошибка ❗\n" + err.message);
  }
});

bot.hears("🛑 Отменить все ордера", async (ctx) => {
  ctx.reply("⏳ Отменяю все ордера...");
  try {
    const res = await cancelAllOrders();
    ctx.reply(`Ответ биржи:\n${JSON.stringify(res, null, 2)}`);
  } catch (err) {
    ctx.reply("Ошибка ❗\n" + err.message);
  }
});

// ---- Команды в меню Telegram ----
bot.telegram.setMyCommands([
  { command: "start", description: "Запустить бот" },
  { command: "close", description: "Закрыть позиции" },
  { command: "cancel", description: "Отменить ордера" }
]);




async function downloadPhotos(ctx, limit = 50, outDir = "./pict") {
    if (!ctx || !ctx.telegram) throw new Error("ctx отсутствует — функцию нужно вызывать через бота");

    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    let arr_downloaded_files = [];

    const chatId = ctx.chat.id;

    // читаем last_id
    let lastId = 0;
    if (fs.existsSync("last_id.txt")) {
        lastId = parseInt(fs.readFileSync("last_id.txt", "utf-8"), 10);
    }

    // получаем новые сообщения
    const updates = await ctx.telegram.getChatHistory(chatId, {
        limit,
    });

    for (const msg of updates) {
        if (!msg.photo) continue;
        if (msg.message_id <= lastId) continue;

        const fileId = msg.photo[msg.photo.length - 1].file_id; // HD версия
        const link = await ctx.telegram.getFileLink(fileId);

        const ext = "jpg";
        const fileName = `${msg.message_id}.${ext}`;
        const filePath = path.join(outDir, fileName);

        const res = await fetch(link.href);
        const buffer = Buffer.from(await res.arrayBuffer());

        fs.writeFileSync(filePath, buffer);
        arr_downloaded_files.push(fileName);

        // записываем новый last id
        fs.writeFileSync("last_id.txt", msg.message_id.toString());
    }

    return arr_downloaded_files;
}

// --- Обработка команд внутри чат-бота (по желанию) ---
bot.command("sync", async (ctx) => {
    const names = await downloadPhotos(ctx);
    ctx.reply("Готово! Новые файлы:\n" + names.join("\n"));
});


async function main() {
  bot.launch();
  console.log("🤖 Bot started!");
}

main();

module.exports = { main,downloadPhotos };
