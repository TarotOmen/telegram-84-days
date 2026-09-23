import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      paid BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "84-days"
  });
});

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
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

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
      [telegramUser.id, JSON.stringify(state)]
    );

    const result = await pool.query(
      `SELECT paid FROM users WHERE telegram_id = $1`,
      [telegramUser.id]
    );

    res.json({
      ok: true,
      paid: result.rows[0]?.paid === true
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

app.post("/api/pay/tribute", async (req, res) => {
  res.json({
    ok: false,
    error: "Tribute payment is not connected yet"
  });
});

app.post("/api/pay/stars", async (req, res) => {
  res.json({
    ok: false,
    error: "Telegram Stars payment is not connected yet"
  });
});

app.get("/", (req, res) => {
  res.send("84 Days backend is running");
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`84 Days server started on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
