"""
Quello che la caccia impara (learning.py): every hunt, try and post is written down; your verdicts override the
rules; the lead rates per verb, object and pattern come back as gentle priors. Nothing here calls Google.
"""

import os
import tempfile
import unittest

import hunt
import learning
from buyerml_store import Store

BUYER = "Stiamo cercando uno sviluppatore Laravel per il nostro gestionale, budget 4000 euro"


def search_for(posts_for):
    def search(q):
        return [{"url": f"https://www.facebook.com/groups/g/posts/{abs(hash((q, i))) % 10**8}", "title": "", "snippet": t}
                for i, t in enumerate(posts_for(q))]
    return search


class Learning(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(os.path.join(self.tmp.name, "t.db"))
        self.addCleanup(self.store.close)

    def test_patterns(self):
        self.assertEqual(learning.pattern_of("sviluppatore Laravel")[1], "ruolo + tecnologia")
        self.assertEqual(learning.pattern_of("CRM")[1], "prodotto")
        self.assertEqual(learning.pattern_of("sviluppatore")[1], "ruolo")

    def test_a_hunt_is_written_down(self):
        h = hunt.Hunt("Laravel", 5, search_for(lambda q: [BUYER] if '"Laravel"' in q else ["Secondo voi Laravel è morto?"]),
                      lambda s: [], store=self.store)
        h.run()
        run = self.store.db.execute("SELECT * FROM hunt_runs").fetchone()
        self.assertEqual((run["seed"], run["status"], run["leads"]), ("Laravel", "finita", len(h.leads)))
        tries = self.store.db.execute("SELECT COUNT(*) FROM hunt_tries").fetchone()[0]
        self.assertEqual(tries, h.spent["searches"])
        s = learning.stats(self.store, "clienti")
        self.assertEqual(s["totals"]["searches"], h.spent["searches"])
        laravel = next(o for o in s["objects"] if o["key"] == "Laravel")
        self.assertGreater(laravel["rate"], 0)

    def test_a_wrong_verdict_removes_the_lead_and_a_right_one_adds_it(self):
        h = hunt.Hunt("Laravel", 2, search_for(lambda q: [BUYER]), lambda s: [], store=self.store)
        h.run()
        url = next(iter(h.leads))
        before = learning.stats(self.store, "clienti")["totals"]["leads"]
        learning.set_feedback(self.store, url, "clienti", "sbagliato")
        after = learning.stats(self.store, "clienti")
        self.assertEqual(after["totals"]["leads"], before - 1)
        self.assertEqual(after["totals"]["feedback"], {"sbagliato": 1})
        learning.set_feedback(self.store, url, "clienti", None)
        self.assertEqual(learning.stats(self.store, "clienti")["totals"]["leads"], before)
        with self.assertRaises(ValueError):
            learning.set_feedback(self.store, url, "clienti", "forse")

    def test_history_raises_what_converted(self):
        posts = lambda q: [BUYER] if '"stiamo cercando"' in q else []
        hunt.Hunt("Laravel", 15, search_for(posts), lambda s: [], store=self.store).run()
        p = learning.priors(self.store, "clienti")
        self.assertGreater(p["verbs"]["stiamo cercando"], 1.0)
        self.assertTrue(all(v <= 1.0 for k, v in p["verbs"].items() if k != "stiamo cercando"))
        nxt = hunt.Hunt("Python", 5, search_for(lambda q: []), lambda s: [], store=self.store)
        self.assertGreater(nxt.verbs["stiamo cercando"].prior, nxt.verbs["sto cercando"].prior)

    def test_backfill_reads_the_old_hunts_once(self):
        h = hunt.Hunt("Laravel", 3, search_for(lambda q: [BUYER]), lambda s: [], store=self.store)
        h.run()
        self.store.db.execute("DELETE FROM hunt_tries")
        self.store.db.execute("DELETE FROM hunt_posts")
        self.assertEqual(learning.backfill(self.store), h.spent["searches"])
        self.assertEqual(learning.backfill(self.store), 0)


try:
    from fastapi.testclient import TestClient
except ImportError:      # pragma: no cover
    TestClient = None


@unittest.skipUnless(TestClient, "fastapi not installed")
class LearningApi(unittest.TestCase):
    def test_feedback_and_stats(self):
        import api
        import demo_data
        with tempfile.TemporaryDirectory() as d:
            app = api.create_app(db_path=os.path.join(d, "demo.db"), demo=True,
                                 engine_client_factory=lambda: demo_data.DemoEngineClient(delay_s=0),
                                 externals_factory=lambda: demo_data.demo_externals(delay_s=0))
            c = TestClient(app)
            self.assertEqual(c.post("/api/learning/clienti/feedback", json={"url": "u", "verdict": "giusto"}).status_code, 200)
            self.assertEqual(c.post("/api/learning/clienti/feedback", json={"url": "u", "verdict": "boh"}).status_code, 400)
            s = c.get("/api/learning/clienti").json()
            self.assertEqual(s["totals"]["feedback"], {"giusto": 1})
            self.assertEqual(c.get("/api/learning/boh").status_code, 404)


if __name__ == "__main__":
    unittest.main()
