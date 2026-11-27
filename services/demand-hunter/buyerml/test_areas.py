"""
Le aree di mercato (areas.py): the goal's tree from the starting vocabulary, the discovered terms under their
parent, the hunts already done per node, the expansion with Google's suggestions (cleaned, saved, expandable again).
"""

import os
import tempfile
import unittest

import areas
import hunt
from buyerml_store import Store


def labels(node):
    return [c["label"] for c in node["children"]]


class Tree(unittest.TestCase):
    def test_both_goals_start_from_the_vocabulary(self):
        clienti = areas.tree("clienti")
        self.assertIn("Cybersecurity", labels(clienti))
        sec = areas.find(clienti, "Security operations")
        self.assertIn("SIEM", labels(sec))
        self.assertEqual(areas.find(clienti, "SIEM")["rel"], "prodotto")
        lavoro = areas.tree("lavoro")
        self.assertIn("Lavoro IT", labels(lavoro))
        self.assertIn("Ristorazione e turismo", labels(lavoro))

    def test_every_relation_is_a_known_kind(self):
        data = areas.load()
        known = set(data["relations"])

        def walk(n):
            for c in n.get("children", []):
                self.assertIn(c["rel"], known, c["label"])
                walk(c)
        for g in data["goals"].values():
            walk(g)

    def test_unknown_goal(self):
        with self.assertRaises(ValueError):
            areas.tree("boh")


class Expansion(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(os.path.join(self.tmp.name, "t.db"))
        self.addCleanup(self.store.close)

    def test_suggestions_are_cleaned_and_saved_under_their_node(self):
        asked = []

        def ac(phrase):
            asked.append(phrase)
            return ["siem open source", "siem cos'è", "cerco siem per pmi", "siem corso", "SOC", "wazuh", "siem lavoro", "software cerco siem"]
        out = areas.expand("clienti", "SIEM", ac, self.store)
        self.assertEqual(asked, ["SIEM", "cerco SIEM"])
        self.assertEqual([a["label"] for a in out["added"]], ["siem open source", "siem per pmi", "wazuh"])
        self.assertEqual({a["label"]: a["rel"] for a in out["added"]}["wazuh"], "correlato")
        siem = areas.find(areas.tree("clienti", self.store), "SIEM")
        self.assertIn("wazuh", labels(siem))
        self.assertEqual(areas.find(siem, "wazuh")["source"], "autocomplete")

    def test_a_discovered_term_can_be_expanded_again(self):
        areas.expand("clienti", "SIEM", lambda p: ["wazuh"], self.store)
        areas.expand("clienti", "wazuh", lambda p: ["wazuh docker"], self.store)
        wazuh = areas.find(areas.tree("clienti", self.store), "wazuh")
        self.assertEqual(labels(wazuh), ["wazuh docker"])

    def test_the_job_goal_drops_prices_and_keeps_roles(self):
        out = areas.expand("lavoro", "Cuoco", lambda p: ["cercasi cuoco milano", "cuoco prezzo", "cercasi aiuto cuoco"], self.store)
        self.assertEqual([a["label"] for a in out["added"]], ["cuoco milano", "aiuto cuoco"])

    def test_hunts_done_are_counted_on_their_node(self):
        buyer = "Stiamo cercando uno sviluppatore Laravel per il nostro gestionale, budget 4000 euro"

        def search(q):
            return [{"url": f"https://www.facebook.com/groups/g/posts/{abs(hash(q)) % 10**8}", "title": "", "snippet": buyer}]
        h = hunt.Hunt("Laravel", 3, search, lambda s: [], store=self.store)
        h.run()
        laravel = areas.find(areas.tree("clienti", self.store), "Laravel")
        self.assertEqual(laravel["hunted"], h.spent["searches"])
        self.assertEqual(laravel["leads"], 1)


try:
    from fastapi.testclient import TestClient
except ImportError:      # pragma: no cover
    TestClient = None


@unittest.skipUnless(TestClient, "fastapi not installed")
class AreasApi(unittest.TestCase):
    def setUp(self):
        import api
        import demo_data
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        app = api.create_app(db_path=os.path.join(self.tmp.name, "demo.db"), demo=True,
                             engine_client_factory=lambda: demo_data.DemoEngineClient(delay_s=0),
                             externals_factory=lambda: demo_data.demo_externals(delay_s=0))
        self.client = TestClient(app)

    def test_tree_estimate_confirm(self):
        self.assertEqual(self.client.get("/api/areas/clienti").json()["label"], "Clienti per la mia software house")
        self.assertEqual(self.client.get("/api/areas/boh").status_code, 404)
        est = self.client.post("/api/areas/clienti/expand/estimate", json={"label": "Chatbot"}).json()
        self.assertEqual(est["calls"], 2)
        r = self.client.post("/api/areas/clienti/expand", json={"label": "Chatbot", "confirm_token": est["confirm_token"]})
        self.assertEqual(r.status_code, 200, r.text)
        again = self.client.post("/api/areas/clienti/expand", json={"label": "Chatbot", "confirm_token": est["confirm_token"]})
        self.assertEqual(again.status_code, 409)


if __name__ == "__main__":
    unittest.main()
