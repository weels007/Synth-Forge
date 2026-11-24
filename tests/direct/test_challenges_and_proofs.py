"""Dispute adjudication and the execution-proof chain."""

import json

import pytest

from conftest import ATTO, THESIS, mock_prices, mock_proposal, mock_ruling

CHALLENGE = "The proposal silently exceeds the duration sleeve stated in the mandate."


def _prepared(vault, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    mock_prices(direct_vm)
    direct_vm.sender = direct_alice
    vault.generate_strategy("PF-0001", THESIS, 90)
    vault.execute_strategy("PF-0001", "ST-0001")


def test_revoke_marks_the_strategy_and_reopens_review(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MANDATE_DRIFT", "MISSING_HEDGE"], "Allocation ignores the duration sleeve.")

    ruling = json.loads(vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE))
    assert ruling["verdict"] == "REVOKE"
    # Violations are normalised (sorted, de-duplicated) so validators agree
    # regardless of the order the model emits them in.
    assert ruling["violations"] == ["MANDATE_DRIFT", "MISSING_HEDGE"]
    assert ruling["explanation"] == "Allocation ignores the duration sleeve."

    strategy = json.loads(vault.get_strategy("ST-0001"))
    assert strategy["status"] == "REVOKED"
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["active_strategy_id"] == ""
    assert portfolio["status"] == "REVIEW"

    with direct_vm.expect_revert("[EXPECTED] strategy is already revoked"):
        mock_ruling(direct_vm, "REVOKE", [], "again")
        vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)


def test_uphold_keeps_the_strategy_active(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "UPHOLD", [], "The allocation is consistent with the mandate.")

    ruling = json.loads(vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE))
    assert ruling["verdict"] == "UPHOLD"
    strategy = json.loads(vault.get_strategy("ST-0001"))
    assert strategy["status"] == "ACTIVE"
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["active_strategy_id"] == "ST-0001"
    assert portfolio["status"] == "LIVE"


def test_adjudication_runs_through_validator_consensus(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "UPHOLD", [], "consistent")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MANDATE_DRIFT"], "inconsistent")
    assert direct_vm.run_validator() is False


@pytest.mark.parametrize("reason", ["short", "x" * 1400])
def test_challenge_reason_is_bounded(vault, balanced_portfolio, direct_vm, direct_alice, reason):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] challenge reason"):
        vault.challenge_strategy("PF-0001", "ST-0001", reason)


def test_anyone_can_challenge(vault, balanced_portfolio, direct_vm, direct_alice, direct_bob):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MANDATE_DRIFT"], "Not a balanced book.")
    direct_vm.sender = direct_bob
    ruling = json.loads(vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE))
    assert ruling["verdict"] == "REVOKE"
    proofs = json.loads(vault.list_proofs("PF-0001"))
    assert proofs[0]["executor"] == direct_bob.as_hex


def test_proof_chain_records_every_transition(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    vault.mark_to_market("PF-0001")
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "UPHOLD", [], "clean")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)

    proofs = json.loads(vault.list_proofs("PF-0001"))
    assert [row["kind"] for row in proofs] == [
        "CHALLENGE",
        "MARK",
        "REBALANCE",
        "STRATEGY_APPROVAL",
        "PORTFOLIO_OPEN",
    ]
    assert [row["proof_id"] for row in proofs] == [
        "PR-0005",
        "PR-0004",
        "PR-0003",
        "PR-0002",
        "PR-0001",
    ]
    strategy_digest = json.loads(vault.get_strategy("ST-0001"))["digest"]
    approval = proofs[3]
    assert approval["allocation_digest"] == strategy_digest
    assert approval["verdict"] == "ACCEPTED"
    rebalance = proofs[2]
    assert rebalance["allocation_digest"] == strategy_digest
    assert rebalance["weight_l1_bps"] == 5000
    assert rebalance["input_digest"] != ""
    mark = proofs[1]
    assert mark["nav_after_atto"] == mark["nav_before_atto"]
    challenge = proofs[0]
    assert challenge["verdict"] == "UPHOLD"
    assert challenge["input_digest"] != ""


def test_proof_lookup_and_unknown_ids(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    proof = json.loads(vault.get_proof("PR-0003"))
    assert proof["kind"] == "REBALANCE"
    assert proof["portfolio_id"] == "PF-0001"
    assert proof["strategy_id"] == "ST-0001"
    assert proof["executor"] == direct_alice.as_hex
    with direct_vm.expect_revert("[EXPECTED] unknown proof"):
        vault.get_proof("PR-9999")


def test_proofs_are_scoped_per_portfolio(vault, balanced_portfolio, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    vault.open_portfolio("Second book", "Carry trade.", "AGGRESSIVE", 50_000 * ATTO)
    assert len(json.loads(vault.list_proofs("PF-0002"))) == 1
    assert len(json.loads(vault.list_proofs("PF-0001"))) == 1
    proof = json.loads(vault.get_proof("PR-0002"))
    assert proof["portfolio_id"] == "PF-0002"
    assert proof["kind"] == "PORTFOLIO_OPEN"


def test_deposits_and_redemptions_are_proven(vault, balanced_portfolio, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    vault.fund_portfolio("PF-0001", 100_000 * ATTO)
    vault.redeem_shares("PF-0001", 100_000 * ATTO)
    kinds = [row["kind"] for row in json.loads(vault.list_proofs("PF-0001"))]
    assert kinds == ["REDEMPTION", "DEPOSIT", "PORTFOLIO_OPEN"]

