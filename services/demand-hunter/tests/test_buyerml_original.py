"""Runs the ORIGINAL BuyerML tests of the integrated modules (hunt, demand, learning, areas), unchanged.

Excluded only the *Api classes: they test BuyerML's own monolithic api.py, which is not part of this service
(its role is taken by app/main.py, tested in test_service.py).
"""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("MOCK_MODE", "true")

from app import BUYERML_DIR  # noqa: E402,F401

import test_areas  # noqa: E402
import test_demand  # noqa: E402
import test_hunt  # noqa: E402
import test_learning  # noqa: E402

EXCLUDED = {"HuntApi", "LearningApi", "AreasApi"}


def load_tests(loader: unittest.TestLoader, tests, pattern):
    suite = unittest.TestSuite()
    for mod in (test_demand, test_hunt, test_learning, test_areas):
        for name in dir(mod):
            obj = getattr(mod, name)
            if isinstance(obj, type) and issubclass(obj, unittest.TestCase) and obj.__module__ == mod.__name__ \
                    and name not in EXCLUDED:
                suite.addTests(loader.loadTestsFromTestCase(obj))
    return suite
