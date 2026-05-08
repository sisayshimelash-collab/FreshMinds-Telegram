require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(
  /\/$/,
  "",
);
const DB_PATH = path.join(__dirname, "data", "notes.json");

// ─── Bot ──────────────────────────────────────────────────────────────────────
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });
  console.log("✅ Telegram bot initialised");
} else {
  console.warn("⚠️  BOT_TOKEN not set – Telegram posting disabled");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { notes: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
}

function generateId(title) {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${slug}-${suffix}`;
}

function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// GET /api/note/:id
app.get("/api/note/:id", (req, res) => {
  const db = readDB();
  const note = db.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Note not found" });
  res.json(note);
});

// GET /api/notes
app.get("/api/notes", (req, res) => {
  const db = readDB();
  res.json(db.notes);
});

// POST /api/note
app.post("/api/note", async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !title.trim())
      return res.status(400).json({ error: "Title is required" });
    if (!content || !content.trim())
      return res.status(400).json({ error: "Content is required" });

    // Save note
    const id = generateId(title);
    const note = {
      id,
      title: title.trim(),
      content: content.trim(),
      createdAt: new Date().toISOString(),
    };

    const db = readDB();
    db.notes.unshift(note);
    writeDB(db);
    console.log(`💾 Note saved: ${id}`);

    // Send to Telegram (non-blocking — won't crash the response if it fails)
    const viewerUrl = `${APP_URL}/viewer.html?note=${id}`;

    if (bot && CHANNEL_ID) {
      console.log(`🔄 Attempting to send Telegram message to ${CHANNEL_ID}...`);

      bot
        .sendMessage(CHANNEL_ID, `📘 *${escapeMarkdown(title)}*`, {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📖 Open Note", web_app: { url: viewerUrl } }],
            ],
          },
        })

        .then((msg) => {
          console.log(
            `✅ Telegram message sent! Message ID: ${msg.message_id}`,
          );
        })
        .catch((err) => {
          console.error(`❌ Telegram error: ${err.message}`);
          if (err.response) {
            console.error(`❌ Response status: ${err.response.statusCode}`);
            console.error(`❌ Response body:`, err.response.body);
          }
        });
    }

    // Always respond immediately — don't wait for Telegram
    res.status(201).json({ success: true, note });
  } catch (err) {
    console.error("❌ Server error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});


// POST /api/log-access - log student access
app.post("/api/log-access", (req, res) => {
  const { noteId, studentName, userId, accessedAt } = req.body;
  
  const logPath = path.join(__dirname, "data", "access-log.json");
  
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(logPath, "utf8"));
  } catch {
    log = [];
  }
  
  log.push({
    noteId,
    studentName,
    userId,
    accessedAt
  });
  
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
  console.log(`📊 Access logged: ${studentName} viewed ${noteId}`);
  
  res.json({ success: true });
});

// POST /api/log-access - log student access
app.post("/api/log-access", (req, res) => {
  const { noteId, studentName, userId, accessedAt } = req.body;
  const logPath = path.join(__dirname, "data", "access-log.json");
  
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(logPath, "utf8"));
  } catch {
    log = [];
  }
  
  log.push({ noteId, studentName, userId, accessedAt });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
  console.log(`📊 Access logged: ${studentName} viewed ${noteId}`);
  
  res.json({ success: true });
});
// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 FreshMinds Academy running at http://localhost:${PORT}`);
  console.log(`   Admin  → http://localhost:${PORT}/admin.html`);
  console.log(`   Viewer → http://localhost:${PORT}/viewer.html?note=<id>`);
});
