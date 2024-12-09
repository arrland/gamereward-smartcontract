// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title GameRewards
 * @dev Contract for managing and distributing game rewards using Merkle trees
 * Inherits from AccessControl for role-based access control, ReentrancyGuard for security, and Pausable for pause mechanism
 */
contract GameRewards is AccessControl, ReentrancyGuard, Pausable {
    // ============ Role Definitions ============
    
    bytes32 public constant BATCH_ADDER_ROLE = keccak256("BATCH_ADDER_ROLE");
    
    // ============ State Variables ============

    // Stores Merkle roots for each batch of rewards
    mapping(uint256 => bytes32) public merkleRoots;
    
    // Tracks whether an address has claimed rewards for a specific batch
    mapping(uint256 => mapping(address => bool)) public claimed;

    // Stores total amount for each batch of rewards
    mapping(uint256 => uint256) public batchTotalAmounts;
    
    // Current batch identifier
    uint256 public currentBatchId;
    
    // Address of the game token (ERC20)
    address public gameToken;
    
    // Tracks last claim timestamp for each user
    mapping(address => uint256) public lastClaimTimestamp;

    // Tracks banned users
    mapping(address => bool) public isBanned;

    // Time constraints for claim delay
    uint256 public constant MIN_DELAY = 60; // 1 minute
    uint256 public constant MAX_DELAY = 5184000; // 60 days
    uint256 public constant MAX_CLAIMS_PER_TX = 50;
    uint256 public constant INITIAL_DELAY = 120; // 2 minutes
    
    // Time delay between claims
    uint256 public claimDelay;

    // Track claimed amounts per batch
    mapping(uint256 => uint256) public claimedAmounts;

    // ============ Events ============

    event RewardsBatchSet(
        uint256 indexed batchId,
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 timestamp
    );

    event RewardClaimed(
        address indexed user,
        uint256 indexed batchId,
        uint256 amount,
        uint256 timestamp
    );

    event UserBanned(address indexed user, uint256 timestamp);
    event UserUnbanned(address indexed user, uint256 timestamp);

    event ClaimDelayUpdated(uint256 previousDelay, uint256 newDelay);

    event GameTokenUpdated(address indexed oldToken, address indexed newToken);

    // ============ Structs ============

    struct ClaimData {
        uint256 batchId;
        uint256 amount;
        bytes32[] merkleProof;
    }

    // ============ Modifiers ============

    // ============ Constructor ============

    constructor(address _gameToken, address _admin, address _batchAdder) {
        require(_gameToken != address(0), "Invalid token address");
        require(_admin != address(0), "Invalid admin address");
        require(_batchAdder != address(0), "Invalid batch adder address");
        
        gameToken = _gameToken;
        currentBatchId = 0;
        claimDelay = INITIAL_DELAY; // Initialize with initial delay
        
        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(BATCH_ADDER_ROLE, _batchAdder);
    }

    // ============ Admin Functions ============

    function setRewardsBatch(        
        bytes32 merkleRoot,
        uint256 totalAmount
    ) external whenNotPaused onlyRole(BATCH_ADDER_ROLE) {        
        require(merkleRoot != bytes32(0), "Invalid Merkle root");
        require(totalAmount > 0, "Invalid total amount");

        uint256 batchId = currentBatchId + 1;
        currentBatchId = batchId;

        merkleRoots[batchId] = merkleRoot;
        batchTotalAmounts[batchId] = totalAmount;

        emit RewardsBatchSet(
            batchId,
            merkleRoot,
            totalAmount,
            block.timestamp
        );
    }

    function setGameToken(address _tokenAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_tokenAddress != address(0), "Invalid token address");
        // Verify it's a valid ERC20 token
        require(IERC20(_tokenAddress).totalSupply() >= 0, "Invalid ERC20 token");
        address oldToken = gameToken;
        gameToken = _tokenAddress;
        emit GameTokenUpdated(oldToken, _tokenAddress);
    }

    function setAdminAddress(address _adminAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_adminAddress != address(0), "Invalid admin address");
        grantRole(DEFAULT_ADMIN_ROLE, _adminAddress);
    }

    function addBatchAdder(address _batchAdder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_batchAdder != address(0), "Invalid batch adder address");
        grantRole(BATCH_ADDER_ROLE, _batchAdder);
    }

    function banUser(address user) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(user != address(0), "Invalid address");
        require(!isBanned[user], "User already banned");
        
        isBanned[user] = true;
        emit UserBanned(user, block.timestamp);
    }

    function unbanUser(address user) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(user != address(0), "Invalid address");
        require(isBanned[user], "User not banned");
        
        isBanned[user] = false;
        emit UserUnbanned(user, block.timestamp);
    }

    /**
     * @notice Updates the claim delay period
     * @param newDelay New delay period in seconds
     */
    function setClaimDelay(uint256 newDelay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newDelay >= MIN_DELAY && newDelay <= MAX_DELAY, "Invalid delay period");
        uint256 oldDelay = claimDelay;
        claimDelay = newDelay;
        emit ClaimDelayUpdated(oldDelay, newDelay);
    }

    /**
     * @notice Pauses all reward claims and critical operations
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract and allows reward claims
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============ User Functions ============

    function claimMultipleRewards(ClaimData[] memory claims) public whenNotPaused nonReentrant {
        require(!isBanned[msg.sender], "User is banned from claiming");
        require(claims.length > 0 && claims.length <= MAX_CLAIMS_PER_TX, "Invalid claims count");
        require(block.timestamp >= lastClaimTimestamp[msg.sender] + claimDelay || lastClaimTimestamp[msg.sender] == 0, "Claim delay not passed");        
        require(IERC20(gameToken).balanceOf(address(this)) > 0, "No rewards available");
        
        uint256 totalAmount = 0;
        uint256 claimsLength = claims.length;

        // First verify all proofs
        for (uint256 i = 0; i < claimsLength; i++) {
            ClaimData memory claim = claims[i];
            require(isBatchClaimable(claim.batchId), "Batch not claimable");
            
            // Verify the Merkle proof first
            bytes32 leaf = keccak256(abi.encodePacked(msg.sender, claim.amount));
            require(
                MerkleProof.verify(claim.merkleProof, merkleRoots[claim.batchId], leaf),
                "Invalid proof"
            );
            
            // Check if already claimed from this batch
            require(!claimed[claim.batchId][msg.sender], "Already claimed");

            // Validate batch total amount first
            uint256 newClaimedAmount = claimedAmounts[claim.batchId] + claim.amount;
            require(newClaimedAmount <= batchTotalAmounts[claim.batchId], "Exceeds batch total");
            
            
            // Update state
            claimedAmounts[claim.batchId] = newClaimedAmount;
            claimed[claim.batchId][msg.sender] = true;
            totalAmount += claim.amount;
            
            emit RewardClaimed(msg.sender, claim.batchId, claim.amount, block.timestamp);
        }

        // Update last claim timestamp
        lastClaimTimestamp[msg.sender] = block.timestamp;

        // Transfer rewards
        require(IERC20(gameToken).transfer(msg.sender, totalAmount), "Transfer failed");
    }

    function claimReward(
        uint256 batchId,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external whenNotPaused {
        ClaimData[] memory claims = new ClaimData[](1);
        claims[0] = ClaimData(batchId, amount, merkleProof);
        claimMultipleRewards(claims);
    }

    // ============ View Functions ============

    function getNextClaimTime(address user) external view returns (uint256) {
        if (lastClaimTimestamp[user] == 0) {
            return 0; // User has never claimed, can claim immediately
        }
        return lastClaimTimestamp[user] + claimDelay;
    }

    function hasClaimed(address user, uint256 batchId) external view returns (bool) {
        return claimed[batchId][user];
    }

    function getUserClaimableRewards(
        address user,
        uint256[] calldata batchIds
    ) external view returns (
        uint256[] memory claimable,
        bool[] memory claimedStatus
    ) {
        claimable = new uint256[](batchIds.length);
        claimedStatus = new bool[](batchIds.length);

        bool isClaimDelayPassed = block.timestamp >= lastClaimTimestamp[user] + claimDelay || lastClaimTimestamp[user] == 0;

        for (uint256 i = 0; i < batchIds.length; i++) {
            if (isBatchClaimable(batchIds[i]) && !claimed[batchIds[i]][user] && isClaimDelayPassed) {
                claimable[i] = 1; // Placeholder for actual amount
            }
            claimedStatus[i] = claimed[batchIds[i]][user];
        }
    }

    function isBatchClaimable(uint256 batchId) public view returns (bool) {
        return merkleRoots[batchId] != bytes32(0);
    }

    function getMerkleRoot(uint256 batchId) public view returns (bytes32) {
        return merkleRoots[batchId];
    }
}