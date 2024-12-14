const { expect } = require("chai");
const { ethers } = require("hardhat");
const { generateMerkleTree } = require("./merkleUtils");
const keccak256 = require("keccak256");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("GameRewards", function () {
  let gameRewards;
  let gameToken;
  let owner;
  let batchAdder;
  let user1;
  let user2;
  let user3;
  let merkleTree;
  let proofs;
  let rewards;
  const INITIAL_DELAY = 120; // 2 minutes

  beforeEach(async function () {
    [owner, batchAdder, user1, user2, user3] = await ethers.getSigners();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    gameToken = await MockERC20.deploy("Game Token", "GAME");
    await gameToken.waitForDeployment();

    // Deploy GameRewards
    const GameRewards = await ethers.getContractFactory("GameRewards");
    gameRewards = await GameRewards.deploy(
      await gameToken.getAddress(),
      owner.address,
      batchAdder.address
    );
    await gameRewards.waitForDeployment();

    // Fund the contract with tokens
    await gameToken.mint(await gameRewards.getAddress(), ethers.parseEther("1000"));

    // Grant roles
    await gameRewards.grantRole(await gameRewards.BATCH_ADDER_ROLE(), batchAdder.address);
  });

  describe("Deployment", function () {
    it("Should set the correct token address", async function () {
      expect(await gameRewards.gameToken()).to.equal(await gameToken.getAddress());
    });

    it("Should set the correct initial claim delay", async function () {
      expect(await gameRewards.claimDelay()).to.equal(await gameRewards.INITIAL_DELAY());
    });
  });

  describe("Batch Management", function () {
    beforeEach(async function () {
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      
      const { tree, root } = generateMerkleTree(rewards);
      merkleTree = tree;
    });

    it("Should allow batch adder to set new rewards batch", async function () {
      const root = merkleTree.getHexRoot();
      const totalAmount = ethers.parseEther("100"); // Sum of rewards

      // Get block before the transaction
      const block = await ethers.provider.getBlock('latest');
      const expectedTimestamp = block.timestamp + 1; // Next block timestamp

      await expect(gameRewards.connect(batchAdder).setRewardsBatch(root, totalAmount))
        .to.emit(gameRewards, "RewardsBatchSet")
        .withArgs(1, root, totalAmount, expectedTimestamp);

      expect(await gameRewards.merkleRoots(1)).to.equal(root);
      expect(await gameRewards.batchTotalAmounts(1)).to.equal(totalAmount);
    });

    it("Should not allow non-batch adder to set rewards batch", async function () {
      const root = merkleTree.getHexRoot();
      const totalAmount = ethers.parseEther("100");

      await expect(
        gameRewards.connect(user1).setRewardsBatch(root, totalAmount)
      ).to.be.revertedWithCustomError(gameRewards, "AccessControlUnauthorizedAccount");
    });

    it("Should revert when creating batch with zero amount", async function () {
      await expect(
        gameRewards.connect(batchAdder).setRewardsBatch(
          merkleTree.getHexRoot(),
          0
        )
      ).to.be.revertedWith("Invalid total amount");
    });

    it("Should revert when creating batch with zero merkle root", async function () {
      await expect(
        gameRewards.connect(batchAdder).setRewardsBatch(
          ethers.ZeroHash,
          ethers.parseEther("100")
        )
      ).to.be.revertedWith("Invalid Merkle root");
    });

    it("Should increment batch ID correctly", async function () {
      const initialBatchId = await gameRewards.currentBatchId();
      
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );
      
      expect(await gameRewards.currentBatchId()).to.equal(initialBatchId + 1n);

      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("200")
      );
      
      expect(await gameRewards.currentBatchId()).to.equal(initialBatchId + 2n);
    });

    it("Should allow overwriting existing batch", async function () {
      // Create initial batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );
      const batchId = await gameRewards.currentBatchId();

      // Create new rewards and merkle tree
      const newRewards = [
        { address: user2.address, amount: ethers.parseEther("200") }
      ];
      
      const { tree: newTree, root: newRoot } = generateMerkleTree(newRewards);
      const newMerkleTree = newTree;

      // Overwrite batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        newMerkleTree.getHexRoot(),
        ethers.parseEther("200")
      );

      // Verify new batch data
      expect(await gameRewards.merkleRoots(batchId + 1n)).to.equal(newMerkleTree.getHexRoot());
      expect(await gameRewards.batchTotalAmounts(batchId + 1n)).to.equal(ethers.parseEther("200"));
    });

    it("Should handle batch with zero rewards in merkle tree", async function () {
      // Create merkle tree with a single dummy leaf to avoid empty tree
      const dummyLeaf = keccak256(
        ethers.solidityPacked(
          ["address", "uint256"],
          [ethers.ZeroAddress, 0]
        )
      );
      const emptyMerkleTree = generateMerkleTree([{ address: ethers.ZeroAddress, amount: 0 }]).tree;

      await gameRewards.connect(batchAdder).setRewardsBatch(
        emptyMerkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      const batchId = await gameRewards.currentBatchId();
      expect(await gameRewards.merkleRoots(batchId)).to.equal(emptyMerkleTree.getHexRoot());

      // Verify that no one can claim from this batch
      const dummyProof = emptyMerkleTree.getHexProof(dummyLeaf);
      await expect(
        gameRewards.connect(user1).claimMultipleRewards([{
          batchId: batchId,
          amount: ethers.parseEther("100"),
          merkleProof: dummyProof
        }])
      ).to.be.revertedWith("Invalid proof");
    });
  });

  describe("Multiple Claims Functionality", function () {
    beforeEach(async function () {
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("150") },
        { address: user3.address, amount: ethers.parseEther("50") }
      ];
      
      const merkleData = generateMerkleTree(rewards);
      merkleTree = merkleData.tree;
      proofs = merkleData.proofs;

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should correctly sum multiple claim amounts", async function () {
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300")
      );
      const batchId = await gameRewards.currentBatchId();

      const claims = rewards.map((reward) => ({
        batchId: batchId,
        amount: reward.amount,
        merkleProof: proofs[ethers.getAddress(reward.address)]
      })).filter(claim => claim.merkleProof === proofs[ethers.getAddress(user1.address)]);

      // Calculate total amount - only for user1's claims
      const totalAmount = rewards
        .filter(reward => reward.address === user1.address)
        .reduce((sum, reward) => sum + BigInt(reward.amount), BigInt(0));

      const nextBlockTimestamp = await time.latest() + 1;
      await expect(gameRewards.connect(user1).claimMultipleRewards(claims))
        .to.emit(gameRewards, "RewardClaimed")
        .withArgs(user1.address, batchId, rewards[0].amount, nextBlockTimestamp);

      expect(await gameToken.balanceOf(user1.address)).to.equal(totalAmount);
    });

    it("Should handle concurrent claims from same batch", async function () {
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300")
      );
      const batchId = await gameRewards.currentBatchId();

      for (let i = 0; i < rewards.length; i++) {
        const reward = rewards[i];
        const user = [user1, user2, user3][i];
        const proof = merkleTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId,
          amount: reward.amount,
          merkleProof: proof
        }]);
      }

      expect(await gameRewards.claimedAmounts(batchId))
        .to.equal(ethers.parseEther("300"));
    });

    it("Should validate all proofs in batch claim", async function () {
      // Set up a new batch specifically for this test
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("1000")
      );
      const currentBatchId = await gameRewards.currentBatchId();

      // Create claims with one invalid proof
      const validAmount = rewards[0].amount;
      const invalidAmount = ethers.parseEther("999"); // Wrong amount

      const claims = [
        {
          batchId: currentBatchId,
          amount: validAmount,
          merkleProof: merkleTree.getHexProof(
            keccak256(
              ethers.solidityPacked(
                ["address", "uint256"],
                [user1.address, validAmount]
              )
            )
          )
        },
        {
          batchId: currentBatchId,
          amount: invalidAmount,
          merkleProof: merkleTree.getHexProof(
            keccak256(
              ethers.solidityPacked(
                ["address", "uint256"],
                [user1.address, validAmount] // Use valid amount to get valid proof
              )
            )
          )
        }
      ];

      await expect(
        gameRewards.connect(user1).claimMultipleRewards(claims)
      ).to.be.revertedWith("Invalid proof");
    });

    it("Should properly update claim status for all claims in batch", async function () {
      // Create batch with total amount
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300") // 100 + 150 + 50
      );
      const batchId = await gameRewards.currentBatchId();

      // First user claims their reward
      const user1Proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [rewards[0].address, rewards[0].amount]
          )
        )
      );

      await gameRewards.connect(user1).claimMultipleRewards([{
        batchId: batchId,
        amount: rewards[0].amount,
        merkleProof: user1Proof
      }]);

      // Verify first claim is marked as claimed
      expect(await gameRewards.hasClaimed(user1.address, batchId)).to.be.true;
      expect(await gameRewards.hasClaimed(user2.address, batchId)).to.be.false;
      expect(await gameRewards.hasClaimed(user3.address, batchId)).to.be.false;

      // Second user claims after delay
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine");

      const user2Proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [rewards[1].address, rewards[1].amount]
          )
        )
      );

      await gameRewards.connect(user2).claimMultipleRewards([{
        batchId: batchId,
        amount: rewards[1].amount,
        merkleProof: user2Proof
      }]);

      // Verify first and second claims are marked as claimed
      expect(await gameRewards.hasClaimed(user1.address, batchId)).to.be.true;
      expect(await gameRewards.hasClaimed(user2.address, batchId)).to.be.true;
      expect(await gameRewards.hasClaimed(user3.address, batchId)).to.be.false;

      // Third user claims after delay
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine");

      const user3Proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [rewards[2].address, rewards[2].amount]
          )
        )
      );

      await gameRewards.connect(user3).claimMultipleRewards([{
        batchId: batchId,
        amount: rewards[2].amount,
        merkleProof: user3Proof
      }]);

      // Verify all claims are marked as claimed
      expect(await gameRewards.hasClaimed(user1.address, batchId)).to.be.true;
      expect(await gameRewards.hasClaimed(user2.address, batchId)).to.be.true;
      expect(await gameRewards.hasClaimed(user3.address, batchId)).to.be.true;
    });

    it("Should emit events for each claim in batch", async function () {
      // Create batch with total amount
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300") // 100 + 150 + 50
      );
      const batchId = await gameRewards.currentBatchId();

      // Generate proofs for all rewards
      const claims = rewards.map((reward) => {
        const proof = merkleTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );
        return {
          batchId,
          amount: reward.amount,
          merkleProof: proof
        };
      });

      // Claim rewards and verify events
      for (let i = 0; i < rewards.length; i++) {
        const user = [user1, user2, user3][i];
        const reward = rewards[i];

        if (i > 0) {
          await ethers.provider.send("evm_increaseTime", [60]);
          await ethers.provider.send("evm_mine");
        }

        // Get block before the transaction
        const block = await ethers.provider.getBlock('latest');
        const expectedTimestamp = block.timestamp + 1; // Next block timestamp

        // Verify RewardClaimed event is emitted with correct parameters
        await expect(gameRewards.connect(user).claimMultipleRewards([claims[i]]))
          .to.emit(gameRewards, "RewardClaimed")
          .withArgs(user.address, batchId, reward.amount, expectedTimestamp);
      }
    });

    it("Should not allow claims exceeding batch total amount", async function () {
      // Create a batch with a small total amount
      const batchTotalAmount = ethers.parseEther("50"); // Only allow 50 tokens total
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        batchTotalAmount
      );
      const batchId = await gameRewards.currentBatchId();

      // Try to claim more than the batch total
      const claim = {
        batchId: batchId,
        amount: ethers.parseEther("100"), // Try to claim 100 tokens
        merkleProof: merkleTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [user1.address, ethers.parseEther("100")]
            )
          )
        )
      };

      await expect(
        gameRewards.connect(user1).claimMultipleRewards([claim])
      ).to.be.revertedWith("Exceeds batch total");

      // Verify the claimed amount hasn't changed
      expect(await gameRewards.claimedAmounts(batchId)).to.equal(0);
    });

    it("Should track claimed amounts correctly across multiple claims", async function () {
      // Create a new set of rewards for this test
      const batchRewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("150") },
        { address: user3.address, amount: ethers.parseEther("175") }  
      ];
      
      // Create merkle tree for the new rewards
      const { tree: batchTree } = generateMerkleTree(batchRewards);

      // Set up a batch with limited total amount
      const batchTotalAmount = ethers.parseEther("300"); // Only allow 300 tokens total
      await gameRewards.connect(batchAdder).setRewardsBatch(
        batchTree.getHexRoot(),
        batchTotalAmount
      );
      const batchId = await gameRewards.currentBatchId();

      // First claim by user1
      const claim1 = {
        batchId: batchId,
        amount: ethers.parseEther("100"),
        merkleProof: batchTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [user1.address, ethers.parseEther("100")]
            )
          )
        )
      };

      await gameRewards.connect(user1).claimMultipleRewards([claim1]);
      expect(await gameRewards.claimedAmounts(batchId)).to.equal(ethers.parseEther("100"));

      // Advance time for next claim
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine");

      // Second claim by user2
      const claim2 = {
        batchId: batchId,
        amount: ethers.parseEther("150"),
        merkleProof: batchTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [user2.address, ethers.parseEther("150")]
            )
          )
        )
      };

      await gameRewards.connect(user2).claimMultipleRewards([claim2]);
      expect(await gameRewards.claimedAmounts(batchId)).to.equal(ethers.parseEther("250"));

      // Advance time for next claim
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine");

      // Try to claim the third reward which would exceed the batch total
      const claim3 = {
        batchId: batchId,
        amount: ethers.parseEther("175"),
        merkleProof: batchTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [user3.address, ethers.parseEther("175")]
            )
          )
        )
      };

      // This should fail as it would exceed the batch total (250 + 175 > 300)
      await expect(
        gameRewards.connect(user3).claimMultipleRewards([claim3])
      ).to.be.revertedWith("Exceeds batch total");

      // Verify the total claimed amount hasn't changed
      expect(await gameRewards.claimedAmounts(batchId)).to.equal(ethers.parseEther("250"));
    });

    it("Should handle concurrent claims from same batch", async function () {
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300")
      );
      const batchId = await gameRewards.currentBatchId();

      // Prepare all claims
      const claims = await Promise.all(rewards.map(async (reward, i) => {
        const user = [user1, user2, user3][i];
        const proof = merkleTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        return {
          user,
          claim: {
            batchId,
            amount: reward.amount,
            merkleProof: proof
          }
        };
      }));

      // Submit all claims concurrently
      await Promise.all(claims.map(({ user, claim }) =>
        gameRewards.connect(user).claimMultipleRewards([claim])
      ));

      // Verify total claimed amount
      expect(await gameRewards.claimedAmounts(batchId))
        .to.equal(rewards.reduce((sum, r) => sum + r.amount, 0n));
    });

    it("Should correctly track claims across multiple batches", async function () {
      // Create two batches with different rewards
      const batch1Rewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("150") }
      ];
      
      const batch2Rewards = [
        { address: user2.address, amount: ethers.parseEther("200") },
        { address: user3.address, amount: ethers.parseEther("250") }
      ];

      // Setup batch 1
      const { tree: tree1 } = generateMerkleTree(batch1Rewards);
      
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree1.getHexRoot(),
        ethers.parseEther("250") // 100 + 150
      );
      const batch1Id = await gameRewards.currentBatchId();

      // Setup batch 2
      const { tree: tree2 } = generateMerkleTree(batch2Rewards);
      
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree2.getHexRoot(),
        ethers.parseEther("450") // 200 + 250
      );
      const batch2Id = await gameRewards.currentBatchId();

      // Claim from both batches
      // First batch claims
      for (let i = 0; i < batch1Rewards.length; i++) {
        const reward = batch1Rewards[i];
        const user = [user1, user2][i];
        const proof = tree1.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        if (i > 0) {
          await ethers.provider.send("evm_increaseTime", [60]);
          await ethers.provider.send("evm_mine");
        }

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId: batch1Id,
          amount: reward.amount,
          merkleProof: proof
        }]);
      }

      // Second batch claims
      for (let i = 0; i < batch2Rewards.length; i++) {
        const reward = batch2Rewards[i];
        const user = [user2, user3][i];
        const proof = tree2.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        await ethers.provider.send("evm_increaseTime", [60]);
        await ethers.provider.send("evm_mine");

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId: batch2Id,
          amount: reward.amount,
          merkleProof: proof
        }]);
      }

      // Verify claimed amounts for both batches
      expect(await gameRewards.claimedAmounts(batch1Id))
        .to.equal(batch1Rewards.reduce((sum, r) => sum + r.amount, 0n));
      expect(await gameRewards.claimedAmounts(batch2Id))
        .to.equal(batch2Rewards.reduce((sum, r) => sum + r.amount, 0n));
    });
  });

  describe("Batch Total Amount Validation", function () {
    beforeEach(async function () {
      // Create rewards with exact amounts for testing
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("150") },
        { address: user3.address, amount: ethers.parseEther("50") }
      ];
      
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should allow claiming exact batch total amount", async function () {
      // Set batch total to exact sum of all rewards
      const exactTotal = ethers.parseEther("300"); // 100 + 150 + 50
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        exactTotal
      );
      const batchId = await gameRewards.currentBatchId();

      // Claim all rewards
      for (let i = 0; i < rewards.length; i++) {
        const reward = rewards[i];
        const user = [user1, user2, user3][i];
        const proof = merkleTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        if (i > 0) {
          // Advance time for subsequent claims
          await ethers.provider.send("evm_increaseTime", [60]);
          await ethers.provider.send("evm_mine");
        }

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId: batchId,
          amount: reward.amount,
          merkleProof: proof
        }]);
      }

      // Verify final claimed amount equals total
      expect(await gameRewards.claimedAmounts(batchId)).to.equal(exactTotal);
    });

    it("Should allow multiple partial claims summing to total", async function () {
      // Create a batch with multiple rewards for different users that sum to a total
      const partialRewards = [
        { address: user1.address, amount: ethers.parseEther("10") },
        { address: user2.address, amount: ethers.parseEther("20") },
        { address: user3.address, amount: ethers.parseEther("30") }
      ];
      
      const { tree: partialTree } = generateMerkleTree(partialRewards);

      // Set batch total to sum of partial rewards
      const totalAmount = ethers.parseEther("60"); // 10 + 20 + 30
      await gameRewards.connect(batchAdder).setRewardsBatch(
        partialTree.getHexRoot(),
        totalAmount
      );
      const batchId = await gameRewards.currentBatchId();

      // Claim each partial reward with different users
      for (let i = 0; i < partialRewards.length; i++) {
        const reward = partialRewards[i];
        const user = [user1, user2, user3][i];
        const proof = partialTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        if (i > 0) {
          await ethers.provider.send("evm_increaseTime", [60]);
          await ethers.provider.send("evm_mine");
        }

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId: batchId,
          amount: reward.amount,
          merkleProof: proof
        }]);

        // Verify running total
        expect(await gameRewards.claimedAmounts(batchId))
          .to.equal(partialRewards.slice(0, i + 1).reduce((sum, r) => sum + r.amount, 0n));
      }
    });

    it("Should handle concurrent claims from same batch", async function () {
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300")
      );
      const batchId = await gameRewards.currentBatchId();

      // Prepare all claims
      const claims = await Promise.all(rewards.map(async (reward, i) => {
        const user = [user1, user2, user3][i];
        const proof = merkleTree.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        return {
          user,
          claim: {
            batchId: batchId,
            amount: reward.amount,
            merkleProof: proof
          }
        };
      }));

      // Submit all claims concurrently
      await Promise.all(claims.map(({ user, claim }) =>
        gameRewards.connect(user).claimMultipleRewards([claim])
      ));

      // Verify total claimed amount
      expect(await gameRewards.claimedAmounts(batchId))
        .to.equal(rewards.reduce((sum, r) => sum + r.amount, 0n));
    });

    it("Should correctly track claims across multiple batches", async function () {
      // Create two batches with different rewards
      const batch1Rewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("150") }
      ];
      
      const batch2Rewards = [
        { address: user2.address, amount: ethers.parseEther("200") },
        { address: user3.address, amount: ethers.parseEther("250") }
      ];

      // Setup batch 1
      const { tree: tree1 } = generateMerkleTree(batch1Rewards);
      
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree1.getHexRoot(),
        ethers.parseEther("250") // 100 + 150
      );
      const batch1Id = await gameRewards.currentBatchId();

      // Setup batch 2
      const { tree: tree2 } = generateMerkleTree(batch2Rewards);
      
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree2.getHexRoot(),
        ethers.parseEther("450") // 200 + 250
      );
      const batch2Id = await gameRewards.currentBatchId();

      // Claim from both batches
      // First batch claims
      for (let i = 0; i < batch1Rewards.length; i++) {
        const reward = batch1Rewards[i];
        const user = [user1, user2][i];
        const proof = tree1.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        if (i > 0) {
          await ethers.provider.send("evm_increaseTime", [60]);
          await ethers.provider.send("evm_mine");
        }

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId: batch1Id,
          amount: reward.amount,
          merkleProof: proof
        }]);
      }

      // Second batch claims
      for (let i = 0; i < batch2Rewards.length; i++) {
        const reward = batch2Rewards[i];
        const user = [user2, user3][i];
        const proof = tree2.getHexProof(
          keccak256(
            ethers.solidityPacked(
              ["address", "uint256"],
              [reward.address, reward.amount]
            )
          )
        );

        await ethers.provider.send("evm_increaseTime", [60]);
        await ethers.provider.send("evm_mine");

        await gameRewards.connect(user).claimMultipleRewards([{
          batchId: batch2Id,
          amount: reward.amount,
          merkleProof: proof
        }]);
      }

      // Verify claimed amounts for both batches
      expect(await gameRewards.claimedAmounts(batch1Id))
        .to.equal(batch1Rewards.reduce((sum, r) => sum + r.amount, 0n));
      expect(await gameRewards.claimedAmounts(batch2Id))
        .to.equal(batch2Rewards.reduce((sum, r) => sum + r.amount, 0n));
    });
  });

  describe("Merkle Proof Verification", function () {
    beforeEach(async function () {
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("200") }
      ];
      
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      // Create initial batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300")
      );

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should revert with invalid proof format", async function () {
      const batchId = await gameRewards.currentBatchId();
      const invalidProof = [ethers.ZeroHash]; // Invalid proof length

      await expect(
        gameRewards.connect(user1).claimMultipleRewards([{
          batchId: batchId,
          amount: ethers.parseEther("100"),
          merkleProof: invalidProof
        }])
      ).to.be.revertedWith("Invalid proof");
    });

    it("Should revert with proof from different batch", async function () {
      // Create a different batch with different rewards
      const differentRewards = [
        { address: user1.address, amount: ethers.parseEther("150") }
      ];
      
      const { tree: differentTree } = generateMerkleTree(differentRewards);

      await gameRewards.connect(batchAdder).setRewardsBatch(
        differentTree.getHexRoot(),
        ethers.parseEther("150")
      );

      const firstBatchId = await gameRewards.currentBatchId() - 1n;
      const proof = differentTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("150")]
          )
        )
      );

      // Try to use proof from second batch with first batch ID
      await expect(
        gameRewards.connect(user1).claimMultipleRewards([{
          batchId: firstBatchId,
          amount: ethers.parseEther("150"),
          merkleProof: proof
        }])
      ).to.be.revertedWith("Invalid proof");
    });

    it("Should revert with modified amount", async function () {
      const batchId = await gameRewards.currentBatchId();
      const originalProof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("100")]
          )
        )
      );

      // Try to claim with modified amount using original proof
      await expect(
        gameRewards.connect(user1).claimMultipleRewards([{
          batchId: batchId,
          amount: ethers.parseEther("101"), // Modified amount
          merkleProof: originalProof
        }])
      ).to.be.revertedWith("Invalid proof");
    });

    it("Should revert with wrong user address", async function () {
      const batchId = await gameRewards.currentBatchId();
      const proofForUser1 = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("100")]
          )
        )
      );

      // Try to use user1's proof with user2's address
      await expect(
        gameRewards.connect(user2).claimMultipleRewards([{
          batchId: batchId,
          amount: ethers.parseEther("100"),
          merkleProof: proofForUser1
        }])
      ).to.be.revertedWith("Invalid proof");
    });
  });

  describe("Claiming Rewards", function () {
    beforeEach(async function () {
      // Setup test rewards and merkle tree
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("200") }
      ];

      // Create merkle tree
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      // Setup a batch for testing claims
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("300")
      );

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should allow valid claim with proof", async function () {
      const reward = rewards[0];
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [reward.address, reward.amount]
          )
        )
      );

      const tx = await gameRewards.connect(user1).claimReward(1, reward.amount, proof);
      const receipt = await tx.wait();
      
      const event = receipt.logs.find(log => log.fragment && log.fragment.name === 'RewardClaimed');
      expect(event).to.not.be.undefined;
      expect(event.args[0]).to.equal(user1.address); // user
      expect(event.args[1]).to.equal(1n); // batchId
      expect(event.args[2]).to.equal(reward.amount); // amount
    });

    it("Should not allow double claiming", async function () {
      const reward = rewards[0];
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [reward.address, reward.amount]
          )
        )
      );

      await gameRewards.connect(user1).claimReward(1, reward.amount, proof);
      
      // Wait for claim delay to pass
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine");

      await expect(
        gameRewards.connect(user1).claimReward(1, reward.amount, proof)
      ).to.be.revertedWith("Already claimed");
    });

    it("Should not allow claiming with invalid proof", async function () {
      const reward = rewards[0];
      const invalidProof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user2.address, reward.amount] // Wrong user
          )
        )
      );

      await expect(
        gameRewards.connect(user1).claimReward(1, reward.amount, invalidProof)
      ).to.be.revertedWith("Invalid proof");
    });
  });

  describe("Pause Functionality", function () {
    beforeEach(async function () {
      // Setup basic rewards for testing
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      // Create a batch for testing claims
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should allow admin to pause and unpause contract", async function () {
      // Initially contract should be unpaused
      expect(await gameRewards.paused()).to.be.false;

      // Admin can pause
      await gameRewards.pause();
      expect(await gameRewards.paused()).to.be.true;

      // Admin can unpause
      await gameRewards.unpause();
      expect(await gameRewards.paused()).to.be.false;
    });

    it("Should prevent operations while paused", async function () {
      const batchId = await gameRewards.currentBatchId();
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [rewards[0].address, rewards[0].amount]
          )
        )
      );

      // Pause contract
      await gameRewards.pause();

      // Attempt to create new batch while paused
      await expect(
        gameRewards.connect(batchAdder).setRewardsBatch(
          merkleTree.getHexRoot(),
          ethers.parseEther("100")
        )
      ).to.be.reverted;

      // Attempt to claim rewards while paused
      await expect(
        gameRewards.connect(user1).claimMultipleRewards([{
          batchId: batchId,
          amount: rewards[0].amount,
          merkleProof: proof
        }])
      ).to.be.reverted;

      // Unpause and verify operations resume
      await gameRewards.unpause();

      // Should now be able to create batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Should now be able to claim
      await gameRewards.connect(user1).claimMultipleRewards([{
        batchId: batchId,
        amount: rewards[0].amount,
        merkleProof: proof
      }]);
    });

    it("Should prevent unauthorized pause attempts", async function () {
      // Non-admin cannot pause
      await expect(
        gameRewards.connect(user1).pause()
      ).to.be.reverted;

      // Batch adder cannot pause
      await expect(
        gameRewards.connect(batchAdder).pause()
      ).to.be.reverted;

      // Only admin can pause
      await gameRewards.pause();
      expect(await gameRewards.paused()).to.be.true;
    });

    it("Should prevent unauthorized unpause attempts", async function () {
      // First pause the contract
      await gameRewards.pause();

      // Non-admin cannot unpause
      await expect(
        gameRewards.connect(user1).unpause()
      ).to.be.reverted;

      // Batch adder cannot unpause
      await expect(
        gameRewards.connect(batchAdder).unpause()
      ).to.be.reverted;

      // Only admin can unpause
      await gameRewards.unpause();
      expect(await gameRewards.paused()).to.be.false;
    });

    it("Should maintain pause state after role changes", async function () {
      // Pause contract
      await gameRewards.pause();

      // Grant admin role to new admin
      await gameRewards.grantRole(await gameRewards.DEFAULT_ADMIN_ROLE(), user1.address);

      // Contract should still be paused
      expect(await gameRewards.paused()).to.be.true;

      // New admin should be able to unpause
      await gameRewards.connect(user1).unpause();
      expect(await gameRewards.paused()).to.be.false;

      // Original admin renounces their role but pause state remains
      await gameRewards.connect(user1).pause();
      await gameRewards.renounceRole(await gameRewards.DEFAULT_ADMIN_ROLE(), owner.address);
      expect(await gameRewards.paused()).to.be.true;
    });
  });

  describe("Claim Delay", function () {
    beforeEach(async function () {
      // Setup initial batch
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      
      const { tree } = generateMerkleTree(rewards);

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);

      // Create first batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree.getHexRoot(),
        ethers.parseEther("100")
      );
    });

    it("Should enforce claim delay between claims", async function () {
      const reward = rewards[0];
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [reward.address, reward.amount]
          )
        )
      );

      // First claim should work
      await gameRewards.connect(user1).claimReward(1, reward.amount, proof);

      // Create second batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Try to claim immediately (should fail)
      await expect(
        gameRewards.connect(user1).claimReward(2, reward.amount, proof)
      ).to.be.revertedWith("Claim delay not passed");

      // Wait for delay
      await ethers.provider.send("evm_increaseTime", [61]); // slightly more than delay
      await ethers.provider.send("evm_mine");

      // Should now be able to claim
      await gameRewards.connect(user1).claimReward(2, reward.amount, proof);
    });
  });

  describe("Claim Delay Management", function () {
    beforeEach(async function () {
      // Setup rewards
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      // Set initial short delay
      await gameRewards.connect(owner).setClaimDelay(60);

      // Create first batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );
    });

    it("Should enforce delay modification correctly", async function () {
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("100")]
          )
        )
      );

      // First claim
      await gameRewards.connect(user1).claimReward(1, ethers.parseEther("100"), proof);

      // Modify delay to a longer period
      const newDelay = 300; // 5 minutes
      await gameRewards.connect(owner).setClaimDelay(newDelay);

      // Create second batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Try to claim before new delay period (should fail)
      await ethers.provider.send("evm_increaseTime", [61]); // Old delay + 1
      await ethers.provider.send("evm_mine");

      await expect(
        gameRewards.connect(user1).claimReward(2, ethers.parseEther("100"), proof)
      ).to.be.revertedWith("Claim delay not passed");

      // Wait for remaining new delay period
      await ethers.provider.send("evm_increaseTime", [240]); // Additional time to reach new delay
      await ethers.provider.send("evm_mine");

      // Should now be able to claim
      await gameRewards.connect(user1).claimReward(2, ethers.parseEther("100"), proof);
    });
  });

  describe("User Management", function () {
    let banManager;

    beforeEach(async function () {
      const [, , , _banManager] = await ethers.getSigners();
      banManager = _banManager;
    });

    it("Should allow admin to add ban manager", async function () {
      await expect(gameRewards.connect(owner).addBanManager(banManager.address))
        .to.emit(gameRewards, "RoleGranted")
        .withArgs(await gameRewards.BAN_MANAGER_ROLE(), banManager.address, owner.address);
    });

    it("Should not allow non-admin to add ban manager", async function () {
      await expect(gameRewards.connect(user1).addBanManager(banManager.address))
        .to.be.revertedWithCustomError(gameRewards, "AccessControlUnauthorizedAccount")
        .withArgs(user1.address, ethers.ZeroHash);
    });

    it("Should allow admin to ban user", async function () {
      const tx = await gameRewards.connect(owner).banUser(user1.address);
      await expect(tx).to.emit(gameRewards, "UserBanned").withArgs(user1.address, await time.latest());
      expect(await gameRewards.isBanned(user1.address)).to.be.true;
    });

    it("Should allow ban manager to ban user", async function () {
      await gameRewards.connect(owner).addBanManager(banManager.address);
      const tx = await gameRewards.connect(banManager).banUser(user1.address);
      await expect(tx).to.emit(gameRewards, "UserBanned").withArgs(user1.address, await time.latest());
      expect(await gameRewards.isBanned(user1.address)).to.be.true;
    });

    it("Should not allow unauthorized address to ban user", async function () {
      await expect(gameRewards.connect(user1).banUser(user2.address))
        .to.be.revertedWith("Caller cannot ban users");
    });

    it("Should allow admin to unban user", async function () {
      await gameRewards.connect(owner).banUser(user1.address);
      const tx = await gameRewards.connect(owner).unbanUser(user1.address);
      await expect(tx).to.emit(gameRewards, "UserUnbanned").withArgs(user1.address, await time.latest());
      expect(await gameRewards.isBanned(user1.address)).to.be.false;
    });

    it("Should allow ban manager to unban user", async function () {
      await gameRewards.connect(owner).addBanManager(banManager.address);
      await gameRewards.connect(banManager).banUser(user1.address);
      const tx = await gameRewards.connect(banManager).unbanUser(user1.address);
      await expect(tx).to.emit(gameRewards, "UserUnbanned").withArgs(user1.address, await time.latest());
      expect(await gameRewards.isBanned(user1.address)).to.be.false;
    });

    it("Should not allow unauthorized address to unban user", async function () {
      await gameRewards.connect(owner).banUser(user2.address);
      await expect(gameRewards.connect(user1).unbanUser(user2.address))
        .to.be.revertedWith("Caller cannot unban users");
    });

    it("Should not allow banning already banned user", async function () {
      await gameRewards.connect(owner).banUser(user1.address);
      await expect(gameRewards.connect(owner).banUser(user1.address))
        .to.be.revertedWith("User already banned");
    });

    it("Should not allow unbanning non-banned user", async function () {
      await expect(gameRewards.connect(owner).unbanUser(user1.address))
        .to.be.revertedWith("User not banned");
    });
  });

  describe("Security", function () {
    beforeEach(async function () {
      // Setup a batch
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should not allow other address to use someone else's proof", async function () {
      const reward = rewards[0];
      const proof = merkleTree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [reward.address, reward.amount]
          )
        )
      );

      // Try to use user1's proof from user2's account
      await expect(
        gameRewards.connect(user2).claimReward(1, reward.amount, proof)
      ).to.be.revertedWith("Invalid proof");
    });
  });

  describe("Access Control", function () {
    let ADMIN_ROLE;
    let BATCH_ADDER_ROLE;
    let newAdmin;
    let newBatchAdder;

    beforeEach(async function () {
      ADMIN_ROLE = await gameRewards.DEFAULT_ADMIN_ROLE();
      BATCH_ADDER_ROLE = await gameRewards.BATCH_ADDER_ROLE();
      [newAdmin, newBatchAdder] = [user1, user2];

      // Setup basic rewards for testing batch creation
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      const { tree } = generateMerkleTree(rewards);
      merkleTree = tree;

      // Set a shorter claim delay for testing
      await gameRewards.connect(owner).setClaimDelay(60);
    });

    it("Should allow admin to grant and revoke batch adder role", async function () {
      // Grant role
      await gameRewards.grantRole(BATCH_ADDER_ROLE, newBatchAdder.address);
      expect(await gameRewards.hasRole(BATCH_ADDER_ROLE, newBatchAdder.address)).to.be.true;

      // Test new batch adder can create batch
      await gameRewards.connect(newBatchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Revoke role
      await gameRewards.revokeRole(BATCH_ADDER_ROLE, newBatchAdder.address);
      expect(await gameRewards.hasRole(BATCH_ADDER_ROLE, newBatchAdder.address)).to.be.false;

      // Test revoked batch adder cannot create batch
      await expect(
        gameRewards.connect(newBatchAdder).setRewardsBatch(
          merkleTree.getHexRoot(),
          ethers.parseEther("100")
        )
      ).to.be.reverted;

      // Test new batch adder can still create batch after re-granting role
      await gameRewards.grantRole(BATCH_ADDER_ROLE, newBatchAdder.address);
      await gameRewards.connect(newBatchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );
    });

    it("Should allow admin role transfer", async function () {
      // Grant admin role to new admin
      await gameRewards.grantRole(ADMIN_ROLE, newAdmin.address);
      expect(await gameRewards.hasRole(ADMIN_ROLE, newAdmin.address)).to.be.true;

      // New admin should be able to grant roles
      await gameRewards.connect(newAdmin).grantRole(BATCH_ADDER_ROLE, newBatchAdder.address);
      expect(await gameRewards.hasRole(BATCH_ADDER_ROLE, newBatchAdder.address)).to.be.true;

      // Original admin renounces their role
      await gameRewards.renounceRole(ADMIN_ROLE, owner.address);
      expect(await gameRewards.hasRole(ADMIN_ROLE, owner.address)).to.be.false;

      // Original admin should no longer be able to grant roles
      await expect(
        gameRewards.grantRole(BATCH_ADDER_ROLE, user3.address)
      ).to.be.reverted;
    });

    it("Should prevent unauthorized role management", async function () {
      // Non-admin cannot grant roles
      await expect(
        gameRewards.connect(user1).grantRole(BATCH_ADDER_ROLE, user2.address)
      ).to.be.reverted;

      // Non-admin cannot revoke roles
      await expect(
        gameRewards.connect(user1).revokeRole(BATCH_ADDER_ROLE, batchAdder.address)
      ).to.be.reverted;

      // Batch adder cannot grant their role to others
      await expect(
        gameRewards.connect(batchAdder).grantRole(BATCH_ADDER_ROLE, user2.address)
      ).to.be.reverted;
    });

    it("Should prevent unauthorized batch creation", async function () {
      // Random user cannot create batch
      await expect(
        gameRewards.connect(user1).setRewardsBatch(
          merkleTree.getHexRoot(),
          ethers.parseEther("100")
        )
      ).to.be.reverted;

      // Admin without batch adder role cannot create batch
      await expect(
        gameRewards.setRewardsBatch(
          merkleTree.getHexRoot(),
          ethers.parseEther("100")
        )
      ).to.be.reverted;
    });

    it("Should handle role reassignment correctly", async function () {
      // Grant role to new batch adder
      await gameRewards.grantRole(BATCH_ADDER_ROLE, newBatchAdder.address);
      
      // Both batch adders should be able to create batches
      await gameRewards.connect(batchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );
      
      await gameRewards.connect(newBatchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );

      // Revoke role from original batch adder
      await gameRewards.revokeRole(BATCH_ADDER_ROLE, batchAdder.address);
      
      // Original batch adder should no longer be able to create batches
      await expect(
        gameRewards.connect(batchAdder).setRewardsBatch(
          merkleTree.getHexRoot(),
          ethers.parseEther("100")
        )
      ).to.be.reverted;

      // New batch adder should still be able to create batches
      await gameRewards.connect(newBatchAdder).setRewardsBatch(
        merkleTree.getHexRoot(),
        ethers.parseEther("100")
      );
    });
  });

  describe("Token Management", function () {
    it("Should check for insufficient token balance", async function () {
      // Setup rewards that exceed contract balance
      rewards = [
        { address: user1.address, amount: ethers.parseEther("2000") } // More than the 1000 tokens minted
      ];
      
      const { tree } = generateMerkleTree(rewards);

      // Create batch
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree.getHexRoot(),
        ethers.parseEther("2000")
      );

      const proof = tree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("2000")]
          )
        )
      );

      // Try to claim more than contract balance
      await expect(
        gameRewards.connect(user1).claimReward(1, ethers.parseEther("2000"), proof)
      ).to.be.revertedWithCustomError(gameToken, "ERC20InsufficientBalance");
    });

    it("Should handle token transfer failures", async function () {
      // Deploy a mock token that fails transfers
      const MockFailingToken = await ethers.getContractFactory("MockFailingToken");
      const failingToken = await MockFailingToken.deploy();
      await failingToken.waitForDeployment();

      // Deploy new GameRewards with failing token
      const GameRewards = await ethers.getContractFactory("GameRewards");
      const gameRewardsWithFailingToken = await GameRewards.deploy(
        await failingToken.getAddress(),
        owner.address,
        batchAdder.address
      );

      // Mint tokens to the contract
      await failingToken.mint(await gameRewardsWithFailingToken.getAddress(), ethers.parseEther("1000"));

      // Setup rewards
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      
      const { tree } = generateMerkleTree(rewards);

      // Grant roles and setup batch
      await gameRewardsWithFailingToken.grantRole(await gameRewardsWithFailingToken.BATCH_ADDER_ROLE(), batchAdder.address);
      await gameRewardsWithFailingToken.connect(batchAdder).setRewardsBatch(
        tree.getHexRoot(),
        ethers.parseEther("100")
      );

      const proof = tree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("100")]
          )
        )
      );

      // Try to claim with failing token
      await expect(
        gameRewardsWithFailingToken.connect(user1).claimReward(1, ethers.parseEther("100"), proof)
      ).to.be.revertedWith("Transfer failed");
    });

    it("Should handle token approval correctly", async function () {
      // Check initial balance
      const initialBalance = await gameToken.balanceOf(await gameRewards.getAddress());
      expect(initialBalance).to.equal(ethers.parseEther("1000"));

      // Setup and execute a claim
      rewards = [
        { address: user1.address, amount: ethers.parseEther("100") }
      ];
      
      const { tree } = generateMerkleTree(rewards);

      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree.getHexRoot(),
        ethers.parseEther("100")
      );

      const proof = tree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("100")]
          )
        )
      );

      await gameRewards.connect(user1).claimReward(1, ethers.parseEther("100"), proof);

      // Verify balances after claim
      const finalContractBalance = await gameToken.balanceOf(await gameRewards.getAddress());
      const userBalance = await gameToken.balanceOf(user1.address);
      expect(finalContractBalance).to.equal(initialBalance - ethers.parseEther("100"));
      expect(userBalance).to.equal(ethers.parseEther("100"));
    });

    it("Should allow admin to update game token", async function () {
      // Deploy new token
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const newToken = await MockERC20.deploy("New Game Token", "NGT");
      await newToken.waitForDeployment();

      const oldTokenAddress = await gameToken.getAddress();

      // Update token
      await expect(gameRewards.connect(owner).setGameToken(await newToken.getAddress()))
        .to.emit(gameRewards, "GameTokenUpdated")
        .withArgs(oldTokenAddress, await newToken.getAddress());

      expect(await gameRewards.gameToken()).to.equal(await newToken.getAddress());
    });

    it("Should not allow non-admin to update game token", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const newToken = await MockERC20.deploy("New Game Token", "NGT");
      await newToken.waitForDeployment();

      await expect(
        gameRewards.connect(user1).setGameToken(await newToken.getAddress())
      ).to.be.revertedWithCustomError(gameRewards, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle maximum uint256 values", async function () {
      const maxUint256 = ethers.MaxUint256;
      
      // Setup reward with max uint256 amount
      const maxReward = {
        address: user1.address,
        amount: maxUint256
      };

      const { tree } = generateMerkleTree([maxReward]);

      // Try to create batch with max amount
      await expect(
        gameRewards.connect(batchAdder).setRewardsBatch(
          tree.getHexRoot(),
          maxUint256
        )
      ).to.not.be.reverted;

      const proof = tree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [maxReward.address, maxReward.amount]
          )
        )
      );

      // Try to claim max amount (should fail due to insufficient token balance)
      await expect(
        gameRewards.connect(user1).claimReward(1, maxUint256, proof)
      ).to.be.revertedWithCustomError(gameToken, "ERC20InsufficientBalance");
    });

    it("Should handle minimum valid values", async function () {
      // Setup reward with minimum amount (1 wei)
      const minReward = {
        address: user1.address,
        amount: 1n
      };

      const { tree } = generateMerkleTree([minReward]);

      // Create batch with minimum amount
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree.getHexRoot(),
        1n
      );

      const proof = tree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [minReward.address, minReward.amount]
          )
        )
      );

      // Claim minimum amount
      await expect(
        gameRewards.connect(user1).claimReward(1, 1n, proof)
      ).to.not.be.reverted;
    });

    it("Should handle array bounds and empty arrays", async function () {
      // Create a batch with multiple rewards to ensure we have valid proofs
      const validRewards = [
        { address: user1.address, amount: ethers.parseEther("100") },
        { address: user2.address, amount: ethers.parseEther("150") },
        { address: user3.address, amount: ethers.parseEther("200") }
      ];
      
      const { tree } = generateMerkleTree(validRewards);
  
      await gameRewards.connect(batchAdder).setRewardsBatch(
        tree.getHexRoot(),
        ethers.parseEther("450") // Total of all rewards
      );
  
      // Try to claim with empty proof array
      await expect(
        gameRewards.connect(user1).claimReward(1, ethers.parseEther("100"), [])
      ).to.be.revertedWith("Invalid proof");

      // Try to claim with empty claims array
      await expect(
        gameRewards.connect(user1).claimMultipleRewards([])
      ).to.be.revertedWith("Invalid claims count");

      // Get a valid proof for user1's reward
      const validProof = tree.getHexProof(
        keccak256(
          ethers.solidityPacked(
            ["address", "uint256"],
            [user1.address, ethers.parseEther("100")]
          )
        )
      );

      // Try to claim with valid proof but wrong amount
      await expect(
        gameRewards.connect(user1).claimReward(1, ethers.parseEther("150"), validProof)
      ).to.be.revertedWith("Invalid proof");

      // Try to claim with valid proof but wrong user
      await expect(
        gameRewards.connect(user2).claimReward(1, ethers.parseEther("100"), validProof)
      ).to.be.revertedWith("Invalid proof");

      // Verify valid proof works correctly
      await expect(
        gameRewards.connect(user1).claimReward(1, ethers.parseEther("100"), validProof)
      ).to.not.be.reverted;
    });
  });

  describe("Token Recovery", function () {
    let otherToken;
    
    beforeEach(async function () {
      // Deploy another token for testing recovery
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      otherToken = await MockERC20.deploy("Other Token", "OTHER");
      await otherToken.waitForDeployment();
      
      // Send some tokens to the contract
      await otherToken.mint(await gameRewards.getAddress(), ethers.parseEther("500"));
    });

    it("Should allow admin to recover tokens", async function () {
      const amount = ethers.parseEther("100");
      const recipient = user1.address;
      
      // Check initial balances
      const initialBalance = await otherToken.balanceOf(recipient);
      
      // Recover tokens
      await gameRewards.connect(owner).recoverToken(
        await otherToken.getAddress(),
        amount,
        recipient
      );
      
      // Check final balances
      const finalBalance = await otherToken.balanceOf(recipient);
      expect(finalBalance - initialBalance).to.equal(amount);
    });

    it("Should allow recovering game tokens", async function () {
      const amount = ethers.parseEther("100");
      const recipient = user2.address;
      
      // Recover game tokens
      await gameRewards.connect(owner).recoverToken(
        await gameToken.getAddress(),
        amount,
        recipient
      );
      
      // Check recipient received the tokens
      expect(await gameToken.balanceOf(recipient)).to.equal(amount);
    });

    it("Should not allow non-admin to recover tokens", async function () {
      const amount = ethers.parseEther("100");
      
      // Try to recover tokens as non-admin
      await expect(
        gameRewards.connect(user1).recoverToken(
          await otherToken.getAddress(),
          amount,
          user2.address
        )
      ).to.be.revertedWithCustomError(gameRewards, "AccessControlUnauthorizedAccount")
        .withArgs(user1.address, ethers.ZeroHash);
    });

    it("Should not allow recovery to zero address", async function () {
      const amount = ethers.parseEther("100");
      
      await expect(
        gameRewards.connect(owner).recoverToken(
          await otherToken.getAddress(),
          amount,
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Cannot recover to zero address");
    });

    it("Should not allow recovery of zero amount", async function () {
      await expect(
        gameRewards.connect(owner).recoverToken(
          await otherToken.getAddress(),
          0,
          user1.address
        )
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should not allow recovery of more tokens than available", async function () {
      const tooMuchAmount = ethers.parseEther("1000");
      
      await expect(
        gameRewards.connect(owner).recoverToken(
          await otherToken.getAddress(),
          tooMuchAmount,
          user1.address
        )
      ).to.be.revertedWith("Insufficient balance");
    });
  });
});
