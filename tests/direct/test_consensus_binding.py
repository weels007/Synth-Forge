"""Consensus binding, single-adjudication and the recovery transition."""

import json

from conftest import ATTO, THESIS, mock_prices, mock_proposal, mock_ruling

CHALLENGE = "The book drifted away from the duration sleeve named in its mandate."
REOPEN_NOTE = "Post-revoke review complete: caps re-checked and the mandate restated."


def _prepared(vault, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    mock_prices(direct_vm)
    direct_vm.sender = direct_alice
    vault.generate_strategy("PF-0001", THESIS, 90)
    vault.execute_strategy("PF-0001", "ST-0001")


def _proofs(vault):
    return json.loads(vault.list_proofs("PF-0001"))


def test_verdict_must_agree_on_the_cited_grounds(vault, balanced_portfolio, direct_vm, direct_alice):
    # Same verdict, different grounds: the ruling would justify a different
    # audit trail, so the committee must not settle on it.
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MISSING_HEDGE"], "hedge missing")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)

    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MANDATE_DRIFT"], "mandate drifted")
    assert direct_vm.run_validator() is False


def test_verdict_agrees_when_grounds_match_in_any_order(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MISSING_HEDGE", "MANDATE_DRIFT"], "drifted")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)

    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MANDATE_DRIFT", "MISSING_HEDGE"], "drifted")
    assert direct_vm.run_validator() is True


def test_revoke_without_cited_grounds_is_refused(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", [], "because")
    with direct_vm.expect_revert("[LLM_ERROR] revoke ruling cites no violation"):
        vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)


def test_a_strategy_is_adjudicated_exactly_once(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "UPHOLD", [], "clean")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)
    assert json.loads(vault.get_strategy("ST-0001"))["adjudicated"] is True

    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MANDATE_DRIFT"], "second bite")
    with direct_vm.expect_revert("[EXPECTED] strategy already adjudicated"):
        vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)
    # The settled book is untouched by the refused retrial.
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["status"] == "LIVE"
    assert portfolio["active_strategy_id"] == "ST-0001"


def test_unknown_grounds_are_dropped_so_honest_rulings_converge(vault, balanced_portfolio, direct_vm, direct_alice):
    # A model that appends its own vocabulary to a valid code must not stall the
    # round: unknown codes are dropped identically on both sides, so the shared
    # ground still carries the ruling.
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["CONCENTRATION_RISK", "CORRELATED_CRYPTO_BETA"], "correlated")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)

    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["CONCENTRATION_RISK"], "correlated")
    assert direct_vm.run_validator() is True

    proof = [row for row in _proofs(vault) if row["kind"] == "CHALLENGE"][0]
    assert proof["evidence"]["violations"] == ["CONCENTRATION_RISK"]


def test_objective_breach_overrides_a_contrary_model_verdict(vault, balanced_portfolio, direct_vm, direct_alice, direct_owner):
    # The book held a leg that the owner has since disabled: that is a fact, so
    # the ruling must revoke it even if the model argues otherwise. The model
    # text survives in the explanation; the decision does not.
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.sender = direct_owner
    vault.set_asset_enabled("SBTC", False)

    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "UPHOLD", [], "the book still looks balanced to me")
    direct_vm.sender = direct_alice
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)

    proof = [row for row in _proofs(vault) if row["kind"] == "CHALLENGE"][0]
    assert proof["verdict"] == "REVOKE"
    assert proof["evidence"]["violations"] == ["UNSUPPORTED_INSTRUMENT"]
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["status"] == "REVIEW"
    assert portfolio["active_strategy_id"] == ""


def test_cited_grounds_are_capped_and_ordered(vault, balanced_portfolio, direct_vm, direct_alice):
    # Evidence must stay readable and identical across nodes: at most three
    # codes, always in the same order.
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(
        direct_vm, "REVOKE",
        ["SUM_MISMATCH", "MISSING_HEDGE", "CAP_BREACH", "MANDATE_DRIFT"],
        "several problems",
    )
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)

    proof = [row for row in _proofs(vault) if row["kind"] == "CHALLENGE"][0]
    violations = proof["evidence"]["violations"]
    assert len(violations) == 3
    assert violations == sorted(violations)


def test_rebalance_proof_preserves_the_sources_it_fetched(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepared(vault, direct_vm, direct_alice)
    rebalance = [row for row in _proofs(vault) if row["kind"] == "REBALANCE"][0]
    sources = rebalance["evidence"]["sources"]
    assert sources, "a rebalance must commit the prices it executed on"
    by_symbol = {row["symbol"]: row for row in sources}
    assert by_symbol["SBTC"]["url"] == "https://feeds.synthforge.test/btc"
    assert by_symbol["SBTC"]["price_atto"] == str(60000 * ATTO)
    assert by_symbol["SGOLD"]["path"] == "price"
    assert str(rebalance["evidence"]["target_weights"]["SBTC"]) == "2000"


def test_reopen_is_the_explicit_way_out_of_review(vault, balanced_portfolio, direct_vm, direct_alice, direct_bob):
    _prepared(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["MISSING_HEDGE"], "sleeve breached")
    vault.challenge_strategy("PF-0001", "ST-0001", CHALLENGE)
    assert json.loads(vault.get_portfolio("PF-0001"))["status"] == "REVIEW"

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED] only the manager or owner"):
        vault.reopen_portfolio("PF-0001", REOPEN_NOTE)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] reopen note is too short"):
        vault.reopen_portfolio("PF-0001", "too short")

    portfolio = json.loads(vault.reopen_portfolio("PF-0001", REOPEN_NOTE))
    assert portfolio["status"] == "LIVE"
    latest = _proofs(vault)[0]
    assert latest["kind"] == "REOPEN"
    assert latest["evidence"]["note"] == REOPEN_NOTE


def test_reopen_refuses_a_portfolio_that_is_not_under_review(vault, balanced_portfolio, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] portfolio is not under review"):
        vault.reopen_portfolio("PF-0001", REOPEN_NOTE)


def test_weights_parse_percent_and_decimal_text_without_floats(vault, balanced_portfolio, direct_vm, direct_alice):
    text_proposal = {
        "regime": "RISK_ON",
        "allocation": [
            {"symbol": "SBTC", "weight_bps": "20%"},
            {"symbol": "SGOLD", "weight_bps": "30.0"},
            {"symbol": "SSPX", "weight_bps": "30 %"},
            {"symbol": "SUSDY", "weight": "19.6"},
        ],
        "confidence_bps": "7200",
        "rationale": "text weights are parsed deterministically",
    }
    mock_proposal(direct_vm, text_proposal)
    direct_vm.sender = direct_alice
    strategy = json.loads(vault.generate_strategy("PF-0001", THESIS, 90))
    allocation = strategy["allocation"]
    assert allocation["SBTC"] == 2000
    assert allocation["SGOLD"] == 3000
    assert sum(allocation.values()) == 10000
    for value in allocation.values():
        assert isinstance(value, int)
