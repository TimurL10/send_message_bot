require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const input = require("input");
const fs = require("fs");
const path = require("path");

// ==== ENV ====
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
let stringSession = process.env.TG_STRING_SESSION || "";

async function login() {
    console.log("Starting Telegram userbot...");

    const client = new TelegramClient(
        new StringSession(stringSession),
        apiId,
        apiHash,
        { connectionRetries: 5 }
    );

    if (stringSession) {
        await client.start({ onError: console.error });
        console.log("✔ Logged in using STRING_SESSION");
        return client;
    }

    // If there is no saved session → interactive login
    await client.start({
        phoneNumber: async () => await input.text("Enter phone number: "),
        password: async () => await input.text("Enter 2FA password: "),
        phoneCode: async () => await input.text("Enter code: "),
        onError: console.error,
    });

    console.log("🎉 Login successful!");
    console.log("🔑 YOUR STRING_SESSION (save to .env):");
    console.log(client.session.save());

    return client;
}

// ===================================
//        DOWNLOAD PHOTOS
// ===================================
async function downloadPhotos(client, entity, limit = 50, outDir = "./pict") {
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    let arr_downloaded_files = [];
    let saved = 0;
    const filter = new Api.InputMessagesFilterPhotos();

    for await (const msg of client.iterMessages(entity, { limit, filter, reverse: true,})) {
        if (!msg.photo) continue;

        // определяем расширение по MIME
        let ext = "jpg";
        if (msg.photo && msg.photo.mimeType) {
            const mime = msg.photo.mimeType.toLowerCase();
            if (mime.includes("png")) ext = "png";
            if (mime.includes("jpeg")) ext = "jpg";
            if (mime.includes("webp")) ext = "webp";
        }

        const fileName = `${msg.id}.${ext}`;
        const filePath = path.join(outDir, fileName);

        let lastId = 0;
        lastId = parseInt(fs.readFileSync("last_id.txt", "utf-8"), 10);

        if (msg.id <= lastId) continue;

        console.log(`⬇️ Скачиваю новое фото: ${fileName}`);
        await client.downloadMedia(msg, { outputFile: filePath });

        arr_downloaded_files.push(fileName);

        fs.writeFileSync("last_id.txt", msg.id.toString());

        console.log(`📥 Saved: ${filePath}`);
        saved++;
    }

    return arr_downloaded_files;
}


async function findChannel(client, searchPart) {
    searchPart = searchPart.toLowerCase();

    const dialogs = await client.getDialogs({});
    const matches = dialogs.filter(d => 
        d.entity && d.entity.title &&
        d.entity.title.toLowerCase().includes(searchPart)
    );

    if (matches.length === 0) {
        console.log("❌ Канал не найден");
        return null;
    }

    if (matches.length === 1) {
        console.log(`✔ Найден канал: ${matches[0].entity.title}`);
        return matches[0].entity;
    }

    // Если найдено несколько — выберем первый
    console.log("⚠ Найдено несколько каналов, беру первый:");
    matches.forEach((m, i) => console.log(`${i+1}. ${m.entity.title}`));

    return matches[0].entity;
}



async function download_media_from_chanel() {
    try {
        const client = await login();

        const searchName = "Биполярка"; // канал ("durov" или id)

        const channelEntity = await findChannel(client, searchName);

        if (!channelEntity) {
            console.log("Канал не найден");
            process.exit(1);
        }

        const images = await downloadPhotos(client,channelEntity, 50);  

        return images;
    }
    catch(e) {
        throw e;
    }
}  



module.exports = {
    download_media_from_chanel
}