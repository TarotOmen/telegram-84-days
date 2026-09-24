import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "https://telegram-84-days.onrender.com";
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://telegram-84-days-api.onrender.com";

const hasDatabaseConfig =
  process.env.PGHOST &&
  process.env.PGPORT &&
  process.env.PGDATABASE &&
  process.env.PGUSER &&
  process.env.PGPASSWORD;

const pool = hasDatabaseConfig
  ? new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function initDb() {
  if (!pool) {
    console.log("PostgreSQL variables are not configured");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      paid BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("PostgreSQL connected");
}

function checkTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (
    calculatedHash.length !== hash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {
    return null;
  }

  const userRaw = params.get("user");

  if (!userRaw) return null;

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

async function telegramApi(method, body = {}) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const json = await response.json();

  if (!json.ok) {
    throw new Error(
      `Telegram API ${method}: ${json.description || "unknown error"}`
    );
  }

  return json;
}

async function configureTelegramBot() {
  if (!BOT_TOKEN) {
    console.log(
      "Telegram bot is not configured: BOT_TOKEN is missing"
    );
    return;
  }

  try {
    await telegramApi("setMyCommands", {
      commands: [
        {
          command: "start",
          description: "Открыть 84 Дня"
        }
      ]
    });

    await telegramApi("setWebhook", {
      url: `${API_PUBLIC_URL}/telegram/webhook`,
      allowed_updates: ["message"]
    });

    console.log(
      `Telegram bot configured. Mini App: ${WEBAPP_URL}`
    );
  } catch (error) {
    console.error(
      "Telegram bot configuration failed:",
      error
    );
  }
}

async function handleTelegramUpdate(update) {
  const message = update?.message;

  if (!message?.chat?.id) return;

  const text = String(message.text || "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,

      text:
        "12 недель к твоему лучшему будущему.\n" +
        "84 дня. Каждый день - твое движение к цели.",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Открыть 12 недель",
              web_app: {
                url: WEBAPP_URL
              }
            }
          ]
        ]
      }
    });

    return;
  }

  if (text === "/app") {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,

      text: "Открывай свой цикл:",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Открыть 12 недель",
              web_app: {
                url: WEBAPP_URL
              }
            }
          ]
        ]
      }
    });
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "84-days"
  });
});

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    await handleTelegramUpdate(req.body);
  } catch (error) {
    console.error(
      "Telegram update error:",
      error
    );
  }
});

app.post("/api/session", async (req, res) => {
  try {
    const telegramUser = checkTelegramInitData(
      req.body?.initData
    );

    if (!telegramUser) {
      return res.status(401).json({
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    if (!pool) {
      return res.json({
        ok: true,
        user: telegramUser,
        paid: false,
        state: {}
      });
    }

    const result = await pool.query(
      `
      INSERT INTO users (telegram_id)
      VALUES ($1)
      ON CONFLICT (telegram_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING telegram_id, state, paid
      `,
      [telegramUser.id]
    );

    const row = result.rows[0];

    res.json({
      ok: true,
      user: telegramUser,
      paid: row.paid,
      state: row.state || {}
    });
  } catch (error) {
    console.error(
      "Session error:",
      error
    );

    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

app.post("/api/state", async (req, res) => {
  try {
    const telegramUser = checkTelegramInitData(
      req.body?.initData
    );

    if (!telegramUser) {
      return res.status(401).json({
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    const state = req.body?.state || {};

    if (!pool) {
      return res.json({
        ok: true,
        paid: false
      });
    }

    await pool.query(
      `
      INSERT INTO users (telegram_id, state)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        state = $2::jsonb,
        updated_at = NOW()
      `,
      [
        telegramUser.id,
        JSON.stringify(state)
      ]
    );

    const result = await pool.query(
      `
      SELECT paid
      FROM users
      WHERE telegram_id = $1
      `,
      [telegramUser.id]
    );

    res.json({
      ok: true,
      paid: result.rows[0]?.paid === true
    });
  } catch (error) {
    console.error(
      "State error:",
      error
    );

    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

app.post(
  "/api/pay/tribute",
  async (req, res) =>
    res.json({
      ok: false,
      error: "Tribute payment is not connected yet"
    })
);

app.post(
  "/api/pay/stars",
  async (req, res) =>
    res.json({
      ok: false,
      error: "Telegram Stars payment is not connected yet"
    })
);

app.get("/", (req, res) =>
  res.send("84 Days backend is running")
);

async function start() {
  try {
    await initDb();

    app.listen(
      PORT,
      "0.0.0.0",
      async () => {
        console.log(
          `84 Days server started on port ${PORT}`
        );

        await configureTelegramBot();
      }
    );
  } catch (error) {
    console.error(
      "Startup failed:",
      error
    );

    process.exit(1);
  }
}

start();
