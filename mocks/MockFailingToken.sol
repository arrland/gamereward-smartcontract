// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFailingToken is ERC20 {
    constructor() ERC20("Failing Token", "FAIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        revert("Transfer failed");
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert("Transfer failed");
    }
} 