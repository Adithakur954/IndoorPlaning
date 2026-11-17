"""End-to-end check of the optimisation API against a running service.

    python scripts/e2e-optimize.py http://127.0.0.1:3002 worker/samples/benchmark-4floor

The directory must hold an exported scene and optimize-job.json (see
`node scripts/export-scene.mjs <dir> benchmark --job`).
"""
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

base, scene_dir = sys.argv[1], Path(sys.argv[2])


def call(method, path, body=None, raw=False):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"content-type": "application/zip" if raw else "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def zip_scene():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(scene_dir.rglob("*")):
            rel = f.relative_to(scene_dir).as_posix()
            if f.is_file() and (rel in ("scene.xml", "scene_config.json") or rel.startswith("meshes/")):
                z.write(f, rel)
    return buf.getvalue()


job = json.loads((scene_dir / "optimize-job.json").read_text())
status, scene = call("POST", "/api/scenes", zip_scene(), raw=True)
assert status == 200, scene
print("scene", scene["sceneId"][:12], scene)
body = {
    "sceneId": scene["sceneId"],
    "profile": job["profile"],
    "candidates": job["candidates"],
    "settings": {"band": job["band"], "thresholdDbm": -67, "targetCoveragePct": 95,
                 "existingHandling": "ignore", "resolutionM": 1.0},
}

# 1. validation errors are 400s
bad = {**body, "settings": {**body["settings"], "thresholdDbm": 5}}
print("bad threshold ->", call("POST", "/api/optimizations", bad)[0])
assert call("POST", "/api/optimizations", bad)[0] == 400

# 2. run, watch progress
status, sub = call("POST", "/api/optimizations", body)
print("submit", status, sub)
assert status == 200
seen = set()
t0 = time.time()
while True:
    _, st = call("GET", f"/api/optimizations/{sub['id']}")
    if st.get("progress"):
        seen.add(st["progress"]["stage"])
    if st["status"] in ("done", "failed", "cancelled") or time.time() - t0 > 300:
        break
    time.sleep(0.4)
print("final", st["status"], "stages seen:", sorted(seen), f"{time.time() - t0:.1f}s")
assert st["status"] == "done", st
res = st["result"]
print(res["outcome"]["message"])
assert res["outcome"]["targetAchieved"]
status, m = call("GET", f"/api/optimizations/{sub['id']}/maps/{res['maps'][0]['file'].split('/')[-1]}")
assert status == 200 and "afterDbm" in m

# 3. identical request is a cache hit
status, again = call("POST", "/api/optimizations", body)
print("resubmit", again)
assert again["cached"] is True

# 4. cancel a long run
slow = {**body, "settings": {**body["settings"], "samplesPerTx": 60_000_000, "screeningSamples": 20_000_000,
                              "resolutionM": 0.5, "seed": 7}}
status, sub2 = call("POST", "/api/optimizations", slow)
time.sleep(3)
print("cancel ->", call("POST", f"/api/jobs/{sub2['id']}/cancel"))
time.sleep(1.5)
_, st2 = call("GET", f"/api/optimizations/{sub2['id']}")
print("after cancel:", st2["status"])
assert st2["status"] == "cancelled", st2
print("OK")
