import { Logger } from "common/logger.js";
import cors from "cors";
import express from "express";
import fs from "fs";
import http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import https from "https";
import path from "path";

import { Application } from "./app.js";
import { useHttpServer } from "./serviceListing.js";
import { ServiceDefinition } from "./serviceManager.js";

class Gateway {
	private api: express.Express;
	public httpServer: http.Server;

	public async init(serviceListing: ServiceDefinition[]) {
		this.api = express();
		this.api.use(cors());

		this.api.use((req, res, next) => {
			const ip = req.headers["cf-connecting-ip"] ? req.headers["cf-connecting-ip"] : req.ip;
			const body = JSON.stringify(req.body);
			const logMsg = `[${ip}] (${req.method}) ${req.path} ${JSON.stringify(req.query)} ${body}`;
			Logger.info(logMsg);
			next();
		});

		serviceListing.forEach(service => {
			if (service.gateway) this.loadGatewayEndpoint(service);
		});

		this.api.use(express.static("../../VTOLLiveViewerClient/public/"));

		this.api.get("/api/core/lobbies", (req, res) => {
			// const app = Application
			res.send(Application.instance.rawLobbyData);
		});

		this.api.get("/*", (req, res) => {
			res.sendFile(path.resolve("../../VTOLLiveViewerClient/public/index.html"));
		});

		const port = parseInt(process.env.API_PORT);
		if (useHttpServer) {
			Logger.warn(`Using http server for gateway`);
			this.httpServer = this.api.listen(port, () => {
				Logger.info(`<<Gateway open>>  Port: ${port}`);
			});
		} else {
			Logger.info(`Using https server for gateway`);
			const key = fs.readFileSync("../keys/vtolvr.live.key");
			const cert = fs.readFileSync("../keys/vtolvr.live.pem");
			const httpsServer = https.createServer({ key, cert }, this.api);

			httpsServer.listen(port, () => {
				Logger.info(`<<Gateway open>>  Port: ${port}`);
			});

			this.httpServer = httpsServer;
		}
	}

	private loadGatewayEndpoint(service: ServiceDefinition) {
		const rewrite = `^${service.gateway.url}`;
		const middleware = createProxyMiddleware(service.gateway.url, {
			target: `http://localhost:${service.gateway.port}`,
			pathRewrite: { [rewrite]: "" }
		});
		this.api.use(middleware);
		Logger.info(`Loaded gateway endpoint for ${service.name} at ${service.gateway.url} -> http://localhost:${service.gateway.port}`);
	}
}

export { Gateway };
