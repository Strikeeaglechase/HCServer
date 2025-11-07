import { Logger } from "common/logger.js";
import { EnableRPCs, RPC, RPCController, RPCPacket } from "common/rpc.js";
import { AuthType, DbUserEntry, HCUser, Packet, PacketType, RecordedLobbyInfo, UserScopes, VTGRHeader } from "common/shared.js";
import { AuthService } from "serviceLib/serviceDefs/AuthService.js";
import { DBService } from "serviceLib/serviceDefs/DBService.js";
import { v4 as uuidv4 } from "uuid";
import { WebSocket } from "ws";

import { Application } from "./app.js";
import { HCCommands } from "./hcManager.js";

const REPLAY_HEADER = Buffer.from("REPLAY", "ascii");
// const REPLAY_FOOTER = Buffer.from("\0\0\0END", "ascii");

enum AIPClientPacketType {
	RPC,
	CommandPacket
}

type AIPClientPacket = { type: AIPClientPacketType.RPC; packet: RPCPacket } | { type: AIPClientPacketType.CommandPacket; packet: HCCommands.Packet };

@EnableRPCs("instance")
class Client {
	public isHeadlessClient = false;
	public isAIPClient = false;
	public id = uuidv4();
	public keepAliveInterval: NodeJS.Timeout;
	public loggedInAs: HCUser;
	public subscribedGameId: string;

	public subscribedToLiveGameData = true;

	private requestReplaysCancelationCallback: () => void;

	constructor(private socket: WebSocket, private app: Application) {
		this.send({
			id: this.id,
			type: PacketType.assignId
		});

		this.socket.on("message", data => {
			if (data.toString() == process.env.HC_PASSWORD) {
				app.assignHeadlessSocket(this);
				return;
			}

			if (data.toString() == "autosub") {
				this.handleAutoSub();
				return;
			}

			if (this.isHeadlessClient) {
				const message = data.toString();
				message
					.split("\n")
					.filter(m => m.length > 2)
					.forEach(m => {
						app.handleVtolMessage(m, this);
					});
			} else if (this.isAIPClient) {
				const message: AIPClientPacket = JSON.parse(data.toString());
				switch (message.type) {
					case AIPClientPacketType.RPC:
						RPCController.handlePacket(message.packet, this);
						break;
					case AIPClientPacketType.CommandPacket:
						const hcClient = app.headlessClients[0];
						if (!hcClient) {
							Logger.warn(`AIPClient ${this} sent a command packet but no HCClient found`);
							return;
						}

						// console.log(message);
						// if (!this.subscribedGameId) {
						// 	Logger.error(`No subscribed game ID for AIPClient ${this}. Cannot send command packet.`);
						// }

						message.packet.lobbyId = this.subscribedGameId;
						hcClient.send(message.packet);
						break;
				}
			} else {
				RPCController.handlePacket(data.toString(), this);
			}
		});

		this.sendSync();

		this.keepAliveInterval = setInterval(() => {
			this.ping(Date.now());
			if (!this.isAlive()) {
				clearInterval(this.keepAliveInterval);
			}
		}, 1000);
	}

	private handleAutoSub() {
		this.isAIPClient = true;
		this.loggedInAs = {
			username: "AI Pilot Client",
			id: `auto_${this.id}`,
			pfpUrl: "",
			scopes: [UserScopes.ALPHA_ACCESS, UserScopes.DONOR],
			authType: AuthType.BYPASS
		};
		Logger.info(`Client ${this} auto-subscribed`);

		const hs = this.app.games.find(g => g.isHs);
		// const hs = this.app.games.find(g => g.hostId == "76561198241105316");
		if (!hs) {
			Logger.error(`No HS lobby found to auto-subscribe to`);
			return;
		}
		hs.continuousRecord = true;
		hs.continuousRecordPassword = "shark";

		this.subscribe(hs.id);
	}

	public hasScope(scope: UserScopes | UserScopes[]) {
		if (!this.loggedInAs) return false;

		if (Array.isArray(scope)) {
			return scope.some(s => this.loggedInAs.scopes.includes(s));
		}

		return this.loggedInAs.scopes.includes(scope);
	}

	private sendSync() {
		Logger.info(`Sending sync to ${this} with ${this.app.createLobbyRPCs.length} lobbies and ${this.app.games.length} games`);
		this.app.createLobbyRPCs.forEach(rpc => this.send(rpc));
		this.app.games.forEach(game => {
			const resync = game.getListResyncPackets();
			resync.forEach(p => this.send(p));
			game.syncIsRecording();
		});
	}

	@RPC("in")
	subscribe(gameId: string) {
		this.subscribedGameId = gameId;
		this.app.subscribeToGame(this, gameId);
	}

	@RPC("out")
	invalidateToken() {}

	@RPC("in")
	async setUser(key: string) {
		const user = await AuthService.readToken(key);
		if (!user) {
			Logger.warn(`User on websocket ${this.id} sent an invalid user token: "${key}"`);
			this.invalidateToken();
			return;
		}

		const dbUser = await DBService.getUser(user.id);
		if (!dbUser) {
			Logger.warn(`User on websocket ${this.id} sent an invalid user token. User was not found in the DB!: "${key}"`);
			this.invalidateToken();
			return;
		}

		const existingScopes = JSON.stringify(dbUser.scopes.sort());
		const currentScopes = JSON.stringify(user.scopes.sort());
		const daysTillExpire = ((user.exp ?? 0) * 1000 - Date.now()) / 1000 / 60 / 60 / 24;

		if (existingScopes != currentScopes || daysTillExpire < 4) {
			if (existingScopes != currentScopes) Logger.info(`User has outdated scopes, sending them new ones. ${existingScopes} -> ${currentScopes}`);
			else Logger.info(`User has an outdated token, sending them a new one. ${daysTillExpire} days till expire.`);

			const newToken = await AuthService.cloneJWT(user);
			const decodedNewToken = await AuthService.readToken(newToken);
			const newDecodedTimeTillExpire = ((decodedNewToken.exp ?? 0) * 1000 - Date.now()) / 1000 / 60 / 60 / 24;
			Logger.info(`New token expires in ${newDecodedTimeTillExpire} days`);
			this.newToken(newToken);
		} else {
			this.loggedInAs = user;
			Logger.info(`User ${user.username} (${user.id}) logged in on websocket ${this.id}`);
			// if (this.hasScope(UserScopes.ALPHA_ACCESS)) this.sendSync();
		}
	}

	@RPC("out")
	ping(n: number) {}

	@RPC("in")
	pong(n: number) {}

	@RPC("in")
	async requestReplayLobbies(
		id: string | null,
		lobbyNameQuery: string,
		playerNameQuery: string,
		hostNameQuery: string,
		lowerDateBound: number,
		upperDateBound: number
	) {
		Logger.info(`Requesting replay lobbies with query id: ${id}, name: ${lobbyNameQuery}, player: ${playerNameQuery}, host: ${hostNameQuery}`);
		const lobbies = DBService.getRecordedLobbiesStream(id, lobbyNameQuery, playerNameQuery, hostNameQuery, lowerDateBound, upperDateBound);

		let hasCanceled = false;
		this.requestReplaysCancelationCallback = () => {
			hasCanceled = true;
			lobbies.destroy();
		};

		lobbies.on("data", (lobby: string) => {
			if (hasCanceled) return;
			const lobbyObj = JSON.parse(lobby) as VTGRHeader;
			console.log(`Sending replay lobby info for ${lobbyObj.info.lobbyName} (${lobbyObj.id})`);
			this.replayLobbyInfo(lobbyObj.info);
		});
	}

	@RPC("in")
	cancelRequestReplayLobbies() {
		if (this.requestReplaysCancelationCallback) this.requestReplaysCancelationCallback();
	}

	@RPC("out")
	replayLobbyInfo(info: RecordedLobbyInfo) {}

	@RPC("in")
	async replayGame(replayId: string) {
		const entry = await DBService.getRecordedLobby(replayId); // this.app.storedLobbies.get(replayId);
		if (!entry) {
			Logger.warn(`Replay request for unknown recording: ${replayId}`);
			return;
		}

		const lastChunk = entry.chunks[entry.chunks.length - 1];
		const replaySize = lastChunk.start + lastChunk.length;

		this.replayHeader(entry);
		this.expectReplaySize(replaySize);

		// const readStream = VTGRService.readRecordingBody(replayId);

		// let streamBuff: Buffer[] = [];
		// let currentSize = 0;
		// readStream.on("data", chunk => {
		// 	streamBuff.push(chunk);
		// 	currentSize += chunk.length;

		// 	if (currentSize > 512 * 1024) {
		// 		const message = Buffer.concat(streamBuff);
		// 		this.send(Buffer.concat([REPLAY_HEADER, message]));
		// 		streamBuff = [];
		// 		currentSize = 0;
		// 	}
		// });

		// readStream.on("end", () => {
		// 	const message = Buffer.concat(streamBuff);
		// 	this.send(Buffer.concat([REPLAY_HEADER, message]));
		// });
	}

	@RPC("out")
	expectReplaySize(size: number) {}

	@RPC("out")
	replayHeader(header: VTGRHeader) {}

	@RPC("in")
	async adminSearchUsers(query: string) {
		query = query.split("$").join("");
		// Direct Id result
		const user = await DBService.getUser(query.trim());
		if (user) {
			this.adminSearchUsersResult([user]);
			return;
		}

		const result = await DBService.searchUserByName(query.trim());
		this.adminSearchUsersResult(result);
	}

	@RPC("out")
	adminSearchUsersResult(users: DbUserEntry[]) {}

	@RPC("in")
	adminSetUserScopes(id: string, scopes: UserScopes[]) {
		Logger.info(`Admin ${this.toString()} set scopes of ${id} to ${scopes.join(", ")}`);
		DBService.updateUserScopes(id, scopes);
	}

	@RPC("in")
	kickUser(id: string) {
		Logger.info(`Admin ${this.toString()} kicked ${id}`);

		this.app.headlessClients.forEach(hc => hc.send(`crash_${this.subscribedGameId}_${id}`));
	}

	@RPC("out")
	newToken(token: string) {}

	@RPC("out")
	error(message: string) {}

	@RPC("in")
	enableRecordLobby(lobbyId: string, password: string) {
		const lobby = this.app.games.find(g => g.id == lobbyId);
		if (!lobby) {
			Logger.warn(`Tried to enable recording for unknown lobby ${lobbyId}`);
			return;
		}

		lobby.enableRecording(password);
	}

	@RPC("in")
	unsubscribeFromLiveLobbyList() {
		this.subscribedToLiveGameData = false;
		console.log(`Client ${this} unsubscribed from live lobby list`);
	}

	public send<T extends Packet | ArrayLike<number> | string | HCCommands.Packet>(packet: T): void {
		if (packet instanceof Uint8Array) {
			this.socket.send(packet);
		} else if (typeof packet == "string") {
			this.socket.send(packet);
		} else {
			this.socket.send(JSON.stringify(packet));
		}
	}

	public isAlive(): boolean {
		return this.socket.readyState != this.socket.CLOSED;
	}

	public onDisconnected() {
		if (this.isHeadlessClient) {
			this.app.onHeadlessDisconnected();
		}
	}

	public toString() {
		if (!this.loggedInAs) return this.id;
		return `${this.loggedInAs.username} (${this.loggedInAs.id})`;
	}
}

export { Client };
