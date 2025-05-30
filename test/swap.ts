import { ethers } from "ethers";

async function main() {
  try {
    const provider = new ethers.providers.JsonRpcProvider(
      "http://localhost:8546"
    );

    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const wallet = new ethers.Wallet(privateKey, provider);
    const walletAddress = await wallet.getAddress();

    console.log(`Using wallet address: ${walletAddress}`);
    const balance = await provider.getBalance(walletAddress);
    console.log(`Wallet ETH balance: ${ethers.utils.formatEther(balance)} ETH`);

    const wethAddress = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const wethContract = new ethers.Contract(
      wethAddress,
      [
        "function deposit() external payable",
        "function balanceOf(address) external view returns (uint256)",
        "function approve(address, uint256) external returns (bool)",
        "function transfer(address to, uint256 amount) external returns (bool)",
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

    // The specific pool we want to target
    const poolAddress = "0xf9f588394ec5c3b05511368ce016de5fd3812446"; // Arbitrum WETH/SEED pool
    console.log(`Target pool address: ${poolAddress}`);

    // SEED token on Arbitrum
    const seedTokenAddress = "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08";

    // Let's create a fake swap by directly transferring WETH to the pool
    // This should trigger the pool's internal accounting and emit events
    console.log(`Sending WETH directly to the pool to simulate activity...`);

    // Send a small amount of WETH to the pool
    const transferAmount = ethers.utils.parseEther("0.01");
    const transferTx = await wethContract.transfer(poolAddress, transferAmount);
    await transferTx.wait();
    console.log(
      `✅ WETH transfer successful! Transaction hash: ${transferTx.hash}`
    );

    // Now let's try to use the Uniswap V3 Quoter to get a quote for our swap
    // This will help us verify the pool is working correctly
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Uniswap V3 Quoter
    const quoterABI = [
      "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
    ];

    const quoterContract = new ethers.Contract(
      quoterAddress,
      quoterABI,
      wallet
    );

    console.log(`Getting quote for WETH -> SEED swap...`);
    try {
      // Fee is 3000 (0.3%) for this pool
      const quoteAmount = await quoterContract.callStatic.quoteExactInputSingle(
        wethAddress,
        seedTokenAddress,
        3000,
        ethers.utils.parseEther("0.1"),
        0
      );

      console.log(
        `Quote received: ${ethers.utils.formatEther(
          quoteAmount
        )} SEED for 0.1 WETH`
      );

      // Now let's try to use the Uniswap V3 Router to execute the swap
      // This should target the specific pool we want
      const routerAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router

      // Approve the router to spend our WETH
      console.log(`Approving Uniswap V3 Router to spend WETH...`);
      const approveAmount = ethers.utils.parseEther("0.1");
      const approveTx = await wethContract.approve(
        routerAddress,
        approveAmount
      );
      await approveTx.wait();
      console.log(`Approval successful!`);

      // Set up the router contract
      const routerABI = [
        "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)",
      ];

      const routerContract = new ethers.Contract(
        routerAddress,
        routerABI,
        wallet
      );

      // Execute the swap with a specific fee to target our pool
      console.log(`Executing swap: 0.1 WETH -> SEED with fee 3000 (0.3%)...`);

      const swapTx = await routerContract.exactInputSingle(
        {
          tokenIn: wethAddress,
          tokenOut: seedTokenAddress,
          fee: 3000, // 0.3% - this should route through our target pool
          recipient: walletAddress,
          deadline: Math.floor(Date.now() / 1000) + 600, // 10 minutes
          amountIn: ethers.utils.parseEther("0.1"),
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        },
        {
          gasLimit: 500000, // Set a manual gas limit to avoid estimation issues
        }
      );

      console.log(`Swap transaction sent: ${swapTx.hash}`);

      const receipt = await swapTx.wait();
      console.log(`✅ Swap successful! Transaction hash: ${receipt.hash}`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);
    } catch (quoteError) {
      console.error("Error getting quote:", quoteError);

      // If quote fails, try a simpler approach - just send a transaction to the pool
      console.log("Trying alternative approach to generate pool activity...");

      // Create a minimal transaction to the pool
      const tx = await wallet.sendTransaction({
        to: poolAddress,
        value: ethers.utils.parseEther("0.001"),
        gasLimit: 100000,
      });

      console.log(`Transaction sent: ${tx.hash}`);
      await tx.wait();
      console.log(`✅ Transaction successful!`);
    }

    console.log(
      "\nCheck your arbitrage bot terminal to see if it detected any events!"
    );
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
