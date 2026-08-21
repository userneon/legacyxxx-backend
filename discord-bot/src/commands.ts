import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { config } from "./config.js";
import { apiGet, compactNumber, RootApiError } from "./root-api.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("help").setDescription("LEGACY-X bot commands"),
  new SlashCommandBuilder().setName("status").setDescription("LEGACY-X community status"),
  new SlashCommandBuilder().setName("servers").setDescription("Live LEGACY-X CS2 servers"),
  new SlashCommandBuilder().setName("leaders").setDescription("Season leaderboard").addIntegerOption(option => option.setName("limit").setDescription("1-10").setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName("profile").setDescription("LEGACY-X player profile by SteamID64").addStringOption(option => option.setName("steamid").setDescription("17-digit SteamID64").setRequired(true)),
  new SlashCommandBuilder().setName("rank").setDescription("Player rank by SteamID64").addStringOption(option => option.setName("steamid").setDescription("17-digit SteamID64").setRequired(true)),
  new SlashCommandBuilder().setName("level").setDescription("Player level by SteamID64").addStringOption(option => option.setName("steamid").setDescription("17-digit SteamID64").setRequired(true)),
  new SlashCommandBuilder().setName("clan").setDescription("Find a LEGACY-X clan").addStringOption(option => option.setName("name").setDescription("Clan name or tag").setRequired(true)),
  new SlashCommandBuilder().setName("match").setDescription("Current LEGACY-X matches"),
  new SlashCommandBuilder().setName("reconnect").setDescription("Reconnect help and last-played guidance"),
  new SlashCommandBuilder().setName("wallet").setDescription("Wallet and QPay help"),
  new SlashCommandBuilder().setName("qpay").setDescription("QPay top-up help"),
  new SlashCommandBuilder().setName("report").setDescription("Send a private community report").addStringOption(option => option.setName("message").setDescription("What happened?").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("staff").setDescription("Staff-only community actions")
    .addStringOption(option => option.setName("action").setDescription("announce | penalties | warn | timeout | mute | unmute | ban | unban | role").setRequired(true))
    .addUserOption(option => option.setName("member").setDescription("Target Discord member"))
    .addStringOption(option => option.setName("reason").setDescription("Reason or announcement text").setMaxLength(1000)),
].map(command => command.toJSON());

function errorMessage(error: unknown) {
  if (error instanceof RootApiError && error.status === 404) return "No LEGACY-X record was found for that SteamID64.";
  if (error instanceof RootApiError) return `LEGACY-X API: ${error.message}`;
  return "The LEGACY-X service is temporarily unavailable. Please try again shortly.";
}

function staffAllowed(interaction: ChatInputCommandInteraction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!config.staffRoleIds.size || !interaction.inCachedGuild()) return false;
  return interaction.member.roles.cache.some(role => config.staffRoleIds.has(role.id));
}

export async function handleCommand(interaction: ChatInputCommandInteraction) {
  try {
    switch (interaction.commandName) {
      case "help":
        await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x10b981).setTitle("LEGACY-X Bot Commands").setDescription("`/status` `/servers` `/leaders` `/profile` `/rank` `/level` `/clan` `/match` `/reconnect` `/wallet` `/qpay` `/report`\n\nStaff: `/staff action member reason`") ] });
        return;
      case "status": {
        const data = await apiGet<{ playersOnline: number; liveServers: number; matchesToday: number; activeClans: number }>("/public/overview");
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x10b981).setTitle("LEGACY-X Live Status").addFields(
          { name: "Players online", value: String(data.playersOnline), inline: true }, { name: "Live servers", value: String(data.liveServers), inline: true }, { name: "Matches today", value: String(data.matchesToday), inline: true }, { name: "Active clans", value: String(data.activeClans), inline: true })] });
        return;
      }
      case "servers": {
        const result = await apiGet<{ servers?: Array<{ name: string; map: string; mode: string; players: number; maxPlayers: number; address: string }> }>("/public/servers");
        const lines = (result.servers ?? []).slice(0, 10).map(server => `**${server.name}** — ${server.players}/${server.maxPlayers} · ${server.map} · ${server.mode}\n\`${server.address}\``);
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("LEGACY-X Servers").setDescription(lines.join("\n\n") || "No live servers currently reported.")] });
        return;
      }
      case "leaders": {
        const result = await apiGet<{ season?: string; entries?: Array<{ position: number; username: string; rating: number; rank: string }> }>(`/public/rank/leaderboard?limit=${interaction.options.getInteger("limit") ?? 5}`);
        const lines = (result.entries ?? []).map(entry => `**#${entry.position} ${entry.username}** · ${compactNumber(entry.rating)} ELO · ${entry.rank}`);
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle(`LEGACY-X Leaders · ${result.season ?? "Current Season"}`).setDescription(lines.join("\n") || "No ranked players yet.")] });
        return;
      }
      case "profile":
      case "rank":
      case "level": {
        const steamId = interaction.options.getString("steamid", true);
        if (!/^7656\d{13}$/.test(steamId)) { await interaction.reply({ ephemeral: true, content: "Enter a valid 17-digit SteamID64 starting with `7656`." }); return; }
        const profile = await apiGet<{ username: string; steamId: string; avatar?: string; role?: string; level?: number; rank?: string; balance?: number }>(`/profile/${steamId}`);
        const embed = new EmbedBuilder().setColor(0x10b981).setTitle(profile.username).setURL(`https://legacyx.cc/profile/${profile.steamId}`).addFields(
          { name: "Role", value: profile.role ?? "Player", inline: true }, { name: "Rank", value: profile.rank ?? "Unranked", inline: true }, { name: "Level", value: String(profile.level ?? 0), inline: true });
        if (profile.avatar) embed.setThumbnail(profile.avatar);
        await interaction.reply({ embeds: [embed] });
        return;
      }
      case "clan": {
        const name = encodeURIComponent(interaction.options.getString("name", true));
        const result = await apiGet<{ data?: Array<{ name: string; tag?: string; memberCount?: number; seasonScore?: number }> }>(`/clans?search=${name}`);
        const clan = result.data?.[0];
        await interaction.reply(clan ? { embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle(`${clan.name} ${clan.tag ? `[${clan.tag}]` : ""}`).setDescription(`${clan.memberCount ?? 0} members · ${clan.seasonScore ?? 0} season score`)] } : { ephemeral: true, content: "No matching LEGACY-X clan was found." });
        return;
      }
      case "match":
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle("LEGACY-X Matches").setDescription("Live match feed will activate when the CS2 server and Match Core plugin are deployed. Use `/servers` for current server availability.")] });
        return;
      case "reconnect":
        await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle("Reconnect").setDescription("Once the CS2 server is live, `/reconnect` will show your most recently played LEGACY-X server. For now, use the website Servers page.")] });
        return;
      case "wallet":
      case "qpay":
        await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x16458b).setTitle("LEGACY-X Wallet").setDescription("Wallet and QPay top-ups are completed securely on the LEGACY-X website: https://legacyx.cc/wallet\n\nNever send payment details or screenshots to a Discord user.")] });
        return;
      case "report": {
        const message = interaction.options.getString("message", true);
        if (!config.DISCORD_REPORT_CHANNEL_ID || !interaction.guild) { await interaction.reply({ ephemeral: true, content: "Reporting channel is not configured yet. Please contact LEGACY-X staff." }); return; }
        const channel = await interaction.guild.channels.fetch(config.DISCORD_REPORT_CHANNEL_ID);
        if (!(channel instanceof TextChannel)) { await interaction.reply({ ephemeral: true, content: "Reporting channel configuration is invalid." }); return; }
        await channel.send({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Community Report").setDescription(message).addFields({ name: "Reporter", value: `${interaction.user.tag} · ${interaction.user.id}` }).setTimestamp()] });
        await interaction.reply({ ephemeral: true, content: "Your report has been sent privately to LEGACY-X staff." });
        return;
      }
      case "staff": {
        if (!staffAllowed(interaction)) { await interaction.reply({ ephemeral: true, content: "This command is restricted to LEGACY-X staff." }); return; }
        const action = interaction.options.getString("action", true).toLowerCase();
        const member = interaction.options.getUser("member");
        const reason = interaction.options.getString("reason") ?? "No reason supplied";
        if (action === "announce" && config.DISCORD_ANNOUNCEMENT_CHANNEL_ID && interaction.guild) {
          const channel = await interaction.guild.channels.fetch(config.DISCORD_ANNOUNCEMENT_CHANNEL_ID);
          if (channel instanceof TextChannel) await channel.send({ embeds: [new EmbedBuilder().setColor(0x10b981).setTitle("LEGACY-X Announcement").setDescription(reason).setFooter({ text: `Posted by ${interaction.user.tag}` })] });
          await interaction.reply({ ephemeral: true, content: "Announcement posted." });
          return;
        }
        await interaction.reply({ ephemeral: true, content: `Staff action queued for review: **${action}**${member ? ` · ${member.tag}` : ""}\nReason: ${reason}\n\nDatabase-backed moderation actions will activate after the dedicated bot authorization endpoint is enabled.` });
        return;
      }
      default:
        await interaction.reply({ ephemeral: true, content: "Unknown LEGACY-X bot command." });
    }
  } catch (error) {
    const payload = { ephemeral: true, content: errorMessage(error) };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload); else await interaction.reply(payload);
  }
}
