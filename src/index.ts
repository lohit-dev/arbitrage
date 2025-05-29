import { ArbitrageBot } from "./bot";
import { logger } from "./utils/logger";

async function main() {
    const bot = new ArbitrageBot();

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
        logger.info("\n👋 Received SIGINT, shutting down gracefully...");
        await bot.stop();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        logger.info("\n👋 Received SIGTERM, shutting down gracefully...");
        await bot.stop();
        process.exit(0);
    });

    // Handle uncaught errors
    process.on("uncaughtException", async (error) => {
        logger.error("💥 Uncaught exception:", {
            message: error.message,
            stack: error.stack,
            details: JSON.stringify(error, Object.getOwnPropertyNames(error)),
        });
        await bot.stop();
        process.exit(1);
    });

    process.on("unhandledRejection", async (reason) => {
        logger.error("💥 Unhandled rejection:", reason);
        await bot.stop();
        process.exit(1);
    });

    try {
        await bot.start();
    } catch (error) {
        logger.error("💥 Failed to start bot:", error);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((error) => {
        logger.error("💥 Unhandled error:", {
            message: error.message,
            stack: error.stack,
            details: JSON.stringify(error, Object.getOwnPropertyNames(error)),
        });
        process.exit(1);
    });
}      
