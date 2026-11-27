"""Lead AI Generate — Demand Hunter service (wraps the original BuyerML engine without changing it)."""
import os
import sys

# The original BuyerML modules use flat imports (`import demand`): their directory goes on the path.
BUYERML_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "buyerml")
if BUYERML_DIR not in sys.path:
    sys.path.insert(0, BUYERML_DIR)
