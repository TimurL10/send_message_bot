require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const bot = new Telegraf(process.env.BOT_TOKEN);
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createWorker } = require("tesseract.js");
const api = require('./api_tools');


function getLastFile(dir) {
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir);
    if (files.length === 0) return null;

    const fullPaths = files.map(f => ({
        name: f,
        fullPath: path.join(dir, f),
        time: fs.statSync(path.join(dir, f)).mtime.getTime()   // время изменения файла
    }));

    // сортируем по времени (последний сверху)
    fullPaths.sort((a, b) => b.time - a.time);

    return fullPaths[0].fullPath;
}

async function ocrLastImage() {
    const dir = "./pict"; // твоя папка
    const lastImage = getLastFile(dir);

    if (!lastImage) {
        console.log("Нет файлов в папке");
        return null;
    }

    console.log("Последний файл:", lastImage);

    const text = await ocrImage(lastImage);
    return text;
}


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



async function downloadPhotos(ctx, outDir = "./pict", lastIdFile = "last_id.txt") {
    if (!ctx || !ctx.message || !ctx.message.photo) return [];

    // Создаём директорию, если её нет
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const msg = ctx.message;
    const msgId = msg.message_id;

    // Читаем last_id
    let lastId = 0;
    if (fs.existsSync(lastIdFile)) {
        lastId = parseInt(fs.readFileSync(lastIdFile, "utf-8").trim(), 10);
    }

    // Пропускаем старые фото
    if (msgId <= lastId) {
        return [];
    }

    // Берём самое большое фото
    const photos = msg.photo;
    const best = photos[photos.length - 1];

    // Получаем ссылку
    const fileLink = await ctx.telegram.getFileLink(best.file_id);

    // Определяем расширение по mime_type
    let ext = "jpg";
    if (best.mime_type) {
        const mime = best.mime_type.toLowerCase();
        if (mime.includes("png")) ext = "png";
        if (mime.includes("jpeg")) ext = "jpg";
        if (mime.includes("webp")) ext = "webp";
    }

    const fileName = `${msgId}.${ext}`;
    const savePath = path.join(outDir, fileName);

    // Скачиваем через axios
    const response = await axios.get(fileLink.href, { responseType: "arraybuffer" });
    fs.writeFileSync(savePath, response.data);

    // Обновляем last_id
    fs.writeFileSync(lastIdFile, String(msgId));

    return [fileName];
}


bot.on("photo", async (ctx) => {
    try {
        const files = await downloadPhotos(ctx);
        let text_from_jpg;
        if (files && files.length > 0) {
            await ctx.reply("Сохранено: " + files.join(", "));
            text_from_jpg = await ocrLastImage();
            
        } else {
            await ctx.reply("Фото старое или уже сохранено.");
        }

      const signal = await api.parseSignalText(text_from_jpg);
      const orderPayload = await api.buildPlaceOrderFromSignal(signal);
      console.log(signal);
      console.log(orderPayload); 

      let first_order =  await api.buildEntryOrderFromSignal(signal, options = {});
      let order_status = await api.placeOrder(first_order);
      await ctx.reply(JSON.stringify(order_status));

      let takes_orders = await api.buildTakeProfitOrdersFromSignal(signal, options = {});
      for (let order of takes_orders) {
        let order_status = await api.placeOrder(order);
        await ctx.reply(JSON.stringify(order_status));
      }

      let stop_loss_order = await api.buildStopLossOrderFromSignal (signal, options = {});
      order_status = await api.placeOrder(stop_loss_order);
      await ctx.reply(JSON.stringify(order_status));

      //if (order_status == 'FILLED') {




    } catch (e) {
        console.error("Ошибка в обработке фото:", e);
        await ctx.reply("❌ Ошибка при обработке фото.");
    }
});



// Меню
const menu = Markup.keyboard([
  ["🔵 Закрыть все позиции"],
  ["🟢 Закрыть все ордера"]
]).resize();

// /start
bot.start((ctx) => {
  ctx.reply("Привет! Выбери кнопку:", menu);  
});

// Кнопки
bot.hears("🔵 Закрыть все позиции", (ctx) => api.closeAllPositions().then((res) => {ctx.reply(res.code)}));
bot.hears("🟢 Закрыть все ордера", (ctx) => api.closeAllOpenOrders().then((res) => {ctx.reply(res.code)}));



async function main() {
    console.log("Запуск бота...");
    bot.launch();
    console.log("🤖 БОТ ЗАПУЩЕН!");
    let ip = await api.getPublicIP();
    console.log(ip);

    
}
main();
