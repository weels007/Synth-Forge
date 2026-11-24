"""Shared fixtures and scenario helpers for SynthForge direct-mode tests."""

import json

import pytest


ATTO = 10 ** 18
BPS = 10000

# A small, realistic synthetic universe. Each feed returns a flat JSON price.
ASSETS = [
    {
        "symbol": "SBTC",
        "name": "Synthetic Bitcoin",
        "kind": "CRYPTO",
        "underlying": "BTC",
        "url": "https://feeds.synthforge.test/btc",
        "path": "price",
        "bucket": "HIGH",
        "cap": 4000,
    },
    {
        "symbol": "SGOLD",
        "name": "Synthetic Gold",
        "kind": "COMMODITY",
        "underlying": "XAU",
        "url": "https://feeds.synthforge.test/gold",
        "path": "price",
        "bucket": "LOW",
        "cap": 4000,
    },
    {
        "symbol": "SSPX",
        "name": "Synthetic S&P 500",
        "kind": "INDEX",
        "underlying": "SPX",
        "url": "https://feeds.synthforge.test/spx",
        "path": "quote.price",
        "bucket": "MEDIUM",
        "cap": 4000,
    },
    {
        "symbol": "SUSDY",
        "name": "Synthetic T-Bill Yield",
        "kind": "RATE",
        "underlying": "USD-1M",
        "url": "https://feeds.synthforge.test/usdy",
        "path": "price",
        "bucket": "LOW",
        "cap": 10000,
    },
    {
        "symbol": "SEUR",
        "name": "Synthetic EUR/USD",
        "kind": "FX",
        "underlying": "EURUSD",
        "url": "https://feeds.synthforge.test/eur",
        "path": "price",
        "bucket": "MEDIUM",
        "cap": 3000,
    },
]

DEFAULT_PRICES = {
    "SBTC": "60000",
    "SGOLD": "2400",
    "SSPX": "5200",
    "SUSDY": "1",
    "SEUR": "1.09",
}

FEED_PATTERNS = {
    "SBTC": r"feeds\.synthforge\.test/btc",
    "SGOLD": r"feeds\.synthforge\.test/gold",
    "SSPX": r"feeds\.synthforge\.test/spx",
    "SUSDY": r"feeds\.synthforge\.test/usdy",
    "SEUR": r"feeds\.synthforge\.test/eur",
}

BALANCED_PROPOSAL = {
    "regime": "RISK_ON",
    "allocation": [
        {"symbol": "SBTC", "weight_bps": 2000},
        {"symbol": "SGOLD", "weight_bps": 3000},
        {"symbol": "SSPX", "weight_bps": 3000},
        {"symbol": "SUSDY", "weight_bps": 2000},
    ],
    "confidence_bps": 7200,
    "rationale": "Risk-on regime: keep duration low, add equity beta via sSPX and a gold hedge.",
}

THESIS = (
    "US real yields are rolling over while earnings breadth is improving. "
    "Rotate into equity beta and gold, keep a defensive duration sleeve."
)

MANDATE = "Beat USD cash over a full cycle with a balanced multi-asset synthetic book."


def feed_body(symbol: str, price: str) -> str:
    if symbol == "SSPX":
        return json.dumps({"quote": {"price": price}})
    return json.dumps({"price": price})


def mock_prices(vm, overrides=None):
    """Register one web mock per synthetic asset feed."""
    prices = dict(DEFAULT_PRICES)
    if overrides:
        prices.update(overrides)
    for symbol, price in prices.items():
        vm.mock_web(FEED_PATTERNS[symbol], {"status": 200, "body": feed_body(symbol, price)})
    return prices


def mock_proposal(vm, proposal=None):
    vm.mock_llm(r"PORTFOLIO CONSTRUCTION ENGINE", json.dumps(proposal or BALANCED_PROPOSAL))


def mock_ruling(vm, verdict, violations=None, explanation="adjudicated"):
    body = {
        "verdict": verdict,
        "violations": violations or [],
        "explanation": explanation,
    }
    vm.mock_llm(r"RISK ADJUDICATOR", json.dumps(body))


def load(contract) -> str:
    """Normalise a JSON-string return value into text."""
    return contract if isinstance(contract, str) else str(contract)


@pytest.fixture
def vault(direct_deploy):
    """Deployed SynthForge vault with the synthetic universe registered."""
    contract = direct_deploy("contracts/SynthForgeVault.py")
    for asset in ASSETS:
        contract.register_asset(
            asset["symbol"],
            asset["name"],
            asset["kind"],
            asset["underlying"],
            asset["url"],
            asset["path"],
            asset["bucket"],
            asset["cap"],
        )
    return contract


@pytest.fixture
def balanced_portfolio(vault, direct_vm, direct_alice):
    """A BALANCED portfolio seeded with 1,000,000 quote units."""
    direct_vm.sender = direct_alice
    vault.open_portfolio("Macro book", MANDATE, "BALANCED", 1_000_000 * ATTO)
    return "PF-0001"
