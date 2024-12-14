const { ethers } = require("hardhat");

const { checkContractDeployed } = require("./utils");

async function main() {
  console.log("Deploying GameRewards contract...");

  // Get the contract factory
  const GameRewards = await ethers.getContractFactory("GameRewards");
  let gameTokenAddress;
  let adminAddress;
  let batchAddress;
  // Get the game token address and admin address from environment variables
  if (network.name == "amoy") {
    gameTokenAddress = "0x17fF13862c5665dE5676cab1db0927B4C97eebc1";
    adminAddress = "0x85831486902abc905E8a39dCf9CADF7286a84900";
    batchAddress = "0x85831486902abc905E8a39dCf9CADF7286a84900";
  } else {
    gameTokenAddress = "0x14e5386f47466a463f85d151653e1736c0c50fc3";
    adminAddress = "0x0cEc288905316197bA3BBf2F19D94286d684fe43";
    batchAddress = "0xb8Dc88Adb664a4A398799fE7bDaF79871771B293";
  }

  // Deploy the contract
  const gameRewards = await GameRewards.deploy(gameTokenAddress, adminAddress, batchAddress);

  console.log("GameRewards deployed to:", await gameRewards.getAddress());
  console.log("Game token address:", gameTokenAddress);
  console.log("Admin address:", adminAddress);

  // Wait for a few block confirmations
  console.log("Waiting for block confirmations...");

  checkContractDeployed(await gameRewards.getAddress());

  await new Promise(resolve => setTimeout(resolve, 10000));
  
  console.log("Deployment completed!");

  // Verify the contract on the block explorer if not on localhost
  const networkName = hre.network.name;
  if (networkName !== "localhost" && networkName !== "hardhat") {
    console.log("Verifying contract on block explorer...");
    try {
      await hre.run("verify:verify", {
        address: await gameRewards.getAddress(),
        constructorArguments: [gameTokenAddress, adminAddress, batchAddress],
      });
      console.log("Contract verified successfully");
    } catch (error) {
      console.log("Error verifying contract:", error.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
