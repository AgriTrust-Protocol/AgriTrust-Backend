// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ProposalState, ProposalType} from "./GovernanceTypes.sol";

/// @title ProposalManager
/// @notice Ownable proposal lifecycle and versioning store for quadratic governance.
contract ProposalManager {
    struct Proposal {
        address proposer;
        ProposalType proposalType;
        ProposalState state;
        uint256 version;
        uint256 votingStartsAt;
        uint256 votingEndsAt;
        bytes32 latestContentHash;
        address target;
        uint256 value;
        bytes data;
    }

    uint256 public proposalCount;
    address public governor;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(uint256 => bytes32)) public versionContentHash;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, ProposalType indexed proposalType, bytes32 contentHash);
    event ProposalAmended(uint256 indexed proposalId, uint256 indexed version, bytes32 contentHash);
    event ProposalStateChanged(uint256 indexed proposalId, ProposalState state);

    modifier onlyGovernor() {
        require(msg.sender == governor, "only governor");
        _;
    }

    constructor(address initialGovernor) {
        governor = initialGovernor == address(0) ? msg.sender : initialGovernor;
    }

    function createProposal(address proposer, ProposalType proposalType, bytes32 contentHash, address target, uint256 value, bytes calldata data)
        external
        onlyGovernor
        returns (uint256 proposalId)
    {
        proposalId = ++proposalCount;
        Proposal storage proposal = _proposals[proposalId];
        proposal.proposer = proposer;
        proposal.proposalType = proposalType;
        proposal.state = ProposalState.Draft;
        proposal.version = 1;
        proposal.latestContentHash = contentHash;
        proposal.target = target;
        proposal.value = value;
        proposal.data = data;
        versionContentHash[proposalId][1] = contentHash;
        emit ProposalCreated(proposalId, proposer, proposalType, contentHash);
    }

    function amendProposal(uint256 proposalId, address proposer, bytes32 contentHash, address target, uint256 value, bytes calldata data) external onlyGovernor {
        Proposal storage proposal = _proposals[proposalId];
        require(proposal.proposer == proposer, "only proposer");
        require(proposal.state == ProposalState.Draft || proposal.state == ProposalState.Amend, "voting started");
        proposal.state = ProposalState.Amend;
        proposal.version += 1;
        proposal.latestContentHash = contentHash;
        proposal.target = target;
        proposal.value = value;
        proposal.data = data;
        versionContentHash[proposalId][proposal.version] = contentHash;
        emit ProposalAmended(proposalId, proposal.version, contentHash);
    }

    function setState(uint256 proposalId, ProposalState state) external onlyGovernor {
        _proposals[proposalId].state = state;
        emit ProposalStateChanged(proposalId, state);
    }

    function setVotingWindow(uint256 proposalId, uint256 startsAt, uint256 endsAt) external onlyGovernor {
        _proposals[proposalId].votingStartsAt = startsAt;
        _proposals[proposalId].votingEndsAt = endsAt;
    }

    function proposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }
}
