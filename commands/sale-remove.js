import { SlashCommandBuilder } from "discord.js";
import db from "../db/init.js";

export default {
  data: new SlashCommandBuilder()
    .setName("sale-remove")
    .setDescription("Remove sale by ID")
    .addIntegerOption(opt =>
      opt.setName("id").setDescription("Sale ID").setRequired(true)
    ),

  async execute(interaction) {
    const id = interaction.options.getInteger("id");

    db.prepare(`DELETE FROM sales WHERE id = ?`).run(id);

    await interaction.reply(`Deleted sale ${id}`);
  }
};