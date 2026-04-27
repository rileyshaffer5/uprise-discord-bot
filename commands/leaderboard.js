import { SlashCommandBuilder } from "discord.js";
import db from "../db/init.js";

export default {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Top sellers"),

  async execute(interaction) {
    const rows = db.prepare(`
      SELECT agent_name, SUM(amount) as total
      FROM sales
      GROUP BY agent_name
      ORDER BY total DESC
      LIMIT 5
    `).all();

    let text = "**Leaderboard**\n";

    rows.forEach((r, i) => {
      text += `${i + 1}. ${r.agent_name} - $${r.total}\n`;
    });

    await interaction.reply(text);
  }
};