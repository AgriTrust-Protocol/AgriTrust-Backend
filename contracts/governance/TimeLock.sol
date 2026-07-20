// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TimeLock
/// @notice Minimal 48-hour proposal execution timelock controlled by governance.
contract TimeLock {
    uint256 public constant DELAY = 48 hours;
    address public governor;

    struct Operation {
        address proposer;
        address target;
        uint256 value;
        bytes data;
        uint256 eta;
        bool executed;
        bool cancelled;
    }

    mapping(bytes32 => Operation) public operations;

    event Queued(bytes32 indexed operationId, uint256 eta);
    event Executed(bytes32 indexed operationId);
    event Cancelled(bytes32 indexed operationId);

    modifier onlyGovernor() {
        require(msg.sender == governor, "only governor");
        _;
    }

    constructor(address initialGovernor) {
        governor = initialGovernor == address(0) ? msg.sender : initialGovernor;
    }

    receive() external payable {}

    function hashOperation(uint256 proposalId, address target, uint256 value, bytes calldata data) public pure returns (bytes32) {
        return keccak256(abi.encode(proposalId, target, value, data));
    }

    function queue(uint256 proposalId, address proposer, address target, uint256 value, bytes calldata data) external onlyGovernor returns (bytes32 operationId) {
        operationId = hashOperation(proposalId, target, value, data);
        require(operations[operationId].eta == 0, "already queued");
        uint256 eta = block.timestamp + DELAY;
        operations[operationId] = Operation(proposer, target, value, data, eta, false, false);
        emit Queued(operationId, eta);
    }

    function cancel(bytes32 operationId, address caller) external onlyGovernor {
        Operation storage operation = operations[operationId];
        require(operation.proposer == caller, "only proposer");
        require(!operation.executed, "executed");
        require(block.timestamp < operation.eta, "delay elapsed");
        operation.cancelled = true;
        emit Cancelled(operationId);
    }

    function execute(bytes32 operationId) external payable onlyGovernor returns (bytes memory result) {
        Operation storage operation = operations[operationId];
        require(operation.eta != 0, "not queued");
        require(block.timestamp >= operation.eta, "timelock active");
        require(!operation.cancelled, "cancelled");
        require(!operation.executed, "executed");
        operation.executed = true;
        (bool ok, bytes memory data) = operation.target.call{value: operation.value}(operation.data);
        require(ok, "execution failed");
        emit Executed(operationId);
        return data;
    }
}
