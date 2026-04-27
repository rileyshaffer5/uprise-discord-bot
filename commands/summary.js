import { SlashCommandBuilder } from "discord.js";
import db from "../db/init.js";

export default {
  data: new SlashCommandBuilder()
    .setName("summary")
    .setDescription("Show total sales"),

  async execute(interaction) {
    const row = db.prepare(`
      SELECT COUNT(*) as count, SUM(amount) as total FROM sales
    `).get();

    await interaction.reply(
      `Sales: ${row.count}\nTotal: $${row.total || 0}`
    );
  }
};