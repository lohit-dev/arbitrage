import { ethers } from "ethers";

export function formatPrice(sqrtPriceX96: string): string {
  try {
    const sqrtPrice = parseFloat(sqrtPriceX96);
    const price = Math.pow(sqrtPrice / Math.pow(2, 96), 2);
    return price.toFixed(8);
  } catch (error) {
    return "0.00000000";
  }
}

export function formatAmount(amount: string, decimals: number = 18): string {
  return ethers.utils.formatUnits(amount, decimals);
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(4)}%`;
}

export function formatCurrency(amount: string, symbol: string = "ETH"): string {
  const formatted = parseFloat(amount).toFixed(6);
  return `${formatted} ${symbol}`;
}
