"""Generative strategy engine: AI proposal gated by validator consensus."""

import json

import pytest

from conftest import ATTO, BALANCED_PROPOSAL, THESIS, mock_proposal


def _generate(vault, direct_vm, direct_alice, portfolio="PF-0001", thesis=THESIS, horizon=90):
    direct_vm.sender = direct_alice
    return json.loads(vault.generate_strategy(portfolio, thesis, horizon))


def test_strategy_is_stored_only_after_consensus(vault, balanced_portfolio, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    strategy = _generate(vault, direct_vm, direct_alice)

    assert strategy["strategy_id"] == "ST-0001"
    assert strategy["regime"] == "RISK_ON"
    assert strategy["status"] == "ACTIVE"
    assert strategy["risk_profile"] == "BALANCED"
    assert strategy["horizon_days"] == 90
    assert strategy["confidence_bps"] == 7200
    assert len(strategy["digest"]) == 64
    assert sum(strategy["allocation"].values()) == 10000
    assert strategy["allocation"] == {"SBTC": 2000, "SGOLD": 3000, "SSPX": 3000, "SUSDY": 2000}

    stored = json.loads(vault.get_strategy("ST-0001"))
    assert stored["allocation"] == strategy["allocation"]
    assert stored["thesis"] == THESIS


def test_validator_agrees_on_a_consistent_rerun(vault, balanced_portfolio, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    _generate(vault, direct_vm, direct_alice)
    assert direct_vm.run_validator() is True


def test_validator_rejects_a_divergent_regime(vault, balanced_portfolio, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    _generate(vault, direct_vm, direct_alice)

    direct_vm.clear_mocks()
    divergent = json.loads(json.dumps(BALANCED_PROPOSAL))
    divergent["regime"] = "RISK_OFF"
    mock_proposal(direct_vm, divergent)
    assert direct_vm.run_validator() is False


def test_validator_rejects_a_divergent_weight(vault, balanced_portfolio, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    _generate(vault, direct_vm, direct_alice)

    direct_vm.clear_mocks()
    drifted = {
        "regime": "RISK_ON",
        "allocation": [
            {"symbol": "SBTC", "weight_bps": 2000},
            {"symbol": "SGOLD", "weight_bps": 4000},
            {"symbol": "SSPX", "weight_bps": 1000},
            {"symbol": "SUSDY", "weight_bps": 3000},
        ],
        "confidence_bps": 7200,
        "rationale": "drifted",
    }
    mock_proposal(direct_vm, drifted)
    assert direct_vm.run_validator() is False


def test_validator_rejects_a_different_asset_set(vault, balanced_portfolio, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    _generate(vault, direct_vm, direct_alice)

    direct_vm.clear_mocks()
    different = {
        "regime": "RISK_ON",
        "allocation": [
            {"symbol": "SGOLD", "weight_bps": 3000},
            {"symbol": "SSPX", "weight_bps": 4000},
            {"symbol": "SUSDY", "weight_bps": 3000},
        ],
        "confidence_bps": 7200,
        "rationale": "different set",
    }
    mock_proposal(direct_vm, different)
    assert direct_vm.run_validator() is False


def test_symbols_outside_the_universe_are_rejected(vault, balanced_portfolio, direct_vm, direct_alice):
    rogue = {
        "regime": "RISK_ON",
        "allocation": [
            {"symbol": "SAAPL", "weight_bps": 6000},
            {"symbol": "SGOLD", "weight_bps": 4000},
        ],
        "confidence_bps": 5000,
        "rationale": "hallucinated ticker",
    }
    mock_proposal(direct_vm, rogue)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] symbol outside universe"):
        vault.generate_strategy("PF-0001", THESIS, 90)


def test_policy_caps_repair_an_oversized_allocation(vault, balanced_portfolio, direct_vm, direct_alice):
    greedy = {
        "regime": "RISK_ON",
        "allocation": [
            {"symbol": "SBTC", "weight_bps": 6000},
            {"symbol": "SGOLD", "weight_bps": 2000},
            {"symbol": "SSPX", "weight_bps": 2000},
        ],
        "confidence_bps": 6000,
        "rationale": "concentrated bet",
    }
    mock_proposal(direct_vm, greedy)
    strategy = _generate(vault, direct_vm, direct_alice)
    allocation = strategy["allocation"]
    assert sum(allocation.values()) == 10000
    assert max(allocation.values()) <= 4000
    assert allocation["SBTC"] <= 2500


def test_infeasible_allocation_aborts_the_transaction(vault, balanced_portfolio, direct_vm, direct_alice):
    single = {
        "regime": "RISK_ON",
        "allocation": [{"symbol": "SBTC", "weight_bps": 10000}],
        "confidence_bps": 9000,
        "rationale": "all in",
    }
    mock_proposal(direct_vm, single)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] allocation cannot satisfy the risk caps"):
        vault.generate_strategy("PF-0001", THESIS, 90)


def test_only_the_manager_can_propose(vault, balanced_portfolio, direct_vm, direct_bob):
    mock_proposal(direct_vm)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED] only the portfolio manager"):
        vault.generate_strategy("PF-0001", THESIS, 90)


@pytest.mark.parametrize("thesis,horizon", [("too short", 90), (THESIS, 0), (THESIS, 4000)])
def test_thesis_and_horizon_are_validated(vault, balanced_portfolio, direct_vm, direct_alice, thesis, horizon):
    mock_proposal(direct_vm)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED]"):
        vault.generate_strategy("PF-0001", thesis, horizon)


def test_conservative_profile_zeroes_the_high_risk_bucket(vault, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    vault.open_portfolio("Defensive book", "Preserve capital.", "CONSERVATIVE", 500_000 * ATTO)
    defensive = {
        "regime": "RISK_OFF",
        "allocation": [
            {"symbol": "SBTC", "weight_bps": 2000},
            {"symbol": "SGOLD", "weight_bps": 2000},
            {"symbol": "SSPX", "weight_bps": 2000},
            {"symbol": "SUSDY", "weight_bps": 2000},
            {"symbol": "SEUR", "weight_bps": 2000},
        ],
    }
    mock_proposal(direct_vm, defensive)
    strategy = json.loads(vault.generate_strategy("PF-0001", THESIS, 30))
    allocation = strategy["allocation"]
    # CONSERVATIVE tolerates zero HIGH-bucket exposure, so the repair sleeve
    # rotates the crypto leg into the defensive assets instead.
    assert allocation["SBTC"] == 0
    assert sum(allocation.values()) == 10000
    assert max(allocation.values()) <= 2500


def test_preview_prompt_is_the_exact_adjudication_input(vault, balanced_portfolio):
    prompt = vault.preview_prompt(balanced_portfolio, THESIS, 90)
    assert "PORTFOLIO CONSTRUCTION ENGINE" in prompt
    assert "PF-0001" in prompt
    assert "risk profile: BALANCED" in prompt
    assert "max single asset" not in prompt.lower()
    assert "No single asset may exceed 4000 bps" in prompt
    assert THESIS in prompt
    assert "Return ONLY this JSON object" in prompt


def test_strategy_history_is_newest_first(vault, balanced_portfolio, direct_vm, direct_alice):
    mock_proposal(direct_vm)
    _generate(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_proposal(direct_vm)
    _generate(vault, direct_vm, direct_alice)
    history = json.loads(vault.list_strategies(balanced_portfolio))
    assert [row["strategy_id"] for row in history] == ["ST-0002", "ST-0001"]
