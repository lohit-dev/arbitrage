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
import { config, env } from "../config";
import { ERC20_ABI, POOL_ABI } from "../contracts/abis";
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";

// Uniswap V3 SwapRouter address is the same on both Ethereum and Arbitrum
const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

// Maximum gas settings
const MAX_FEE_PER_GAS = ethers.utils.parseUnits("100", "gwei");
const MAX_PRIORITY_FEE_PER_GAS = ethers.utils.parseUnits("5", "gwei");

export class TradingService {
  private networks: Map<string, NetworkRuntime>;
  private wallet: ethers.Wallet;

  constructor(networks: Map<string, NetworkRuntime>) {
    this.networks = networks;

    // Initialize wallet with private key
    if (!env.PRIVATE_KEY) {
      throw new Error("Private key not found in environment variables");
    }

    // Use the Ethereum provider for the wallet (could be either network)
    const ethereumRuntime = this.networks.get("ethereum");
    if (!ethereumRuntime) {
      throw new Error("Ethereum network not found");
    }

    this.wallet = new ethers.Wallet(env.PRIVATE_KEY, ethereumRuntime.provider);
    logger.info(`Trading wallet initialized: ${this.wallet.address}`);
  }

  /**
   * Execute an arbitrage trade between networks
   * @param buyNetwork Network to buy on
   * @param sellNetwork Network to sell on
   * @param tokenSymbol Token to trade
   * @param amount Amount to trade
   * @returns Transaction hash of the sell transaction
   */
  async executeArbitrage(
    buyNetwork: string,
    sellNetwork: string,
    tokenSymbol: string,
    amount: string
  ): Promise<string> {
    logger.info(
      `Executing arbitrage: Buy ${tokenSymbol} on ${buyNetwork}, Sell on ${sellNetwork}, Amount: ${amount}`
    );

    try {
      // 1. Buy tokens on the first network
      const buyTxHash = await this.executeTrade(
        buyNetwork,
        "WETH",
        tokenSymbol,
        amount
      );
      logger.info(`Buy transaction successful: ${buyTxHash}`);

      // 2. Wait for the transaction to be mined
      const buyNetworkRuntime = this.networks.get(buyNetwork);
      if (!buyNetworkRuntime) {
        throw new Error(`Network ${buyNetwork} not found`);
      }

      const buyReceipt = await buyNetworkRuntime.provider.waitForTransaction(
        buyTxHash
      );
      logger.info(`Buy transaction mined in block ${buyReceipt.blockNumber}`);

      // 3. Sell tokens on the second network
      // In a real cross-chain scenario, you would need to bridge the tokens first
      // For testing purposes, we'll simulate this by just executing another trade
      const sellTxHash = await this.executeTrade(
        sellNetwork,
        tokenSymbol,
        "WETH",
        amount
      );
      logger.info(`Sell transaction successful: ${sellTxHash}`);

      return sellTxHash;
    } catch (error) {
      logger.error("Error executing arbitrage:", error);
      throw error;
    }
  }

  /**
   * Execute a trade on a specific network
   * @param network Network to trade on
   * @param tokenInSymbol Input token symbol
   * @param tokenOutSymbol Output token symbol
   * @param amountIn Amount to trade (in full units, not wei)
   * @returns Transaction hash
   */
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

    // Get token information
    const tokenIn = networkRuntime.tokens[tokenInSymbol];
    const tokenOut = networkRuntime.tokens[tokenOutSymbol];

    if (!tokenIn || !tokenOut) {
      throw new Error(
        `Tokens not found: ${tokenInSymbol} or ${tokenOutSymbol}`
      );
    }

    // Create wallet connected to this network
    const networkWallet = this.wallet.connect(networkRuntime.provider);

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

    // 5. Get output quote
    const amountOut = await this.getOutputQuote(
      network,
      route,
      tokenIn,
      rawAmountIn
    );

    // 6. Create an unchecked trade
    const uncheckedTrade = Trade.createUncheckedTrade({
      route,
      inputAmount: CurrencyAmount.fromRawAmount(tokenIn, rawAmountIn),
      outputAmount: CurrencyAmount.fromRawAmount(
        tokenOut,
        amountOut.toString()
      ),
      tradeType: TradeType.EXACT_INPUT,
    });

    // 7. Approve token spending
    await this.approveTokenSpending(
      network,
      tokenIn.address,
      SWAP_ROUTER_ADDRESS,
      rawAmountIn
    );

    // 8. Execute the trade
    const options: SwapOptions = {
      slippageTolerance: new Percent(50, 10_000), // 0.5%
      deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes
      recipient: networkWallet.address,
    };

    const methodParameters = SwapRouter.swapCallParameters(
      [uncheckedTrade],
      options
    );

    // 9. Send the transaction
    const tx = await networkWallet.sendTransaction({
      data: methodParameters.calldata,
      to: SWAP_ROUTER_ADDRESS,
      value: methodParameters.value,
      gasLimit: 500000, // Set a reasonable gas limit
    });

    logger.info(
      `Trade executed on ${network}: ${tokenInSymbol} -> ${tokenOutSymbol}, Amount: ${amountIn}, Tx: ${tx.hash}`
    );

    return tx.hash;
  }

  /**
   * Get pool information for a token pair
   */
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

    // Find the pool address from config
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

    // Create a contract instance for the pool
    const poolContract = new ethers.Contract(
      poolAddress,
      POOL_ABI,
      networkRuntime.provider
    );

    // Get pool data
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

  /**
   * Get output quote for a route
   */
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

    // Get the encoded path from the route
    const path = encodeRouteToPath(route, false);

    // Format the amount in
    const formattedAmountIn = ethers.utils
      .parseUnits(amountIn, tokenIn.decimals)
      .toString();

    try {
      // Use the quoter contract to get the output amount
      const quoteAmount =
        await networkRuntime.quoter.callStatic.quoteExactInput(
          path,
          formattedAmountIn
        );

      return quoteAmount;
    } catch (error) {
      logger.error(`Failed to get quote: ${error}`);
      throw new Error(`Failed to get quote: ${error}`);
    }
  }

  /**
   * Approve token spending
   */
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

    // Create wallet connected to this network
    const networkWallet = this.wallet.connect(networkRuntime.provider);

    // Create token contract
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      networkWallet
    );

    // Check current allowance
    const currentAllowance = await tokenContract.allowance(
      networkWallet.address,
      spenderAddress
    );

    // If current allowance is less than amount, approve
    if (currentAllowance.lt(amount)) {
      logger.info(
        `Approving ${spenderAddress} to spend ${amount} of token ${tokenAddress}`
      );

      const tx = await tokenContract.approve(spenderAddress, amount, {
        gasLimit: 100000,
      });

      await tx.wait();
      logger.info(`Approval successful: ${tx.hash}`);
    } else {
      logger.info("Token spending already approved");
    }
  }
}
