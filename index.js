import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  Collection,
  GatewayIntentBits,
  Events,
  EmbedBuilder
} from "discord.js";
import db from "./db/init.js";

const SALES_CHANNEL_ID = "1316189904786423830";
const SALES_SUMMARY_CHANNEL_ID = "1432124585075146852";
const CENTRAL_TZ = "America/Chicago";
const SUMMARY_REFRESH_MS = 60 * 1000;

let summaryUpdateInProgress = false;
let summaryUpdateQueued = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.commands = new Collection();

const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));

for (const file of commandFiles) {
  const command = await import(`./commands/${file}`);
  if (command.default?.data && command.default?.execute) {
    client.commands.set(command.default.data.name, command.default);
  }
}

function getSetting(key) {
  const row = db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO bot_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getCentralParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value ?? "";

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    tzName: get("timeZoneName")
  };
}

function formatCentralTimestamp(date = new Date()) {
  const p = getCentralParts(date);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const mi = String(p.minute).padStart(2, "0");
  const ss = String(p.second).padStart(2, "0");
  return `${p.year}-${mm}-${dd} ${hh}:${mi}:${ss} ${p.tzName}`;
}

function formatCentralDayKey(date = new Date()) {
  const p = getCentralParts(date);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

function formatCentralMonthKey(date = new Date()) {
  const p = getCentralParts(date);
  const mm = String(p.month).padStart(2, "0");
  return `${p.year}-${mm}`;
}

function getIsoWeekInfoFromParts(year, month, day) {
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return { isoYear, weekNo };
}

function formatCentralWeekKey(date = new Date()) {
  const p = getCentralParts(date);
  const { isoYear, weekNo } = getIsoWeekInfoFromParts(p.year, p.month, p.day);
  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

function parseDbDate(value) {
  if (!value) return new Date();

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(value.replace(" ", "T") + "Z");
  }

  return new Date(value);
}

function getRowPeriodKeys(createdAt) {
  const date = parseDbDate(createdAt);

  return {
    day: formatCentralDayKey(date),
    week: formatCentralWeekKey(date),
    month: formatCentralMonthKey(date)
  };
}

function money(amount) {
  return Number(amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function parseSaleMessageContent(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("$")) return null;

  const lines = trimmed
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const firstLineMatch = lines[0].match(/^\$([\d,]+(?:\.\d{1,2})?)\s*(.*)$/);
  if (!firstLineMatch) return null;

  const amount = Number(firstLineMatch[1].replace(/,/g, ""));
  const carrier = firstLineMatch[2] ? firstLineMatch[2].trim() : null;

  if (Number.isNaN(amount) || amount <= 0) return null;

  let effectiveDate = null;

  for (const line of lines.slice(1)) {
    const eftMatch = line.match(/^EFT\s+(.+)$/i);
    if (eftMatch) {
      effectiveDate = eftMatch[1].trim();
      break;
    }
  }

  return {
    amount,
    carrier,
    effectiveDate
  };
}

function buildSummaryText(title, keyLabel, rows, periodType) {
  const now = new Date();
  const currentDay = formatCentralDayKey(now);
  const currentWeek = formatCentralWeekKey(now);
  const currentMonth = formatCentralMonthKey(now);

  let currentKey = "";
  if (periodType === "day") currentKey = currentDay;
  if (periodType === "week") currentKey = currentWeek;
  if (periodType === "month") currentKey = currentMonth;

  const filtered = rows.filter(row => {
    const keys = getRowPeriodKeys(row.created_at);
    return keys[periodType] === currentKey;
  });

  const totalsByAgent = new Map();

  for (const row of filtered) {
    const agentId = row.agent_discord_id || row.agent_name || "unknown";
    const displayName = row.agent_name || "Unknown";

    if (!totalsByAgent.has(agentId)) {
      totalsByAgent.set(agentId, {
        name: displayName,
        total: 0
      });
    }

    const existing = totalsByAgent.get(agentId);
    existing.total += Number(row.amount || 0);

    if (displayName.includes("| UPRISE") || displayName.length > existing.name.length) {
      existing.name = displayName;
    }
  }

  const leaderboard = [...totalsByAgent.values()].sort((a, b) => b.total - a.total);
  const teamTotal = leaderboard.reduce((sum, row) => sum + row.total, 0);

  let text = "";

  if (leaderboard.length === 0) {
    text += `No sales logged yet.\n\n`;
  } else {
    for (const row of leaderboard) {
      text += `${row.name}: ${money(row.total)}\n`;
    }
    text += `\n`;
  }

  text += `Team Total: ${money(teamTotal)}\n\n`;
  text += `Updated ${formatCentralTimestamp(now)}`;

  return {
    title: `📅 ${title} — ${keyLabel}`,
    body: text
  };
}

function makeSummaryEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xFF3B3B)
    .setTitle(title)
    .setDescription(description);
}

async function getOrCreateSummaryMessage(channel, settingKey) {
  const existingId = getSetting(settingKey);

  if (existingId) {
    try {
      return await channel.messages.fetch(existingId);
    } catch {
      // recreate if missing
    }
  }

  const msg = await channel.send({
    embeds: [
      makeSummaryEmbed("Loading...", "Please wait...")
    ]
  });

  setSetting(settingKey, msg.id);
  return msg;
}

async function updateAllSummaries() {
  const channel = await client.channels.fetch(SALES_SUMMARY_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  const rows = db.prepare(`
    SELECT agent_discord_id, agent_name, amount, created_at
    FROM sales
    ORDER BY created_at ASC
  `).all();

  const todayMsg = await getOrCreateSummaryMessage(channel, "summary_today_message_id");
  const weekMsg = await getOrCreateSummaryMessage(channel, "summary_week_message_id");
  const monthMsg = await getOrCreateSummaryMessage(channel, "summary_month_message_id");

  const today = buildSummaryText(
    "Sales — Today (Live)",
    formatCentralDayKey(new Date()),
    rows,
    "day"
  );

  const week = buildSummaryText(
    "Sales — This Week (Live)",
    formatCentralWeekKey(new Date()),
    rows,
    "week"
  );

  const month = buildSummaryText(
    "Sales — This Month (Live)",
    formatCentralMonthKey(new Date()),
    rows,
    "month"
  );

  await todayMsg.edit({
    content: "",
    embeds: [makeSummaryEmbed(today.title, today.body)]
  });

  await weekMsg.edit({
    content: "",
    embeds: [makeSummaryEmbed(week.title, week.body)]
  });

  await monthMsg.edit({
    content: "",
    embeds: [makeSummaryEmbed(month.title, month.body)]
  });
}

async function requestSummaryRefresh() {
  if (summaryUpdateInProgress) {
    summaryUpdateQueued = true;
    return;
  }

  summaryUpdateInProgress = true;

  try {
    do {
      summaryUpdateQueued = false;
      await updateAllSummaries();
    } while (summaryUpdateQueued);
  } finally {
    summaryUpdateInProgress = false;
  }
}

client.once(Events.ClientReady, async () => {
  console.log("Bot is online");

  try {
    await requestSummaryRefresh();
    console.log("Summaries initialized");
  } catch (err) {
    console.error("Failed to initialize summaries:", err);
  }

  setInterval(async () => {
    try {
      await requestSummaryRefresh();
    } catch (err) {
      console.error("Auto-refresh failed:", err);
    }
  }, SUMMARY_REFRESH_MS);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      await command.execute(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "saleModal") {
      const rawAmount = interaction.fields.getTextInputValue("amount");
      const cleaned = rawAmount.replace(/\$/g, "").replace(/,/g, "").trim();
      const amount = Number(cleaned);

      if (Number.isNaN(amount) || amount <= 0) {
        await interaction.reply({
          content: "Enter a valid amount like $100 or $1,250",
          ephemeral: true
        });
        return;
      }

      const name = interaction.member?.displayName || interaction.user.username;

      db.prepare(`
        INSERT INTO sales (agent_discord_id, agent_name, amount, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        interaction.user.id,
        name,
        amount,
        new Date().toISOString()
      );

      await interaction.reply({
        content: `✅ Recorded total sales of ${money(amount)} for ${name}`,
        ephemeral: true
      });

      await requestSummaryRefresh();
    }
  } catch (err) {
    console.error(err);
  }
});

client.on(Events.MessageCreate, async message => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== SALES_CHANNEL_ID) return;

    const raw = message.content.trim();

    if (raw.toLowerCase().startsWith("!add")) {
      const mentionedUser = message.mentions.users.first();

      if (!mentionedUser) {
        await message.reply("Use this format: `!add @Person $1000`");
        return;
      }

      const addMatch = raw.match(/\$([\d,]+(?:\.\d{1,2})?)/);

      if (!addMatch) {
        await message.reply("Use this format: `!add @Person $1000`");
        return;
      }

      const amount = Number(addMatch[1].replace(/,/g, ""));

      if (Number.isNaN(amount) || amount <= 0) {
        await message.reply("Invalid add amount.");
        return;
      }

      const mentionedMember =
        message.guild?.members.cache.get(mentionedUser.id) ||
        await message.guild?.members.fetch(mentionedUser.id).catch(() => null);

      const targetName = mentionedMember?.displayName || mentionedUser.username;

      db.prepare(`
        INSERT INTO sales (
          agent_discord_id,
          agent_name,
          amount,
          carrier,
          effective_date,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        mentionedUser.id,
        targetName,
        amount,
        "MANUAL_ADD",
        null,
        new Date().toISOString()
      );

      await message.channel.send(
        `✅ Added ${money(amount)} to ${targetName}'s totals.`
      );

      await requestSummaryRefresh();
      return;
    }

    if (raw.toLowerCase().startsWith("!remove")) {
      const mentionedUser = message.mentions.users.first();

      if (!mentionedUser) {
        await message.reply("Use this format: `!remove @Person $22000`");
        return;
      }

      const removeMatch = raw.match(/\$([\d,]+(?:\.\d{1,2})?)/);

      if (!removeMatch) {
        await message.reply("Use this format: `!remove @Person $22000`");
        return;
      }

      const amount = Number(removeMatch[1].replace(/,/g, ""));

      if (Number.isNaN(amount) || amount <= 0) {
        await message.reply("Invalid removal amount.");
        return;
      }

      const mentionedMember =
        message.guild?.members.cache.get(mentionedUser.id) ||
        await message.guild?.members.fetch(mentionedUser.id).catch(() => null);

      const targetName = mentionedMember?.displayName || mentionedUser.username;

      db.prepare(`
        INSERT INTO sales (
          agent_discord_id,
          agent_name,
          amount,
          carrier,
          effective_date,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        mentionedUser.id,
        targetName,
        -amount,
        "REMOVAL",
        null,
        new Date().toISOString()
      );

      await message.channel.send(
        `❌ Removed ${money(amount)} from ${targetName}'s totals.`
      );

      await requestSummaryRefresh();
      return;
    }

    const parsed = parseSaleMessageContent(raw);
    if (!parsed) return;

    const name = message.member?.displayName || message.author.username;

    db.prepare(`
      INSERT INTO sales (
        agent_discord_id,
        agent_name,
        amount,
        carrier,
        effective_date,
        created_at,
        source_message_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.author.id,
      name,
      parsed.amount,
      parsed.carrier,
      parsed.effectiveDate,
      new Date().toISOString(),
      message.id
    );

    await message.channel.send(
      `✅ Recorded total sales of ${money(parsed.amount)} for ${name}`
    );

    await requestSummaryRefresh();
  } catch (err) {
    console.error(err);
    await message.reply("Something broke while logging that sale.");
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (newMessage.author?.bot) return;
    if (newMessage.channel?.id !== SALES_CHANNEL_ID) return;
    if (!newMessage.id) return;

    const existingSale = db.prepare(`
      SELECT id
      FROM sales
      WHERE source_message_id = ?
    `).get(newMessage.id);

    if (!existingSale) return;

    const raw = newMessage.content?.trim() || "";
    const parsed = parseSaleMessageContent(raw);

    if (!parsed) {
      await newMessage.channel.send(
        `⚠️ Edited sale message from ${newMessage.member?.displayName || newMessage.author.username} is no longer in a valid sale format, so the original logged sale was left unchanged.`
      );
      return;
    }

    const updatedName = newMessage.member?.displayName || newMessage.author.username;

    db.prepare(`
      UPDATE sales
      SET agent_name = ?,
          amount = ?,
          carrier = ?,
          effective_date = ?
      WHERE source_message_id = ?
    `).run(
      updatedName,
      parsed.amount,
      parsed.carrier,
      parsed.effectiveDate,
      newMessage.id
    );

    await newMessage.channel.send(
      `✏️ Updated logged sale to ${money(parsed.amount)} for ${updatedName}.`
    );

    await requestSummaryRefresh();
  } catch (err) {
    console.error(err);
  }
});

client.login(process.env.DISCORD_TOKEN);