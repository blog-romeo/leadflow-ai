"""
Reading the demand (demand.py): the taxonomy is a valid tree, sellers / job seekers / learners are never leads,
a technical word alone scores nothing, the evidence is copied from the text, a model's answer is cleaned of
inventions, and the rules keep their measured precision on the labelled posts (eval_demand.py).
"""

import json
import os
import unittest

import demand
import eval_demand
from demand import from_model, load_taxonomy, read

HERE = os.path.dirname(os.path.abspath(__file__))


class TaxonomyTree(unittest.TestCase):
    def setUp(self):
        self.tax = load_taxonomy()

    def test_every_parent_exists_and_there_is_one_root(self):
        roots = [n for n in self.tax.nodes.values() if n["parent"] is None]
        self.assertEqual([r["id"] for r in roots], ["it"])
        for n in self.tax.nodes.values():
            if n["parent"]:
                self.assertIn(n["parent"], self.tax.nodes, n["id"])

    def test_no_cycles_and_market_ids_are_the_seed_markets(self):
        with open(os.path.join(HERE, "seed", "seed.json"), encoding="utf-8") as f:
            seed_markets = {m["id"] for m in json.load(f)["markets"]}
        for nid in self.tax.nodes:
            self.assertLess(len(self.tax.path(nid)), 10, nid)
            mid = self.tax.nodes[nid].get("market_id")
            if mid:
                self.assertIn(mid, seed_markets, nid)

    def test_covers_the_requested_areas(self):
        for nid in ("software", "web", "mobile", "saas", "ai", "ml", "ai.genai.llm", "ai.agents", "ai.chatbot", "data.science",
                    "data.engineering", "automation", "automation.rpa", "integration", "blockchain", "blockchain.web3",
                    "blockchain.web3.defi", "blockchain.smartcontracts", "cybersecurity", "cloud", "devops", "infrastructure",
                    "database", "fintech", "ecommerce", "crm", "erp", "iot", "embedded", "gaming", "xr", "robotics",
                    "devtools", "enterprise", "it_consulting"):
            self.assertIn(nid, self.tax.nodes)

    def test_short_capitalised_alias_keeps_its_case(self):
        self.assertIsNone(demand.match_market("ho parlato ai ragazzi del bar", self.tax)["node"])
        self.assertEqual(demand.match_market("cerco un esperto di AI", self.tax)["path"][1]["id"], "ai")

    def test_technical_roles_from_the_query_list(self):
        for text, node in (("cerchiamo un Penetration Tester", "cybersecurity.pentest"), ("cerco un ethical hacker", "cybersecurity.pentest"),
                           ("cercasi Programmatore iOS", "mobile.ios"), ("cercasi Programmatore Android", "mobile.android")):
            self.assertEqual(demand.match_market(text, self.tax)["node"], node, text)

    def test_extensible_a_new_node_is_matched(self):
        import tempfile
        with open(demand.TAXONOMY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        data["nodes"].append({"id": "ai.agents.voice_sales", "parent": "ai.agents", "name": "Agenti vocali di vendita",
                              "aliases": {"it": ["agente vocale per le vendite"], "en": []}})
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(data, f)
        tax = load_taxonomy(f.name)
        os.unlink(f.name)
        self.assertEqual(demand.match_market("vorrei un agente vocale per le vendite", tax)["node"], "ai.agents.voice_sales")


class WhoIsWriting(unittest.TestCase):
    def test_seller_is_never_a_lead_even_with_strong_words(self):
        r = read("Sono uno sviluppatore Flutter e realizzo app su misura, budget a partire da 2.000 €, scrivimi per info")
        self.assertEqual(r.author_role, "seller")
        self.assertFalse(r.demand_detected)
        self.assertLess(r.lead_score, 25)

    def test_job_seeker_is_not_a_client(self):
        r = read("Cerco lavoro come programmatore Python, anche stage")
        self.assertEqual(r.author_role, "job_seeker")
        self.assertEqual(r.demand, "no")

    def test_keywords_alone_score_nothing(self):
        r = read("AI, blockchain, developer, software, Solidity, Python, LLM: il futuro è qui!")
        self.assertEqual(r.demand, "no")
        self.assertLess(r.lead_score, 25)

    def test_non_it_request_is_not_demand(self):
        self.assertEqual(read("Cerco un idraulico urgente a Roma, budget 200 euro").demand, "no")


class TheReading(unittest.TestCase):
    def test_the_example_of_the_brief(self):
        r = read("Cerco uno sviluppatore Flutter per realizzare un'app")
        self.assertTrue(r.demand_detected)
        self.assertEqual(r.intent_type, "service_demand")
        self.assertIn("Flutter", r.technology)
        self.assertEqual(r.taxonomy_path[:2], ["it", "software"])
        self.assertEqual(r.project_type, "mobile_app")
        self.assertEqual(r.language, "it")

    def test_several_intents_at_once(self):
        r = read("Cerchiamo un freelance per collegare n8n al nostro CRM e automatizzare i preventivi")
        self.assertTrue({"service_demand", "hiring", "integration", "automation"} <= set(r.intent_types))

    def test_budget_and_urgency_raise_the_stage(self):
        plain = read("Cerco uno sviluppatore Solidity per uno smart contract")
        hot = read("Cerco uno sviluppatore Solidity per uno smart contract, budget 3000 euro, urgente")
        self.assertEqual(plain.stage, "concrete_request")
        self.assertEqual(hot.stage, "high_intent")
        self.assertGreater(hot.lead_score, plain.lead_score)

    def test_evidence_is_copied_from_the_text(self):
        text = "Ogni sera copio gli ordini da Shopify al gestionale a mano. Esiste un programma che lo faccia?"
        for e in read(text).evidence:
            self.assertIn(e["text"], text)
            self.assertIn(e["match"].lower(), text.lower())

    def test_problem_is_never_written_by_the_rules(self):
        self.assertEqual(read("Cerco uno sviluppatore per un CRM").problem, "")

    def test_english(self):
        r = read("Looking for a React Native developer for our startup MVP, budget $8k")
        self.assertEqual((r.language, r.stage), ("en", "high_intent"))


class ModelAnswers(unittest.TestCase):
    TEXT = "Cerco uno sviluppatore Laravel per un CRM per la mia agenzia, budget 5.000 €"

    def test_inventions_are_removed_and_the_score_is_computed_here(self):
        r = from_model(self.TEXT, {
            "author_role": "buyer", "stage": "high_intent", "intent_types": ["service_demand", "made_up"],
            "taxonomy_node": "crm.made_up", "technology": ["Laravel", "Django"], "budget_declared": True, "urgent": False,
            "company_signal": True, "problem": "CRM per agenzia", "evidence": ["sviluppatore Laravel", "budget 50.000 €"]})
        self.assertEqual(r.technology, ["Laravel"])
        self.assertIsNone(r.taxonomy_node)
        self.assertEqual(r.intent_types, ["service_demand"])
        self.assertEqual([e["text"] for e in r.evidence], ["sviluppatore Laravel"])
        self.assertEqual(r.lead_score, demand.lead_score("high_intent", 1, 0, True, False, True, len(self.TEXT))[0])

    def test_a_seller_from_the_model_is_still_not_a_lead(self):
        r = from_model(self.TEXT, {"author_role": "seller", "stage": "high_intent", "intent_types": ["service_demand"],
                                   "taxonomy_node": "crm", "technology": [], "budget_declared": True, "urgent": True,
                                   "company_signal": False, "problem": "x", "evidence": []})
        self.assertEqual((r.demand, r.stage, r.problem), ("no", "conversation", ""))

    def test_schema_enums_match_the_module(self):
        item = demand.DEMAND_SCHEMA["properties"]["results"]["items"]["properties"]
        self.assertEqual(item["stage"]["enum"], list(demand.STAGES))
        self.assertEqual(item["author_role"]["enum"], list(demand.ROLES))


class MeasuredPrecision(unittest.TestCase):
    """The rules are a precision filter: on both labelled sets, no trap may become a lead."""

    def _run(self, name):
        examples = eval_demand.load(os.path.join(HERE, "fixtures", name))
        return eval_demand.evaluate(examples, eval_demand.rules_reader([e["text"] for e in examples]))

    def test_tuning_set(self):
        res = self._run("demand_eval.json")
        self.assertEqual(res["traps_read_as_demand"].split("/")[0], "0")
        self.assertGreaterEqual(res["demand_yes"]["precision"], 0.9)

    def test_holdout_precision_only(self):
        res = self._run("demand_holdout.json")      # recall here is low on purpose: it is not tuned on
        self.assertEqual(res["traps_read_as_demand"].split("/")[0], "0")
        self.assertGreaterEqual(res["demand_yes"]["precision"], 0.9)

    def test_extra_set(self):
        res = self._run("demand_extra.json")
        self.assertEqual(res["traps_read_as_demand"].split("/")[0], "0")
        self.assertGreaterEqual(res["demand_yes"]["precision"], 0.9)

    def test_lead_class_separates_clients_from_job_ads(self):
        # tuning set: the 12 posts of the first real hunt + synthetic cases (they were used to write the rules)
        with open(os.path.join(HERE, "fixtures", "lead_class.json"), encoding="utf-8") as f:
            cases = json.load(f)["examples"]
        wrong = [(e["id"], e["lead_class"], demand.read(e["text"]).lead_class) for e in cases
                 if demand.read(e["text"]).lead_class != e["lead_class"]]
        self.assertEqual(wrong, [])
        self.assertTrue({e["lead_class"] for e in cases} <= set(demand.LEAD_CLASSES))

    def test_lead_class_on_real_posts(self):
        # 62 real posts that the earlier rules all read as clients (only 16 were): no real client lost, most others out
        with open(os.path.join(HERE, "fixtures", "lead_class_real.json"), encoding="utf-8") as f:
            cases = json.load(f)["examples"]
        got = [(e["lead_class"], demand.read(e["text"]).lead_class) for e in cases]
        clients = [g for want, g in got if want == "cliente"]
        read_as_client = [want for want, g in got if g == "cliente"]
        self.assertGreaterEqual(clients.count("cliente") / len(clients), 0.9)
        self.assertGreaterEqual(read_as_client.count("cliente") / len(read_as_client), 0.6)

    def test_labels_use_known_values(self):
        tax = load_taxonomy()
        for name in ("demand_eval.json", "demand_holdout.json", "demand_extra.json"):
            for e in eval_demand.load(os.path.join(HERE, "fixtures", name)):
                self.assertIn(e["demand"], ("yes", "weak", "no"))
                self.assertIn(e["author_role"], demand.ROLES)
                self.assertIn(e["stage"], demand.STAGES)
                self.assertTrue(set(e["intents"]) <= set(demand.INTENTS), e["id"])
                self.assertTrue(e["market"] is None or e["market"] in tax.nodes, (e["id"], e["market"]))


if __name__ == "__main__":
    unittest.main()
