import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} from "discord.js";

export default {
  data: new SlashCommandBuilder()
    .setName("sale-add")
    .setDescription("Add a sale"),

  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId("saleModal")
      .setTitle("Add Sale");

    const amount = new TextInputBuilder()
      .setCustomId("amount")
      .setLabel("Amount")
      .setStyle(TextInputStyle.Short);

    const row = new ActionRowBuilder().addComponents(amount);

    modal.addComponents(row);

    await interaction.showModal(modal);
  }
};