// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {GovernorQuadratic, IGovernanceToken} from "../contracts/governance/GovernorQuadratic.sol";
import {ProposalType} from "../contracts/governance/GovernanceTypes.sol";

contract MockToken is IGovernanceToken {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public override totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract GovernorQuadraticTest {
    GovernorQuadratic governor;
    MockToken token;
    address voter1 = address(0x1);
    address voter2 = address(0x2);
    address voter3 = address(0x3);

    function setUp() public {
        token = new MockToken();
        governor = new GovernorQuadratic(token);
        token.mint(voter1, 25);
        token.mint(voter2, 100);
        token.mint(voter3, 225);
    }

    function testQuadraticCostCurve() public {
        assertEq(governor.propose(ProposalType.TextProposal, keccak256("v1"), address(0), 0, ""), 1);
        assertEq(governor.proposals().versionContentHash(1, 1), keccak256("v1"));
    }

    function testVotingPowerMathBounds() public pure {
        assertEq(exposedCost(1), 1);
        assertEq(exposedCost(5), 25);
        assertEq(exposedCost(10), 100);
        assertEq(exposedSqrt(25), 5);
        assertEq(exposedSqrt(100), 10);
        assertEq(exposedSqrt(225), 15);
    }

    function exposedCost(uint256 votes) internal pure returns (uint256) {
        return votes * votes;
    }

    function exposedSqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "uint not equal");
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "bytes32 not equal");
    }
}
