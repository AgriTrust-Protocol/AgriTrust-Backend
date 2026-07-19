// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VotingPower
/// @notice Shared quadratic and time-weighted voting math for cooperative governance.
library VotingPower {
    uint256 internal constant WEEKS_PER_YEAR = 52;
    uint256 internal constant MAX_LOCK_WEEKS = 156; // 3 years

    function voteCost(uint256 votes) internal pure returns (uint256) {
        return votes * votes;
    }

    function maxQuadraticVotes(uint256 tokenBalance) internal pure returns (uint256) {
        return sqrt(tokenBalance);
    }

    function timeWeightedTokens(uint256 tokens, uint256 lockDurationWeeks) internal pure returns (uint256) {
        uint256 cappedWeeks = lockDurationWeeks > MAX_LOCK_WEEKS ? MAX_LOCK_WEEKS : lockDurationWeeks;
        return (tokens * cappedWeeks) / WEEKS_PER_YEAR;
    }

    function maxTimeWeightedQuadraticVotes(uint256 tokens, uint256 lockDurationWeeks) internal pure returns (uint256) {
        return sqrt(timeWeightedTokens(tokens, lockDurationWeeks));
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
