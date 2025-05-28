import { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  networks: {
    anvil: {
      url: "http://127.0.0.1:8545",
      chainId: 1,
    },
  },
  solidity: "0.8.20",
};

export default config;
