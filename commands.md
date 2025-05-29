cast send --rpc-url http://localhost:8545 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a --value 10ether 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 "deposit()"

cast send --rpc-url http://localhost:8546 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a --value 10ether 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 "deposit()"

# This might work if SEED token supports it

cast rpc --rpc-url http://localhost:8545 anvil_setStorageAt \
 0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED \
 $(cast keccak256 "$(cast abi-encode 'f(address,uint256)' 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0)") \
 0x0000000000000000000000000000000000000000000000056bc75e2d630eb000

# First approve WETH spending (using Uniswap V3 router on Arbitrum)

cast send --rpc-url http://localhost:8546 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
 "approve(address,uint256)" \
 0xE592427A0AEce92De3Edee1F18E0157C05861564 \
 5000000000000000000 # 5 WETH

# Swap WETH for SEED using Uniswap V3 (you'll need to adjust parameters)

cast send --rpc-url http://localhost:8546 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
 0xE592427A0AEce92De3Edee1F18E0157C05861564 \
 "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))" \
 "(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08,3000,0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,$(($(date +%s) + 1800)),1000000000000000000,0,0)"

# First approve WETH spending on Uniswap router

cast send --rpc-url http://localhost:8545 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
 "approve(address,uint256)" \
 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D \
 10000000000000000000 # 10 WETH

# Swap WETH for SEED on Uniswap

cast send --rpc-url http://localhost:8545 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D \
 "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" \
 1000000000000000000 \
 0 \
 "[0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED]" \
 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
 $(($(date +%s) + 1800))

# Check all balances on Ethereum

echo "=== ETHEREUM BALANCES ==="
cast balance --rpc-url http://localhost:8545 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
cast call --rpc-url http://localhost:8545 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 "balanceOf(address)(uint256)" 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
cast call --rpc-url http://localhost:8545 0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED "balanceOf(address)(uint256)" 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

echo "=== ARBITRUM BALANCES ==="  
cast balance --rpc-url http://localhost:8546 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
cast call --rpc-url http://localhost:8546 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 "balanceOf(address)(uint256)" 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC  
cast call --rpc-url http://localhost:8546 0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08 "balanceOf(address)(uint256)" 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
