import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

const SUPPORT_CHAT_ID = -1003889367656;
const supportMode = new Set();

/* =========================
   CORS
========================= */

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === "https://telegram-84-days.onrender.com") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "https://telegram-84-days.onrender.com";
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "https://telegram-84-days-api.onrender.com";
const TRIBUTE_API_KEY = process.env.TRIBUTE_API_KEY || "";
const TRIBUTE_PRODUCT_URL = process.env.TRIBUTE_PRODUCT_URL || "https://web.tribute.tg/p/Fbo";
const TRIBUTE_PRODUCT_ID = process.env.TRIBUTE_PRODUCT_ID || "";
const TAROT_WEBHOOK_URL = process.env.TAROT_WEBHOOK_URL || "https://tarot-omen1.onrender.com/tribute-webhook";

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log("PostgreSQL configured through DATABASE_URL");
} else if (
  process.env.PGHOST && process.env.PGPORT && process.env.PGDATABASE &&
  process.env.PGUSER && process.env.PGPASSWORD
) {
  pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false }
  });
  console.log("PostgreSQL configured through PG variables");
} else {
  console.log("WARNING: PostgreSQL is not configured");
}

let tributeProductId = TRIBUTE_PRODUCT_ID ? String(TRIBUTE_PRODUCT_ID) : null;
let tributeStarsAmount = null;

/* =========================
   DATABASE INIT
========================= */

async function initDb() {
  if (!pool) {
    console.log("PostgreSQL pool is not configured");
    return;
  }

  await pool.query("SELECT NOW()");
  console.log("PostgreSQL connected");

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
    CREATE TABLE IF NOT EXISTS app_promo_codes (
      code TEXT PRIMARY KEY,
      used_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_119_referrals (
      telegram_id BIGINT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT '119',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE promo_119_referrals
      ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_referred_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE promo_119_referrals
    SET referred_at = COALESCE(referred_at, first_seen_at, NOW()),
        last_referred_at = COALESCE(last_referred_at, referred_at, first_seen_at, NOW())
    WHERE referred_at IS NULL OR last_referred_at IS NULL
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      message_thread_id BIGINT,
      full_name TEXT,
      username TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS telegram_id BIGINT,
      ADD COLUMN IF NOT EXISTS chat_id BIGINT,
      ADD COLUMN IF NOT EXISTS message_thread_id BIGINT,
      ADD COLUMN IF NOT EXISTS thread_id BIGINT,
      ADD COLUMN IF NOT EXISTS full_name TEXT,
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE support_tickets
      ALTER COLUMN thread_id DROP NOT NULL,
      ALTER COLUMN message_thread_id DROP NOT NULL
  `);

  await pool.query(`
    UPDATE support_tickets
    SET message_thread_id = COALESCE(message_thread_id, thread_id),
        thread_id = COALESCE(thread_id, message_thread_id)
    WHERE message_thread_id IS NULL OR thread_id IS NULL
  `);

  await pool.query(`
    UPDATE support_tickets
    SET status = 'open'
    WHERE status IS NULL
  `);

  await pool.query(`
    UPDATE support_tickets
    SET created_at = NOW()
    WHERE created_at IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_message_thread_id_unique
    ON support_tickets (message_thread_id)
    WHERE message_thread_id IS NOT NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_one_open_per_user
    ON support_tickets (telegram_id)
    WHERE status = 'open'
  `);

  console.log("Database tables ready");
}

/* =========================
   TRIBUTE PRODUCT
========================= */

async function resolveTributeProductId() {
  if (tributeProductId) {
    console.log(`Tribute product ID from ENV: ${tributeProductId}`);

    if (TRIBUTE_API_KEY) {
      try {
        const response = await fetch(
          `https://tribute.tg/api/v1/products/${encodeURIComponent(tributeProductId)}`,
          {
            method: "GET",
            headers: {
              "Api-Key": TRIBUTE_API_KEY,
              "Accept": "application/json"
            }
          }
        );

        if (response.ok) {
          const product = await response.json();
          const starsAmount = Number(product?.starsAmount);

          if (Number.isFinite(starsAmount) && starsAmount > 0) {
            tributeStarsAmount = Math.round(starsAmount);
          }
        }
      } catch (error) {
        console.error("Tribute product details error:", error);
      }
    }

    return tributeProductId;
  }

  if (!TRIBUTE_API_KEY) {
    console.log("TRIBUTE_API_KEY is missing");
    return null;
  }

  try {
    const response = await fetch(
      "https://tribute.tg/api/v1/products?type=digital&size=100",
      {
        method: "GET",
        headers: {
          "Api-Key": TRIBUTE_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Tribute API HTTP ${response.status}`);
    }

    const json = await response.json();
    const rows = Array.isArray(json?.rows) ? json.rows : [];

    const target = rows.find(product =>
      String(product?.webLink || "").replace(/\/$/, "") ===
      TRIBUTE_PRODUCT_URL.replace(/\/$/, "")
    );

    if (!target?.id) {
      console.log("84 Days Tribute product was not found.");
      console.log(`Product URL: ${TRIBUTE_PRODUCT_URL}`);
      return null;
    }

    tributeProductId = String(target.id);

    const starsAmount = Number(target?.starsAmount);

    if (Number.isFinite(starsAmount) && starsAmount > 0) {
      tributeStarsAmount = Math.round(starsAmount);
    }

    console.log(`84 Days Tribute product ID resolved: ${tributeProductId}`);

    return tributeProductId;
  } catch (error) {
    console.error("Tribute product ID resolve error:", error);
    return null;
  }
}

/* =========================
   TELEGRAM MINI APP AUTH
========================= */

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

  if (calculatedHash.length !== hash.length) return null;

  if (
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

/* =========================
   TRIBUTE SIGNATURE
========================= */

function verifyTributeSignature(rawBody, signature) {
  if (!TRIBUTE_API_KEY || !rawBody || !signature) return false;

  const calculated = crypto
    .createHmac("sha256", TRIBUTE_API_KEY)
    .update(rawBody)
    .digest("hex");

  if (calculated.length !== signature.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(calculated),
    Buffer.from(signature)
  );
}

function is84DaysProduct(productId) {
  if (!tributeProductId || productId == null) return false;

  return String(productId) === String(tributeProductId);
}

async function markTributeEvent(
  eventKey,
  productId,
  telegramId,
  eventName
) {
  if (!pool) {
    throw new Error("PostgreSQL is not configured");
  }

  const result = await pool.query(
    `
      INSERT INTO tribute_events (
        event_key,
        product_id,
        telegram_id,
        event_name
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key
    `,
    [
      eventKey,
      String(productId ?? ""),
      telegramId ?? null,
      eventName
    ]
  );

  return result.rowCount > 0;
}

function stateMeansUserIsActuallyUsingApp(state) {
  return !!(
    state &&
    state.goal &&
    state.start
  );
}

async function mark119ReferralUsed(telegramId, state) {
  if (
    !pool ||
    !telegramId ||
    !stateMeansUserIsActuallyUsingApp(state)
  ) {
    return false;
  }

  const result = await pool.query(
    `
      UPDATE promo_119_referrals
      SET used_at = COALESCE(used_at, NOW())
      WHERE telegram_id = $1
        AND used_at IS NULL
      RETURNING telegram_id, used_at
    `,
    [telegramId]
  );

  if (result.rowCount > 0) {
    console.log(
      "[119 PROMO] ACTUALLY USED -> used_at set",
      {
        telegramId,
        usedAt: result.rows[0].used_at
      }
    );

    return true;
  }

  return false;
}

async function activateUser(telegramId) {
  if (!pool) {
    throw new Error("PostgreSQL is not configured");
  }

  await pool.query(
    `
      INSERT INTO users (
        telegram_id,
        paid
      )
      VALUES ($1, TRUE)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        paid = TRUE,
        updated_at = NOW()
    `,
    [telegramId]
  );

  console.log(
    `84 Days access activated: Telegram ${telegramId}`
  );
}

async function deactivateUser(telegramId) {
  if (!pool) {
    throw new Error("PostgreSQL is not configured");
  }

  await pool.query(
    `
      UPDATE users
      SET paid = FALSE,
          updated_at = NOW()
      WHERE telegram_id = $1
    `,
    [telegramId]
  );

  console.log(
    `84 Days access revoked: Telegram ${telegramId}`
  );
}

/* =========================
   FORWARD TO TAROT
========================= */

async function forwardTributeToTarot(rawBody, signature) {
  console.log("Forwarding Tribute event to Tarot...");

  const response = await fetch(
    TAROT_WEBHOOK_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "trbt-signature": signature
      },
      body: rawBody
    }
  );

  if (!response.ok) {
    throw new Error(
      `Tarot webhook HTTP ${response.status}`
    );
  }
}

async function processTributeEvent(req) {
  const signature =
    req.headers["trbt-signature"] ||
    req.headers["x-trbt-signature"] ||
    "";

  const rawBody =
    req.rawBody ||
    Buffer.from(
      JSON.stringify(req.body || {})
    );

  try {
    await forwardTributeToTarot(
      rawBody,
      signature
    );
  } catch (error) {
    console.error(
      "Tarot forwarding error:",
      error
    );
  }

  if (
    !verifyTributeSignature(
      rawBody,
      signature
    )
  ) {
    console.error(
      "Invalid Tribute signature"
    );

    return;
  }

  const body = req.body || {};
  const payload = body.payload || body;

  const eventName = String(
    body.name ||
    body.event ||
    body.event_name ||
    body.type ||
    ""
  );

  const productId =
    payload.product_id ??
    payload.product?.id ??
    payload.product?.product_id ??
    body.product_id ??
    body.product?.id ??
    null;

  const telegramId =
    payload.telegram_user_id ??
    payload.telegram_id ??
    payload.user?.telegram_id ??
    payload.user?.id ??
    body.telegram_id ??
    body.user?.telegram_id ??
    body.user?.id ??
    null;

  const eventId =
    payload.transaction_id ??
    payload.purchase_id ??
    payload.id ??
    body.id ??
    body.event_id ??
    body.transaction_id ??
    body.payment_id ??
    null;

  const eventKey = String(
    eventId ||
    `${eventName}:${telegramId}:${productId}:${JSON.stringify(body)}`
  );

  if (!is84DaysProduct(productId)) {
    console.log(
      `Tribute event ignored: product ${productId}`
    );

    return;
  }

  const isNew = await markTributeEvent(
    eventKey,
    productId,
    telegramId,
    eventName
  );

  if (!isNew) {
    console.log(
      `Tribute event already processed: ${eventKey}`
    );

    return;
  }

  const activationEvents = [
    "new_digital_product",
    "order_created",
    "order_paid",
    "payment_succeeded",
    "subscription_created",
    "subscription_renewed",
    "renewed_subscription",
    "paid"
  ];

  const revokeEvents = [
    "digital_product_refunded",
    "subscription_cancelled",
    "subscription_canceled",
    "subscription_expired",
    "refund",
    "refunded"
  ];

  if (
    telegramId &&
    activationEvents.includes(eventName)
  ) {
    await activateUser(telegramId);
    return;
  }

  if (
    telegramId &&
    revokeEvents.includes(eventName)
  ) {
    await deactivateUser(telegramId);
    return;
  }

  console.log(
    `Tribute event received but no action mapped: ${eventName}`
  );
}

/* =========================
   PROMO CODE
========================= */

function generatePromoCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 8; i++) {
    code += chars[
      crypto.randomInt(chars.length)
    ];
  }

  return code;
}

/* =========================
   TELEGRAM API
========================= */

async function telegramApi(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing");
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

  if (!response.ok || !json.ok) {
    throw new Error(
      `Telegram API ${method}: ${
        json.description || "unknown error"
      }`
    );
  }

  return json;
}

/* =========================
   SUPPORT CHAT DIAGNOSTICS
========================= */

async function getSupportBotDiagnostics() {
  if (!BOT_TOKEN) {
    return {
      ok: false,
      error: "BOT_TOKEN is missing"
    };
  }

  try {
    const me = await telegramApi(
      "getMe",
      {}
    );

    const bot = me.result || {};

    const member = await telegramApi(
      "getChatMember",
      {
        chat_id: SUPPORT_CHAT_ID,
        user_id: bot.id
      }
    );

    const chat = await telegramApi(
      "getChat",
      {
        chat_id: SUPPORT_CHAT_ID
      }
    );

    const m = member.result || {};

    return {
      ok: true,
      bot_id: bot.id,
      bot_username: bot.username || null,
      chat_id: chat.result?.id,
      chat_title:
        chat.result?.title || null,
      chat_type:
        chat.result?.type || null,
      is_forum:
        chat.result?.is_forum === true,
      status: m.status || null,
      is_admin:
        m.status === "administrator",
      can_manage_topics:
        m.can_manage_topics === true,
      can_manage_chat:
        m.can_manage_chat === true,
      can_delete_messages:
        m.can_delete_messages === true,
      can_restrict_members:
        m.can_restrict_members === true,
      can_invite_users:
        m.can_invite_users === true
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error.message ||
        String(error)
    };
  }
}

async function diagnoseSupportChat() {
  const diagnostics =
    await getSupportBotDiagnostics();

  console.log(
    "[SUPPORT] bot/chat diagnostics:",
    diagnostics
  );

  return diagnostics;
}

/* =========================
   SUPPORT TICKETS
========================= */

function supportTopicTitle(
  fullName,
  username
) {
  const name =
    fullName || "Пользователь";

  const user =
    username &&
    username !== "не указан"
      ? ` · ${username}`
      : "";

  return `🆘 ${name}${user}`.slice(
    0,
    128
  );
}

async function getOpenSupportTicket(
  telegramId
) {
  if (!pool) return null;

  const result = await pool.query(
    `
      SELECT
        id,
        telegram_id,
        chat_id,
        message_thread_id,
        full_name,
        username,
        status
      FROM support_tickets
      WHERE telegram_id = $1
        AND status = 'open'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [telegramId]
  );

  return result.rows[0] || null;
}

async function createSupportTicket(
  message
) {
  if (!pool) {
    throw new Error(
      "PostgreSQL is not configured"
    );
  }

  const telegramId =
    message.from?.id;

  if (!telegramId) {
    throw new Error(
      "Telegram user ID is missing"
    );
  }

  const existing =
    await getOpenSupportTicket(
      telegramId
    );

  if (existing) return existing;

  const fullName =
    `${message.from?.first_name || ""} ${
      message.from?.last_name || ""
    }`.trim();

  const username =
    message.from?.username
      ? `@${message.from.username}`
      : "не указан";

  const topic =
    await telegramApi(
      "createForumTopic",
      {
        chat_id: SUPPORT_CHAT_ID,
        name: supportTopicTitle(
          fullName,
          username
        ),
        icon_color: 0xFFD67E
      }
    );

  const messageThreadId =
    topic.result?.message_thread_id;

  if (!messageThreadId) {
    throw new Error(
      "Telegram did not return message_thread_id"
    );
  }

  const inserted =
    await pool.query(
      `
        INSERT INTO support_tickets (
          telegram_id,
          chat_id,
          message_thread_id,
          thread_id,
          full_name,
          username,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $3,
          $4,
          $5,
          'open'
        )
        RETURNING *
      `,
      [
        telegramId,
        SUPPORT_CHAT_ID,
        messageThreadId,
        fullName || "не указано",
        username
      ]
    );

  return inserted.rows[0];
}

async function sendSupportQuestion(
  message,
  ticket
) {
  const fullName =
    `${message.from?.first_name || ""} ${
      message.from?.last_name || ""
    }`.trim();

  const username =
    message.from?.username
      ? `@${message.from.username}`
      : "не указан";

  const text =
    String(message.text || "").trim();

  await telegramApi(
    "sendMessage",
    {
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id:
        Number(
          ticket.message_thread_id
        ),
      text:
        "🆘 НОВОЕ ОБРАЩЕНИЕ\n\n" +
        `Пользователь: ${
          fullName || "не указано"
        }\n` +
        `Username: ${username}\n` +
        `Telegram ID: ${
          message.from.id
        }\n\n` +
        `Вопрос:\n${text}`,
      reply_markup: {
        inline_keyboard: [[
          {
            text:
              "✅ ЗАКРЫТЬ ОБРАЩЕНИЕ",
            callback_data:
              `support_close:${ticket.id}`
          }
        ]]
      }
    }
  );
}

async function closeSupportTicket(
  ticketId
) {
  if (!pool) {
    throw new Error(
      "PostgreSQL is not configured"
    );
  }

  const result = await pool.query(
    `
      UPDATE support_tickets
      SET
        status = 'closed',
        closed_at = NOW()
      WHERE id = $1
        AND status = 'open'
      RETURNING *
    `,
    [ticketId]
  );

  return result.rows[0] || null;
}

async function sendAdminReplyToUser(
  message
) {
  const threadId =
    message.message_thread_id;

  if (!threadId || !pool) {
    return false;
  }

  const result =
    await pool.query(
      `
        SELECT *
        FROM support_tickets
        WHERE chat_id = $1
          AND message_thread_id = $2
          AND status = 'open'
        LIMIT 1
      `,
      [
        SUPPORT_CHAT_ID,
        threadId
      ]
    );

  const ticket =
    result.rows[0];

  if (!ticket) return false;

  const text =
    String(message.text || "").trim();

  if (
    !text ||
    text.startsWith("/")
  ) {
    return true;
  }

  await telegramApi(
    "sendMessage",
    {
      chat_id:
        Number(ticket.telegram_id),
      text:
        `🆘 Поддержка 12 недель:\n\n${text}`
    }
  );

  return true;
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
            command: "start",
            description: "Открыть 84 Дня"
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
          "message",
          "callback_query",
          "pre_checkout_query"
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
  if (update?.pre_checkout_query) {
    const query =
      update.pre_checkout_query;

    const payload =
      String(
        query.invoice_payload || ""
      );

    try {
      await telegramApi(
        "answerPreCheckoutQuery",
        {
          pre_checkout_query_id:
            query.id,
          ok:
            payload.startsWith(
              "84days:"
            ),
          ...(payload.startsWith(
            "84days:"
          )
            ? {}
            : {
                error_message:
                  "Недействительный платёж."
              })
        }
      );
    } catch (error) {
      console.error(
        "Pre-checkout error:",
        error
      );
    }

    return;
  }

  if (update?.callback_query) {
    const callback =
      update.callback_query;

    const chatId =
      callback.message?.chat?.id;

    const callbackData =
      String(
        callback.data || ""
      );

    try {
      await telegramApi(
        "answerCallbackQuery",
        {
          callback_query_id:
            callback.id
        }
      );
    } catch (error) {
      console.error(
        "Callback answer error:",
        error
      );
    }

    if (!chatId) return;

    if (
      callbackData.startsWith(
        "support_close:"
      )
    ) {
      if (
        chatId !==
        SUPPORT_CHAT_ID
      ) {
        return;
      }

      const ticketId =
        Number(
          callbackData.split(":")[1]
        );

      if (!Number.isInteger(ticketId)) {
        return;
      }

      try {
        const ticket =
          await closeSupportTicket(
            ticketId
          );

        if (!ticket) {
          await telegramApi(
            "sendMessage",
            {
              chat_id:
                SUPPORT_CHAT_ID,
              message_thread_id:
                callback.message
                  ?.message_thread_id,
              text:
                "Обращение уже закрыто."
            }
          );

          return;
        }

        await telegramApi(
          "editMessageReplyMarkup",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            message_id:
              callback.message
                .message_id,
            reply_markup: {
              inline_keyboard: []
            }
          }
        );

        await telegramApi(
          "sendMessage",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            message_thread_id:
              Number(
                ticket.message_thread_id
              ),
            text:
              "✅ Обращение закрыто."
          }
        );

        await telegramApi(
          "closeForumTopic",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            message_thread_id:
              Number(
                ticket.message_thread_id
              )
          }
        );
      } catch (error) {
        console.error(
          "Support close error:",
          error
        );
      }

      return;
    }

    if (callbackData === "support") {
      supportMode.add(
        callback.from?.id
      );

      await telegramApi(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "Задай вопрос. Одно обращение — одна отдельная тема поддержки."
        }
      );

      return;
    }

    if (
      callbackData ===
      "instruction"
    ) {
      await telegramApi(
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "КАК ПОЛЬЗОВАТЬСЯ «12 НЕДЕЛЯМИ»\n\n" +
            "1. Определи главную цель\n" +
            "Напиши одну конкретную цель, которую хочешь достичь за 12 недель.\n\n" +
            "2. Напиши, зачем тебе это\n" +
            "Что изменится в твоей жизни, если ты достигнешь этой цели?\n\n" +
            "3. Определи свой минимум\n" +
            "Какой минимальный результат ты должен делать даже в плохой день?\n\n" +
            "4. Заполни дополнительные цели\n" +
            "Можно добавить ещё две цели, если они связаны с твоим главным направлением.\n\n" +
            "5. Планируй каждую неделю\n" +
            "Для каждой недели укажи результат недели и ключевые действия, которые приведут к нему.\n\n" +
            "6. Каждый день отмечай движение\n" +
            "Записывай, что сделал сегодня, какой получил результат и оценивай день:\n" +
            "✅ сделал\n❌ не сделал\n0️⃣ ничего существенного\n\n" +
            "7. В конце недели подведи итог\n" +
            "Посмотри, какие действия выполнены, что сработало и что нужно изменить.\n\n" +
            "Главное правило:\n" +
            "Не пытайся идеально заполнить все 84 дня заранее. Сначала определи направление и план, а дальше каждый день двигайся по нему."
        }
      );

      return;
    }

    return;
  }

  const message =
    update?.message;

  if (!message) return;

  /* Messages sent by an administrator inside a support topic */

  if (
    message.chat?.id ===
    SUPPORT_CHAT_ID
  ) {
    if (
      message.text ===
      "/newcode"
    ) {
      if (!pool) {
        await telegramApi(
          "sendMessage",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            text:
              "База данных недоступна, код не создан."
          }
        );

        return;
      }

      const code =
        generatePromoCode();

      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS app_promo_codes (
            code TEXT PRIMARY KEY,
            used_by BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            used_at TIMESTAMPTZ
          )
        `);

        await pool.query(
          `
            INSERT INTO app_promo_codes (
              code
            )
            VALUES ($1)
          `,
          [code]
        );

        await telegramApi(
          "sendMessage",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            text:
              `Новый промокод: ${code}\n\nОтдай его пользователю — он вводит его в приложении вместо оплаты.`
          }
        );
      } catch (error) {
        console.error(
          "Promo code creation error:",
          error
        );

        await telegramApi(
          "sendMessage",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            text:
              `Не получилось создать код: ${
                error.message ||
                "неизвестная ошибка"
              }`
          }
        );
      }

      return;
    }

    if (
      message.text ===
      "/id"
    ) {
      const diagnostics =
        await diagnoseSupportChat();

      if (!diagnostics.ok) {
        await telegramApi(
          "sendMessage",
          {
            chat_id:
              SUPPORT_CHAT_ID,
            text:
              `Диагностика поддержки:\n\nОшибка: ${diagnostics.error}`
          }
        );

        return;
      }

      await telegramApi(
        "sendMessage",
        {
          chat_id:
            SUPPORT_CHAT_ID,
          text:
            `12 weeks [ADMIN]\n` +
            `chat_id: ${diagnostics.chat_id}\n` +
            `type: ${diagnostics.chat_type}\n` +
            `is_forum: ${diagnostics.is_forum}\n` +
            `title: ${
              diagnostics.chat_title ||
              "не указан"
            }\n\n` +
            `BOT\n` +
            `id: ${diagnostics.bot_id}\n` +
            `username: @${
              diagnostics.bot_username ||
              "не указан"
            }\n` +
            `status: ${diagnostics.status}\n` +
            `is_admin: ${diagnostics.is_admin}\n` +
            `can_manage_topics: ${diagnostics.can_manage_topics}\n` +
            `can_manage_chat: ${diagnostics.can_manage_chat}\n` +
            `can_delete_messages: ${diagnostics.can_delete_messages}\n` +
            `can_restrict_members: ${diagnostics.can_restrict_members}\n` +
            `can_invite_users: ${diagnostics.can_invite_users}`
        }
      );

      return;
    }

    if (
      message.message_thread_id
    ) {
      try {
        const handled =
          await sendAdminReplyToUser(
            message
          );

        if (handled) return;
      } catch (error) {
        console.error(
          "Support reply failed:",
          error
        );
      }
    }

    return;
  }

  if (
    message.successful_payment
  ) {
    try {
      const telegramId =
        message.from?.id;

      if (telegramId) {
        await activateUser(
          telegramId
        );

        await telegramApi(
          "sendMessage",
          {
            chat_id:
              message.chat.id,
            text:
              "✅ Оплата получена. Все 12 недель открыты."
          }
        );
      }
    } catch (error) {
      console.error(
        "Successful payment handling error:",
        error
      );
    }

    return;
  }

  const text =
    String(
      message.text || ""
    ).trim();

  if (
    message.from?.id &&
    text &&
    !text.startsWith("/")
  ) {
    const hasSupportMode =
      supportMode.has(
        message.from.id
      );

    const openTicket =
      await getOpenSupportTicket(
        message.from.id
      );

    if (
      hasSupportMode ||
      openTicket
    ) {
      try {
        const ticket =
          openTicket ||
          await createSupportTicket(
            message
          );

        if (
          hasSupportMode &&
          !openTicket
        ) {
          await sendSupportQuestion(
            message,
            ticket
          );
        } else {
          await telegramApi(
            "sendMessage",
            {
              chat_id:
                SUPPORT_CHAT_ID,
              message_thread_id:
                Number(
                  ticket.message_thread_id
                ),
              text:
                `💬 Сообщение пользователя:\n\n${text}`
            }
          );
        }

        supportMode.delete(
          message.from.id
        );
      } catch (error) {
        console.error(
          "Support ticket message failed:",
          error
        );

        try {
          await telegramApi(
            "sendMessage",
            {
              chat_id:
                message.chat.id,
              text:
                "Не получилось отправить сообщение в поддержку. Попробуй чуть позже."
            }
          );
        } catch (notifyError) {
          console.error(
            "Failed to notify user about support failure:",
            notifyError
          );
        }
      }

      return;
    }
  }

  if (
    text === "/start" ||
    text.startsWith("/start ")
  ) {
    const startPayload =
      text
        .slice("/start".length)
        .trim();

    if (
      startPayload ===
        "from_119" &&
      pool &&
      message.from?.id
    ) {
      try {
        await pool.query(
          `
            INSERT INTO promo_119_referrals (
              telegram_id,
              source,
              referred_at,
              last_referred_at
            )
            VALUES (
              $1,
              '119',
              NOW(),
              NOW()
            )
            ON CONFLICT (telegram_id)
            DO UPDATE SET
              last_seen_at = NOW(),
              last_referred_at = CASE
                WHEN promo_119_referrals.used_at IS NULL
                THEN NOW()
                ELSE promo_119_referrals.last_referred_at
              END
          `,
          [message.from.id]
        );

        console.log(
          "119 referral recorded",
          {
            telegramId:
              message.from.id
          }
        );
      } catch (error) {
        console.error(
          "119 referral save error:",
          error
        );
      }
    }

    await telegramApi(
      "sendMessage",
      {
        chat_id:
          message.chat.id,
        text:
          "12 недель",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🚀 СТАРТ",
                web_app: {
                  url: WEBAPP_URL
                }
              }
            ],
            [
              {
                text:
                  "📖 ИНСТРУКЦИЯ",
                callback_data:
                  "instruction"
              },
              {
                text:
                  "🆘 ТЕХПОДДЕРЖКА",
                callback_data:
                  "support"
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
          inline_keyboard: [[
            {
              text:
                "🚀 СТАРТ",
              web_app: {
                url: WEBAPP_URL
              }
            }
          ]]
        }
      }
    );

    return;
  }
}

/* =========================
   PAYMENTS
========================= */

app.post(
  "/api/payment/stars",
  async (req, res) => {
    try {
      const telegramUser =
        checkTelegramInitData(
          req.body?.initData
        );

      if (!telegramUser) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid Telegram session"
        });
      }

      const starsPrice =
        Number(
          process.env.STARS_PRICE ||
          tributeStarsAmount ||
          0
        );

      if (
        !Number.isInteger(
          starsPrice
        ) ||
        starsPrice < 1
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "Stars price is not configured"
        });
      }

      const payload =
        `84days:${telegramUser.id}:${Date.now()}`;

      const invoiceLink =
        await telegramApi(
          "createInvoiceLink",
          {
            title:
              "12 недель",
            description:
              "Открыть все 12 недель и полный доступ к приложению.",
            payload,
            currency:
              "XTR",
            prices: [
              {
                label:
                  "12 недель",
                amount:
                  starsPrice
              }
            ]
          }
        );

      return res.json({
        ok: true,
        invoice:
          invoiceLink.result,
        stars:
          starsPrice
      });
    } catch (error) {
      console.error(
        "Stars invoice error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Stars payment unavailable"
      });
    }
  }
);

app.post(
  "/api/payment/promo",
  async (req, res) => {
    try {
      const telegramUser =
        checkTelegramInitData(
          req.body?.initData
        );

      if (!telegramUser) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid Telegram session"
        });
      }

      const code =
        String(
          req.body?.code || ""
        )
          .trim()
          .toUpperCase();

      if (!code) {
        return res.status(400).json({
          ok: false,
          error:
            "Код не указан"
        });
      }

      if (!pool) {
        return res.status(503).json({
          ok: false,
          error:
            "Database unavailable"
        });
      }

      const result =
        await pool.query(
          `
            UPDATE app_promo_codes
            SET
              used_by = $2,
              used_at = NOW()
            WHERE code = $1
              AND used_by IS NULL
            RETURNING code
          `,
          [
            code,
            telegramUser.id
          ]
        );

      if (result.rowCount === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Код не найден или уже использован"
        });
      }

      await activateUser(
        telegramUser.id
      );

      return res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        "Promo redeem error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Server error"
      });
    }
  }
);

app.get(
  "/api/payment/tribute",
  (req, res) => {
    res.json({
      ok: true,
      url:
        TRIBUTE_PRODUCT_URL
    });
  }
);

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
  (req, res) => {
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

app.post(
  "/tribute/webhook",
  (req, res) => {
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
  async (req, res) => {
    try {
      console.log(
        "[SESSION] INCOMING REQUEST",
        {
          method:
            req.method,
          path:
            req.path,
          hasInitData:
            !!req.body?.initData,
          initDataLength:
            String(
              req.body?.initData || ""
            ).length
        }
      );

      const telegramUser =
        checkTelegramInitData(
          req.body?.initData
        );

      if (!telegramUser) {
        console.log(
          "[SESSION] INVALID TELEGRAM SESSION"
        );

        return res.status(401).json({
          ok: false,
          error:
            "Invalid Telegram session"
        });
      }

      console.log(
        "[SESSION] request",
        {
          telegramId:
            telegramUser.id,
          dbConfigured:
            !!pool
        }
      );

      if (!pool) {
        console.error(
          "[SESSION] PostgreSQL pool is not available"
        );

        return res.status(503).json({
          ok: false,
          error:
            "Database unavailable"
        });
      }

      const result =
        await pool.query(
          `
            INSERT INTO users (
              telegram_id
            )
            VALUES ($1)
            ON CONFLICT (telegram_id)
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

      const actuallyUsingApp =
        stateMeansUserIsActuallyUsingApp(
          row.state
        );

      const referralUsedNow =
        await mark119ReferralUsed(
          telegramUser.id,
          row.state
        );

      console.log(
        "[SESSION] success",
        {
          telegramId:
            telegramUser.id,
          hasState:
            actuallyUsingApp,
          stateBytes:
            JSON.stringify(
              row.state || {}
            ).length,
          referralUsedNow
        }
      );

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

      res.status(500).json({
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
  async (req, res) => {
    try {
      const telegramUser =
        checkTelegramInitData(
          req.body?.initData
        );

      if (!telegramUser) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid Telegram session"
        });
      }

      const state =
        req.body?.state || {};

      console.log(
        "[STATE] request",
        {
          telegramId:
            telegramUser.id,
          stateBytes:
            JSON.stringify(
              state
            ).length,
          hasGoal:
            !!state.goal,
          notes:
            Object.keys(
              state.notes || {}
            ).length
        }
      );

      if (!pool) {
        console.error(
          "[STATE] PostgreSQL pool is not available"
        );

        return res.status(503).json({
          ok: false,
          error:
            "Database unavailable"
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

      const result =
        await pool.query(
          `
            SELECT
              paid,
              state
            FROM users
            WHERE telegram_id = $1
          `,
          [
            telegramUser.id
          ]
        );

      const savedState =
        result.rows[0]?.state ||
        {};

      const savedBytes =
        JSON.stringify(
          savedState
        ).length;

      const savedNotes =
        Object.keys(
          savedState.notes || {}
        ).length;

      const matches =
        JSON.stringify(
          savedState
        ) ===
        JSON.stringify(
          state
        );

      console.log(
        "[STATE] saved",
        {
          telegramId:
            telegramUser.id,
          savedBytes,
          savedNotes,
          matches
        }
      );

      res.json({
        ok: true,
        paid:
          result.rows[0]?.paid === true
      });
    } catch (error) {
      console.error(
        "State error:",
        error
      );

      res.status(500).json({
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
    await resolveTributeProductId();

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
        await diagnoseSupportChat();
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
