const SunCalc = require("suncalc");
const { decode } = require("html-entities");
const REQUEST_TIMEOUT_MS = 15_000;

const parseChatIds = (value) => {
	try {
		return JSON.parse(value || "[]");
	} catch {
		return null;
	}
};

const CONFIG = {
	telegram: {
		token: process.env.TELEGRAM_TOKEN,
		chatIds: parseChatIds(process.env.TELEGRAM_CHAT_IDS),
		apiUrl: "https://api.telegram.org/bot",
	},
	plant: {
		id: process.env.PLANT_ID,
		apiUrl: process.env.API_URL,
	},
	location: {
		latitude: Number(process.env.LATITUDE),
		longitude: Number(process.env.LONGITUDE),
		timezone: process.env.TZ,
	},
	monitoring: {
		checkIntervalMinutes: 30,
		alertCooldownHours: 4,
		hoursToNotify: 1,
		sunriseBufferMinutes: 30,
		sunsetBufferMinutes: 30,
	},
	healthcheck: {
		url: process.env.HEALTHCHECK_URL,
	},
};

const validateConfig = (config = CONFIG, env = process.env) => {
	if (
		!config.telegram.token?.trim() ||
		!Array.isArray(config.telegram.chatIds) ||
		config.telegram.chatIds.length === 0 ||
		config.telegram.chatIds.some((id) => !String(id).trim()) ||
		!config.plant.id?.trim() ||
		!config.plant.apiUrl ||
		!config.location.timezone
	) {
		throw new Error("Missing or invalid required environment variables");
	}

	const { latitude, longitude } = config.location;
	if (
		!env.LATITUDE?.trim() ||
		!env.LONGITUDE?.trim() ||
		!Number.isFinite(latitude) ||
		!Number.isFinite(longitude) ||
		Math.abs(latitude) > 90 ||
		Math.abs(longitude) > 180
	) {
		throw new Error("Invalid latitude or longitude");
	}

	try {
		new Intl.DateTimeFormat("en", { timeZone: config.location.timezone });
		const url = new URL(config.plant.apiUrl);
		if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
	} catch {
		throw new Error("Invalid timezone or API URL");
	}
};

class SolarMonitor {
	#checking = false;
	#pendingRecovery = [];
	#state = {
		lastAlertByChat: new Map(),
		alertedChatIds: new Set(),
		lastEnergy: {
			value: null,
			timestamp: null,
			stagnantCount: 0,
		},
	};

	constructor({
		fetchImpl = fetch,
		now = () => new Date(),
		interval = setInterval,
		sunCalc = SunCalc,
	} = {}) {
		this.fetchImpl = fetchImpl;
		this.now = now;
		this.interval = interval;
		this.sunCalc = sunCalc;
		this.requiredStagnantReadings =
			Math.ceil(
				(CONFIG.monitoring.hoursToNotify * 60) /
					CONFIG.monitoring.checkIntervalMinutes,
			);
	}

	async #fetchSolarData() {
		try {
			const url = new URL(CONFIG.plant.apiUrl);
			url.searchParams.set("kk", CONFIG.plant.id);
			const response = await this.fetchImpl(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`Plant API returned ${response.status}`);
			const { success, data } = await response.json();

			if (!success) throw new Error("API response indicates failure");

			const parsedData = JSON.parse(decode(data));
			const { realTimePower, dailyEnergy } = parsedData.realKpi;

			const result = {
				power: Number(realTimePower),
				todayEnergy: Number(dailyEnergy),
			};
			if (!Number.isFinite(result.power) || !Number.isFinite(result.todayEnergy)) {
				throw new Error("Plant API returned invalid measurements");
			}
			return result;
		} catch (error) {
			console.error("Solar data fetch error:", error.message);
			await this.#sendMessage(
				"⚠️ Error al obtener datos de la instalación solar",
			);
			return null;
		}
	}

	async #sendMessage(message, isAlert = false, chatIds = CONFIG.telegram.chatIds) {
		const timestamp = this.now().toLocaleString("es-ES", {
			timeZone: CONFIG.location.timezone,
		});
		const formattedMessage = isAlert
			? `🔴 <b>Alerta Sistema Solar</b>\n\n${message}\n\nFecha: ${timestamp}`
			: message;

		const sendPromises = chatIds.map(async (chatId) => {
			try {
				const response = await this.fetchImpl(
					`${CONFIG.telegram.apiUrl}${CONFIG.telegram.token}/sendMessage`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: chatId,
							text: formattedMessage,
							parse_mode: "HTML",
						}),
						signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
					},
				);

				if (!response.ok) {
					const error = await response.json();
					throw new Error(`Telegram API error: ${error.description}`);
				}

				console.log(`[${timestamp}] Message sent to ${chatId}`);
				return { chatId, delivered: true };
			} catch (error) {
				console.error(
					`[${timestamp}] Failed to send message to ${chatId}:`,
					error.message,
				);
				return { chatId, delivered: false };
			}
		});

		const results = await Promise.all(sendPromises);
		return results.filter(({ delivered }) => !delivered).map(({ chatId }) => chatId);
	}

	#isSunUp() {
		const now = this.now();
		const times = this.sunCalc.getTimes(
			now,
			CONFIG.location.latitude,
			CONFIG.location.longitude,
		);
		const minuteInMs = 60 * 1000;

		const sunriseWithBuffer = new Date(
			times.sunrise.getTime() +
				CONFIG.monitoring.sunriseBufferMinutes * minuteInMs,
		);
		const sunsetWithBuffer = new Date(
			times.sunset.getTime() -
				CONFIG.monitoring.sunsetBufferMinutes * minuteInMs,
		);

		if (now <= sunriseWithBuffer || now >= sunsetWithBuffer) {
			const nextSunrise =
				now >= sunsetWithBuffer
					? new Date(times.sunrise.getTime() + 24 * 60 * 60 * 1000)
					: sunriseWithBuffer;

			console.log(
				`[${this.#formatDate(now)}] Monitoring paused until next sunrise: ${this.#formatDate(nextSunrise)}`,
			);
			return false;
		}

		return true;
	}

	#canSendAlert(chatId) {
		const lastAlert = this.#state.lastAlertByChat.get(chatId);
		if (lastAlert === undefined) return true;
		return (
			(this.now().getTime() - lastAlert) / (1000 * 60 * 60) >=
			CONFIG.monitoring.alertCooldownHours
		);
	}

	#formatDate(date) {
		return date.toLocaleString("es-ES", { timeZone: CONFIG.location.timezone });
	}

	async #checkEnergy(data) {
		const { lastEnergy } = this.#state;

		if (lastEnergy.value === null) {
			this.#state.lastEnergy = {
				value: data.todayEnergy,
				timestamp: this.now().getTime(),
				stagnantCount: 0,
			};
			console.log(
				`[${this.#formatDate(this.now())}] Daily energy: ${data.todayEnergy} kWh. Current power: ${data.power} kW`,
			);
			return;
		}

		if (data.todayEnergy === lastEnergy.value) {
			lastEnergy.stagnantCount++;
			console.log(
				`[${this.#formatDate(this.now())}] Energy unchanged - Daily Energy: ${data.todayEnergy} kWh. Power: ${data.power} kW - #${lastEnergy.stagnantCount}/${this.requiredStagnantReadings}`,
			);

			if (lastEnergy.stagnantCount >= this.requiredStagnantReadings) {
				const hoursStagnant =
					(this.now().getTime() - lastEnergy.timestamp) / (1000 * 60 * 60);
				await this.#sendAlert(
					`⚠️ Sistema solar posiblemente apagado. Energía diaria sin cambios durante ${hoursStagnant.toFixed(1)} horas.\n\nEnergía diaria: ${data.todayEnergy} kWh\nPotencia actual: ${data.power} kW`,
				);
			}
		} else {
			if (this.#state.alertedChatIds.size > 0) {
				const hoursStagnant =
					(this.now().getTime() - lastEnergy.timestamp) / (1000 * 60 * 60);
				const message = `✅ Producción de energía restablecida después de ${hoursStagnant.toFixed(1)} horas.\n\nEnergía diaria: ${data.todayEnergy} kWh\nPotencia actual: ${data.power} kW`;
				const failedChatIds = await this.#sendMessage(
					message,
					false,
					[...this.#state.alertedChatIds],
				);
				if (failedChatIds.length > 0) {
					this.#pendingRecovery.push({ message, chatIds: failedChatIds });
				}
			}
			console.log(
				`[${this.#formatDate(this.now())}] Energy updated - Daily Energy: ${data.todayEnergy} kWh. Power: ${data.power} kW`,
			);
			this.#state.lastEnergy = {
				value: data.todayEnergy,
				timestamp: this.now().getTime(),
				stagnantCount: 0,
			};
			this.#state.lastAlertByChat.clear();
			this.#state.alertedChatIds.clear();
		}
	}

	async #sendAlert(message) {
		const dueChatIds = CONFIG.telegram.chatIds.filter((chatId) =>
			this.#canSendAlert(chatId),
		);
		if (dueChatIds.length === 0) return;
		const failedChatIds = new Set(await this.#sendMessage(message, true, dueChatIds));
		for (const chatId of dueChatIds) {
			if (!failedChatIds.has(chatId)) {
				this.#state.lastAlertByChat.set(chatId, this.now().getTime());
				this.#state.alertedChatIds.add(chatId);
			}
		}
	}

	async #checkSystem() {
		const pendingRecovery = this.#pendingRecovery;
		this.#pendingRecovery = [];
		for (const { message, chatIds } of pendingRecovery) {
			const failedChatIds = await this.#sendMessage(message, false, chatIds);
			if (failedChatIds.length > 0) {
				this.#pendingRecovery.push({ message, chatIds: failedChatIds });
			}
		}

		if (CONFIG.healthcheck.url) {
			try {
				const response = await this.fetchImpl(CONFIG.healthcheck.url, {
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (!response.ok) {
					console.error(
						`[${this.#formatDate(this.now())}] Healthcheck failed: ${response.status}`,
					);
				}
			} catch (error) {
				console.error(
					`[${this.#formatDate(this.now())}] Healthcheck error:`,
					error.message,
				);
			}
		}

		if (!this.#isSunUp()) {
			this.#state = {
				lastAlertByChat: new Map(),
				alertedChatIds: new Set(),
				lastEnergy: {
					value: null,
					timestamp: null,
					stagnantCount: 0,
				},
			};
			return;
		}

		const data = await this.#fetchSolarData();
		if (data) {
			await this.#checkEnergy(data);
		}
	}

	async check() {
		if (this.#checking) {
			console.warn("Previous monitoring check is still running; skipping this interval");
			return false;
		}

		this.#checking = true;
		try {
			await this.#checkSystem();
			return true;
		} catch (error) {
			console.error("Monitoring check error:", error.message);
			return false;
		} finally {
			this.#checking = false;
		}
	}

	start() {
		console.log(
			`[${this.#formatDate(this.now())}] Starting solar system monitoring...`,
		);
		console.log(
			`[${this.#formatDate(this.now())}] Configured chat IDs:`,
			CONFIG.telegram.chatIds,
		);

		this.interval(
			() => void this.check(),
			CONFIG.monitoring.checkIntervalMinutes * 60 * 1000,
		);
		void this.check();
	}
}

module.exports = { SolarMonitor, validateConfig, CONFIG };

if (require.main === module) {
	try {
		validateConfig();
		const monitor = new SolarMonitor();
		monitor.start();
	} catch (error) {
		console.error("Startup error:", error.message);
		process.exit(1);
	}
}
