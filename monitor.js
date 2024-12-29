const SunCalc = require("suncalc");
const { decode } = require("html-entities");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_IDS = JSON.parse(process.env.TELEGRAM_CHAT_IDS);
const PLANT_ID = process.env.PLANT_ID;
const LATITUDE = Number.parseFloat(process.env.LATITUDE);
const LONGITUDE = Number.parseFloat(process.env.LONGITUDE);

if (
	!TELEGRAM_TOKEN ||
	TELEGRAM_CHAT_IDS.length === 0 ||
	!PLANT_ID ||
	!LATITUDE ||
	!LONGITUDE
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
		this.hoursToNotifyPower = 2;
		this.hoursToNotifyEnergy = 2;

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

	isSunUp() {
		const times = SunCalc.getTimes(new Date(), this.latitude, this.longitude);
		const now = new Date();
		return now > times.sunrise && now < times.sunset;
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

				console.log(`Mensaje enviado correctamente a ${chatId}`);
			} catch (error) {
				console.error(`Error al enviar mensaje a ${chatId}:`, error.message);
				errors.push({ chatId, error: error.message });
			}
		}

		if (errors.length > 0) {
			console.error("Errores al enviar mensajes:", errors);
		}
	}

	async sendAlert(message) {
		if (!this.canSendAlert()) return;

		const formattedMessage = `🔴 <b>Alerta Sistema Solar</b>\n\n${message}\n\nFecha: ${new Date().toLocaleString()}`;
		await this.sendTelegramMessage(formattedMessage);

		this.lastAlert = Date.now();
	}

	async checkSystem() {
		if (!this.isSunUp()) {
			console.log("Es de noche. No se realizan chequeos.");
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
		if (data.power < 0.01) {
			this.zeroReadingsCount++;
			console.log(
				`Lectura de potencia cero (${data.power})W #${this.zeroReadingsCount} - ${new Date().toLocaleString()}`,
			);

			if (this.zeroReadingsCount >= this.requiredZeroReadings) {
				const message = `⚠️ Sistema solar posiblemente apagado.\nSin producción durante las últimas ${this.hoursToNotifyPower} horas con luz solar.\nÚltima lectura: ${data.power} kW`;
				await this.sendAlert(message);
			}
		} else {
			if (this.zeroReadingsCount > 0) {
				console.log("Sistema funcionando normalmente. Reiniciando contador.");
				if (this.zeroReadingsCount >= this.requiredZeroReadings) {
					await this.sendTelegramMessage(
						`✅ Sistema solar funcionando nuevamente\nPotencia actual: ${data.power} kW`,
					);
				}
			}
			this.zeroReadingsCount = 0;
		}

		// Verificación de energía diaria
		if (this.lastTodayEnergy === null) {
			this.lastTodayEnergy = data.todayEnergy;
			this.lastTodayEnergyUpdate = Date.now();
			this.todayEnergyStagnantCount = 0;
		} else if (data.todayEnergy === this.lastTodayEnergy) {
			this.todayEnergyStagnantCount++;
			console.log(
				`Energía diaria sin cambios (${data.todayEnergy} kWh) #${this.todayEnergyStagnantCount} - ${new Date().toLocaleString()}`,
			);

			if (
				this.todayEnergyStagnantCount >= this.requiredStagnantReadings &&
				!this.energyAlertSent
			) {
				const hoursStagnant =
					(Date.now() - this.lastTodayEnergyUpdate) / (1000 * 60 * 60);
				const message = `⚠️ La producción de energía diaria no ha cambiado en ${hoursStagnant.toFixed(1)} horas.\nValor actual: ${data.todayEnergy} kWh`;
				await this.sendAlert(message);
				this.energyAlertSent = true;
			}
		} else {
			if (this.energyAlertSent) {
				const hoursStagnant =
					(Date.now() - this.lastTodayEnergyUpdate) / (1000 * 60 * 60);
				await this.sendTelegramMessage(
					`✅ La producción de energía diaria se ha recuperado después de ${hoursStagnant.toFixed(1)} horas.\nNuevo valor: ${data.todayEnergy} kWh`,
				);
				this.energyAlertSent = false;
			}
			console.log(`Energía diaria actualizada: ${data.todayEnergy} kWh`);
			this.lastTodayEnergy = data.todayEnergy;
			this.lastTodayEnergyUpdate = Date.now();
			this.todayEnergyStagnantCount = 0;
		}
	}

	start() {
		console.log("Iniciando monitorización del sistema solar...");
		console.log("Chat IDs configurados:", this.telegramChatIds);
		this.sendTelegramMessage("🟢 Monitor del sistema solar iniciado");
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
