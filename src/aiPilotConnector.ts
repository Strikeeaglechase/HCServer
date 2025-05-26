import { RPCPacket } from "common/rpc.js";
import { Vector3 } from "common/shared.js";

import { VTOLLobby } from "./game.js";

enum AIPEntityType {
	Player,
	Missile
}

class AIPEntity {
	public id: number;
	public kind: AIPEntityType;

	public position: Vector3 = { x: 0, y: 0, z: 0 };
	public rotation: Vector3 = { x: 0, y: 0, z: 0 };
	public velocity: Vector3 = { x: 0, y: 0, z: 0 };
	public acceleration: Vector3;
}
const playerVehicleRPCClasses = ["PlayerVehicle", "F45A", "FA26B", "AV42", "AH94", "T55", "EF24"];
const playerVehicleTypes = ["Vehicles/SEVTF", "Vehicles/FA-26B", "Vehicles/F-16", "Vehicles/AH-94", "Vehicles/VTOL4", "Vehicles/T-55", "Vehicles/EF-24"];

class AIPilotConnector {
	private entities: AIPEntity[] = [];

	constructor(private lobby: VTOLLobby) {}

	public handlePacket(packet: RPCPacket) {
		if (packet.className == "MessageHandler") this.handleMessageHandler(packet);
		else if (playerVehicleRPCClasses.includes(packet.className)) this.handleVehiclePacket(packet);
		else if (packet.className == "MissileEntity") this.handleMissilePacket(packet);
	}

	private handleMessageHandler(packet: RPCPacket) {
		switch (packet.method) {
			case "NetInstantiate": {
				const [id, ownerId, path, pos, rot, active] = packet.args;
				if (!playerVehicleTypes.includes(path) && !path.match(/weapons\/missiles\/.*/i)) return;

				const entity = new AIPEntity();
				entity.id = +id;
				entity.position = pos;
				entity.rotation = rot;
				entity.kind = playerVehicleTypes.includes(path) ? AIPEntityType.Player : AIPEntityType.Missile;
				this.entities.push(entity);
				break;
			}

			case "NetDestroy": {
				const [id] = packet.args;
				this.entities = this.entities.filter(entity => entity.id != id);
				break;
			}
		}
	}

	private handleMissilePacket(packet: RPCPacket) {
		// MissileEntity
		if (packet.method != "SyncShit") return;
		const [pos, rot, vel, accel] = packet.args;
		const ent = this.entities.find(entity => entity.id == +packet.id);
		if (!ent) {
			console.log(`Missile ${packet.id} not found`);
			return;
		}

		ent.position = pos;
		ent.rotation = rot;
		ent.velocity = vel;
		ent.acceleration = accel;
	}

	private handleVehiclePacket(packet: RPCPacket) {
		if (packet.method != "UpdateData") return;

		const [pos, vel, accel, rot, throttle, isLanded, pyr] = packet.args;
		const ent = this.entities.find(entity => entity.id == +packet.id);
		if (!ent) {
			console.log(`Entity ${packet.id} not found`);
			return;
		}

		ent.position = pos;
		ent.velocity = vel;
		ent.acceleration = accel;
		ent.rotation = rot;
	}
}

export { AIPilotConnector };
