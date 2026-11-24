"""Deterministic execution over validator-attested prices."""

import json

import pytest

from conftest import ATTO, THESIS, mock_prices, mock_proposal

CAPITAL = 1_000_000 * ATTO


def _prepare(vault, direct_vm, direct_alice, overrides=None):
    mock_proposal(direct_vm)
    mock_prices(direct_vm, overrides)
    direct_vm.sender = direct_alice
    vault.generate_strategy("PF-0001", THESIS, 90)
    return json.loads(vault.execute_strategy("PF-0001", "ST-0001"))


def test_execution_allocates_units_at_attested_prices(vault, balanced_portfolio, direct_vm, direct_alice):
    receipt = _prepare(vault, direct_vm, direct_alice)

    assert receipt["proof_id"] == "PR-0003"
    assert receipt["nav_before_atto"] == CAPITAL
    # Floor rounding on unit conversion leaves sub-cent dust in the NAV.
    assert abs(receipt["nav_after_atto"] - CAPITAL) < 1_000_000
    assert receipt["turnover_bps"] == 5000
    assert receipt["holdings"] == ["SBTC", "SGOLD", "SSPX", "SUSDY"]

    positions = {row["symbol"]: row for row in json.loads(vault.get_positions("PF-0001"))}
    assert set(positions) == {"SBTC", "SGOLD", "SSPX", "SUSDY"}
    expected_btc = (CAPITAL * 2000 // 10000) * ATTO // (60000 * ATTO)
    assert positions["SBTC"]["units_atto"] == expected_btc
    assert positions["SBTC"]["weight_bps"] == 2000
    expected_usdy = (CAPITAL * 2000 // 10000) * ATTO // (1 * ATTO)
    assert positions["SUSDY"]["units_atto"] == expected_usdy

    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["status"] == "LIVE"
    assert portfolio["active_strategy_id"] == "ST-0001"
    assert portfolio["rebalances"] == 1
    strategy = json.loads(vault.get_strategy("ST-0001"))
    assert strategy["executions"] == 1


def test_execute_requires_the_manager(vault, balanced_portfolio, direct_vm, direct_alice, direct_bob):
    mock_proposal(direct_vm)
    mock_prices(direct_vm)
    direct_vm.sender = direct_alice
    vault.generate_strategy("PF-0001", THESIS, 90)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED] only the portfolio manager"):
        vault.execute_strategy("PF-0001", "ST-0001")


def test_unknown_strategy_is_rejected(vault, balanced_portfolio, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] unknown strategy"):
        vault.execute_strategy("PF-0001", "ST-9999")


def test_price_snapshot_is_agreed_by_validators(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepare(vault, direct_vm, direct_alice)
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    mock_prices(direct_vm, {"SBTC": "90000"})
    assert direct_vm.run_validator() is False


def test_mark_to_market_reprices_nav(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepare(vault, direct_vm, direct_alice)
    units = {row["symbol"]: row["units_atto"] for row in json.loads(vault.get_positions("PF-0001"))}

    direct_vm.clear_mocks()
    mock_prices(direct_vm, {"SBTC": "66000", "SUSDY": "1"})
    receipt = json.loads(vault.mark_to_market("PF-0001"))

    expected = (units["SBTC"] * 66000 * ATTO) // ATTO
    expected += (units["SGOLD"] * 2400 * ATTO) // ATTO
    expected += (units["SSPX"] * 5200 * ATTO) // ATTO
    expected += (units["SUSDY"] * 1 * ATTO) // ATTO
    assert abs(receipt["nav_before_atto"] - CAPITAL) < 1_000_000
    assert receipt["nav_after_atto"] == expected
    assert receipt["nav_after_atto"] > CAPITAL

    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["nav_atto"] == expected
    assert portfolio["nav_per_share_atto"] == expected * ATTO // CAPITAL


def test_mark_to_market_needs_positions(vault, balanced_portfolio, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] portfolio has no positions"):
        vault.mark_to_market("PF-0001")


def test_nav_is_realised_on_redemption(vault, balanced_portfolio, direct_vm, direct_alice, direct_bob):
    _prepare(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_prices(direct_vm, {"SBTC": "66000"})
    vault.mark_to_market("PF-0001")
    nav = json.loads(vault.get_portfolio("PF-0001"))["nav_atto"]

    direct_vm.sender = direct_bob
    funded = json.loads(vault.fund_portfolio("PF-0001", 200_000 * ATTO))
    receipt = json.loads(vault.redeem_shares("PF-0001", funded["shares_minted_atto"]))
    assert abs(receipt["payout_atto"] - 200_000 * ATTO) < ATTO

    direct_vm.sender = direct_alice
    vault.redeem_shares("PF-0001", 500_000 * ATTO)
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["shares_atto"] == 500_000 * ATTO
    # Burning half of the shares halves the NAV but preserves NAV per share.
    assert abs(portfolio["nav_atto"] - nav // 2) < 1000
    assert abs(portfolio["nav_per_share_atto"] - nav * ATTO // CAPITAL) < 1000


def test_repeat_execution_has_zero_turnover(vault, balanced_portfolio, direct_vm, direct_alice):
    _prepare(vault, direct_vm, direct_alice)
    second = json.loads(vault.execute_strategy("PF-0001", "ST-0001"))
    assert second["turnover_bps"] == 0
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["rebalances"] == 2


def test_revoked_strategy_cannot_be_executed(vault, balanced_portfolio, direct_vm, direct_alice):
    from conftest import mock_ruling

    _prepare(vault, direct_vm, direct_alice)
    direct_vm.clear_mocks()
    mock_ruling(direct_vm, "REVOKE", ["CAP_BREACH"])
    direct_vm.sender = direct_alice
    vault.challenge_strategy("PF-0001", "ST-0001", "The book breached the duration sleeve limit.")
    with direct_vm.expect_revert("[EXPECTED] strategy is not active"):
        vault.execute_strategy("PF-0001", "ST-0001")
