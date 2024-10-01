import { Logger } from "common/logger.js";
import express from "express";
import fs from "fs";
import path from "path";

import { Application } from "./app.js";
import { Gateway } from "./gateway.js";
import { ServiceManager } from "./serviceManager.js";

async function start() {
	// const app = express();
	// app.use((req, res, next) => {
	// 	const ip = req.headers["cf-connecting-ip"] ?
	// 		req.headers["cf-connecting-ip"] :
	// 		req.ip;
	// 	const body = JSON.stringify(req.body);
	// 	const logMsg = `[${ip}] (${req.method}) ${req.path} ${JSON.stringify(req.query)} ${body}`;
	// 	Logger.info(logMsg);
	// 	next();
	// });

	// app.use(express.static("../../VTOLLiveViewerClient/dist/"));

	// app.get("/*", (req, res) => {
	// 	res.sendFile(path.resolve("../../VTOLLiveViewerClient/dist/index.html"));
	// });

	// const PORT = parseInt(process.env.PORT);
	// const httpsServer = app.listen(PORT, () =>
	// 	Logger.info(`API Server up on port ${PORT}!`)
	// );

	const serviceManager = new ServiceManager();
	const gateway = new Gateway();

	await serviceManager.init();
	await gateway.init(serviceManager.serviceDefs);

	const application = new Application(gateway.httpServer);

	process.on("unhandledRejection", (error: Error) => {
		Logger.error(`Top level unhandled rejection!`);
		console.error(error);
		Logger.error(error.toString());
		Logger.error(error.stack);
	});
	process.on("uncaughtException", (error: Error) => {
		Logger.error(`Top level uncaught exception!`);
		console.error(error);
		Logger.error(error.toString());
		Logger.error(error.stack);
	});
}

export { start };
