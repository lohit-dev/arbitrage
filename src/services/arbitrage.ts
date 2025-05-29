import { ethers } from "ethers";
import {
  NetworkRuntime,
  SwapEvent,
  PoolState,
  ArbitrageOpportunity,
  PoolInfo,
} from "../types";
import { config } from "../config";
import { logger } from "../utils/logger";
import { SIMPLE_POOL_ABI, POOL_ABI } from "../contracts/abis";
import { TradingService } from "./trading";
import { DiscordNotificationService } from "./notification";
import { discordConfig } from "../config";

export class ArbitrageService {
  private networks: Map<string, NetworkRuntime> = new Map();
  private poolStates: Map<string, PoolState> = new Map();
  public tradingService: TradingService;
  public discordNotifications: DiscordNotificationService;
  private isTrading: boolean = false; // Add this flag
  private pendingOpportunities: ArbitrageOpportunity[] = []; // Add this queue

  constructor(networks: Map<string, NetworkRuntime>) {
    this.networks = networks;
    this.tradingService = new TradingService(networks);
    this.discordNotifications = new DiscordNotificationService(
      discordConfig.webhookUrl
    ); // Initialize
  }

  async handleSwapEvent(swapEvent: SwapEvent): Promise<void> {
    // If we're currently trading, queue the event for later
    if (this.isTrading) {
      logger.info("Trade in progress, deferring swap event processing...");
      return;
    }

    try {
      this.isTrading = true;
      await this.updatePoolState(swapEvent);
      await this.checkArbitrageOpportunity();
    } catch (error) {
      logger.error("Error processing swap event:", error);
    } finally {
      this.isTrading = false;
    }
  }

  private async updatePoolState(swapEvent: SwapEvent): Promise<void> {
    const poolKey = `${swapEvent.network}-${swapEvent.poolAddress}`;
    const networkRuntime = this.networks.get(swapEvent.network);

    if (!networkRuntime) {
      logger.error(`Network runtime not found for ${swapEvent.network}`);
      return;
    }

    try {
      // Create contract instance for the pool
      const poolContract = new ethers.Contract(
        swapEvent.poolAddress,
        SIMPLE_POOL_ABI,
        networkRuntime.provider
      );

      // Create a full pool contract to get slot0 data
      const fullPoolContract = new ethers.Contract(
        swapEvent.poolAddress,
        POOL_ABI,
        networkRuntime.provider
      );

      // Fetch pool data in parallel
      const [slot0, fee, token0, token1] = await Promise.all([
        fullPoolContract.slot0(),
        poolContract.fee(),
        poolContract.token0(),
        poolContract.token1(),
      ]);

      // Get token symbols from addresses
      const token0IsSeed =
        token0.toLowerCase() ===
        networkRuntime.tokens["SEED"].address.toLowerCase();

      // Create pool state
      const poolState: PoolState = {
        network: swapEvent.network,
        address: swapEvent.poolAddress,
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        tick: slot0.tick,
        fee: fee,
        token0: token0,
        token1: token1,
        liquidity: slot0.liquidity,
        lastUpdated: Date.now(),
      };

      // Update pool state
      this.poolStates.set(poolKey, poolState);

      logger.info(`Updated pool state for ${poolKey}`);
      logger.info(
        `Current price: ${this.calculatePriceFromSqrtPrice(
          slot0.sqrtPriceX96.toString()
        ).toFixed(8)}`
      );
    } catch (error) {
      logger.error(`Failed to update pool state for ${poolKey}:`, error);
    }
  }


  async checkArbitrageOpportunity(): Promise<ArbitrageOpportunity | null> {
    const ethereumPool = this.poolStates.get(
      "ethereum-" + config.pools.ethereum[0].address
    );
    const arbitrumPool = this.poolStates.get(
      "arbitrum-" + config.pools.arbitrum[0].address
    );

    if (!ethereumPool || !arbitrumPool) {
      return null;
    }

    const ethPrice = this.calculatePriceFromSqrtPrice(
      ethereumPool.sqrtPriceX96
    );
    const arbPrice = this.calculatePriceFromSqrtPrice(
      arbitrumPool.sqrtPriceX96
    );

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

    const priceDifference = Math.abs(sellPrice - buyPrice);
    const profitPercentage = priceDifference / buyPrice;

    // Check if profit exceeds threshold
    const minProfitThreshold = parseFloat(config.trading.minProfitThreshold);

    if (profitPercentage < minProfitThreshold) {
      return null;
    }

    const tradeAmount = parseFloat(
      ethers.utils.formatEther(config.trading.defaultTradeAmount)
    );
    const profitEstimate = (priceDifference * tradeAmount).toString();

    return {
      buyNetwork,
      sellNetwork,
      buyPrice: buyPrice.toString(),
      sellPrice: sellPrice.toString(),
      priceDifference: priceDifference.toString(),
      profitEstimate,
      gasEstimate: this.estimateGasCosts(buyNetwork, sellNetwork),
      timestamp: Date.now(),
    };
  }

  private calculatePriceFromSqrtPrice(sqrtPriceX96: string): number {
    const sqrtPrice = parseFloat(sqrtPriceX96);
    const price = Math.pow(sqrtPrice / Math.pow(2, 96), 2);
    return price;
  }

  private estimateGasCosts(buyNetwork: string, sellNetwork: string): number {
    const buyGas = config.networks[buyNetwork]?.gasLimit || 150000;
    const sellGas = config.networks[sellNetwork]?.gasLimit || 150000;
    return buyGas + sellGas;
  }

  async handleArbitrageOpportunity(
    opportunity: ArbitrageOpportunity
  ): Promise<void> {
    if (this.isTrading) {
      logger.info("Trade already in progress, skipping opportunity");
      return;
    }

    try {
      this.isTrading = true;

      logger.info("🚨 ARBITRAGE OPPORTUNITY DETECTED!");
      logger.info(
        `💰 Buy on ${opportunity.buyNetwork} at ${parseFloat(
          opportunity.buyPrice
        ).toFixed(8)} WETH`
      );
      logger.info(
        `💰 Sell on ${opportunity.sellNetwork} at ${parseFloat(
          opportunity.sellPrice
        ).toFixed(8)} WETH`
      );
      logger.info(
        `📈 Estimated profit: ${parseFloat(opportunity.profitEstimate).toFixed(
          6
        )} WETH`
      );
      logger.info(
        `⛽ Gas estimate: ${opportunity.gasEstimate.toLocaleString()} units`
      );

      await this.discordNotifications.sendTradeNotification({
        type: "OPPORTUNITY",
        opportunity: opportunity,
      });

      if (config.trading.autoTradeEnabled) {
        try {
          logger.info("🤖 Auto-trading is enabled. Executing arbitrage trade...");
          const tradeAmount = ethers.utils.formatEther(config.trading.defaultTradeAmount);

          const txHash = await this.tradingService.executeArbitrage(
            opportunity.buyNetwork,
            opportunity.sellNetwork,
            "SEED",
            tradeAmount
          );

          logger.info(`✅ Arbitrage trade completed successfully! Tx: ${txHash}`);
          logger.info(`💰 Expected profit: ${opportunity.profitEstimate} WETH`);

          // Wait for transaction confirmation
          const network = this.networks.get(opportunity.buyNetwork);
          if (network) {
            await network.provider.waitForTransaction(txHash, 1);
            logger.info("Trade confirmed on blockchain");
          }
        } catch (error) {
          logger.error("❌ Failed to execute arbitrage trade:", error);
        }
      } else {
        logger.info("🛑 Auto-trading is disabled. Skipping trade execution.");
      }
    } finally {
      this.isTrading = false;

      // Process any pending opportunities if they're still profitable
      if (this.pendingOpportunities.length > 0) {
        logger.info("Processing next pending opportunity...");
        const nextOpportunity = this.pendingOpportunities.shift();
        if (nextOpportunity) {
          // Verify the opportunity is still valid before executing
          const isStillProfitable = await this.verifyOpportunity(nextOpportunity);
          if (isStillProfitable) {
            await this.handleArbitrageOpportunity(nextOpportunity);
          }
        }
      }
    }
  }

  // Add this helper method to verify if an opportunity is still profitable
  private async verifyOpportunity(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      const buyQuote = await this.getQuote(
        opportunity.buyNetwork,
        "SEED",
        "WETH",
        config.trading.defaultTradeAmount
      );

      const sellQuote = await this.getQuote(
        opportunity.sellNetwork,
        "SEED",
        "WETH",
        config.trading.defaultTradeAmount
      );

      const buyPrice = parseFloat(ethers.utils.formatEther(buyQuote));
      const sellPrice = parseFloat(ethers.utils.formatEther(sellQuote));
      const profitPercentage = (sellPrice - buyPrice) / buyPrice;
      const minProfitThreshold = parseFloat(config.trading.minProfitThreshold);

      return profitPercentage >= minProfitThreshold;
    } catch (error) {
      logger.error("Error verifying opportunity:", error);
      return false;
    }
  }

  async getQuote(
    network: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<string> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    try {
      const tokenInObj = networkRuntime.tokens[tokenIn];
      const tokenOutObj = networkRuntime.tokens[tokenOut];

      if (!tokenInObj || !tokenOutObj) {
        throw new Error(
          `Token ${tokenIn} or ${tokenOut} not found in network ${network}`
        );
      }

      const poolInfo: PoolInfo = await this.getPoolInfo(network);
      // https: docs.uniswap.org / sdk / v3 / guides / swaps / quoting;
      // Given the amount you want to swap, produces a quote for the amount out for a swap of a single pool - quoteExactInputSingle
      const quote: string =
        // see abi for this things params
        await networkRuntime.quoter.callStatic.quoteExactInputSingle(
          networkRuntime.tokens[tokenIn].address,
          networkRuntime.tokens[tokenOut].address,
          poolInfo.fee,
          amountIn,
          0 // sqrtPriceLimitX96: 0 to accept any price impact
        );
      logger.info(
        `Quote for ${amountIn} ${tokenIn} on ${network} pool: ${JSON.stringify(poolInfo)} is ${quote} `)
      return quote.toString();
    } catch (error) {
      logger.error(`❌ Quote failed for ${network}: `, error);
      throw error;
    }
  }

  async getPoolInfo(network: string): Promise<PoolInfo> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const poolConfig = config.pools[network][0];
    const poolContract = new ethers.Contract(
      poolConfig.address,
      SIMPLE_POOL_ABI,
      networkRuntime.provider
    );

    const [fee, token0, token1] = await Promise.all([
      poolContract.fee(),
      poolContract.token0(),
      poolContract.token1(),
    ]);

    const token0IsSeed =
      token0.toLowerCase() ===
      networkRuntime.tokens["SEED"].address.toLowerCase();

    return {
      fee: fee,
      token0IsSeed,
      token0,
      token1,
    };
  }
}
