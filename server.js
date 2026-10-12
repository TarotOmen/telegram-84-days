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
   Цены и Stars зашиты прямо здесь, чтобы не зависеть от переменных
   окружения на Render. Ссылки на товары Tribute — наоборот, из ENV:
   их нужно завести на стороне Tribute (по одному товару на тариф) и
   передать сюда ссылки через TRIBUTE_PRODUCT_URL_MONTH /
   _CYCLE / _YEAR. Пока ссылка не задана, кнопка оплаты картой для
   этого тарифа будет вести в никуда — это нормально до тех пор, пока
   товар не создан в Tribute.
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
    // ↑ "Fbo" = тариф "3 месяца" — ссылка уже была такой, менять не пришлось.
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

// Резолвленные ID товаров Tribute — по одному на тариф, заполняются при старте.
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

  // На случай, если таблица users уже существовала до этих правок —
  // добавляем новые колонки отдельно, CREATE TABLE их не тронет.
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

async function resolveTributeProductIds() {
  // Цены и Stars теперь зашиты в TRIBUTE_PLANS выше — звёзды у Tribute
  // больше не спрашиваем. Единственное, что нужно узнать — числовой ID
  // каждого товара по его ссылке, чтобы потом опознавать вебхуки оплаты.

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
      console.log(`Tribute plan "${planKey}": no product URL configured (TRIBUTE_PRODUCT_URL_${planKey.toUpperCase()}), skipping.`);
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

function planForProductId(
  productId
) {
  if (productId == null) return null;

  for (const [planKey, id] of Object.entries(tributeProductIds)) {
    if (id && String(productId) === String(id)) {
      return planKey;
    }
  }

  return null;
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
  telegramId,
  planKey
) {
  if (!pool || !telegramId) {
    return;
  }

  const plan = TRIBUTE_PLANS[planKey] || TRIBUTE_PLANS.cycle;
  const resolvedPlanKey = TRIBUTE_PLANS[planKey] ? planKey : "cycle";
  const expiresAt = new Date(Date.now() + plan.days * 24 * 3600 * 1000);

  await pool.query(
    `
      INSERT INTO users
        (
          telegram_id,
          paid,
          plan,
          plan_expires_at
        )
      VALUES
        ($1, TRUE, $2, $3)
      ON CONFLICT
        (telegram_id)
      DO UPDATE
        SET paid=TRUE,
            plan=$2,
            plan_expires_at=$3,
            updated_at=NOW()
    `,
    [telegramId, resolvedPlanKey, expiresAt]
  );
}

function isPlanActive(row) {
  if (!row || !row.paid) return false;
  if (!row.plan_expires_at) return true; // старые записи без срока — считаем бессрочными
  return new Date(row.plan_expires_at) > new Date();
}

function weeksAllowedFor(row) {
  if (!isPlanActive(row)) return 0;
  const plan = TRIBUTE_PLANS[row.plan];
  return plan ? plan.weeks : 12; // старые записи без тарифа — как раньше, все 12 недель
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

  const matchedPlan = planForProductId(productId);

  if (
    matchedPlan &&
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
          telegramId,
          matchedPlan
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
