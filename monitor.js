const SunCalc = require("suncalc");
const { decode } = require("html-entities");

const CONFIG = {
	telegram: {
		token: process.env.TELEGRAM_TOKEN,
		chatIds: JSON.parse(process.env.TELEGRAM_CHAT_IDS || "[]"),
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

const validateConfig = () => {
	const required = [
		CONFIG.telegram.token,
		CONFIG.telegram.chatIds.length,
		CONFIG.plant.id,
		CONFIG.location.latitude,
		CONFIG.location.longitude,
		CONFIG.location.timezone,
	];

	if (required.some((value) => !value)) {
		throw new Error("Missing required environment variables");
	}
};

class SolarMonitor {
	#state = {
		lastAlert: null,
		lastEnergy: {
			value: null,
			timestamp: null,
			stagnantCount: 0,
		},
		alertSent: false,
	};

	constructor() {
		this.requiredStagnantReadings =
			(CONFIG.monitoring.hoursToNotify * 60) /
			CONFIG.monitoring.checkIntervalMinutes;
	}

	async #fetchSolarData() {
		try {
			const url = `${CONFIG.plant.apiUrl}?kk=${CONFIG.plant.id}`;
			const response = await fetch(url);
			const { success, data } = await response.json();

			if (!success) throw new Error("API response indicates failure");

			const parsedData = JSON.parse(decode(data));
			const { realTimePower, dailyEnergy } = parsedData.realKpi;

			return {
				power: Number(realTimePower),
				todayEnergy: Number(dailyEnergy),
			};
		} catch (error) {
			console.error("Solar data fetch error:", error.message);
			await this.#sendMessage(
				"⚠️ Error al obtener datos de la instalación solar",
			);
			return null;
		}
	}

	async #sendMessage(message, isAlert = false) {
		const timestamp = new Date().toLocaleString("es-ES", {
			timeZone: CONFIG.location.timezone,
		});
		const formattedMessage = isAlert
			? `🔴 <b>Alerta Sistema Solar</b>\n\n${message}\n\nFecha: ${timestamp}`
			: message;

		const sendPromises = CONFIG.telegram.chatIds.map(async (chatId) => {
			try {
				const response = await fetch(
					`${CONFIG.telegram.apiUrl}${CONFIG.telegram.token}/sendMessage`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: chatId,
							text: formattedMessage,
							parse_mode: "HTML",
						}),
					},
				);

				if (!response.ok) {
					const error = await response.json();
					throw new Error(`Telegram API error: ${error.description}`);
				}

				console.log(`[${timestamp}] Message sent to ${chatId}`);
			} catch (error) {
				console.error(
					`[${timestamp}] Failed to send message to ${chatId}:`,
					error.message,
				);
			}
		});

		await Promise.all(sendPromises);
	}

	#isSunUp() {
		const now = new Date();
		const times = SunCalc.getTimes(
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

	#canSendAlert() {
		if (!this.#state.lastAlert) return true;
		return (
			(Date.now() - this.#state.lastAlert) / (1000 * 60 * 60) >=
			CONFIG.monitoring.alertCooldownHours
		);
	}

	#formatDate(date) {
		return date.toLocaleString("es-ES", { timeZone: CONFIG.location.timezone });
	}

	async #checkEnergy(data) {
		const { lastEnergy } = this.#state;

		if (!lastEnergy.value) {
			this.#state.lastEnergy = {
				value: data.todayEnergy,
				timestamp: Date.now(),
				stagnantCount: 0,
			};
			console.log(
				`[${this.#formatDate(new Date())}] Daily energy: ${data.todayEnergy} kWh. Current power: ${data.power} kW`,
			);
			return;
		}

		if (data.todayEnergy === lastEnergy.value) {
			lastEnergy.stagnantCount++;
			console.log(
				`[${this.#formatDate(new Date())}] Energy unchanged - Daily Energy: ${data.todayEnergy} kWh. Power: ${data.power} kW - #${lastEnergy.stagnantCount}/${this.requiredStagnantReadings}`,
			);

			if (
				lastEnergy.stagnantCount >= this.requiredStagnantReadings &&
				!this.#state.alertSent
			) {
				const hoursStagnant =
					(Date.now() - lastEnergy.timestamp) / (1000 * 60 * 60);
				await this.#sendAlert(
					`⚠️ Sistema solar posiblemente apagado. Energía diaria sin cambios durante ${hoursStagnant.toFixed(1)} horas.\n\nEnergía diaria: ${data.todayEnergy} kWh\nPotencia actual: ${data.power} kW`,
				);
				this.#state.alertSent = true;
			}
		} else {
			if (this.#state.alertSent) {
				const hoursStagnant =
					(Date.now() - lastEnergy.timestamp) / (1000 * 60 * 60);
				await this.#sendMessage(
					`✅ Producción de energía restablecida después de ${hoursStagnant.toFixed(1)} horas.\n\nEnergía diaria: ${data.todayEnergy} kWh\nPotencia actual: ${data.power} kW`,
				);
			}
			console.log(
				`[${this.#formatDate(new Date())}] Energy updated - Daily Energy: ${data.todayEnergy} kWh. Power: ${data.power} kW`,
			);
			this.#state.lastEnergy = {
				value: data.todayEnergy,
				timestamp: Date.now(),
				stagnantCount: 0,
			};
			this.#state.alertSent = false;
		}
	}

	async #sendAlert(message) {
		if (!this.#canSendAlert()) return;
		await this.#sendMessage(message, true);
		this.#state.lastAlert = Date.now();
	}

	async #checkSystem() {
		if (CONFIG.healthcheck.url) {
			try {
				const response = await fetch(CONFIG.healthcheck.url);
				if (!response.ok) {
					console.error(
						`[${this.#formatDate(new Date())}] Healthcheck failed: ${response.status}`,
					);
				}
			} catch (error) {
				console.error(
					`[${this.#formatDate(new Date())}] Healthcheck error:`,
					error.message,
				);
			}
		}

		if (!this.#isSunUp()) {
			this.#state = {
				lastAlert: null,
				lastEnergy: {
					value: null,
					timestamp: null,
					stagnantCount: 0,
				},
				alertSent: false,
			};
			return;
		}

		const data = await this.#fetchSolarData();
		if (data) {
			await this.#checkEnergy(data);
		}
	}

	start() {
		console.log(
			`[${this.#formatDate(new Date())}] Starting solar system monitoring...`,
		);
		console.log(
			`[${this.#formatDate(new Date())}] Configured chat IDs:`,
			CONFIG.telegram.chatIds,
		);

		setInterval(
			() => this.#checkSystem(),
			CONFIG.monitoring.checkIntervalMinutes * 60 * 1000,
		);
		this.#checkSystem();
	}
}

try {
	validateConfig();
	const monitor = new SolarMonitor();
	monitor.start();
} catch (error) {
	console.error("Startup error:", error.message);
	process.exit(1);
}
