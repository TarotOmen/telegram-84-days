import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const app = express();

app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    }
  })
);


/* =========================
   CONFIG
========================= */

const PORT =
  process.env.PORT || 10000;

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

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


/* =========================
   POSTGRESQL
========================= */

/*
  Основной способ:
  DATABASE_URL

  Именно эта переменная уже есть
  у тебя в Render.
*/

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl: {
      rejectUnauthorized: false
    }
  });

  console.log(
    "PostgreSQL configured through DATABASE_URL"
  );

} else if (
  process.env.PGHOST &&
  process.env.PGPORT &&
  process.env.PGDATABASE &&
  process.env.PGUSER &&
  process.env.PGPASSWORD
) {

  /*
    Резервный вариант:
    если когда-нибудь DATABASE_URL
    не будет использоваться.
  */

  pool = new Pool({
    host:
      process.env.PGHOST,

    port:
      Number(
        process.env.PGPORT
      ),

    database:
      process.env.PGDATABASE,

    user:
      process.env.PGUSER,

    password:
      process.env.PGPASSWORD,

    ssl: {
      rejectUnauthorized: false
    }
  });

  console.log(
    "PostgreSQL configured through PG variables"
  );

} else {

  console.log(
    "WARNING: PostgreSQL is not configured"
  );
}


/* =========================
   TRIBUTE PRODUCT
========================= */

let tributeProductId =
  TRIBUTE_PRODUCT_ID
    ? String(
        TRIBUTE_PRODUCT_ID
      )
    : null;


/* =========================
   DATABASE INIT
========================= */

async function initDb() {

  if (!pool) {
    console.log(
      "PostgreSQL pool is not configured"
    );

    return;
  }

  /*
    Проверяем реальное соединение.
  */

  await pool.query(
    "SELECT NOW()"
  );

  console.log(
    "PostgreSQL connected"
  );


  /*
    Пользователи 84 дней.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,

      state JSONB NOT NULL
        DEFAULT '{}'::jsonb,

      paid BOOLEAN NOT NULL
        DEFAULT FALSE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    )
  `);


  /*
    История Tribute-событий.

    Нужна для защиты от повторной
    обработки одной и той же покупки.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tribute_events (
      event_key TEXT PRIMARY KEY,

      product_id TEXT,

      telegram_id BIGINT,

      event_name TEXT,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    )
  `);

  console.log(
    "Database tables ready"
  );
}


/* =========================
   RESOLVE TRIBUTE PRODUCT ID
========================= */

async function resolveTributeProductId() {

  /*
    Если ID уже задан в Render —
    используем его.
  */

  if (tributeProductId) {

    console.log(
      `Tribute product ID from ENV: ${tributeProductId}`
    );

    return tributeProductId;
  }


  /*
    Без API key определить ID нельзя.
  */

  if (!TRIBUTE_API_KEY) {

    console.log(
      "TRIBUTE_API_KEY is missing"
    );

    return null;
  }


  try {

    const response =
      await fetch(
        "https://tribute.tg/api/v1/products?type=digital&size=100",
        {
          method: "GET",

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
        `Tribute API HTTP ${response.status}`
      );
    }


    const json =
      await response.json();


    const rows =
      Array.isArray(
        json?.rows
      )
        ? json.rows
        : [];


    const target =
      rows.find(
        product =>
          String(
            product?.webLink || ""
          ).replace(
            /\/$/,
            ""
          ) ===
          TRIBUTE_PRODUCT_URL.replace(
            /\/$/,
            ""
          )
      );


    if (!target?.id) {

      console.log(
        "84 Days Tribute product was not found."
      );

      console.log(
        `Product URL: ${TRIBUTE_PRODUCT_URL}`
      );

      return null;
    }


    tributeProductId =
      String(
        target.id
      );


    console.log(
      `84 Days Tribute product ID resolved: ${tributeProductId}`
    );


    return tributeProductId;

  } catch (error) {

    console.error(
      "Tribute product ID resolve error:",
      error
    );

    return null;
  }
}


/* =========================
   TELEGRAM MINI APP AUTH
========================= */

function checkTelegramInitData(
  initData
) {

  if (
    !BOT_TOKEN ||
    !initData
  ) {
    return null;
  }


  const params =
    new URLSearchParams(
      initData
    );


  const hash =
    params.get(
      "hash"
    );


  if (!hash) {
    return null;
  }


  params.delete(
    "hash"
  );


  const dataCheckString =
    [...params.entries()]
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join(
        "\n"
      );


  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(
        BOT_TOKEN
      )
      .digest();


  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(
        dataCheckString
      )
      .digest(
        "hex"
      );


  if (
    calculatedHash.length !==
    hash.length
  ) {
    return null;
  }


  if (
    !crypto.timingSafeEqual(
      Buffer.from(
        calculatedHash
      ),
      Buffer.from(
        hash
      )
    )
  ) {
    return null;
  }


  const userRaw =
    params.get(
      "user"
    );


  if (!userRaw) {
    return null;
  }


  try {

    return JSON.parse(
      userRaw
    );

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
      .update(
        rawBody
      )
      .digest(
        "hex"
      );


  if (
    calculated.length !==
    signature.length
  ) {
    return false;
  }


  return crypto.timingSafeEqual(
    Buffer.from(
      calculated
    ),
    Buffer.from(
      signature
    )
  );
}


/* =========================
   PRODUCT CHECK
========================= */

function is84DaysProduct(
  productId
) {

  if (
    !tributeProductId ||
    productId == null
  ) {
    return false;
  }


  return (
    String(
      productId
    ) ===
    String(
      tributeProductId
    )
  );
}


/* =========================
   EVENT IDEMPOTENCY
========================= */

async function markTributeEvent(
  eventKey,
  productId,
  telegramId,
  eventName
) {

  if (!pool) {
    throw new Error(
      "PostgreSQL is not configured"
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

        VALUES (
          $1,
          $2,
          $3,
          $4
        )

        ON CONFLICT (
          event_key
        )

        DO NOTHING

        RETURNING event_key
      `,
      [
        eventKey,

        String(
          productId ?? ""
        ),

        telegramId ??
          null,

        eventName
      ]
    );


  return (
    result.rowCount > 0
  );
}


/* =========================
   ACTIVATE USER
========================= */

async function activateUser(
  telegramId
) {

  if (!pool) {
    throw new Error(
      "PostgreSQL is not configured"
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

      ON CONFLICT (
        telegram_id
      )

      DO UPDATE SET
        paid = TRUE,
        updated_at = NOW()
    `,
    [
      telegramId
    ]
  );


  console.log(
    `84 Days access activated: Telegram ${telegramId}`
  );
}


/* =========================
   DEACTIVATE USER
========================= */

async function deactivateUser(
  telegramId
) {

  if (!pool) {
    throw new Error(
      "PostgreSQL is not configured"
    );
  }


  await pool.query(
    `
      UPDATE users

      SET
        paid = FALSE,

        updated_at =
          NOW()

      WHERE telegram_id =
        $1
    `,
    [
      telegramId
    ]
  );


  console.log(
    `84 Days access revoked: Telegram ${telegramId}`
  );
}


/* =========================
   FORWARD TO TAROT
========================= */

async function forwardTributeToTarot(
  rawBody,
  signature
) {

  console.log(
    "Forwarding Tribute event to Tarot..."
  );


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

        body:
          rawBody
      }
    );


  const text =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `Tarot webhook HTTP ${response.status}: ${text.slice(
        0,
        300
      )}`
    );
  }


  console.log(
    "Tribute event successfully forwarded to Tarot."
  );
}


/* =========================
   PROCESS TRIBUTE EVENT
========================= */

async function processTributeEvent(
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


  /*
    Проверяем подпись.
  */

  if (
    !verifyTributeSignature(
      rawBody,
      signature
    )
  ) {

    throw new Error(
      "Invalid Tribute signature"
    );
  }


  const body =
    req.body || {};


  /*
    Tribute webhook может присылать
    данные в разных полях.

    Для нормального события
    здесь должны появиться
    event name и payload.
  */

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


  console.log(
    "Tribute event received:",
    {
      eventName,
      productId,
      telegramId
    }
  );


  /* =========================
     84 DAYS PURCHASE
  ========================= */

  if (
    eventName ===
      "new_digital_product" &&
    is84DaysProduct(
      productId
    )
  ) {

    if (!telegramId) {

      throw new Error(
        "84 Days purchase has no telegram_user_id"
      );
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

    } else {

      console.log(
        `Duplicate purchase ignored: ${purchaseId}`
      );
    }


    return;
  }


  /* =========================
     84 DAYS REFUND
  ========================= */

  if (
    eventName ===
      "digital_product_refunded" &&
    is84DaysProduct(
      productId
    )
  ) {

    if (!telegramId) {

      throw new Error(
        "84 Days refund has no telegram_user_id"
      );
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
    }


    return;
  }


  /*
    Всё, что не относится
    к нашему товару,
    отправляем Tarot.
  */

  await forwardTributeToTarot(
    rawBody,
    signature
  );
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
          JSON.stringify(
            body
          )
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
   TELEGRAM BOT CONFIG
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
            command:
              "start",

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


  if (
    text === "/app"
  ) {

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

      service:
        "84-days"
    });
  }
);


/* =========================
   TELEGRAM WEBHOOK
========================= */

app.post(
  "/telegram/webhook",
  async (
    req,
    res
  ) => {

    /*
      Telegram сразу получает
      успешный ответ.
    */

    res.sendStatus(
      200
    );


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
  (
    req,
    res
  ) => {

    /*
      Tribute получает 200
      сразу.

      Это устраняет проблему
      с 10-секундным timeout.
    */

    res.status(200).json({
      ok: true
    });


    /*
      Дальше обрабатываем
      событие отдельно.
    */

    setImmediate(
      async () => {

        try {

          await processTributeEvent(
            req
          );


          console.log(
            "Tribute event processed successfully."
          );

        } catch (error) {

          console.error(
            "Tribute event processing error:",
            error
          );
        }
      }
    );
  }
);


/* =========================
   TRIBUTE WEBHOOK ALIAS
========================= */

app.post(
  "/tribute/webhook",
  (
    req,
    res
  ) => {

    res.status(200).json({
      ok: true
    });


    setImmediate(
      async () => {

        try {

          await processTributeEvent(
            req
          );


          console.log(
            "Tribute event processed successfully."
          );

        } catch (error) {

          console.error(
            "Tribute event processing error:",
            error
          );
        }
      }
    );
  }
);


/* =========================
   MINI APP SESSION
========================= */

app.post(
  "/api/session",
  async (
    req,
    res
  ) => {

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
              updated_at =
                NOW()

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
   SAVE STATE
========================= */

app.post(
  "/api/state",
  async (
    req,
    res
  ) => {

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

          JSON.stringify(
            state
          )
        ]
      );


      const result =
        await pool.query(
          `
            SELECT paid

            FROM users

            WHERE telegram_id =
              $1
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
  (
    req,
    res
  ) => {

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

    /*
      Сначала подключаем БД.
    */

    await initDb();


    /*
      Один раз при запуске
      определяем ID товара Tribute.

      У тебя он уже был найден:
      158310
    */

    await resolveTributeProductId();


    /*
      Запускаем сервер.
    */

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
          `Tribute product URL: ${TRIBUTE_PRODUCT_URL}`
        );


        console.log(
          `Tribute product ID: ${
            tributeProductId ||
            "NOT RESOLVED"
          }`
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
