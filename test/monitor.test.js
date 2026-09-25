const assert = require("node:assert/strict");
const test = require("node:test");

Object.assign(process.env, {
	TELEGRAM_TOKEN: "test-token",
	TELEGRAM_CHAT_IDS: '["123"]',
	PLANT_ID: "test-plant",
	API_URL: "https://plant.example/data",
	LATITUDE: "0",
	LONGITUDE: "0",
	TZ: "UTC",
});

const { CONFIG, SolarMonitor, validateConfig } = require("../monitor");

function makeMonitor({ energy = 0, telegramSucceeds = () => true } = {}) {
	let time = Date.parse("2026-06-01T10:00:00Z");
	let telegramAttempts = 0;
	let plantRequests = 0;
	const attemptedChatIds = [];
	const fetchImpl = async (url, options) => {
		assert.ok(options.signal, "requests must have a timeout signal");
		if (String(url).startsWith("https://api.telegram.org/")) {
			telegramAttempts++;
			const chatId = JSON.parse(options.body).chat_id;
			attemptedChatIds.push(chatId);
			const ok = telegramSucceeds(telegramAttempts, chatId);
			return { ok, json: async () => ({ description: "temporary error" }) };
		}
		plantRequests++;
		return {
			ok: true,
			json: async () => ({
				success: true,
				data: JSON.stringify({
					realKpi: { realTimePower: 0, dailyEnergy: energy },
				}),
			}),
		};
	};
	const monitor = new SolarMonitor({
		fetchImpl,
		now: () => new Date(time),
		sunCalc: {
			getTimes: () => ({
				sunrise: new Date("2026-06-01T06:00:00Z"),
				sunset: new Date("2026-06-01T22:00:00Z"),
			}),
		},
	});
	return {
		monitor,
		advanceMinutes: (minutes) => { time += minutes * 60_000; },
		setEnergy: (value) => { energy = value; },
		get telegramAttempts() { return telegramAttempts; },
		get attemptedChatIds() { return attemptedChatIds; },
		get plantRequests() { return plantRequests; },
	};
}

test("zero daily energy triggers an alert after one hour", async () => {
	const fixture = makeMonitor();
	await fixture.monitor.check();
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 1);
});

test("a failed Telegram alert is retried and cooldown starts after delivery", async () => {
	const fixture = makeMonitor({
		energy: 2,
		telegramSucceeds: (attempt) => attempt !== 1,
	});
	await fixture.monitor.check();
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 1);
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 2);
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 2);
	fixture.advanceMinutes(240);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 3);
});

test("only failed chats are retried", async () => {
	CONFIG.telegram.chatIds = ["123", "456"];
	try {
		const fixture = makeMonitor({
			telegramSucceeds: (attempt, chatId) => !(attempt === 2 && chatId === "456"),
		});
		await fixture.monitor.check();
		fixture.advanceMinutes(30);
		await fixture.monitor.check();
		fixture.advanceMinutes(30);
		await fixture.monitor.check();
		fixture.advanceMinutes(30);
		await fixture.monitor.check();
		assert.deepEqual(fixture.attemptedChatIds, ["123", "456", "456"]);
	} finally {
		CONFIG.telegram.chatIds = ["123"];
	}
});

test("recovery goes only to chats that received an alert", async () => {
	CONFIG.telegram.chatIds = ["123", "456"];
	try {
		const fixture = makeMonitor({
			telegramSucceeds: (attempt, chatId) => !(attempt === 2 && chatId === "456"),
		});
		await fixture.monitor.check();
		fixture.advanceMinutes(30);
		await fixture.monitor.check();
		fixture.advanceMinutes(30);
		await fixture.monitor.check();
		fixture.setEnergy(1);
		fixture.advanceMinutes(30);
		await fixture.monitor.check();
		assert.deepEqual(fixture.attemptedChatIds, ["123", "456", "123"]);
	} finally {
		CONFIG.telegram.chatIds = ["123"];
	}
});

test("a failed recovery notification is retried", async () => {
	const fixture = makeMonitor({
		telegramSucceeds: (attempt) => attempt !== 2,
	});
	await fixture.monitor.check();
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	fixture.setEnergy(1);
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 2);
	fixture.advanceMinutes(30);
	await fixture.monitor.check();
	assert.equal(fixture.telegramAttempts, 3);
});

test("a second check is skipped while the first is running", async () => {
	let release;
	let requests = 0;
	const fixture = makeMonitor();
	fixture.monitor.fetchImpl = async () => {
		requests++;
		return new Promise((resolve) => { release = resolve; });
	};
	const first = fixture.monitor.check();
	assert.equal(await fixture.monitor.check(), false);
	assert.equal(requests, 1);
	release({
		ok: true,
		json: async () => ({
			success: true,
			data: JSON.stringify({ realKpi: { realTimePower: 0, dailyEnergy: 1 } }),
		}),
	});
	assert.equal(await first, true);
});

test("zero coordinates are valid; missing or out-of-range coordinates are rejected", () => {
	assert.doesNotThrow(() => validateConfig(CONFIG, process.env));
	assert.throws(
		() => validateConfig(CONFIG, { ...process.env, LATITUDE: "" }),
		/latitude or longitude/,
	);
	assert.throws(
		() => validateConfig({
			...CONFIG,
			location: { ...CONFIG.location, longitude: 181 },
		}, process.env),
		/latitude or longitude/,
	);
	assert.throws(
		() => validateConfig({
			...CONFIG,
			telegram: { ...CONFIG.telegram, chatIds: null },
		}, process.env),
		/required environment variables/,
	);
});
