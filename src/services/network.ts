import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { NetworkRuntime, PoolConfig } from "../types";
import { config, networkRpcUrls } from "../config";
import { QUOTER_V2_ABI } from "../contracts/abis";

const QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

export class NetworkService {
  private networks: Map<string, NetworkRuntime> = new Map();
  private poolConfigs: Map<string, PoolConfig[]> = new Map();

  async initialize(): Promise<void> {
    for (const [networkKey, networkConfig] of Object.entries(config.networks)) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(
          networkRpcUrls[networkKey]
        );

        // Test the connection to the provider
        await provider.getBlockNumber();

        const quoter = new ethers.Contract(
          QUOTER_ADDRESS, // Use the hardcoded address instead of QUOTER_ADDRESSES
          QUOTER_V2_ABI,
          provider
        );

        const tokens: Record<string, Token> = {};
        for (const [symbol, tokenConfig] of Object.entries(
          config.tokens[networkKey]
        )) {
          tokens[symbol] = new Token(
            networkConfig.chainId,
            tokenConfig.address,
            tokenConfig.decimals,
            tokenConfig.symbol
          );
        }

        const networkRuntime: NetworkRuntime = {
          config: networkConfig,
          provider,
          quoter,
          tokens,
        };

        this.networks.set(networkKey, networkRuntime);
        this.poolConfigs.set(networkKey, config.pools[networkKey] || []);
      } catch (error: any) {
        throw new Error(
          `Failed to initialize network ${networkKey}: ${error.message}`
        );
      }
    }
  }

  getNetworks(): Map<string, NetworkRuntime> {
    return this.networks;
  }

  getPoolConfigs(): Map<string, PoolConfig[]> {
    return this.poolConfigs;
  }

  getNetwork(networkKey: string): NetworkRuntime | undefined {
    return this.networks.get(networkKey);
  }
}
