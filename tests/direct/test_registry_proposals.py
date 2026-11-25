"""Registry proposals: anyone proposes, consensus probes, the owner decides."""

import json

import pytest

from conftest import ATTO


def addr_hex(value):
    if hasattr(value, "as_hex"):
        return value.as_hex.lower()
    return "0x" + value.hex()

PROPOSAL = {
    "symbol": "sSOL",
    "name": "Synthetic Solana",
    "kind": "CRYPTO",
    "underlying": "SOL",
    "url": "https://feeds.synthforge.test/sol",
    "path": "price",
    "bucket": "HIGH",
    "cap": 3000,
}

SOL_FEED = r"feeds\.synthforge\.test/sol"


def mock_sol(vm, price="150", body=None, status=200):
    payload = body if body is not None else json.dumps({"price": price})
    vm.mock_web(SOL_FEED, {"status": status, "body": payload})


def propose(contract, proposal=PROPOSAL):
    return json.loads(
        contract.propose_asset(
            proposal["symbol"],
            proposal["name"],
            proposal["kind"],
            proposal["underlying"],
            proposal["url"],
            proposal["path"],
            proposal["bucket"],
            proposal["cap"],
        )
    )


def proposals(contract):
    return {row["symbol"]: row for row in json.loads(contract.list_asset_proposals())}


def test_any_wallet_can_propose_and_the_probe_is_recorded(direct_vm, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    record = propose(vault)
    assert record["status"] == "PENDING"
    assert record["proposed_by"].lower() == addr_hex(direct_bob)
    assert int(record["probe_price_atto"]) == 150 * ATTO
    assert len(record["probe_digest"]) == 64
    assert record["decided_by"] == ""
    info = json.loads(vault.get_system_info())
    assert info["proposals"] == 1
    assert info["pending_proposals"] == 1
    assert info["assets"] == 5
    assert list(proposals(vault)) == ["SSOL"]


def test_a_proposal_is_not_an_asset_until_activated(direct_vm, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    with direct_vm.expect_revert("[EXPECTED] unknown synthetic asset"):
        vault.get_asset("SSOL")
    symbols = [row["symbol"] for row in json.loads(vault.list_assets())]
    assert symbols == ["SBTC", "SGOLD", "SSPX", "SUSDY", "SEUR"]


def test_owner_activation_registers_the_proposed_asset(direct_vm, direct_owner, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    direct_vm.sender = direct_owner
    asset = json.loads(vault.activate_asset("ssol"))
    assert asset["symbol"] == "SSOL"
    assert asset["reference_url"] == PROPOSAL["url"]
    assert asset["max_weight_bps"] == 3000
    assert asset["risk_bucket"] == "HIGH"
    assert asset["enabled"] is True
    assert json.loads(vault.get_asset("SSOL"))["name"] == "Synthetic Solana"
    record = proposals(vault)["SSOL"]
    assert record["status"] == "ACTIVE"
    assert record["decided_by"].lower() == addr_hex(direct_owner)
    assert record["decided_at"] != ""
    assert int(record["activation_price_atto"]) == 150 * ATTO
    info = json.loads(vault.get_system_info())
    assert info["assets"] == 6
    assert info["pending_proposals"] == 0


def test_activation_cannot_run_twice(direct_vm, direct_owner, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    direct_vm.sender = direct_owner
    vault.activate_asset("SSOL")
    with direct_vm.expect_revert("[EXPECTED] asset already registered"):
        vault.activate_asset("SSOL")


def test_only_the_owner_decides(direct_vm, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    with direct_vm.expect_revert("[EXPECTED] only the vault owner can activate"):
        vault.activate_asset("SSOL")
    with direct_vm.expect_revert("[EXPECTED] only the vault owner can reject"):
        vault.reject_asset("SSOL", "I do not like this feed at all")


def test_activation_reprobes_and_refuses_a_dead_feed(direct_vm, direct_owner, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    direct_vm.clear_mocks()
    mock_sol(direct_vm, body="gone", status=404)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("[EXTERNAL] feed rejected the request (404)"):
        vault.activate_asset("SSOL")
    assert proposals(vault)["SSOL"]["status"] == "PENDING"
    assert json.loads(vault.get_system_info())["assets"] == 5


def test_rejection_requires_a_reason_and_unblocks_reproposal(direct_vm, direct_owner, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("[EXPECTED] rejection note must say why"):
        vault.reject_asset("SSOL", "no")
    rejected = json.loads(vault.reject_asset("SSOL", "scraped blog, not the canonical SOL print"))
    assert rejected["status"] == "REJECTED"
    assert rejected["decided_by"].lower() == addr_hex(direct_owner)
    assert rejected["note"] == "scraped blog, not the canonical SOL print"
    assert rejected["probe_digest"] != ""
    direct_vm.sender = direct_bob
    again = propose(vault)
    assert again["status"] == "PENDING"
    assert len(proposals(vault)) == 1


def test_a_second_pending_proposal_is_refused(direct_vm, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    with direct_vm.expect_revert("[EXPECTED] a proposal for SSOL is already pending"):
        propose(vault)


def test_proposing_an_existing_symbol_is_refused(direct_vm, direct_bob, vault):
    existing = dict(PROPOSAL, symbol="SBTC")
    with direct_vm.expect_revert("[EXPECTED] asset already registered"):
        propose(vault, existing)


@pytest.mark.parametrize(
    "body,pattern",
    [
        (json.dumps({"quote": {"price": "1"}}), "[EXTERNAL] price path not found"),
        ("<html>not json</html>", "[EXTERNAL] feed returned non-JSON payload"),
        (json.dumps({"price": "0"}), "[EXTERNAL] non-positive price"),
    ],
)
def test_a_feed_that_does_not_price_anything_leaves_no_record(direct_vm, direct_bob, vault, body, pattern):
    mock_sol(direct_vm, body=body)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert(pattern):
        propose(vault)
    assert json.loads(vault.get_system_info())["proposals"] == 0


def test_direct_owner_registration_closes_a_pending_proposal(direct_vm, direct_owner, direct_bob, vault):
    mock_sol(direct_vm)
    direct_vm.sender = direct_bob
    propose(vault)
    direct_vm.sender = direct_owner
    vault.register_asset("SSOL", "Synthetic Solana", "CRYPTO", "SOL", PROPOSAL["url"], "price", "HIGH", 3000)
    record = proposals(vault)["SSOL"]
    assert record["status"] == "ACTIVE"
    assert record["note"] == "registered directly by the owner"
    assert json.loads(vault.get_system_info())["pending_proposals"] == 0


def test_paused_vault_refuses_proposals(direct_vm, direct_owner, direct_bob, vault):
    direct_vm.sender = direct_owner
    vault.set_paused(True)
    direct_vm.sender = direct_bob
    mock_sol(direct_vm)
    with direct_vm.expect_revert("[EXPECTED] vault is paused"):
        propose(vault)


def test_unknown_proposal_is_reported(direct_vm, vault):
    with direct_vm.expect_revert("[EXPECTED] unknown asset proposal"):
        vault.get_asset_proposal("NOPE")
