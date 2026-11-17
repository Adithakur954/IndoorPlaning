"""Stage an isolated CPython runtime and worker dependencies; never copy a venv launcher."""
from pathlib import Path
import json
import shutil
import sys
import zipfile

root, destination, archive = map(Path, sys.argv[1:])
runtime = destination / "runtime" / "python"
runtime.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    for name in bundle.namelist():
        if not (runtime / name).resolve().is_relative_to(runtime.resolve()):
            raise ValueError("Unsafe Python archive member")
    bundle.extractall(runtime)
site = root / "worker" / ".venv" / "Lib" / "site-packages"
if not site.is_dir():
    raise RuntimeError("Build requires the worker virtual environment with installed dependencies")
ignored = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "tests", "test", ".git", "pip", "pip-*", "setuptools", "setuptools-*", "_distutils_hack")
shutil.copytree(site, runtime / "Lib" / "site-packages", ignore=ignored, dirs_exist_ok=True)
version = f"python{sys.version_info.major}{sys.version_info.minor}"
if version != "python313":
    raise RuntimeError("This Windows packager currently targets CPython 3.13 x64")
(runtime / f"{version}._pth").write_text(f"{version}.zip\n.\nLib/site-packages\n../../worker\nimport site\n", encoding="utf-8")
for package in ["floorplan", "sionna_worker"]:
    shutil.copytree(root / "worker" / package, destination / "worker" / package, ignore=ignored, dirs_exist_ok=True)
model = root / "worker" / "models" / "floorplan_unet_run5.onnx"
if not model.is_file():
    raise RuntimeError("Required floor-plan model is missing")
(destination / "worker" / "models").mkdir(parents=True, exist_ok=True)
shutil.copy2(model, destination / "worker" / "models" / model.name)
llvm = root / "worker" / ".llvm" / "Library" / "bin"
target = destination / "worker" / ".llvm" / "Library" / "bin"
target.mkdir(parents=True, exist_ok=True)
if not (llvm / "LLVM-C.dll").is_file():
    raise RuntimeError("Required LLVM CPU backend is missing")
runtime_dlls = {"llvm-c.dll", "zlib.dll", "zstd.dll", "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "ucrtbase.dll"}
for dll in llvm.glob("*.dll"):
    if dll.name.lower() in runtime_dlls or dll.name.lower().startswith("api-ms-"):
        shutil.copy2(dll, target / dll.name)
# Preserve upstream notices shipped with the runtime and native LLVM distribution.
notices = destination / "THIRD_PARTY_NOTICES"
notices.mkdir(exist_ok=True)
for source in [root / "worker" / ".llvm" / "info" / "licenses", root / "worker" / ".llvm" / "Library" / "share" / "licenses"]:
    if source.is_dir():
        shutil.copytree(source, notices / source.parent.name, dirs_exist_ok=True)
print(json.dumps({"pythonRuntime": str(runtime), "modelIncluded": model.name}))
