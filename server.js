require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // e.g., "FreshMindsBot"
const CHANNEL_ID = process.env.CHANNEL_ID;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(
  /\/$/,
  "",
);
const DB_PATH = path.join(__dirname, "data", "notes.json");

// ─── Redis Setup ──────────────────────────────────────────────────────────────
let redis = null;
const USE_REDIS = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

if (USE_REDIS) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  console.log("✅ Redis storage enabled");
} else {
  console.log("⚠️  Redis not configured - using file storage");
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
let bot = null;
if (BOT_TOKEN) {
  // Use webhook for production, polling only for local development
  const useWebhook = process.env.NODE_ENV === 'production' || APP_URL.includes('onrender.com');
  
  if (useWebhook) {
    bot = new TelegramBot(BOT_TOKEN, { polling: false });
    console.log("✅ Telegram bot initialised (webhook mode)");
  } else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log("✅ Telegram bot initialised (polling mode - local only)");
  }
  
  // Handle /start command with deep linking
  bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1]; // e.g., "note_abc123"
    
    console.log(`🔔 Bot command received: /start ${param} from user ${chatId}`);
    
    if (param.startsWith('note_')) {
      const noteId = param.replace('note_', '');
      const viewerUrl = `${APP_URL}/viewer.html?note=${noteId}`;
      
      // Send personal message with web_app button (this WILL work!)
      await bot.sendMessage(chatId, `📘 *Access Your Premium Note*`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { 
              text: "📖 Open Secure Reader", 
              web_app: { url: viewerUrl }
            }
          ]]
        },
      });
      
      console.log(`✅ Sent web_app button to user ${chatId} for note ${noteId}`);
    }
  });
} else {
  console.warn("⚠️  BOT_TOKEN not set – Telegram posting disabled");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function readDB() {
  if (USE_REDIS) {
    try {
      const data = await redis.get("notes");
      return data || { notes: [] };
    } catch (err) {
      console.error("Redis read error:", err);
      return { notes: [] };
    }
  } else {
    try {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    } catch {
      return { notes: [] };
    }
  }
}

async function writeDB(data) {
  if (USE_REDIS) {
    try {
      await redis.set("notes", data);
    } catch (err) {
      console.error("Redis write error:", err);
    }
  } else {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
  }
}

async function logAccess(logEntry) {
  if (USE_REDIS) {
    try {
      // Store access logs in Redis list
      await redis.lpush("access-log", JSON.stringify(logEntry));
    } catch (err) {
      console.error("Redis log error:", err);
    }
  } else {
    const logPath = path.join(__dirname, "data", "access-log.json");
    let log = [];
    try {
      log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    } catch {
      log = [];
    }
    log.push(logEntry);
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
  }
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

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Root route - redirect to admin
app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

// Telegram webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// GET /api/note/:id
app.get("/api/note/:id", async (req, res) => {
  const db = await readDB();
  const note = db.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Note not found" });
  res.json(note);
});

// GET /api/notes
app.get("/api/notes", async (req, res) => {
  const db = await readDB();
  res.json(db.notes);
});

// GET /api/health - check if Redis is enabled
app.get("/api/health", (req, res) => {
  res.json({
    redis: USE_REDIS,
    hasUrl: !!process.env.KV_REST_API_URL,
    hasToken: !!process.env.KV_REST_API_TOKEN,
  });
});

// GET /feed.xml - RSS feed for Instant View
app.get("/feed.xml", async (req, res) => {
  const db = await readDB();
  const notes = db.notes.slice(0, 50); // Last 50 notes
  
  let rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>FreshMinds Academy</title>
    <link>${APP_URL}</link>
    <description>Premium educational notes</description>
    <atom:link href="${APP_URL}/feed.xml" rel="self" type="application/rss+xml"/>
`;

  notes.forEach(note => {
    const noteUrl = `${APP_URL}/note/${note.id}`;
    const content = escapeXml(note.content);
    const title = escapeXml(note.title);
    
    rss += `
    <item>
      <title>${title}</title>
      <link>${noteUrl}</link>
      <guid>${noteUrl}</guid>
      <pubDate>${new Date(note.createdAt).toUTCString()}</pubDate>
      <description><![CDATA[${content}]]></description>
    </item>`;
  });

  rss += `
  </channel>
</rss>`;

  res.set('Content-Type', 'application/rss+xml');
  res.send(rss);
});

// GET /note/:id - Single note page for Instant View
app.get("/note/:id", async (req, res) => {
  console.log(`🔍 /note/:id called with id: ${req.params.id}`);
  
  const db = await readDB();
  console.log(`🔍 Found ${db.notes.length} notes in database`);
  
  const note = db.notes.find((n) => n.id === req.params.id);
  console.log(`🔍 Note found: ${!!note}`);
  
  if (!note) {
    console.log(`❌ Note not found: ${req.params.id}`);
    console.log(`📋 Available IDs: ${db.notes.slice(0, 5).map(n => n.id).join(', ')}`);
    return res.status(404).send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>Note Not Found</title></head>
      <body>
        <h1>Note Not Found</h1>
        <p>Looking for ID: ${req.params.id}</p>
        <p>Available notes: ${db.notes.length}</p>
      </body></html>
    `);
  }
  
  const content = note.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeXml(note.title)}">
  <meta property="og:description" content="FreshMinds Academy Premium Note">
  <meta property="og:type" content="article">
  <meta property="article:published_time" content="${note.createdAt}">
  <title>${escapeXml(note.title)} - FreshMinds Academy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1 { font-size: 2em; margin-bottom: 0.5em; color: #1a1a1a; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 2em; }
    .content { font-size: 1.1em; color: #333; }
    .watermark { background: #d4ff4e; padding: 10px; border-left: 3px solid #000; margin: 20px 0; }
  </style>
</head>
<body>
  <article>
    <h1>${escapeXml(note.title)}</h1>
    <div class="meta">Published: ${new Date(note.createdAt).toLocaleString()}</div>
    <div class="watermark">📌 FreshMinds Academy Premium Content</div>
    <div class="content">${content}</div>
  </article>
</body>
</html>`);
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

    const db = await readDB();
    db.notes.unshift(note);
    await writeDB(db);
    console.log(`💾 Note saved: ${id}`);

    // Send to Telegram - Use URL button since web_app doesn't work in channels
    // For true protection, we'll implement menu-based access
    const viewerUrl = `${APP_URL}/viewer.html?note=${id}`;

    console.log(`🔍 Debug: bot=${!!bot}, CHANNEL_ID=${CHANNEL_ID}, APP_URL=${APP_URL}`);
    
    if (bot && CHANNEL_ID) {
      console.log(`🔄 Attempting to send Telegram message to ${CHANNEL_ID}...`);

      // Set a timeout promise
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout after 10s')), 10000)
      );

      // Post announcement with contact bot button
      const sendPromise = bot.sendMessage(
        CHANNEL_ID, 
        `📘 *${escapeMarkdown(title)}*\n\n🔐 *Premium Content Available*\nClick below to access this note securely`,
        {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [[
              { 
                text: "📖 Open Secure Reader", 
                url: `https://t.me/${process.env.BOT_USERNAME || 'YourBotUsername'}?start=note_${id}`
              }
            ]]
          },
        }
      );

      // Race between send and timeout
      Promise.race([sendPromise, timeoutPromise])
        .then((msg) => {
          console.log(`✅ Telegram message sent! Message ID: ${msg.message_id}`);
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
app.post("/api/log-access", async (req, res) => {
  const { noteId, studentName, userId, accessedAt } = req.body;
  
  await logAccess({ noteId, studentName, userId, accessedAt });
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
app.listen(PORT, async () => {
  console.log(`🚀 FreshMinds Academy running at http://localhost:${PORT}`);
  console.log(`   Admin  → http://localhost:${PORT}/admin.html`);
  console.log(`   Viewer → http://localhost:${PORT}/viewer.html?note=<id>`);
  
  // Set webhook for production
  if (bot && (process.env.NODE_ENV === 'production' || APP_URL.includes('onrender.com'))) {
    const webhookUrl = `${APP_URL}/webhook/${BOT_TOKEN}`;
    try {
      await bot.setWebHook(webhookUrl);
      console.log(`✅ Webhook set: ${webhookUrl}`);
    } catch (err) {
      console.error(`❌ Webhook error: ${err.message}`);
    }
  }
});
