import { Logger } from "common/logger.js";
import { config } from "dotenv";
import fs from "fs";

function loadEnv() {
	config();
	const expected = fs.readFileSync("../expectEnv.txt", "utf-8").split("\n");
	let isMissing = false;
	expected.forEach(key => {
		if (!process.env[key.trim()]) {
			Logger.error(`Missing environment variable: ${key}`);
			isMissing = true;
		}
	});
	if (isMissing) process.exit(1);
}

loadEnv();

// Using import() to ensure loadEnv is called before anything else
async function exec() {
	const imp = await import("./main.js");
	imp.start();
}

exec();
