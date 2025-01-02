const SunCalc = require("suncalc");
const { decode } = require("html-entities");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_IDS = JSON.parse(process.env.TELEGRAM_CHAT_IDS);
const PLANT_ID = process.env.PLANT_ID;
const LATITUDE = Number.parseFloat(process.env.LATITUDE);
const LONGITUDE = Number.parseFloat(process.env.LONGITUDE);
const TIMEZONE = process.env.TZ;
const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL;

if (
	!TELEGRAM_TOKEN ||
	TELEGRAM_CHAT_IDS.length === 0 ||
	!PLANT_ID ||
	!LATITUDE ||
	!LONGITUDE ||
	!TIMEZONE
) {
	console.error("Error: Faltan variables de entorno");
	process.exit(1);
}

class SolarMonitor {
	constructor(telegramToken, telegramChatIds) {
		this.latitude = LATITUDE;
		this.longitude = LONGITUDE;
		this.telegramToken = telegramToken;
		this.telegramChatIds = Array.isArray(telegramChatIds)
			? telegramChatIds
			: [telegramChatIds];

		// Configuración de intervalos y tiempos
		this.checkIntervalMinutes = 10;
		this.hoursToNotifyPower = 1;
		this.hoursToNotifyEnergy = 1;
		this.sunriseBufferMinutes = 30; // Buffer después del amanecer
		this.sunsetBufferMinutes = 30; // Buffer antes del atardecer

		// Cálculo de lecturas necesarias basado en los intervalos
		this.requiredZeroReadings =
			(this.hoursToNotifyPower * 60) / this.checkIntervalMinutes;
		this.requiredStagnantReadings =
			(this.hoursToNotifyEnergy * 60) / this.checkIntervalMinutes;

		// Contadores y estado
		this.zeroReadingsCount = 0;
		this.lastAlert = null;
		this.alertCooldownHours = 4;
		this.lastTodayEnergy = null;
		this.lastTodayEnergyUpdate = null;
		this.todayEnergyStagnantCount = 0;
		this.energyAlertSent = false;

		this.apiUrl =
			"https://uni001eu5.fusionsolar.huawei.com/rest/pvms/web/kiosk/v1/station-kiosk-file";
	}

	formatDate(date) {
		return date.toLocaleString("es-ES", { timeZone: TIMEZONE });
	}
	async getCurrentPowerAndEnergy() {
		try {
			const url = `${this.apiUrl}?kk=${PLANT_ID}`;
			const response = await fetch(url);
			const jsonData = await response.json();
			if (!jsonData.success) {
				throw new Error("API response indicates failure");
			}
			const decodedData = decode(jsonData.data);
			const parsedData = JSON.parse(decodedData);
			const currentPower = parsedData.realKpi.realTimePower;
			const todayEnergy = parsedData.realKpi.dailyEnergy;
			return {
				power: Number.parseFloat(currentPower),
				todayEnergy: Number.parseFloat(todayEnergy),
			};
		} catch (error) {
			console.error(
				"Error al obtener datos de la instalación solar:",
				error.message,
			);
			await this.sendTelegramMessage(
				"⚠️ Error al obtener datos de la instalación solar",
			);
			return null;
		}
	}
	async pingHealthcheck() {
		try {
			const response = await fetch(HEALTHCHECK_URL);
			if (!response.ok) {
				console.error(
					`[${this.formatDate(new Date())}] Error en healthcheck ping: ${response.status}`,
				);
			} else {
				console.log(
					`[${this.formatDate(new Date())}] Healthcheck ping enviado correctamente`,
				);
			}
		} catch (error) {
			console.error(
				`[${this.formatDate(new Date())}] Error al enviar healthcheck ping:`,
				error.message,
			);
		}
	}
	isSunUp() {
		const times = SunCalc.getTimes(new Date(), this.latitude, this.longitude);
		const now = new Date();
		const minuteInMs = 60 * 1000;
		// Añadir buffer después del amanecer
		const sunriseWithBuffer = new Date(
			times.sunrise.getTime() + this.sunriseBufferMinutes * minuteInMs,
		);
		// Restar buffer antes del atardecer
		const sunsetWithBuffer = new Date(
			times.sunset.getTime() - this.sunsetBufferMinutes * minuteInMs,
		);

		const isWithinBufferedDaylight =
			now > sunriseWithBuffer && now < sunsetWithBuffer;

		if (!isWithinBufferedDaylight) {
			const timeUntilStart = sunriseWithBuffer - now;
			const timeUntilEnd = sunsetWithBuffer - now;

			if (timeUntilStart > 0) {
				console.log(
					`[${this.formatDate(now)}] Esperando ${Math.round(timeUntilStart / minuteInMs)} minutos después del amanecer (${this.formatDate(sunriseWithBuffer)}) para comenzar el monitoreo`,
				);
			} else if (timeUntilEnd < 0) {
				console.log(
					`[${this.formatDate(now)}] Monitoreo pausado hasta el amanecer. Próximo inicio: ${this.formatDate(new Date(times.sunrise.getTime() + 24 * 60 * 60 * 1000 + this.sunriseBufferMinutes * minuteInMs))}`,
				);
			}
		}

		return isWithinBufferedDaylight;
	}

	canSendAlert() {
		if (!this.lastAlert) return true;
		const hoursSinceLastAlert =
			(Date.now() - this.lastAlert) / (1000 * 60 * 60);
		return hoursSinceLastAlert >= this.alertCooldownHours;
	}

	async sendTelegramMessage(message) {
		const telegramUrl = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
		const errors = [];

		for (const chatId of this.telegramChatIds) {
			try {
				const response = await fetch(telegramUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						chat_id: chatId,
						text: message,
						parse_mode: "HTML",
					}),
				});

				if (!response.ok) {
					const errorData = await response.json();
					throw new Error(`Telegram API error: ${errorData.description}`);
				}

				console.log(
					`[${this.formatDate(new Date())}] Mensaje enviado correctamente a ${chatId}`,
				);
			} catch (error) {
				console.error(
					`[${this.formatDate(new Date())}] Error al enviar mensaje a ${chatId}:`,
					error.message,
				);
				errors.push({ chatId, error: error.message });
			}
		}

		if (errors.length > 0) {
			console.error(
				`[${this.formatDate(new Date())}] Errores al enviar mensajes:`,
				errors,
			);
		}
	}

	async sendAlert(message) {
		if (!this.canSendAlert()) return;

		const formattedMessage = `🔴 <b>Alerta Sistema Solar</b>\n\n${message}\n\nFecha: ${this.formatDate(new Date())}`;
		await this.sendTelegramMessage(formattedMessage);

		this.lastAlert = Date.now();
	}

	async checkSystem() {
		if (HEALTHCHECK_URL) {
			await this.pingHealthcheck();
		}
		if (!this.isSunUp()) {
			this.zeroReadingsCount = 0;
			this.todayEnergyStagnantCount = 0;
			this.lastTodayEnergy = null;
			this.lastTodayEnergyUpdate = null;
			this.energyAlertSent = false;
			return;
		}

		const data = await this.getCurrentPowerAndEnergy();
		if (!data) return;

		// Verificación de potencia actual
		// if (data.power < 0.01) {
		// 	this.zeroReadingsCount++;
		// 	console.log(
		// 		`Lectura de potencia cero (${data.power} KW) #${this.zeroReadingsCount} - ${new Date().toLocaleString()}`,
		// 	);

		// 	if (this.zeroReadingsCount >= this.requiredZeroReadings) {
		// 		const message = `⚠️ Sistema solar posiblemente apagado.\nSin producción durante las últimas ${this.hoursToNotifyPower} horas con luz solar.\nÚltima lectura: ${data.power} kW`;
		// 		await this.sendAlert(message);
		// 	}
		// } else {
		// 	if (this.zeroReadingsCount > 0) {
		// 		console.log("Sistema funcionando normalmente. Reiniciando contador.");
		// 		if (this.zeroReadingsCount >= this.requiredZeroReadings) {
		// 			await this.sendTelegramMessage(
		// 				`✅ Sistema solar funcionando nuevamente\nPotencia actual: ${data.power} kW`,
		// 			);
		// 		}
		// 	}
		// 	console.log(`Potencia actual: ${data.power} kW`);
		// 	this.zeroReadingsCount = 0;
		// }

		// Verificación de energía diaria
		if (this.lastTodayEnergy === null) {
			this.lastTodayEnergy = data.todayEnergy;
			this.lastTodayEnergyUpdate = Date.now();
			this.todayEnergyStagnantCount = 0;
			console.log(
				`[${this.formatDate(new Date())}] Energía diaria: ${data.todayEnergy} kWh. Potencia actual: ${data.power} kW`,
			);
		} else if (data.todayEnergy === this.lastTodayEnergy) {
			this.todayEnergyStagnantCount++;
			console.log(
				`[${this.formatDate(new Date())}] Energía diaria sin cambios (${data.todayEnergy} kWh). Potencia actual: ${data.power} kW - #${this.todayEnergyStagnantCount}`,
			);

			if (
				this.todayEnergyStagnantCount >= this.requiredStagnantReadings &&
				!this.energyAlertSent
			) {
				const hoursStagnant =
					(Date.now() - this.lastTodayEnergyUpdate) / (1000 * 60 * 60);
				const message = `⚠️ Sistema solar posiblemente apagado. La producción de energía diaria no ha cambiado en ${hoursStagnant.toFixed(1)} horas.\n\nEnergia diaria: ${data.todayEnergy} kWh\nPotencia actual: ${data.power} kW`;
				await this.sendAlert(message);
				console.log(
					`[${this.formatDate(new Date())}] Sistema solar posiblemente apagado. La producción de energía diaria no ha cambiado en ${hoursStagnant.toFixed(1)} horas.\n - Energia diaria: ${data.todayEnergy} kWh\n - Potencia actual: ${data.power} kW`,
				);
				this.energyAlertSent = true;
			}
		} else {
			if (this.energyAlertSent) {
				const hoursStagnant =
					(Date.now() - this.lastTodayEnergyUpdate) / (1000 * 60 * 60);
				await this.sendTelegramMessage(
					`✅ La producción de energía diaria se ha recuperado después de ${hoursStagnant.toFixed(1)} horas.\n\nEnergia diaria: ${data.todayEnergy} kWh\nPotencia actual: ${data.power} kW`,
				);
				console.log(
					`[${this.formatDate(new Date())}] Producción de energía diaria recuperada después de ${hoursStagnant.toFixed(1)} horas.`,
				);
				this.energyAlertSent = false;
			}
			console.log(
				`[${this.formatDate(new Date())}] Energía diaria actualizada: ${data.todayEnergy} kWh. Potencia actual: ${data.power} kW`,
			);
			this.lastTodayEnergy = data.todayEnergy;
			this.lastTodayEnergyUpdate = Date.now();
			this.todayEnergyStagnantCount = 0;
		}
	}

	start() {
		console.log(
			`[${this.formatDate(new Date())}] Iniciando monitorización del sistema solar...`,
		);
		console.log(
			`[${this.formatDate(new Date())}] Chat IDs configurados:`,
			this.telegramChatIds,
		);
		// this.sendTelegramMessage("🟢 Monitor del sistema solar iniciado");
		setInterval(
			() => this.checkSystem(),
			this.checkIntervalMinutes * 60 * 1000,
		);
		this.checkSystem();
	}
}

// Uso del monitor
const monitor = new SolarMonitor(TELEGRAM_TOKEN, TELEGRAM_CHAT_IDS);
monitor.start();
