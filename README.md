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
   git clone https://github.com/acamposcar/solar-monitor.git
   cd solar-monitor

2. Install dependencies (if running locally)
   npm install

3. Configure environment variables (see example below).

4. Run
   node monitor.js

Or run with Docker (see Docker section).

## Configuration

Create a .env or provide environment variables in your runtime environment. Example keys:

- TELEGRAM_TOKEN — Telegram bot token (e.g. `123456:ABC-...`)
- TELEGRAM_CHAT_IDS — JSON array of chat IDs (example: '["12345","67890"]' or `[12345,67890]`)
- PLANT_ID — Plant identifier used by your API
- API_URL — Base URL for the plant API (the script calls: `${API_URL}?kk=${PLANT_ID}`)
- LATITUDE — Plant latitude (number)
- LONGITUDE — Plant longitude (number)
- TZ — Timezone (IANA string, used for timestamp formatting and SunCalc)
- HEALTHCHECK_URL — (optional) URL to ping every run (useful for monitoring)

Example (.env)
TELEGRAM_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_IDS='["11111111","22222222"]'
PLANT_ID=xxxxxxx
API_URL=https://example-fusion-solar-api.local/data
LATITUDE=40.4168
LONGITUDE=-3.7038
TZ=Europe/Madrid
HEALTHCHECK_URL=

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
- After an alert, the script waits `alertCooldownHours` before sending another alert.
- When dailyEnergy increases again, a recovery message is sent.

Sunlight handling:
- Uses SunCalc to compute sunrise/sunset for given coordinates and TZ.
- Monitoring is disabled until sunrise+buffer and paused after sunset-buffer.
- When monitoring resumes after night, internal state is reset.

Healthcheck:
- If HEALTHCHECK_URL is set, the script will GET it on each run. Non-OK responses are logged.

## Docker

Build the image:
  docker build -t solar-monitor .

Run with env:
  docker run -d \
    --env TELEGRAM_TOKEN="$TELEGRAM_TOKEN" \
    --env TELEGRAM_CHAT_IDS="$TELEGRAM_CHAT_IDS" \
    --env PLANT_ID="$PLANT_ID" \
    --env API_URL="$API_URL" \
    --env LATITUDE="$LATITUDE" \
    --env LONGITUDE="$LONGITUDE" \
    --env TZ="$TZ" \
    --env HEALTHCHECK_URL="$HEALTHCHECK_URL" \
    --name solar-monitor \
    solar-monitor

Or use the provided `docker-compose.yml`:
  docker-compose up -d

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
