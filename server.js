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
      ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE promo_119_referrals
    SET referred_at = COALESCE(referred_at, first_seen_at, NOW())
    WHERE referred_at IS NULL
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

  // IMPORTANT: CREATE TABLE IF NOT EXISTS does not modify an existing table.
  // The support table may have been created by an older server version, so
  // migrate every support column that the current code requires.
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

  // Older versions used a required column named thread_id. The current
  // version uses message_thread_id. Keep both columns compatible so an old
  // database schema cannot block a new support ticket.
  await pool.query(`
    ALTER TABLE support_tickets
      ALTER COLUMN thread_id DROP NOT NULL,
      ALTER COLUMN message_thread_id DROP NOT NULL
  `);

  // Copy the forum topic ID in both directions for legacy rows.
  await pool.query(`
    UPDATE support_tickets
    SET message_thread_id = COALESCE(message_thread_id, thread_id),
        thread_id = COALESCE(thread_id, message_thread_id)
    WHERE message_thread_id IS NULL OR thread_id IS NULL
  `);

  // Backfill defaults for rows created by an older schema before applying
  // constraints/indexes used by the current support implementation.
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

  // message_thread_id must be unique when present. NULL values are allowed
  // so old tickets can remain in the database until they are closed/replaced.
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
   119 PROMO INTEGRATION
========================= */

async function mark119ReferralUsed(telegramId, state) {
  if (!pool || !telegramId) return false;

  const actuallyUsingApp =
    !!(state && state.goal && state.start);

  if (!actuallyUsingApp) {
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

  const existing = await pool.query(
    `
      SELECT used_at
      FROM promo_119_referrals
      WHERE telegram_id = $1
      LIMIT 1
    `,
    [telegramId]
  );

  if (
    existing.rowCount > 0 &&
    existing.rows[0].used_at
  ) {
    console.log(
      "[119 PROMO] already used",
      {
        telegramId,
        usedAt: existing.rows[0].used_at
      }
    );
  } else {
    console.log(
      "[119 PROMO] no referral row for user; nothing to mark",
      {
        telegramId
      }
    );
  }

  return false;
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

          if (
            Number.isFinite(starsAmount) &&
            starsAmount > 0
          ) {
            tributeStarsAmount =
              Math.round(starsAmount);
          }
        }
      } catch (error) {
        console.error(
          "Tribute product details error:",
          error
        );
      }
    }

    return tributeProductId;
  }

  if (!TRIBUTE_API_KEY) {
    console.log(
      "TRIBUTE_API_KEY is missing"
    );

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
      throw new Error(
        `Tribute API HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const rows =
      Array.isArray(json?.rows)
        ? json.rows
        : [];

    const target =
      rows.find(product =>
        String(
          product?.webLink || ""
        ).replace(/\/$/, "") ===
        TRIBUTE_PRODUCT_URL.replace(/\/$/, "")
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
      String(target.id);

    const starsAmount =
      Number(target?.starsAmount);

    if (
      Number.isFinite(starsAmount) &&
      starsAmount > 0
    ) {
      tributeStarsAmount =
        Math.round(starsAmount);
    }

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
  if (!BOT_TOKEN || !initData) {
    return null;
  }

  const params =
    new URLSearchParams(initData);

  const hash =
    params.get("hash");

  if (!hash) {
    return null;
  }

  params.delete("hash");

  const dataCheckString =
    Array.from(params.entries())
      .sort(
        ([a], [b]) =>
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

  if (calculatedHash !== hash) {
    return null;
  }

  try {
    return JSON.parse(
      params.get("user") || "{}"
    );
  } catch {
    return null;
  }
}

/* =========================
   TRIBUTE
========================= */

function verifyTributeSignature(
  rawBody,
  signature
) {
  if (
    !TRIBUTE_API_KEY ||
    !signature
  ) {
    return false;
  }

  const expected =
    crypto
      .createHmac(
        "sha256",
        TRIBUTE_API_KEY
      )
      .update(rawBody)
      .digest("hex");

  return (
    expected === signature
  );
}

function is84DaysProduct(
  productId
) {
  if (!tributeProductId) {
    return false;
  }

  return (
    String(productId) ===
    String(tributeProductId)
  );
}

async function markTributeEvent(
  eventKey,
  productId,
  telegramId,
  eventName
) {
  if (!pool) {
    return false;
  }

  const result =
    await pool.query(
      `
        INSERT INTO tribute_events
          (
            event_key,
            product_id,
            telegram_id,
            event_name
          )
        VALUES
          ($1,$2,$3,$4)
        ON CONFLICT
          (event_key)
        DO NOTHING
        RETURNING event_key
      `,
      [
        eventKey,
        productId
          ? String(productId)
          : null,
        telegramId
          ? Number(telegramId)
          : null,
        eventName
          ? String(eventName)
          : null
      ]
    );

  return result.rowCount > 0;
}

async function activateUser(
  telegramId
) {
  if (!pool || !telegramId) {
    return;
  }

  await pool.query(
    `
      INSERT INTO users
        (
          telegram_id,
          paid
        )
      VALUES
        ($1, TRUE)
      ON CONFLICT
        (telegram_id)
      DO UPDATE
        SET paid=TRUE,
            updated_at=NOW()
    `,
    [telegramId]
  );
}

async function deactivateUser(
  telegramId
) {
  if (!pool || !telegramId) {
    return;
  }

  await pool.query(
    `
      UPDATE users
      SET paid=FALSE,
          updated_at=NOW()
      WHERE telegram_id=$1
    `,
    [telegramId]
  );
}

async function forwardTributeToTarot(
  rawBody,
  signature
) {
  if (!TAROT_WEBHOOK_URL) {
    return;
  }

  try {
    const response =
      await fetch(
        TAROT_WEBHOOK_URL,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",

            ...(signature
              ? {
                  "x-tribute-signature":
                    signature
                }
              : {})
          },
          body: rawBody
        }
      );

    if (!response.ok) {
      console.error(
        `Tarot forwarding failed: HTTP ${response.status}`
      );
    }
  } catch (error) {
    console.error(
      "Tarot forwarding error:",
      error
    );
  }
}

async function processTributeEvent(
  req
) {
  const signature =
    req.headers["x-tribute-signature"] ||
    req.headers["x-tribute-signature-sha256"] ||
    "";

  const rawBody =
    req.rawBody ||
    Buffer.from(
      JSON.stringify(req.body || {})
    );

  if (
    TRIBUTE_API_KEY &&
    !verifyTributeSignature(
      rawBody,
      signature
    )
  ) {
    console.error(
      "Tribute webhook signature verification failed"
    );
  }

  const body =
    req.body || {};

  const event =
    body.event ||
    body.type ||
    body.name ||
    "unknown";

  const data =
    body.data ||
    body;

  const productId =
    data.product_id ||
    data.productId ||
    data.product?.id ||
    null;

  const telegramId =
    data.telegram_user_id ||
    data.telegramUserId ||
    data.user_id ||
    data.userId ||
    data.telegram_id ||
    data.telegramId ||
    data.user?.id ||
    null;

  const eventKey =
    String(
      body.id ||
      body.event_id ||
      body.eventId ||
      `${event}:${telegramId}:${Date.now()}`
    );

  console.log(
    "Tribute webhook:",
    {
      event,
      productId,
      telegramId
    }
  );

  if (
    is84DaysProduct(productId) &&
    telegramId
  ) {
    const inserted =
      await markTributeEvent(
        eventKey,
        productId,
        telegramId,
        event
      );

    if (inserted) {
      const lowerEvent =
        String(event)
          .toLowerCase();

      if (
        lowerEvent.includes("cancel") ||
        lowerEvent.includes("refund") ||
        lowerEvent.includes("expire")
      ) {
        await deactivateUser(
          telegramId
        );
      } else {
        await activateUser(
          telegramId
        );
      }
    }
  }

  await forwardTributeToTarot(
    rawBody,
    signature
  );
}

/* =========================
   PROMO CODES
========================= */

function generatePromoCode() {
  return (
    Math.random()
      .toString(36)
      .slice(2, 10)
      .toUpperCase()
  );
}

/* =========================
   TELEGRAM API
========================= */

async function telegramApi(
  method,
  body
) {
  if (!BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN is missing"
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
        body: JSON.stringify(body)
      }
    );

  const json =
    await response.json();

  if (!response.ok || !json.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${response.status} ${JSON.stringify(json)}`
    );
  }

  return json;
}

/* =========================
   SUPPORT
========================= */

async function getSupportBotDiagnostics() {
  const me =
    await telegramApi(
      "getMe",
      {}
    );

  const chat =
    await telegramApi(
      "getChat",
      {
        chat_id:
          SUPPORT_CHAT_ID
      }
    );

  let member =
    null;

  if (me?.result?.id) {
    member =
      await telegramApi(
        "getChatMember",
        {
          chat_id:
            SUPPORT_CHAT_ID,
          user_id:
            me.result.id
        }
      );
  }

  return {
    ok: true,
    bot_id:
      me?.result?.id,
    bot_username:
      me?.result?.username,
    chat_id:
      chat?.result?.id,
    chat_title:
      chat?.result?.title,
    chat_type:
      chat?.result?.type,
    is_forum:
      chat?.result?.is_forum,
    status:
      member?.result?.status,
    is_admin:
      ["administrator", "creator"].includes(
        member?.result?.status
      ),
    can_manage_topics:
      member?.result?.can_manage_topics,
    can_manage_chat:
      member?.result?.can_manage_chat,
    can_delete_messages:
      member?.result?.can_delete_messages,
    can_restrict_members:
      member?.result?.can_restrict_members,
    can_invite_users:
      member?.result?.can_invite_users
  };
}

async function diagnoseSupportChat() {
  try {
    const diagnostics =
      await getSupportBotDiagnostics();

    console.log(
      "[SUPPORT] bot/chat diagnostics:",
      diagnostics
    );
  } catch (error) {
    console.error(
      "[SUPPORT] diagnostics failed:",
      error
    );
  }
}

function supportTopicTitle(
  fullName,
  username
) {
  const safeName =
    String(
      fullName ||
      "Пользователь"
    ).trim();

  const safeUsername =
    String(
      username || ""
    ).trim();

  if (safeUsername) {
    return `🆘 ${safeName} (@${safeUsername})`;
  }

  return `🆘 ${safeName}`;
}

async function getOpenSupportTicket(
  telegramId
) {
  if (!pool) {
    return null;
  }

  const result =
    await pool.query(
      `
        SELECT *
        FROM support_tickets
        WHERE telegram_id=$1
          AND status='open'
        ORDER BY id DESC
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
      "Database unavailable"
    );
  }

  const telegramId =
    Number(
      message.from?.id
    );

  const fullName =
    [
      message.from?.first_name,
      message.from?.last_name
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

  const username =
    message.from?.username ||
    null;

  const existing =
    await getOpenSupportTicket(
      telegramId
    );

  if (existing) {
    return existing;
  }

  const topic =
    await telegramApi(
      "createForumTopic",
      {
        chat_id:
          SUPPORT_CHAT_ID,

        name:
          supportTopicTitle(
            fullName,
            username
          )
      }
    );

  const threadId =
    Number(
      topic?.result?.message_thread_id
    );

  if (!threadId) {
    throw new Error(
      "Telegram did not return message_thread_id"
    );
  }

  const result =
    await pool.query(
      `
        INSERT INTO support_tickets
          (
            telegram_id,
            chat_id,
            message_thread_id,
            thread_id,
            full_name,
            username,
            status
          )
        VALUES
          ($1,$2,$3,$3,$4,$5,'open')
        RETURNING *
      `,
      [
        telegramId,
        SUPPORT_CHAT_ID,
        threadId,
        fullName || null,
        username
      ]
    );

  return result.rows[0];
}

async function sendSupportQuestion(
  message,
  ticket
) {
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
        `👤 Пользователь ${message.from?.first_name || ""} (@${message.from?.username || "без username"}) открыл обращение.`
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
        "💬 Напишите ответ пользователю в этой теме."
    }
  );
}

async function closeSupportTicket(
  ticketId
) {
  if (!pool) {
    return;
  }

  await pool.query(
    `
      UPDATE support_tickets
      SET status='closed',
          closed_at=NOW()
      WHERE id=$1
    `,
    [ticketId]
  );
}

async function sendAdminReplyToUser(
  message
) {
  if (!pool) {
    return false;
  }

  const threadId =
    Number(
      message.message_thread_id
    );

  if (!threadId) {
    return false;
  }

  const result =
    await pool.query(
      `
        SELECT *
        FROM support_tickets
        WHERE message_thread_id=$1
          AND status='open'
        LIMIT 1
      `,
      [threadId]
    );

  const ticket =
    result.rows[0];

  if (!ticket) {
    return false;
  }

  const text =
    String(
      message.text || ""
    ).trim();

  if (!text) {
    return true;
  }

  await telegramApi(
    "sendMessage",
    {
      chat_id:
        ticket.telegram_id,

      text:
        `🆘 Поддержка:\n\n${text}`
    }
  );

  await telegramApi(
    "sendMessage",
    {
      chat_id:
        SUPPORT_CHAT_ID,

      message_thread_id:
        threadId,

      text:
        "✅ Ответ отправлен пользователю."
    }
  );

  return true;
}

async function configureTelegramBot() {
  if (!BOT_TOKEN) {
    console.log(
      "BOT_TOKEN missing; Telegram bot configuration skipped"
    );

    return;
  }

  try {
    const webhookUrl =
      `${API_PUBLIC_URL}/telegram/webhook`;

    await telegramApi(
      "setWebhook",
      {
        url:
          webhookUrl,

        allowed_updates: [
          "message",
          "callback_query"
        ]
      }
    );

    console.log(
      `Telegram webhook configured: ${webhookUrl}`
    );
  } catch (error) {
    console.error(
      "Telegram webhook configuration failed:",
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
  const callback =
    update.callback_query;

  const message =
    update.message;

  if (callback) {
    const callbackId =
      callback.id;

    const data =
      String(
        callback.data || ""
      );

    try {
      await telegramApi(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackId
        }
      );
    } catch (error) {
      console.error(
        "answerCallbackQuery failed:",
        error
      );
    }

    if (
      data === "support"
    ) {
      const fromId =
        callback.from?.id;

      if (fromId) {
        supportMode.add(
          fromId
        );
      }

      await telegramApi(
        "sendMessage",
        {
          chat_id:
            callback.message.chat.id,

          text:
            "🆘 Напиши свой вопрос одним сообщением. Я передам его в поддержку."
        }
      );

      return;
    }

    if (
      data === "instruction"
    ) {
      await telegramApi(
        "sendMessage",
        {
          chat_id:
            callback.message.chat.id,

          text:
            "📖 Инструкция\n\nОткрой приложение кнопкой «🚀 СТАРТ» и следуй шагам внутри."
        }
      );

      return;
    }

    return;
  }

  if (!message) {
    return;
  }

  if (
    message.message_thread_id &&
    message.chat?.id ===
      SUPPORT_CHAT_ID
  ) {
    try {
      const handled =
        await sendAdminReplyToUser(
          message
        );

      if (handled) {
        return;
      }
    } catch (error) {
      console.error(
        "Support reply failed:",
        error
      );
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
      startPayload === "from_119" &&
      pool &&
      message.from?.id
    ) {
      try {
        await pool.query(
          `
            INSERT INTO promo_119_referrals
              (
                telegram_id,
                source,
                referred_at
              )
            VALUES
              ($1, '119', NOW())
            ON CONFLICT
              (telegram_id)
            DO UPDATE SET
              last_seen_at = NOW()
          `,
          [message.from.id]
        );

        console.log(
          "[119 PROMO] referral registered:",
          {
            telegramId:
              message.from.id
          }
        );
      } catch (error) {
        console.error(
          "[119 PROMO] referral save error:",
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
                  url:
                    WEBAPP_URL
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
                  "🚀 СТАРТ",

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

      if (
        result.rowCount === 0
      ) {
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
            INSERT INTO users
              (telegram_id)
            VALUES
              ($1)
            ON CONFLICT
              (telegram_id)
            DO UPDATE SET
              updated_at = NOW()
            RETURNING
              telegram_id,
              state,
              paid
          `,
          [telegramUser.id]
        );

      const row =
        result.rows[0];

      const hasState =
        !!(
          row.state &&
          row.state.goal &&
          row.state.start
        );

      console.log(
        "[SESSION] success",
        {
          telegramId:
            telegramUser.id,

          hasState,

          stateBytes:
            JSON.stringify(
              row.state || {}
            ).length
        }
      );

      /*
       * 119 PROMO:
       *
       * Сам переход по /start from_119
       * НЕ считается использованием.
       *
       * Реальным использованием считаем
       * момент, когда Mini App открылся
       * и у пользователя уже есть
       * goal + start.
       *
       * Тогда ставим used_at.
       */
      try {
        await mark119ReferralUsed(
          telegramUser.id,
          row.state
        );
      } catch (promoError) {
        console.error(
          "[119 PROMO] failed to mark actual use:",
          promoError
        );
      }

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
          INSERT INTO users
            (
              telegram_id,
              state
            )
          VALUES
            (
              $1,
              $2::jsonb
            )
          ON CONFLICT
            (telegram_id)
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

      /*
       * Дополнительная страховка:
       * если пользователь пришёл из 119,
       * а состояние появилось только сейчас,
       * ставим used_at и здесь тоже.
       */
      try {
        await mark119ReferralUsed(
          telegramUser.id,
          state
        );
      } catch (promoError) {
        console.error(
          "[119 PROMO] failed to mark actual use after state save:",
          promoError
        );
      }

      const result =
        await pool.query(
          `
            SELECT
              paid,
              state
            FROM users
            WHERE telegram_id = $1
          `,
          [telegramUser.id]
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
