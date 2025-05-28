import { ethers } from "ethers";
import { NetworkRuntime, SwapEvent, PoolConfig } from "../types";
import { logger } from "../utils/logger";
import { POOL_ABI } from "../contracts/abis";

export class EventListenerService {
  private networks: Map<string, NetworkRuntime> = new Map();
  private poolConfigs: Map<string, PoolConfig[]> = new Map();
  private swapEventCallback?: (event: SwapEvent) => void;

  constructor(
    networks: Map<string, NetworkRuntime>,
    poolConfigs: Map<string, PoolConfig[]>
  ) {
    this.networks = networks;
    this.poolConfigs = poolConfigs;
  }

  setSwapEventCallback(callback: (event: SwapEvent) => void): void {
    this.swapEventCallback = callback;
  }

  async startListening(): Promise<void> {
    logger.info("🎧 Starting event listeners for all pools...");

    for (const [networkKey, networkRuntime] of this.networks) {
      const pools = this.poolConfigs.get(networkKey) || [];

      for (const pool of pools) {
        await this.listenToPoolEvents(networkKey, networkRuntime, pool);
      }
    }

    logger.info("✅ All event listeners started successfully");
  }

  private async listenToPoolEvents(
    networkKey: string,
    networkRuntime: NetworkRuntime,
    poolConfig: PoolConfig
  ): Promise<void> {
    try {
      const poolContract = new ethers.Contract(
        poolConfig.address,
        POOL_ABI,
        networkRuntime.provider
      );
      logger.info(
        `Connecting to ${networkKey} at URL:`,
        (networkRuntime.provider as ethers.providers.JsonRpcProvider).connection
          .url
      );

      logger.info(
        `📡 Listening to ${networkRuntime.config.name} pool: ${poolConfig.address}`
      );

      poolContract.on(
        "Swap",
        (
          sender: string,
          recipient: string,
          amount0: ethers.BigNumber,
          amount1: ethers.BigNumber,
          sqrtPriceX96: ethers.BigNumber,
          liquidity: ethers.BigNumber,
          tick: number,
          event: ethers.Event
        ) => {
          const swapEvent: SwapEvent = {
            poolAddress: poolConfig.address,
            network: networkKey,
            sender,
            recipient,
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            sqrtPriceX96: sqrtPriceX96.toString(),
            liquidity: liquidity.toString(),
            tick,
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
          };

          logger.info(
            `🔄 Swap detected on ${networkRuntime.config.name}: ${event.transactionHash}`
          );

          if (this.swapEventCallback) {
            this.swapEventCallback(swapEvent);
          }
        }
      );

      // Handle connection errors
      networkRuntime.provider.on("error", (error) => {
        logger.error(`❌ ${networkRuntime.config.name} provider error:`, error);

        setTimeout(() => {
          this.reconnectToNetwork(networkKey, networkRuntime, poolConfig);
        }, 5000);
      });
    } catch (error) {
      logger.error(
        `❌ Failed to setup event listener for ${networkKey} pool ${poolConfig.address}:`,
        error
      );
    }
  }

  private async reconnectToNetwork(
    networkKey: string,
    networkRuntime: NetworkRuntime,
    poolConfig: PoolConfig
  ): Promise<void> {
    try {
      logger.info(`🔄 Reconnecting to ${networkRuntime.config.name}...`);
      await this.listenToPoolEvents(networkKey, networkRuntime, poolConfig);
      logger.info(`✅ Reconnected to ${networkRuntime.config.name}`);
    } catch (error) {
      logger.error(`❌ Reconnection failed for ${networkKey}:`, error);
      setTimeout(() => {
        this.reconnectToNetwork(networkKey, networkRuntime, poolConfig);
      }, 10000);
    }
  }

  stop(): void {
    logger.info("🛑 Stopping all event listeners...");

    for (const [networkKey, networkRuntime] of this.networks) {
      networkRuntime.provider.removeAllListeners();
    }

    logger.info("✅ All event listeners stopped");
  }
}
