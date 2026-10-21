#!/usr/bin/env python3
"""DSP control-plane checks for api_bridge.py.

    python3 tests/test_dsp_bridge.py

Covers module discovery, live parameter updates, preset aliases, block-size
configuration and the performance payload used by the console speedometer.
"""

from __future__ import annotations

import os
import sys
import traceback

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_bridge import app  # noqa: E402

CHECKS = 0
FAILED = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS, FAILED
    CHECKS += 1
    if not condition:
        FAILED += 1
        print(f"FAIL {label}{f': {detail}' if detail else ''}")


def main() -> int:
    global FAILED
    client = TestClient(app)
    try:
        modules = client.get("/api/dsp/modules")
        check("modules: 200", modules.status_code == 200, modules.text)
        body = modules.json()
        check("modules: 43 modules", len(body["modules"]) == 43, str(len(body["modules"])))
        check("modules: presets present", len(body["presets"]) >= 6)
        check("modules: unique ids", len({m["id"] for m in body["modules"]}) == 43)
        check(
            "modules: every module has category/params",
            all(m["category"] and isinstance(m["params"], dict) for m in body["modules"]),
        )

        update = client.post(
            "/api/dsp/set-value",
            json={"module": "noise_adaptive_hiss", "param": "reduction_db", "value": 9},
        )
        check("set-value: 200", update.status_code == 200, update.text)
        check("set-value: echoes value", update.json()["value"] == 9.0)

        bypass = client.post(
            "/api/dsp/set-value",
            json={"module": "noise_adaptive_hiss", "param": "bypassed", "value": False},
        )
        check("set-value: bypass update", bypass.status_code == 200 and bypass.json()["value"] is False)

        unknown = client.post(
            "/api/dsp/set-value",
            json={"module": "not_a_module", "param": "x", "value": 1},
        )
        check("set-value: unknown module 404", unknown.status_code == 404)
        invalid = client.post(
            "/api/dsp/set-value",
            json={"module": "noise_adaptive_hiss", "param": "hf_hz", "value": 999999},
        )
        check("set-value: value clamped", invalid.status_code == 200 and invalid.json()["value"] == 12000.0)

        preset = client.post(
            "/api/dsp/load-preset",
            json={"name": "OFCOM-FM-TRANSMIT", "morph_time": 3},
        )
        check("preset: 200", preset.status_code == 200, preset.text)
        check("preset: alias resolves", preset.json()["canonical"] == "FM-Reference")
        check("preset: morph clamped", preset.json()["morph_time"] == 3.0)
        after = {m["id"]: m for m in client.get("/api/dsp/modules").json()["modules"]}
        check("preset: pre-emphasis enabled", after["pre_emphasis_filter"]["bypassed"] is False)

        config = client.post("/api/dsp/config", json={"block_size": 2048})
        check("config: 200", config.status_code == 200 and config.json()["block_size"] == 2048)
        perf = client.get("/api/status/performance")
        check("perf: 200", perf.status_code == 200, perf.text)
        payload = perf.json()
        for key in (
            "realtime_factor",
            "cpu_dsp_pct",
            "block_size",
            "latency_ms",
            "dropped_blocks",
            "state",
            "modules",
        ):
            check(f"perf: {key}", key in payload)
        check("perf: block size applied", payload["block_size"] == 2048)
        check("perf: 43 modules", payload["modules"] == 43)
        check("perf: factor non-negative", payload["realtime_factor"] >= 0)
        check("perf: state valid", payload["state"] in ("live", "lagging", "offline"))
    except Exception:
        FAILED += 1
        traceback.print_exc()
    print(f"{CHECKS} checks passed, {FAILED} failed.")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
