import { compressRpcPackets } from "common/compression/vtcompression.js";
import { Logger } from "common/logger.js";
import { EnableRPCs, RPC, RPCController, RPCHandler, RPCPacket } from "common/rpc.js";
import { UserScopes } from "common/shared.js";
import http from "http";
import { ServiceConnector } from "serviceLib/serviceConnector.js";
import { Callable, Event } from "serviceLib/serviceHandler.js";
import { WebSocketServer } from "ws";

import { Client } from "./client.js";
import { VTOLLobby } from "./game.js";
import { HCManager } from "./hcManager.js";
import { IPCPacket, IPCTypes } from "./ipcMessages.js";

// If "permission" is an array, the user has access if they have *any* of the listed permissions
const clientAllowedRPCs: { className: string; method: string; permission: UserScopes | UserScopes[] }[] = [
	{ className: "Client", method: "subscribe", permission: [UserScopes.ALPHA_ACCESS, UserScopes.DONOR] },
	{ className: "Application", method: "requestJoinLobby", permission: [UserScopes.ALPHA_ACCESS, UserScopes.DONOR] },
	{ className: "Application", method: "requestJoinPrivateLobby", permission: [UserScopes.ALPHA_ACCESS, UserScopes.DONOR] },
	{ className: "Client", method: "enableRecordLobby", permission: [UserScopes.ALPHA_ACCESS, UserScopes.DONOR] },
	{ className: "Client", method: "unsubscribeFromLiveLobbyList", permission: null },
	{ className: "Client", method: "replayGame", permission: null },
	{ className: "Client", method: "requestReplayLobbies", permission: null },
	{ className: "Client", method: "cancelRequestReplayLobbies", permission: null },
	{ className: "Client", method: "setUser", permission: null },
	{ className: "Client", method: "pong", permission: null },
	{ className: "Client", method: "adminSearchUsers", permission: UserScopes.ADMIN },
	{ className: "Client", method: "adminSetUserScopes", permission: UserScopes.ADMIN },
	{ className: "Client", method: "kickUser", permission: UserScopes.ADMIN }
];

const tps = 60;
const tickrate = 1 / tps;

export const IS_ALPHA = true;

interface VTOLUser {
	userId: string;
	lobbyId: string;
	username: string;
	isPrivate: boolean;
	lobbyName: string;
	missionName: string;
}

interface RawLobbyData {
	lobbyName: string;
	ownerName: string;
	ownerId: string;
	scenarioName: string;
	scenarioId: string;
	maxPlayers: string;
	feature: string;
	envIdx: string;
	gameVersion: string;
	briefingRoom: string;
	hasPwd: boolean;
	ld_GameState: string;
	mUtc: string;
	playerCount: number;
}

interface RawLobbyDataCollection {
	private: RawLobbyData[];
	public: RawLobbyData[];
	updatedAt: number;
	lastUpdatedList: "private" | "public";
}

@EnableRPCs("singleInstance")
class Application {
	public static instance: Application;
	wss: WebSocketServer;
	clients: Client[] = [];
	headlessClients: Client[] = [];
	games: VTOLLobby[] = [];

	public hcManager: HCManager;
	private connector: ServiceConnector;

	createLobbyRPCs: RPCPacket[] = [];
	pooledRpcs: RPCPacket[] = [];

	public vtolUsersList: VTOLUser[] = [];

	public rawLobbyData: RawLobbyDataCollection = {
		private: [],
		public: [],
		updatedAt: 0,
		lastUpdatedList: "private"
	};

	private queuedLobbyData: RawLobbyData[] = [];

	// public api: express.Express;

	constructor(server: http.Server) {
		this.wss = new WebSocketServer({
			server: server
		});

		this.wss.on("listening", () => {
			Logger.info(`Websocket server opened`);
			RPCController.init(packet => {
				if (packet.className == "Client") {
					const client = this.clients.find(c => c.id == packet.id);
					if (client) {
						client.send(packet);
					}
				} else {
					// Logger.error(`Send handler not defined: \n\t${JSON.stringify(packet)}`);
					// Logger.info(`Broadcasting packet: ${packet.className}.${packet.method}`);
					this.clients.forEach(c => c.send(packet));
				}
			});
			RPCController.assignPermissionProvided(this.rpcPermissionProvider.bind(this));
			RPCController.suppressRPCFindError = true;

			this.init();

			setInterval(() => this.clearClosed(), 1000);
		});

		this.wss.on("close", () => {
			Logger.info(`Websocket server closed`);
		});
	}

	private async init() {
		this.wss.on("connection", socket => this.clients.push(new Client(socket, this)));

		this.connector = new ServiceConnector(process.env.SERVICE_CONNECTOR_URL, process.env.SERVICE_KEY);
		await this.connector.connect();
		this.connector.register("Application", this);

		this.hcManager = new HCManager(this);
		await this.hcManager.init();

		// this.api.get("/vtol-users", (req, res) => {
		// 	res.send(this.vtolUsersList);
		// });

		// this.api.listen(parseInt(process.env.API_PORT), () => {
		// 	Logger.info(`Workshop API opened on ${process.env.API_PORT}`);
		// });

		Logger.info(`Application initialized`);
		setInterval(() => this.networkTick(), tickrate * 1000);
	}

	private networkTick() {
		if (this.pooledRpcs.length > 0) {
			const bytes = new Uint8Array(compressRpcPackets(this.pooledRpcs, false));

			this.clients.forEach(c => {
				// const hasPerms = c.hasScope(UserScopes.ALPHA_ACCESS) ||
				// if (!IS_ALPHA || (c.hasScope(UserScopes.ALPHA_ACCESS) && c.subscribedToLiveGameData)) {
				// }
				if (c.subscribedToLiveGameData) c.send(bytes);
			});

			this.pooledRpcs = [];
		}

		this.games.forEach(g => g.update());

		const ids: string[] = [];
		this.games.forEach(g => {
			if (ids.includes(g.id)) Logger.error(`Duplicate game id: ${g.id}`);
			else ids.push(g.id);
		});
	}

	private rpcPermissionProvider(packet: RPCPacket, rpc: RPCHandler, client: Client) {
		if (client.isHeadlessClient) return true;
		const allowed = clientAllowedRPCs.find(r => r.className == packet.className && r.method == packet.method);
		// console.log(allowed);

		if ((packet.className == "Client" && packet.method == "subscribe") || (packet.className == "Application" && packet.method == "requestJoinLobby")) {
			// Auto-allow subscribe if 24/7 BVR
			const game = this.getGame(packet.args[0]);
			if (game && game.isHs) return true;
		}

		if (allowed && allowed.permission == null) return true;
		if (!allowed) return false;
		if (!client.loggedInAs) {
			Logger.warn(`Client ${client} tried to call ${packet.className}.${packet.method} but is not logged in`);
			client.error(`Permission denied, you are not logged in`);
			return false;
		}

		if (!client.hasScope(allowed.permission)) {
			Logger.warn(`Client ${client} tried to call ${packet.className}.${packet.method} but does not have permission (needs ${allowed.permission})`);
			client.error(`Permission denied (${allowed.permission})`);
			return false;
		}

		return true;
	}

	public subscribeToGame(client: Client, gameId: string) {
		this.games.forEach(g => g.unsubscribe(client));
		this.getGame(gameId)?.subscribe(client);
	}

	private clearClosed() {
		const closedClients = this.clients.filter(c => !c.isAlive());

		this.clients = this.clients.filter(c => c.isAlive());
		this.headlessClients = this.headlessClients.filter(c => c.isAlive());

		closedClients.forEach(c => c.onDisconnected());
	}

	private parseIPCPacket(packetData: string): IPCPacket {
		if (!packetData || packetData == "" || packetData == " " || packetData.length < 2) return null;
		try {
			const ipcPacket = JSON.parse(packetData);
			ipcPacket.type = typeof ipcPacket.type == "string" ? ipcPacket.type : ipcPacket.type.value;

			return ipcPacket;
		} catch (e) {
			Logger.error(`Unable to parse packet: ${packetData}`);
			return null;
		}
	}

	private getGame(id: string) {
		const game = this.games.find(g => g.id == id);
		if (game) return game;
		Logger.error(`Can't find game with ID ${id}`);
		return null;
	}

	@RPC("in")
	CreateLobby(id: string) {
		Logger.info(`Got new lobby: ${id}`);
		if (this.games.find(g => g.id == id)) {
			Logger.warn(`Lobby ${id} already exists`);
			return;
		}
		this.games.push(new VTOLLobby(id, this));
	}

	@RPC("in")
	SyncLobbies(ids: string[]) {
		const closedGames = this.games.filter(g => !ids.includes(g.id));
		closedGames.forEach(game => {
			Logger.warn(`Lobby ${game.id} closed, but was not removed`);
			game.CloseLobby(); // TODO: This fails to inform front-end clients of the lobby closing
		});

		const openedGames = ids.filter(id => !this.games.find(g => g.id == id));
		openedGames.forEach(id => {
			Logger.warn(`Lobby ${id} opened, but was not added`);
			this.games.push(new VTOLLobby(id, this));
		});
	}

	@RPC("in")
	ReportMemberInLobby(lobbyId: string, memberId: string, username: string, isPrivate: boolean, lobbyName: string, missionName: string) {
		// console.log(`Member ${memberId} (${username}) is in lobby ${lobbyId} (${lobbyName}) playing ${missionName}`);
		this.vtolUsersList.push({
			userId: memberId,
			username: username,
			lobbyId: lobbyId,
			lobbyName: lobbyName,
			missionName: missionName,
			isPrivate: isPrivate
		});
	}

	@RPC("in")
	BeginMemberReport() {
		this.vtolUsersList = [];
	}

	@RPC("in")
	requestJoinLobby(id: string) {
		this.hcManager.requestJoinLobby(id);
	}

	@RPC("in")
	requestJoinPrivateLobby(id: string, password: string) {
		this.hcManager.requestJoinLobby(id, password);
	}

	@RPC("in")
	RawLobbySync(
		lobbyName: string,
		ownerName: string,
		ownerId: string,
		scenarioName: string,
		scenarioId: string,
		maxPlayers: string,
		feature: string,
		envIdx: string,
		gameVersion: string,
		briefingRoom: string,
		hasPwd: boolean,
		ld_GameState: string,
		mUtc: string,
		playerCount: number
	) {
		const data: RawLobbyData = {
			lobbyName,
			ownerName,
			ownerId,
			scenarioName,
			scenarioId,
			maxPlayers,
			feature,
			envIdx,
			gameVersion,
			briefingRoom,
			hasPwd,
			ld_GameState,
			mUtc,
			playerCount
		};

		this.queuedLobbyData.push(data);
	}

	@RPC("in")
	RawLobbySyncDone(isPublicList: boolean) {
		this.rawLobbyData.lastUpdatedList = isPublicList ? "public" : "private";
		this.rawLobbyData.updatedAt = Date.now();
		this.rawLobbyData[this.rawLobbyData.lastUpdatedList] = this.queuedLobbyData;
		this.queuedLobbyData = [];
	}

	public closeLobby(lobby: VTOLLobby) {
		Logger.info(`Closing lobby ${lobby.id}`);
		RPCController.deregister(lobby);
		this.games = this.games.filter(g => g.id != lobby.id);
		const pl = this.createLobbyRPCs.length;
		this.createLobbyRPCs = this.createLobbyRPCs.filter(rpc => rpc.args[0] != lobby.id);
		if (pl == this.createLobbyRPCs.length) {
			Logger.warn(`Lobby ${lobby.id} was not found in pending RPCs for resync packet`);
		}
	}

	public handleVtolMessage(data: string, client: Client) {
		const packet = this.parseIPCPacket(data);
		if (!packet) return;
		switch (packet.type) {
			// Why is this a switch?
			case IPCTypes.rpcPacket: {
				// Packets with gameIds should be transmitted to only clients in that game
				if (packet.gameId) {
					this.getGame(packet.gameId)?.handleRPC(packet);
				} else {
					if (packet.className == "Application" && packet.method == "CreateLobby") {
						this.createLobbyRPCs.push(packet);
					} else if (packet.className == "VTOLLobby") {
						const g = this.getGame(packet.id);
						if (g) {
							g.handleLobbyPacket(packet);
						} else {
							Logger.error(`Lobby ${packet.id} not found for lobby packet ${JSON.stringify(packet)}`);
						}
					}
					// Using { ...packet } to clone as recording system attaches a timestamp, which is bad for compression
					this.pooledRpcs.push({ ...packet });
				}

				RPCController.handlePacket(packet, client);
				break;
			}
			default:
				Logger.error(`Unknown IPC type: ${packet.type}`);
		}
	}

	public assignHeadlessSocket(client: Client) {
		Logger.info(`Got new headless client socket connection`);
		// this.games = [];
		// const gameList = [...this.games];
		// gameList.forEach(game => {
		// 	game.CloseLobby();
		// });
		// this.createLobbyRPCs = [];
		this.headlessClients.push(client);
		client.isHeadlessClient = true;
	}

	public onHeadlessDisconnected() {
		Logger.warn(`Headless client disconnected!`);
		for (let i = this.games.length - 1; i >= 0; i--) {
			this.games[i].CloseLobby();
		}
	}

	@Event
	public lobbyConnected(lobbyId: string) {}

	@Event
	public lobbyDisconnected(lobbyId: string) {}

	@Event
	public lobbyData(lobbyId: string, data: RPCPacket[]) {}

	@Callable
	public getLobbyResyncRPCs(lobbyId: string): RPCPacket[] {
		const game = this.getGame(lobbyId);
		if (!game) return [];
		return game.getResyncPackets();
	}

	@Callable
	public headlessClientDisconnected() {}
}

export { Application };
