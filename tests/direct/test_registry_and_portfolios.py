"""Asset registry and portfolio ledger tests (pure deterministic paths)."""

import json

import pytest

from conftest import ATTO, MANDATE


def test_registry_exposes_full_asset_metadata(vault):
    rows = json.loads(vault.list_assets())
    assert [row["symbol"] for row in rows] == ["SBTC", "SGOLD", "SSPX", "SUSDY", "SEUR"]
    btc = json.loads(vault.get_asset("SBTC"))
    assert btc["kind"] == "CRYPTO"
    assert btc["underlying"] == "BTC"
    assert btc["risk_bucket"] == "HIGH"
    assert btc["max_weight_bps"] == 4000
    assert btc["enabled"] is True
    assert btc["price_path"] == "price"


def test_symbols_are_normalised(vault):
    vault.register_asset("sNIKKEI", "Synthetic Nikkei", "index", "N225", "https://feeds.synthforge.test/n225", "price", "medium", 3000)
    asset = json.loads(vault.get_asset("snikkei"))
    assert asset["symbol"] == "SNIKKEI"
    assert asset["kind"] == "INDEX"
    assert asset["risk_bucket"] == "MEDIUM"


def test_only_owner_can_register(direct_vm, direct_bob, vault):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED] only the vault owner"):
        vault.register_asset("sX", "X", "EQUITY", "X", "https://example.test/x", "price", "LOW", 1000)


def test_duplicate_symbol_is_rejected(direct_vm, vault):
    with direct_vm.expect_revert("[EXPECTED] asset already registered"):
        vault.register_asset("SBTC", "dup", "CRYPTO", "BTC", "https://example.test/x", "price", "HIGH", 1000)


@pytest.mark.parametrize(
    "args",
    [
        ("sX", "X", "WEIRD", "X", "https://example.test/x", "price", "LOW", 1000),
        ("sX", "X", "EQUITY", "X", "ftp://example.test/x", "price", "LOW", 1000),
        ("sX", "X", "EQUITY", "X", "https://example.test/x", "", "LOW", 1000),
        ("sX", "X", "EQUITY", "X", "https://example.test/x", "price", "SPICY", 1000),
        ("sX", "X", "EQUITY", "X", "https://example.test/x", "price", "LOW", 0),
        ("sX", "X", "EQUITY", "X", "https://example.test/x", "price", "LOW", 20000),
    ],
)
def test_invalid_asset_payloads_are_rejected(direct_vm, vault, args):
    with direct_vm.expect_revert("[EXPECTED]"):
        vault.register_asset(*args)


def test_disabled_assets_leave_the_universe(vault, balanced_portfolio, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    vault.set_asset_enabled("SBTC", False)
    asset = json.loads(vault.get_asset("SBTC"))
    assert asset["enabled"] is False
    prompt = vault.preview_prompt(balanced_portfolio, "A thesis long enough to pass validation.", 90)
    assert "SBTC" not in prompt
    assert "SGOLD" in prompt


def test_open_portfolio_seeds_shares(vault, direct_vm, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    vault.open_portfolio("Macro book", MANDATE, "BALANCED", 1_000_000 * ATTO)
    portfolio = json.loads(vault.get_portfolio("PF-0001"))
    assert portfolio["manager"] == direct_alice.as_hex
    assert portfolio["shares_atto"] == 1_000_000 * ATTO
    assert portfolio["nav_atto"] == 1_000_000 * ATTO
    assert portfolio["nav_per_share_atto"] == ATTO
    assert portfolio["status"] == "OPEN"
    assert int(vault.get_share_balance("PF-0001", direct_alice)) == 1_000_000 * ATTO
    assert int(vault.get_share_balance("PF-0001", direct_bob)) == 0


@pytest.mark.parametrize(
    "profile,capital",
    [("ULTRA", 10 * ATTO), ("BALANCED", 0)],
)
def test_open_portfolio_validates_inputs(vault, direct_vm, direct_alice, profile, capital):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED]"):
        vault.open_portfolio("bad", MANDATE, profile, capital)


def test_fund_mints_shares_pro_rata(vault, balanced_portfolio, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    receipt = json.loads(vault.fund_portfolio(balanced_portfolio, 250_000 * ATTO))
    assert receipt["shares_minted_atto"] == 250_000 * ATTO
    assert int(vault.get_share_balance(balanced_portfolio, direct_bob)) == 250_000 * ATTO
    portfolio = json.loads(vault.get_portfolio(balanced_portfolio))
    assert portfolio["shares_atto"] == 1_250_000 * ATTO
    assert portfolio["nav_atto"] == 1_250_000 * ATTO
    assert portfolio["nav_per_share_atto"] == ATTO


def test_redeem_burns_shares_and_pays_out(vault, balanced_portfolio, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    vault.fund_portfolio(balanced_portfolio, 250_000 * ATTO)
    receipt = json.loads(vault.redeem_shares(balanced_portfolio, 100_000 * ATTO))
    assert receipt["payout_atto"] == 100_000 * ATTO
    assert int(vault.get_share_balance(balanced_portfolio, direct_bob)) == 150_000 * ATTO
    portfolio = json.loads(vault.get_portfolio(balanced_portfolio))
    assert portfolio["shares_atto"] == 1_150_000 * ATTO
    assert portfolio["nav_atto"] == 1_150_000 * ATTO


def test_redeem_rejects_oversized_burn(vault, balanced_portfolio, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED] insufficient shares"):
        vault.redeem_shares(balanced_portfolio, 10 * ATTO)


def test_transfer_shares_moves_balance(vault, balanced_portfolio, direct_vm, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    vault.transfer_shares(balanced_portfolio, direct_bob, 400_000 * ATTO)
    assert int(vault.get_share_balance(balanced_portfolio, direct_alice)) == 600_000 * ATTO
    assert int(vault.get_share_balance(balanced_portfolio, direct_bob)) == 400_000 * ATTO
    portfolio = json.loads(vault.get_portfolio(balanced_portfolio))
    assert portfolio["shares_atto"] == 1_000_000 * ATTO


def test_unknown_portfolio_is_rejected(vault, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] unknown portfolio"):
        vault.get_portfolio("PF-9999")


def test_system_info_reports_policy_caps(vault):
    info = json.loads(vault.get_system_info())
    assert info["contract"] == "SynthForgeVault"
    assert info["caps"]["CONSERVATIVE"]["max_single_bps"] == 2500
    assert info["caps"]["BALANCED"]["max_high_bps"] == 2500
    assert info["price_tolerance_bps"] == 150
    assert info["assets"] == 5
