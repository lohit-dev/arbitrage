import { ethers } from "ethers";
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
import config from "../config.json";
import { logger } from "../src/utils/logger";

// TypeScript interfaces
interface TokenConfig {
  address: string;
  decimals: number;
  symbol: string;
}

interface PoolConfig {
  address: string;
  token0: string;
  token1: string;
}

interface NetworkTokens {
  [key: string]: TokenConfig;
}

interface NetworkConfig {
  chainId: number;
  name: string;
  gasLimit: number;
}

// Helper function to format pool data
async function getPoolInfo(
  pool: ethers.Contract,
  poolConfig: PoolConfig,
  tokens: NetworkTokens,
  provider: ethers.providers.JsonRpcProvider
): Promise<void> {
  // Verify pool exists
  const code = await provider.getCode(poolConfig.address);
  if (code === "0x") {
    throw new Error(
      `Pool contract not found at ${poolConfig.address}. Make sure you're forking from a block where this pool exists.`
    );
  }

  // Get pool data
  const [token0, token1, fee, tickSpacing, liquidity, slot0] =
    await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.tickSpacing(),
      pool.liquidity(),
      pool.slot0(),
    ]);

  // Get expected token addresses
  const configToken0Address = tokens[poolConfig.token0].address;
  const configToken1Address = tokens[poolConfig.token1].address;

  logger.info("🔍 POOL INFORMATION:");
  logger.info("=".repeat(50));
  logger.info(`Pool Address: ${poolConfig.address}`);
  logger.info(`Expected Token0 (${poolConfig.token0}): ${configToken0Address}`);
  logger.info(`Actual Token0: ${token0}`);
  logger.info(`Expected Token1 (${poolConfig.token1}): ${configToken1Address}`);
  logger.info(`Actual Token1: ${token1}`);
  logger.info(`Actual Fees: ${(fee / 10000).toFixed(2)}%`);
  logger.info(`Tick Spacing: ${tickSpacing}`);
  logger.info(`Liquidity: ${liquidity.toString()}`);
  logger.info(`Current Tick: ${slot0[1]}`);
  logger.info(`Current Sqrt Price: ${slot0[0].toString()}`);

  // Verify token addresses (handle both possible orders)
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();
  const configToken0Lower = configToken0Address.toLowerCase();
  const configToken1Lower = configToken1Address.toLowerCase();

  let baseToken: string;
  let quoteToken: string;
  let actualToken0Symbol: string;
  let actualToken1Symbol: string;

  // Determine actual token order
  if (token0Lower === configToken0Lower && token1Lower === configToken1Lower) {
    // Config order matches actual order
    baseToken = poolConfig.token0;
    quoteToken = poolConfig.token1;
    actualToken0Symbol = poolConfig.token0;
    actualToken1Symbol = poolConfig.token1;
    logger.info(
      `✅ Token order matches config: ${poolConfig.token0}/${poolConfig.token1}`
    );
  } else if (
    token0Lower === configToken1Lower &&
    token1Lower === configToken0Lower
  ) {
    // Config order is reversed from actual order
    baseToken = poolConfig.token1;
    quoteToken = poolConfig.token0;
    actualToken0Symbol = poolConfig.token1;
    actualToken1Symbol = poolConfig.token0;
    logger.info(
      `⚠️  Token order reversed from config. Actual: ${actualToken0Symbol}/${actualToken1Symbol}`
    );
  } else {
    logger.info(`❌ Token addresses don't match config!`);
    logger.info(
      `   Config expects: ${configToken0Address} / ${configToken1Address}`
    );
    logger.info(`   Pool has: ${token0} / ${token1}`);
    return;
  }

  // Calculate price
  const decimalsBase = tokens[baseToken].decimals;
  const decimalsQuote = tokens[quoteToken].decimals;

  let price = Math.pow(1.0001, Number(slot0[1]));

  // If the actual token0 is not our base token, we need to flip the price
  if (actualToken0Symbol !== baseToken) {
    price = 1 / price;
  }

  // Adjust for decimals
  price = price * Math.pow(10, decimalsQuote - decimalsBase);

  logger.info(
    `Current Price: 1 ${baseToken} = ${price.toFixed(8)} ${quoteToken}`
  );

  // Check liquidity
  if (liquidity.isZero()) {
    logger.warn("⚠️  WARNING: Pool has no liquidity!");
  } else {
    logger.info(
      `✅ Pool has liquidity: ${ethers.utils.formatEther(liquidity)} units`
    );
  }
}

async function testUniswap(): Promise<void> {
  logger.info("🚀 Testing Uniswap WETH/SEED pools on forked networks...\n");

  // Test Ethereum Mainnet Fork
  try {
    logger.info("ETHEREUM ANALYSIS");
    logger.info("=".repeat(50));

    const ethProvider = new ethers.providers.JsonRpcProvider(
      "http://127.0.0.1:8546"
    );

    const blockNumber = await ethProvider.getBlockNumber();
    logger.info(`Connected to Ethereum. Block number: ${blockNumber}`);

    const ethPool = config.pools.ethereum[0] as PoolConfig;
    const ethTokens = config.tokens.ethereum as NetworkTokens;

    // Connect to pool
    const pool = new ethers.Contract(
      ethPool.address,
      IUniswapV3PoolABI,
      ethProvider
    );
    await getPoolInfo(pool, ethPool, ethTokens, ethProvider);
  } catch (error: any) {
    logger.error("❌ Error testing Ethereum fork:", error.message);
    logger.info("\nTo fix this, make sure anvil is running with:");
    logger.info("anvil --fork-url $ETH_RPC_URL --port 8546");
  }

  // Test Arbitrum Fork
  try {
    logger.info("\n\nARBITRUM ANALYSIS");
    logger.info("=".repeat(50));

    const arbProvider = new ethers.providers.JsonRpcProvider(
      "http://127.0.0.1:8545"
    );

    const blockNumber = await arbProvider.getBlockNumber();
    logger.info(`Connected to Arbitrum. Block number: ${blockNumber}`);

    const arbPool = config.pools.arbitrum[0] as PoolConfig;
    const arbTokens = config.tokens.arbitrum as NetworkTokens;

    // Connect to pool
    const pool = new ethers.Contract(
      arbPool.address,
      IUniswapV3PoolABI,
      arbProvider
    );
    await getPoolInfo(pool, arbPool, arbTokens, arbProvider);
  } catch (error: any) {
    logger.error("❌ Error testing Arbitrum fork:", error.message);
    logger.info("\nTo fix this, make sure anvil is running with:");
    logger.info("anvil --fork-url $ARB_RPC_URL --port 8545");
  }
}

testUniswap()
  .then(() => {
    logger.info("\n✅ Pool testing completed!");
    process.exit(0);
  })
  .catch((error) => {
    logger.error("💥 Unexpected error:", error);
    process.exit(1);
  });
