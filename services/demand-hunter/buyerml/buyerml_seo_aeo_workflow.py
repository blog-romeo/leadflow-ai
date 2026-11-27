"""
================================================================================
BuyerML — Complete SEO + AEO Workflow
================================================================================
Python implementation of the 8-phase workflow + Layer 0 (Business Context Engine).

How to use it:
    1. Install dependencies:  pip install requests
    2. Set your API keys in the constants at the top of the file (SERPAPI_KEY etc.)
    3. If you don't have API keys yet, leave MOCK_MODE = True: the workflow still
       runs, returning realistic sample data, useful for testing the end-to-end
       logic before wiring up the real APIs.
    4. Run:  python buyerml_seo_aeo_workflow.py

Structure:
    Layer 0  -> BusinessProfile, BusinessRelevanceRules
    Phase 0  -> AICrawlabilityGate
    Phase 1  -> TrendDiscovery
    Phase 2  -> VerticalExpansion
    Phase 3  -> KeywordExpansion
    Phase 4  -> AwarenessMapper
    Phase 5  -> IntentDetector
    Phase 6  -> Router (6a Fast-Track) + FormatSelector (6b)
    Phase 7  -> AIVisibilityMonitor
    Phase 8  -> PageAuditor + Orchestrator
    main()   -> runs the entire end-to-end pipeline on sample data
================================================================================
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum

import requests

# ------------------------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------------------------

def _load_env_file(path: str = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")) -> None:
    """Loads KEY=value lines from the local .env file (git-ignored) into the environment."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_env_file()

# Real APIs: run with MOCK_MODE=false (environment or .env)
MOCK_MODE = os.environ.get("MOCK_MODE", "true").lower() != "false"

SERPAPI_KEY = os.environ.get("SERPAPI_KEY", "YOUR_SERPAPI_KEY")
SERPAPI_BASE_URL = "https://serpapi.com/search"
# Google searches through SerpApi can take well over 15 s: a short timeout loses paid searches
SERPAPI_TIMEOUT = 60

LANGUAGE = "it"
AREA = "IT"
GOOGLE_DOMAIN = "google.it"


# ==============================================================================
# LAYER 0 — Business Context Engine
# ==============================================================================

class RelevanceLevel(str, Enum):
    HIGHLY_RELEVANT = "Highly Relevant"
    RELEVANT = "Relevant"
    PARTIALLY_RELEVANT = "Partially Relevant"
    NOT_RELEVANT = "Not Relevant"
    FORBIDDEN = "Forbidden / Avoid"


def _list(*items: str) -> list[str]:
    """Small helper to keep the dataclass defaults readable."""
    return list(items)


# ------------------------------------------------------------------------------
# A. Company Context
# ------------------------------------------------------------------------------

@dataclass
class CompanyContext:
    company_name: str = "BuyerML"
    business_description: str = (
        "BuyerML identifies repetitive business processes inside SMEs and "
        "turns them into AI-driven automations / AI Agents."
    )
    industry: str = "AI Advisory / Business Process Automation"
    sub_industry: str = "SME workflow automation"
    market: str = "B2B"
    geographic_market: list[str] = field(default_factory=lambda: _list("Italy"))
    company_type: str = "AI Advisory agency"
    business_model: str = "Advisory retainer + project-based implementation"
    company_stage: str = "Early-stage / scaling"
    products: list[str] = field(default_factory=lambda: _list("AI Agent implementations"))
    services: list[str] = field(default_factory=lambda: _list("AI Advisory", "Process discovery audits"))


# ------------------------------------------------------------------------------
# B. Business
# ------------------------------------------------------------------------------

@dataclass
class Business:
    what_it_does: str = (
        "Identifies repetitive business processes and turns them into "
        "automations / AI Agents."
    )
    what_it_sells: str = "AI Advisory services + AI Agent implementation"
    what_problems_it_solves: str = (
        "Inefficiencies, repetitive manual tasks, non-scalable processes"
    )
    business_objectives: list[str] = field(default_factory=lambda: _list(
        "Grow market share in SME automation advisory"
    ))
    business_priorities: list[str] = field(default_factory=lambda: _list(
        "Scale qualified lead generation through content"
    ))
    operational_priorities: list[str] = field(default_factory=lambda: _list(
        "Increase AI citation visibility (AEO)"
    ))
    main_business_challenges: list[str] = field(default_factory=lambda: _list(
        "Low current AI visibility score (31/100)"
    ))
    main_customer_problems: list[str] = field(default_factory=lambda: _list(
        "Too much time lost on manual, repetitive work"
    ))
    core_use_cases: list[str] = field(default_factory=lambda: _list(
        "Adding AEO to an existing SEO-optimized site",
        "Automating customer service triage with an AI Agent",
    ))
    jobs_to_be_done: list[str] = field(default_factory=lambda: _list(
        "Help me find which of my processes are worth automating"
    ))


# ------------------------------------------------------------------------------
# C. Value Proposition
# ------------------------------------------------------------------------------

@dataclass
class ValueProposition:
    value_proposition: str = (
        "We help SMEs turn repetitive manual processes into AI automations, "
        "always starting from the business problem."
    )
    unique_value_proposition: str = (
        "We start from the business problem, not the technology — "
        "the AI Agent is the outcome of an advisory process, not the pitch."
    )
    core_benefits: list[str] = field(default_factory=lambda: _list(
        "Time savings", "Fewer manual errors", "Scalable operations"
    ))
    customer_benefits: list[str] = field(default_factory=lambda: _list(
        "Employees freed from repetitive tasks"
    ))
    customer_outcomes: list[str] = field(default_factory=lambda: _list(
        "Hours saved per week on manual workflows"
    ))
    business_outcomes: list[str] = field(default_factory=lambda: _list(
        "Higher client retention through measurable ROI"
    ))
    value_drivers: list[str] = field(default_factory=lambda: _list(
        "AI Advisor methodology", "Process-first discovery"
    ))
    reasons_to_choose: list[str] = field(default_factory=lambda: _list(
        "Problem-first approach instead of technology-first"
    ))
    key_promises: list[str] = field(default_factory=lambda: _list(
        "Implementation scoped around a real business process, not a demo"
    ))


# ------------------------------------------------------------------------------
# D. Target Audience
# ------------------------------------------------------------------------------

@dataclass
class TargetAudience:
    target_audience: str = "Italian SMEs, operational decision makers"
    ideal_customer_profile: str = (
        "SME (10-250 employees) with manual, repetitive operational workflows"
    )
    buyer_personas: list[str] = field(default_factory=lambda: _list(
        "Operations Manager", "COO of a growing SME"
    ))
    decision_makers: list[str] = field(default_factory=lambda: _list("COO", "Owner/CEO"))
    influencers: list[str] = field(default_factory=lambda: _list("Operations team lead"))
    end_users: list[str] = field(default_factory=lambda: _list("Customer service staff", "Sales ops staff"))
    industries_served: list[str] = field(default_factory=lambda: _list(
        "Customer service", "Sales", "Marketing", "Ecommerce", "Administration"
    ))
    company_size: str = "10-250 employees"
    geography: str = "Italy"
    customer_needs: list[str] = field(default_factory=lambda: _list(
        "Reduce time spent on repetitive tasks"
    ))
    customer_pain_points: list[str] = field(default_factory=lambda: _list(
        "Repetitive tasks", "Too much time lost on manual work"
    ))
    customer_motivations: list[str] = field(default_factory=lambda: _list(
        "Free up staff time for higher-value work"
    ))
    customer_goals: list[str] = field(default_factory=lambda: _list(
        "Scale operations without scaling headcount"
    ))


# ------------------------------------------------------------------------------
# E. Products & Services (one entry per product/service)
# ------------------------------------------------------------------------------

@dataclass
class ProductService:
    name: str
    description: str = ""
    category: str = ""
    problem_solved: str = ""
    target_customer: str = ""
    use_cases: list[str] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    benefits: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)
    differentiators: list[str] = field(default_factory=list)
    related_topics: list[str] = field(default_factory=list)
    related_keywords: list[str] = field(default_factory=list)
    search_intent: str = "informational"
    commercial_intent: str = "medium"


# ------------------------------------------------------------------------------
# F. Market Positioning
# ------------------------------------------------------------------------------

@dataclass
class MarketPositioning:
    market_category: str = "AI-driven business process automation"
    market_position: str = "Challenger, advisory-led"
    brand_positioning: str = "The advisor that starts from your process, not from AI hype"
    competitive_positioning: str = "More consultative than pure-play automation SaaS tools"
    strategic_position: str = "SME-focused, Italy-first"
    market_perception: str = "Low current AI visibility (31/100)"
    desired_market_perception: str = "The trusted advisor for AI process automation in Italian SMEs"


# ------------------------------------------------------------------------------
# G. Differentiation
# ------------------------------------------------------------------------------

@dataclass
class Differentiation:
    key_differentiators: list[str] = field(default_factory=lambda: _list(
        "Starts from the business problem, not the technology",
        "AI Advisor methodology",
    ))
    unique_selling_proposition: str = "Process-first AI automation advisory for SMEs"
    competitive_advantages: list[str] = field(default_factory=lambda: _list(
        "Advisory-led discovery before implementation"
    ))
    core_strengths: list[str] = field(default_factory=lambda: _list("Process diagnosis methodology"))
    proprietary_capabilities: list[str] = field(default_factory=lambda: _list("AI Advisor framework"))
    reasons_competitors_cannot_replicate: list[str] = field(default_factory=lambda: _list(
        "Methodology built specifically around SME operational discovery"
    ))
    what_makes_company_different: str = "Consultative, problem-first approach"
    what_makes_product_different: str = "AI Agents scoped from a real diagnosed process, not a template"


# ------------------------------------------------------------------------------
# H. Competitive Landscape
# ------------------------------------------------------------------------------

@dataclass
class CompetitiveLandscape:
    main_competitors: list[str] = field(default_factory=lambda: _list(
        "zapier.com", "make.com", "zendesk.com", "intercom.com", "pipedrive.com"
    ))
    direct_competitors: list[str] = field(default_factory=lambda: _list("zapier.com", "make.com"))
    indirect_competitors: list[str] = field(default_factory=lambda: _list(
        "generic IT consultancies"
    ))
    alternatives: list[str] = field(default_factory=lambda: _list("in-house automation teams"))
    substitute_solutions: list[str] = field(default_factory=lambda: _list("manual process improvement"))
    competitor_strengths: list[str] = field(default_factory=lambda: _list(
        "Zapier/Make: large integration ecosystem"
    ))
    competitor_weaknesses: list[str] = field(default_factory=lambda: _list(
        "Tool-first vendors lack process discovery advisory"
    ))
    competitive_gaps: list[str] = field(default_factory=lambda: _list(
        "No advisory-led competitor focused on Italian SMEs"
    ))
    market_opportunities: list[str] = field(default_factory=lambda: _list(
        "Low AI-citation competition on process-specific verticals"
    ))


# ------------------------------------------------------------------------------
# I. Customer Problems
# ------------------------------------------------------------------------------

@dataclass
class CustomerProblems:
    pain_points: list[str] = field(default_factory=lambda: _list("Repetitive manual tasks"))
    frictions: list[str] = field(default_factory=lambda: _list("Slow handoffs between tools"))
    bottlenecks: list[str] = field(default_factory=lambda: _list("Manual data entry"))
    inefficiencies: list[str] = field(default_factory=lambda: _list("Duplicate manual work across teams"))
    risks: list[str] = field(default_factory=lambda: _list("Human error in repetitive processes"))
    costs: list[str] = field(default_factory=lambda: _list("Wasted staff hours"))
    manual_activities: list[str] = field(default_factory=lambda: _list("Manual order entry"))
    repetitive_activities: list[str] = field(default_factory=lambda: _list("Repetitive customer replies"))
    information_problems: list[str] = field(default_factory=lambda: _list("Data scattered across tools"))
    process_problems: list[str] = field(default_factory=lambda: _list("No standardized workflow"))


# ------------------------------------------------------------------------------
# J. Customer Needs
# ------------------------------------------------------------------------------

@dataclass
class CustomerNeeds:
    functional_needs: list[str] = field(default_factory=lambda: _list("Automate repetitive tasks"))
    operational_needs: list[str] = field(default_factory=lambda: _list("Reduce manual workload"))
    business_needs: list[str] = field(default_factory=lambda: _list("Scale without adding headcount"))
    strategic_needs: list[str] = field(default_factory=lambda: _list("Stay competitive on efficiency"))
    information_needs: list[str] = field(default_factory=lambda: _list("Understand what AI Agents can do"))
    technology_needs: list[str] = field(default_factory=lambda: _list("Integrate with existing tools"))


# ------------------------------------------------------------------------------
# K. Customer Journey
# ------------------------------------------------------------------------------

@dataclass
class CustomerJourney:
    awareness: str = "Realizes tasks are repetitive and time-consuming"
    problem_recognition: str = "Recognizes automation could help"
    research: str = "Searches for automation categories and options"
    evaluation: str = "Compares tools/advisors"
    comparison: str = "Compares BuyerML vs. Zapier/Make/consultancies"
    decision: str = "Chooses an advisory-led vs. tool-led approach"
    purchase: str = "Signs advisory retainer or implementation project"
    adoption: str = "Rolls out the first AI Agent"
    retention: str = "Expands automation to more processes"


# ------------------------------------------------------------------------------
# L. Buying Triggers
# ------------------------------------------------------------------------------

@dataclass
class BuyingTriggers:
    business_events: list[str] = field(default_factory=lambda: _list("Team growth outpacing process capacity"))
    operational_problems: list[str] = field(default_factory=lambda: _list("Recurring backlog in customer service"))
    growth: list[str] = field(default_factory=lambda: _list("Rapid headcount growth"))
    cost_pressure: list[str] = field(default_factory=lambda: _list("Rising operational costs"))
    digital_transformation: list[str] = field(default_factory=lambda: _list("Company-wide digitalization initiative"))
    technology_change: list[str] = field(default_factory=lambda: _list("New CRM/ERP rollout"))
    regulatory_change: list[str] = field(default_factory=lambda: _list("New compliance reporting requirements"))
    urgency_signals: list[str] = field(default_factory=lambda: _list("Missed SLAs due to manual bottlenecks"))


# ------------------------------------------------------------------------------
# M. Objections
# ------------------------------------------------------------------------------

@dataclass
class Objections:
    price_objections: list[str] = field(default_factory=lambda: _list("Advisory cost vs. DIY tools"))
    technology_objections: list[str] = field(default_factory=lambda: _list("Skepticism about AI reliability"))
    trust_objections: list[str] = field(default_factory=lambda: _list("Unproven track record with new client"))
    security_concerns: list[str] = field(default_factory=lambda: _list("Data handled by AI Agent"))
    implementation_concerns: list[str] = field(default_factory=lambda: _list("Disruption during rollout"))
    roi_concerns: list[str] = field(default_factory=lambda: _list("Unclear payback period"))
    switching_costs: list[str] = field(default_factory=lambda: _list("Migration from existing manual process"))
    adoption_barriers: list[str] = field(default_factory=lambda: _list("Staff resistance to new workflow"))


# ------------------------------------------------------------------------------
# N. Core Topics
# ------------------------------------------------------------------------------

@dataclass
class CoreTopics:
    core_topics: list[str] = field(default_factory=lambda: _list("Business process automation"))
    secondary_topics: list[str] = field(default_factory=lambda: _list("AI Agents", "Workflow automation"))
    supporting_topics: list[str] = field(default_factory=lambda: _list("Digital transformation"))
    content_pillars: list[str] = field(default_factory=lambda: _list(
        "Process automation", "AI Agents", "Vertical automation (sales, service, marketing)"
    ))
    subtopics: list[str] = field(default_factory=lambda: _list("Customer service automation", "Sales automation"))
    related_concepts: list[str] = field(default_factory=lambda: _list("RPA", "Workflow orchestration"))


# ------------------------------------------------------------------------------
# O. Entities
# ------------------------------------------------------------------------------

@dataclass
class Entities:
    brand_entities: list[str] = field(default_factory=lambda: _list("BuyerML"))
    product_entities: list[str] = field(default_factory=lambda: _list("AI Agent"))
    service_entities: list[str] = field(default_factory=lambda: _list("AI Advisory"))
    industry_entities: list[str] = field(default_factory=lambda: _list("Business process automation"))
    technology_entities: list[str] = field(default_factory=lambda: _list("LLM", "AI Agent", "RPA"))
    people_organizations: list[str] = field(default_factory=list)
    geographic_entities: list[str] = field(default_factory=lambda: _list("Italy"))
    relevant_concepts: list[str] = field(default_factory=lambda: _list("Jobs-to-be-Done", "Process mining"))


# ------------------------------------------------------------------------------
# P. Terminology
# ------------------------------------------------------------------------------

@dataclass
class Terminology:
    industry_terminology: list[str] = field(default_factory=lambda: _list("workflow automation", "AI Agent"))
    customer_terminology: list[str] = field(default_factory=lambda: _list("repetitive tasks", "manual work"))
    product_terminology: list[str] = field(default_factory=lambda: _list("process discovery", "AI Advisor"))
    technical_terminology: list[str] = field(default_factory=lambda: _list("LLM", "orchestration", "schema markup"))
    synonyms: list[str] = field(default_factory=lambda: _list("automation = process automation"))
    related_terms: list[str] = field(default_factory=lambda: _list("RPA", "digital transformation"))
    preferred_terms: list[str] = field(default_factory=lambda: _list("AI Agent", "process automation"))
    terms_to_avoid: list[str] = field(default_factory=lambda: _list("chatbot", "bot"))


# ------------------------------------------------------------------------------
# Q. Search Strategy
# ------------------------------------------------------------------------------

@dataclass
class SearchStrategy:
    primary_keywords: list[str] = field(default_factory=lambda: _list("business process automation"))
    secondary_keywords: list[str] = field(default_factory=lambda: _list("repetitive tasks", "AI automation"))
    long_tail_keywords: list[str] = field(default_factory=lambda: _list(
        "how to choose the right business process automation tool"
    ))
    keyword_clusters: list[str] = field(default_factory=lambda: _list(
        "customer service automation", "sales automation"
    ))
    topic_clusters: list[str] = field(default_factory=lambda: _list("business risk management"))
    search_intent: list[str] = field(default_factory=lambda: _list(
        "informational", "commercial_investigation", "transactional"
    ))
    informational_intent: list[str] = field(default_factory=lambda: _list("how to automate repetitive tasks"))
    commercial_intent: list[str] = field(default_factory=lambda: _list("best business process automation tools"))
    transactional_intent: list[str] = field(default_factory=lambda: _list("business process automation pricing"))
    navigational_intent: list[str] = field(default_factory=lambda: _list("BuyerML reviews"))


# ------------------------------------------------------------------------------
# R. SEO Priorities
# ------------------------------------------------------------------------------

@dataclass
class SEOPriorities:
    priority_topics: list[str] = field(default_factory=lambda: _list("customer service automation"))
    priority_keywords: list[str] = field(default_factory=lambda: _list("business process automation software"))
    priority_pages: list[str] = field(default_factory=lambda: _list("/customer-service-automation"))
    content_gaps: list[str] = field(default_factory=lambda: _list("No FAQ content on risk management automation"))
    competitor_gaps: list[str] = field(default_factory=lambda: _list("No advisory-led comparison content exists"))
    internal_linking_priorities: list[str] = field(default_factory=lambda: _list(
        "Link vertical pages back to the pillar page"
    ))
    content_opportunities: list[str] = field(default_factory=lambda: _list(
        "Comparison table content for tool_comparison cluster"
    ))


# ------------------------------------------------------------------------------
# S. AI / LLM Identity
# ------------------------------------------------------------------------------

@dataclass
class AILLMIdentity:
    who_is_the_company: str = "BuyerML"
    what_does_it_do: str = (
        "Identifies repetitive business processes and turns them into "
        "automations / AI Agents."
    )
    what_does_it_sell: str = "AI Advisory services + AI Agent implementation"
    who_does_it_serve: str = "Italian SMEs, operational decision makers"
    what_problems_does_it_solve: str = (
        "Inefficiencies, repetitive manual tasks, non-scalable processes"
    )
    what_category: str = "AI-driven business process automation"
    what_should_it_be_known_for: str = "Process-first AI automation advisory"
    associated_topics: list[str] = field(default_factory=lambda: _list(
        "business process automation", "AI Agents"
    ))
    associated_entities: list[str] = field(default_factory=lambda: _list("AI Agent", "workflow automation"))
    what_differentiates_it: str = "Starts from the business problem, not the technology"


# ------------------------------------------------------------------------------
# T. LLM Relevance
# ------------------------------------------------------------------------------

@dataclass
class LLMRelevance:
    target_ai_queries: list[str] = field(default_factory=lambda: _list(
        "best business process automation tools"
    ))
    conversational_queries: list[str] = field(default_factory=lambda: _list(
        "how do I know which of my tasks can be automated?"
    ))
    question_types: list[str] = field(default_factory=lambda: _list("how-to", "comparison", "pricing"))
    relevant_topics: list[str] = field(default_factory=lambda: _list("process automation", "AI Agents"))
    relevant_entities: list[str] = field(default_factory=lambda: _list("BuyerML", "AI Agent"))
    answer_intent: list[str] = field(default_factory=lambda: _list("informational", "commercial"))
    brand_associations: list[str] = field(default_factory=lambda: _list("advisory-led automation"))
    product_associations: list[str] = field(default_factory=lambda: _list("AI Agent implementation"))
    problem_associations: list[str] = field(default_factory=lambda: _list("repetitive manual tasks"))
    solution_associations: list[str] = field(default_factory=lambda: _list("AI-driven process automation"))


# ------------------------------------------------------------------------------
# U. AI Visibility
# ------------------------------------------------------------------------------

@dataclass
class AIVisibilityContext:
    brand_clarity: str = "Medium — brand name not yet widely cited"
    category_clarity: str = "Clear — AI Advisory / process automation"
    products_clarity: str = "Clear on-site, not yet reflected in AI answers"
    services_clarity: str = "Clear on-site"
    expertise_clarity: str = "Needs more proof points / case studies"
    problems_solved_clarity: str = "Clear"
    target_audience_clarity: str = "Clear — Italian SMEs"
    differentiation_clarity: str = "Needs stronger explicit statements for AI parsing"
    authority_signals: str = "Limited — few third-party citations"
    trust_signals: str = "Limited E-E-A-T signals on published pages"
    relevant_entities_coverage: str = "Partial — AI Agent covered, JTBD framing missing"


# ------------------------------------------------------------------------------
# 8. Brand & Tone of Voice
# ------------------------------------------------------------------------------

@dataclass
class BrandToneOfVoice:
    brand_voice: str = "Consultative, pragmatic, problem-first"
    tone_of_voice: str = "Confident but not hype-driven"
    communication_style: str = "Direct, example-led"
    writing_style: str = "Clear, structured, business-oriented"
    formality: str = "Semi-formal"
    technical_level: str = "Accessible to non-technical operational decision makers"
    preferred_vocabulary: list[str] = field(default_factory=lambda: _list("AI Agent", "process automation"))
    words_to_use: list[str] = field(default_factory=lambda: _list("process", "outcome", "automation"))
    words_to_avoid: list[str] = field(default_factory=lambda: _list("chatbot", "magic", "revolutionary"))
    messaging_principles: list[str] = field(default_factory=lambda: _list(
        "Always start from the business problem, never from the technology"
    ))
    brand_claims: list[str] = field(default_factory=lambda: _list(
        "Implementation scoped around a real diagnosed process"
    ))
    proof_points: list[str] = field(default_factory=lambda: _list("Hours saved per week case studies"))


# ------------------------------------------------------------------------------
# 9. Strategic Objectives
# ------------------------------------------------------------------------------

@dataclass
class StrategicObjectives:
    business_objectives: list[str] = field(default_factory=lambda: _list("Grow SME advisory client base"))
    marketing_objectives: list[str] = field(default_factory=lambda: _list("Increase qualified organic leads"))
    seo_objectives: list[str] = field(default_factory=lambda: _list("Rank for vertical automation keywords"))
    content_objectives: list[str] = field(default_factory=lambda: _list("Publish one vertical funnel per month"))
    conversion_objectives: list[str] = field(default_factory=lambda: _list("Increase demo requests from Most Aware content"))
    ai_visibility_objectives: list[str] = field(default_factory=lambda: _list(
        "Raise AI Visibility Score from 31/100 to 60+/100"
    ))
    llm_objectives: list[str] = field(default_factory=lambda: _list("Be cited in ChatGPT/Claude for tool-comparison prompts"))
    growth_objectives: list[str] = field(default_factory=lambda: _list("Expand to 6 fully-built BUYER verticals"))
    priority_objectives: list[str] = field(default_factory=lambda: _list("Fix Phase 8 high-priority FAQ/schema gaps"))
    kpis: list[str] = field(default_factory=lambda: _list(
        "AI Visibility Score", "Site Health Score", "Qualified leads per vertical"
    ))


# ------------------------------------------------------------------------------
# Master BusinessProfile — composes every section above
# ------------------------------------------------------------------------------

@dataclass
class BusinessProfile:
    """
    Full Business Profile that feeds the entire workflow (Layer 0).
    Every section below mirrors the consulting taxonomy: Company Context,
    Business, Value Proposition, Target Audience, Products & Services,
    Market Positioning, Differentiation, Competitive Landscape, Customer
    Problems/Needs/Journey/Triggers/Objections, Core Topics, Entities,
    Terminology, Search Strategy, SEO Priorities, AI/LLM Identity, LLM
    Relevance, AI Visibility, Brand & Tone of Voice, Strategic Objectives.
    """

    company_context: CompanyContext = field(default_factory=CompanyContext)
    business: Business = field(default_factory=Business)
    value_proposition: ValueProposition = field(default_factory=ValueProposition)
    target_audience: TargetAudience = field(default_factory=TargetAudience)
    products_services: list[ProductService] = field(default_factory=lambda: [
        ProductService(
            name="AI Agent Implementation",
            description="End-to-end build and rollout of a custom AI Agent for a diagnosed process",
            category="business process automation",
            problem_solved="Repetitive manual tasks in a specific business process",
            target_customer="SME operations teams",
            use_cases=["Customer service triage", "Order management"],
            features=["Multi-LLM backend", "Custom process mapping"],
            benefits=["Time savings", "Fewer manual errors"],
            outcomes=["Hours saved per week"],
            differentiators=["Process-first discovery before implementation"],
            related_topics=["AI Agents", "workflow automation"],
            related_keywords=["AI agent implementation", "business process automation"],
            search_intent="commercial_investigation",
            commercial_intent="high",
        ),
        ProductService(
            name="AI Advisory Retainer",
            description="Ongoing advisory to identify and prioritize automatable processes",
            category="advisory",
            problem_solved="Not knowing which processes are worth automating first",
            target_customer="SME decision makers",
            use_cases=["Quarterly process discovery audits"],
            features=["Process diagnosis framework"],
            benefits=["Clear automation roadmap"],
            outcomes=["Prioritized automation backlog"],
            differentiators=["Advisory-led, not tool-led"],
            related_topics=["business process automation"],
            related_keywords=["business process automation consulting"],
            search_intent="informational",
            commercial_intent="medium",
        ),
    ])

    market_positioning: MarketPositioning = field(default_factory=MarketPositioning)
    differentiation: Differentiation = field(default_factory=Differentiation)
    competitive_landscape: CompetitiveLandscape = field(default_factory=CompetitiveLandscape)

    customer_problems: CustomerProblems = field(default_factory=CustomerProblems)
    customer_needs: CustomerNeeds = field(default_factory=CustomerNeeds)
    customer_journey: CustomerJourney = field(default_factory=CustomerJourney)
    buying_triggers: BuyingTriggers = field(default_factory=BuyingTriggers)
    objections: Objections = field(default_factory=Objections)

    core_topics: CoreTopics = field(default_factory=CoreTopics)
    entities: Entities = field(default_factory=Entities)
    terminology: Terminology = field(default_factory=Terminology)

    search_strategy: SearchStrategy = field(default_factory=SearchStrategy)
    seo_priorities: SEOPriorities = field(default_factory=SEOPriorities)

    ai_llm_identity: AILLMIdentity = field(default_factory=AILLMIdentity)
    llm_relevance: LLMRelevance = field(default_factory=LLMRelevance)
    ai_visibility_context: AIVisibilityContext = field(default_factory=AIVisibilityContext)

    brand_tone_of_voice: BrandToneOfVoice = field(default_factory=BrandToneOfVoice)
    strategic_objectives: StrategicObjectives = field(default_factory=StrategicObjectives)

    # ---- convenience accessors used across the pipeline (Phase 0, 1, 2...) ----

    @property
    def company_name(self) -> str:
        return self.company_context.company_name

    @property
    def industry(self) -> str:
        return self.company_context.industry

    @property
    def geographic_market(self) -> list[str]:
        return self.company_context.geographic_market

    @property
    def what_it_does(self) -> str:
        return self.business.what_it_does

    @property
    def what_it_sells(self) -> str:
        return self.business.what_it_sells

    @property
    def problems_solved(self) -> str:
        return self.business.what_problems_it_solves

    @property
    def target_audience_summary(self) -> str:
        return self.target_audience.target_audience

    @property
    def differentiators(self) -> list[str]:
        return self.differentiation.key_differentiators

    @property
    def value_proposition_statement(self) -> str:
        return self.value_proposition.value_proposition

    def to_dict(self) -> dict:
        """Full serialization of the profile, e.g. for logging or passing to an LLM."""
        from dataclasses import asdict
        return asdict(self)


class BusinessRelevanceRules:
    """
    The critical filter of Layer 0: classifies every keyword/seed on the
    Highly Relevant -> Forbidden scale BEFORE it enters the rest of the
    workflow. The taxonomy below is a sample to be customized with the
    client's real Business Profile.
    """

    HIGHLY_RELEVANT_TERMS = {
        "business process automation",
        "business automation",
        "ai agents for companies",
        "ai automation",
    }
    RELEVANT_TERMS = {
        "repetitive tasks",
        "workflow automation",
        "too much time lost on manual work",
        "business automation software",
    }
    # competitor domains NOT relevant to the automation/software industry:
    # if they appear in a query's ads, the query should be discarded even
    # if the intent looks transactional.
    FORBIDDEN_COMPETITOR_DOMAINS = {
        "wellness-courses.com",
        "therapist.com",
        "meditation.com",
    }

    @classmethod
    def classify(cls, term: str) -> RelevanceLevel:
        term_lower = term.lower()
        if term_lower in cls.HIGHLY_RELEVANT_TERMS:
            return RelevanceLevel.HIGHLY_RELEVANT
        if term_lower in cls.RELEVANT_TERMS:
            return RelevanceLevel.RELEVANT
        # fallback heuristic: if it contains "automation" or "process",
        # treat it as at least "Partially Relevant"
        if "automation" in term_lower or "process" in term_lower:
            return RelevanceLevel.PARTIALLY_RELEVANT
        return RelevanceLevel.NOT_RELEVANT

    @classmethod
    def is_domain_relevant(cls, competitor_domains: list[str]) -> bool:
        """True if at least one competitor in the ads belongs to the target industry."""
        if not competitor_domains:
            return True  # no competitors -> no negative signal
        return not all(d in cls.FORBIDDEN_COMPETITOR_DOMAINS for d in competitor_domains)

    @classmethod
    def filter_seeds(cls, seeds: list[dict]) -> list[dict]:
        """Applies classification to a list of seeds and drops the Not Relevant ones."""
        filtered = []
        for seed in seeds:
            relevance = cls.classify(seed["seed"])
            seed["relevance"] = relevance.value
            if relevance in (RelevanceLevel.NOT_RELEVANT, RelevanceLevel.FORBIDDEN):
                continue
            filtered.append(seed)
        return filtered


# ==============================================================================
# PHASE 0 — AI Crawlability Gate + llms.txt Generation
# ==============================================================================

class AICrawlabilityGate:
    """Checks AI crawler access, monitors bot activity, generates llms.txt."""

    REQUIRED_CRAWLERS = [
        "ChatGPT-User",
        "OAI-SearchBot",
        "Googlebot",
        "Google-Extended",
        "ClaudeBot",
        "GPTBot",
        "PerplexityBot",
    ]

    def __init__(self, site: str):
        self.site = site

    def check_crawlability(self) -> dict:
        """Phase 0.1 — in production: call to Site Audit / AI Search Health."""
        if MOCK_MODE:
            crawler_status = {c: "allowed" for c in self.REQUIRED_CRAWLERS}
        else:
            # TODO: replace with a real call to the site audit tool
            crawler_status = {c: "allowed" for c in self.REQUIRED_CRAWLERS}

        gate_pass = all(v == "allowed" for v in crawler_status.values())
        return {
            "site": self.site,
            "verified_crawlers": crawler_status,
            "gate_status": "✅ PASS — proceed to Phase 1" if gate_pass else "🚨 BLOCKED",
        }

    def monitor_crawler_activity(self) -> dict:
        """Phase 0.2 — rolling 28-day monitoring (sample data in mock mode)."""
        if MOCK_MODE:
            return {
                "period": "last 28 days",
                "total_hits": 297,
                "active_bots": 6,
                "trend": "+100%",
                "bot_breakdown": [
                    {"bot": "ClaudeBot", "hits": 223},
                    {"bot": "GPTBot", "hits": 39},
                    {"bot": "OAI-SearchBot", "hits": 30},
                    {"bot": "Bingbot", "hits": 3},
                    {"bot": "ChatGPT-User", "hits": 1},
                ],
            }
        # TODO: replace with a real call to the log analytics service
        return {}

    def generate_llms_txt(self, profile: BusinessProfile, pages: list[dict]) -> str:
        """Phase 0.3 — generates the text content of the llms.txt file."""
        differentiators = "\n".join(f"- {d}" for d in profile.differentiators)
        where = "\n".join(f"- {loc}" for loc in profile.geographic_market)
        pages_md = "\n".join(
            f"- [{p['title']}]({p['url']}) – {p['description']}" for p in pages
        )

        content = f"""# {profile.company_name}

> {profile.value_proposition_statement}

## Identity

**{profile.company_name}** – {profile.what_it_does}

*Industry:* {profile.industry}

## What sets us apart

{differentiators}

## Where we operate

{where}

## About

{profile.what_it_sells}. Target: {profile.target_audience_summary}. Problems solved: {profile.problems_solved}.

## Main pages

{pages_md}

---
*Automatically generated — {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}*
"""
        return content

    def check_ambiguous_brand_references(self, text: str, brand: str) -> list[str]:
        """Phase 0.4 — simple copy check: flags ambiguous brand mentions."""
        warnings = []
        # minimal sample heuristic: brand followed by a geographic term
        # without disambiguating parentheses (e.g. "BuyerML USA" vs "BuyerML (USA)")
        tokens = text.split()
        for i, tok in enumerate(tokens[:-1]):
            if tok == brand and tokens[i + 1].isupper() and "(" not in tokens[i + 1]:
                warnings.append(
                    f"Possible ambiguity: '{tok} {tokens[i + 1]}' -> "
                    f"use '{tok} ({tokens[i + 1]})'"
                )
        return warnings


# ==============================================================================
# PHASE 1 — Multi-Seed Trend Discovery
# ==============================================================================

class TrendDiscovery:
    """Queries Google Trends interest over time (last 12 months) for each structured seed."""

    # change of the last quarter vs the first quarter of the 12-month series
    EXPLOSIVE_THRESHOLD = 60.0   # % and above
    GROWTH_THRESHOLD = 10.0      # % and above
    DECLINE_THRESHOLD = -10.0    # % and below
    LOW_VOLUME_ZERO_SHARE = 0.5  # more zero weeks than this -> "low volume", kept

    def __init__(self, seeds: list[dict]):
        self.seeds = seeds

    def run(self) -> list[dict]:
        filtered_seeds = BusinessRelevanceRules.filter_seeds(self.seeds)
        results = []
        for seed in filtered_seeds:
            trend_data = self._fetch_trend(seed["seed"])
            results.append({**seed, **trend_data})
        # drop seeds in clear decline
        return [r for r in results if r.get("stage") != "declining"]

    def _fetch_trend(self, seed_term: str) -> dict:
        if MOCK_MODE:
            # sample data consistent with what we discussed in the workflow
            mock_table = {
                "business process automation": {
                    "trend": "+45%", "volume": 170, "difficulty": "12%",
                    "efficiency": "High", "stage": "steady growth",
                },
                "repetitive tasks": {
                    "trend": "+22%", "stage": "steady growth",
                },
                "ai automation": {
                    "trend": "+90%", "stage": "explosive",
                },
            }
            return mock_table.get(seed_term.lower(), {"trend": "+10%", "stage": "steady growth"})

        # SerpApi Google Trends, interest over time for this seed only
        params = {
            "engine": "google_trends",
            "q": seed_term,
            "data_type": "TIMESERIES",
            "date": "today 12-m",
            "geo": AREA,
            "hl": LANGUAGE,
            "api_key": SERPAPI_KEY,
        }
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        timeline = resp.json().get("interest_over_time", {}).get("timeline_data", [])
        return self._trend_from_timeline(timeline)

    def fetch_batch(self, terms: list[str]) -> dict[str, dict]:
        """
        Up to 5 terms in ONE SerpApi search (Google Trends compares them): each
        term's series is read on its own, so the stage stays per term; the
        values are relative to the group.
        """
        terms = terms[:5]
        if MOCK_MODE:
            return {t: self._fetch_trend(t) for t in terms}
        params = {"engine": "google_trends", "q": ",".join(terms), "data_type": "TIMESERIES", "date": "today 12-m",
                  "geo": AREA, "hl": LANGUAGE, "api_key": SERPAPI_KEY}
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        timeline = resp.json().get("interest_over_time", {}).get("timeline_data", [])
        return {term: self._trend_from_timeline([{"values": [p["values"][i]]} for p in timeline if len(p.get("values", [])) > i])
                for i, term in enumerate(terms)}

    def fetch_series(self, terms: list[str]) -> dict[str, list[dict]]:
        """
        The weekly series of up to 5 terms in ONE SerpApi search, as they are: [{date, value}] per term
        (values relative to the group; trends.py brings each one back to its own peak).
        """
        terms = terms[:5]
        if MOCK_MODE:
            raise RuntimeError("MOCK_MODE: le serie di Google Trends vere non sono disponibili")
        params = {"engine": "google_trends", "q": ",".join(terms), "data_type": "TIMESERIES", "date": "today 12-m",
                  "geo": AREA, "hl": LANGUAGE, "api_key": SERPAPI_KEY}
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        timeline = resp.json().get("interest_over_time", {}).get("timeline_data", [])
        out: dict[str, list[dict]] = {t: [] for t in terms}
        for point in timeline:
            ts = point.get("timestamp")
            date = time.strftime("%Y-%m-%d", time.gmtime(int(ts))) if ts else str(point.get("date", ""))
            for i, term in enumerate(terms):
                values = point.get("values", [])
                if i < len(values):
                    out[term].append({"date": date, "value": values[i].get("extracted_value", 0) or 0})
        return out

    def fetch_related(self, term: str) -> dict:
        """Google Trends related queries of one term: {"rising": [...], "top": [...]}, each {query, value, extracted_value}."""
        if MOCK_MODE:
            raise RuntimeError("MOCK_MODE: le query correlate vere non sono disponibili")
        params = {"engine": "google_trends", "q": term, "data_type": "RELATED_QUERIES", "date": "today 12-m",
                  "geo": AREA, "hl": LANGUAGE, "api_key": SERPAPI_KEY}
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        related = resp.json().get("related_queries", {})
        return {"rising": related.get("rising", []), "top": related.get("top", [])}

    @classmethod
    def _trend_from_timeline(cls, timeline: list[dict]) -> dict:
        """Turns the weekly 0-100 interest series into the same {trend, stage} as the mock."""
        points = [
            point["values"][0].get("extracted_value", 0)
            for point in timeline
            if point.get("values")
        ]
        quarter = len(points) // 4
        if quarter == 0 or not any(points):
            return {"trend": "n/a", "stage": "no data"}

        early = sum(points[:quarter]) / quarter
        recent = sum(points[-quarter:]) / quarter

        # Google Trends reports 0 when searches are too few to measure: a
        # series that is mostly zeros cannot be judged as growing or declining.
        # Exception: zeros only in the past and steady interest in the last
        # quarter is a term that is emerging now.
        zero_weeks = points.count(0)
        if zero_weeks > len(points) * cls.LOW_VOLUME_ZERO_SHARE:
            if all(points[-quarter:]):
                return {"trend": "new", "stage": "explosive", "recent_interest": round(recent)}
            return {"trend": "n/a", "stage": "low volume", "recent_interest": round(recent),
                    "zero_weeks": zero_weeks}

        if early == 0:
            if recent == 0:
                return {"trend": "n/a", "stage": "no data"}
            return {"trend": "new", "stage": "explosive", "recent_interest": round(recent)}

        change = (recent - early) / early * 100
        if change >= cls.EXPLOSIVE_THRESHOLD:
            stage = "explosive"
        elif change >= cls.GROWTH_THRESHOLD:
            stage = "steady growth"
        elif change <= cls.DECLINE_THRESHOLD:
            stage = "declining"
        else:
            stage = "stable"
        return {"trend": f"{change:+.0f}%", "stage": stage, "recent_interest": round(recent)}


# ==============================================================================
# PHASE 2 — Functional & BUYER Verticals Expansion
# ==============================================================================

class VerticalExpansion:
    """Expands the Mega Topic into BUYER (departmental) verticals and functional clusters."""

    BUYER_VERTICALS = [
        {"vertical": "customer service automation", "priority": "high"},
        {"vertical": "sales automation", "priority": "high"},
        {"vertical": "marketing automation", "priority": "high"},
        {"vertical": "ecommerce automation", "priority": "medium"},
        {"vertical": "administration automation", "priority": "medium"},
        {"vertical": "order management automation", "priority": "low"},
    ]

    FUNCTIONAL_CLUSTERS = [
        {"cluster": "business operations management", "volume": 50},
        {"cluster": "business resource management", "volume": 50},
        {"cluster": "business capacity management", "volume": 50},
        {"cluster": "business service management", "volume": 40},
        {"cluster": "business quality management", "volume": 40},
        {"cluster": "business performance management", "volume": 40},
        {"cluster": "business risk management", "volume": 30},
    ]

    TOOL_COMPARISON_CLUSTER = {
        "cluster": "tool_comparison",
        "seed_keyword": "business process automation tools",
        "volume": 90,
        "kd": "11%",
        "preassigned_awareness": "Product Aware",
        "preassigned_intent": "commercial_investigation",
    }

    def run(self, mega_topic: str) -> dict:
        return {
            "mega_topic": mega_topic,
            "buyer_verticals": self.BUYER_VERTICALS,
            "functional_clusters": self.FUNCTIONAL_CLUSTERS,
            "tool_comparison_cluster": self.TOOL_COMPARISON_CLUSTER,
        }


# ==============================================================================
# PHASE 3 — Keyword & Questions Expansion
# ==============================================================================

class KeywordExpansion:
    """
    Phase 3 — for each vertical/cluster:
      - the words people search: Google Trends related queries (rising + top)
        and Google Autocomplete
      - the questions people ask about the topic: autocomplete on question
        openers ("come ...", "quanto costa ...") + Google "People also ask"
    One list, duplicates removed (first source wins).
    Cost in real mode: 1 Trends + 1 autocomplete + one autocomplete per
    question opener + 1 Google search per seed.
    """

    QUESTION_PREFIXES = {
        "it": ["come", "cosa", "quanto costa", "perché", "quale", "dove", "chi", "conviene"],
        "en": ["how", "what", "how much", "why", "which", "where", "who", "is it worth"],
    }

    def __init__(self):
        self.errors: list[str] = []  # sources that failed: the others still count

    def _safe(self, label: str, fetch, *args) -> list[dict]:
        try:
            return fetch(*args)
        except (requests.RequestException, ValueError) as e:
            self.errors.append(f"{label}: {e}")
            return []

    def expand(self, seed: str) -> list[dict]:
        keywords = (
            self._safe(f"trends related queries for {seed!r}", self._fetch_related_queries, seed)
            + self._safe(f"autocomplete for {seed!r}", self._fetch_autocomplete, seed)
            + self._safe(f"questions for {seed!r}", self._fetch_questions, seed)
        )
        seen, unique = set(), []
        for kw in keywords:
            key = kw["query"].lower().strip()
            if key and key not in seen:
                seen.add(key)
                unique.append(kw)
        return unique

    def _fetch_related_queries(self, seed: str) -> list[dict]:
        if MOCK_MODE:
            mock = {
                "customer service automation": [
                    {"query": "customer service automation ai", "type": "keyword",
                     "source": "trends_rising", "trend_growth": "+250%"},
                ],
            }
            return mock.get(seed.lower(), [])

        # SerpApi Google Trends — related queries (single query per request)
        params = {
            "engine": "google_trends",
            "q": seed,
            "data_type": "RELATED_QUERIES",
            "date": "today 12-m",
            "geo": AREA,
            "hl": LANGUAGE,
            "api_key": SERPAPI_KEY,
        }
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        related = resp.json().get("related_queries", {})
        # rising first: they are the emerging phrasings
        rising = [
            {"query": r["query"], "type": "keyword", "source": "trends_rising",
             "trend_growth": r.get("value", "")}
            for r in related.get("rising", []) if r.get("query")
        ]
        top = [
            {"query": r["query"], "type": "keyword", "source": "trends_top",
             "trend_interest": r.get("extracted_value")}
            for r in related.get("top", []) if r.get("query")
        ]
        return rising + top

    def _fetch_autocomplete(self, seed: str) -> list[dict]:
        if MOCK_MODE:
            mock = {
                "customer service automation": [
                    "customer service automation software",
                    "customer service automation examples",
                    "customer service automation cost",
                ],
                "business risk management": [
                    "business risk management automation software",
                ],
            }
            return [
                {"query": q, "type": "keyword", "source": "autocomplete"}
                for q in mock.get(seed.lower(), [f"{seed} software"])
            ]

        # SerpApi Google Autocomplete
        params = {
            "engine": "google_autocomplete",
            "q": seed,
            "hl": LANGUAGE,
            "gl": AREA.lower(),
            "api_key": SERPAPI_KEY,
        }
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        suggestions = resp.json().get("suggestions", [])
        return [
            {"query": s.get("value", s), "type": "keyword", "source": "autocomplete"}
            for s in suggestions
        ]

    def _fetch_questions(self, seed: str) -> list[dict]:
        if MOCK_MODE:
            return [
                {
                    "query": f"how to choose the right {seed} tool",
                    "volume": 30,
                    "type": "question",
                }
            ]

        questions = []
        for prefix in self.QUESTION_PREFIXES.get(LANGUAGE, self.QUESTION_PREFIXES["en"]):
            for s in self._safe(f"autocomplete for {prefix + ' ' + seed!r}", self._fetch_autocomplete, f"{prefix} {seed}"):
                questions.append({"query": s["query"], "type": "question",
                                  "source": "autocomplete_question"})
        return questions + self._safe(f"people also ask for {seed!r}", self._fetch_people_also_ask, seed)

    def _fetch_people_also_ask(self, seed: str) -> list[dict]:
        """Questions from Google's "People also ask" box (SerpApi related_questions)."""
        params = {
            "engine": "google",
            "q": seed,
            "hl": LANGUAGE,
            "gl": AREA.lower(),
            "google_domain": GOOGLE_DOMAIN,
            "api_key": SERPAPI_KEY,
        }
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        return [
            {"query": q["question"], "type": "question", "source": "people_also_ask"}
            for q in resp.json().get("related_questions", []) if q.get("question")
        ]


# ==============================================================================
# PHASE 4 — Awareness Mapping
# ==============================================================================

class AwarenessLevel(str, Enum):
    UNAWARE = "Unaware"
    PROBLEM_AWARE = "Problem Aware"
    SOLUTION_AWARE = "Solution Aware"
    PRODUCT_AWARE = "Product Aware"
    MOST_AWARE = "Most Aware"


class AwarenessMapper:
    """Classifies each keyword on the 5 levels, keeping traceability of origin."""

    # Keyword heuristic, Italian + English (queries often mix them: "software
    # gestionale prezzi"). Checked from the most aware level down; hints match
    # whole words, so "cost" does not fire on "costruzioni" nor "app" on
    # "apprendimento". In production, an AI model can replace it.
    KEYWORD_HINTS = {
        AwarenessLevel.MOST_AWARE: [
            "prezzo", "prezzi", "costo", "costi", "quanto costa", "preventivo", "preventivi",
            "acquistare", "comprare", "acquisto", "abbonamento", "offerta", "sconto",
            "prova gratuita", "demo",
            "price", "pricing", "cost", "buy", "quote", "free trial",
        ],
        AwarenessLevel.PRODUCT_AWARE: [
            "software", "migliore", "migliori", "vs", "confronto", "alternativa", "alternative",
            "recensioni", "recensione", "piattaforma", "programma", "strumento", "strumenti",
            "app", "fornitore", "fornitori", "agenzia",
            "best", "tool", "tools", "review", "reviews", "platform", "comparison",
        ],
        AwarenessLevel.SOLUTION_AWARE: [
            "esempi", "esempio", "cos'è", "che cos'è", "cosa è", "cosa sono", "come funziona",
            "a cosa serve", "vantaggi", "guida", "tutorial", "soluzione", "soluzioni",
            "come creare", "come fare", "come usare", "come configurare", "come implementare",
            "examples", "what is", "how it works", "benefits", "guide",
            "how to create", "how to build", "how to use", "how to set up",
        ],
        AwarenessLevel.PROBLEM_AWARE: [
            "come automatizzare", "come ridurre", "come gestire", "come evitare",
            "perdere tempo", "perdita di tempo", "troppo tempo", "lavoro manuale",
            "attività ripetitive", "errori", "problema", "problemi",
            "how to automate", "losing time", "recognize", "manual work",
        ],
    }
    _PATTERNS = {
        level: re.compile(r"(?<!\w)(?:" + "|".join(re.escape(h) for h in hints) + r")(?!\w)")
        for level, hints in KEYWORD_HINTS.items()
    }

    def classify(self, query: str, origin: str = "", vertical: str = "") -> dict:
        query_lower = query.lower().replace("\u2019", "'")
        level = AwarenessLevel.UNAWARE
        for lvl, pattern in self._PATTERNS.items():
            if pattern.search(query_lower):
                level = lvl
                break
        return {
            "query": query,
            "origin": origin,
            "vertical": vertical,
            "awareness": level.value,
        }

    def run_batch(self, keywords: list[dict], origin: str = "", vertical: str = "") -> list[dict]:
        return [
            self.classify(kw["query"], origin=origin, vertical=vertical)
            for kw in keywords
        ]


# ==============================================================================
# PHASE 5 — Real Intent Detection
# ==============================================================================

class SearchIntent(str, Enum):
    INFORMATIONAL = "informational"
    NAVIGATIONAL = "navigational"
    TRANSACTIONAL = "transactional"
    COMMERCIAL_INVESTIGATION = "commercial_investigation"


class IntentDetector:
    """Verifies search intent on the real SERP (Google Search API via SerpApi)."""

    # The SERP rule only sees shopping results, a knowledge graph or ads, which
    # niche Italian B2B searches rarely have (Phase 1: 8 of 8 terms came out
    # "informational"). The words of the query are a second, explicit signal.
    QUERY_INTENT_HINTS = {
        SearchIntent.TRANSACTIONAL: [
            "prezzo", "prezzi", "costo", "costi", "quanto costa", "preventivo", "preventivi", "acquistare",
            "comprare", "abbonamento", "offerta", "prova gratuita", "demo",
            "price", "pricing", "cost", "buy", "quote", "free trial",
        ],
        SearchIntent.COMMERCIAL_INVESTIGATION: [
            "migliori", "migliore", "vs", "confronto", "alternativa", "alternative", "recensioni", "recensione",
            "top", "best", "review", "reviews", "comparison",
        ],
        SearchIntent.NAVIGATIONAL: ["login", "accedi", "accesso", "sito ufficiale", "download", "scarica"],
    }
    _QUERY_PATTERNS = {
        intent: re.compile(r"(?<!\w)(?:" + "|".join(re.escape(h) for h in hints) + r")(?!\w)")
        for intent, hints in QUERY_INTENT_HINTS.items()
    }

    @classmethod
    def intent_from_query(cls, query: str) -> SearchIntent | None:
        q = query.lower()
        for intent, pattern in cls._QUERY_PATTERNS.items():
            if pattern.search(q):
                return intent
        return None

    def detect(self, query: str) -> dict:
        serp_data = self._fetch_serp(query)
        intent = self._classify_intent(serp_data)
        source = "serp"
        if intent == SearchIntent.INFORMATIONAL:
            from_query = self.intent_from_query(query)
            if from_query:
                intent, source = from_query, "query"
        competitor_ads = serp_data.get("competitor_ads", [])
        domain_ok = BusinessRelevanceRules.is_domain_relevant(competitor_ads)

        return {
            "query": query,
            "real_serp_intent": intent.value,
            "intent_source": source,
            "competitor_ads": competitor_ads,
            "top5_organic": serp_data.get("top5_organic", []),
            "domain_relevant": domain_ok,
        }

    def _fetch_serp(self, query: str) -> dict:
        if MOCK_MODE:
            mock = {
                "customer service automation software": {
                    "answer_box": False, "related_questions": False,
                    "knowledge_graph": False, "shopping_results": False,
                    "ads": True,
                    "competitor_ads": ["zendesk.com", "intercom.com", "zapier.com"],
                    "top5_organic": ["zendesk.com/it", "hubspot.com/blog", "make.com"],
                },
                "repetitive tasks work stress": {
                    "answer_box": False, "related_questions": False,
                    "knowledge_graph": False, "shopping_results": True,
                    "ads": True,
                    "competitor_ads": ["wellness-courses.com"],
                    "top5_organic": [],
                },
            }
            return mock.get(
                query.lower(),
                {
                    "answer_box": True, "related_questions": True,
                    "knowledge_graph": False, "shopping_results": False,
                    "ads": False, "competitor_ads": [], "top5_organic": [],
                },
            )

        # TODO: real call to SerpApi Google Search
        params = {
            "engine": "google",
            "q": query,
            "hl": LANGUAGE,
            "gl": AREA.lower(),
            "google_domain": GOOGLE_DOMAIN,
            "api_key": SERPAPI_KEY,
        }
        resp = requests.get(SERPAPI_BASE_URL, params=params, timeout=SERPAPI_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        ads = data.get("ads", [])
        organic = data.get("organic_results", [])[:5]
        return {
            "answer_box": "answer_box" in data,
            "related_questions": "related_questions" in data,
            "knowledge_graph": "knowledge_graph" in data,
            "shopping_results": "shopping_results" in data,
            "ads": bool(ads),
            "competitor_ads": [a.get("link", "") for a in ads],
            "top5_organic": [o.get("link", "") for o in organic],
        }

    @staticmethod
    def _classify_intent(serp: dict) -> SearchIntent:
        """Replicates the logic of the original SerpApi script."""
        if serp.get("shopping_results"):
            return SearchIntent.TRANSACTIONAL
        if serp.get("knowledge_graph"):
            return SearchIntent.NAVIGATIONAL
        if serp.get("ads") and (serp.get("answer_box") or serp.get("related_questions")):
            return SearchIntent.COMMERCIAL_INVESTIGATION
        return SearchIntent.INFORMATIONAL


# ==============================================================================
# PHASE 6a / 6b — Router + Format Selector
# ==============================================================================

class Router:
    """Phase 6a — routes anomalies (early demand / false positives)."""

    ANOMALY_LEVELS = {AwarenessLevel.UNAWARE.value, AwarenessLevel.PROBLEM_AWARE.value}
    HIGH_INTENT = {SearchIntent.TRANSACTIONAL.value, SearchIntent.NAVIGATIONAL.value}

    def route(self, record: dict) -> dict:
        awareness = record["awareness"]
        intent = record["real_serp_intent"]
        domain_relevant = record.get("domain_relevant", True)

        is_anomaly = awareness in self.ANOMALY_LEVELS and intent in self.HIGH_INTENT

        if is_anomaly and not domain_relevant:
            record["routing"] = "discarded_false_positive"
        elif is_anomaly and domain_relevant:
            record["routing"] = "fast_track_commercial"
            record["priority"] = "highest"
        else:
            record["routing"] = "format_selector"
        return record


class FormatSelector:
    """Phase 6b — assigns editorial asset, schema markup, CTA, AI model."""

    FORMAT_TABLE = {
        (AwarenessLevel.PRODUCT_AWARE.value, SearchIntent.COMMERCIAL_INVESTIGATION.value): {
            "asset_format": "comparison_table", "schema_markup": "ComparisonTable",
            "cta": "Compare now",
        },
        (AwarenessLevel.MOST_AWARE.value, SearchIntent.TRANSACTIONAL.value): {
            "asset_format": "pricing_page", "schema_markup": "Product/Offer",
            "cta": "Request a demo",
        },
        (AwarenessLevel.PROBLEM_AWARE.value, SearchIntent.INFORMATIONAL.value): {
            "asset_format": "guide", "schema_markup": "Article/HowTo",
            "cta": "Learn how",
        },
    }

    def select(self, record: dict, is_question: bool = False) -> dict:
        if is_question:
            record.update({
                "asset_format": "conversational_FAQ",
                "schema_markup": "FAQPage",
                "cta": "Learn more",
            })
        else:
            key = (record["awareness"], record["real_serp_intent"])
            fmt = self.FORMAT_TABLE.get(key, {
                "asset_format": "generic_article", "schema_markup": "Article",
                "cta": "Find out more",
            })
            record.update(fmt)

        record["ai_generation_model"] = self._select_ai_model(record.get("priority", "medium"))
        record["target_ai_engines"] = ["ChatGPT", "Claude", "Perplexity", "Gemini"]
        return record

    @staticmethod
    def _select_ai_model(priority: str) -> str:
        mapping = {
            "low": "Gemini Flash",
            "medium": "Claude Haiku",
            "high": "Claude Haiku",
            "highest": "Claude Sonnet",
        }
        return mapping.get(priority, "Claude Haiku")


# ==============================================================================
# PHASE 7 — AI Visibility Monitoring
# ==============================================================================

class AIVisibilityMonitor:
    """Monitors brand citations in AI answers (closing loop)."""

    def check(self, prompts: list[str]) -> dict:
        if MOCK_MODE:
            return {
                "ai_visibility_score": "31/100 (Low)",
                "monitored_prompts": prompts,
                "detected_citations": {
                    "ChatGPT": 0, "Google_AI_Overview": 1, "Gemini": 0, "Claude": 0,
                },
                "competitors_cited_instead_of_us": ["zapier.com", "make.com"],
            }
        # TODO: real integration with Semrush AI Visibility / Verify-Live
        return {}


# ==============================================================================
# PHASE 8 — Page Audit & Orchestrator
# ==============================================================================

class PageAuditor:
    """Assigns a dual SEO+AEO score to a page, with a list of issues."""

    def audit(self, url: str, has_faq: bool, has_schema: bool, has_eeat: bool) -> dict:
        seo_score = 40 + (20 if has_schema else 0) + (10 if has_eeat else 0)
        aeo_score = 30 + (30 if has_faq else 0) + (20 if has_schema else 0)

        issues = []
        if not has_faq:
            issues.append("missing dedicated FAQ section")
        if not has_schema:
            issues.append("missing structured data (schema.org)")
        if not has_eeat:
            issues.append("missing E-E-A-T signals (author, date, sources)")

        return {
            "url": url,
            "seo_score": min(seo_score, 100),
            "aeo_score": min(aeo_score, 100),
            "issues": issues,
        }


class Orchestrator:
    """Aggregates multiple page audits into a Health Score + prioritized to-do list."""

    def orchestrate(self, audits: list[dict]) -> dict:
        if not audits:
            return {"site_health_score": 0, "next_steps": []}

        avg_score = sum((a["seo_score"] + a["aeo_score"]) / 2 for a in audits) / len(audits)

        next_steps = []
        for a in audits:
            for issue in a["issues"]:
                priority = "high" if "FAQ" in issue else "medium"
                next_steps.append({
                    "url": a["url"],
                    "priority": priority,
                    "action": f"Fix: {issue}",
                    "executable": True,
                })

        next_steps.sort(key=lambda x: {"high": 0, "medium": 1, "low": 2}[x["priority"]])

        return {
            "site_health_score": round(avg_score, 1),
            "pages_analyzed": len(audits),
            "next_steps": next_steps,
        }


# ==============================================================================
# END-TO-END PIPELINE
# ==============================================================================

def run_pipeline() -> None:
    print("=" * 80)
    print("BuyerML — Running end-to-end SEO + AEO Workflow")
    print("=" * 80)

    profile = BusinessProfile()

    print("\n[LAYER 0] Full Business Profile (all sections A-U + Brand Voice + Strategic Objectives)")
    print(
        f"Sections loaded: company_context, business, value_proposition, target_audience, "
        f"products_services ({len(profile.products_services)} items), market_positioning, "
        f"differentiation, competitive_landscape, customer_problems, customer_needs, "
        f"customer_journey, buying_triggers, objections, core_topics, entities, terminology, "
        f"search_strategy, seo_priorities, ai_llm_identity, llm_relevance, "
        f"ai_visibility_context, brand_tone_of_voice, strategic_objectives"
    )
    # Full JSON dump available any time via profile.to_dict() — omitted from
    # the console output here for readability, but ready to pass to an LLM
    # or to log for auditing purposes.

    # ---- PHASE 0 ----
    print("\n[PHASE 0] AI Crawlability Gate")
    gate = AICrawlabilityGate(site="buyerml.it")
    gate_result = gate.check_crawlability()
    print(json.dumps(gate_result, indent=2, ensure_ascii=False))

    if "PASS" not in gate_result["gate_status"]:
        print("Gate blocked: stopping the pipeline.")
        return

    crawler_activity = gate.monitor_crawler_activity()
    print(json.dumps(crawler_activity, indent=2, ensure_ascii=False))

    pages_for_llms = [
        {
            "title": "Business Process Automation",
            "url": "https://buyerml.it/",
            "description": "AI Advisory for process automation with AI Agents",
        }
    ]
    llms_txt = gate.generate_llms_txt(profile, pages_for_llms)
    print("\n--- Generated llms.txt ---")
    print(llms_txt)

    # ---- PHASE 1 ----
    print("\n[PHASE 1] Multi-Seed Trend Discovery")
    seeds = [
        {"seed": "business process automation", "category": "PROCESS", "priority": 1},
        {"seed": "repetitive tasks", "category": "PAIN", "priority": 2},
        {"seed": "AI automation", "category": "SOLUTION", "priority": 5},
    ]
    trend_discovery = TrendDiscovery(seeds)
    trending_seeds = trend_discovery.run()
    print(json.dumps(trending_seeds, indent=2, ensure_ascii=False))

    # ---- PHASE 2 ----
    print("\n[PHASE 2] BUYER Verticals + Functional Clusters")
    vertical_expansion = VerticalExpansion()
    verticals = vertical_expansion.run(mega_topic="business process automation")
    print(json.dumps(verticals, indent=2, ensure_ascii=False))

    # ---- PHASES 3, 4, 5, 6 for a sample vertical ----
    print("\n[PHASE 3-6] Pipeline for the 'customer service automation' vertical")
    keyword_expansion = KeywordExpansion()
    awareness_mapper = AwarenessMapper()
    intent_detector = IntentDetector()
    router = Router()
    format_selector = FormatSelector()

    vertical = "customer service automation"
    expanded_keywords = keyword_expansion.expand(vertical)
    mapped = awareness_mapper.run_batch(expanded_keywords, origin="BUYER", vertical=vertical)

    final_records = []
    for record in mapped:
        intent_data = intent_detector.detect(record["query"])
        record.update(intent_data)
        record = router.route(record)

        is_question = any(
            kw.get("type") == "question" and kw["query"] == record["query"]
            for kw in expanded_keywords
        )

        if record["routing"] in ("format_selector", "fast_track_commercial"):
            record = format_selector.select(record, is_question=is_question)

        final_records.append(record)

    print(json.dumps(final_records, indent=2, ensure_ascii=False))

    # ---- PHASE 7 ----
    print("\n[PHASE 7] AI Visibility Monitoring")
    monitor = AIVisibilityMonitor()
    visibility = monitor.check(
        prompts=["how to choose the right business process automation tool"]
    )
    print(json.dumps(visibility, indent=2, ensure_ascii=False))

    # ---- PHASE 8 ----
    print("\n[PHASE 8] Page Audit & Orchestrator")
    auditor = PageAuditor()
    page_audit = auditor.audit(
        url="/services/24h-emergency-service",
        has_faq=False,
        has_schema=False,
        has_eeat=False,
    )
    orchestrator = Orchestrator()
    orchestration_result = orchestrator.orchestrate([page_audit])
    print(json.dumps(orchestration_result, indent=2, ensure_ascii=False))

    print("\n" + "=" * 80)
    print("Pipeline completed.")
    print("=" * 80)


if __name__ == "__main__":
    run_pipeline()
