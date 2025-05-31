//@ts-ignore
import secrets from "../secrets.js";
import { ServiceDefinition } from "./serviceManager.js";

const microservicePort = secrets.ports.core;
const microserviceKey = secrets.serviceConnectorKey;
const gatewayHost = secrets.gatewayHost;
const rootUrl = secrets.isDev ? `http://${gatewayHost}:8010/` : `https://${gatewayHost}`;
const gatewayUrl = secrets.isDev ? `http://${gatewayHost}:8010/api` : `${rootUrl}/api`;

const connectorEnv = [`SERVICE_CONNECTOR_URL=ws://localhost:${microservicePort}`, `SERVICE_KEY=${microserviceKey}`];
const awsEnv = [`AWS_KEY=${secrets.aws.accessKey}`, `AWS_SECRET=${secrets.aws.secretKey}`, `S3_BUCKET=${secrets.isDev ? "dev-" : ""}hc-vtgr`];

const dbName = "headless-client" + (secrets.isDev ? "-dev" : "");
const logIgnoreConfig = [{ serviceIdentifier: "Application", methodName: "lobbyData" }];

const steamCmdPath = secrets.isDev ? "../steamcmd/steamcmd.exe" : "";

export const isDev: boolean = secrets.isDev;
export const useHttpServer: boolean = secrets.isDev;

export default function (): ServiceDefinition[] {
	return [
		{
			name: "Microservice Core",
			path: "../../MicroserviceArch/core/dist/index.js",
			envs: [
				`PORT=${microservicePort}`,
				`SERVICE_KEY=${microserviceKey}`,
				`LOG_IGNORE=${JSON.stringify(logIgnoreConfig)}`,
				`REDUCE_FILE_LOGGING=${secrets.isDev.toString()}`
			]
		},
		{
			name: "Workshop",
			path: "../../HCServices/workshopService/dist/index.js",
			envs: [
				...connectorEnv,
				`API_PORT=${secrets.ports.workshop}`,
				`STEAM_USER=${secrets.steam.username}`,
				`STEAM_PASS=${secrets.steam.password}`,
				`STEAM_CMD_PATH=${steamCmdPath}`
			],
			gateway: { url: "/api/workshop", port: secrets.ports.workshop }
		},
		{
			name: "Database",
			path: "../../HCServices/databaseService/dist/index.js",
			envs: [...connectorEnv, `DB_NAME=${dbName}`, `DB_URL=${secrets.dbUrl}`]
		},
		{
			name: "Auth",
			path: "../../HCServices/authService/dist/index.js",
			envs: [
				...connectorEnv,
				`API_PORT=${secrets.ports.auth}`,
				`COOKIE_DOMAIN=${gatewayHost}`,
				`STEAM_REALM=${gatewayUrl}`,
				`STEAM_RETURN_URL=${gatewayUrl}/auth/steam/return`,
				`CLIENT_URL=${rootUrl}`,
				`STEAM_API_KEY=${secrets.steam.oauthKey}`,
				`JWT_KEY=${secrets.jwtKey}`
			],
			gateway: { url: "/api/auth", port: secrets.ports.auth }
		},
		{
			name: "Replay",
			path: "../../HCServices/replayService/dist/index.js",
			envs: [...connectorEnv, ...awsEnv, `API_PORT=${secrets.ports.replay}`],
			gateway: { url: "/api/replay", port: secrets.ports.replay }
		},
		{
			name: "VTGR",
			path: "../../HCServices/vtgrService/dist/index.js",
			envs: [...connectorEnv]
		},
		{
			name: "Storage",
			path: "../../HCServices/storageService/dist/index.js",
			envs: [...connectorEnv, ...awsEnv, `API_PORT=${secrets.ports.storage}`, `DATA_PATH=../store/`],
			gateway: { url: "/api/storage", port: secrets.ports.storage }
		},
		{
			name: "LandingRater",
			path: "../../HCServices/carrierLandingRater/dist/index.js",
			envs: [...connectorEnv, `API_PORT=${secrets.ports.landingRater}`],
			gateway: { url: "/api/lrs", port: secrets.ports.landingRater }
		}
	];
}
