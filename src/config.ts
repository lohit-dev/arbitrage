import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { Config } from "./types";

// Load environment variables from .env.local first, then fall back to .env
dotenvConfig({ path: path.resolve(process.cwd(), ".env.local") });
dotenvConfig(); // This will load from .env as a fallback

const configPath = path.join(__dirname, "..", "config.test.json");
const configFile = fs.readFileSync(configPath, "utf8");
export const config: Config = JSON.parse(configFile);

const ethereumRpc = process.env.ETHEREUM_RPC || "https://eth.llamarpc.com";
const arbitrumRpc = process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc";

console.log(`Using Ethereum RPC: ${ethereumRpc}`);
console.log(`Using Arbitrum RPC: ${arbitrumRpc}`);

export const env = {
  ETHEREUM_RPC: ethereumRpc,
  ARBITRUM_RPC: arbitrumRpc,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  WALLET_ADDRESS: process.env.WALLET_ADDRESS,
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  NODE_ENV: process.env.NODE_ENV || "development",
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
};

export const discordConfig = {
  webhookUrl: env.webhookUrl,
};

export const networkRpcUrls: Record<string, string> = {
  ethereum: env.ETHEREUM_RPC,
  arbitrum: env.ARBITRUM_RPC,
};
