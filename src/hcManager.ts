import { ChildProcess, spawn } from "child_process";
import { Logger } from "common/logger.js";
import path from "path";

import { Application } from "./app";

class HCManager {
	private hcPath: string;
	private process: ChildProcess | undefined;
	public startedAt: number = Date.now();

	constructor(private app: Application) {
		this.hcPath = process.env.HC_PATH;
	}

	public async init() {
		// TEMP: Doing some debugging, going to just manually spawn HC, not using hcManager
		// this.spawn();
		// if (process.env.IS_DEV != "true") this.spawn();
		// else Logger.warn(`HCManager: Skipping spawn because IS_DEV is TRUE`);
	}

	public async spawn() {
		if (this.process) {
			Logger.warn("HCManager: Process already running when spawn called");
			return;
		}

		this.startedAt = Date.now();

		Logger.info(`Spawning HC instance!`);

		// "from-server" arg prevents HC from doing local fs logging, server must handle it
		let cmd: string;
		const hcPath = path.resolve(this.hcPath);
		if (process.platform == "win32") {
			cmd = `${hcPath}/HeadlessVTOL.exe`;
		} else {
			// cmd = `dotnet ${hcPath}/HeadlessVTOLUbuntu.dll`;
			throw new Error("HCManager: Linux not supported yet");
		}

		Logger.info(` - HC Spawn Command: ${cmd}`);
		// const hcClient = execFile(cmd, { cwd: hcPath });
		const hcClient = spawn(cmd, { cwd: hcPath, stdio: "pipe" }); // execFile buffers all stdout resulting in SIGTERM. Many months spent dealing with this bug
		this.process = hcClient;

		hcClient.stdout.on("data", data => {
			const parts = (data.toString() as string).split("\n");
			parts.forEach(part => {
				if (part.trim().length > 0) Logger.processHCLog(part);
			});
		});

		hcClient.stderr.on("data", data => {
			Logger.error(`HC ERROR: ${data}`);
		});

		hcClient.on("error", err => {
			Logger.warn(`Error from HC Child Process: ${err}`);
		});

		hcClient.on("exit", (code, sig) => {
			Logger.warn(`HC Client exited with code ${code} and signal ${sig}`);
		});

		hcClient.on("close", code => {
			Logger.warn(`HC Client closed with code ${code}`);
		});
	}

	public requestJoinLobby(lobbyId: string, password?: string) {
		if (this.app.headlessClients.length == 0) {
			Logger.error("No clients connected to HC when requestJoinLobby");
			return;
		}

		if (password) {
			Logger.info(`HCManager: Requesting join lobby ${lobbyId} with password ${password}`);
			this.app.headlessClients.forEach(hc => hc.send(`joinpass_${lobbyId}_${password}`));
		} else {
			Logger.info(`HCManager: Requesting join lobby ${lobbyId}`);
			this.app.headlessClients.forEach(hc => hc.send(`join_${lobbyId}`));
		}
	}

	public requestLeaveLobby(lobbyId: string) {
		if (this.app.headlessClients.length == 0) {
			Logger.error("No clients connected to HC when requestLeaveLobby");
			return;
		}
		Logger.info(`HCManager: Requesting leave lobby ${lobbyId}`);
		this.app.headlessClients.forEach(hc => hc.send(`leave_${lobbyId}`));
	}
}

export { HCManager };
