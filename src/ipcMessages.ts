enum IPCTypes {
	rpcPacket = "rpcPacket"
}

interface IPCRPCPacket {
	className: string;
	method: string;
	args: any[];
	id?: string;
	gameId?: string;
	type: IPCTypes.rpcPacket;
}

type IPCPacket = IPCRPCPacket;

export { IPCRPCPacket, IPCPacket, IPCTypes };
