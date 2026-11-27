"""
La caccia (hunt.py): every combination is generated, the best is tried first, a verb or object that
brings nothing is dropped, a winning combination is expanded with Google's suggestions, every paid
call counts against the budget, a search already done is never paid again, sellers are not leads.
And the API: estimate -> one-time token -> job -> live view -> stop. No network.
"""

import os
import tempfile
import time
import unittest

import hunt
from buyerml_store import Store

BUYER = "Stiamo cercando uno sviluppatore Laravel per il nostro gestionale, budget 4000 euro"
SELLER = "Sono uno sviluppatore Laravel, realizzo gestionali su misura, contattami"


def fake_search(posts_for):
    calls = []

    def search(query):
        calls.append(query)
        return [{"url": f"https://www.facebook.com/groups/g/posts/{abs(hash((query, i))) % 10**8}", "title": "", "snippet": t}
                for i, t in enumerate(posts_for(query))] + [{"url": "https://example.com/x", "title": "", "snippet": BUYER}]
    search.calls = calls
    return search


class Combinations(unittest.TestCase):
    def test_every_verb_with_every_object(self):
        h = hunt.Hunt("Laravel", 10, fake_search(lambda q: []), lambda s: [])
        objects = hunt.related_objects("Laravel")
        self.assertEqual(len(h.combos), len(hunt.VERBS) * len(objects))
        self.assertEqual(objects[0], ("Laravel", "seed"))
        self.assertIn(("sviluppatore Laravel", "ruolo"), objects)

    def test_a_role_is_not_wrapped_in_another_role(self):
        self.assertNotIn("sviluppatore sviluppatore Laravel", [o for o, _ in hunt.related_objects("sviluppatore Laravel")])

    def test_empty_seed_is_refused(self):
        with self.assertRaises(ValueError):
            hunt.Hunt("  ", 10, fake_search(lambda q: []), lambda s: [])


class Budget(unittest.TestCase):
    def test_searches_and_suggestions_together_never_pass_the_budget(self):
        search = fake_search(lambda q: [BUYER])
        suggested = []
        h = hunt.Hunt("Laravel", 15, search, lambda s: suggested.append(s) or [f"{s} developer", f"{s} freelance"])
        h.run()
        self.assertEqual(len(search.calls) + len(suggested), 15)
        self.assertLessEqual(len(suggested), max(1, int(15 * hunt.AUTOCOMPLETE_SHARE)))
        self.assertEqual(h.spent, {"searches": len(search.calls), "autocomplete": len(suggested)})

    def test_a_search_already_done_is_not_paid_again(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(os.path.join(d, "t.db"))
            first = hunt.Hunt("Laravel", 5, fake_search(lambda q: []), lambda s: [], store=store)
            first.run()
            done = {c.query for c in first.combos.values() if c.status == "provata"}
            search = fake_search(lambda q: [])
            again = hunt.Hunt("Laravel", 5, search, lambda s: [], store=store)
            again.run()
            self.assertFalse(done & set(search.calls))
            self.assertEqual({c.query for c in again.combos.values() if c.status == "già fatta"}, done)
            store.close()

    def test_stop_ends_the_hunt(self):
        h = hunt.Hunt("Laravel", 50, fake_search(lambda q: []), lambda s: [])
        h.stop_requested = True
        self.assertEqual(h.run()["status"], "fermata")
        self.assertEqual(h.spent["searches"], 0)


class Learning(unittest.TestCase):
    def test_leads_are_buyers_only_and_counted_once(self):
        h = hunt.Hunt("Laravel", 6, fake_search(lambda q: [BUYER, SELLER, BUYER]), lambda s: [])
        h.run()
        self.assertEqual(len(h.leads), 1)               # the same post under other URLs, and the seller, are not new leads
        lead = next(iter(h.leads.values()))
        self.assertEqual(lead["text"], BUYER)
        self.assertGreaterEqual(lead["score"], 66)

    def test_results_outside_facebook_are_not_read(self):
        h = hunt.Hunt("Laravel", 3, fake_search(lambda q: []), lambda s: [])
        h.run()
        self.assertEqual(len(h.leads), 0)

    def test_an_object_with_no_leads_is_dropped_and_its_combinations_abandoned(self):
        h = hunt.Hunt("Laravel", 40, fake_search(lambda q: [BUYER] if '"Laravel"' in q else []), lambda s: [])
        h.run()
        backend = h.objects["backend"]
        if backend.searches:
            self.assertTrue(backend.dropped or backend.searches < hunt.DROP_OBJECT_AFTER)
        self.assertTrue(any(o.dropped for o in h.objects.values()))
        self.assertIn("abbandonata", {c.status for c in h.combos.values()})

    def test_the_winner_is_tried_before_the_others(self):
        h = hunt.Hunt("Laravel", 12, fake_search(lambda q: [BUYER] if '"Laravel"' in q else []), lambda s: [])
        h.run()
        laravel = [c for c in h.combos.values() if c.obj == "Laravel"]
        self.assertTrue(all(c.status == "provata" for c in laravel))

    def test_a_winning_combination_is_expanded_with_the_suggestions_that_start_with_a_verb(self):
        asked = []

        def ac(phrase):
            asked.append(phrase)
            return [f"{phrase} developer remoto", "laravel tutorial italiano", f"{phrase}?"]
        h = hunt.Hunt("Laravel", 10, fake_search(lambda q: [BUYER]), ac)
        h.run()
        self.assertEqual(asked[0], "stiamo cercando Laravel")
        self.assertIn("laravel developer remoto", h.objects)
        self.assertNotIn("laravel tutorial italiano", h.objects)

    def test_google_echoing_itself_is_not_a_new_object(self):
        h = hunt.Hunt("Laravel", 10, fake_search(lambda q: [BUYER]), lambda p: [f"{p} per pmi", f"{p} per pmi per pmi"])
        h.run()
        self.assertFalse([o for o in h.objects if hunt._repeats(o)])

    def test_snapshot_lists_combinations_leads_and_events(self):
        h = hunt.Hunt("Laravel", 4, fake_search(lambda q: [BUYER]), lambda s: [])
        h.run()
        s = h.snapshot()
        self.assertEqual(s["status"], "finita")
        self.assertEqual(s["combos_list"][0]["status"], "provata")
        self.assertTrue(s["lead_list"] and s["events"])
        self.assertEqual(sum(s["by_status"].values()), s["combos"])


class Goals(unittest.TestCase):
    JOB_AD = "Assumiamo sviluppatore Laravel, contratto a tempo indeterminato, inviare CV"

    def test_a_job_ad_is_not_a_client(self):
        h = hunt.Hunt("Laravel", 4, fake_search(lambda q: [self.JOB_AD, BUYER]), lambda s: [])
        h.run()
        self.assertEqual([l["text"] for l in h.leads.values()], [BUYER])

    def test_the_job_goal_keeps_the_job_ads_only(self):
        h = hunt.Hunt("Laravel", 4, fake_search(lambda q: [self.JOB_AD, BUYER]), lambda s: [], goal="lavoro")
        h.run()
        self.assertEqual([l["lead_class"] for l in h.leads.values()], ["lavoro_it"])
        self.assertEqual(list(h.verbs), list(hunt.GOALS["lavoro"]["verbs"]))

    def test_a_word_outside_it_gets_no_role_forms(self):
        self.assertEqual(hunt.related_objects("cameriere"), [("cameriere", "seed")])

    def test_unknown_goal(self):
        with self.assertRaises(ValueError):
            hunt.Hunt("Laravel", 4, fake_search(lambda q: []), lambda s: [], goal="boh")


class Suggestions(unittest.TestCase):
    def test_without_history_the_common_requests_come_first(self):
        s = hunt.suggest_seeds()
        self.assertEqual(len(s), hunt.SUGGESTIONS)
        self.assertEqual({x["source"] for x in s}, {"lista"})

    def test_winners_and_asked_technologies_come_before_the_list_and_hunted_seeds_are_left_out(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(os.path.join(d, "t.db"))
            hunt.Hunt("Laravel", 6, fake_search(lambda q: [BUYER] if '"sviluppatore Laravel"' in q else []),
                      lambda s: [], store=store).run()
            s = hunt.suggest_seeds(store)
            seeds = [x["seed"].lower() for x in s]
            self.assertNotIn("laravel", seeds)                       # already hunted
            self.assertEqual(s[0]["seed"], "sviluppatore Laravel")   # it brought the lead
            self.assertEqual(s[0]["source"], "vincente")
            self.assertIn("1 lead", s[0]["reason"])
            sources = [x["source"] for x in s]
            self.assertEqual(sources, sorted(sources, key=["vincente", "dai post", "lista"].index))
            store.close()

    def test_a_job_ad_or_a_word_outside_it_is_not_suggested(self):
        ad = "Cercasi talenti per la nostra azienda, assumiamo personale"
        with tempfile.TemporaryDirectory() as d:
            store = Store(os.path.join(d, "t.db"))
            hunt.Hunt("Laravel", 6, fake_search(lambda q: [ad]), lambda s: [], store=store).run()
            self.assertEqual({x["source"] for x in hunt.suggest_seeds(store)}, {"lista"})
            store.close()

    def test_a_seller_post_suggests_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(os.path.join(d, "t.db"))
            hunt.Hunt("Laravel", 4, fake_search(lambda q: [SELLER]), lambda s: [], store=store).run()
            self.assertEqual({x["source"] for x in hunt.suggest_seeds(store)}, {"lista"})
            store.close()


try:
    from fastapi.testclient import TestClient
except ImportError:      # pragma: no cover
    TestClient = None


@unittest.skipUnless(TestClient, "fastapi not installed (pip install -r requirements.txt)")
class HuntApi(unittest.TestCase):
    def setUp(self):
        import api
        import demo_data
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        app = api.create_app(db_path=os.path.join(self.tmp.name, "demo.db"), demo=True,
                             engine_client_factory=lambda: demo_data.DemoEngineClient(delay_s=0),
                             externals_factory=lambda: demo_data.demo_externals(delay_s=0))
        self.client = TestClient(app)

    def test_estimate_confirm_follow(self):
        est = self.client.post("/api/hunt/estimate", json={"seed": "Laravel", "budget": 8}).json()
        self.assertTrue(est["confirm_token"] and est["combos"] > 0 and est["simulated"])
        job = self.client.post("/api/hunt", json={"seed": "Laravel", "budget": 8, "confirm_token": est["confirm_token"]}).json()
        for _ in range(200):
            view = self.client.get(f"/api/hunt/{job['id']}").json()
            if view["job"]["status"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(view["job"]["status"], "done", view["job"]["error"])
        self.assertEqual(sum(view["hunt"]["spent"].values()), 8)
        # the token is used once
        again = self.client.post("/api/hunt", json={"seed": "Laravel", "budget": 8, "confirm_token": est["confirm_token"]})
        self.assertEqual(again.status_code, 409)

    def test_the_token_is_for_that_seed_and_budget(self):
        est = self.client.post("/api/hunt/estimate", json={"seed": "Laravel", "budget": 8}).json()
        r = self.client.post("/api/hunt", json={"seed": "Laravel", "budget": 80, "confirm_token": est["confirm_token"]})
        self.assertEqual(r.status_code, 409)

    def test_the_token_is_for_that_goal(self):
        est = self.client.post("/api/hunt/estimate", json={"seed": "Laravel", "budget": 8, "goal": "lavoro"}).json()
        self.assertEqual(est["goal"], "lavoro")
        r = self.client.post("/api/hunt", json={"seed": "Laravel", "budget": 8, "confirm_token": est["confirm_token"]})
        self.assertEqual(r.status_code, 409)

    def test_suggestions(self):
        s = self.client.get("/api/hunt/suggestions").json()["suggestions"]
        self.assertTrue(s and all(x["seed"] and x["reason"] for x in s))

    def test_bad_input(self):
        self.assertEqual(self.client.post("/api/hunt/estimate", json={"seed": " ", "budget": 8}).status_code, 400)
        self.assertEqual(self.client.post("/api/hunt/estimate", json={"seed": "x", "budget": 0}).status_code, 400)
        self.assertEqual(self.client.get("/api/hunt/nope").status_code, 404)
        self.assertEqual(self.client.post("/api/hunt/nope/stop").status_code, 404)


if __name__ == "__main__":
    unittest.main()
