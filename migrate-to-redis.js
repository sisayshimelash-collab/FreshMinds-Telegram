require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Redis } = require("@upstash/redis");

// Check if Redis credentials are set
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("❌ Redis credentials not found in .env");
  console.log("Please add KV_REST_API_URL and KV_REST_API_TOKEN to your .env file");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function migrate() {
  try {
    // Read local notes
    const notesPath = path.join(__dirname, "data", "notes.json");
    const notesData = JSON.parse(fs.readFileSync(notesPath, "utf8"));
    
    console.log(`📦 Found ${notesData.notes.length} notes to migrate`);
    
    // Upload to Redis
    await redis.set("notes", notesData);
    
    console.log("✅ Migration complete!");
    console.log("🔍 Verifying...");
    
    // Verify
    const savedData = await redis.get("notes");
    console.log(`✅ Verified: ${savedData.notes.length} notes in Redis`);
    
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  }
}

migrate();
