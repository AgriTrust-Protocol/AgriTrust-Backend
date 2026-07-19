// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

enum ProposalType {
    TreasurySpend,
    ParameterChange,
    ContractUpgrade,
    TextProposal
}

enum ProposalState {
    Draft,
    Amend,
    Voting,
    Queued,
    Executed,
    Cancelled
}
