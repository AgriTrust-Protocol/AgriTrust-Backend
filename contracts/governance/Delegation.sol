// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ProposalType} from "./GovernanceTypes.sol";

/// @title Delegation
/// @notice Stores delegate assignments per voter and proposal type.
contract Delegation {
    mapping(address => mapping(ProposalType => address)) private _delegates;

    event DelegateChanged(address indexed delegator, ProposalType indexed proposalType, address indexed delegatee);

    function delegate(ProposalType proposalType, address delegatee) external {
        require(delegatee != msg.sender, "self delegation");
        _delegates[msg.sender][proposalType] = delegatee;
        emit DelegateChanged(msg.sender, proposalType, delegatee);
    }

    function delegateOf(address delegator, ProposalType proposalType) public view returns (address) {
        return _delegates[delegator][proposalType];
    }

    function votingRepresentative(address voter, ProposalType proposalType) public view returns (address) {
        address delegatee = _delegates[voter][proposalType];
        return delegatee == address(0) ? voter : delegatee;
    }
}
