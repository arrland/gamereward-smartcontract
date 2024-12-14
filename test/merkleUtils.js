const { MerkleTree: MerkleTreeJS } = require('merkletreejs');
const { ethers } = require('ethers');
const keccak256 = require('keccak256');

function generateMerkleTree(entries) {
  const leaves = entries.map(entry => 
      ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [ethers.getAddress(entry.address), entry.amount]
      )
  );

  const tree = new MerkleTreeJS(leaves, keccak256, { sortPairs: true });
  
  const root = tree.getHexRoot();

  const proofs = entries.reduce((acc, entry, index) => {
    const normalizedAddress = ethers.getAddress(entry.address);
    acc[normalizedAddress] = tree.getHexProof(leaves[index]); 
    return acc;
  }, {});

  return { tree, root, proofs };
}

module.exports = {
  generateMerkleTree
};
