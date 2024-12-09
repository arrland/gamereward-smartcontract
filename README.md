# GameRewards Smart Contract

A Solidity smart contract for managing and distributing game rewards using Merkle trees. This contract provides a secure, gas-efficient, and flexible way to distribute ERC20 token rewards to game players.

## Features

- **Merkle Tree Distribution**: Efficient proof verification for reward claims using Merkle proofs
- **Batch Processing**: Support for multiple reward batches with unique Merkle roots
- **Multi-claim Support**: Users can claim rewards from up to 50 batches in a single transaction
- **Access Control**: Role-based access control for administrative functions using OpenZeppelin's AccessControl
- **Anti-spam Protection**: Configurable delay between claims (1 minute to 60 days)
- **Security Features**: 
  - Reentrancy protection using OpenZeppelin's ReentrancyGuard
  - Pausable functionality for emergency stops
  - User banning capability for suspicious accounts
  - Batch amount validation to prevent over-distribution
  - Time-based claim restrictions

## Contract Details

### Roles

- `DEFAULT_ADMIN_ROLE`: Can manage all aspects of the contract including:
  - Setting game token address
  - Managing other admin addresses
  - Banning/unbanning users
  - Setting claim delay periods
  - Pausing/unpausing the contract
- `BATCH_ADDER_ROLE`: Can add new reward batches with Merkle roots

### Key Functions

#### Administrative Functions

solidity
// Add new rewards batch with Merkle root
function setRewardsBatch(bytes32 merkleRoot, uint256 totalAmount) external
// Update game token address
function setGameToken(address tokenAddress) external
// Manage roles and permissions
function setAdminAddress(address adminAddress) external
function addBatchAdder(address batchAdder) external
// User management
function banUser(address user) external
function unbanUser(address user) external
// System configuration
function setClaimDelay(uint256 newDelay) external
function pause() external
function unpause() external

#### User Functions

solidity
// Claim rewards from multiple batches
function claimMultipleRewards(ClaimData[] memory claims) public
// Claim rewards from a single batch
function claimReward(
uint256 batchId,
uint256 amount,
bytes32[] calldata merkleProof
) external

#### View Functions

solidity
// Check when user can claim next
function getNextClaimTime(address user) external view returns (uint256)
// Check if user has claimed from specific batch
function hasClaimed(address user, uint256 batchId) external view returns (bool)
// Get claimable rewards for user across multiple batches
function getUserClaimableRewards(
address user,
uint256[] calldata batchIds
) external view returns (uint256[] memory claimable, bool[] memory claimedStatus)
// Check if batch is claimable
function isBatchClaimable(uint256 batchId) public view returns (bool)
// Get Merkle root for specific batch
function getMerkleRoot(uint256 batchId) public view returns (bytes32)


### System Parameters

- **Claim Delay**:
  - Minimum: 60 seconds (1 minute)
  - Maximum: 5,184,000 seconds (60 days)
  - Initial: 120 seconds (2 minutes)
- **Transaction Limits**:
  - Maximum claims per transaction: 50

## Implementation Guide

### 1. Contract Deployment

solidity
constructor(
address gameToken, // ERC20 token address
address admin, // Admin address
address batchAdder // Batch adder address
)

### 2. Setting Up Rewards

1. Generate Merkle tree off-chain:
   - Leaf format: `keccak256(abi.encodePacked(userAddress, amount))`
   - Store Merkle proofs for each user

2. Add rewards batch:
   ```solidity
   function setRewardsBatch(
       bytes32 merkleRoot,    // Root of the Merkle tree
       uint256 totalAmount    // Total rewards in batch
   )
   ```

### 3. Claiming Process

Users can claim rewards by providing:
- Batch ID
- Reward amount
- Merkle proof

Requirements:
- User must not be banned
- Claim delay period must have passed
- Valid Merkle proof
- Rewards not already claimed
- Contract must have sufficient token balance

## Events

solidity
event RewardsBatchSet(
uint256 indexed batchId,
bytes32 merkleRoot,
uint256 totalAmount,
uint256 timestamp
)
event RewardClaimed(
address indexed user,
uint256 indexed batchId,
uint256 amount,
uint256 timestamp
)
event UserBanned(address indexed user, uint256 timestamp)
event UserUnbanned(address indexed user, uint256 timestamp)
event ClaimDelayUpdated(uint256 previousDelay, uint256 newDelay)
event GameTokenUpdated(address indexed oldToken, address indexed newToken)

## Security Considerations

1. **Access Control**:
   - Role-based permissions
   - Only authorized addresses can add batches
   - Admin functions protected

2. **Anti-Spam**:
   - Configurable claim delay
   - Maximum claims per transaction
   - User banning capability

3. **Safety Checks**:
   - Reentrancy protection
   - Pausable functionality
   - Amount validation
   - Address validation
   - Batch total tracking

4. **Gas Optimization**:
   - Merkle tree for efficient verification
   - Batch claiming support
   - Minimal storage usage

## Development Setup

### Prerequisites

    bash
    Node.js v14+ required
    npm install --save-dev hardhat
    npm install --save @openzeppelin/contracts

### Testing

    bash
    Run all tests
    npx hardhat test
    Run specific test file
    npx hardhat test test/GameRewards.test.js


### Deployment

    bash
    Deploy to local network
    npx hardhat run scripts/deploy.js --network localhost