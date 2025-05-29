import { NetworkService } from "./services/network";
import { EventListenerService } from "./services/events";
import { ArbitrageService } from "./services/arbitrage";
import { logger } from "./utils/logger";
import { config } from "./config";
import { ethers } from "ethers";
import { ArbitrageOpportunity, SwapEvent } from "./types";

class ArbitrageBot {
  private networkService: NetworkService;
  private eventListenerService!: EventListenerService;
  public arbitrageService!: ArbitrageService;
  private isProcessingEvent: boolean = false;
  private lastTradeTimestamp: number = 0;
  private readonly TRADE_COOLDOWN = 60000; // 1 minute cooldown
  private myWalletAddress: string = "";

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
      this.eventListenerService = new EventListenerService(networks, poolConfigs);

      // Get wallet address for filtering our own transactions
      this.myWalletAddress = this.arbitrageService.tradingService.wallet.address;
      logger.info(`🔑 Bot wallet address: ${this.myWalletAddress}`);

      // Set up event handler
      this.eventListenerService.setSwapEventCallback(async (swapEvent) => {
        await this.handleSwapEvent(swapEvent);
      });

      await this.eventListenerService.startListening();
      logger.info("✅ Event listeners started");

      // Initial delay and check as requested
      logger.info("⏳ Waiting 2 seconds before initial arbitrage check...");
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Perform initial arbitrage check
      await this.performArbitrageCheck();

      logger.info("🎯 Arbitrage Bot is now running and listening for opportunities...");
    } catch (error) {
      logger.error("❌ Failed to start Arbitrage Bot:", error);
      throw error;
    }
  }

  private async handleSwapEvent(swapEvent: SwapEvent): Promise<void> {
    try {
      // Log the swap event details
      logger.info(`🔄 Processing swap event from tx: ${swapEvent.transactionHash}`);
      logger.info(`    Network: ${swapEvent.network}`);
      logger.info(`    Pool: ${swapEvent.poolAddress}`);

      // Wait for blockchain state to update
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Perform new arbitrage check after swap
      await this.performArbitrageCheck();
    } catch (error) {
      logger.error("Error processing swap event:", error);
    }
  }

  private async performArbitrageCheck(): Promise<void> {
    try {
      // Check if enough time has passed since last trade
      const now = Date.now();

      logger.info("\n🔍 Performing arbitrage check...");
      logger.info("=".repeat(50));

      const networks = this.networkService.getNetworks();

      // Get quotes from both networks
      const ethQuote = await this.arbitrageService.getQuote(
        "ethereum",
        "SEED",
        "WETH",
        config.trading.defaultTradeAmount
      );

      const arbQuote = await this.arbitrageService.getQuote(
        "arbitrum",
        "SEED",
        "WETH",
        config.trading.defaultTradeAmount
      );

      // Convert to float for comparison
      const ethPrice = parseFloat(ethers.utils.formatEther(ethQuote));
      const arbPrice = parseFloat(ethers.utils.formatEther(arbQuote));

      logger.info(`Ethereum Price: ${ethPrice.toFixed(8)} WETH/SEED`);
      logger.info(`Arbitrum Price: ${arbPrice.toFixed(8)} WETH/SEED`);

      // Determine arbitrage direction
      let buyNetwork, sellNetwork, buyPrice, sellPrice;

      if (ethPrice < arbPrice) {
        buyNetwork = "ethereum";
        sellNetwork = "arbitrum";
        buyPrice = ethPrice;
        sellPrice = arbPrice;
      } else {
        buyNetwork = "arbitrum";
        sellNetwork = "ethereum";
        buyPrice = arbPrice;
        sellPrice = ethPrice;
      }

      // Calculate profit and check if it exceeds threshold
      const priceDifference = Math.abs(sellPrice - buyPrice);
      const profitPercentage = priceDifference / buyPrice;
      const minProfitThreshold = parseFloat(config.trading.minProfitThreshold);

      logger.info(
        `Price difference: ${(profitPercentage * 100).toFixed(2)}% (threshold: ${(
          minProfitThreshold * 100
        ).toFixed(2)}%)`
      );

      if (profitPercentage >= minProfitThreshold && config.trading.autoTradeEnabled) {
        this.lastTradeTimestamp = now; // Update last trade timestamp

        const tradeAmount = ethers.utils.formatEther(
          config.trading.defaultTradeAmount
        );
        const opportunity: ArbitrageOpportunity = {
          buyNetwork,
          sellNetwork,
          buyPrice: buyPrice.toString(),
          sellPrice: sellPrice.toString(),
          priceDifference: priceDifference.toString(),
          profitEstimate: (
            priceDifference * parseFloat(tradeAmount)
          ).toString(),
          gasEstimate: buyNetwork === "ethereum" ? 150000 : 80000,
          timestamp: Date.now(),
        };

        logger.info("🚨 ARBITRAGE OPPORTUNITY DETECTED!");

        // Execute the trade - this will generate swap events that trigger the next check
        await this.executeArbitrageTrade(opportunity, tradeAmount);
        // The next check will happen when we receive the swap event from this trade
      } else {
        // No continuous polling - only check on swap events
        logger.info("No profitable opportunity found. Waiting for next swap event...");
      }
    } catch (error) {
      logger.error("❌ Arbitrage check failed:", error);
    }
  }

  private async executeArbitrageTrade(
    opportunity: ArbitrageOpportunity,
    tradeAmount: string
  ): Promise<void> {
    try {
      logger.info("🤖 Executing arbitrage trade...");
      logger.info(
        `Buy on ${opportunity.buyNetwork} at ${opportunity.buyPrice} WETH`
      );
      logger.info(
        `Sell on ${opportunity.sellNetwork} at ${opportunity.sellPrice} WETH`
      );
      logger.info(`Expected profit: ${opportunity.profitEstimate} WETH`);

      // Execute trade and wait for transaction
      const txHash = await this.arbitrageService.tradingService.executeArbitrage(
        opportunity.buyNetwork,
        opportunity.sellNetwork,
        "SEED",
        tradeAmount
      );

      logger.info(`✅ Trade executed! Tx: ${txHash}`);
      logger.info("🔄 This trade will generate swap events that will trigger the next opportunity check...");
    } catch (error) {
      logger.error("❌ Failed to execute arbitrage trade:", error);
      // On trade failure, continue checking for opportunities
      setTimeout(() => {
        if (!this.isProcessingEvent) {
          this.performArbitrageCheck();
        }
      }, 5000);
    }
  }

  async stop(): Promise<void> {
    logger.info("🛑 Stopping Arbitrage Bot...");
    this.eventListenerService.stop();
    logger.info("✅ Arbitrage Bot stopped");
  }
}

async function main(): Promise<void> {
  const bot = new ArbitrageBot();

  // Handle graceful shutdown
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