// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Delegation} from "./Delegation.sol";
import {ProposalManager} from "./ProposalManager.sol";
import {ProposalState, ProposalType} from "./GovernanceTypes.sol";
import {QuorumCalculator} from "./QuorumCalculator.sol";
import {TimeLock} from "./TimeLock.sol";
import {VotingPower} from "./VotingPower.sol";

interface IGovernanceToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title GovernorQuadratic
/// @notice Versioned cooperative governance with quadratic, delegated, time-weighted voting.
contract GovernorQuadratic {
    using QuorumCalculator for uint256;

    IGovernanceToken public immutable token;
    ProposalManager public immutable proposals;
    Delegation public immutable delegation;
    TimeLock public immutable timelock;
    uint256 public constant VOTING_PERIOD = 1 weeks;

    struct Receipt {
        bool hasVoted;
        bool support;
        uint256 votes;
        uint256 cost;
    }

    mapping(uint256 => mapping(address => Receipt)) public receipts;
    mapping(uint256 => uint256) public forVotes;
    mapping(uint256 => uint256) public againstVotes;
    mapping(uint256 => bytes32) public queuedOperation;

    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 votes, uint256 cost);

    constructor(IGovernanceToken governanceToken) {
        token = governanceToken;
        proposals = new ProposalManager(address(this));
        delegation = new Delegation();
        timelock = new TimeLock(address(this));
    }

    function propose(ProposalType proposalType, bytes32 contentHash, address target, uint256 value, bytes calldata data) external returns (uint256) {
        return proposals.createProposal(msg.sender, proposalType, contentHash, target, value, data);
    }

    function amend(uint256 proposalId, bytes32 contentHash, address target, uint256 value, bytes calldata data) external {
        proposals.amendProposal(proposalId, msg.sender, contentHash, target, value, data);
    }

    function delegate(ProposalType proposalType, address delegatee) external {
        delegation.delegate(proposalType, delegatee);
    }

    function startVoting(uint256 proposalId) external {
        ProposalManager.Proposal memory proposal = proposals.proposal(proposalId);
        require(msg.sender == proposal.proposer, "only proposer");
        require(proposal.state == ProposalState.Draft || proposal.state == ProposalState.Amend, "bad state");
        proposals.setVotingWindow(proposalId, block.timestamp, block.timestamp + VOTING_PERIOD);
        proposals.setState(proposalId, ProposalState.Voting);
    }

    function castVote(uint256 proposalId, bool support, uint256 votes, uint256 lockDurationWeeks) external {
        ProposalManager.Proposal memory proposal = proposals.proposal(proposalId);
        require(proposal.state == ProposalState.Voting, "not voting");
        require(block.timestamp >= proposal.votingStartsAt && block.timestamp <= proposal.votingEndsAt, "closed");
        require(delegation.votingRepresentative(msg.sender, proposal.proposalType) == msg.sender, "delegated");
        _cast(proposalId, msg.sender, support, votes, lockDurationWeeks);
    }

    function castDelegatedVote(uint256 proposalId, address delegator, bool support, uint256 votes, uint256 lockDurationWeeks) external {
        ProposalManager.Proposal memory proposal = proposals.proposal(proposalId);
        require(proposal.state == ProposalState.Voting, "not voting");
        require(delegation.delegateOf(delegator, proposal.proposalType) == msg.sender, "not delegate");
        _cast(proposalId, delegator, support, votes, lockDurationWeeks);
    }

    function _cast(uint256 proposalId, address voter, bool support, uint256 votes, uint256 lockDurationWeeks) internal {
        require(!receipts[proposalId][voter].hasVoted, "already voted");
        uint256 cost = VotingPower.voteCost(votes);
        uint256 maxVotes = VotingPower.maxTimeWeightedQuadraticVotes(token.balanceOf(voter), lockDurationWeeks);
        require(votes > 0 && votes <= maxVotes, "insufficient quadratic power");
        require(token.transferFrom(voter, address(this), cost), "lock failed");
        receipts[proposalId][voter] = Receipt(true, support, votes, cost);
        if (support) forVotes[proposalId] += votes;
        else againstVotes[proposalId] += votes;
        emit VoteCast(proposalId, voter, support, votes, cost);
    }

    function queue(uint256 proposalId) external returns (bytes32 operationId) {
        ProposalManager.Proposal memory proposal = proposals.proposal(proposalId);
        require(proposal.state == ProposalState.Voting, "not voting");
        require(block.timestamp > proposal.votingEndsAt, "voting active");
        require(forVotes[proposalId] > againstVotes[proposalId], "not approved");
        require(QuorumCalculator.quorumReached(forVotes[proposalId], againstVotes[proposalId], token.totalSupply()), "quorum");
        operationId = timelock.queue(proposalId, proposal.proposer, proposal.target, proposal.value, proposal.data);
        queuedOperation[proposalId] = operationId;
        proposals.setState(proposalId, ProposalState.Queued);
    }

    function cancel(uint256 proposalId) external {
        ProposalManager.Proposal memory proposal = proposals.proposal(proposalId);
        require(msg.sender == proposal.proposer, "only proposer");
        timelock.cancel(queuedOperation[proposalId], msg.sender);
        proposals.setState(proposalId, ProposalState.Cancelled);
    }

    function execute(uint256 proposalId) external payable returns (bytes memory) {
        bytes memory result = timelock.execute(queuedOperation[proposalId]);
        proposals.setState(proposalId, ProposalState.Executed);
        return result;
    }
}
