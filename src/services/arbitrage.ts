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
import { Token } from "@uniswap/sdk-core";

// ArbitrageService handles the core logic for detecting and executing arbitrage opportunities
export class ArbitrageService {
  private networks: Map<string, NetworkRuntime> = new Map();
  private poolStates: Map<string, PoolState> = new Map();
  public tradingService: TradingService;
  public discordNotifications: DiscordNotificationService;
  private isTrading: boolean = false;
  private lastTradeTimestamp: number = 0;
  private readonly COOLDOWN_PERIOD = 0;

  // Cache quotes to reduce RPC calls
  private priceCache: Map<string, { price: number; timestamp: number }> =
    new Map();
  private readonly CACHE_DURATION = 3 * 1000;

  // Add these properties to the ArbitrageService class
  private readonly EVENT_QUEUE: SwapEvent[] = [];
  private isProcessingQueue: boolean = false;

  constructor(networks: Map<string, NetworkRuntime>) {
    this.networks = networks;
    this.tradingService = new TradingService(networks);
    this.discordNotifications = new DiscordNotificationService(
      discordConfig.webhookUrl
    );
  }

  async initializePoolStates(): Promise<void> {
    logger.info("🔄 Initializing pool states for all networks...");

    for (const [networkName, networkRuntime] of this.networks.entries()) {
      const pools = config.pools[networkName];

      if (!pools || pools.length === 0) {
        logger.warn(`No pools configured for network: ${networkName}`);
        continue;
      }

      for (const poolConfig of pools) {
        try {
          await this.initializePoolState(networkName, poolConfig.address);
          logger.info(
            `✅ Initialized pool state for ${networkName}: ${poolConfig.address}`
          );
        } catch (error) {
          logger.error(
            `❌ Failed to initialize pool state for ${networkName} ${poolConfig.address}:`,
            error
          );
        }
      }
    }

    logger.info("✅ Pool state initialization completed");
  }

  private async initializePoolState(
    network: string,
    poolAddress: string
  ): Promise<void> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network runtime not found for ${network}`);
    }

    const poolContract = new ethers.Contract(
      poolAddress,
      POOL_ABI,
      networkRuntime.provider
    );

    try {
      // Get current pool state from blockchain
      const [fee, token0, token1, liquidity, slot0] = await Promise.all([
        poolContract.fee(),
        poolContract.token0(),
        poolContract.token1(),
        poolContract.liquidity(),
        poolContract.slot0(),
      ]);

      const sqrtPriceX96 = slot0[0];
      const tick = slot0[1];

      const poolKey = `${network}-${poolAddress}`;
      const poolState: PoolState = {
        network: network,
        address: poolAddress,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick: tick,
        fee: fee,
        token0: token0,
        token1: token1,
        liquidity: liquidity.toString(),
        lastUpdated: Date.now(),
      };

      // Store the pool state, just a hashmap bro
      this.poolStates.set(poolKey, poolState);

      const price = this.calculatePriceFromSqrtPrice(sqrtPriceX96.toString());
      logger.info(
        `📊 Pool ${poolKey} initialized - Price: ${price.toFixed(
          8
        )}, Liquidity: ${ethers.utils.formatEther(liquidity)}`
      );
    } catch (error: any) {
      const poolKey = `${network}-${poolAddress}`;
      logger.error(`Failed to initialize pool state for ${poolKey}:`, error);
      throw error;
    }
  }

  async handleSwapEvent(swapEvent: SwapEvent): Promise<void> {
    // Add the event to the queue
    this.EVENT_QUEUE.push(swapEvent);

    // If we're not already processing events, start processing
    if (!this.isProcessingQueue) {
      await this.processEventQueue();
    }
  }

  private async processEventQueue(): Promise<void> {
    if (this.isProcessingQueue) return;

    try {
      this.isProcessingQueue = true;

      while (this.EVENT_QUEUE.length > 0) {
        const event = this.EVENT_QUEUE.shift()!;

        try {
          // Update pool state
          await this.updatePoolState(event);

          // Check for arbitrage opportunity
          logger.info(
            "🔍 Checking for arbitrage opportunity after pool state update..."
          );
          const opportunity = await this.checkArbitrageOpportunity();

          if (opportunity) {
            logger.info("🎯 New arbitrage opportunity found after swap event!");
            await this.handleArbitrageOpportunity(opportunity);
          }
        } catch (error) {
          logger.error(`Error processing swap event: ${error}`);
          // Continue processing other events even if one fails
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async updatePoolState(swapEvent: SwapEvent): Promise<void> {
    const poolKey = `${swapEvent.network}-${swapEvent.poolAddress}`;
    const existingState = this.poolStates.get(poolKey);

    if (!existingState) {
      logger.warn(
        `Pool state not initialized for ${poolKey}, initializing now...`
      );
      await this.initializePoolState(swapEvent.network, swapEvent.poolAddress);
      return;
    }

    try {
      const updatedPoolState: PoolState = {
        ...existingState,
        sqrtPriceX96: swapEvent.sqrtPriceX96,
        tick: swapEvent.tick,
        liquidity: swapEvent.liquidity,
        lastUpdated: Date.now(),
      };

      this.poolStates.set(poolKey, updatedPoolState);

      const price = this.calculatePriceFromSqrtPrice(swapEvent.sqrtPriceX96);
      logger.info(
        `📊 Updated pool state for ${poolKey} - Price: ${price.toFixed(8)}`
      );
    } catch (error) {
      logger.error(`Failed to update pool state for ${poolKey}:`, error);
    }
  }

  async checkArbitrageOpportunity(): Promise<ArbitrageOpportunity | null> {
    const ethereumPools = config.pools.ethereum || [];
    const arbitrumPools = config.pools.arbitrum || [];

    if (ethereumPools.length === 0 || arbitrumPools.length === 0) {
      logger.warn("❌ No pools configured for ethereum or arbitrum");
      return null;
    }

    const ethereumPoolKey = `ethereum-${ethereumPools[0].address}`;
    const arbitrumPoolKey = `arbitrum-${arbitrumPools[0].address}`;

    const ethereumPool = this.poolStates.get(ethereumPoolKey);
    const arbitrumPool = this.poolStates.get(arbitrumPoolKey);

    logger.info(`📊 Pool State Check:`);
    logger.info(
      `  - Ethereum pool (${ethereumPoolKey}): ${
        ethereumPool ? "✅ Available" : "❌ Missing"
      }`
    );
    logger.info(
      `  - Arbitrum pool (${arbitrumPoolKey}): ${
        arbitrumPool ? "✅ Available" : "❌ Missing"
      }`
    );

    if (ethereumPool) {
      const ethPrice = this.calculatePriceFromSqrtPrice(
        ethereumPool.sqrtPriceX96
      );
      logger.info(`  - Ethereum price: ${ethPrice.toFixed(8)}`);
      logger.info(
        `  - Ethereum liquidity: ${ethers.utils.formatEther(
          ethereumPool.liquidity
        )}`
      );
    }

    if (arbitrumPool) {
      const arbPrice = this.calculatePriceFromSqrtPrice(
        arbitrumPool.sqrtPriceX96
      );
      logger.info(`  - Arbitrum price: ${arbPrice.toFixed(8)}`);
      logger.info(
        `  - Arbitrum liquidity: ${ethers.utils.formatEther(
          arbitrumPool.liquidity
        )}`
      );
    }

    if (!ethereumPool || !arbitrumPool) {
      logger.warn("❌ Cannot check arbitrage - missing pool state(s)");
      logger.info(
        "💡 Hint: Pool states are initialized on startup and updated via swap events"
      );
      return null;
    }

    const ethPrice = this.calculatePriceFromSqrtPrice(
      ethereumPool.sqrtPriceX96
    );
    const arbPrice = this.calculatePriceFromSqrtPrice(
      arbitrumPool.sqrtPriceX96
    );

    logger.info(
      `💰 Current prices - ETH: ${ethPrice.toFixed(8)}, ARB: ${arbPrice.toFixed(
        8
      )}`
    );

    // Calculate profits for both directions
    const ethToArbProfit = arbPrice - ethPrice; // Buy on ETH, sell on ARB
    const arbToEthProfit = ethPrice - arbPrice; // Buy on ARB, sell on ETH

    logger.info(`📈 Profit calculations:`);
    logger.info(`  - ETH -> ARB profit: ${ethToArbProfit.toFixed(8)}`);
    logger.info(`  - ARB -> ETH profit: ${arbToEthProfit.toFixed(8)}`);

    let buyNetwork, sellNetwork, buyPrice, sellPrice, profitAmount;

    // Only choose direction if profit meets minimum threshold
    const minProfitThreshold = parseFloat(config.trading.minProfitThreshold);
    logger.info(`🎯 Minimum profit threshold: ${minProfitThreshold}`);

    if (
      ethToArbProfit > arbToEthProfit &&
      ethToArbProfit > minProfitThreshold
    ) {
      buyNetwork = "ethereum";
      sellNetwork = "arbitrum";
      buyPrice = ethPrice;
      sellPrice = arbPrice;
      profitAmount = ethToArbProfit;
      logger.info(`✅ Profitable opportunity: Buy ETH, Sell ARB`);
    } else if (arbToEthProfit > minProfitThreshold) {
      buyNetwork = "arbitrum";
      sellNetwork = "ethereum";
      buyPrice = arbPrice;
      sellPrice = ethPrice;
      profitAmount = arbToEthProfit;
      logger.info(`✅ Profitable opportunity: Buy ARB, Sell ETH`);
    } else {
      logger.info("❌ No profitable arbitrage opportunity found");
      return null;
    }

    const profitPercentage = profitAmount / buyPrice;
    const tradeAmount = parseFloat(
      ethers.utils.formatEther(config.trading.defaultTradeAmount)
    );
    const profitEstimate = (profitAmount * tradeAmount).toString();

    logger.info(
      `💯 Profit percentage: ${(profitPercentage * 100).toFixed(2)}%`
    );
    logger.info(`💰 Estimated profit: ${profitEstimate}`);

    return {
      buyNetwork,
      sellNetwork,
      buyPrice: buyPrice.toString(),
      sellPrice: sellPrice.toString(),
      priceDifference: profitAmount.toString(),
      profitEstimate,
      gasEstimate: this.estimateGasCosts(buyNetwork, sellNetwork),
      timestamp: Date.now(),
    };
  }

  // This is not a scam, this is is the actual price calculation
  // This is the correct formula to calculate price from sqrtPriceX96
  // Price = (sqrtPriceX96 / 2^96) ^ 2
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
          logger.info(
            "🤖 Auto-trading is enabled. Executing arbitrage trade..."
          );

          const tradeAmount = ethers.utils.formatEther(
            config.trading.defaultTradeAmount
          );

          const txHash = await this.tradingService.executeArbitrage(
            opportunity.buyNetwork,
            opportunity.sellNetwork,
            "SEED",
            tradeAmount
          );

          logger.info(
            `✅ Arbitrage trade completed successfully! Tx: ${txHash}`
          );
          logger.info(`💰 Expected profit: ${opportunity.profitEstimate} WETH`);

          this.lastTradeTimestamp = Date.now();
        } catch (error) {
          logger.error("❌ Failed to execute arbitrage trade:", error);
        }
      } else {
        logger.info("🛑 Auto-trading is disabled. Skipping trade execution.");
      }
    } finally {
      this.isTrading = false;
      this.lastTradeTimestamp = Date.now(); // Update timestamp after trade
    }
  }

  // USD price from quoter
  private async getUSDValue(amount: string, symbol: string): Promise<string> {
    try {
      // Skip if amount is 0 or very small
      if (parseFloat(amount) < 0.000001) {
        return "0.00";
      }

      const networkRuntime = this.networks.get("ethereum");
      if (!networkRuntime) {
        logger.warn("Ethereum network not found for USD price lookup");
        return "0.00";
      }

      const token = networkRuntime.tokens[symbol];
      const seedToken = networkRuntime.tokens["SEED"];

      if (!token) {
        logger.warn(`Token ${symbol} not found for USD price`);
        return "0.00";
      }

      // For ETH/WETH, we can use a direct SEED quote
      if (symbol === "ETH" || symbol === "WETH") {
        if (!seedToken) {
          logger.warn("SEED token not found for ETH price");
          return "0.00";
        }

        // Convert ETH amount to wei
        const rawAmount = ethers.utils.parseEther(amount);

        // Get WETH/SEED quote with dynamic fee
        const wethToken = networkRuntime.tokens["WETH"];
        if (!wethToken) {
          logger.warn("WETH token not found for price lookup");
          return "0.00";
        }

        const poolFee = await this.getPoolFee("ethereum", wethToken, seedToken);

        const quote =
          await networkRuntime.quoter.callStatic.quoteExactInputSingle(
            wethToken.address,
            seedToken.address,
            poolFee,
            rawAmount.toString(),
            0 // sqrtPriceLimitX96: 0 to accept any price impact
          );

        const usdValue = ethers.utils.formatUnits(quote, seedToken.decimals);
        return parseFloat(usdValue).toFixed(2);
      }

      // For other tokens, try to get a quote against SEED or WETH
      if (seedToken) {
        try {
          // Try direct token -> SEED quote first
          const rawAmount = ethers.utils.parseUnits(amount, token.decimals);
          const poolFee = await this.getPoolFee("ethereum", token, seedToken);

          const quote =
            await networkRuntime.quoter.callStatic.quoteExactInputSingle(
              token.address,
              seedToken.address,
              poolFee,
              rawAmount.toString(),
              0
            );

          const usdValue = ethers.utils.formatUnits(quote, seedToken.decimals);
          return parseFloat(usdValue).toFixed(2);
        } catch (directError) {
          logger.debug(`Direct ${symbol}/SEED quote failed, trying via WETH`);

          // If direct quote fails, try token -> WETH -> SEED
          const wethToken = networkRuntime.tokens["WETH"];
          if (!wethToken || !seedToken) {
            throw new Error(
              "WETH or SEED token not found for indirect pricing"
            );
          }

          // First get token -> WETH quote
          const rawAmount = ethers.utils.parseUnits(amount, token.decimals);
          const tokenWethFee = await this.getPoolFee(
            "ethereum",
            token,
            wethToken
          );

          const wethQuote =
            await networkRuntime.quoter.callStatic.quoteExactInputSingle(
              token.address,
              wethToken.address,
              tokenWethFee,
              rawAmount.toString(),
              0
            );

          // Then get WETH -> SEED quote
          const wethSeedFee = await this.getPoolFee(
            "ethereum",
            wethToken,
            seedToken
          );

          const seedQuote =
            await networkRuntime.quoter.callStatic.quoteExactInputSingle(
              wethToken.address,
              seedToken.address,
              wethSeedFee,
              wethQuote.toString(),
              0 // sqrtPriceLimitX96: 0 to accept any price impact
            );

          const usdValue = ethers.utils.formatUnits(
            seedQuote,
            seedToken.decimals
          );
          return parseFloat(usdValue).toFixed(2);
        }
      }

      logger.warn(`Could not get USD price for ${symbol}, no SEED token found`);
      return "0.00";
    } catch (error) {
      logger.error(`Failed to get USD price for ${symbol}:`, error);
      return "0.00";
    }
  }

  private async getPoolFee(
    network: string,
    tokenA: Token,
    tokenB: Token
  ): Promise<number> {
    const poolInfo = await this.getPoolInfo(network);
    return poolInfo.fee;
  }

  async getQuote(
    network: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<string> {
    const cacheKey = `${network}-${tokenIn}-${tokenOut}-${amountIn}`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      logger.debug(`Using cached quote for ${cacheKey}`);
      return cached.price.toString();
    }

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

      const quote: string =
        await networkRuntime.quoter.callStatic.quoteExactInputSingle(
          networkRuntime.tokens[tokenIn].address,
          networkRuntime.tokens[tokenOut].address,
          poolInfo.fee,
          amountIn,
          0 // sqrtPriceLimitX96: 0 to accept any price impact
        );

      this.priceCache.set(cacheKey, {
        price: parseFloat(quote),
        timestamp: Date.now(),
      });

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
