import { WebhookClient, EmbedBuilder } from "discord.js";
import { ethers } from "ethers";
import { logger } from "../utils/logger";
import { ArbitrageOpportunity } from "../types";

export interface TradeNotification {
  type:
    | "OPPORTUNITY"
    | "TRADE_START"
    | "TRADE_SUCCESS"
    | "TRADE_FAILED"
    | "BALANCE_UPDATE";
  network?: string;
  tokenIn?: string;
  tokenOut?: string;
  amount?: string;
  txHash?: string;
  error?: string;
  opportunity?: ArbitrageOpportunity;
  balances?: {
    [key: string]: {
      amount: string;
      previousAmount?: string;
      usdValue?: string;
      change?: string;
    };
  };
  gasUsed?: string;
  actualProfit?: string;
}

export class DiscordNotificationService {
  private webhook: WebhookClient | null = null;
  private isEnabled: boolean = false;

  constructor(webhookUrl?: string) {
    if (webhookUrl) {
      try {
        this.webhook = new WebhookClient({ url: webhookUrl });
        this.isEnabled = true;
        logger.info("Discord notifications enabled");
      } catch (error) {
        logger.error("Failed to initialize Discord webhook:", error);
        this.isEnabled = false;
      }
    } else {
      logger.warn("Discord webhook URL not provided - notifications disabled");
      this.isEnabled = false;
    }
  }

  async sendTradeNotification(notification: TradeNotification): Promise<void> {
    if (!this.isEnabled || !this.webhook) {
      return;
    }

    try {
      const embed = this.createTradeEmbed(notification);
      await this.webhook.send({ embeds: [embed] });
    } catch (error) {
      logger.error("Failed to send Discord notification:", error);
    }
  }

  private createTradeEmbed(notification: TradeNotification): EmbedBuilder {
    const embed = new EmbedBuilder();
    const timestamp = new Date().toISOString();

    switch (notification.type) {
      case "OPPORTUNITY":
        return this.createOpportunityEmbed(notification, embed, timestamp);

      case "TRADE_START":
        return this.createTradeStartEmbed(notification, embed, timestamp);

      case "TRADE_SUCCESS":
        return this.createTradeSuccessEmbed(notification, embed, timestamp);

      case "TRADE_FAILED":
        return this.createTradeFailedEmbed(notification, embed, timestamp);

      case "BALANCE_UPDATE":
        return this.createBalanceUpdateEmbed(notification, embed, timestamp);

      default:
        return embed
          .setTitle("Unknown Notification")
          .setColor(0x808080)
          .setTimestamp();
    }
  }

  private createOpportunityEmbed(
    notification: TradeNotification,
    embed: EmbedBuilder,
    timestamp: string
  ): EmbedBuilder {
    const opp = notification.opportunity!;
    const profitPercent = (
      (parseFloat(opp.priceDifference) / parseFloat(opp.buyPrice)) *
      100
    ).toFixed(2);

    return embed
      .setTitle("🚨 ARBITRAGE OPPORTUNITY DETECTED")
      .setColor(0xffd700) // Gold
      .addFields(
        {
          name: "💰 Buy Network",
          value: opp.buyNetwork.toUpperCase(),
          inline: true,
        },
        {
          name: "💰 Sell Network",
          value: opp.sellNetwork.toUpperCase(),
          inline: true,
        },
        { name: "📊 Profit %", value: `${profitPercent}%`, inline: true },
        {
          name: "🔢 Buy Price",
          value: `${parseFloat(opp.buyPrice).toFixed(8)} WETH`,
          inline: true,
        },
        {
          name: "🔢 Sell Price",
          value: `${parseFloat(opp.sellPrice).toFixed(8)} WETH`,
          inline: true,
        },
        {
          name: "💎 Est. Profit",
          value: `${parseFloat(opp.profitEstimate).toFixed(6)} WETH`,
          inline: true,
        },
        {
          name: "⛽ Gas Estimate",
          value: `${opp.gasEstimate.toLocaleString()} units`,
          inline: false,
        }
      )
      .setFooter({ text: `Detected at ${timestamp}` })
      .setTimestamp();
  }

  private createTradeStartEmbed(
    notification: TradeNotification,
    embed: EmbedBuilder,
    timestamp: string
  ): EmbedBuilder {
    return embed
      .setTitle("🤖 ARBITRAGE TRADE STARTED")
      .setColor(0x0099ff) // Blue
      .addFields(
        {
          name: "🌐 Network",
          value: notification.network?.toUpperCase() || "Unknown",
          inline: true,
        },
        {
          name: "🔄 Trade",
          value: `${notification.tokenIn} → ${notification.tokenOut}`,
          inline: true,
        },
        {
          name: "💰 Amount",
          value: `${notification.amount} ${notification.tokenIn}`,
          inline: true,
        }
      )
      .setFooter({ text: `Started at ${timestamp}` })
      .setTimestamp();
  }

  private createTradeSuccessEmbed(
    notification: TradeNotification,
    embed: EmbedBuilder,
    timestamp: string
  ): EmbedBuilder {
    const fields = [
      {
        name: "🌐 Network",
        value: notification.network?.toUpperCase() || "Unknown",
        inline: true,
      },
      {
        name: "🔄 Trade",
        value: `${notification.tokenIn} → ${notification.tokenOut}`,
        inline: true,
      },
      {
        name: "💰 Amount",
        value: `${notification.amount} ${notification.tokenIn}`,
        inline: true,
      },
      {
        name: "📋 Transaction",
        value: `[View on Explorer](${this.getExplorerUrl(
          notification.network!,
          notification.txHash!
        )})`,
        inline: false,
      },
    ];

    if (notification.gasUsed) {
      fields.push({
        name: "⛽ Gas Used",
        value: notification.gasUsed,
        inline: true,
      });
    }

    if (notification.actualProfit) {
      fields.push({
        name: "💎 Actual Profit",
        value: `${notification.actualProfit} WETH`,
        inline: true,
      });
    }

    return embed
      .setTitle("✅ TRADE SUCCESSFUL")
      .setColor(0x00ff00) // Green
      .addFields(fields)
      .setFooter({ text: `Completed at ${timestamp}` })
      .setTimestamp();
  }

  private createTradeFailedEmbed(
    notification: TradeNotification,
    embed: EmbedBuilder,
    timestamp: string
  ): EmbedBuilder {
    const fields = [
      {
        name: "🌐 Network",
        value: notification.network?.toUpperCase() || "Unknown",
        inline: true,
      },
      {
        name: "🔄 Trade",
        value: `${notification.tokenIn} → ${notification.tokenOut}`,
        inline: true,
      },
      {
        name: "💰 Amount",
        value: `${notification.amount} ${notification.tokenIn}`,
        inline: true,
      },
      {
        name: "❌ Error",
        value: `\`\`\`${notification.error || "Unknown error"}\`\`\``,
        inline: false,
      },
    ];

    if (notification.txHash) {
      fields.push({
        name: "📋 Transaction",
        value: `[View on Explorer](${this.getExplorerUrl(
          notification.network!,
          notification.txHash!
        )})`,
        inline: false,
      });
    }

    return embed
      .setTitle("❌ TRADE FAILED")
      .setColor(0xff0000) // Red
      .addFields(fields)
      .setFooter({ text: `Failed at ${timestamp}` })
      .setTimestamp();
  }

  private createBalanceUpdateEmbed(
    notification: TradeNotification,
    embed: EmbedBuilder,
    timestamp: string
  ): EmbedBuilder {
    const balances = notification.balances!;
    const fields = Object.entries(balances).map(([token, data]) => {
      let value = `Current: ${data.amount}`;

      if (data.previousAmount) {
        const diff = parseFloat(data.amount) - parseFloat(data.previousAmount);
        const sign = diff >= 0 ? "📈" : "📉";
        value += `\nChange: ${sign} ${diff.toFixed(6)}`;
      }

      if (data.usdValue) {
        value += `\n≈ $${data.usdValue}`;
      }

      return {
        name: `💰 ${token}`,
        value: value,
        inline: true,
      };
    });

    return embed
      .setTitle("📊 WALLET BALANCE UPDATE")
      .setColor(0x9932cc)
      .addFields(fields)
      .setFooter({ text: `Updated at ${timestamp}` })
      .setTimestamp();
  }

  private getExplorerUrl(network: string, txHash: string): string {
    const explorers: { [key: string]: string } = {
      ethereum: "https://etherscan.io/tx/",
      arbitrum: "https://arbiscan.io/tx/",
      polygon: "https://polygonscan.com/tx/",
      bsc: "https://bscscan.com/tx/",
    };

    return `${explorers[network] || explorers.ethereum}${txHash}`;
  }

  // Utility method to send custom messages
  async sendCustomMessage(
    title: string,
    description: string,
    color: number = 0x0099ff
  ): Promise<void> {
    if (!this.isEnabled || !this.webhook) {
      return;
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

      await this.webhook.send({ embeds: [embed] });
    } catch (error) {
      logger.error("Failed to send custom Discord message:", error);
    }
  }

  // Method to send startup notification
  async sendStartupNotification(walletAddress: string): Promise<void> {
    await this.sendCustomMessage(
      "🚀 ARBITRAGE BOT STARTED",
      `Bot is now running and monitoring for opportunities.\n\n**Wallet Address:** \`${walletAddress}\`\n**Status:** Online ✅`,
      0x00ff00
    );
  }

  // Method to send shutdown notification
  async sendShutdownNotification(): Promise<void> {
    await this.sendCustomMessage(
      "🛑 ARBITRAGE BOT STOPPED",
      "Bot has been shut down.",
      0xff0000
    );
  }
}
