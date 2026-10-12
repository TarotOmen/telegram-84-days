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
const TAROT_WEBHOOK_URL = process.env.TAROT_WEBHOOK_URL || "https://tarot-omen1.onrender.com/tribute-webhook";

/* =========================
   PRICING TIERS
========================= */

const TRIBUTE_PLANS = {
  month: {
    label: "1 месяц / 4 недели",
    priceRub: 199,
    starsPrice: 180,
    weeks: 4,
    days: 30,
    url: process.env.TRIBUTE_PRODUCT_URL_MONTH || "https://web.tribute.tg/p/GKE"
  },
  cycle: {
    label: "3 месяца / 12 недель",
    priceRub: 499,
    starsPrice: 480,
    weeks: 12,
    days: 90,
    url: process.env.TRIBUTE_PRODUCT_URL_CYCLE || process.env.TRIBUTE_PRODUCT_URL || "https://web.tribute.tg/p/Fbo"
  },
  year: {
    label: "12 месяцев / 4 цикла",
    priceRub: 1290,
    starsPrice: 1250,
    weeks: 12,
    days: 365,
    url: process.env.TRIBUTE_PRODUCT_URL_YEAR || "https://web.tribute.tg/p/GKF"
  }
};

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

const tributeProductIds = { month: null, cycle: null, year: null };

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
      plan TEXT,
      plan_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ`);

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

  // Миграция старой таблицы: создаём недостающие столбцы по отдельности.
  await pool.query(`ALTER TABLE promo_119_referrals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '119'`);
  await pool.query(`ALTER TABLE promo_119_referrals ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE promo_119_referrals ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE promo_119_referrals ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE promo_119_referrals ADD COLUMN IF NOT EXISTS last_referred_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE promo_119_referrals ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ`);

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
    console.log("[119 PROMO] ACTUALLY USED -> used_at set", {
      telegramId,
      usedAt: result.rows[0].used_at
    });

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

  if (existing.rowCount > 0 && existing.rows[0].used_at) {
    console.log("[119 PROMO] already used", {
      telegramId,
      usedAt: existing.rows[0].used_at
    });
  } else {
    console.log("[119 PROMO] no referral row for user; nothing to mark", {
      telegramId
    });
  }

  return false;
}

/* =========================
   TRIBUTE PRODUCT
========================= */

async function resolveTributeProductIds() {
  if (!TRIBUTE_API_KEY) {
    console.log("TRIBUTE_API_KEY is missing — Tribute webhook matching won't work until it's set.");
    return;
  }

  let rows = [];

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
    rows = Array.isArray(json?.rows) ? json.rows : [];
  } catch (error) {
    console.error("Tribute product list fetch error:", error);
    return;
  }

  for (const [planKey, plan] of Object.entries(TRIBUTE_PLANS)) {
    if (!plan.url) {
      console.log(`Tribute plan "${planKey}": no product URL configured, skipping.`);
      continue;
    }

    const target = rows.find(product =>
      String(product?.webLink || "").replace(/\/$/, "") ===
      plan.url.replace(/\/$/, "")
    );

    if (!target?.id) {
      console.log(`Tribute plan "${planKey}": product not found for URL ${plan.url}`);
      continue;
    }

    tributeProductIds[planKey] = String(target.id);
    console.log(`Tribute plan "${planKey}": product ID resolved to ${target.id}`);
  }
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

  const dataCheckString = Array.from(params.entries())
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

  if (calculatedHash !== hash) {
    return null;
  }

  const authDate = Number(params.get("auth_date") || 0);

  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id) return null;
    return user;
  } catch {
    return null;
  }
}

/* =========================
   PLAN ACCESS
========================= */

function isPlanActive(row) {
  if (!row) return false;

  if (row.plan_expires_at) {
    return new Date(row.plan_expires_at).getTime() > Date.now();
  }

  return !!row.paid;
}

function weeksAllowedFor(row) {
  if (!isPlanActive(row)) return 0;

  const plan = row.plan || "cycle";

  if (plan === "month") return 4;
  if (plan === "year") return 52;

  return 12;
}

async function activateUser(telegramId, planKey = "cycle") {
  if (!pool) throw new Error("PostgreSQL is not configured");

  const plan = TRIBUTE_PLANS[planKey] || TRIBUTE_PLANS.cycle;
  const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);

  await pool.query(
    `
      INSERT INTO users
        (telegram_id, paid, plan, plan_expires_at)
      VALUES
        ($1, TRUE, $2, $3)
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        paid = TRUE,
        plan = $2,
        plan_expires_at = $3,
        updated_at = NOW()
    `,
    [telegramId, planKey, expiresAt]
  );
}

async function deactivateUser(telegramId) {
  if (!pool) throw new Error("PostgreSQL is not configured");

  await pool.query(
    `
      UPDATE users
      SET paid = FALSE,
          plan = NULL,
          plan_expires_at = NULL,
          updated_at = NOW()
      WHERE telegram_id = $1
    `,
    [telegramId]
  );
}

/* =========================
   TRIBUTE EVENTS
========================= */

async function markTributeEvent(eventKey, productId, telegramId, eventName) {
  if (!pool) throw new Error("PostgreSQL is not configured");

  const result = await pool.query(
    `
      INSERT INTO tribute_events
        (event_key, product_id, telegram_id, event_name)
      VALUES
        ($1, $2, $3, $4)
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key
    `,
    [eventKey, String(productId || ""), telegramId, eventName]
  );

  return result.rowCount > 0;
}

function is84DaysProduct(productId) {
  if (!productId) return false;

  return Object.values(tributeProductIds)
    .some(id => id && String(id) === String(productId));
}

async function forwardTributeToTarot(rawBody, signature) {
  if (!TAROT_WEBHOOK_URL) {
    throw new Error("TAROT_WEBHOOK_URL is not configured");
  }

  const response = await fetch(TAROT_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "trbt-signature": signature } : {})
    },
    body: rawBody
  });

  if (!response.ok) {
    throw new Error(`Tarot webhook returned HTTP ${response.status}`);
  }
}

async function processTributeEvent(req) {
  const rawBody = req.rawBody;
  const signature = String(req.get("trbt-signature") || "");

  const body = req.body || {};
  const eventName = String(body.name || "");
  const payload = body.payload || {};
  const productId = payload.product_id;
  const telegramId = payload.telegram_user_id;

  console.log("Tribute event received:", {
    eventName,
    productId,
    telegramId
  });

  if (eventName === "new_digital_product" && is84DaysProduct(productId)) {
    if (!telegramId) {
      throw new Error("84 Days purchase has no telegram_user_id");
    }

    const purchaseId =
      payload.purchase_id ??
      payload.transaction_id ??
      `${telegramId}:${body.created_at}`;

    const eventKey = `purchase:${purchaseId}`;
    const fresh = await markTributeEvent(eventKey, productId, telegramId, eventName);

    if (fresh) {
      await activateUser(telegramId);
    } else {
      console.log(`Duplicate purchase ignored: ${purchaseId}`);
    }

    return;
  }

  if (eventName === "digital_product_refunded" && is84DaysProduct(productId)) {
    if (!telegramId) {
      throw new Error("84 Days refund has no telegram_user_id");
    }

    const purchaseId =
      payload.purchase_id ??
      payload.transaction_id ??
      `${telegramId}:${body.created_at}`;

    const eventKey = `refund:${purchaseId}`;
    const fresh = await markTributeEvent(eventKey, productId, telegramId, eventName);

    if (fresh) {
      await deactivateUser(telegramId);
    }

    return;
  }

  await forwardTributeToTarot(rawBody, signature);
}

/* =========================
   TELEGRAM API
========================= */

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
    throw new Error(`Telegram API ${method}: ${json.description || "unknown error"}`);
  }

  return json;
}

/* =========================
   TELEGRAM BOT CONFIG
========================= */

async function configureTelegramBot() {
  if (!BOT_TOKEN) {
    console.log("Telegram bot is not configured: BOT_TOKEN is missing");
    return;
  }

  try {
    await telegramApi("setMyCommands", {
      commands: [
        {
          command: "start",
          description: "Открыть 12 недель"
        }
      ]
    });

    await telegramApi("setWebhook", {
      url: `${API_PUBLIC_URL}/telegram/webhook`,
      allowed_updates: ["message"]
    });

    console.log(`Telegram bot configured. Mini App: ${WEBAPP_URL}`);
  } catch (error) {
    console.error("Telegram bot configuration failed:", error);
  }
}

/* =========================
   TELEGRAM UPDATES
========================= */

async function handleTelegramUpdate(update) {
  const message = update?.message;

  if (!message?.chat?.id) {
    return;
  }

  const text = String(message.text || "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    const payload = text.slice("/start".length).trim();

    if (payload === "from_119" && pool) {
      try {
        await pool.query(
          `
            INSERT INTO promo_119_referrals
              (telegram_id, source, first_seen_at, last_seen_at, referred_at, last_referred_at)
            VALUES
              ($1, '119', NOW(), NOW(), NOW(), NOW())
            ON CONFLICT (telegram_id)
            DO UPDATE SET
              source = '119',
              last_seen_at = NOW(),
              last_referred_at = NOW()
          `,
          [message.from?.id]
        );
      } catch (error) {
        console.error("[119 PROMO] failed to record referral:", error);
      }
    }

    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text:
        "12 недель к твоему лучшему будущему.\n" +
        "Поставь цель и двигайся к ней шаг за шагом.",
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

    return;
  }

  if (supportMode.has(String(message.from?.id))) {
    await handleSupportUserMessage(message);
  }
}

/* =========================
   SUPPORT
========================= */

async function diagnoseSupportChat() {
  if (!BOT_TOKEN) return;

  try {
    const result = await telegramApi("getChat", {
      chat_id: SUPPORT_CHAT_ID
    });

    console.log("Support chat configured:", {
      id: result.result.id,
      title: result.result.title,
      type: result.result.type
    });
  } catch (error) {
    console.error("Support chat diagnostic failed:", error);
  }
}

async function createSupportTicket(telegramUser, message) {
  if (!pool) throw new Error("PostgreSQL is not configured");

  const existing = await pool.query(
    `
      SELECT id, chat_id, message_thread_id, status
      FROM support_tickets
      WHERE telegram_id = $1 AND status = 'open'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [telegramUser.id]
  );

  if (existing.rowCount > 0) {
    return existing.rows[0];
  }

  const fullName = [telegramUser.first_name, telegramUser.last_name]
    .filter(Boolean)
    .join(" ");

  const result = await pool.query(
    `
      INSERT INTO support_tickets
        (telegram_id, chat_id, full_name, username, status)
      VALUES
        ($1, $2, $3, $4, 'open')
      RETURNING id, chat_id, message_thread_id, status
    `,
    [
      telegramUser.id,
      SUPPORT_CHAT_ID,
      fullName || null,
      telegramUser.username || null
    ]
  );

  const ticket = result.rows[0];

  const topic = await telegramApi("createForumTopic", {
    chat_id: SUPPORT_CHAT_ID,
    name: `Обращение ${ticket.id} — ${fullName || telegramUser.id}`
  });

  await pool.query(
    `
      UPDATE support_tickets
      SET message_thread_id = $1,
          thread_id = $1
      WHERE id = $2
    `,
    [topic.result.message_thread_id, ticket.id]
  );

  await telegramApi("sendMessage", {
    chat_id: SUPPORT_CHAT_ID,
    message_thread_id: topic.result.message_thread_id,
    text:
      `Новое обращение в поддержку\n` +
      `ID: ${ticket.id}\n` +
      `Пользователь: ${fullName || "без имени"}\n` +
      `Telegram ID: ${telegramUser.id}\n` +
      `Username: ${telegramUser.username ? "@" + telegramUser.username : "нет"}`
  });

  return {
    ...ticket,
    message_thread_id: topic.result.message_thread_id
  };
}

async function handleSupportUserMessage(message) {
  if (!pool) return;

  const telegramUser = message.from;
  const ticket = await createSupportTicket(telegramUser, message);

  await telegramApi("sendMessage", {
    chat_id: SUPPORT_CHAT_ID,
    message_thread_id: ticket.message_thread_id,
    text:
      `Сообщение от ${telegramUser.first_name || "пользователя"} ` +
      `(ID ${telegramUser.id}):\n\n` +
      (message.text || "[не текстовое сообщение]")
  });

  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: "Сообщение передано в поддержку. Ответ придёт сюда."
  });
}

/* =========================
   SUPPORT WEBHOOK HANDLING
========================= */

app.post("/support/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message) return;

    if (message.message_thread_id && message.chat?.id === SUPPORT_CHAT_ID) {
      const result = await pool.query(
        `
          SELECT telegram_id, id
          FROM support_tickets
          WHERE message_thread_id = $1 AND status = 'open'
          LIMIT 1
        `,
        [message.message_thread_id]
      );

      if (result.rowCount > 0) {
        const ticket = result.rows[0];

        if (message.text === "/close") {
          await pool.query(
            `
              UPDATE support_tickets
              SET status = 'closed', closed_at = NOW()
              WHERE id = $1
            `,
            [ticket.id]
          );

          await telegramApi("sendMessage", {
            chat_id: ticket.telegram_id,
            text: "Обращение закрыто. Если понадобится помощь, напиши снова."
          });

          return;
        }

        if (message.text) {
          await telegramApi("sendMessage", {
            chat_id: ticket.telegram_id,
            text: `Ответ поддержки:\n\n${message.text}`
          });
        }
      }
    }
  } catch (error) {
    console.error("Support webhook error:", error);
  }
});

/* =========================
   PAYMENT ENDPOINTS
========================= */

app.post("/api/payment/create", async (req, res) => {
  try {
    const telegramUser = checkTelegramInitData(req.body?.initData);

    if (!telegramUser) {
      return res.status(401).json({
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    const planKey = String(req.body?.plan || "cycle");

    if (!TRIBUTE_PLANS[planKey]) {
      return res.status(400).json({
        ok: false,
        error: "Неизвестный тариф. Обнови приложение и попробуй ещё раз."
      });
    }

    const plan = TRIBUTE_PLANS[planKey];

    if (!plan.url) {
      return res.status(503).json({
        ok: false,
        error: `Товар для тарифа "${planKey}" ещё не настроен`
      });
    }

    res.json({
      ok: true,
      url: plan.url
    });
  } catch (error) {
    console.error("Payment create error:", error);
    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

app.get("/api/payment/plans", (req, res) => {
  res.json({
    ok: true,
    plans: Object.fromEntries(
      Object.entries(TRIBUTE_PLANS).map(([key, p]) => [
        key,
        {
          label: p.label,
          priceRub: p.priceRub,
          starsPrice: p.starsPrice,
          weeks: p.weeks
        }
      ])
    )
  });
});

/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "84-days"
  });
});

/* =========================
   TELEGRAM WEBHOOK
========================= */

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    await handleTelegramUpdate(req.body);
  } catch (error) {
    console.error("Telegram update error:", error);
  }
});

/* =========================
   TRIBUTE WEBHOOK
========================= */

app.post("/tribute-webhook", (req, res) => {
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      await processTributeEvent(req);
      console.log("Tribute event processed successfully.");
    } catch (error) {
      console.error("Tribute event processing error:", error);
    }
  });
});

app.post("/tribute/webhook", (req, res) => {
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      await processTributeEvent(req);
      console.log("Tribute event processed successfully.");
    } catch (error) {
      console.error("Tribute event processing error:", error);
    }
  });
});

/* =========================
   MINI APP SESSION
========================= */

app.post("/api/session", async (req, res) => {
  try {
    const telegramUser = checkTelegramInitData(req.body?.initData);

    if (!telegramUser) {
      return res.status(401).json({
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: "Database unavailable"
      });
    }

    const result = await pool.query(
      `
        INSERT INTO users (telegram_id)
        VALUES ($1)
        ON CONFLICT (telegram_id)
        DO UPDATE SET updated_at = NOW()
        RETURNING telegram_id, state, paid, plan, plan_expires_at
      `,
      [telegramUser.id]
    );

    const row = result.rows[0];

    try {
      await mark119ReferralUsed(telegramUser.id, row.state);
    } catch (promoError) {
      console.error("[119 PROMO] failed to mark actual use:", promoError);
    }

    res.json({
      ok: true,
      user: telegramUser,
      paid: isPlanActive(row),
      plan: row.plan || null,
      weeksAllowed: weeksAllowedFor(row),
      state: row.state || {}
    });
  } catch (error) {
    console.error("Session error:", error);

    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

/* =========================
   SAVE STATE
========================= */

app.post("/api/state", async (req, res) => {
  try {
    const telegramUser = checkTelegramInitData(req.body?.initData);

    if (!telegramUser) {
      return res.status(401).json({
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    const state = req.body?.state || {};

    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: "Database unavailable"
      });
    }

    await pool.query(
      `
        INSERT INTO users (telegram_id, state)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (telegram_id)
        DO UPDATE SET state = $2::jsonb, updated_at = NOW()
      `,
      [telegramUser.id, JSON.stringify(state)]
    );

    try {
      await mark119ReferralUsed(telegramUser.id, state);
    } catch (promoError) {
      console.error("[119 PROMO] failed to mark actual use after state save:", promoError);
    }

    const result = await pool.query(
      `
        SELECT paid, plan, plan_expires_at, state
        FROM users
        WHERE telegram_id = $1
      `,
      [telegramUser.id]
    );

    res.json({
      ok: true,
      paid: isPlanActive(result.rows[0]),
      plan: result.rows[0]?.plan || null,
      weeksAllowed: weeksAllowedFor(result.rows[0])
    });
  } catch (error) {
    console.error("State error:", error);

    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

/* =========================
   ROOT
========================= */

app.get("/", (req, res) => {
  res.send("84 Days backend is running");
});

/* =========================
   START
========================= */

async function start() {
  try {
    await initDb();
    await resolveTributeProductIds();

    app.listen(PORT, "0.0.0.0", async () => {
      console.log(`84 Days server started on port ${PORT}`);
      console.log(`Tribute webhook: ${API_PUBLIC_URL}/tribute-webhook`);

      for (const [planKey, plan] of Object.entries(TRIBUTE_PLANS)) {
        console.log(
          `Tribute plan "${planKey}" (${plan.label}): URL=${plan.url || "NOT SET"}, product ID=${tributeProductIds[planKey] || "NOT RESOLVED"}`
        );
      }

      console.log(`Tarot forwarding webhook: ${TAROT_WEBHOOK_URL}`);

      await configureTelegramBot();
      await diagnoseSupportChat();
    });
  } catch (error) {
    console.error("Startup failed:", error);
    process.exit(1);
  }
}

start();
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

  const preCheckout =
    update.pre_checkout_query;

  if (preCheckout) {
    // Без ответа на этот запрос в течение 10 секунд Telegram сам
    // отклоняет платёж — именно поэтому Stars раньше не проходили.
    const payload =
      String(preCheckout.invoice_payload || "");

    const ok =
      payload.startsWith("84days:");

    try {
      await telegramApi(
        "answerPreCheckoutQuery",
        ok
          ? {
              pre_checkout_query_id:
                preCheckout.id,
              ok: true
            }
          : {
              pre_checkout_query_id:
                preCheckout.id,
              ok: false,
              error_message:
                "Недействительный платёж."
            }
      );
    } catch (error) {
      console.error(
        "answerPreCheckoutQuery error:",
        error
      );
    }

    return;
  }

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

      const payloadParts =
        String(
          message.successful_payment.invoice_payload || ""
        ).split(":");

      // Формат payload: 84days:<planKey>:<telegramId>:<timestamp>
      const planKey =
        TRIBUTE_PLANS[payloadParts[1]]
          ? payloadParts[1]
          : "cycle";

      if (telegramId) {
        await activateUser(
          telegramId,
          planKey
        );

        await telegramApi(
          "sendMessage",
          {
            chat_id:
              message.chat.id,

            text:
              `✅ Оплата получена. Тариф «${TRIBUTE_PLANS[planKey].label}» активирован.`
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

      const planKey = req.body?.plan;
      if (!Object.prototype.hasOwnProperty.call(TRIBUTE_PLANS, planKey)) {
        return res.status(400).json({
          ok: false,
          error: "Неизвестный тариф. Обнови приложение и попробуй ещё раз."
        });
      }

      const plan = TRIBUTE_PLANS[planKey];
      const starsPrice = plan.starsPrice;

      const payload =
        `84days:${planKey}:${telegramUser.id}:${Date.now()}`;

      const invoiceLink =
        await telegramApi(
          "createInvoiceLink",
          {
            title:
              plan.label,

            description:
              `Доступ к приложению: ${plan.label}.`,

            payload,

            provider_token: "",

            currency:
              "XTR",

            prices: [
              {
                label:
                  plan.label,

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

      // Промокоды дают доступ уровня "3 месяца / 12 недель" —
      // это соответствует прежнему поведению до появления тарифов.
      await activateUser(
        telegramUser.id,
        "cycle"
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
    const planKey = req.query?.plan;
    if (!Object.prototype.hasOwnProperty.call(TRIBUTE_PLANS, planKey)) {
      return res.status(400).json({
        ok: false,
        error: "Неизвестный тариф. Обнови приложение и попробуй ещё раз."
      });
    }

    const plan = TRIBUTE_PLANS[planKey];

    if (!plan.url) {
      return res.status(503).json({
        ok: false,
        error:
          `Товар для тарифа "${planKey}" ещё не настроен (TRIBUTE_PRODUCT_URL_${planKey.toUpperCase()})`
      });
    }

    res.json({
      ok: true,
      url:
        plan.url
    });
  }
);

app.get(
  "/api/payment/plans",
  (req, res) => {
    res.json({
      ok: true,
      plans:
        Object.fromEntries(
          Object.entries(TRIBUTE_PLANS).map(
            ([key, p]) => [
              key,
              {
                label: p.label,
                priceRub: p.priceRub,
                starsPrice: p.starsPrice,
                weeks: p.weeks
              }
            ]
          )
        )
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
              paid,
              plan,
              plan_expires_at
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
          isPlanActive(row),

        plan:
          row.plan || null,

        weeksAllowed:
          weeksAllowedFor(row),

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
              plan,
              plan_expires_at,
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
          isPlanActive(result.rows[0]),

        plan:
          result.rows[0]?.plan || null,

        weeksAllowed:
          weeksAllowedFor(result.rows[0])
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

    await resolveTributeProductIds();

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

        for (const [planKey, plan] of Object.entries(TRIBUTE_PLANS)) {
          console.log(
            `Tribute plan "${planKey}" (${plan.label}): URL=${plan.url || "NOT SET"}, product ID=${tributeProductIds[planKey] || "NOT RESOLVED"}`
          );
        }

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
