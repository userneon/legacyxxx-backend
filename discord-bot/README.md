# LEGACY-X Discord Bot

The bot is a separate Node.js service inside the backend repository. It is intentionally **not** a browser client and it does not expose Discord secrets to the website. Discord credentials, channel IDs, staff role IDs, and the Root API `bot:read` service token are held only in `discord-bot/.env`.

## Commands

| Group | Commands | Status |
|---|---|---|
| Community | `/help`, `/status`, `/servers`, `/leaders`, `/profile`, `/rank`, `/level`, `/clan` | Reads live Root API public data |
| CS2 | `/match`, `/reconnect` | Ready; activates fuller live data after game server/plugin deployment |
| Wallet | `/wallet`, `/qpay` | Sends users to the secure website wallet; never collects payment data in Discord |
| Safety | `/report` | Sends private report embeds to configured report channel |
| Staff | `/staff announce`, `/staff warn`, `/staff timeout`, `/staff mute`, `/staff unmute`, `/staff ban`, `/staff unban`, `/staff penalties`, `/staff role` | Permission-gated framework; announcement works when channel is configured, database moderation actions require the dedicated bot authorization endpoint |

## Local setup

```bash
cd discord-bot
cp .env.example .env
npm install
npm run check
npm run build
npm run dev
```

For immediate development command updates, set `DISCORD_GUILD_ID`; without it, Discord global command propagation can take longer.

## Production requirements

1. Create a Discord Application + Bot, then add its token, Application ID, and Guild ID to `discord-bot/.env`.
2. Create a separate Root API `api_tokens` entry with only the `bot:read` scope and put the plaintext token only in `LEGACYX_BOT_API_TOKEN`. The bot profile endpoint returns public summary data only: it never returns wallet balance, links, refresh tokens, or private account fields.
3. Invite it with `bot` and `applications.commands` scopes. Start with only View Channels, Send Messages, Embed Links, Read Message History, and Use Application Commands. Add moderation permissions only when staff execution is enabled.
4. Configure report/announcement channel IDs and comma-separated staff role IDs.
5. Run as a dedicated persistent service; never commit `.env`, never run the bot from a browser bundle, and never paste payment, Discord, Steam, or Root API secrets into a command.
