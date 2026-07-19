// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VotingPower} from "./VotingPower.sol";

/// @title QuorumCalculator
/// @notice Computes 4% quadratic quorum over support and opposition vote buckets.
library QuorumCalculator {
    uint256 internal constant QUORUM_BPS = 400;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    function quorumThreshold(uint256 totalSupply) internal pure returns (uint256) {
        return (totalSupply * QUORUM_BPS) / BPS_DENOMINATOR;
    }

    function quadraticParticipation(uint256 forVotes, uint256 againstVotes) internal pure returns (uint256) {
        return VotingPower.sqrt(forVotes) + VotingPower.sqrt(againstVotes);
    }

    function quorumReached(uint256 forVotes, uint256 againstVotes, uint256 totalSupply) internal pure returns (bool) {
        return quadraticParticipation(forVotes, againstVotes) >= quorumThreshold(totalSupply);
    }
}
