"""Loads a pickle with an allow-list, so a tampered download cannot run code.

ResPlan.pkl only needs shapely's WKB reader and numpy scalars; anything else
raises instead of being imported.
"""
import pickle

ALLOWED = {
    ("shapely.io", "from_wkb"),
    ("numpy._core.multiarray", "scalar"),
    ("numpy.core.multiarray", "scalar"),
    ("numpy", "dtype"),
    ("numpy", "ndarray"),
    ("numpy._core.multiarray", "_reconstruct"),
    ("numpy.core.multiarray", "_reconstruct"),
    ("builtins", "set"),
    ("builtins", "frozenset"),
    ("collections", "OrderedDict"),
}


class _Restricted(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) in ALLOWED:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"blocked: {module}.{name}")


def load(path):
    with open(path, "rb") as f:
        return _Restricted(f).load()
