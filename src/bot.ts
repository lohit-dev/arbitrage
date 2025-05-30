import { NetworkService } from "./services/network";
import { EventListenerService } from "./services/events";
import { ArbitrageService } from "./services/arbitrage";
import { logger } from "./utils/logger";
import { config } from "./config";
import { ArbitrageOpportunity, SwapEvent } from "./types";

class ArbitrageBot {
  private networkService: NetworkService;
  private eventListenerService!: EventListenerService;
  public arbitrageService!: ArbitrageService;
  private isProcessingEvent: boolean = false;
  private lastTradeTimestamp: number = 0;
  private myWalletAddress: string = "";

  // Add these to prevent spam
  private readonly COOLDOWN_PERIOD = 60000; // 1 minute between trades
  private readonly EVENT_PROCESS_DELAY = 3000; // 3 seconds after swap to process
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

      // Create services after networks are initialized
      this.arbitrageService = new ArbitrageService(networks);
      this.eventListenerService = new EventListenerService(
        networks,
        poolConfigs
      );

      // Get wallet address for filtering our own transactions
      this.myWalletAddress =
        this.arbitrageService.tradingService.wallet.address;
      logger.info(`🔑 Bot wallet address: ${this.myWalletAddress}`);

      // ✅ CRITICAL: Initialize pool states BEFORE starting event listeners
      logger.info("🔄 Initializing pool states from blockchain...");
      await this.arbitrageService.initializePoolStates();
      logger.info("✅ Pool states initialized successfully");

      // Set up event handler with proper filtering
      this.eventListenerService.setSwapEventCallback(async (swapEvent) => {
        await this.handleSwapEvent(swapEvent);
      });

      await this.eventListenerService.startListening();
      logger.info("✅ Event listeners started");

      // Initial delay and check as requested
      logger.info("⏳ Waiting 2 seconds before initial arbitrage check...");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Perform initial arbitrage check using the service method
      await this.performInitialArbitrageCheck();

      logger.info(
        "🎯 Arbitrage Bot is now running and listening for opportunities..."
      );
    } catch (error) {
      logger.error("❌ Failed to start Arbitrage Bot:", error);
      throw error;
    }
  }

  private async handleSwapEvent(swapEvent: SwapEvent): Promise<void> {
    // Prevent processing if already processing or in cooldown
    if (this.isProcessingEvent) {
      logger.debug("Already processing an event, skipping...");
      return;
    }

    // Check cooldown period
    const now = Date.now();
    if (now - this.lastTradeTimestamp < this.COOLDOWN_PERIOD) {
      logger.debug("In cooldown period, skipping event processing");
      return;
    }

    // Skip if we've already processed this block recently
    if (swapEvent.blockNumber <= this.lastProcessedBlock) {
      logger.debug("Already processed this block, skipping...");
      return;
    }

    // Filter out our own transactions
    if (
      swapEvent.sender.toLowerCase() === this.myWalletAddress.toLowerCase() ||
      swapEvent.recipient.toLowerCase() === this.myWalletAddress.toLowerCase()
    ) {
      logger.info("Skipping our own transaction");
      return;
    }

    try {
      this.isProcessingEvent = true;
      this.lastProcessedBlock = swapEvent.blockNumber;

      logger.info(
        `🔄 Processing swap event from tx: ${swapEvent.transactionHash}`
      );
      logger.info(` Network: ${swapEvent.network}`);
      logger.info(` Block: ${swapEvent.blockNumber}`);

      // Wait for blockchain state to settle
      await new Promise((resolve) =>
        setTimeout(resolve, this.EVENT_PROCESS_DELAY)
      );

      // Use the ArbitrageService's method instead of our own
      await this.arbitrageService.handleSwapEvent(swapEvent);
    } catch (error) {
      logger.error("Error processing swap event:", error);
    } finally {
      this.isProcessingEvent = false;
    }
  }

  // Updated initial check with better error handling
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

  // ✅ NEW: Add method to manually refresh pool states (useful for debugging)
  async refreshPoolStates(): Promise<void> {
    logger.info("🔄 Manually refreshing pool states...");
    try {
      await this.arbitrageService.initializePoolStates();
      logger.info("✅ Pool states refreshed successfully");

      // Check for opportunities after refresh
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

  process.on("SIGUSR1", async () => {
    logger.info("\n🔄 Received SIGUSR1, refreshing pool states...");
    await bot.refreshPoolStates();
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
