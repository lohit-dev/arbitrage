import { NetworkService } from "./services/network";
import { EventListenerService } from "./services/events";
import { ArbitrageService } from "./services/arbitrage";
import { logger } from "./utils/logger";
import { config } from "./config";
import { ethers } from "ethers";
import { ArbitrageOpportunity } from "./types";

class ArbitrageBot {
  private networkService: NetworkService;
  private eventListenerService!: EventListenerService;
  public arbitrageService!: ArbitrageService;

  constructor() {
    this.networkService = new NetworkService();
  }

  async start(): Promise<void> {
    try {
      logger.info("🚀 Starting Arbitrage Bot...");

      await this.networkService.initialize();
      logger.info("✅ Networks initialized");

      // Get initialized networks
      const networks = this.networkService.getNetworks();
      const poolConfigs = this.networkService.getPoolConfigs();

      // Create services after networks are initialized
      this.arbitrageService = new ArbitrageService(networks);
      this.eventListenerService = new EventListenerService(
        networks,
        poolConfigs
      );

      this.eventListenerService.setSwapEventCallback((swapEvent) => {
        this.arbitrageService.handleSwapEvent(swapEvent);
      });

      await this.eventListenerService.startListening();
      logger.info("✅ Event listeners started");

      await this.performInitialArbitrageCheck();

      logger.info(
        "🎯 Arbitrage Bot is now running and listening for opportunities..."
      );
    } catch (error) {
      logger.error("❌ Failed to start Arbitrage Bot:", error);
      process.exit(1);
    }
  }

  private async performInitialArbitrageCheck(): Promise<void> {
    try {
      logger.info("Trade amount: 1 SEED token");
      logger.info("Networks: Ethereum, Arbitrum");
      logger.info("🔍 UNISWAP ARBITRAGE SCANNER");

      const networks = this.networkService.getNetworks();

      // Ethereum Analysis
      logger.info("ETHEREUM ANALYSIS");
      logger.info("=".repeat(50));

      const ethPool = await this.arbitrageService.getPoolInfo("ethereum");
      logger.info(`Actual Fees: ${(ethPool.fee / 10000).toFixed(2)}%`);
      logger.info(
        `Token Order: ${ethPool.token0IsSeed ? "SEED/WETH" : "WETH/SEED"}`
      );

      logger.info("Quote Params:");
      const ethTokens = networks.get("ethereum")?.tokens;
      if (!ethTokens) throw new Error("Ethereum network not found");

      logger.info(`  TokenIn: ${ethTokens["SEED"].address} (SEED)`);
      logger.info(`  TokenOut: ${ethTokens["WETH"].address} (WETH)`);
      logger.info("  AmountIn: 1 SEED");
      logger.info(`  Fee: ${ethPool.fee}`);

      const ethQuote = await this.arbitrageService.getQuote(
        "ethereum",
        "SEED",
        "WETH",
        config.trading.defaultTradeAmount
      );
      const ethPrice = parseFloat(ethers.utils.formatEther(ethQuote));
      logger.info(`1 SEED = ${ethPrice.toFixed(8)} WETH`);
      const ethInverse = 1 / ethPrice;
      logger.info(`1 WETH = ${ethInverse.toFixed(2)} SEED`);

      // Arbitrum Analysis
      logger.info("ARBITRUM ANALYSIS");
      logger.info("=".repeat(50));

      const arbPool = await this.arbitrageService.getPoolInfo("arbitrum");
      logger.info(`Actual Fees: ${(arbPool.fee / 10000).toFixed(2)}%`);
      logger.info(
        `Token Order: ${arbPool.token0IsSeed ? "SEED/WETH" : "WETH/SEED"}`
      );

      logger.info("Quote Params:");
      const arbTokens = networks.get("arbitrum")?.tokens;
      if (!arbTokens) throw new Error("Arbitrum network not found");

      logger.info(`  TokenIn: ${arbTokens["SEED"].address} (SEED)`);
      logger.info(`  TokenOut: ${arbTokens["WETH"].address} (WETH)`);
      logger.info("  AmountIn: 1 SEED");
      logger.info(`  Fee: ${arbPool.fee}`);

      const arbQuote = await this.arbitrageService.getQuote(
        "arbitrum",
        "SEED",
        "WETH",
        config.trading.defaultTradeAmount
      );
      const arbPrice = parseFloat(ethers.utils.formatEther(arbQuote));
      logger.info(`1 SEED = ${arbPrice.toFixed(8)} WETH`);
      const arbInverse = 1 / arbPrice;
      logger.info(`1 WETH = ${arbInverse.toFixed(2)} SEED`);

      // Arbitrage Analysis
      logger.info("\n\nARBITRAGE OPPORTUNITY ANALYSIS");
      logger.info("=".repeat(50));

      // Determine arbitrage direction
      let buyNetwork, sellNetwork, buyPrice, sellPrice;

      if (ethPrice < arbPrice) {
        buyNetwork = "ethereum";
        sellNetwork = "arbitrum";
        buyPrice = ethPrice;
        sellPrice = arbPrice;
        logger.info(
          `Buy SEED on Ethereum at ${buyPrice.toFixed(
            8
          )} WETH | Gas estimate: 150,000 units`
        );
        logger.info(
          `Sell SEED on Arbitrum at ${sellPrice.toFixed(
            8
          )} WETH | Gas estimate: 80,000 units`
        );
      } else {
        buyNetwork = "arbitrum";
        sellNetwork = "ethereum";
        buyPrice = arbPrice;
        sellPrice = ethPrice;
        logger.info(
          `Buy SEED on Arbitrum at ${buyPrice.toFixed(
            8
          )} WETH | Gas estimate: 80,000 units`
        );
        logger.info(
          `Sell SEED on Ethereum at ${sellPrice.toFixed(
            8
          )} WETH | Gas estimate: 150,000 units`
        );
      }

      // Calculate profit and check if it exceeds threshold
      const priceDifference = Math.abs(sellPrice - buyPrice);
      const profitPercentage = priceDifference / buyPrice;
      const minProfitThreshold = parseFloat(config.trading.minProfitThreshold);

      logger.info(
        `Price difference: ${(profitPercentage * 100).toFixed(
          2
        )}% (threshold: ${(minProfitThreshold * 100).toFixed(2)}%)`
      );

      // Execute trade if profitable and auto-trading is enabled
      if (
        profitPercentage >= minProfitThreshold &&
        config.trading.autoTradeEnabled
      ) {
        logger.info("🚨 ARBITRAGE OPPORTUNITY DETECTED!");

        const tradeAmount = ethers.utils.formatEther(
          config.trading.defaultTradeAmount
        );
        const profitEstimate = (
          priceDifference * parseFloat(tradeAmount)
        ).toString();

        const opportunity: ArbitrageOpportunity = {
          buyNetwork,
          sellNetwork,
          buyPrice: buyPrice.toString(),
          sellPrice: sellPrice.toString(),
          priceDifference: priceDifference.toString(),
          profitEstimate,
          gasEstimate: buyNetwork === "ethereum" ? 150000 : 80000,
          timestamp: Date.now(),
        };

        try {
          logger.info(
            "🤖 Auto-trading is enabled. Executing arbitrage trade..."
          );

          // Execute the arbitrage trade
          const txHash =
            await this.arbitrageService.tradingService.executeArbitrage(
              opportunity.buyNetwork,
              opportunity.sellNetwork,
              "SEED", // The token we're trading
              tradeAmount
            );

          logger.info(
            `✅ Arbitrage trade completed successfully! Tx: ${txHash}`
          );
          logger.info(`💰 Expected profit: ${opportunity.profitEstimate} WETH`);
        } catch (error) {
          logger.error("❌ Failed to execute arbitrage trade:", error);
        }
      } else if (!config.trading.autoTradeEnabled) {
        logger.info("🛑 Auto-trading is disabled. Skipping trade execution.");
      } else {
        logger.info("No profitable arbitrage opportunity found.");
      }
    } catch (error) {
      logger.error("❌ Initial arbitrage check failed:", error);
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

  // Handle graceful shutdown by chatgpt
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
