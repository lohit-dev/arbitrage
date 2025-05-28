import { ethers } from "ethers";

// This script will execute a swap directly targeting the pool your bot is monitoring
async function main() {
  try {
    // Connect to your Arbitrum fork
    const provider = new ethers.providers.JsonRpcProvider(
      "http://localhost:8545"
    );

    // Use the test account from your memory
    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const wallet = new ethers.Wallet(privateKey, provider);
    const walletAddress = await wallet.getAddress();

    console.log(`Using wallet address: ${walletAddress}`);
    const balance = await provider.getBalance(walletAddress);
    console.log(`Wallet ETH balance: ${ethers.utils.formatEther(balance)} ETH`);

    // WETH contract on Arbitrum
    const wethAddress = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const wethContract = new ethers.Contract(
      wethAddress,
      [
        "function deposit() external payable",
        "function balanceOf(address) external view returns (uint256)",
        "function approve(address, uint256) external returns (bool)",
      ],
      wallet
    );

    // Wrap some ETH to WETH
    const wrapAmount = ethers.utils.parseEther("1");
    console.log(
      `Wrapping ${ethers.utils.formatEther(wrapAmount)} ETH to WETH...`
    );
    const wrapTx = await wethContract.deposit({ value: wrapAmount });
    await wrapTx.wait();
    console.log("ETH wrapped to WETH successfully");

    // Check WETH balance
    const wethBalance = await wethContract.balanceOf(walletAddress);
    console.log(`WETH balance: ${ethers.utils.formatEther(wethBalance)} WETH`);

    // Uniswap V3 Router
    const routerAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

    // Approve the router to spend WETH
    console.log("Approving Uniswap V3 Router to spend WETH...");
    const approveAmount = ethers.utils.parseEther("0.1");
    const approveTx = await wethContract.approve(routerAddress, approveAmount);
    await approveTx.wait();
    console.log("Approval successful");

    // SEED token on Arbitrum
    const seedTokenAddress = "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08";

    // Set up the router contract
    const routerABI = [
      "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)",
    ];

    const router = new ethers.Contract(routerAddress, routerABI, wallet);

    // Prepare swap parameters
    const amountIn = ethers.utils.parseEther("0.1");
    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    console.log(`Executing swap: 0.1 WETH -> SEED on Arbitrum fork...`);

    // Execute the swap with a manual gas limit
    const tx = await router.exactInputSingle(
      [
        wethAddress, // tokenIn
        seedTokenAddress, // tokenOut
        3000, // fee (0.3%)
        walletAddress, // recipient
        deadline, // deadline
        amountIn, // amountIn
        0, // amountOutMinimum
        0, // sqrtPriceLimitX96
      ],
      { gasLimit: 500000 }
    );

    console.log(`Swap transaction sent: ${tx.hash}`);

    // Wait for the transaction to be mined
    console.log("Waiting for transaction confirmation...");
    const receipt = await tx.wait();
    console.log(`✅ Swap successful! Transaction hash: ${receipt.hash}`);
    console.log(`Gas used: ${receipt.gasUsed.toString()}`);

    // Now manually check if the event was emitted on the pool
    const poolAddress = "0xf9f588394ec5c3b05511368ce016de5fd3812446"; // Your monitored pool
    const poolABI = [
      "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
    ];

    const poolContract = new ethers.Contract(poolAddress, poolABI, provider);

    // Get the transaction receipt and check for the Swap event
    const swapFilter = poolContract.filters.Swap();
    console.log("Checking for Swap events in the transaction...");

    // Look for events in the last few blocks
    const currentBlock = await provider.getBlockNumber();
    const events = await poolContract.queryFilter(
      swapFilter,
      currentBlock - 10,
      currentBlock
    );

    if (events.length > 0) {
      console.log(`Found ${events.length} Swap events:`);
      events.forEach((event, i) => {
        console.log(`Event ${i + 1}:`);
        console.log(`  Transaction Hash: ${event.transactionHash}`);
        console.log(`  Block Number: ${event.blockNumber}`);
        console.log(`  Event Arguments:`, event.args);
      });
      console.log(
        "\nYour bot should be detecting these events. If not, there might be an issue with the event subscription."
      );
    } else {
      console.log(
        "No Swap events found in recent blocks. This suggests the swap might not have gone through the pool your bot is monitoring."
      );
    }
  } catch (error) {
    console.error("Error executing swap:", error);
  }
}

main().catch(console.error);
