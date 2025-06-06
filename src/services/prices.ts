import axios from "axios";
import { logger } from "../utils/logger";

export interface PriceData {
  ethereum: number;
  usd: number;
}

export class PriceService {
  private static instance: PriceService;
  private lastRequest: number = 0;
  private readonly RATE_LIMIT = 10000; // 10 seconds

  private readonly API_CONFIG = {
    url: "https://api.coingecko.com/api/v3/simple/price",
    apiKeys: [
      "CG-cP4n2gwFZ4ZP9RkZtYdbkpKT",
      "CG-6apJRLv8dFadNwouYfK2GEX9",
      "CG-MhGhY1U2pzh5XzifFNwvPmna",
    ],
    currentKeyIndex: 0,
  };

  private constructor() {}

  static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance = new PriceService();
    }
    return PriceService.instance;
  }

  private async rotateApiKey(): Promise<string> {
    const currentKey = this.API_CONFIG.apiKeys[this.API_CONFIG.currentKeyIndex];
    this.API_CONFIG.currentKeyIndex =
      (this.API_CONFIG.currentKeyIndex + 1) % this.API_CONFIG.apiKeys.length;
    return currentKey;
  }

  async getPrices(): Promise<{ ethereum: PriceData; seed?: PriceData }> {
    const now = Date.now();
    if (now - this.lastRequest < this.RATE_LIMIT) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.RATE_LIMIT - (now - this.lastRequest))
      );
    }

    const apiKey = await this.rotateApiKey();

    try {
      const response = await axios.get(this.API_CONFIG.url, {
        headers: {
          "x-cg-demo-api-key": apiKey,
        },
        params: {
          ids: "ethereum,seed-token",
          vs_currencies: "usd",
        },
        timeout: 10000,
      });

      this.lastRequest = Date.now();

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
      logger.error(`CoinGecko API error: ${error.message}`);
      throw new Error("Failed to fetch prices");
    }
  }
}
