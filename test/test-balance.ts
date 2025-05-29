import { ethers } from "ethers";

const PRIVATE_KEY =
  "7c7f9b2aac806a014c9a26d31d1c21a123aa6e8c130374369b4b5365e7bc347b";

async function checkBalances() {
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  console.log(`Wallet Address: ${wallet.address}`);
  console.log("\n=== BALANCES ===");

  // Sepolia
  try {
    const sepoliaProvider = new ethers.providers.StaticJsonRpcProvider(
      "https://eth-sepolia.public.blastapi.io",
      { chainId: 11155111, name: "Sepolia" }
    );

    const sepoliaBalance = await sepoliaProvider.getBalance(wallet.address);
    console.log(
      `Sepolia Balance: ${ethers.utils.formatEther(sepoliaBalance)} ETH`
    );

    const sepoliaGasPrice = await sepoliaProvider.getGasPrice();
    console.log(
      `Sepolia Gas Price: ${ethers.utils.formatUnits(
        sepoliaGasPrice,
        "gwei"
      )} gwei`
    );

    // Estimate cost for deployment (approximate)
    const estimatedGasCost = sepoliaGasPrice.mul(800000); // gasLimit from config
    console.log(
      `Estimated deployment cost on Sepolia: ${ethers.utils.formatEther(
        estimatedGasCost
      )} ETH`
    );

    if (sepoliaBalance.lt(estimatedGasCost)) {
      console.log("❌ Insufficient funds on Sepolia!");
      console.log(
        `Need at least ${ethers.utils.formatEther(estimatedGasCost)} ETH`
      );
    } else {
      console.log("✅ Sufficient funds on Sepolia");
    }
  } catch (error: any) {
    console.error("Error checking Sepolia balance:", error.message);
  }

  console.log("");

  // Arbitrum Sepolia
  try {
    const arbSepoliaProvider = new ethers.providers.StaticJsonRpcProvider(
      "https://sepolia-rollup.arbitrum.io/rpc",
      { chainId: 421614, name: "Arbitrum Sepolia" }
    );

    const arbBalance = await arbSepoliaProvider.getBalance(wallet.address);
    console.log(
      `Arbitrum Sepolia Balance: ${ethers.utils.formatEther(arbBalance)} ETH`
    );

    const arbGasPrice = await arbSepoliaProvider.getGasPrice();
    console.log(
      `Arbitrum Sepolia Gas Price: ${ethers.utils.formatUnits(
        arbGasPrice,
        "gwei"
      )} gwei`
    );

    const estimatedArbGasCost = arbGasPrice.mul(800000);
    console.log(
      `Estimated deployment cost on Arbitrum Sepolia: ${ethers.utils.formatEther(
        estimatedArbGasCost
      )} ETH`
    );

    if (arbBalance.lt(estimatedArbGasCost)) {
      console.log("❌ Insufficient funds on Arbitrum Sepolia!");
      console.log(
        `Need at least ${ethers.utils.formatEther(estimatedArbGasCost)} ETH`
      );
    } else {
      console.log("✅ Sufficient funds on Arbitrum Sepolia");
    }
  } catch (error: any) {
    console.error("Error checking Arbitrum Sepolia balance:", error.message);
  }

  console.log("\n=== FAUCET LINKS ===");
  console.log("Sepolia Faucets:");
  console.log("- https://sepoliafaucet.com/");
  console.log("- https://www.infura.io/faucet/sepolia");
  console.log("- https://faucet.quicknode.com/ethereum/sepolia");
  console.log("- https://faucets.chain.link/sepolia");

  console.log("\nArbitrum Sepolia Faucets:");
  console.log("- https://faucets.chain.link/arbitrum-sepolia");
  console.log("- Bridge from Sepolia: https://bridge.arbitrum.io/");
}

checkBalances()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
