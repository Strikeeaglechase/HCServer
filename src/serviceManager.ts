import { ChildProcess, spawn } from "child_process";
import { Logger } from "common/logger.js";
import fs, { WriteStream } from "fs";
import path from "path";

import getServiceListing from "./serviceListing.js";

interface ServiceDefinition {
	name: string;
	path: string;
	envs: string[];
	gateway?: { url: string; port: number };
	debug?: boolean;
}

class ServiceManager {
	private runningServices: { process: ChildProcess; service: ServiceDefinition; alive: boolean }[] = [];
	public serviceDefs: ServiceDefinition[] = [];
	private serviceStartLog: WriteStream;

	public async init() {
		this.serviceStartLog = fs.createWriteStream("../serviceStartLog.log", { flags: "a" });
		this.loadServices();
		setInterval(() => this.update(), 1000);
	}

	public update() {
		this.runningServices = this.runningServices.filter(rs => rs.alive);
		this.loadServices();
	}

	private loadServices() {
		this.serviceDefs = getServiceListing();
		this.serviceDefs.forEach(sd => {
			const runningService = this.getRunningInstance(sd.name);
			if (!runningService) this.startService(sd);
		});
	}

	private getRunningInstance(name: string) {
		return this.runningServices.find(rs => rs.service.name == name);
	}

	private startService(serviceDef: ServiceDefinition) {
		const servicePath = path.resolve(serviceDef.path);
		Logger.info(`Starting service ${serviceDef.name} (${servicePath})`);
		const envs = serviceDef.envs.map(env => {
			const idx = env.indexOf("=");
			return [env.substring(0, idx), env.substring(idx + 1)];
		});

		this.serviceStartLog.write(
			`[${new Date().toISOString()}] Starting service ${serviceDef.name} ExecCommand: "node ${servicePath}" Envs: ${JSON.stringify(
				Object.fromEntries(envs)
			)}  \n`
		);

		let args = [servicePath];
		if (serviceDef.debug) args = ["--inspect", ...args];

		const serviceProcess = spawn("node", args, { env: Object.fromEntries(envs), cwd: path.dirname(servicePath) });

		serviceProcess.on("exit", code => {
			Logger.error(`Service ${serviceDef.name} exited with code ${code}!`);
			this.runningServices = this.runningServices.filter(rs => rs.service.name != serviceDef.name);
			this.startService(serviceDef);
		});
		serviceProcess.on("error", err => {
			Logger.error(`Service ${serviceDef.name} errored with ${err}!`);
			if (err.message.includes("ENOENT")) {
				Logger.error(`Unable to find ${serviceDef.name}`);
				this.getRunningInstance(serviceDef.name).alive = false;
			}
		});

		if (serviceProcess.stdout)
			serviceProcess.stdout.on("data", (data: string) =>
				data
					.toString()
					.split("\n")
					.filter(p => p.length > 1)
					.forEach(part => Logger.info(`[${serviceDef.name}] ${part}`))
			);

		if (serviceProcess.stderr)
			serviceProcess.stderr.on("data", (data: string) =>
				data
					.toString()
					.split("\n")
					.filter(p => p.length > 1)
					.forEach(part => Logger.error(`[${serviceDef.name}] ${part}`))
			);

		this.runningServices.push({ process: serviceProcess, service: serviceDef, alive: true });
	}
}

export { ServiceManager, ServiceDefinition };
