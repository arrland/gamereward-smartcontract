const { ethers } = require("hardhat");
const fs = require('fs');


async function checkContractDeployed(tokenAddress) {
    let code = await ethers.provider.getCode(tokenAddress);
    
    let count = 0;
    while (code === '0x' && count < 36) {
      await new Promise(resolve => setTimeout(resolve, 12000));
      code = await ethers.provider.getCode(tokenAddress);
      count++;
    }
    if (code === '0x') {
      throw new Error("Contract deployment failed. No code at the given address after 180 seconds.");
    }
  }
    
async function verifyContract(address, contractName, constructorArguments) {
    console.log(`Verifying ${contractName} at ${address}...`);
    try {
      await run("verify:verify", {
        address: address,
        constructorArguments: constructorArguments,
      });
      console.log(`${contractName} verified successfully.`);
    } catch (error) {
      console.error(`Failed to verify ${contractName}:`, error);
    }
  }

module.exports = { checkContractDeployed, verifyContract };