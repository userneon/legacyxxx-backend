import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { commandDefinitions, handleCommand } from "./commands.js";
import { config } from "./config.js";

const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
const commandRoute = config.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_GUILD_ID)
  : Routes.applicationCommands(config.DISCORD_APPLICATION_ID);

await rest.put(commandRoute, { body: commandDefinitions });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, readyClient => console.log(`[discord] ${readyClient.user.tag} is online`));
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) await handleCommand(interaction);
});
await client.login(config.DISCORD_BOT_TOKEN);
