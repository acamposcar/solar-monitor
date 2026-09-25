# Solar Monitor (FusionSolar)

Solar Monitor watches a FusionSolar-like installation and notifies configured Telegram chats if the plant appears to be down (no increase in daily energy over a configurable period). It is a small Node.js script that can run directly or inside Docker.

## Features
- Polls a FusionSolar-style API periodically for real-time power and daily energy.
- Detects "stagnant" daily energy (no increase) and sends alerts when production likely stopped.
- Sends alerts and recovery notifications to one or more Telegram chats (HTML formatted).
- Only monitors during daylight hours using SunCalc (with configurable buffers).
- Optional healthcheck ping for external uptime monitoring.
- Simple configuration via environment variables.

## Quick Start

1. Clone the repository
   - git clone https://github.com/acamposcar/solar-monitor.git
   - cd solar-monitor

2. Install dependencies (if running locally)
   - npm install

3. Configure environment variables (see example below).

4. Run
   - node monitor.js

Or run with Docker (see Docker section).

## Configuration

Create a .env or provide environment variables in your runtime environment. Example keys:

- TELEGRAM_TOKEN — Telegram bot token
- TELEGRAM_CHAT_IDS — JSON array of chat ID
- PLANT_ID — Plant identifier used by your API
- API_URL — Base URL for the plant API
- LATITUDE — Plant latitude (number)
- LONGITUDE — Plant longitude (number)
- TZ — Timezone (IANA string, used for timestamp formatting and SunCalc)
- HEALTHCHECK_URL — (optional) URL to ping every run (useful for monitoring)

Notes:
- TELEGRAM_CHAT_IDS must be parseable JSON string in the environment.
- Ensure your bot can send messages to the target chat(s) (added to groups if needed).

## Behavior and Tuning

Default monitoring settings (in `monitor.js` under CONFIG.monitoring):
- checkIntervalMinutes: 30
- alertCooldownHours: 4
- hoursToNotify: 1
- sunriseBufferMinutes: 30
- sunsetBufferMinutes: 30

Alert logic:
- requiredStagnantReadings = (hoursToNotify * 60) / checkIntervalMinutes
- If dailyEnergy remains unchanged across `requiredStagnantReadings` checks during daylight, an alert is sent.
- After a delivered alert, the script waits `alertCooldownHours` before sending
  another alert to that chat. Failed deliveries are retried at the next check.
- When dailyEnergy increases again, a recovery message is sent to chats that
  received an alert. Failed recovery messages are retried at the next check.
- HTTP requests time out after 15 seconds. If a check is still running when the
  next interval starts, that interval is skipped.

Sunlight handling:
- Uses SunCalc to compute sunrise/sunset for given coordinates and TZ.
- Monitoring is disabled until sunrise+buffer and paused after sunset-buffer.
- When monitoring resumes after night, internal state is reset.

Healthcheck:
- If HEALTHCHECK_URL is set, the script will GET it on each run. Non-OK responses are logged.

## Docker

The Compose stack builds the image from this repository on the Docker host. On an
ARM64 host this produces an ARM64 image; no emulation or registry login is needed.
The image uses Node.js 24 and exposes no ports. No persistent volume is required;
monitoring state is kept in memory and starts fresh after a restart.

For a command-line deployment, copy `.env.example` to `.env`, replace the sample
values with your own, then run:

```sh
docker compose up -d --build
docker compose logs -f solar-monitor
```

The `.env` file is ignored by Git. Keep your Telegram token and any optional
healthcheck URL out of the repository.

Run the automated tests with `npm test` after `npm ci`.

### Dockhand (Git stack)

1. Add `https://github.com/acamposcar/solar-monitor.git` as a public Git
   repository in Dockhand. No Git credential is needed for this repository.
2. Create a stack **From Git** on the ARM64 Docker environment. Select the
   repository and `main` branch, set the Compose path to `docker-compose.yml`,
   and enable **Build images on deploy**.
3. In the stack's **Environment** tab, set `TELEGRAM_TOKEN`,
   `TELEGRAM_CHAT_IDS`, `PLANT_ID`, `LATITUDE`, and `LONGITUDE`. Set `TZ`,
   `API_URL`, and `HEALTHCHECK_URL` there if you need different values. Use a
   JSON array for chat IDs, for example `["123456789"]`. Mark
   `TELEGRAM_TOKEN`, `PLANT_ID`, and any private `HEALTHCHECK_URL` as secrets
   in Dockhand; do not add real values to Git. These values are passed to the
   container as environment variables and remain visible to Docker admins.
4. Deploy the stack and inspect its logs. A successful start logs
   `Starting solar system monitoring...`; checks run every 30 minutes during
   daylight. The first check also runs immediately.

Dockhand fetches commits from GitHub; a local clone on the Docker host does not
make unpushed changes available to a Git stack. Restrict access to Dockhand's
admin interface because it can control the Docker host.

## Troubleshooting

- Missing required environment variables error:
  Ensure TELEGRAM_TOKEN, TELEGRAM_CHAT_IDS, PLANT_ID, LATITUDE, LONGITUDE and TZ are set.

- Telegram errors:
  Verify bot token and that the bot is allowed to message the chat(s). For groups, add the bot to the group.

- Fetch issues in Node:
  Use Node 18+ (which has global fetch). If using an older Node, add a fetch polyfill (e.g., node-fetch) and adapt the code.

- Parsing errors:
  The script expects the API to return JSON with an encoded JSON string in `data` where `realKpi` contains `realTimePower` and `dailyEnergy`. Update API_URL or parsing if your endpoint differs.

## Files of interest
- monitor.js — main script that implements monitoring and Telegram notifications.
- Dockerfile — container build file.
- docker-compose.yml — example compose configuration.
- .env.example — example environment file.
- LICENSE — licensing information.

## Contributing
Contributions are welcome. Open an issue to discuss changes or submit a pull request. If you'd like to make configuration fully environment-driven (rather than hard-coded defaults), a PR to expose those settings is a good place to start.

## License
See the LICENSE file in the repository.
