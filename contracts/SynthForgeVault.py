# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import datetime
import hashlib
import json

from dataclasses import dataclass

# SynthForge - Generative Synthetic Asset Vaults on GenLayer
#
# GenLayer role: the vault does NOT trust an off-chain AI to pick weights.
# A strategy is *proposed* by an LLM and then *adjudicated* by an independent
# validator committee under the Equivalence Principle. Only a consensus-agreed
# allocation can move portfolio state, and every state transition emits an
# on-chain execution proof anchored to the inputs that justified it.


BPS = 10000
ATTO = 10 ** 18

ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

# Consensus bands. Tight on purpose: the weight vector is the financially
# binding output, so two nodes that differ materially must not agree.
MAX_WEIGHT_DELTA_BPS = 500
MAX_L1_DELTA_BPS = 1200
PRICE_TOLERANCE_BPS = 150
MAX_THESIS_CHARS = 2400
MIN_REASON_CHARS = 40
MAX_REASON_CHARS = 1200
MAX_RATIONALE_CHARS = 900

# Adjudication is decided on a closed vocabulary. Free-text grounds can never
# reach consensus: two independent model runs phrase the same breach
# differently, so a validator comparing literal strings would reject an honest
# ruling and the round would rotate forever. These codes are the only grounds a
# ruling may cite, and every objective policy breach is decided in Python -
# the model cannot talk its way out of a cap that is already breached.
VIOLATION_CODES = (
    "CAP_BREACH",
    "SUM_MISMATCH",
    "MANDATE_DRIFT",
    "CONCENTRATION_RISK",
    "MISSING_HEDGE",
    "THESIS_CONTRADICTION",
    "UNSUPPORTED_INSTRUMENT",
)
MAX_VIOLATIONS = 3


# ---------------------------------------------------------------------------
# Storage records
# ---------------------------------------------------------------------------


@allow_storage
@dataclass
class SyntheticAsset:
    symbol: str
    name: str
    kind: str
    underlying: str
    reference_url: str
    price_path: str
    risk_bucket: str
    max_weight_bps: u256
    enabled: bool
    added_at: str


@allow_storage
@dataclass
class Portfolio:
    portfolio_id: str
    manager: Address
    name: str
    mandate: str
    risk_profile: str
    capital_atto: u256
    shares_atto: u256
    nav_atto: u256
    active_strategy_id: str
    status: str
    rebalances: u256
    created_at: str
    last_mark_at: str


@allow_storage
@dataclass
class Strategy:
    strategy_id: str
    portfolio_id: str
    thesis: str
    risk_profile: str
    horizon_days: u256
    regime: str
    allocation_json: str
    rationale: str
    digest: str
    confidence_bps: u256
    status: str
    created_by: Address
    created_at: str
    executions: u256
    ruled: u256


@allow_storage
@dataclass
class ExecutionProof:
    proof_id: str
    kind: str
    portfolio_id: str
    strategy_id: str
    allocation_digest: str
    input_digest: str
    nav_before_atto: u256
    nav_after_atto: u256
    weight_l1_bps: u256
    verdict: str
    verdict_detail: str
    evidence_json: str
    executor: Address
    created_at: str


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    moment = datetime.datetime.now(datetime.timezone.utc)
    moment = moment.replace(microsecond=0)
    return moment.isoformat().replace("+00:00", "Z")


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _pad(value: int, width: int) -> str:
    out = str(value)
    while len(out) < width:
        out = "0" + out
    return out


def _max_single_bps(profile: str) -> int:
    # The single-asset cap also enforces diversification: reaching 10000 bps
    # requires at least 10000 / cap assets.
    if profile == "CONSERVATIVE":
        return 2500
    if profile == "BALANCED":
        return 4000
    return 6000


def _max_high_bps(profile: str) -> int:
    if profile == "CONSERVATIVE":
        return 0
    if profile == "BALANCED":
        return 2500
    return 5000


def _dig(data, path: str):
    current = data
    parts = str(path).split(".")
    for part in parts:
        if part == "":
            continue
        if isinstance(current, dict):
            if part not in current:
                raise ValueError(part)
            current = current[part]
        elif isinstance(current, list):
            current = current[int(part)]
        else:
            raise ValueError(part)
    return current


def _decimal_atto(text: str, error_prefix: str) -> int:
    # Integer-only decimal parser. No float anywhere: float arithmetic is not
    # reproducible across nodes and is rejected by the VM in money paths.
    raw = str(text).strip()
    negative = raw.startswith("-")
    if negative:
        raw = raw[1:]
    if raw.startswith("+"):
        raw = raw[1:]
    lower = raw.lower()
    exponent = 0
    if "e" in lower:
        parts = lower.split("e")
        if len(parts) != 2:
            raise gl.vm.UserError(error_prefix + " unparsable number: " + str(text))
        raw = parts[0]
        try:
            exponent = int(parts[1])
        except Exception:
            raise gl.vm.UserError(error_prefix + " unparsable exponent: " + str(text))
        if exponent > 24 or exponent < -24:
            raise gl.vm.UserError(error_prefix + " exponent out of range: " + str(text))
    if "." in raw:
        pieces = raw.split(".")
        if len(pieces) != 2:
            raise gl.vm.UserError(error_prefix + " unparsable number: " + str(text))
        whole = pieces[0]
        frac = pieces[1]
    else:
        whole = raw
        frac = ""
    if whole == "":
        whole = "0"
    if not whole.isdigit() or (frac != "" and not frac.isdigit()):
        raise gl.vm.UserError(error_prefix + " unparsable number: " + str(text))
    digits = int(whole + frac)
    shift = 18 + exponent - len(frac)
    if shift >= 0:
        amount = digits * (10 ** shift)
    else:
        amount = digits // (10 ** (-shift))
    if negative:
        return -amount
    return amount


def _to_atto(value) -> int:
    if isinstance(value, bool):
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} price payload is a boolean")
    if isinstance(value, int):
        if value < 0:
            raise gl.vm.UserError(f"{ERROR_EXTERNAL} negative price")
        return value * ATTO
    text = str(value).strip()
    for noise in ("$", ",", "_", " "):
        text = text.replace(noise, "")
    if text == "" or text.lower() == "null" or text.lower() == "none":
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} empty price")
    return _decimal_atto(text, ERROR_EXTERNAL)


def _http_json(url: str):
    response = gl.nondet.web.get(url)
    status = getattr(response, "status", None)
    if status is None:
        status = getattr(response, "status_code", 200)
    status = int(status)
    if status >= 500:
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} feed unavailable ({status})")
    if status >= 400:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} feed rejected the request ({status})")
    body = response.body
    if isinstance(body, (bytes, bytearray)):
        text = body.decode("utf-8", "replace")
    else:
        text = str(body)
    try:
        return json.loads(text)
    except Exception:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} feed returned non-JSON payload")


def _fetch_price(spec: dict) -> int:
    payload = _http_json(spec["url"])
    try:
        raw = _dig(payload, spec["path"])
    except Exception:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} price path not found: {spec['path']}")
    price = _to_atto(raw)
    if price <= 0:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} non-positive price for {spec['symbol']}")
    return price


def _fetch_prices(specs: list) -> dict:
    prices = {}
    for spec in specs:
        prices[spec["symbol"]] = _fetch_price(spec)
    return prices


def _compare_prices(leader_prices, validator_prices) -> bool:
    if not isinstance(leader_prices, dict) or not isinstance(validator_prices, dict):
        return False
    leader_keys = sorted(leader_prices.keys())
    validator_keys = sorted(validator_prices.keys())
    if leader_keys != validator_keys:
        return False
    for symbol in leader_keys:
        left = int(leader_prices[symbol])
        right = int(validator_prices[symbol])
        if left <= 0 or right <= 0:
            return False
        diff = left - right
        if diff < 0:
            diff = -diff
        if diff * BPS > right * PRICE_TOLERANCE_BPS:
            return False
    return True


def _coerce_bps(value) -> int:
    # Integer-only: weights decide the book, so they may never pass through a
    # float. "30%", "30.4" and 30 all resolve deterministically.
    text = str(value).strip()
    for noise in ("%", " ", "_", ","):
        text = text.replace(noise, "")
    if text == "" or text.lower() == "none" or text.lower() == "null":
        raise gl.vm.UserError(f"{ERROR_LLM} non-numeric weight: {value}")
    negative = text.startswith("-")
    if negative:
        text = text[1:]
    if text.startswith("+"):
        text = text[1:]
    whole = text
    frac = ""
    if "." in text:
        whole, frac = text.split(".", 1)
    if whole == "":
        whole = "0"
    if not whole.isdigit() or (frac != "" and not frac.isdigit()):
        raise gl.vm.UserError(f"{ERROR_LLM} non-numeric weight: {value}")
    parsed = int(whole)
    if frac != "" and int(frac[0]) >= 5:
        parsed = parsed + 1
    if negative:
        parsed = -parsed
    if parsed < 0:
        return 0
    if parsed > BPS:
        return BPS
    return parsed


def _remainder_key(item):
    return (-item[1], item[0])


def _normalize_weights(weights: dict) -> dict:
    total = 0
    for symbol in weights:
        total += int(weights[symbol])
    if total <= 0:
        raise gl.vm.UserError(f"{ERROR_LLM} allocation weights sum to zero")
    symbols = sorted(weights.keys())
    result = {}
    used = 0
    remainders = []
    for symbol in symbols:
        scaled = int(weights[symbol]) * BPS // total
        result[symbol] = scaled
        used += scaled
        remainders.append((symbol, (int(weights[symbol]) * BPS) % total))
    deficit = BPS - used
    remainders.sort(key=_remainder_key)
    cursor = 0
    while deficit > 0:
        result[remainders[cursor % len(remainders)][0]] += 1
        deficit -= 1
        cursor += 1
    return result


def _apply_caps(weights: dict, universe: dict, profile: str) -> dict:
    # Deterministic policy repair. Runs on the consensus-agreed leader result
    # (and again on every node inside the nondet block), so it can never be
    # influenced by a single validator.
    cap_single = _max_single_bps(profile)
    cap_high = _max_high_bps(profile)
    symbols = sorted(weights.keys())
    caps = {}
    for symbol in symbols:
        asset_cap = int(universe[symbol]["max_weight_bps"])
        if cap_single < asset_cap:
            caps[symbol] = cap_single
        else:
            caps[symbol] = asset_cap
    result = {}
    for symbol in symbols:
        weight = int(weights[symbol])
        if weight > caps[symbol]:
            weight = caps[symbol]
        result[symbol] = weight
    high_total = 0
    for symbol in symbols:
        if universe[symbol]["risk_bucket"] == "HIGH":
            high_total += result[symbol]
    if high_total > cap_high:
        for symbol in symbols:
            if universe[symbol]["risk_bucket"] == "HIGH":
                if cap_high <= 0:
                    result[symbol] = 0
                else:
                    result[symbol] = result[symbol] * cap_high // high_total
    total = 0
    for symbol in symbols:
        total += result[symbol]
    if total > BPS:
        result = _normalize_weights(result)
        total = BPS
    high_used = 0
    for symbol in symbols:
        if universe[symbol]["risk_bucket"] == "HIGH":
            high_used += result[symbol]
    deficit = BPS - total
    guard = 0
    while deficit > 0 and guard < 64:
        guard += 1
        room_total = 0
        rooms = {}
        for symbol in symbols:
            room = caps[symbol] - result[symbol]
            if universe[symbol]["risk_bucket"] == "HIGH":
                remaining = cap_high - high_used
                if remaining < room:
                    room = remaining
            if room > 0:
                rooms[symbol] = room
                room_total += room
        if room_total <= 0:
            break
        placed = 0
        for symbol in symbols:
            if symbol not in rooms:
                continue
            add = deficit * rooms[symbol] // room_total
            if add > rooms[symbol]:
                add = rooms[symbol]
            if universe[symbol]["risk_bucket"] == "HIGH":
                remaining = cap_high - high_used
                if add > remaining:
                    add = remaining
            if add > 0:
                result[symbol] += add
                placed += add
                if universe[symbol]["risk_bucket"] == "HIGH":
                    high_used += add
        if placed == 0:
            best_symbol = ""
            best_room = 0
            for symbol in symbols:
                room = caps[symbol] - result[symbol]
                if universe[symbol]["risk_bucket"] == "HIGH":
                    remaining = cap_high - high_used
                    if remaining < room:
                        room = remaining
                if room > best_room:
                    best_room = room
                    best_symbol = symbol
            if best_symbol == "":
                break
            if best_room <= 0:
                break
            result[best_symbol] += 1
            placed = 1
            if universe[best_symbol]["risk_bucket"] == "HIGH":
                high_used += 1
        deficit -= placed
    total = 0
    for symbol in symbols:
        total += result[symbol]
    if total != BPS:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} allocation cannot satisfy the risk caps; extend the universe")
    return result


def _normalize_proposal(raw, universe: dict, profile: str) -> dict:
    if not isinstance(raw, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} proposal is not a JSON object")
    regime = str(raw.get("regime", "")).strip().upper()
    if regime != "RISK_ON" and regime != "NEUTRAL" and regime != "RISK_OFF":
        raise gl.vm.UserError(f"{ERROR_LLM} invalid regime: {regime}")
    entries = raw.get("allocation")
    if not isinstance(entries, list) or len(entries) == 0:
        raise gl.vm.UserError(f"{ERROR_LLM} allocation list is missing")
    weights = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise gl.vm.UserError(f"{ERROR_LLM} allocation entry is not an object")
        symbol = str(entry.get("symbol", "")).strip().upper()
        if symbol not in universe:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} symbol outside universe: {symbol}")
        if symbol in weights:
            raise gl.vm.UserError(f"{ERROR_LLM} duplicate symbol: {symbol}")
        weights[symbol] = _coerce_bps(entry.get("weight_bps", entry.get("weight", 0)))
    weights = _normalize_weights(weights)
    weights = _apply_caps(weights, universe, profile)
    confidence = _coerce_bps(raw.get("confidence_bps", 5000))
    rationale = str(raw.get("rationale", "")).strip()
    if len(rationale) > MAX_RATIONALE_CHARS:
        rationale = rationale[:MAX_RATIONALE_CHARS]
    return {
        "regime": regime,
        "weights": weights,
        "confidence_bps": confidence,
        "rationale": rationale,
    }


def _compare_proposals(leader_proposal, validator_proposal) -> bool:
    if not isinstance(leader_proposal, dict) or not isinstance(validator_proposal, dict):
        return False
    if str(leader_proposal.get("regime", "")) != str(validator_proposal.get("regime", "")):
        return False
    leader_weights = leader_proposal.get("weights")
    validator_weights = validator_proposal.get("weights")
    if not isinstance(leader_weights, dict) or not isinstance(validator_weights, dict):
        return False
    if sorted(leader_weights.keys()) != sorted(validator_weights.keys()):
        return False
    total_delta = 0
    for symbol in leader_weights.keys():
        delta = int(leader_weights[symbol]) - int(validator_weights[symbol])
        if delta < 0:
            delta = -delta
        if delta > MAX_WEIGHT_DELTA_BPS:
            return False
        total_delta += delta
    return total_delta <= MAX_L1_DELTA_BPS


def _known_violations(raw) -> list:
    # Keep only grounds from the shared vocabulary, deduplicated and ordered, so
    # two nodes that read the same breach cite the same code.
    codes = []
    if isinstance(raw, list):
        for item in raw:
            value = str(item).strip().upper().replace(" ", "_").replace("-", "_")
            if value in VIOLATION_CODES and value not in codes:
                codes.append(value)
    codes = sorted(codes)
    if len(codes) > MAX_VIOLATIONS:
        codes = codes[:MAX_VIOLATIONS]
    return codes


def _policy_breaches(allocation: dict, risk_profile: str, universe: dict) -> list:
    # Objective breaches, computed identically by every node from policy and
    # pinned state. These outrank the model: a book that already breaches a cap
    # is revoked whatever the prompt says, which removes the largest source of
    # verdict flapping between independent runs.
    codes = []
    cap_single = _max_single_bps(risk_profile)
    cap_high = _max_high_bps(risk_profile)
    total = 0
    high_total = 0
    for symbol in sorted(allocation.keys()):
        weight = int(allocation[symbol])
        total += weight
        meta = universe.get(symbol, None)
        if meta is None:
            codes.append("UNSUPPORTED_INSTRUMENT")
            continue
        limit = int(meta["max_weight_bps"])
        if limit > cap_single:
            limit = cap_single
        if weight > limit:
            codes.append("CAP_BREACH")
        if str(meta["risk_bucket"]) == "HIGH":
            high_total += weight
    if total != BPS:
        codes.append("SUM_MISMATCH")
    if high_total > cap_high:
        codes.append("CAP_BREACH")
    unique = []
    for code in codes:
        if code not in unique:
            unique.append(code)
    return sorted(unique)


def _normalize_verdict(raw, hard_codes=None) -> dict:
    if not isinstance(raw, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} ruling is not a JSON object")
    verdict = str(raw.get("verdict", "")).strip().upper()
    if verdict != "UPHOLD" and verdict != "REVOKE":
        raise gl.vm.UserError(f"{ERROR_LLM} invalid verdict: {verdict}")
    violations = _known_violations(raw.get("violations", []))
    explanation = str(raw.get("explanation", "")).strip()
    if len(explanation) > MAX_RATIONALE_CHARS:
        explanation = explanation[:MAX_RATIONALE_CHARS]
    if hard_codes:
        # Policy already decided this case; keep the model text, not its opinion.
        verdict = "REVOKE"
        violations = sorted(str(code) for code in hard_codes)
    if verdict == "REVOKE" and len(violations) == 0:
        raise gl.vm.UserError(f"{ERROR_LLM} revoke ruling cites no violation")
    return {"verdict": verdict, "violations": violations, "explanation": explanation}


def _compare_verdicts(leader_ruling, validator_ruling) -> bool:
    # Every mandatory criterion, not just the label. The verdict decides whether
    # the book stays live, and the violation set is the stated grounds a ruling
    # is audited against, so two nodes that disagree on either would produce
    # different state and must not reach consensus.
    if not isinstance(leader_ruling, dict) or not isinstance(validator_ruling, dict):
        return False
    leader_verdict = str(leader_ruling.get("verdict", "")).upper()
    validator_verdict = str(validator_ruling.get("verdict", "")).upper()
    if leader_verdict != validator_verdict:
        return False
    if leader_verdict != "UPHOLD" and leader_verdict != "REVOKE":
        return False
    # Compare the vocabulary codes, not the raw text: an unknown or differently
    # phrased citation is dropped identically on both sides, so honest rulings
    # still converge while differing grounds still do not.
    leader_violations = _known_violations(leader_ruling.get("violations"))
    validator_violations = _known_violations(validator_ruling.get("violations"))
    if leader_violations != validator_violations:
        return False
    if leader_verdict == "REVOKE" and len(leader_violations) == 0:
        return False
    return True


def _handle_leader_error(leaders_res, leader_fn) -> bool:
    leader_msg = ""
    if hasattr(leaders_res, "message"):
        leader_msg = str(leaders_res.message)
    try:
        leader_fn()
        return False
    except gl.vm.UserError as err:
        validator_msg = str(err)
        deterministic = validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL)
        if deterministic:
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False


def _universe_prompt_lines(universe: dict) -> list:
    symbols = sorted(universe.keys())
    rows = []
    for symbol in symbols:
        meta = universe[symbol]
        rows.append(
            "- " + symbol
            + " | kind " + str(meta["kind"])
            + " | underlying " + str(meta["underlying"])
            + " | risk " + str(meta["risk_bucket"])
            + " | cap " + str(int(meta["max_weight_bps"])) + " bps"
        )
    return rows


def _build_strategy_prompt(portfolio_id: str, mandate: str, risk_profile: str, horizon_days: int, thesis: str, universe: dict) -> str:
    cap_single = _max_single_bps(risk_profile)
    cap_high = _max_high_bps(risk_profile)
    chunks = []
    chunks.append("SYNTHFORGE // PORTFOLIO CONSTRUCTION ENGINE")
    chunks.append("You allocate a synthetic-asset portfolio managed by a GenLayer vault.")
    chunks.append("Independent validators rerun this exact prompt. They compare the macro")
    chunks.append("regime and the weight vector, so be decisive and consistent.")
    chunks.append("")
    chunks.append("PORTFOLIO")
    chunks.append("- id: " + portfolio_id)
    chunks.append("- mandate: " + mandate)
    chunks.append("- risk profile: " + risk_profile)
    chunks.append("- horizon: " + str(horizon_days) + " days")
    chunks.append("")
    chunks.append("INVESTMENT THESIS (written by the portfolio manager)")
    chunks.append("<<<")
    chunks.append(thesis)
    chunks.append(">>>")
    chunks.append("")
    chunks.append("ALLOWED UNIVERSE - you may allocate only to these symbols")
    for row in _universe_prompt_lines(universe):
        chunks.append(row)
    chunks.append("")
    chunks.append("HARD RULES - a proposal that breaks any rule is rejected")
    chunks.append("1. Every symbol must come from the allowed universe above.")
    chunks.append("2. weight_bps values are integers and must sum to exactly 10000 (100%).")
    chunks.append("3. No symbol may exceed its cap listed above.")
    chunks.append("4. No single asset may exceed " + str(cap_single) + " bps for this risk profile.")
    chunks.append("5. HIGH risk assets together may not exceed " + str(cap_high) + " bps.")
    chunks.append("6. Long only. No leverage, no shorts, no cash sleeve: fully invested.")
    chunks.append("7. Use every asset you believe matters; diversification is mandatory.")
    chunks.append("")
    chunks.append("TASK")
    chunks.append("1. Classify the macro regime implied by the thesis: RISK_ON, NEUTRAL or RISK_OFF.")
    chunks.append("2. Allocate the 10000 bps across the universe to express that thesis.")
    chunks.append("3. State your confidence in bps (0-10000).")
    chunks.append("")
    chunks.append("Return ONLY this JSON object, nothing else:")
    chunks.append('{"regime": "RISK_ON|NEUTRAL|RISK_OFF", "allocation": [{"symbol": "SYMBOL", "weight_bps": 2500}], "confidence_bps": 7000, "rationale": "at most 500 characters"}')
    return chr(10).join(chunks)


def _build_challenge_prompt(mandate: str, risk_profile: str, thesis: str, allocation: dict, universe: dict, challenge_reason: str, hard_codes: list) -> str:
    cap_single = _max_single_bps(risk_profile)
    cap_high = _max_high_bps(risk_profile)
    chunks = []
    chunks.append("SYNTHFORGE // RISK ADJUDICATOR")
    chunks.append("A live synthetic-asset vault on GenLayer has been challenged.")
    chunks.append("Validators rerun this exact prompt independently and must agree on the verdict.")
    chunks.append("")
    chunks.append("PORTFOLIO MANDATE")
    chunks.append("<<<")
    chunks.append(mandate)
    chunks.append(">>>")
    chunks.append("risk profile: " + risk_profile)
    chunks.append("")
    chunks.append("STRATEGY THESIS")
    chunks.append("<<<")
    chunks.append(thesis)
    chunks.append(">>>")
    chunks.append("")
    chunks.append("ALLOCATION UNDER REVIEW")
    for symbol in sorted(allocation.keys()):
        meta = universe.get(symbol, None)
        bucket = "UNKNOWN"
        if meta is not None:
            bucket = str(meta["risk_bucket"])
        chunks.append("- " + symbol + " | weight " + str(int(allocation[symbol])) + " bps | risk " + bucket)
    chunks.append("")
    chunks.append("POLICY LIMITS")
    chunks.append("- max single asset: " + str(cap_single) + " bps")
    chunks.append("- max HIGH risk total: " + str(cap_high) + " bps")
    chunks.append("- allocation must sum to 10000 bps")
    chunks.append("")
    chunks.append("OBJECTIVE POLICY FACTS (computed on chain, not up for debate)")
    if len(hard_codes) > 0:
        for code in sorted(hard_codes):
            chunks.append("- breach found: " + str(code))
        chunks.append("A breach listed above is a fact. The verdict MUST be REVOKE and")
        chunks.append("violations MUST be exactly the codes listed above.")
    else:
        chunks.append("- no cap, sum or coverage breach was detected")
    chunks.append("")
    chunks.append("CHALLENGE")
    chunks.append("<<<")
    chunks.append(challenge_reason)
    chunks.append(">>>")
    chunks.append("")
    chunks.append("VIOLATION CODES (cite only these exact strings)")
    chunks.append("- CAP_BREACH: a leg or the HIGH-risk sleeve exceeds its policy cap")
    chunks.append("- SUM_MISMATCH: the legs do not sum to 10000 bps")
    chunks.append("- MANDATE_DRIFT: the book no longer implements the stated mandate")
    chunks.append("- CONCENTRATION_RISK: exposure is concentrated in correlated instruments")
    chunks.append("- MISSING_HEDGE: protection the mandate requires is absent")
    chunks.append("- THESIS_CONTRADICTION: the book contradicts its own stated thesis")
    chunks.append("- UNSUPPORTED_INSTRUMENT: a leg is not an enabled instrument")
    chunks.append("")
    chunks.append("DECIDE")
    chunks.append("- REVOKE when an objective breach is listed, or when the challenge names")
    chunks.append("  a real breach of the mandate or the stated thesis.")
    chunks.append("- UPHOLD when the book implements the mandate inside every policy limit,")
    chunks.append("  even if you would have sized the arms differently.")
    chunks.append("- Cite between one and three codes, exactly as written above.")
    chunks.append("  UPHOLD may cite none.")
    chunks.append("")
    chunks.append("Return ONLY this JSON object, nothing else:")
    chunks.append('{"verdict": "UPHOLD|REVOKE", "violations": ["CODE"], "explanation": "at most 400 characters"}')
    return chr(10).join(chunks)


def _specs_digest(specs: list, prices: dict) -> str:
    # The digest binds symbol, source URL, JSON path and attested price: a
    # proof for one source cannot be read as a proof for another.
    rows = []
    for spec in specs:
        rows.append(
            str(spec["symbol"]) + "|" + str(spec["url"]) + "|" + str(spec["path"])
            + ":" + str(int(prices[spec["symbol"]]))
        )
    return _sha("|".join(rows))


def _specs_evidence(specs: list, prices: dict) -> list:
    rows = []
    for spec in specs:
        rows.append({
            "symbol": str(spec["symbol"]),
            "url": str(spec["url"]),
            "path": str(spec["path"]),
            "price_atto": str(int(prices[spec["symbol"]])),
        })
    return rows


def _parse_evidence(evidence_json: str):
    try:
        return json.loads(evidence_json)
    except Exception:
        return evidence_json



# ---------------------------------------------------------------------------
# Intelligent Contract
# ---------------------------------------------------------------------------


class SynthForgeVault(gl.Contract):
    owner: Address
    paused: bool

    assets: TreeMap[str, SyntheticAsset]
    asset_symbols: DynArray[str]

    portfolios: TreeMap[str, Portfolio]
    portfolio_ids: DynArray[str]

    strategies: TreeMap[str, Strategy]
    strategy_ids: DynArray[str]
    strategy_index: TreeMap[str, str]
    strategy_counter: TreeMap[str, u256]

    proofs: TreeMap[str, ExecutionProof]
    proof_ids: DynArray[str]
    proof_index: TreeMap[str, str]
    proof_counter: TreeMap[str, u256]

    positions: TreeMap[str, u256]
    holdings: TreeMap[str, str]
    weights: TreeMap[str, str]
    share_ledger: TreeMap[str, u256]
    counters: TreeMap[str, u256]

    def __init__(self) -> None:
        self.owner = gl.message.sender_address
        self.paused = False

    # ------------------------------------------------------------------
    # Internal helpers (not part of the ABI)
    # ------------------------------------------------------------------

    def _next(self, key: str) -> u256:
        current = self.counters.get(key, u256(0)) + u256(1)
        self.counters[key] = current
        return current

    def _require_asset(self, symbol: str) -> SyntheticAsset:
        key = str(symbol).strip().upper()
        if key not in self.assets:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} unknown synthetic asset: {key}")
        return self.assets[key]

    def _require_portfolio(self, portfolio_id: str) -> Portfolio:
        if portfolio_id not in self.portfolios:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} unknown portfolio: {portfolio_id}")
        return self.portfolios[portfolio_id]

    def _require_strategy(self, strategy_id: str) -> Strategy:
        if strategy_id not in self.strategies:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} unknown strategy: {strategy_id}")
        return self.strategies[strategy_id]

    def _held_symbols(self, portfolio_id: str) -> str:
        raw = self.holdings.get(portfolio_id, "")
        if raw == "":
            return "[]"
        return raw

    def _stored_weights(self, portfolio_id: str) -> str:
        raw = self.weights.get(portfolio_id, "")
        if raw == "":
            return "{}"
        return raw

    def _pin_universe(self) -> dict:
        universe = {}
        for symbol in self.asset_symbols:
            asset = self.assets[symbol]
            if not asset.enabled:
                continue
            universe[symbol] = {
                "kind": asset.kind,
                "underlying": asset.underlying,
                "risk_bucket": asset.risk_bucket,
                "max_weight_bps": int(asset.max_weight_bps),
                "url": asset.reference_url,
                "path": asset.price_path,
            }
        return universe

    def _record_proof(self, kind: str, portfolio_id: str, strategy_id: str, allocation_digest: str, input_digest: str, nav_before_atto: int, nav_after_atto: int, weight_l1_bps: int, verdict: str, verdict_detail: str, evidence=None) -> str:
        # evidence is the committed material behind the decision: the exact
        # URLs and prices that were fetched, or the allocation and cited
        # violations. Digest alone would not let anyone re-run the decision.
        evidence_json = "{}"
        if evidence is not None:
            evidence_json = json.dumps(evidence, sort_keys=True)
            if len(evidence_json) > 4000:
                evidence_json = evidence_json[:4000]
        sequence = self._next("proof")
        proof_id = "PR-" + _pad(int(sequence), 4)
        self.proofs[proof_id] = ExecutionProof(
            proof_id=proof_id,
            kind=kind,
            portfolio_id=portfolio_id,
            strategy_id=strategy_id,
            allocation_digest=allocation_digest,
            input_digest=input_digest,
            nav_before_atto=u256(nav_before_atto),
            nav_after_atto=u256(nav_after_atto),
            weight_l1_bps=u256(weight_l1_bps),
            verdict=verdict,
            verdict_detail=verdict_detail[:600],
            evidence_json=evidence_json,
            executor=gl.message.sender_address,
            created_at=_now_iso(),
        )
        self.proof_ids.append(proof_id)
        index = self.proof_counter.get(portfolio_id, u256(0))
        self.proof_index[portfolio_id + "|" + str(int(index))] = proof_id
        self.proof_counter[portfolio_id] = index + u256(1)
        return proof_id

    def _asset_json(self, asset: SyntheticAsset) -> dict:
        return {
            "symbol": asset.symbol,
            "name": asset.name,
            "kind": asset.kind,
            "underlying": asset.underlying,
            "reference_url": asset.reference_url,
            "price_path": asset.price_path,
            "risk_bucket": asset.risk_bucket,
            "max_weight_bps": int(asset.max_weight_bps),
            "enabled": bool(asset.enabled),
            "added_at": asset.added_at,
        }

    def _portfolio_json(self, portfolio: Portfolio) -> dict:
        shares = int(portfolio.shares_atto)
        nav = int(portfolio.nav_atto)
        nav_per_share = 0
        if shares > 0:
            nav_per_share = nav * ATTO // shares
        return {
            "portfolio_id": portfolio.portfolio_id,
            "manager": portfolio.manager.as_hex,
            "name": portfolio.name,
            "mandate": portfolio.mandate,
            "risk_profile": portfolio.risk_profile,
            "capital_atto": int(portfolio.capital_atto),
            "shares_atto": shares,
            "nav_atto": nav,
            "nav_per_share_atto": nav_per_share,
            "active_strategy_id": portfolio.active_strategy_id,
            "status": portfolio.status,
            "rebalances": int(portfolio.rebalances),
            "created_at": portfolio.created_at,
            "last_mark_at": portfolio.last_mark_at,
        }

    def _strategy_json(self, strategy: Strategy) -> dict:
        return {
            "strategy_id": strategy.strategy_id,
            "portfolio_id": strategy.portfolio_id,
            "thesis": strategy.thesis,
            "risk_profile": strategy.risk_profile,
            "horizon_days": int(strategy.horizon_days),
            "regime": strategy.regime,
            "allocation": json.loads(strategy.allocation_json),
            "rationale": strategy.rationale,
            "digest": strategy.digest,
            "confidence_bps": int(strategy.confidence_bps),
            "status": strategy.status,
            "created_by": strategy.created_by.as_hex,
            "created_at": strategy.created_at,
            "executions": int(strategy.executions),
            "adjudicated": int(strategy.ruled) != 0,
        }

    def _proof_json(self, proof: ExecutionProof) -> dict:
        return {
            "proof_id": proof.proof_id,
            "kind": proof.kind,
            "portfolio_id": proof.portfolio_id,
            "strategy_id": proof.strategy_id,
            "allocation_digest": proof.allocation_digest,
            "input_digest": proof.input_digest,
            "nav_before_atto": int(proof.nav_before_atto),
            "nav_after_atto": int(proof.nav_after_atto),
            "weight_l1_bps": int(proof.weight_l1_bps),
            "verdict": proof.verdict,
            "verdict_detail": proof.verdict_detail,
            "evidence": _parse_evidence(proof.evidence_json),
            "executor": proof.executor.as_hex,
            "created_at": proof.created_at,
        }

    # ------------------------------------------------------------------
    # Asset universe
    # ------------------------------------------------------------------

    @gl.public.write
    def register_asset(self, symbol: str, name: str, kind: str, underlying: str, reference_url: str, price_path: str, risk_bucket: str, max_weight_bps: u256) -> str:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the vault owner can register assets")
        key = str(symbol).strip().upper()
        if key == "" or len(key) > 16:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} invalid symbol")
        for character in key:
            if not (character.isalnum() or character == "-" or character == "_"):
                raise gl.vm.UserError(f"{ERROR_EXPECTED} invalid symbol characters")
        if key in self.assets:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} asset already registered: {key}")
        kind_key = str(kind).strip().upper()
        if kind_key not in ("EQUITY", "COMMODITY", "FX", "CRYPTO", "INDEX", "RATE", "BASKET"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} invalid asset kind: {kind_key}")
        bucket = str(risk_bucket).strip().upper()
        if bucket != "LOW" and bucket != "MEDIUM" and bucket != "HIGH":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} invalid risk bucket: {bucket}")
        url = str(reference_url).strip()
        if not url.startswith("https://") and not url.startswith("http://"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} reference_url must be http(s)")
        path = str(price_path).strip()
        if path == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} price_path is required")
        cap = int(max_weight_bps)
        if cap <= 0 or cap > BPS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} max_weight_bps must be within 1..10000")
        if str(name).strip() == "" or str(underlying).strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} name and underlying are required")
        self.assets[key] = SyntheticAsset(
            symbol=key,
            name=str(name).strip(),
            kind=kind_key,
            underlying=str(underlying).strip(),
            reference_url=url,
            price_path=path,
            risk_bucket=bucket,
            max_weight_bps=u256(cap),
            enabled=True,
            added_at=_now_iso(),
        )
        self.asset_symbols.append(key)
        return key

    @gl.public.write
    def set_asset_enabled(self, symbol: str, enabled: bool) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the vault owner can update assets")
        asset = self._require_asset(symbol)
        asset.enabled = bool(enabled)
        self.assets[asset.symbol] = asset

    @gl.public.write
    def set_paused(self, paused: bool) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the vault owner can pause")
        self.paused = bool(paused)

    @gl.public.write
    def transfer_ownership(self, new_owner: Address) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the owner can transfer ownership")
        self.owner = new_owner

    # ------------------------------------------------------------------
    # Portfolios and share ledger
    # ------------------------------------------------------------------

    @gl.public.write
    def open_portfolio(self, name: str, mandate: str, risk_profile: str, initial_capital_atto: u256) -> str:
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        profile = str(risk_profile).strip().upper()
        if profile != "CONSERVATIVE" and profile != "BALANCED" and profile != "AGGRESSIVE":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} invalid risk profile: {profile}")
        capital = int(initial_capital_atto)
        if capital <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} initial capital must be positive")
        if str(mandate).strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} mandate is required")
        sequence = self._next("portfolio")
        portfolio_id = "PF-" + _pad(int(sequence), 4)
        manager = gl.message.sender_address
        portfolio = Portfolio(
            portfolio_id=portfolio_id,
            manager=manager,
            name=str(name).strip(),
            mandate=str(mandate).strip(),
            risk_profile=profile,
            capital_atto=u256(capital),
            shares_atto=u256(capital),
            nav_atto=u256(capital),
            active_strategy_id="",
            status="OPEN",
            rebalances=u256(0),
            created_at=_now_iso(),
            last_mark_at=_now_iso(),
        )
        self.portfolios[portfolio_id] = portfolio
        self.portfolio_ids.append(portfolio_id)
        self.share_ledger[portfolio_id + "|" + manager.as_hex] = u256(capital)
        self.holdings[portfolio_id] = "[]"
        self.weights[portfolio_id] = "{}"
        self._record_proof(
            "PORTFOLIO_OPEN", portfolio_id, "", "", _sha(portfolio_id + "|" + str(capital)),
            capital, capital, 0, "ACCEPTED", "portfolio seeded with paper capital",
            evidence={"capital_atto": str(capital)},
        )
        return portfolio_id

    @gl.public.write
    def fund_portfolio(self, portfolio_id: str, amount_atto: u256) -> str:
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} amount must be positive")
        nav_before = int(portfolio.nav_atto)
        total_shares = int(portfolio.shares_atto)
        minted = amount
        if total_shares > 0:
            if nav_before <= 0:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} portfolio is not marked yet")
            minted = amount * total_shares // nav_before
            if minted <= 0:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} amount too small for one share unit")
        holder = gl.message.sender_address
        key = portfolio_id + "|" + holder.as_hex
        self.share_ledger[key] = self.share_ledger.get(key, u256(0)) + u256(minted)
        portfolio.shares_atto = u256(total_shares + minted)
        portfolio.capital_atto = u256(int(portfolio.capital_atto) + amount)
        portfolio.nav_atto = u256(nav_before + amount)
        self.portfolios[portfolio_id] = portfolio
        self._record_proof(
            "DEPOSIT", portfolio_id, "", "", _sha(key + "|" + str(amount)),
            nav_before, nav_before + amount, 0, "ACCEPTED", str(minted) + " shares minted",
            evidence={"amount_atto": str(amount), "shares_minted_atto": str(minted)},
        )
        return json.dumps({"portfolio_id": portfolio_id, "shares_minted_atto": minted, "nav_atto": nav_before + amount}, sort_keys=True)

    @gl.public.write
    def redeem_shares(self, portfolio_id: str, shares_atto: u256) -> str:
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        holder = gl.message.sender_address
        key = portfolio_id + "|" + holder.as_hex
        balance = int(self.share_ledger.get(key, u256(0)))
        amount = int(shares_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} shares must be positive")
        if amount > balance:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} insufficient shares")
        total_shares = int(portfolio.shares_atto)
        nav_before = int(portfolio.nav_atto)
        if total_shares <= 0 or nav_before <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} portfolio holds no value")
        if amount == total_shares:
            payout = nav_before
            keep_num = 0
            keep_den = 1
        else:
            payout = amount * nav_before // total_shares
            keep_num = nav_before - payout
            keep_den = nav_before
        held = json.loads(self._held_symbols(portfolio_id))
        for symbol in held:
            position_key = portfolio_id + "|" + str(symbol)
            units = int(self.positions.get(position_key, u256(0)))
            units = units * keep_num // keep_den
            self.positions[position_key] = u256(units)
        portfolio.capital_atto = u256(int(portfolio.capital_atto) * keep_num // keep_den)
        portfolio.nav_atto = u256(nav_before - payout)
        portfolio.shares_atto = u256(total_shares - amount)
        self.share_ledger[key] = u256(balance - amount)
        self.portfolios[portfolio_id] = portfolio
        self._record_proof(
            "REDEMPTION", portfolio_id, portfolio.active_strategy_id, "", _sha(key + "|" + str(amount)),
            nav_before, nav_before - payout, 0, "ACCEPTED", "in-kind redemption of " + str(amount) + " shares",
            evidence={"shares_atto": str(amount), "payout_atto": str(payout)},
        )
        return json.dumps({"portfolio_id": portfolio_id, "shares_burned_atto": amount, "payout_atto": payout}, sort_keys=True)

    @gl.public.write
    def transfer_shares(self, portfolio_id: str, to: Address, shares_atto: u256) -> None:
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        self._require_portfolio(portfolio_id)
        sender = gl.message.sender_address
        source_key = portfolio_id + "|" + sender.as_hex
        target_key = portfolio_id + "|" + to.as_hex
        balance = int(self.share_ledger.get(source_key, u256(0)))
        amount = int(shares_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} shares must be positive")
        if amount > balance:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} insufficient shares")
        self.share_ledger[source_key] = u256(balance - amount)
        self.share_ledger[target_key] = self.share_ledger.get(target_key, u256(0)) + u256(amount)

    # ------------------------------------------------------------------
    # Generative strategy engine - consensus-gated AI allocation
    # ------------------------------------------------------------------

    @gl.public.write
    def generate_strategy(self, portfolio_id: str, thesis: str, horizon_days: u256) -> str:
        # The leader proposes an allocation with an LLM. Validators rerun the same
        # prompt independently and must agree on the regime, the asset set and a
        # tolerance-bounded weight vector before the proposal becomes state.
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        if gl.message.sender_address != portfolio.manager:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the portfolio manager can propose a strategy")
        thesis_text = str(thesis).strip()
        if len(thesis_text) < 20:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} thesis must be at least 20 characters")
        if len(thesis_text) > MAX_THESIS_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} thesis is too long")
        horizon = int(horizon_days)
        if horizon <= 0 or horizon > 3650:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} horizon must be within 1..3650 days")
        universe = self._pin_universe()
        if len(universe) < 2:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} the universe needs at least two enabled assets")
        profile = portfolio.risk_profile
        prompt = _build_strategy_prompt(portfolio_id, portfolio.mandate, profile, horizon, thesis_text, universe)

        def leader_fn():
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _normalize_proposal(raw, universe, profile)

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            return _compare_proposals(leaders_res.calldata, leader_fn())

        proposal = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        weights = proposal["weights"]
        regime = proposal["regime"]
        rationale = proposal["rationale"]
        confidence = int(proposal["confidence_bps"])

        sequence = self._next("strategy")
        strategy_id = "ST-" + _pad(int(sequence), 4)
        allocation_json = json.dumps(weights, sort_keys=True)
        created_at = _now_iso()
        digest_source = "|".join([portfolio_id, thesis_text, profile, regime, allocation_json])
        digest = _sha(digest_source)
        strategy = Strategy(
            strategy_id=strategy_id,
            portfolio_id=portfolio_id,
            thesis=thesis_text,
            risk_profile=profile,
            horizon_days=u256(horizon),
            regime=regime,
            allocation_json=allocation_json,
            rationale=rationale,
            digest=digest,
            confidence_bps=u256(confidence),
            status="ACTIVE",
            created_by=gl.message.sender_address,
            created_at=created_at,
            executions=u256(0),
            ruled=u256(0),
        )
        self.strategies[strategy_id] = strategy
        self.strategy_ids.append(strategy_id)
        index = self.strategy_counter.get(portfolio_id, u256(0))
        self.strategy_index[portfolio_id + "|" + str(int(index))] = strategy_id
        self.strategy_counter[portfolio_id] = index + u256(1)
        self._record_proof(
            "STRATEGY_APPROVAL", portfolio_id, strategy_id, digest, _sha(prompt),
            int(portfolio.nav_atto), int(portfolio.nav_atto), 0, "ACCEPTED",
            "regime " + regime + " accepted by validator consensus",
            evidence={
                "regime": regime,
                "allocation": weights,
                "confidence_bps": str(confidence),
                "prompt_digest": _sha(prompt),
            },
        )
        return json.dumps(self._strategy_json(strategy), sort_keys=True)

    @gl.public.write
    def execute_strategy(self, portfolio_id: str, strategy_id: str) -> str:
        # Deterministic execution over validator-attested prices. The price
        # snapshot itself is agreed through the Equivalence Principle, so the
        # resulting NAV, turnover and proof are reproducible state.
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        if gl.message.sender_address != portfolio.manager:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the portfolio manager can execute a strategy")
        strategy = self._require_strategy(strategy_id)
        if strategy.portfolio_id != portfolio_id:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} strategy does not belong to this portfolio")
        if strategy.status != "ACTIVE":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} strategy is not active: " + strategy.status)

        allocation = json.loads(strategy.allocation_json)
        target_symbols = sorted(allocation.keys())
        held_symbols = json.loads(self._held_symbols(portfolio_id))
        needed = []
        for symbol in target_symbols:
            needed.append(str(symbol))
        for symbol in held_symbols:
            present = False
            for known in needed:
                if known == str(symbol):
                    present = True
            if not present:
                needed.append(str(symbol))
        needed.sort()

        specs = []
        for symbol in needed:
            asset = self._require_asset(symbol)
            specs.append({"symbol": symbol, "url": asset.reference_url, "path": asset.price_path})

        def leader_fn():
            return _fetch_prices(specs)

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            return _compare_prices(leaders_res.calldata, leader_fn())

        prices = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        nav_before = int(portfolio.capital_atto)
        for symbol in held_symbols:
            position_key = portfolio_id + "|" + str(symbol)
            units = int(self.positions.get(position_key, u256(0)))
            price = int(prices.get(str(symbol), 0))
            if price <= 0:
                raise gl.vm.UserError(f"{ERROR_EXTERNAL} missing attested price for " + str(symbol))
            nav_before += units * price // ATTO
        if nav_before <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} portfolio holds no value")

        previous = json.loads(self._stored_weights(portfolio_id))
        turnover = 0
        for symbol in target_symbols:
            new_weight = int(allocation[symbol])
            old_weight = int(previous.get(symbol, 0))
            if new_weight > old_weight:
                turnover += new_weight - old_weight
            else:
                turnover += old_weight - new_weight
        for symbol in previous.keys():
            present = False
            for known in target_symbols:
                if known == symbol:
                    present = True
            if not present:
                turnover += int(previous[symbol])
        turnover = turnover // 2

        for symbol in held_symbols:
            self.positions[portfolio_id + "|" + str(symbol)] = u256(0)
        deployed = 0
        held_value = 0
        for symbol in target_symbols:
            price = int(prices.get(symbol, 0))
            if price <= 0:
                raise gl.vm.UserError(f"{ERROR_EXTERNAL} missing attested price for " + symbol)
            notional = nav_before * int(allocation[symbol]) // BPS
            units = notional * ATTO // price
            self.positions[portfolio_id + "|" + symbol] = u256(units)
            deployed += notional
            held_value += units * price // ATTO

        cash = nav_before - deployed
        nav_after = cash + held_value
        self.holdings[portfolio_id] = json.dumps(target_symbols)
        self.weights[portfolio_id] = json.dumps(allocation, sort_keys=True)
        portfolio.capital_atto = u256(cash)
        portfolio.nav_atto = u256(nav_after)
        portfolio.active_strategy_id = strategy_id
        portfolio.rebalances = portfolio.rebalances + u256(1)
        portfolio.last_mark_at = _now_iso()
        portfolio.status = "LIVE"
        self.portfolios[portfolio_id] = portfolio
        strategy.executions = strategy.executions + u256(1)
        self.strategies[strategy_id] = strategy

        proof_id = self._record_proof(
            "REBALANCE", portfolio_id, strategy_id, strategy.digest, _specs_digest(specs, prices),
            nav_before, nav_after, turnover, "ACCEPTED",
            "executed under validator-attested prices",
            evidence={
                "sources": _specs_evidence(specs, prices),
                "target_weights": allocation,
                "turnover_bps": str(turnover),
            },
        )
        return json.dumps({
            "proof_id": proof_id,
            "portfolio_id": portfolio_id,
            "strategy_id": strategy_id,
            "nav_before_atto": nav_before,
            "nav_after_atto": nav_after,
            "turnover_bps": turnover,
            "cash_atto": cash,
            "holdings": target_symbols,
        }, sort_keys=True)

    @gl.public.write
    def mark_to_market(self, portfolio_id: str) -> str:
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        held_symbols = json.loads(self._held_symbols(portfolio_id))
        if len(held_symbols) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} portfolio has no positions to mark")
        specs = []
        for symbol in held_symbols:
            asset = self._require_asset(str(symbol))
            specs.append({"symbol": str(symbol), "url": asset.reference_url, "path": asset.price_path})

        def leader_fn():
            return _fetch_prices(specs)

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            return _compare_prices(leaders_res.calldata, leader_fn())

        prices = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        nav_before = int(portfolio.nav_atto)
        nav_after = int(portfolio.capital_atto)
        for symbol in held_symbols:
            position_key = portfolio_id + "|" + str(symbol)
            units = int(self.positions.get(position_key, u256(0)))
            price = int(prices.get(str(symbol), 0))
            if price <= 0:
                raise gl.vm.UserError(f"{ERROR_EXTERNAL} missing attested price for " + str(symbol))
            nav_after += units * price // ATTO
        portfolio.nav_atto = u256(nav_after)
        portfolio.last_mark_at = _now_iso()
        self.portfolios[portfolio_id] = portfolio
        proof_id = self._record_proof(
            "MARK", portfolio_id, portfolio.active_strategy_id, "", _specs_digest(specs, prices),
            nav_before, nav_after, 0, "ACCEPTED", "consensus mark-to-market",
            evidence={"sources": _specs_evidence(specs, prices)},
        )
        return json.dumps({
            "proof_id": proof_id,
            "portfolio_id": portfolio_id,
            "nav_before_atto": nav_before,
            "nav_after_atto": nav_after,
        }, sort_keys=True)

    @gl.public.write
    def challenge_strategy(self, portfolio_id: str, strategy_id: str, reason: str) -> str:
        # Open dispute path: anyone can challenge a live allocation. The ruling
        # is an AI adjudication over the on-chain mandate, policy limits and the
        # challenger's argument, verified by an independent rerun.
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        strategy = self._require_strategy(strategy_id)
        if strategy.portfolio_id != portfolio_id:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} strategy does not belong to this portfolio")
        if strategy.status == "REVOKED":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} strategy is already revoked")
        if int(strategy.ruled) != 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} strategy already adjudicated")
        reason_text = str(reason).strip()
        if len(reason_text) < MIN_REASON_CHARS:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} challenge reason must state the case in at least "
                + str(MIN_REASON_CHARS) + " characters"
            )
        if len(reason_text) > MAX_REASON_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} challenge reason is too long")
        universe = self._pin_universe()
        allocation = json.loads(strategy.allocation_json)
        # Deterministic part of the ruling, computed before any model runs.
        hard_codes = _policy_breaches(allocation, portfolio.risk_profile, universe)
        prompt = _build_challenge_prompt(
            portfolio.mandate, portfolio.risk_profile, strategy.thesis,
            allocation, universe, reason_text, hard_codes,
        )

        def leader_fn():
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _normalize_verdict(raw, hard_codes)

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            return _compare_verdicts(leaders_res.calldata, leader_fn())

        ruling = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        verdict = str(ruling["verdict"])
        explanation = str(ruling["explanation"])
        violations = ruling["violations"]
        # One ruling per strategy, enforced by state: no second challenge can
        # re-litigate a settled allocation or flip the portfolio twice.
        strategy.ruled = u256(1)
        if verdict == "REVOKE":
            strategy.status = "REVOKED"
        self.strategies[strategy_id] = strategy
        if verdict == "REVOKE":
            if portfolio.active_strategy_id == strategy_id:
                portfolio.active_strategy_id = ""
                portfolio.status = "REVIEW"
                self.portfolios[portfolio_id] = portfolio
        proof_detail = verdict + ": " + explanation
        if len(violations) > 0:
            proof_detail = verdict + " [" + ",".join(violations) + "]: " + explanation
        proof_id = self._record_proof(
            "CHALLENGE", portfolio_id, strategy_id, strategy.digest, _sha(prompt),
            int(portfolio.nav_atto), int(portfolio.nav_atto), 0, verdict, proof_detail,
            evidence={
                "verdict": verdict,
                "violations": violations,
                "allocation": allocation,
                "prompt_digest": _sha(prompt),
            },
        )
        return json.dumps({
            "proof_id": proof_id,
            "strategy_id": strategy_id,
            "verdict": verdict,
            "violations": violations,
            "explanation": explanation,
        }, sort_keys=True)

    @gl.public.write
    def reopen_portfolio(self, portfolio_id: str, note: str) -> str:
        # Explicit recovery transition. A revoke parks the portfolio in REVIEW
        # with no active strategy; without this the only way forward would be
        # an implicit side effect of generating another strategy. The manager
        # or the owner states the case, and the transition is recorded.
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} vault is paused")
        portfolio = self._require_portfolio(portfolio_id)
        if gl.message.sender_address != portfolio.manager and gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the manager or owner can reopen a portfolio")
        if portfolio.status != "REVIEW":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} portfolio is not under review: " + portfolio.status)
        note_text = str(note).strip()
        if len(note_text) < MIN_REASON_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} reopen note is too short")
        if len(note_text) > MAX_REASON_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} reopen note is too long")
        portfolio.status = "LIVE"
        self.portfolios[portfolio_id] = portfolio
        self._record_proof(
            "REOPEN", portfolio_id, "", "", _sha(portfolio_id + "|" + note_text),
            int(portfolio.nav_atto), int(portfolio.nav_atto), 0, "ACCEPTED",
            "portfolio reopened: " + note_text,
            evidence={"note": note_text, "previous_status": "REVIEW"},
        )
        return json.dumps(self._portfolio_json(portfolio), sort_keys=True)

    # ------------------------------------------------------------------
    # Read surface
    # ------------------------------------------------------------------

    @gl.public.view
    def get_system_info(self) -> str:
        return json.dumps({
            "contract": "SynthForgeVault",
            "version": "1.0.0",
            "owner": self.owner.as_hex,
            "paused": bool(self.paused),
            "assets": len(self.asset_symbols),
            "portfolios": len(self.portfolio_ids),
            "strategies": len(self.strategy_ids),
            "proofs": len(self.proof_ids),
            "bps": BPS,
            "atto": ATTO,
            "price_tolerance_bps": PRICE_TOLERANCE_BPS,
            "max_weight_delta_bps": MAX_WEIGHT_DELTA_BPS,
            "max_l1_delta_bps": MAX_L1_DELTA_BPS,
            "min_reason_chars": MIN_REASON_CHARS,
            "caps": {
                "CONSERVATIVE": {"max_single_bps": _max_single_bps("CONSERVATIVE"), "max_high_bps": _max_high_bps("CONSERVATIVE")},
                "BALANCED": {"max_single_bps": _max_single_bps("BALANCED"), "max_high_bps": _max_high_bps("BALANCED")},
                "AGGRESSIVE": {"max_single_bps": _max_single_bps("AGGRESSIVE"), "max_high_bps": _max_high_bps("AGGRESSIVE")},
            },
        }, sort_keys=True)

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    @gl.public.view
    def list_assets(self) -> str:
        rows = []
        for symbol in self.asset_symbols:
            rows.append(self._asset_json(self.assets[symbol]))
        return json.dumps(rows, sort_keys=True)

    @gl.public.view
    def get_asset(self, symbol: str) -> str:
        return json.dumps(self._asset_json(self._require_asset(symbol)), sort_keys=True)

    @gl.public.view
    def list_portfolios(self) -> str:
        rows = []
        for portfolio_id in self.portfolio_ids:
            rows.append(self._portfolio_json(self.portfolios[portfolio_id]))
        return json.dumps(rows, sort_keys=True)

    @gl.public.view
    def get_portfolio(self, portfolio_id: str) -> str:
        return json.dumps(self._portfolio_json(self._require_portfolio(portfolio_id)), sort_keys=True)

    @gl.public.view
    def get_positions(self, portfolio_id: str) -> str:
        self._require_portfolio(portfolio_id)
        allocation = json.loads(self._stored_weights(portfolio_id))
        held_symbols = json.loads(self._held_symbols(portfolio_id))
        rows = []
        for symbol in held_symbols:
            key = portfolio_id + "|" + str(symbol)
            weight = int(allocation.get(str(symbol), 0))
            rows.append({
                "symbol": str(symbol),
                "weight_bps": weight,
                "units_atto": int(self.positions.get(key, u256(0))),
            })
        return json.dumps(rows, sort_keys=True)

    @gl.public.view
    def get_share_balance(self, portfolio_id: str, holder: Address) -> str:
        self._require_portfolio(portfolio_id)
        key = portfolio_id + "|" + holder.as_hex
        return str(int(self.share_ledger.get(key, u256(0))))

    @gl.public.view
    def list_strategies(self, portfolio_id: str) -> str:
        self._require_portfolio(portfolio_id)
        count = int(self.strategy_counter.get(portfolio_id, u256(0)))
        rows = []
        index = count - 1
        while index >= 0:
            strategy_id = self.strategy_index.get(portfolio_id + "|" + str(index), "")
            if strategy_id != "":
                if strategy_id in self.strategies:
                    rows.append(self._strategy_json(self.strategies[strategy_id]))
            index -= 1
        return json.dumps(rows, sort_keys=True)

    @gl.public.view
    def get_strategy(self, strategy_id: str) -> str:
        return json.dumps(self._strategy_json(self._require_strategy(strategy_id)), sort_keys=True)

    @gl.public.view
    def list_proofs(self, portfolio_id: str) -> str:
        self._require_portfolio(portfolio_id)
        count = int(self.proof_counter.get(portfolio_id, u256(0)))
        rows = []
        index = count - 1
        while index >= 0:
            proof_id = self.proof_index.get(portfolio_id + "|" + str(index), "")
            if proof_id != "":
                if proof_id in self.proofs:
                    rows.append(self._proof_json(self.proofs[proof_id]))
            index -= 1
        return json.dumps(rows, sort_keys=True)

    @gl.public.view
    def get_proof(self, proof_id: str) -> str:
        if proof_id not in self.proofs:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} unknown proof: {proof_id}")
        return json.dumps(self._proof_json(self.proofs[proof_id]), sort_keys=True)

    @gl.public.view
    def preview_prompt(self, portfolio_id: str, thesis: str, horizon_days: u256) -> str:
        # Transparency endpoint: the exact prompt validators will judge.
        portfolio = self._require_portfolio(portfolio_id)
        universe = self._pin_universe()
        return _build_strategy_prompt(
            portfolio_id, portfolio.mandate, portfolio.risk_profile,
            int(horizon_days), str(thesis).strip(), universe,
        )


# End of SynthForgeVault

