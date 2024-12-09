// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    bool public transferShouldFail;
    mapping(address => bool) public blacklisted;
    uint256 public totalTransferred;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setTransferShouldFail(bool shouldFail) external {
        transferShouldFail = shouldFail;
    }

    function blacklistAddress(address account) external {
        blacklisted[account] = true;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!transferShouldFail, "MockERC20: transfer failed");
        require(!blacklisted[from] && !blacklisted[to], "MockERC20: address blacklisted");
        
        if (from != address(0)) { // not minting
            totalTransferred += value;
        }
        
        super._update(from, to, value);
    }
}
