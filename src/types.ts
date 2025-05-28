import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";

export interface NetworkConfig {
  chainId: number;
  name: string;
  gasLimit: number;
}

export interface TokenConfig {
  address: string;
  decimals: number;
  symbol: string;
}

export interface PoolConfig {
  address: string;
  token0: string;
  token1: string;
  feeTier: number;
}

export interface PoolInfo {
  fee: number;
  token0IsSeed: boolean;
  token0: string;
  token1: string;
}

export interface TradingConfig {
  defaultTradeAmount: string;
  minProfitThreshold: string;
  maxSlippage: string;
  autoTradeEnabled: boolean;
}

export interface Config {
  networks: Record<string, NetworkConfig>;
  tokens: Record<string, Record<string, TokenConfig>>;
  pools: Record<string, PoolConfig[]>;
  trading: TradingConfig;
}

export interface NetworkRuntime {
  config: NetworkConfig;
  provider: ethers.providers.JsonRpcProvider;
  quoter: ethers.Contract;
  tokens: Record<string, Token>;
}

export interface SwapEvent {
  poolAddress: string;
  network: string;
  sender: string;
  recipient: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  blockNumber: number;
  transactionHash: string;
}

export interface PoolState {
  address: string;
  network: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  fee: number;
  token0: string;
  token1: string;
  lastUpdated: number;
}

export interface ArbitrageOpportunity {
  buyNetwork: string;
  sellNetwork: string;
  buyPrice: string;
  sellPrice: string;
  priceDifference: string;
  profitEstimate: string;
  gasEstimate: number;
  timestamp: number;
}
