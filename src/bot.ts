import { NetworkService } from "./services/network";
import { EventListenerService } from "./services/events";
import { ArbitrageService } from "./services/arbitrage";
import { logger } from "./utils/logger";
import { config } from "./config";

/**
 * Arbitrage Bot for detecting and executing arbitrage opportunities
 * across multiple networks and liquidity pools.
 *
 * This bot listens for swap events, checks for arbitrage opportunities,
 * and executes trades if configured to do so.
 */
class ArbitrageBot {
  private networkService: NetworkService;
  private eventListenerService!: EventListenerService;
  public arbitrageService!: ArbitrageService;
  private isProcessingEvent: boolean = false;
  private lastTradeTimestamp: number = 0;
  private myWalletAddress: string = "";

  private readonly COOLDOWN_PERIOD = 60000;
  private readonly EVENT_PROCESS_DELAY = 3000;
  private lastProcessedBlock: number = 0;

  constructor() {
    this.networkService = new NetworkService();
  }

  async start(): Promise<void> {
    try {
      logger.info("🚀 Starting Arbitrage Bot...");
      await this.networkService.initialize();
      logger.info("✅ Networks initialized");

      const networks = this.networkService.getNetworks();
      const poolConfigs = this.networkService.getPoolConfigs();

      // Create services after networks are initialized very important!
      this.arbitrageService = new ArbitrageService(networks);
      this.eventListenerService = new EventListenerService(
        networks,
        poolConfigs
      );

      // Just for logging bot address
      this.myWalletAddress =
        this.arbitrageService.tradingService.wallet.address;
      logger.info(`🔑 Bot wallet address: ${this.myWalletAddress}`);

      logger.info("🔄 Initializing pool states from blockchain...");
      await this.arbitrageService.initializePoolStates();
      logger.info("✅ Pool states initialized successfully");

      this.eventListenerService.setSwapEventCallback(async (swapEvent) => {
        await this.arbitrageService.handleSwapEvent(swapEvent);
      });

      await this.eventListenerService.startListening();
      logger.info("✅ Event listeners started");

      logger.info("⏳ Waiting 2 seconds before initial arbitrage check...");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // initial check
      await this.performInitialArbitrageCheck();

      logger.info(
        "🎯 Arbitrage Bot is now running and listening for opportunities..."
      );
    } catch (error) {
      logger.error("❌ Failed to start Arbitrage Bot:", error);
      throw error;
    }
  }

  private async performInitialArbitrageCheck(): Promise<void> {
    try {
      logger.info("\n🔍 Performing initial arbitrage check...");
      logger.info("=".repeat(50));

      // First verify that pool states are properly initialized
      const opportunity =
        await this.arbitrageService.checkArbitrageOpportunity();

      if (opportunity) {
        logger.info("🎯 Initial arbitrage opportunity found!");

        if (config.trading.autoTradeEnabled) {
          logger.info("🤖 Auto-trading enabled, executing trade...");
          this.lastTradeTimestamp = Date.now();
          await this.arbitrageService.handleArbitrageOpportunity(opportunity);
        } else {
          logger.info(
            "🛑 Auto-trading disabled, opportunity detected but not executed"
          );
        }
      } else {
        logger.info(
          "✅ No profitable opportunity found initially. Bot is ready and waiting for swap events..."
        );
      }
    } catch (error) {
      logger.error("❌ Initial arbitrage check failed:", error);
      logger.info(
        "💡 Bot will continue running and try again when swap events occur"
      );
    }
  }

  async stop(): Promise<void> {
    logger.info("🛑 Stopping Arbitrage Bot...");
    this.eventListenerService.stop();
    logger.info("✅ Arbitrage Bot stopped");
  }

  // helper can use anywhere
  async refreshPoolStates(): Promise<void> {
    logger.info("🔄 Manually refreshing pool states...");
    try {
      await this.arbitrageService.initializePoolStates();
      logger.info("✅ Pool states refreshed successfully");

      const opportunity =
        await this.arbitrageService.checkArbitrageOpportunity();
      if (opportunity) {
        logger.info("🎯 Opportunity found after refresh!");
      } else {
        logger.info("No opportunities found after refresh");
      }
    } catch (error) {
      logger.error("❌ Failed to refresh pool states:", error);
    }
  }
}

async function main(): Promise<void> {
  const bot = new ArbitrageBot();

  process.on("SIGINT", async () => {
    logger.info("\n👋 Received SIGINT, shutting down gracefully...");
    await bot.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("\n👋 Received SIGTERM, shutting down gracefully...");
    await bot.stop();
    process.exit(0);
  });

  await bot.start();
  logger.info("🎉 Arbitrage Bot started successfully!");
}

if (require.main === module) {
  main().catch((error) => {
    logger.error("💥 Unhandled error:", {
      message: error.message,
      stack: error.stack,
      details: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
    process.exit(1);
  });
}

export { ArbitrageBot };
