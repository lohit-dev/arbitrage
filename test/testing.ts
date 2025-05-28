import { ethers } from "ethers";
import { expect } from "chai";
import { describe, it } from "node:test";
import { ArbitrageBot } from "../src";
import { logger } from "../src/utils/logger";

describe("Trigger Swap Event", function () {
  it("performs a Uniswap v3 swap and verifies event capture", async function () {
    // 1. Set up the swap on Arbitrum fork
    const provider = new ethers.providers.JsonRpcProvider(
      "http://localhost:8545"
    );

    // Using the test account from your memory
    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const wallet = new ethers.Wallet(privateKey, provider);

    // Log the wallet address we're using
    const walletAddress = await wallet.getAddress();
    console.log(`Using wallet address: ${walletAddress}`);

    // Check wallet balance
    const balance = await provider.getBalance(walletAddress);
    console.log(`Wallet ETH balance: ${ethers.utils.formatEther(balance)} ETH`);

    // 2. Create a WETH contract to wrap some ETH first
    const wethAddress = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // Arbitrum WETH
    const wethContract = new ethers.Contract(
      wethAddress,
      [
        "function deposit() external payable",
        "function balanceOf(address) external view returns (uint256)",
        "function approve(address, uint256) external returns (bool)",
      ],
      wallet
    );

    // 3. Wrap some ETH to WETH
    const wrapAmount = ethers.utils.parseEther("1");
    console.log(
      `Wrapping ${ethers.utils.formatEther(wrapAmount)} ETH to WETH...`
    );
    const wrapTx = await wethContract.deposit({ value: wrapAmount });
    await wrapTx.wait();

    // Check WETH balance
    const wethBalance = await wethContract.balanceOf(walletAddress);
    console.log(
      `WETH balance after wrapping: ${ethers.utils.formatEther(
        wethBalance
      )} WETH`
    );

    // 4. Approve the router to spend our WETH
    const uniswapV3RouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
    console.log(`Approving Uniswap V3 Router to spend WETH...`);
    const approveTx = await wethContract.approve(
      uniswapV3RouterAddress,
      wethBalance
    );
    await approveTx.wait();

    // 5. Set up the Uniswap V3 router
    const router = new ethers.Contract(
      uniswapV3RouterAddress,
      [
        "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256)",
      ],
      wallet
    );

    // 6. Prepare swap parameters
    const amountIn = ethers.utils.parseEther("0.1"); // Swap 0.1 WETH
    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    // SEED token address on Arbitrum from your config
    const seedTokenAddress = "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08";

    console.log(`Executing swap: 0.1 WETH -> SEED on Arbitrum fork...`);

    // 7. Start the arbitrage bot in a separate process to listen for events
    console.log(`Starting arbitrage bot to listen for swap events...`);
    const bot = new ArbitrageBot();

    // Set up a flag to track if we received the event
    let eventReceived = false;

    // Override the event callback in the bot
    bot["eventListenerService"].setSwapEventCallback((swapEvent) => {
      console.log(
        `✅ SWAP EVENT CAPTURED:`,
        JSON.stringify(swapEvent, null, 2)
      );
      eventReceived = true;
    });

    // Start the bot
    await bot.start();

    // 8. Execute the swap
    try {
      const tx = await router.exactInputSingle({
        tokenIn: wethAddress, // WETH
        tokenOut: seedTokenAddress, // SEED
        fee: 3000, // 0.3%
        recipient: walletAddress,
        deadline,
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      });

      console.log(`Swap transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();
      expect(receipt?.hash).to.exist;
      console.log("✅ Swap Tx Hash:", receipt.hash);

      // 9. Wait for the event to be captured (up to 10 seconds)
      console.log(`Waiting for the swap event to be captured...`);
      let attempts = 0;
      while (!eventReceived && attempts < 10) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
        console.log(`Waiting... (${attempts}/10)`);
      }

      if (eventReceived) {
        console.log(
          `✅ SUCCESS: Swap event was successfully captured by the bot!`
        );
      } else {
        console.log(
          `❌ FAILED: Swap event was not captured within the timeout period.`
        );
      }
    } catch (error) {
      console.error("Error executing swap:", error);
    } finally {
      // 10. Stop the bot
      await bot.stop();
    }
  });
});
