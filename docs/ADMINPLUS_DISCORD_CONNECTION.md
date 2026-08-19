# LEGACY-X AdminPlus → Discord холболт

AdminPlus-д Discord integration нь optional backend webhook notifier хэлбэрээр хэрэгжсэн. CS2 server болон dashboard-ийн амжилттай admin action бүрт `LEGACY-X AdminPlus` embed үүсэж, тохируулсан staff channel руу илгээнэ. Webhook ашиглахад Discord bot token шаардлагагүй; харин webhook URL өөрөө credential тул зөвхөн server `.env`-д хадгална.

## 1. Discord webhook үүсгэх

Discord server дээр staff/admin audit зориулсан тусдаа channel үүсгэнэ. Channel-ийн **Integrations → Webhooks → New Webhook** хэсгээс webhook үүсгэж нэрийг `LEGACY-X AdminPlus` гэж өгнө. Зөвхөн admin action харах staff channel сонгоно; public chat channel-д webhook байрлуулахгүй.

Webhook URL-г copy хийсний дараа чат, ticket, GitHub issue, screenshot болон log-д бүтнээр нь тавихгүй. URL алдагдсан гэж сэжиглэвэл Discord дээр webhook-ийг regenerate эсвэл delete хийж шинэ URL үүсгэнэ.

## 2. Backend configuration

`adminplus/backend/.env` дотор:

```dotenv
DISCORD_WEBHOOK_ENABLED=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/real-id/real-token
```

Дараа нь process restart хийнэ.

```bash
pm2 restart legacy-x-adminplus --update-env
pm2 logs legacy-x-adminplus --lines 100
```

Invalid domain эсвэл missing URL үед notification disabled behavior-тай үлдэж, CS2 action өөрөө ажиллах ёстой; Discord failure нь RCON action-ийг буцааж унтраахгүй.

## 3. Илгээгдэх мэдээлэл

| Field | Meaning |
|---|---|
| `Action` | `player.kick`, `server.change_map` зэрэг operation |
| `Target` | `player:userid`, `server` эсвэл workshop map ID |
| `Request ID` | API request tracing identifier |
| `Metadata` | Team, amount, HP, weapon, map mode зэрэг non-secret context |
| Timestamp | Backend action амжилттай болсон server time |

`LEGACYX_AUDIT_INCLUDE_COMMANDS=false` default хэвээр байх ёстой. Энэ тохиргоо нь raw RCON command-ийг database audit metadata-д хадгалахгүй байлгадаг; Discord embed-д мөн command secret дамжуулахгүй.

## 4. Discord bot шаардлагатай эсэх

Энэ implementation-д webhook notification-д bot application шаардлагагүй. Хэрэв LEGACY-X цаашид Discord slash command-оос CS2 action trigger хийхийг хүсвэл тусдаа bot service, Discord interaction signature verification, role allowlist болон outbound command audit нэмэх шаардлагатай. Одоогийн production setup нь зөвхөн CS2 dashboard action-ийг Discord руу мэдэгдэнэ; Discord-оос сервер удирдах inbound command flow санаатайгаар enable хийгдээгүй.

## 5. Test checklist

Production channel руу туршилтын action хийхээс өмнө webhook URL зөв эсэхийг staging channel дээр шалгана. AdminPlus dashboard-аар test server-ийн нэг тоглогчийн HP-г аюулгүй утгаар өөрчлөөд Discord embed, Supabase audit row, PM2 log гурвыг зэрэг шалгана. RCON failure гарсан action Discord руу `success` embed үүсгэх ёсгүй.

## Security note

Webhook URL нь Discord channel-д message post хийх эрхтэй credential. `.env` permission-ийг `chmod 600` байлгаж, PM2 ecosystem file, browser bundle, Nginx public config болон GitHub repository-д URL оруулахгүй. Discord channel-ийн access-ийг staff role-оор хязгаарлана.

## References

[1]: https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks "Discord webhook introduction and management"
[2]: https://github.com/dede177/cs2-admin-plus "Upstream Admin Plus panel architecture"
