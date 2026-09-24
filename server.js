import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

// Keep the raw request body so Tribute's HMAC signature can be verified exactly.
app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";

const WEBAPP_URL =
  process.env.WEBAPP_URL ||
  "https://telegram-84-days.onrender.com";

const API_PUBLIC_URL =
  process.env.API_PUBLIC_URL ||
  "https://telegram-84-days-api.onrender.com";

const TRIBUTE_API_KEY =
  process.env.TRIBUTE_API_KEY || "";

const TRIBUTE_PRODUCT_URL =
  process.env.TRIBUTE_PRODUCT_URL ||
  "https://web.tribute.tg/p/Fbo";

const TRIBUTE_PRODUCT_ID =
  process.env.TRIBUTE_PRODUCT_ID || "";

const TAROT_WEBHOOK_URL =
  process.env.TAROT_WEBHOOK_URL ||
  "https://tarot-omen1.onrender.com/tribute-webhook";

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
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

let tributeProductIdCache =
  TRIBUTE_PRODUCT_ID || null;


/* =========================
   DATABASE
========================= */

async function initDb() {
  if (!pool) {
    console.log(
      "PostgreSQL variables are not configured"
    );

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tribute_events (
      event_key TEXT PRIMARY KEY,
      product_id TEXT,
      telegram_id BIGINT,
      event_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("PostgreSQL connected");
}


/* =========================
   TELEGRAM MINI APP AUTH
========================= */

function checkTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) {
    return null;
  }

  const params = new URLSearchParams(initData);

  const hash = params.get("hash");

  if (!hash) {
    return null;
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

  if (
    calculatedHash.length !==
    hash.length
  ) {
    return null;
  }

  if (
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {
    return null;
  }

  const userRaw =
    params.get("user");

  if (!userRaw) {
    return null;
  }

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}


/* =========================
   TRIBUTE SIGNATURE
========================= */

function verifyTributeSignature(
  rawBody,
  signature
) {
  if (
    !TRIBUTE_API_KEY ||
    !rawBody ||
    !signature
  ) {
    return false;
  }

  const calculated =
    crypto
      .createHmac(
        "sha256",
        TRIBUTE_API_KEY
      )
      .update(rawBody)
      .digest("hex");

  if (
    calculated.length !==
    signature.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(calculated),
    Buffer.from(signature)
  );
}


/* =========================
   FIND TRIBUTE PRODUCT
========================= */

async function getTributeProductId() {
  if (tributeProductIdCache) {
    return String(
      tributeProductIdCache
    );
  }

  if (!TRIBUTE_API_KEY) {
    return null;
  }

  const response =
    await fetch(
      "https://tribute.tg/api/v1/products?type=digital&size=100",
      {
        headers: {
          "Api-Key":
            TRIBUTE_API_KEY,

          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Tribute product list failed: HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  const rows =
    Array.isArray(json?.rows)
      ? json.rows
      : [];

  const target =
    rows.find(
      row =>
        String(
          row?.webLink || ""
        ).replace(/\/$/, "") ===
        TRIBUTE_PRODUCT_URL.replace(
          /\/$/,
          ""
        )
    );

  if (!target?.id) {
    throw new Error(
      `Tribute product not found by webLink: ${TRIBUTE_PRODUCT_URL}`
    );
  }

  tributeProductIdCache =
    String(target.id);

  console.log(
    `Tribute 84 Days product id resolved: ${tributeProductIdCache}`
  );

  return tributeProductIdCache;
}


async function is84DaysProduct(
  productId
) {
  if (productId == null) {
    return false;
  }

  const expected =
    await getTributeProductId();

  return (
    expected != null &&
    String(productId) ===
      String(expected)
  );
}


/* =========================
   TRIBUTE EVENT STORAGE
========================= */

async function markTributeEvent(
  eventKey,
  productId,
  telegramId,
  eventName
) {
  if (!pool) {
    throw new Error(
      "Database is not configured"
    );
  }

  const result =
    await pool.query(
      `
        INSERT INTO tribute_events (
          event_key,
          product_id,
          telegram_id,
          event_name
        )
        VALUES ($1, $2, $3, $4)

        ON CONFLICT (event_key)
        DO NOTHING

        RETURNING event_key
      `,
      [
        eventKey,
        String(
          productId ?? ""
        ),
        telegramId ?? null,
        eventName
      ]
    );

  return result.rowCount > 0;
}


/* =========================
   ACTIVATE USER
========================= */

async function activateUser(
  telegramId
) {
  if (!pool) {
    throw new Error(
      "Database is not configured"
    );
  }

  await pool.query(
    `
      INSERT INTO users (
        telegram_id,
        paid
      )
      VALUES (
        $1,
        TRUE
      )

      ON CONFLICT (telegram_id)

      DO UPDATE SET
        paid = TRUE,
        updated_at = NOW()
    `,
    [telegramId]
  );
}


/* =========================
   REVOKE USER ACCESS
========================= */

async function deactivateUser(
  telegramId
) {
  if (!pool) {
    throw new Error(
      "Database is not configured"
    );
  }

  await pool.query(
    `
      UPDATE users

      SET
        paid = FALSE,
        updated_at = NOW()

      WHERE telegram_id = $1
    `,
    [telegramId]
  );
}


/* =========================
   FORWARD TRIBUTE TO TAROT
========================= */

async function forwardTributeToTarot(
  rawBody,
  signature
) {
  const response =
    await fetch(
      TAROT_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "trbt-signature":
            signature
        },

        body: rawBody
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Tarot webhook returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  return text;
}


/* =========================
   HANDLE TRIBUTE WEBHOOK
========================= */

async function handleTributeWebhook(
  req
) {
  const rawBody =
    req.rawBody;

  const signature =
    String(
      req.get(
        "trbt-signature"
      ) || ""
    );

  if (
    !verifyTributeSignature(
      rawBody,
      signature
    )
  ) {
    const error =
      new Error(
        "Invalid Tribute signature"
      );

    error.statusCode = 401;

    throw error;
  }

  const body =
    req.body || {};

  const eventName =
    String(
      body.name || ""
    );

  const payload =
    body.payload || {};

  const productId =
    payload.product_id;

  const telegramId =
    payload.telegram_user_id;

  const is84 =
    await is84DaysProduct(
      productId
    );


  /* =========================
     84 DAYS PURCHASE
  ========================= */

  if (
    is84 &&
    eventName ===
      "new_digital_product"
  ) {
    if (!telegramId) {
      const error =
        new Error(
          "Tribute event has no telegram_user_id"
        );

      error.statusCode = 400;

      throw error;
    }

    const purchaseId =
      payload.purchase_id ??
      payload.transaction_id ??
      `${telegramId}:${body.created_at}`;

    const eventKey =
      `purchase:${purchaseId}`;

    const fresh =
      await markTributeEvent(
        eventKey,
        productId,
        telegramId,
        eventName
      );

    if (fresh) {
      await activateUser(
        telegramId
      );

      console.log(
        `84 Days access activated for Telegram ${telegramId}`
      );
    } else {
      console.log(
        `Duplicate Tribute purchase ignored: ${purchaseId}`
      );
    }

    return {
      routed: "84-days",
      ok: true
    };
  }


  /* =========================
     84 DAYS REFUND
  ========================= */

  if (
    is84 &&
    eventName ===
      "digital_product_refunded"
  ) {
    if (!telegramId) {
      const error =
        new Error(
          "Tribute refund has no telegram_user_id"
        );

      error.statusCode = 400;

      throw error;
    }

    const purchaseId =
      payload.purchase_id ??
      payload.transaction_id ??
      `${telegramId}:${body.created_at}`;

    const eventKey =
      `refund:${purchaseId}`;

    const fresh =
      await markTributeEvent(
        eventKey,
        productId,
        telegramId,
        eventName
      );

    if (fresh) {
      await deactivateUser(
        telegramId
      );

      console.log(
        `84 Days access revoked for Telegram ${telegramId}`
      );
    }

    return {
      routed:
        "84-days-refund",
      ok: true
    };
  }


  /* =========================
     EVERYTHING ELSE → TAROT
  ========================= */

  await forwardTributeToTarot(
    rawBody,
    signature
  );

  return {
    routed: "tarot",
    ok: true
  };
}


/* =========================
   TELEGRAM API
========================= */

async function telegramApi(
  method,
  body = {}
) {
  if (!BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN is not configured"
    );
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );

  const json =
    await response.json();

  if (!json.ok) {
    throw new Error(
      `Telegram API ${method}: ${
        json.description ||
        "unknown error"
      }`
    );
  }

  return json;
}


/* =========================
   CONFIGURE TELEGRAM BOT
========================= */

async function configureTelegramBot() {
  if (!BOT_TOKEN) {
    console.log(
      "Telegram bot is not configured: BOT_TOKEN is missing"
    );

    return;
  }

  try {
    await telegramApi(
      "setMyCommands",
      {
        commands: [
          {
            command: "start",
            description:
              "Открыть 84 Дня"
          }
        ]
      }
    );

    await telegramApi(
      "setWebhook",
      {
        url:
          `${API_PUBLIC_URL}/telegram/webhook`,

        allowed_updates: [
          "message"
        ]
      }
    );

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


/* =========================
   TELEGRAM UPDATES
========================= */

async function handleTelegramUpdate(
  update
) {
  const message =
    update?.message;

  if (
    !message?.chat?.id
  ) {
    return;
  }

  const text =
    String(
      message.text || ""
    ).trim();


  if (
    text === "/start" ||
    text.startsWith(
      "/start "
    )
  ) {
    await telegramApi(
      "sendMessage",
      {
        chat_id:
          message.chat.id,

        text:
          "12 недель к твоему лучшему будущему.\n" +
          "84 дня. Каждый день - твое движение к цели.",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "Открыть 12 недель",

                web_app: {
                  url:
                    WEBAPP_URL
                }
              }
            ]
          ]
        }
      }
    );

    return;
  }


  if (text === "/app") {
    await telegramApi(
      "sendMessage",
      {
        chat_id:
          message.chat.id,

        text:
          "Открывай свой цикл:",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "Открыть 12 недель",

                web_app: {
                  url:
                    WEBAPP_URL
                }
              }
            ]
          ]
        }
      }
    );
  }
}


/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "84-days"
    });
  }
);


/* =========================
   TELEGRAM WEBHOOK
========================= */

app.post(
  "/telegram/webhook",
  async (req, res) => {
    res.sendStatus(200);

    try {
      await handleTelegramUpdate(
        req.body
      );
    } catch (error) {
      console.error(
        "Telegram update error:",
        error
      );
    }
  }
);


/* =========================
   TRIBUTE WEBHOOK
========================= */

app.post(
  "/tribute-webhook",
  async (req, res) => {
    try {
      const result =
        await handleTributeWebhook(
          req
        );

      res
        .status(200)
        .json(result);

    } catch (error) {
      console.error(
        "Tribute webhook error:",
        error
      );

      res
        .status(
          error.statusCode ||
            500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Tribute webhook error"
        });
    }
  }
);


/* =========================
   TRIBUTE WEBHOOK ALIAS
========================= */

app.post(
  "/tribute/webhook",
  async (req, res) => {
    try {
      const result =
        await handleTributeWebhook(
          req
        );

      res
        .status(200)
        .json(result);

    } catch (error) {
      console.error(
        "Tribute webhook error:",
        error
      );

      res
        .status(
          error.statusCode ||
            500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Tribute webhook error"
        });
    }
  }
);


/* =========================
   SESSION
========================= */

app.post(
  "/api/session",
  async (req, res) => {
    try {
      const telegramUser =
        checkTelegramInitData(
          req.body?.initData
        );

      if (!telegramUser) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Invalid Telegram session"
          });
      }

      if (!pool) {
        return res.json({
          ok: true,
          user:
            telegramUser,
          paid: false,
          state: {}
        });
      }

      const result =
        await pool.query(
          `
            INSERT INTO users (
              telegram_id
            )

            VALUES ($1)

            ON CONFLICT (
              telegram_id
            )

            DO UPDATE SET
              updated_at = NOW()

            RETURNING
              telegram_id,
              state,
              paid
          `,
          [
            telegramUser.id
          ]
        );

      const row =
        result.rows[0];

      res.json({
        ok: true,

        user:
          telegramUser,

        paid:
          row.paid === true,

        state:
          row.state || {}
      });

    } catch (error) {
      console.error(
        "Session error:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Server error"
        });
    }
  }
);


/* =========================
   STATE
========================= */

app.post(
  "/api/state",
  async (req, res) => {
    try {
      const telegramUser =
        checkTelegramInitData(
          req.body?.initData
        );

      if (!telegramUser) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Invalid Telegram session"
          });
      }

      const state =
        req.body?.state || {};

      if (!pool) {
        return res.json({
          ok: true,
          paid: false
        });
      }

      await pool.query(
        `
          INSERT INTO users (
            telegram_id,
            state
          )

          VALUES (
            $1,
            $2::jsonb
          )

          ON CONFLICT (
            telegram_id
          )

          DO UPDATE SET
            state =
              $2::jsonb,

            updated_at =
              NOW()
        `,
        [
          telegramUser.id,
          JSON.stringify(state)
        ]
      );

      const result =
        await pool.query(
          `
            SELECT paid

            FROM users

            WHERE telegram_id = $1
          `,
          [
            telegramUser.id
          ]
        );

      res.json({
        ok: true,

        paid:
          result.rows[0]
            ?.paid === true
      });

    } catch (error) {
      console.error(
        "State error:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Server error"
        });
    }
  }
);


/* =========================
   ROOT
========================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      "84 Days backend is running"
    );
  }
);


/* =========================
   START
========================= */

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

        console.log(
          `Tribute webhook: ${API_PUBLIC_URL}/tribute-webhook`
        );

        console.log(
          `Tribute product: ${TRIBUTE_PRODUCT_URL}`
        );

        console.log(
          `Tarot forwarding webhook: ${TAROT_WEBHOOK_URL}`
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
