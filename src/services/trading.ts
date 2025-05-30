import { ethers } from "ethers";
import { Token, CurrencyAmount, Percent, TradeType } from "@uniswap/sdk-core";
import {
  Pool,
  Route,
  SwapOptions,
  SwapRouter,
  Trade,
  encodeRouteToPath,
} from "@uniswap/v3-sdk";
import { NetworkRuntime } from "../types";
import { logger } from "../utils/logger";
import { config, discordConfig, env } from "../config";
import { ERC20_ABI, POOL_ABI } from "../contracts/abis";
import { DiscordNotificationService } from "./notification";

// Uniswap V3 SwapRouter address is the same on both Ethereum and Arbitrum
const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

// Fixed gas settings - these were way too high in your config
const MAX_FEE_PER_GAS = ethers.utils.parseUnits("50", "gwei");
const MAX_PRIORITY_FEE_PER_GAS = ethers.utils.parseUnits("2", "gwei");

export class TradingService {
  private networks: Map<string, NetworkRuntime>;
  public wallet: ethers.Wallet;
  private nonceManagers: Map<string, number> = new Map();
  private pendingTransactions: Set<string> = new Set();
  private discordNotifications: DiscordNotificationService;

  private previousBalances: { [key: string]: string } = {};

  constructor(networks: Map<string, NetworkRuntime>) {
    this.networks = networks;
    this.discordNotifications = new DiscordNotificationService(
      discordConfig.webhookUrl
    );

    if (!env.PRIVATE_KEY) {
      throw new Error("Private key not found in environment variables");
    }

    const ethereumRuntime = this.networks.get("ethereum");
    if (!ethereumRuntime) {
      throw new Error("Ethereum network not found");
    }

    this.wallet = new ethers.Wallet(env.PRIVATE_KEY, ethereumRuntime.provider);
    logger.info(`Trading wallet initialized: ${this.wallet.address}`);

    this.discordNotifications.sendStartupNotification(this.wallet.address);

    this.initializeNonceManagers();
  }

  private async initializeNonceManagers(): Promise<void> {
    for (const [networkName, runtime] of this.networks.entries()) {
      try {
        const networkWallet = this.wallet.connect(runtime.provider);
        const currentNonce = await networkWallet.getTransactionCount("pending");
        this.nonceManagers.set(networkName, currentNonce);
        logger.info(`Initialized nonce for ${networkName}: ${currentNonce}`);
      } catch (error) {
        logger.error(`Failed to initialize nonce for ${networkName}:`, error);
      }
    }
  }

  private getNextNonce(network: string): number {
    const currentNonce = this.nonceManagers.get(network) || 0;
    this.nonceManagers.set(network, currentNonce + 1);
    return currentNonce;
  }

  private resetNonce(network: string): void {
    const currentNonce = this.nonceManagers.get(network) || 0;
    if (currentNonce > 0) {
      this.nonceManagers.set(network, currentNonce - 1);
    }
  }

  async checkWalletBalances(network: string): Promise<void> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const networkWallet = this.wallet.connect(networkRuntime.provider);

    logger.info(`\n=== Checking balances on ${network.toUpperCase()} ===`);

    const ethBalance = await networkWallet.getBalance();
    logger.info(`ETH Balance: ${ethers.utils.formatEther(ethBalance)} ETH`);

    for (const [symbol, token] of Object.entries(networkRuntime.tokens)) {
      if (symbol === "ETH") continue;

      try {
        const tokenContract = new ethers.Contract(
          token.address,
          ERC20_ABI,
          networkWallet
        );

        const balance = await tokenContract.balanceOf(networkWallet.address);
        const formattedBalance = ethers.utils.formatUnits(
          balance,
          token.decimals
        );
        logger.info(`${symbol} Balance: ${formattedBalance} ${symbol}`);

        const allowance = await tokenContract.allowance(
          networkWallet.address,
          SWAP_ROUTER_ADDRESS
        );
        const formattedAllowance = ethers.utils.formatUnits(
          allowance,
          token.decimals
        );
        logger.info(
          `${symbol} Allowance for SwapRouter: ${formattedAllowance} ${symbol}`
        );
      } catch (error) {
        logger.error(`Error checking ${symbol} balance:`, error);
      }
    }
    logger.info(`=== End of ${network.toUpperCase()} balances ===\n`);
  }

  private async checkTradeRequirements(
    network: string,
    tokenIn: Token,
    amountIn: string
  ): Promise<{ hasBalance: boolean; hasAllowance: boolean }> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const networkWallet = this.wallet.connect(networkRuntime.provider);
    const rawAmountIn = ethers.utils.parseUnits(amountIn, tokenIn.decimals);

    let hasBalance = false;
    let hasAllowance = false;

    if (tokenIn.symbol === "WETH" || tokenIn.symbol === "ETH") {
      const ethBalance = await networkWallet.getBalance();
      hasBalance = ethBalance.gte(rawAmountIn);
      logger.info(
        `ETH Balance: ${ethers.utils.formatEther(
          ethBalance
        )} ETH, Required: ${amountIn} ETH`
      );

      if (tokenIn.symbol === "WETH") {
        const tokenContract = new ethers.Contract(
          tokenIn.address,
          ERC20_ABI,
          networkWallet
        );
        const allowance = await tokenContract.allowance(
          networkWallet.address,
          SWAP_ROUTER_ADDRESS
        );
        hasAllowance = allowance.gte(rawAmountIn);
        logger.info(
          `WETH Allowance: ${ethers.utils.formatUnits(
            allowance,
            tokenIn.decimals
          )} WETH, Required: ${amountIn} WETH`
        );
      } else {
        hasAllowance = true;
      }
    } else {
      const tokenContract = new ethers.Contract(
        tokenIn.address,
        ERC20_ABI,
        networkWallet
      );

      const balance = await tokenContract.balanceOf(networkWallet.address);
      hasBalance = balance.gte(rawAmountIn);
      logger.info(
        `${tokenIn.symbol} Balance: ${ethers.utils.formatUnits(
          balance,
          tokenIn.decimals
        )} ${tokenIn.symbol}, Required: ${amountIn} ${tokenIn.symbol}`
      );

      const allowance = await tokenContract.allowance(
        networkWallet.address,
        SWAP_ROUTER_ADDRESS
      );
      hasAllowance = allowance.gte(rawAmountIn);
      logger.info(
        `${tokenIn.symbol} Allowance: ${ethers.utils.formatUnits(
          allowance,
          tokenIn.decimals
        )} ${tokenIn.symbol}, Required: ${amountIn} ${tokenIn.symbol}`
      );
    }

    return { hasBalance, hasAllowance };
  }

  async executeArbitrage(
    buyNetwork: string,
    sellNetwork: string,
    tokenSymbol: string,
    amount: string
  ): Promise<string> {
    const tradeKey = `${buyNetwork}-${sellNetwork}-${tokenSymbol}-${amount}`;

    if (this.pendingTransactions.has(tradeKey)) {
      logger.warn(`Arbitrage trade already in progress: ${tradeKey}`);
      throw new Error("Trade already in progress");
    }

    this.pendingTransactions.add(tradeKey);

    try {
      logger.info(
        `Executing arbitrage: Buy ${tokenSymbol} on ${buyNetwork}, Sell on ${sellNetwork}, Amount: ${amount}`
      );

      await this.checkWalletBalances(buyNetwork);
      await this.checkWalletBalances(sellNetwork);

      // Send trade start notification
      await this.discordNotifications.sendTradeNotification({
        type: "TRADE_START",
        network: buyNetwork,
        tokenIn: "WETH",
        tokenOut: tokenSymbol,
        amount: amount,
      });

      const buyTxHash = await this.executeTrade(
        buyNetwork,
        "WETH",
        tokenSymbol,
        amount
      );
      logger.info(`Buy transaction successful: ${buyTxHash}`);

      await this.discordNotifications.sendTradeNotification({
        type: "TRADE_SUCCESS",
        network: buyNetwork,
        tokenIn: "WETH",
        tokenOut: tokenSymbol,
        amount: amount,
        txHash: buyTxHash,
      });

      const buyNetworkRuntime = this.networks.get(buyNetwork);
      if (!buyNetworkRuntime) {
        throw new Error(`Network ${buyNetwork} not found`);
      }

      const buyReceipt = await buyNetworkRuntime.provider.waitForTransaction(
        buyTxHash,
        1,
        300000
      );
      logger.info(`Buy transaction mined in block ${buyReceipt.blockNumber}`);

      await this.discordNotifications.sendTradeNotification({
        type: "TRADE_START",
        network: sellNetwork,
        tokenIn: tokenSymbol,
        tokenOut: "WETH",
        amount: amount,
      });

      const sellTxHash = await this.executeTrade(
        sellNetwork,
        tokenSymbol,
        "WETH",
        amount
      );
      logger.info(`Sell transaction successful: ${sellTxHash}`);
      await this.discordNotifications.sendTradeNotification({
        type: "TRADE_SUCCESS",
        network: sellNetwork,
        tokenIn: tokenSymbol,
        tokenOut: "WETH",
        amount: amount,
        txHash: sellTxHash,
      });

      await this.sendBalanceUpdate();

      return sellTxHash;
    } catch (error) {
      logger.error("Error executing arbitrage:", error);
      await this.discordNotifications.sendTradeNotification({
        type: "TRADE_FAILED",
        network: buyNetwork,
        tokenIn: "WETH",
        tokenOut: tokenSymbol,
        amount: amount,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      this.pendingTransactions.delete(tradeKey);
    }
  }

  async sendBalanceUpdate(): Promise<void> {
    try {
      const balances: {
        [key: string]: {
          amount: string;
          previousAmount?: string;
          usdValue?: string;
          change?: string;
        };
      } = {};

      for (const [networkName, networkRuntime] of this.networks.entries()) {
        const networkWallet = this.wallet.connect(networkRuntime.provider);

        // Get ETH balance
        const ethBalance = await networkWallet.getBalance();
        const ethAmount = ethers.utils.formatEther(ethBalance);
        const key = `${networkName.toUpperCase()} ETH`;

        balances[key] = {
          amount: `${ethAmount} ETH`,
          previousAmount: this.previousBalances[key],
          // You can add price feed here to get USD value
          usdValue: await this.getUSDValue(ethAmount, "ETH"),
        };
        this.previousBalances[key] = balances[key].amount;

        // Get token balances
        for (const [symbol, token] of Object.entries(networkRuntime.tokens)) {
          if (symbol === "ETH") continue;

          try {
            const tokenContract = new ethers.Contract(
              token.address,
              ERC20_ABI,
              networkWallet
            );

            const balance = await tokenContract.balanceOf(
              networkWallet.address
            );
            const formattedBalance = ethers.utils.formatUnits(
              balance,
              token.decimals
            );
            const key = `${networkName.toUpperCase()} ${symbol}`;

            balances[key] = {
              amount: `${formattedBalance} ${symbol}`,
              previousAmount: this.previousBalances[key],
              usdValue: await this.getUSDValue(formattedBalance, symbol),
            };
            this.previousBalances[key] = balances[key].amount;
          } catch (error) {
            logger.error(
              `Error getting ${symbol} balance on ${networkName}:`,
              error
            );
          }
        }
      }

      await this.discordNotifications.sendTradeNotification({
        type: "BALANCE_UPDATE",
        balances: balances,
      });
    } catch (error) {
      logger.error("Error sending balance update:", error);
    }
  }
  // TradingService.ts - Updated getUSDValue method and related functions

  private async getUSDValue(amount: string, symbol: string): Promise<string> {
    try {
      // Skip if amount is 0 or very small
      if (parseFloat(amount) < 0.000001) {
        return "0.00";
      }

      // Use ethereum network for USD price quotes (most liquid)
      const networkRuntime = this.networks.get("ethereum");
      if (!networkRuntime) {
        logger.warn("Ethereum network not found for USD price lookup");
        return "0.00";
      }

      const token = networkRuntime.tokens[symbol];
      const seedToken = networkRuntime.tokens["SEED"]; // Assuming you have SEED configured

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

        // Get the pool fee dynamically
        const poolFee = await this.getPoolFee("ethereum", wethToken, seedToken);

        const quote =
          await networkRuntime.quoter.callStatic.quoteExactInputSingle(
            wethToken.address,
            seedToken.address,
            poolFee, // Use dynamic fee instead of hardcoded 3000
            rawAmount.toString(),
            0 // sqrtPriceLimitX96: 0 to accept any price impact
          );

        // Format the quote (SEED has 6 decimals)
        const usdValue = ethers.utils.formatUnits(quote, seedToken.decimals);
        return parseFloat(usdValue).toFixed(2);
      }

      // For other tokens, try to get a quote against SEED or WETH
      if (seedToken) {
        try {
          // Try direct token -> SEED quote first
          const rawAmount = ethers.utils.parseUnits(amount, token.decimals);

          // Get the pool fee dynamically
          const poolFee = await this.getPoolFee("ethereum", token, seedToken);

          const quote =
            await networkRuntime.quoter.callStatic.quoteExactInputSingle(
              token.address,
              seedToken.address,
              poolFee, // Use dynamic fee
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
              tokenWethFee, // Dynamic fee for token/WETH pair
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
              wethSeedFee, // Dynamic fee for WETH/SEED pair
              wethQuote.toString(),
              0
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

  // Add this new method to get pool fee dynamically
  private async getPoolFee(
    network: string,
    tokenA: Token,
    tokenB: Token
  ): Promise<number> {
    const poolInfo = await this.getPoolInfo(network, tokenA, tokenB);
    return poolInfo.fee;
  }

  // Update the existing getPoolInfo method to be more reusable
  private async getPoolInfo(
    network: string,
    tokenA: Token,
    tokenB: Token
  ): Promise<{
    fee: number;
    liquidity: ethers.BigNumber;
    sqrtPriceX96: ethers.BigNumber;
    tick: number;
  }> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const pools = config.pools[network];
    let poolAddress: string | undefined;

    for (const pool of pools) {
      const token0Symbol = pool.token0;
      const token1Symbol = pool.token1;

      if (
        (tokenA.symbol === token0Symbol && tokenB.symbol === token1Symbol) ||
        (tokenA.symbol === token1Symbol && tokenB.symbol === token0Symbol)
      ) {
        poolAddress = pool.address;
        break;
      }
    }

    if (!poolAddress) {
      throw new Error(
        `Pool not found for ${tokenA.symbol}/${tokenB.symbol} on ${network}`
      );
    }

    const poolContract = new ethers.Contract(
      poolAddress,
      POOL_ABI,
      networkRuntime.provider
    );

    const [fee, liquidity, slot0] = await Promise.all([
      poolContract.fee(),
      poolContract.liquidity(),
      poolContract.slot0(),
    ]);

    return {
      fee,
      liquidity,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
    };
  }

  async executeTrade(
    network: string,
    tokenInSymbol: string,
    tokenOutSymbol: string,
    amountIn: string
  ): Promise<string> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const tokenIn = networkRuntime.tokens[tokenInSymbol];
    const tokenOut = networkRuntime.tokens[tokenOutSymbol];

    if (!tokenIn || !tokenOut) {
      throw new Error(
        `Tokens not found: ${tokenInSymbol} or ${tokenOutSymbol}`
      );
    }

    const networkWallet = this.wallet.connect(networkRuntime.provider);

    logger.info(`\n=== Pre-trade checks for ${network.toUpperCase()} ===`);

    const { hasBalance, hasAllowance } = await this.checkTradeRequirements(
      network,
      tokenIn,
      amountIn
    );

    if (!hasBalance) {
      throw new Error(`Insufficient ${tokenInSymbol} balance for trade`);
    }

    if (!hasAllowance) {
      logger.info(`Insufficient allowance, approving token spending...`);
      await this.approveTokenSpending(
        network,
        tokenIn.address,
        SWAP_ROUTER_ADDRESS,
        ethers.utils.parseUnits(amountIn, tokenIn.decimals).toString()
      );
    }

    logger.info(`=== Starting trade execution ===`);

    // 1. Get pool information
    const poolInfo = await this.getPoolInfo(network, tokenIn, tokenOut);

    // 2. Create a pool instance
    const pool = new Pool(
      tokenIn,
      tokenOut,
      poolInfo.fee,
      poolInfo.sqrtPriceX96.toString(),
      poolInfo.liquidity.toString(),
      poolInfo.tick
    );

    // 3. Create a route
    const route = new Route([pool], tokenIn, tokenOut);

    // 4. Convert amount to raw amount
    const rawAmountIn = ethers.utils
      .parseUnits(amountIn, tokenIn.decimals)
      .toString();

    // 5. Get fresh quote right before trade execution
    const quoteAmountOut = await this.getOutputQuote(
      network,
      route,
      tokenIn,
      rawAmountIn
    );

    logger.info(
      `Quote output: ${ethers.utils.formatUnits(
        quoteAmountOut,
        tokenOut.decimals
      )} ${tokenOutSymbol}`
    );

    // 6. Apply slippage tolerance to get minimum amount out
    const slippageTolerance = parseFloat(config.trading.maxSlippage) || 0.005; // 0.5% default
    const minAmountOut = quoteAmountOut
      .mul(ethers.BigNumber.from(Math.floor((1 - slippageTolerance) * 10000)))
      .div(10000);

    logger.info(
      `Minimum amount out (with ${(slippageTolerance * 100).toFixed(
        2
      )}% slippage): ${ethers.utils.formatUnits(
        minAmountOut,
        tokenOut.decimals
      )} ${tokenOutSymbol}`
    );

    // 7. Create trade with realistic output amount
    const uncheckedTrade = Trade.createUncheckedTrade({
      route,
      inputAmount: CurrencyAmount.fromRawAmount(tokenIn, rawAmountIn),
      outputAmount: CurrencyAmount.fromRawAmount(
        tokenOut,
        minAmountOut.toString()
      ),
      tradeType: TradeType.EXACT_INPUT,
    });

    // 8. Set swap options with reasonable slippage
    const options: SwapOptions = {
      slippageTolerance: new Percent(
        Math.floor(slippageTolerance * 10000),
        10000
      ), // Convert to basis points
      deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes
      recipient: networkWallet.address,
    };

    const methodParameters = SwapRouter.swapCallParameters(
      [uncheckedTrade],
      options
    );

    // 9. Get the next nonce for this network
    const nonce = this.getNextNonce(network);

    try {
      // 10. Execute the transaction
      const tx = await networkWallet.sendTransaction({
        data: methodParameters.calldata,
        to: SWAP_ROUTER_ADDRESS,
        value: methodParameters.value,
        gasLimit: 500000,
        maxFeePerGas: MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
        nonce: nonce,
        type: 2,
      });

      logger.info(
        `Trade executed on ${network}: ${tokenInSymbol} -> ${tokenOutSymbol}, Amount: ${amountIn}, Nonce: ${nonce}, Tx: ${tx.hash}`
      );

      return tx.hash;
    } catch (error) {
      this.resetNonce(network);
      logger.error(`Trade failed on ${network}, nonce reset:`, error);

      await this.discordNotifications.sendTradeNotification({
        type: "TRADE_FAILED",
        network: network,
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        amount: amountIn,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw error;
    }
  }

  private async getOutputQuote(
    network: string,
    route: Route<Token, Token>,
    tokenIn: Token,
    amountIn: string
  ): Promise<ethers.BigNumber> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const path = encodeRouteToPath(route, false);

    try {
      const quoteAmount =
        await networkRuntime.quoter.callStatic.quoteExactInput(path, amountIn);

      return quoteAmount;
    } catch (error) {
      logger.error(`Failed to get quote: ${error}`);
      throw new Error(`Failed to get quote: ${error}`);
    }
  }

  private async approveTokenSpending(
    network: string,
    tokenAddress: string,
    spenderAddress: string,
    amount: string
  ): Promise<void> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    const networkWallet = this.wallet.connect(networkRuntime.provider);
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      networkWallet
    );

    const tokenSymbol = await tokenContract.symbol();
    const tokenDecimals = await tokenContract.decimals();

    logger.info(`\n=== Token Approval Process ===`);
    logger.info(`Token: ${tokenSymbol} (${tokenAddress})`);
    logger.info(`Spender: ${spenderAddress}`);
    logger.info(
      `Amount: ${ethers.utils.formatUnits(
        amount,
        tokenDecimals
      )} ${tokenSymbol}`
    );

    const currentAllowance = await tokenContract.allowance(
      networkWallet.address,
      spenderAddress
    );

    logger.info(
      `Current Allowance: ${ethers.utils.formatUnits(
        currentAllowance,
        tokenDecimals
      )} ${tokenSymbol}`
    );

    logger.info(
      `Approving exact amount: ${ethers.utils.formatUnits(
        amount,
        tokenDecimals
      )} ${tokenSymbol}`
    );

    const nonce = this.getNextNonce(network);

    try {
      const tx = await tokenContract.approve(spenderAddress, amount, {
        gasLimit: 100000,
        maxFeePerGas: MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
        nonce: nonce,
        type: 2,
      });

      logger.info(`Approval transaction sent: ${tx.hash}, nonce: ${nonce}`);
      await tx.wait();

      const newAllowance = await tokenContract.allowance(
        networkWallet.address,
        spenderAddress
      );

      logger.info(
        `New Allowance: ${ethers.utils.formatUnits(
          newAllowance,
          tokenDecimals
        )} ${tokenSymbol}`
      );
      logger.info(`Approval successful!`);
      logger.info(`=== End of Approval Process ===\n`);
    } catch (error) {
      this.resetNonce(network);
      logger.error(`Approval failed, nonce reset:`, error);
      throw error;
    }
  }

  async refreshNonce(network: string): Promise<void> {
    const networkRuntime = this.networks.get(network);
    if (!networkRuntime) {
      throw new Error(`Network ${network} not found`);
    }

    try {
      const networkWallet = this.wallet.connect(networkRuntime.provider);
      const currentNonce = await networkWallet.getTransactionCount("pending");
      this.nonceManagers.set(network, currentNonce);
      logger.info(`Refreshed nonce for ${network}: ${currentNonce}`);
    } catch (error) {
      logger.error(`Failed to refresh nonce for ${network}:`, error);
    }
  }
}
