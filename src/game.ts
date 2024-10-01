import { compressRpcPackets } from "common/compression/vtcompression.js";
import { Logger } from "common/logger.js";
import { EnableRPCs, RPC, RPCPacket } from "common/rpc.js";
import { Player, RawPlayerInfo } from "common/shared.js";

import { Application } from "./app.js";
import { Client } from "./client.js";

function compareStrOrArr(str: string, opts: string | string[]) {
	if (typeof opts == "string") {
		return str == opts;
	}
	return opts.includes(str);
}

interface ResyncPacketFilter {
	className: string | string[];
	method: string | string[];
}

// Packets that we send to new clients when they connect
// Some additional could possibly be added, such as lock-lines
const resyncPacketFilter: ResyncPacketFilter[] = [
	{ className: ["MessageHandler"], method: ["NetInstantiate", "NetDestroy", "SetEntityUnitID", "CreateJammer"] },
	{ className: ["RadarJammerSync"], method: ["TDecoyModel", "TMode"] },
	{ className: ["PlayerVehicle", "AIAirVehicle", "AIGroundUnit"], method: ["Die", "Spawn"] },
	{ className: ["VTOLLobby"], method: ["LogMessage"] }
];
// const LOBBY_INACTIVITY_TIMEOUT = 1000 * 60; // 1 minute
const LOBBY_INACTIVITY_TIMEOUT = 1000 * 5; // 5 seconds

@EnableRPCs("instance", ["NuclearOptionLobby"])
class VTOLLobby {
	subscribedClients: Client[] = [];
	private resyncPackets: RPCPacket[] = [];
	public lastLobbyInfo: RPCPacket;
	public lastMissionInfo: RPCPacket;
	public lastStatusInfo: RPCPacket;

	private prevConnectStatus = false;

	public id: string;
	public name: string;
	public missionName: string;
	public playerCount: number;
	public maxPlayers: number;
	public isConnected: boolean;
	public isPrivate: boolean;
	public players: Player[] = [];

	public isHs = false;
	private lastHealthCheckTime = Date.now();

	private missionId: string;
	private campaignId: string;
	private workshopId: string;

	private disconnectTimeStart: number = 0;
	private continuousRecord = false;
	private continuousRecordPassword: string = undefined;
	private contRecordJoinStartedAt = 0;

	private pooledRpcs: RPCPacket[] = [];
	private pooledVTLobbyPackets: RPCPacket[] = [];

	constructor(id: string, private app: Application) {
		this.id = id;
	}

	@RPC("in")
	UpdateLobbyInfo(
		name: string,
		missionName: string,
		playerCount: number,
		maxPlayers: number,
		isPrivate: boolean,
		isConnected: boolean,
		players: RawPlayerInfo[],
		hostId: string,
		hostName: string
	) {
		this.name = name;
		this.missionName = missionName;
		this.playerCount = playerCount;
		this.maxPlayers = maxPlayers;
		this.players = players.map(p => new Player(p));
		this.isConnected = isConnected;
		this.isPrivate = isPrivate;

		// Logger.info(`Lobby data update for ${this.id}: ${this.name} (${this.missionName}) ${this.playerCount}/${this.maxPlayers} ${this.isPrivate ? "private" : "public"} ${this.isConnected ? "connected" : "1`ed"}`);

		if (this.isConnected && !this.prevConnectStatus) this.onConnect();
		if (!this.isConnected && this.prevConnectStatus) this.onDisconnect();
		this.prevConnectStatus = this.isConnected;

		// Yea this code aint great
		if (this.name.includes("24/7 BVR") && this.playerCount > 1) {
			this.isHs = true;
			if (process.env.IS_DEV != "true") this.continuousRecord = true;
		}

		if (this.workshopId == "3104789609") {
			this.continuousRecord = true;
			this.continuousRecordPassword = "1776";
			// Logger.warn(`Lobby ${this} is a continuous record lobby due to workshop ID`);
		}
	}

	@RPC("in")
	UpdateMissionInfo(name: string, id: string, campaignId: string, workshopId: string, mapId: string, isBuiltin: boolean) {
		// console.log({ name, id, campaignId, workshopId, mapId, isBuiltin });
		this.missionId = id;
		this.campaignId = campaignId;
		this.workshopId = workshopId;
	}

	@RPC("in")
	CloseLobby() {
		// Logger.info(`Lobby ${this} had RPC CloseLobby called`);
		if (this.isConnected) this.onDisconnect();
		this.app.closeLobby(this);
	}

	@RPC("in")
	SyncLeaveLobby() {
		Logger.info(`Got leave lobby notification for ${this.missionName} (${this.id})`);
		this.resyncPackets = [];

		this.flushRpcs();
	}

	@RPC("in")
	SyncLobbyRestart() {
		Logger.info(`Lobby ${this} is restarting`);
	}

	@RPC("in")
	LogMessage(message: string) {}

	@RPC("in")
	UpdateLobbyStatus() {}

	@RPC("in")
	LobbyHealthCheck() {
		this.lastHealthCheckTime = Date.now();
	}

	@RPC("in")
	ConnectionResult(result: boolean, reason: string) {
		console.log(`Connection result for ${this.name} (${this.id}): ${result ? "Success" : "Failure"}: ${reason}`);
		if (this.continuousRecord && !result) {
			this.contRecordJoinStartedAt = 0;
		}
	}

	@RPC("out")
	isRecording(isRecording: boolean) {}

	public syncIsRecording() {
		this.isRecording(this.continuousRecord);
	}

	private async onConnect() {
		Logger.info(`Lobby ${this.name} (${this.id}) connected`);
		this.app.lobbyConnected(this.id);

		// if (this.recorder != null) {
		// 	Logger.warn(`Recorder already exists for lobby ${this.name} (${this.id}), stopping it`);
		// 	await this.recorder.stop();
		// }
		// this.recorder = new GameDataRecorder(this.app, this);
		// this.recorder.init();
	}

	private onDisconnect() {
		Logger.info(`Lobby ${this.name} (${this.id}) disconnected`);
		// this.recorder.stop();
		// this.recorder = null;
		this.app.lobbyDisconnected(this.id);

		this.resyncPackets = [];
		this.pooledRpcs = [];
	}

	public handleRPC(rpc: RPCPacket) {
		this.maybeAddResyncPacket(rpc);
		this.pooledRpcs.push(rpc);
	}

	public enableRecording(password: string) {
		this.continuousRecord = true;
		if (password) this.continuousRecordPassword = password;

		this.syncIsRecording();
	}

	public handleLobbyPacket(packet: RPCPacket) {
		switch (packet.method) {
			case "UpdateLobbyInfo":
				this.lastLobbyInfo = packet;
				break;
			case "UpdateMissionInfo":
				this.lastMissionInfo = packet;
				break;
			case "UpdateLobbyStatus":
				this.lastStatusInfo = packet;
				break;
			default:
				break;
		}

		// this.maybeAddResyncPacket(packet);
		// this.handleRPC(packet);
		this.pooledVTLobbyPackets.push(packet);
		this.maybeAddResyncPacket(packet);
	}

	private flushRpcs() {
		if (this.pooledRpcs.length > 0) {
			const bytes = new Uint8Array(compressRpcPackets(this.pooledRpcs, false));
			this.subscribedClients.forEach(c => c.send(bytes));

			// pooledVTLobbyPackets contain messages that occurred on the VTOLLobby,
			// which get sent to clients via the main server, and as such aren't in the pooled RPCs to prevent double sending
			if (this.pooledVTLobbyPackets.length > 0) {
				const allPackets = this.pooledVTLobbyPackets.concat(this.pooledRpcs);
				this.app.lobbyData(this.id, allPackets);
			} else {
				this.app.lobbyData(this.id, this.pooledRpcs);
			}

			this.pooledRpcs = [];
			this.pooledVTLobbyPackets = [];
		}
	}

	private maybeAddResyncPacket(packet: RPCPacket) {
		const isResyncPacket = resyncPacketFilter.some(
			filter => compareStrOrArr(packet.className, filter.className) && compareStrOrArr(packet.method, filter.method)
		);
		if (isResyncPacket) this.resyncPackets.push(packet);
	}

	public disconnect() {
		this.app.hcManager.requestLeaveLobby(this.id);
		this.onDisconnect();
		this.prevConnectStatus = false;
		this.isConnected = false;
		this.disconnectTimeStart = 0;
	}

	public update() {
		// if (this.id == "109775243536149480") console.log(`Lobby ${this.name}: ${this.isConnected ? "Connected" : "Disconnected"}`);
		this.subscribedClients = this.subscribedClients.filter(c => c.isAlive());

		if (this.isConnected) {
			this.contRecordJoinStartedAt = 0;

			// Begin disconnect timer once no clients are observing the lobby
			if (this.subscribedClients.length == 0) {
				if (this.disconnectTimeStart == 0) this.disconnectTimeStart = Date.now();
			} else {
				this.disconnectTimeStart = 0;
			}

			if (Date.now() - this.lastHealthCheckTime > 1000 * 15) {
				// Logger.warn(`Lobby ${this} has not received a health check in 15 seconds`);
				// this.disconnect();
			}
			if (!this.continuousRecord && this.disconnectTimeStart != 0 && Date.now() - this.disconnectTimeStart > LOBBY_INACTIVITY_TIMEOUT) {
				Logger.info(`Disconnecting from lobby ${this.id} due to inactivity`);
				this.disconnect();
			}
		} else {
			if (this.continuousRecord && (this.contRecordJoinStartedAt == 0 || Date.now() - this.contRecordJoinStartedAt > 60_000) && this.playerCount >= 1) {
				Logger.info(`Continuous record for ${this} is set but not connected. Attempting to connect now`);
				this.app.hcManager.requestJoinLobby(this.id, this.continuousRecordPassword);
				this.contRecordJoinStartedAt = Date.now();
			}
		}

		this.flushRpcs();
	}

	public getResyncPackets() {
		return [this.lastMissionInfo, this.lastLobbyInfo, ...this.resyncPackets].filter(p => p != null);
	}

	public getListResyncPackets() {
		return [this.lastMissionInfo, this.lastLobbyInfo, this.lastStatusInfo].filter(p => p != null);
	}

	public unsubscribe(client: Client) {
		this.subscribedClients = this.subscribedClients.filter(c => c != client);
	}

	public subscribe(client: Client) {
		this.subscribedClients.push(client);

		// Build resync packet
		const packets = this.getResyncPackets();
		const bytes = new Uint8Array(compressRpcPackets(packets, false));
		// fs.writeFileSync(`../resync-${client.id}.bin`, Buffer.from(bytes.buffer));
		// fs.writeFileSync(`../resync-${client.id}.json`, JSON.stringify(packets, null, 2));

		client.send(bytes);
		Logger.info(`Created resync packet with ${packets.length} packets to ${client.id}`);
	}

	public toString() {
		return `${this.name} (${this.id})`;
	}
}
export { VTOLLobby };
