import { Token, QUOTER_ADDRESSES } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import axios from "axios";

import {
  ERC20_ABI,
  POOL_ABI,
  QUOTER_V2_ABI,
  SWAP_ROUTER_ABI,
} from "./contracts/abis";

// Network Configuration
const NETWORKS = {
  ethereum: {
    chainId: 1,
    rpcUrl: process.env.ETHEREUM_RPC || "http://localhost:8545",
    name: "Ethereum",
    gasPrice: "30", // gwei
  },
  arbitrum: {
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC || "http://localhost:8546",
    name: "Arbitrum",
    gasPrice: "0.1", // gwei
  },
} as const;

// const VOLUME_CONFIG = {
//   targetVolume: 10000, // $10,000 target volume per network
//   checkInterval: 300000, // 5 minutes
//   rebalanceAmount: "500000000000000000", // 0.5 tokens per rebalance trade
//   maxRebalanceAttempts: 5,
//   volumeResetInterval: 86400000, // 24 hours
// } as const;

// CoinGecko Configuration
const COINGECKO_CONFIG = {
  url: "https://api.coingecko.com/api/v3/simple/price",
  apiKeys: [
    "CG-cP4n2gwFZ4ZP9RkZtYdbkpKT",
    "CG-6apJRLv8dFadNwouYfK2GEX9",
    "CG-MhGhY1U2pzh5XzifFNwvPmna",
  ],
  currentKeyIndex: 0,
  rateLimit: 10000, // 10 seconds between requests
  lastRequest: 0,
};

// const COINGECKO_CONFIG = ConfigLoader.getInstance().getCoinGeckoConfig();

// Token Definitions
const TOKENS = {
  ethereum: {
    WETH: new Token(
      1,
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      18,
      "WETH",
      "Wrapped Ether"
    ),
    SEED: new Token(
      1,
      "0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED",
      18,
      "SEED",
      "Seed Token"
    ),
  },
  arbitrum: {
    WETH: new Token(
      42161,
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      18,
      "WETH",
      "Wrapped Ether"
    ),
    SEED: new Token(
      42161,
      "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08",
      18,
      "SEED",
      "Seed Token"
    ),
  },
} as const;

// Pool configurations
const POOL_CONFIGS = {
  ethereum: [{ address: "0xd36ae827a9b62b8a32f0032cad1251b94fab1dd4" }],
  arbitrum: [{ address: "0xf9f588394ec5c3b05511368ce016de5fd3812446" }],
};

// Swap Router Addresses
const SWAP_ROUTER_ADDRESSES: { [key in 1 | 42161]: string } = {
  1: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  42161: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
};

interface NetworkConfig {
  chainId: number;
  provider: ethers.providers.JsonRpcProvider;
  wallet?: ethers.Wallet;
  quoter: ethers.Contract;
  swapRouter?: ethers.Contract;
  tokens: { WETH: Token; SEED: Token };
  name: string;
  gasPrice: string;
}

interface PriceData {
  ethereum: number;
  usd: number;
}

interface ArbitrageOpportunity {
  buyNetwork: string;
  sellNetwork: string;
  buyPrice: number;
  sellPrice: number;
  profitPercentage: number;
  estimatedProfit: number;
  gasEstimate: number;
}

interface TradeParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  network: string;
  minAmountOut: string;
}

interface SwapEventData {
  network: string;
  poolAddress: string;
  txHash: string;
  blockNumber: number;
  amount0: ethers.BigNumber;
  amount1: ethers.BigNumber;
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  sender: string;
}

interface PendingArbitrage {
  id: string;
  opportunity: ArbitrageOpportunity;
  timestamp: number;
  status: "pending" | "executing" | "completed" | "failed";
  buyTxHash?: string;
  sellTxHash?: string;
}

class RobustArbitrageBot {
  private networks: Map<string, NetworkConfig> = new Map();
  private poolConfigs: Map<string, any[]> = new Map();
  private poolContracts: Map<string, ethers.Contract[]> = new Map();
  private minProfitThreshold: number = 1; // 1% minimum profit
  private tradeAmount: string = "1000000000000000000"; // 1 token

  // // Volume tracking
  // private networkVolumes: Map<string, number> = new Map();
  // private lastVolumeReset: number = Date.now();
  // private lastVolumeCheck: Map<string, number> = new Map();
  // private rebalanceInProgress: Map<string, boolean> = new Map();

  // Enhanced state management
  private currentArbitrages: Map<string, PendingArbitrage> = new Map();
  private isGloballyProcessing: boolean = false;
  private eventQueue: SwapEventData[] = [];
  private processQueue: boolean = true;
  private maxQueueSize: number = 100;

  // Tracking our own transactions to avoid infinite loops
  private ourTransactions: Set<string> = new Set();
  private ourAddresses: Set<string> = new Set();

  // Rate limiting and cooldowns
  private lastProcessedTime: number = 0;
  private processingCooldown: number = 1000; // 1 second cooldown
  private maxConcurrentArbitrages: number = 2;

  // Enhanced error handling
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;
  private errorBackoffTime: number = 30000; // 30 seconds
  private lastErrorTime: number = 0;

  // Balance tracking

  private nonceManagers: Map<
    string,
    {
      nonce: number;
      pendingNonces: Set<number>;
      lock: boolean;
    }
  > = new Map();

  constructor(private privateKey?: string) {
    this.initializeNetworks();
    this.initializePoolConfigs();
    this.initializePoolContracts();
    this.initializeNonceManagers();
    this.startQueueProcessor();
  }

  private async initializeNonceManagers(): Promise<void> {
    for (const [networkKey, network] of this.networks.entries()) {
      try {
        if (!network.wallet) {
          console.log(
            `No wallet configured for ${networkKey}, skipping nonce initialization`
          );
          continue;
        }

        // Get both pending and latest nonce
        const [pendingNonce, confirmedNonce] = await Promise.all([
          network.provider.getTransactionCount(
            network.wallet.address,
            "pending"
          ),
          network.provider.getTransactionCount(
            network.wallet.address,
            "latest"
          ),
        ]);

        // Use the higher nonce to avoid conflicts
        const currentNonce = Math.max(pendingNonce, confirmedNonce);
        this.nonceManagers.set(networkKey, {
          nonce: currentNonce,
          pendingNonces: new Set(),
          lock: false,
        });

        console.log(
          `Initialized nonce for ${networkKey}: ${currentNonce} (confirmed: ${confirmedNonce}, pending: ${pendingNonce})`
        );
      } catch (error) {
        console.error(`Failed to initialize nonce for ${networkKey}:`, error);
        this.nonceManagers.set(networkKey, {
          nonce: 0,
          pendingNonces: new Set(),
          lock: false,
        });
      }
    }
  }

  private async getNextNonce(networkKey: string): Promise<number> {
    const network = this.networks.get(networkKey.toLowerCase());
    if (!network?.wallet) {
      throw new Error(`Network ${networkKey} not configured with wallet`);
    }

    const nonceManager = this.nonceManagers.get(networkKey.toLowerCase());
    if (!nonceManager) {
      throw new Error(`Nonce manager not initialized for ${networkKey}`);
    }

    // Wait if nonce manager is locked
    while (nonceManager.lock) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      nonceManager.lock = true;

      // Get fresh nonce from network
      const [pendingNonce, confirmedNonce] = await Promise.all([
        network.provider.getTransactionCount(network.wallet.address, "pending"),
        network.provider.getTransactionCount(network.wallet.address, "latest"),
      ]);

      // Calculate next available nonce
      let nextNonce = Math.max(
        pendingNonce,
        confirmedNonce,
        nonceManager.nonce,
        ...nonceManager.pendingNonces
      );

      // Find first unused nonce
      while (nonceManager.pendingNonces.has(nextNonce)) {
        nextNonce++;
      }

      // Add to pending nonces
      nonceManager.pendingNonces.add(nextNonce);
      nonceManager.nonce = nextNonce + 1;

      return nextNonce;
    } catch (error) {
      console.error(`Error getting nonce for ${networkKey}:`, error);
      throw error;
    } finally {
      nonceManager.lock = false;
    }
  }

  private async releasePendingNonce(
    networkKey: string,
    nonce: number
  ): Promise<void> {
    const nonceManager = this.nonceManagers.get(networkKey.toLowerCase());
    if (nonceManager) {
      nonceManager.pendingNonces.delete(nonce);
    }
  }

  // private initializeVolumeTracking(): void {
  //   for (const networkKey of this.networks.keys()) {
  //     this.networkVolumes.set(networkKey, 0);
  //     this.lastVolumeCheck.set(networkKey, Date.now());
  //     this.rebalanceInProgress.set(networkKey, false);
  //   }
  //   console.log(`📊 Volume tracking initialized for all networks`);
  // }

  // private async fetchNetworkVolume(networkKey: string): Promise<number> {
  //   try {
  //     const network = this.networks.get(networkKey);
  //     const poolConfigs = this.poolConfigs.get(networkKey);

  //     if (!network || !poolConfigs) return 0;

  //     // Get pool contract
  //     const poolContract = new ethers.Contract(
  //       poolConfigs[0].address,
  //       POOL_ABI,
  //       network.provider
  //     );

  //     // Get recent swap events (last 100 blocks)
  //     const currentBlock = await network.provider.getBlockNumber();
  //     const fromBlock = Math.max(currentBlock - 100, 0);

  //     const events = await poolContract.queryFilter(
  //       poolContract.filters.Swap(),
  //       fromBlock,
  //       currentBlock
  //     );

  //     // Calculate volume from events
  //     let volume = 0;
  //     const prices = await this.fetchCoinGeckoPrices();

  //     for (const event of events) {
  //       const amount0 = Math.abs(
  //         parseFloat(ethers.utils.formatUnits(event.args!.amount0, 18))
  //       );
  //       const amount1 = Math.abs(
  //         parseFloat(ethers.utils.formatUnits(event.args!.amount1, 18))
  //       );

  //       // Convert to USD (assuming one of the tokens is WETH)
  //       volume += amount1 * prices.ethereum.usd; // WETH amount * ETH price
  //     }

  //     return volume;
  //   } catch (error: any) {
  //     console.error(
  //       `❌ Failed to fetch volume for ${networkKey}: ${error.message}`
  //     );
  //     return 0;
  //   }
  // }

  // private async checkAndRebalanceVolume(networkKey: string): Promise<void> {
  //   if (this.rebalanceInProgress.get(networkKey)) {
  //     return;
  //   }

  //   try {
  //     const currentVolume = await this.fetchNetworkVolume(networkKey);
  //     const storedVolume = this.networkVolumes.get(networkKey) || 0;
  //     const totalVolume = storedVolume + currentVolume;

  //     console.log(
  //       `📊 ${networkKey} volume: $${totalVolume.toFixed(2)} / $${
  //         VOLUME_CONFIG.targetVolume
  //       }`
  //     );

  //     if (totalVolume < VOLUME_CONFIG.targetVolume) {
  //       const volumeDeficit = VOLUME_CONFIG.targetVolume - totalVolume;
  //       console.log(
  //         `⚖️ Volume deficit on ${networkKey}: $${volumeDeficit.toFixed(2)}`
  //       );

  //       await this.executeRebalanceTrades(networkKey, volumeDeficit);
  //     }
  //   } catch (error: any) {
  //     console.error(
  //       `❌ Volume rebalance check failed for ${networkKey}: ${error.message}`
  //     );
  //   }
  // }

  // private async executeRebalanceTrades(
  //   networkKey: string,
  //   volumeDeficit: number
  // ): Promise<void> {
  //   this.rebalanceInProgress.set(networkKey, true);

  //   try {
  //     console.log(`🔄 Starting volume rebalancing for ${networkKey}`);

  //     const network = this.networks.get(networkKey);
  //     const poolConfigs = this.poolConfigs.get(networkKey);

  //     if (!network || !poolConfigs || !network.wallet) {
  //       return;
  //     }

  //     const poolInfo = await this.getPoolInfo(poolConfigs[0].address, network);
  //     if (!poolInfo.isValid) {
  //       return;
  //     }

  //     let attempts = 0;
  //     let volumeGenerated = 0;

  //     while (
  //       volumeGenerated < volumeDeficit &&
  //       attempts < VOLUME_CONFIG.maxRebalanceAttempts
  //     ) {
  //       // Alternate between WETH->SEED and SEED->WETH trades
  //       const isWethToSeed = attempts % 2 === 0;

  //       const tradeParams: TradeParams = {
  //         tokenIn: isWethToSeed
  //           ? network.tokens.WETH.address
  //           : network.tokens.SEED.address,
  //         tokenOut: isWethToSeed
  //           ? network.tokens.SEED.address
  //           : network.tokens.WETH.address,
  //         fee: poolInfo.actualFee!,
  //         amountIn: VOLUME_CONFIG.rebalanceAmount,
  //         network: networkKey,
  //         minAmountOut: "0", // Accept any amount for rebalancing
  //       };

  //       const result = await this.executeTrade(tradeParams);

  //       if (result.success) {
  //         const tradeValue = parseFloat(
  //           ethers.utils.formatUnits(VOLUME_CONFIG.rebalanceAmount, 18)
  //         );
  //         const prices = await this.fetchCoinGeckoPrices();
  //         const usdValue = tradeValue * prices.ethereum.usd;

  //         volumeGenerated += usdValue;
  //         console.log(
  //           `✅ Rebalance trade ${attempts + 1}: +$${usdValue.toFixed(
  //             2
  //           )} volume`
  //         );

  //         // Wait between trades
  //         await new Promise((resolve) => setTimeout(resolve, 3000));
  //       }

  //       attempts++;
  //     }

  //     // Update stored volume
  //     const currentStored = this.networkVolumes.get(networkKey) || 0;
  //     this.networkVolumes.set(networkKey, currentStored + volumeGenerated);

  //     console.log(
  //       `🎯 Volume rebalancing complete for ${networkKey}: +$${volumeGenerated.toFixed(
  //         2
  //       )}`
  //     );
  //   } catch (error: any) {
  //     console.error(
  //       `❌ Rebalance execution failed for ${networkKey}: ${error.message}`
  //     );
  //   } finally {
  //     this.rebalanceInProgress.set(networkKey, false);
  //   }
  // }

  // private startVolumeRebalancer(): void {
  //   console.log(`📊 Starting volume rebalancer...`);

  //   // Check volumes periodically
  //   setInterval(async () => {
  //     if (this.shouldSkipProcessing()) return;

  //     for (const networkKey of this.networks.keys()) {
  //       const lastCheck = this.lastVolumeCheck.get(networkKey) || 0;
  //       if (Date.now() - lastCheck > VOLUME_CONFIG.checkInterval) {
  //         this.lastVolumeCheck.set(networkKey, Date.now());
  //         await this.checkAndRebalanceVolume(networkKey);
  //       }
  //     }
  //   }, VOLUME_CONFIG.checkInterval);

  //   // Reset volumes daily
  //   setInterval(() => {
  //     console.log(`🔄 Resetting daily volume counters`);
  //     for (const networkKey of this.networks.keys()) {
  //       this.networkVolumes.set(networkKey, 0);
  //     }
  //     this.lastVolumeReset = Date.now();
  //   }, VOLUME_CONFIG.volumeResetInterval);
  // }

  private initializeNetworks(): void {
    // Ethereum
    const ethProvider = new ethers.providers.JsonRpcProvider(
      NETWORKS.ethereum.rpcUrl
    );
    const ethQuoter = new ethers.Contract(
      QUOTER_ADDRESSES[NETWORKS.ethereum.chainId],
      QUOTER_V2_ABI,
      ethProvider
    );

    let ethWallet, ethSwapRouter;
    if (this.privateKey) {
      ethWallet = new ethers.Wallet(this.privateKey, ethProvider);
      ethSwapRouter = new ethers.Contract(
        SWAP_ROUTER_ADDRESSES[1],
        SWAP_ROUTER_ABI,
        ethWallet
      );
    }

    this.networks.set("ethereum", {
      chainId: NETWORKS.ethereum.chainId,
      provider: ethProvider,
      wallet: ethWallet,
      quoter: ethQuoter,
      swapRouter: ethSwapRouter,
      tokens: TOKENS.ethereum,
      name: NETWORKS.ethereum.name,
      gasPrice: NETWORKS.ethereum.gasPrice,
    });

    // Arbitrum
    const arbProvider = new ethers.providers.JsonRpcProvider(
      NETWORKS.arbitrum.rpcUrl
    );
    const arbQuoter = new ethers.Contract(
      QUOTER_ADDRESSES[NETWORKS.arbitrum.chainId],
      QUOTER_V2_ABI,
      arbProvider
    );

    let arbWallet, arbSwapRouter;
    if (this.privateKey) {
      arbWallet = new ethers.Wallet(this.privateKey, arbProvider);
      arbSwapRouter = new ethers.Contract(
        SWAP_ROUTER_ADDRESSES[42161],
        SWAP_ROUTER_ABI,
        arbWallet
      );
    }

    this.networks.set("arbitrum", {
      chainId: NETWORKS.arbitrum.chainId,
      provider: arbProvider,
      wallet: arbWallet,
      quoter: arbQuoter,
      swapRouter: arbSwapRouter,
      tokens: TOKENS.arbitrum,
      name: NETWORKS.arbitrum.name,
      gasPrice: NETWORKS.arbitrum.gasPrice,
    });
  }

  private initializePoolConfigs(): void {
    this.poolConfigs.set("ethereum", POOL_CONFIGS.ethereum);
    this.poolConfigs.set("arbitrum", POOL_CONFIGS.arbitrum);
  }

  private initializePoolContracts(): void {
    for (const [networkKey, network] of this.networks.entries()) {
      const poolConfigs = this.poolConfigs.get(networkKey);
      if (!poolConfigs) continue;

      const contracts = poolConfigs.map(
        (config) =>
          new ethers.Contract(config.address, POOL_ABI, network.provider)
      );

      this.poolContracts.set(networkKey, contracts);
    }
  }

  private async rotateApiKey(): Promise<string> {
    const currentKey =
      COINGECKO_CONFIG.apiKeys[COINGECKO_CONFIG.currentKeyIndex];
    COINGECKO_CONFIG.currentKeyIndex =
      (COINGECKO_CONFIG.currentKeyIndex + 1) % COINGECKO_CONFIG.apiKeys.length;
    return currentKey;
  }

  private async fetchCoinGeckoPrices(): Promise<{
    ethereum: PriceData;
    seed?: PriceData;
  }> {
    const now = Date.now();
    if (now - COINGECKO_CONFIG.lastRequest < COINGECKO_CONFIG.rateLimit) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          COINGECKO_CONFIG.rateLimit - (now - COINGECKO_CONFIG.lastRequest)
        )
      );
    }

    const apiKey = await this.rotateApiKey();

    try {
      const response = await axios.get(COINGECKO_CONFIG.url, {
        headers: {
          "x-cg-demo-api-key": apiKey,
        },
        params: {
          ids: "ethereum,seed-token",
          vs_currencies: "usd",
        },
        timeout: 10000, // 10 second timeout
      });

      COINGECKO_CONFIG.lastRequest = Date.now();

      return {
        ethereum: {
          ethereum: 1,
          usd: response.data.ethereum?.usd || 0,
        },
        seed: response.data["seed-token"]
          ? {
              ethereum:
                response.data["seed-token"].usd / response.data.ethereum.usd,
              usd: response.data["seed-token"].usd,
            }
          : undefined,
      };
    } catch (error: any) {
      console.error(`❌ CoinGecko API error: ${error.message}`);
      throw new Error("Failed to fetch prices");
    }
  }

  private async getPoolInfo(
    poolAddress: string,
    network: NetworkConfig
  ): Promise<{
    isValid: boolean;
    actualFee?: number;
    token0?: string;
    token1?: string;
    token0IsSeed?: boolean;
  }> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        POOL_ABI,
        network.provider
      );
      const [token0, token1, fee, liquidity] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
        poolContract.fee(),
        poolContract.liquidity(),
      ]);

      const token0Lower = token0.toLowerCase();
      const token1Lower = token1.toLowerCase();
      const seedLower = network.tokens.SEED.address.toLowerCase();
      const wethLower = network.tokens.WETH.address.toLowerCase();

      const hasSeed = token0Lower === seedLower || token1Lower === seedLower;
      const hasWeth = token0Lower === wethLower || token1Lower === wethLower;

      if (!hasSeed || !hasWeth || liquidity.eq(0)) {
        return { isValid: false };
      }

      return {
        isValid: true,
        actualFee: fee,
        token0,
        token1,
        token0IsSeed: token0Lower === seedLower,
      };
    } catch (error: any) {
      return { isValid: false };
    }
  }

  private async getQuote(networkKey: string): Promise<{
    network: string;
    seedToWethRate: number;
    wethToSeedRate: number;
    poolAddress: string;
    fee: number;
  } | null> {
    const network = this.networks.get(networkKey);
    const poolConfigs = this.poolConfigs.get(networkKey);

    if (!network || !poolConfigs || poolConfigs.length === 0) {
      return null;
    }

    const poolConfig = poolConfigs[0];
    const poolInfo = await this.getPoolInfo(poolConfig.address, network);

    if (!poolInfo.isValid || poolInfo.actualFee === undefined) {
      return null;
    }

    try {
      const seedToWethQuote =
        await network.quoter.callStatic.quoteExactInputSingle(
          network.tokens.SEED.address,
          network.tokens.WETH.address,
          poolInfo.actualFee,
          this.tradeAmount,
          0
        );

      const wethToSeedQuote =
        await network.quoter.callStatic.quoteExactInputSingle(
          network.tokens.WETH.address,
          network.tokens.SEED.address,
          poolInfo.actualFee,
          this.tradeAmount,
          0
        );

      return {
        network: network.name,
        seedToWethRate: parseFloat(
          ethers.utils.formatUnits(seedToWethQuote, 18)
        ),
        wethToSeedRate: parseFloat(
          ethers.utils.formatUnits(wethToSeedQuote, 18)
        ),
        poolAddress: poolConfig.address,
        fee: poolInfo.actualFee,
      };
    } catch (error: any) {
      console.error(`❌ Quote failed for ${network.name}: ${error.message}`);
      return null;
    }
  }

  private async calculateArbitrageOpportunity(
    ethQuote: any,
    arbQuote: any,
    prices: any
  ): Promise<ArbitrageOpportunity | null> {
    if (!ethQuote || !arbQuote || !prices.ethereum) {
      return null;
    }

    // Calculate USD prices for SEED on each network
    const ethSeedUsdPrice = ethQuote.seedToWethRate * prices.ethereum.usd;
    const arbSeedUsdPrice = arbQuote.seedToWethRate * prices.ethereum.usd;

    // Determine arbitrage direction
    let buyNetwork, sellNetwork, buyPrice, sellPrice;
    if (ethSeedUsdPrice < arbSeedUsdPrice) {
      buyNetwork = "Ethereum";
      sellNetwork = "Arbitrum";
      buyPrice = ethSeedUsdPrice;
      sellPrice = arbSeedUsdPrice;
    } else {
      buyNetwork = "Arbitrum";
      sellNetwork = "Ethereum";
      buyPrice = arbSeedUsdPrice;
      sellPrice = ethSeedUsdPrice;
    }

    const profitPercentage = ((sellPrice - buyPrice) / buyPrice) * 100;
    const estimatedProfit = sellPrice - buyPrice;

    // Estimate gas costs
    const buyGasEstimate = buyNetwork === "Ethereum" ? 150000 : 80000;
    const sellGasEstimate = sellNetwork === "Ethereum" ? 150000 : 80000;
    const totalGasEstimate = buyGasEstimate + sellGasEstimate;

    return {
      buyNetwork,
      sellNetwork,
      buyPrice,
      sellPrice,
      profitPercentage,
      estimatedProfit,
      gasEstimate: totalGasEstimate,
    };
  }

  private async checkBalances(networkKey: string): Promise<{
    weth: string;
    seed: string;
    nativeToken: string;
  }> {
    const network = this.networks.get(networkKey);
    if (!network || !network.wallet) {
      throw new Error(`Network ${networkKey} not configured with wallet`);
    }

    const wethContract = new ethers.Contract(
      network.tokens.WETH.address,
      ERC20_ABI,
      network.provider
    );

    const seedContract = new ethers.Contract(
      network.tokens.SEED.address,
      ERC20_ABI,
      network.provider
    );

    const [wethBalance, seedBalance, nativeBalance] = await Promise.all([
      wethContract.balanceOf(network.wallet.address),
      seedContract.balanceOf(network.wallet.address),
      network.provider.getBalance(network.wallet.address),
    ]);

    return {
      weth: ethers.utils.formatUnits(wethBalance, 18),
      seed: ethers.utils.formatUnits(seedBalance, 18),
      nativeToken: ethers.utils.formatUnits(nativeBalance, 18),
    };
  }

  private async executeTrade(params: TradeParams): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    const network = this.networks.get(params.network.toLowerCase());
    if (!network || !network.wallet || !network.swapRouter) {
      return {
        success: false,
        error: `Network ${params.network} not configured for trading`,
      };
    }

    let currentNonce: number | undefined;

    try {
      // Check balance first
      const tokenInContract = new ethers.Contract(
        params.tokenIn,
        ERC20_ABI,
        network.wallet
      );

      const balance = await tokenInContract.balanceOf(network.wallet.address);
      if (balance.lt(params.amountIn)) {
        return {
          success: false,
          error: `Insufficient balance. Have: ${ethers.utils.formatUnits(
            balance,
            18
          )}, Need: ${ethers.utils.formatUnits(params.amountIn, 18)}`,
        };
      }

      // Check allowance
      const allowance = await tokenInContract.allowance(
        network.wallet.address,
        network.swapRouter.address
      );

      // Handle approval if needed
      if (allowance.lt(params.amountIn)) {
        console.log(`   Approving token...`);
        const approveNonce = this.getNextNonce(params.network.toLowerCase());
        const approveTx = await tokenInContract.approve(
          network.swapRouter.address,
          ethers.constants.MaxUint256,
          {
            gasLimit: 100000,
            maxFeePerGas: ethers.utils.parseUnits("50", "gwei"),
            maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
            nonce: approveNonce,
            type: 2, // EIP-1559 transaction
          }
        );

        console.log(
          `   Approval transaction hash: ${approveTx.hash} (nonce: ${approveNonce})`
        );

        // Wait for approval confirmation
        console.log(`   Waiting for approval confirmation...`);
        const approvalReceipt = await approveTx.wait(1);
        console.log(
          `   ✅ Approval confirmed in block ${approvalReceipt.blockNumber}`
        );

        // Add small delay after approval
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Get fresh nonce for the transaction
      currentNonce = await this.getNextNonce(params.network.toLowerCase());
      console.log(
        `   Executing swap with nonce ${currentNonce} on ${params.network}`
      );

      const swapParams = {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        recipient: network.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 1800,
        amountIn: params.amountIn,
        amountOutMinimum: params.minAmountOut,
        sqrtPriceLimitX96: 0,
      };

      const swapTx = await network.swapRouter.exactInputSingle(swapParams, {
        gasLimit: 300000,
        maxFeePerGas: ethers.utils.parseUnits("50", "gwei"),
        maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
        nonce: currentNonce,
        type: 2,
      });

      console.log(`Transaction hash: ${swapTx.hash} (nonce: ${currentNonce})`);
      this.ourTransactions.add(swapTx.hash.toLowerCase());

      const receipt = await swapTx.wait(1);
      if (receipt.status === 0) {
        throw new Error("Transaction failed");
      }

      console.log(`✅ Trade executed successfully with nonce ${currentNonce}`);
      return {
        success: true,
        txHash: swapTx.hash,
      };
    } catch (error: any) {
      console.error(`❌ Trade execution failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    } finally {
      // Release the nonce if it was obtained
      if (currentNonce !== undefined) {
        await this.releasePendingNonce(
          params.network.toLowerCase(),
          currentNonce
        );
      }
    }
  }

  private async executeArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<boolean> {
    const arbitrageId = `${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    console.log(`\n🚀 EXECUTING ARBITRAGE ${arbitrageId}`);
    console.log(
      `Buy ${opportunity.buyNetwork} → Sell ${opportunity.sellNetwork}`
    );
    console.log(`Expected profit: ${opportunity.profitPercentage.toFixed(2)}%`);

    // Create pending arbitrage record
    const pendingArbitrage: PendingArbitrage = {
      id: arbitrageId,
      opportunity,
      timestamp: Date.now(),
      status: "executing",
    };

    this.currentArbitrages.set(arbitrageId, pendingArbitrage);

    try {
      const buyNetworkKey = opportunity.buyNetwork.toLowerCase();
      const sellNetworkKey = opportunity.sellNetwork.toLowerCase();

      // Check balances
      const buyNetworkBalances = await this.checkBalances(buyNetworkKey);
      const sellNetworkBalances = await this.checkBalances(sellNetworkKey);

      console.log(`\nBalances before arbitrage:`);
      console.log(
        `${opportunity.buyNetwork}: ${buyNetworkBalances.seed} SEED, ${buyNetworkBalances.weth} WETH`
      );
      console.log(
        `${opportunity.sellNetwork}: ${sellNetworkBalances.seed} SEED, ${sellNetworkBalances.weth} WETH`
      );

      // Validate we have sufficient funds
      const requiredWeth = parseFloat(
        ethers.utils.formatUnits(this.tradeAmount, 18)
      );
      if (parseFloat(buyNetworkBalances.weth) < requiredWeth) {
        throw new Error(
          `Insufficient WETH on ${opportunity.buyNetwork}. Have: ${buyNetworkBalances.weth}, Need: ${requiredWeth}`
        );
      }

      // Step 1: Buy SEED on the cheaper network
      const buyNetwork = this.networks.get(buyNetworkKey);
      const buyPoolConfig = this.poolConfigs.get(buyNetworkKey)?.[0];

      if (!buyNetwork || !buyPoolConfig) {
        throw new Error(`Buy network configuration not found`);
      }

      const buyPoolInfo = await this.getPoolInfo(
        buyPoolConfig.address,
        buyNetwork
      );
      if (!buyPoolInfo.isValid) {
        throw new Error(`Invalid buy pool`);
      }

      const buyParams: TradeParams = {
        tokenIn: buyNetwork.tokens.WETH.address,
        tokenOut: buyNetwork.tokens.SEED.address,
        fee: buyPoolInfo.actualFee!,
        amountIn: this.tradeAmount,
        network: opportunity.buyNetwork,
        minAmountOut: ethers.utils
          .parseUnits(
            (
              0.95 * parseFloat(ethers.utils.formatUnits(this.tradeAmount, 18))
            ).toString(),
            18
          )
          .toString(), // 5% slippage
      };

      const buyResult = await this.executeTrade(buyParams);
      if (!buyResult.success) {
        throw new Error(`Buy trade failed: ${buyResult.error}`);
      }

      pendingArbitrage.buyTxHash = buyResult.txHash;
      pendingArbitrage.status = "executing";

      // Wait for the transaction to settle and get updated SEED balance
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Get current SEED balance to sell
      const sellNetwork = this.networks.get(sellNetworkKey);
      const sellPoolConfig = this.poolConfigs.get(sellNetworkKey)?.[0];

      if (!sellNetwork || !sellPoolConfig) {
        throw new Error(`Sell network configuration not found`);
      }

      const sellPoolInfo = await this.getPoolInfo(
        sellPoolConfig.address,
        sellNetwork
      );
      if (!sellPoolInfo.isValid) {
        throw new Error(`Invalid sell pool`);
      }

      const seedContract = new ethers.Contract(
        sellNetwork.tokens.SEED.address,
        ERC20_ABI,
        sellNetwork.provider
      );

      const currentSeedBalance = await seedContract.balanceOf(
        sellNetwork.wallet!.address
      );

      if (currentSeedBalance.eq(0)) {
        throw new Error(
          `No SEED balance available to sell on ${opportunity.sellNetwork}`
        );
      }

      const sellParams: TradeParams = {
        tokenIn: sellNetwork.tokens.SEED.address,
        tokenOut: sellNetwork.tokens.WETH.address,
        fee: sellPoolInfo.actualFee!,
        amountIn: currentSeedBalance.toString(),
        network: opportunity.sellNetwork,
        minAmountOut: ethers.utils
          .parseUnits((0.95 * opportunity.sellPrice).toString(), 18)
          .toString(), // 5% slippage
      };

      const sellResult = await this.executeTrade(sellParams);
      if (!sellResult.success) {
        throw new Error(`Sell trade failed: ${sellResult.error}`);
      }

      pendingArbitrage.sellTxHash = sellResult.txHash;
      pendingArbitrage.status = "completed";

      console.log(`✅ ARBITRAGE ${arbitrageId} COMPLETED SUCCESSFULLY`);

      // Reset consecutive errors on success
      this.consecutiveErrors = 0;

      return true;
    } catch (error: any) {
      console.error(
        `❌ Arbitrage ${arbitrageId} execution failed: ${error.message}`
      );
      pendingArbitrage.status = "failed";

      this.consecutiveErrors++;
      this.lastErrorTime = Date.now();

      return false;
    } finally {
      // Clean up completed/failed arbitrages after some time
      setTimeout(() => {
        this.currentArbitrages.delete(arbitrageId);
      }, 300000); // 5 minutes
    }
  }

  private isOurTransaction(eventData: SwapEventData): boolean {
    const txHashLower = eventData.txHash.toLowerCase();
    const senderLower = eventData.sender.toLowerCase();

    return (
      this.ourTransactions.has(txHashLower) ||
      this.ourAddresses.has(senderLower)
    );
  }

  private shouldSkipProcessing(): boolean {
    const now = Date.now();

    // Skip if too many consecutive errors and in backoff period
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      if (now - this.lastErrorTime < this.errorBackoffTime) {
        console.log(
          `⏸️ In error backoff period (${this.consecutiveErrors} consecutive errors)`
        );
        return true;
      } else {
        // Reset error count after backoff period
        this.consecutiveErrors = 0;
      }
    }

    // Skip if we have too many concurrent arbitrages
    const activeArbitrages = Array.from(this.currentArbitrages.values()).filter(
      (arb) => arb.status === "executing"
    ).length;

    if (activeArbitrages >= this.maxConcurrentArbitrages) {
      console.log(`⏸️ Max concurrent arbitrages (${activeArbitrages}) reached`);
      return true;
    }

    // Basic cooldown
    if (now - this.lastProcessedTime < this.processingCooldown) {
      return true;
    }

    return false;
  }

  // Fixed handleSwapEvent method
  private async handleSwapEvent(eventData: SwapEventData): Promise<void> {
    // Check if this is our own transaction to avoid processing our own swaps
    // if (this.isOurTransaction(eventData)) {
    //   console.log(
    //     `⭐ Detected our own transaction: ${eventData.txHash} - skipping`
    //   );
    //   return;
    // }

    // Check if we should skip processing due to various conditions
    if (this.shouldSkipProcessing()) {
      return;
    }

    // Add to event queue if we're using queue processing
    if (this.eventQueue.length >= this.maxQueueSize) {
      console.log(
        `⚠️ Event queue full (${this.maxQueueSize}), dropping oldest events`
      );
      this.eventQueue.shift();
    }

    this.eventQueue.push(eventData);

    // If we're not globally processing and queue processing is enabled, trigger processing
    if (!this.isGloballyProcessing && this.processQueue) {
      this.processEventQueue().catch((error) => {
        console.error(`❌ Error processing event queue: ${error.message}`);
      });
    }
  }

  // Add this method to process the event queue
  private async processEventQueue(): Promise<void> {
    if (this.isGloballyProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isGloballyProcessing = true;
    const now = Date.now();

    try {
      // Process the most recent event (we only need one trigger)
      const eventData = this.eventQueue.pop();
      if (!eventData) {
        return;
      }

      // Clear the queue since we're processing now
      this.eventQueue = [];

      const timestamp = new Date().toLocaleString();
      console.log(`\n🔔 PROCESSING SWAP EVENT`);
      console.log(`⏰ ${timestamp}`);
      console.log(`🌐 Network: ${eventData.network}`);
      console.log(`🏊 Pool: ${eventData.poolAddress}`);
      console.log(`📋 Tx: ${eventData.txHash}`);
      console.log(`#️⃣ Block: ${eventData.blockNumber}`);
      console.log(`👤 Sender: ${eventData.sender}`);
      console.log("=".repeat(60));

      // Update last processed time
      this.lastProcessedTime = now;

      // Scan for arbitrage opportunities
      await this.scanAndExecute();
    } catch (error: any) {
      console.error(`❌ Error processing event queue: ${error.message}`);
      this.consecutiveErrors++;
      this.lastErrorTime = Date.now();
    } finally {
      this.isGloballyProcessing = false;
    }
  }

  // Add this method to start the queue processor
  private startQueueProcessor(): void {
    // Process queue every few seconds if there are pending events
    setInterval(() => {
      if (
        this.eventQueue.length > 0 &&
        !this.isGloballyProcessing &&
        this.processQueue
      ) {
        this.processEventQueue().catch((error) => {
          console.error(`❌ Queue processor error: ${error.message}`);
        });
      }
    }, 3000); // Check every 3 seconds
  }

  private setupEventListeners(): void {
    console.log(`\n🎧 SETTING UP EVENT LISTENERS`);
    console.log("=".repeat(50));

    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      const network = this.networks.get(networkKey);
      if (!network) continue;

      console.log(`📡 Listening to ${network.name} pools:`);

      contracts.forEach((contract, index) => {
        console.log(`   Pool ${index + 1}: ${contract.address}`);

        // Listen to Swap events
        contract.on(
          "Swap",
          (
            sender,
            recipient,
            amount0,
            amount1,
            sqrtPriceX96,
            liquidity,
            tick,
            event
          ) => {
            const eventData: SwapEventData = {
              network: network.name,
              poolAddress: contract.address,
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              amount0,
              amount1,
              sqrtPriceX96,
              tick,
              sender: sender, // Capture the sender address
            };

            // Handle the event asynchronously
            this.handleSwapEvent(eventData).catch((error) => {
              console.error(`❌ Error in swap event handler: ${error.message}`);
            });
          }
        );

        // Handle connection errors
        contract.provider.on("error", (error) => {
          console.error(
            `❌ Provider error for ${network.name}: ${error.message}`
          );
          // Attempt to reconnect after a delay
          setTimeout(() => {
            console.log(`🔄 Attempting to reconnect ${network.name}...`);
            this.reconnectNetwork(networkKey);
          }, 5000);
        });
      });
    }

    console.log(`✅ Event listeners setup complete`);
    console.log(`🎯 Listening for swap events on all configured pools`);
  }

  private async reconnectNetwork(networkKey: string): Promise<void> {
    try {
      const network = this.networks.get(networkKey);
      if (!network) return;

      // Remove old listeners
      const contracts = this.poolContracts.get(networkKey);
      if (contracts) {
        contracts.forEach((contract) => contract.removeAllListeners());
      }

      // Recreate provider and contracts
      const newProvider = new ethers.providers.JsonRpcProvider(
        networkKey === "ethereum"
          ? NETWORKS.ethereum.rpcUrl
          : NETWORKS.arbitrum.rpcUrl
      );

      network.provider = newProvider;

      // Update quoter
      network.quoter = new ethers.Contract(
        QUOTER_ADDRESSES[network.chainId],
        QUOTER_V2_ABI,
        newProvider
      );

      // Update wallet and swap router if available
      if (this.privateKey) {
        network.wallet = new ethers.Wallet(this.privateKey, newProvider);
        network.swapRouter = new ethers.Contract(
          SWAP_ROUTER_ADDRESSES[network.chainId as 1 | 42161],
          SWAP_ROUTER_ABI,
          network.wallet
        );
      }

      // Recreate pool contracts
      const poolConfigs = this.poolConfigs.get(networkKey);
      if (poolConfigs) {
        const newContracts = poolConfigs.map(
          (config) => new ethers.Contract(config.address, POOL_ABI, newProvider)
        );
        this.poolContracts.set(networkKey, newContracts);
      }

      console.log(`✅ Successfully reconnected ${network.name}`);

      // Re-setup listeners for this network
      this.setupEventListenersForNetwork(networkKey);
    } catch (error: any) {
      console.error(`❌ Failed to reconnect ${networkKey}: ${error.message}`);
    }
  }

  private setupEventListenersForNetwork(networkKey: string): void {
    const contracts = this.poolContracts.get(networkKey);
    const network = this.networks.get(networkKey);

    if (!contracts || !network) return;

    contracts.forEach((contract) => {
      contract.on(
        "Swap",
        (
          sender,
          recipient,
          amount0,
          amount1,
          sqrtPriceX96,
          liquidity,
          tick,
          event
        ) => {
          const eventData: SwapEventData = {
            network: network.name,
            poolAddress: contract.address,
            txHash: event.transactionHash,
            blockNumber: event.blockNumber,
            amount0,
            amount1,
            sqrtPriceX96,
            tick,
            sender: sender, // Capture the sender address
          };

          this.handleSwapEvent(eventData).catch((error) => {
            console.error(`❌ Error in swap event handler: ${error.message}`);
          });
        }
      );
    });
  }

  async scanAndExecute(): Promise<void> {
    console.log(`\n🔍 SCANNING FOR ARBITRAGE OPPORTUNITIES`);
    console.log("=".repeat(60));

    try {
      // Fetch real-time prices
      const prices = await this.fetchCoinGeckoPrices();

      // Get quotes from both networks
      const [ethQuote, arbQuote] = await Promise.all([
        this.getQuote("ethereum"),
        this.getQuote("arbitrum"),
      ]);

      if (!ethQuote || !arbQuote) {
        console.log("❌ Failed to get quotes from both networks");
        return;
      }

      // Calculate arbitrage opportunity
      const opportunity = await this.calculateArbitrageOpportunity(
        ethQuote,
        arbQuote,
        prices
      );

      if (!opportunity) {
        console.log("❌ No arbitrage opportunity found");
        return;
      }

      console.log(`\n📊 ARBITRAGE OPPORTUNITY FOUND`);
      console.log(
        `Buy on: ${opportunity.buyNetwork} at ${opportunity.buyPrice.toFixed(
          6
        )}`
      );
      console.log(
        `Sell on: ${opportunity.sellNetwork} at ${opportunity.sellPrice.toFixed(
          6
        )}`
      );
      console.log(
        `Profit: ${opportunity.profitPercentage.toFixed(
          2
        )}% (${opportunity.estimatedProfit.toFixed(6)})`
      );

      if (opportunity.profitPercentage >= this.minProfitThreshold) {
        if (this.privateKey) {
          console.log(`\n🎯 Profit threshold met! Executing arbitrage...`);
          await this.executeArbitrage(opportunity);
        } else {
          console.log(
            `\n⚠️  Profitable opportunity found but no private key provided for trading`
          );
          console.log(
            `   Add private key to constructor to enable automatic trading`
          );
        }
      } else {
        console.log(
          `\n💤 Profit ${opportunity.profitPercentage.toFixed(
            2
          )}% below threshold ${this.minProfitThreshold}%`
        );
      }
    } catch (error: any) {
      console.error(`❌ Scan failed: ${error.message}`);
    }
  }

  async startEventListening(): Promise<void> {
    console.log(`\n🚀 STARTING EVENT-DRIVEN ARBITRAGE BOT`);
    console.log("=".repeat(60));
    console.log(`💰 Minimum profit threshold: ${this.minProfitThreshold}%`);
    console.log(
      `🎯 Trade amount: ${ethers.utils.formatUnits(
        this.tradeAmount,
        18
      )} tokens`
    );
    console.log(
      `${this.privateKey ? "✅" : "❌"} Trading ${
        this.privateKey ? "ENABLED" : "DISABLED"
      }`
    );
    console.log(`⏱️  Processing cooldown: ${this.processingCooldown}ms`);

    // Setup event listeners
    this.setupEventListeners();

    console.log(`\n🎧 Bot is now listening for swap events...`);
    console.log(`🔄 Arbitrage opportunities will be checked when swaps occur`);
    console.log(`📊 This is much more efficient than polling!`);

    // Perform initial scan
    console.log(`\n🔍 Performing initial arbitrage scan...`);
    await this.scanAndExecute();

    // Keep the process alive
    console.log(`\n✅ Event listeners active. Bot is running...`);
    console.log(`Press Ctrl+C to stop the bot`);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log(`\n\n🛑 Shutting down bot...`);
      this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log(`\n\n🛑 Shutting down bot...`);
      this.cleanup();
      process.exit(0);
    });

    // Keep the process running
    return new Promise(() => {});
  }

  private cleanup(): void {
    console.log(`🧹 Cleaning up event listeners...`);

    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      contracts.forEach((contract) => {
        contract.removeAllListeners();
      });
    }

    console.log(`✅ Cleanup complete`);
  }

  // Utility methods
  setMinProfitThreshold(percentage: number): void {
    this.minProfitThreshold = percentage;
  }

  // // Volume configuration methods
  // setTargetVolume(amount: number): void {
  //   console.log(`📊 Target volume updated to $${amount}`);
  // }

  // getVolumeStatus(): object {
  //   return {
  //     targetVolume: VOLUME_CONFIG.targetVolume,
  //     networkVolumes: Array.from(this.networkVolumes.entries()),
  //     rebalanceInProgress: Array.from(this.rebalanceInProgress.entries()),
  //     lastVolumeReset: this.lastVolumeReset,
  //   };
  // }

  // async manualVolumeCheck(): Promise<void> {
  //   console.log(`\n🔧 MANUAL VOLUME CHECK TRIGGERED`);
  //   for (const networkKey of this.networks.keys()) {
  //     await this.checkAndRebalanceVolume(networkKey);
  //   }
  // }

  setTradeAmount(amount: string): void {
    this.tradeAmount = amount;
  }

  setProcessingCooldown(milliseconds: number): void {
    this.processingCooldown = milliseconds;
  }

  // Get current status
  getStatus(): object {
    return {
      isGloballyProcessing: this.isGloballyProcessing,
      lastProcessedTime: this.lastProcessedTime,
      minProfitThreshold: this.minProfitThreshold,
      tradeAmount: ethers.utils.formatUnits(this.tradeAmount, 18),
      processingCooldown: this.processingCooldown,
      tradingEnabled: !!this.privateKey,
      networksConfigured: Array.from(this.networks.keys()),
      poolsListening: Array.from(this.poolContracts.entries()).map(
        ([network, contracts]) => ({
          network,
          poolCount: contracts.length,
          pools: contracts.map((c) => c.address),
        })
      ),
      eventQueueSize: this.eventQueue.length,
      consecutiveErrors: this.consecutiveErrors,
      currentArbitrages: this.currentArbitrages.size,
      // Volume
      // volumeTracking: {
      //   targetVolume: VOLUME_CONFIG.targetVolume,
      //   currentVolumes: Array.from(this.networkVolumes.entries()).map(
      //     ([network, volume]) => ({
      //       network,
      //       volume: volume.toFixed(2),
      //       percentage: ((volume / VOLUME_CONFIG.targetVolume) * 100).toFixed(
      //         1
      //       ),
      //     })
      //   ),
      //   lastVolumeReset: new Date(this.lastVolumeReset).toLocaleString(),
      //   rebalanceInProgress: Array.from(this.rebalanceInProgress.entries()),
      // },
    };
  }

  // Manual trigger for testing
  async manualScan(): Promise<void> {
    console.log(`\n🔧 MANUAL ARBITRAGE SCAN TRIGGERED`);
    await this.scanAndExecute();
  }
}

// Export the enhanced bot
export { RobustArbitrageBot };

// Main execution
async function main(): Promise<void> {
  const privateKey =
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const bot = new RobustArbitrageBot(privateKey);

  // Configure bot settings
  bot.setMinProfitThreshold(0.2); // 0.2% minimum profit
  bot.setTradeAmount("1000000000000000000"); // 1 token
  bot.setProcessingCooldown(2000); // 2 second cooldown between processing

  // console.log(
  //   `💹 Volume rebalancer: $${VOLUME_CONFIG.targetVolume} target per network`
  // );
  // console.log(
  //   `⏱️ Volume check interval: ${VOLUME_CONFIG.checkInterval / 1000}s`
  // );
  console.log(`✅ Event-Driven Arbitrage Bot initialized`);
  console.log(`🌐 Networks: Ethereum, Arbitrum`);
  console.log(`💎 Tokens: SEED/WETH pairs`);
  console.log(`📡 Price source: CoinGecko API`);
  console.log(`🎧 Event-driven: Listens to actual swap events`);

  // Start the event-driven bot
  await bot.startEventListening();
}

// Alternative execution for testing without events
async function testScan(): Promise<void> {
  const bot = new RobustArbitrageBot(
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  );

  bot.setMinProfitThreshold(0.1);
  bot.setTradeAmount("1000000000000000000"); // 1 token
  bot.setProcessingCooldown(1000);

  console.log(`🧪 Testing arbitrage scan without trading...`);
  await bot.manualScan();

  console.log(`\n📊 Bot Status:`);
  console.log(JSON.stringify(bot.getStatus(), null, 2));
}

if (require.main === module) {
  main().catch(console.error);
  // testScan().catch(console.error);
}
