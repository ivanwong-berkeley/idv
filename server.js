/**
 * server.js (secure: env vars via dotenv)
 *
 * Setup:
 *   npm init -y
 *   npm i express mysql2 cors dotenv
 *
 * Run:
 *   node server.js
 *   (or) npm run dev  <-- if you add nodemon later
 *
 * Open:
 *   http://localhost:3000
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// --- Basic startup logging (no secrets) ---
console.log("[startup] Starting server...");
console.log("[startup] DB_HOST =", process.env.DB_HOST ? "(set)" : "(missing)");
console.log("[startup] DB_USER =", process.env.DB_USER ? "(set)" : "(missing)");
console.log("[startup] DB_NAME =", process.env.DB_NAME ? "(set)" : "(missing)");
console.log("[startup] DB_PORT =", process.env.DB_PORT || "3306");

// Fail fast if required env vars are missing
const required = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"];
const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
if (missing.length) {
  console.error(`[startup] Missing required env var(s): ${missing.join(", ")}`);
  console.error("[startup] Create a .env file (see .env.example) and try again.");
  process.exit(1);
}

console.log("I am here before: Configure DB connection.");

// ✅ Configure DB connection (all from env)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  // Optional: avoid hanging forever on bad network (mysql2 supports connectTimeout)
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000)
});



// Optional: quick DB ping at startup so you fail early (recommended)
async function verifyDbConnection() {
  console.log("[startup] Verifying DB connectivity (SELECT 1)...");
  const conn = await pool.getConnection();
  try {
    await conn.query("SELECT 1");
    console.log("[startup] DB connectivity OK.");
  } finally {
    conn.release();
  }
}

console.log("I am here after: Configure DB connection.");

// Serve the frontend
app.use(express.static(path.join(__dirname, "public")));

/**
 * GET /api/id-upload-trend?deploy_date=2026-01-07&days_before=30
 */
app.get("/api/id-upload-trend", async (req, res) => {
  try {
    const deployDate = String(req.query.deploy_date || "").trim();
    const daysBefore = Number(req.query.days_before || 30);

    // Basic validation
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deployDate)) {
      return res.status(400).json({
        error: "deploy_date must be YYYY-MM-DD (e.g., 2026-01-07)"
      });
    }
    if (!Number.isFinite(daysBefore) || daysBefore < 1 || daysBefore > 365) {
      return res.status(400).json({
        error: "days_before must be a number between 1 and 365"
      });
    }

    // NOTE: Some drivers/tools don't allow binding INTERVAL N directly.
    // We validate daysBefore and interpolate it safely as a number.
    const sql = `
      SELECT
        DATE(created_at) AS day,
        COUNT(*) AS total_uploads
      FROM protocom.identity_people
      WHERE created_at >= DATE_SUB(?, INTERVAL ${daysBefore} DAY)
        AND created_at <  DATE_ADD(CURDATE(), INTERVAL 1 DAY)
      GROUP BY day
      ORDER BY day;
    `;

    console.log(`I am here: SQL = ${sql}`);

    // Helpful debugging (safe)
    console.log(`[api] /api/id-upload-trend deploy_date=${deployDate} days_before=${daysBefore}`);

    const [rows] = await pool.query(sql, [deployDate]);

    const boundsSql = `
      SELECT
        ? AS deploy_date,
        DATE_SUB(?, INTERVAL ${daysBefore} DAY) AS start_date,
        CURDATE() AS end_date;
    `;
    const [boundsRows] = await pool.query(boundsSql, [deployDate, deployDate]);
    const bounds = boundsRows[0];

    res.json({
      deploy_date: bounds.deploy_date,
      start_date: bounds.start_date,
      end_date: bounds.end_date,
      rows: rows.map((r) => ({
        day: r.day, // YYYY-MM-DD
        total_uploads: Number(r.total_uploads)
      }))
    });
  } catch (err) {
    console.error("[api] error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const port = Number(process.env.PORT || 3000);

// Graceful shutdown
async function shutdown(signal) {
  try {
    console.log(`[shutdown] Received ${signal}. Closing DB pool...`);
    await pool.end();
    console.log("[shutdown] DB pool closed. Exiting.");
    process.exit(0);
  } catch (e) {
    console.error("[shutdown] Error during shutdown:", e);
    process.exit(1);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

(async () => {
  try {
    await verifyDbConnection();
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } catch (e) {
    console.error("[startup] Failed to start due to DB connectivity error:", e);
    process.exit(1);
  }
})();
