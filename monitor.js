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
		this.zeroReadingsCount = 0;
		this.checkIntervalMinutes = 10;
		this.hoursToNotify = 2;
		this.requiredZeroReadings =
			(this.hoursToNotify * 60) / this.checkIntervalMinutes;
		this.lastAlert = null;
		this.alertCooldownHours = 4;
		this.apiUrl =
			"https://uni001eu5.fusionsolar.huawei.com/rest/pvms/web/kiosk/v1/station-kiosk-file";
	}

	async getCurrentPower() {
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
			return Number.parseFloat(currentPower);
		} catch (error) {
			console.error("Error al obtener datos de potencia:", error.message);
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
			return;
		}

		const currentPower = await this.getCurrentPower();

		if (currentPower === null) return;

		if (currentPower < 0.01) {
			this.zeroReadingsCount++;
			console.log(
				`Lectura de potencia cero (${currentPower})W #${this.zeroReadingsCount} - ${new Date().toLocaleString()}`,
			);

			if (this.zeroReadingsCount >= this.requiredZeroReadings) {
				const message = `⚠️ Sistema solar posiblemente apagado.\nSin producción durante las últimas ${this.hoursToNotify} horas con luz solar.\nÚltima lectura: ${currentPower} kW`;
				await this.sendAlert(message);
			}
		} else {
			if (this.zeroReadingsCount > 0) {
				console.log("Sistema funcionando normalmente. Reiniciando contador.");
				if (this.zeroReadingsCount >= this.requiredZeroReadings) {
					await this.sendTelegramMessage(
						`✅ Sistema solar funcionando nuevamente\nPotencia actual: ${currentPower} kW`,
					);
				}
			}
			this.zeroReadingsCount = 0;
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
