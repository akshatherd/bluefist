"use client";

import React, { useState } from "react";

export default function PricingTab() {
  const [isYearly, setIsYearly] = useState(true);

  const plans = [
    {
      name: "Developer",
      tagline: "For individual builders and open-source maintainers.",
      monthlyPrice: 0,
      yearlyPrice: 0,
      badge: "Free Forever",
      highlight: false,
      features: [
        "Up to 50 AI-TDD Fixes / mo",
        "Single GitHub Repository",
        "Local Circuit Breaker Engine (Ollama)",
        "Basic AST Context Parser",
        "Community Discord Support",
      ],
      cta: "Get Started Free",
    },
    {
      name: "Team & Startup",
      tagline: "For growing dev teams requiring autonomous incident remediation.",
      monthlyPrice: 3499,
      yearlyPrice: 2799,
      badge: "Most Popular",
      highlight: true,
      features: [
        "Up to 1,000 AI-TDD Fixes / mo",
        "Up to 10 Repositories",
        "Cross-File AST Call-Graph Tracing",
        "Automated PyTest Suite Synthesis",
        "GitHub Actions & Webhook Integration",
        "Twilio & WhatsApp Incident Alerts",
        "Priority Support (4-hour SLA)",
      ],
      cta: "Start 14-Day Free Trial",
    },
    {
      name: "Enterprise SRE",
      tagline: "For mission-critical infrastructure requiring zero-trust security.",
      monthlyPrice: 14999,
      yearlyPrice: 11999,
      badge: "Zero-Trust Ready",
      highlight: false,
      features: [
        "Unlimited AI-TDD Hotfixes",
        "Unlimited Repositories & Microservices",
        "Skyflow Zero-Trust PII / Secret Vault",
        "Custom LLM Routing (Gemini, Claude, Self-Hosted)",
        "Role-Based Access Control (RBAC) & Audit Logs",
        "Dedicated SRE Account Manager",
        "99.99% Uptime Guarantee (SLA)",
      ],
      cta: "Contact Enterprise Sales",
    },
  ];

  return (
    <div className="w-full min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8 font-sans">
      {/* Header Section */}
      <div className="text-center max-w-3xl mx-auto mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-semibold tracking-wide uppercase mb-4 shadow-[0_0_15px_rgba(6,182,212,0.15)]">
          🛡️ Enterprise-Grade Reliability
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
          Predictable Pricing for Autonomous SRE
        </h1>
        <p className="mt-4 text-slate-400 text-lg">
          Stop burning engineer hours on manual hotfixes. Choose a plan that scales with your codebase.
        </p>

        {/* Monthly / Yearly Toggle */}
        <div className="mt-8 flex justify-center items-center gap-4">
          <span className={`text-sm font-medium ${!isYearly ? "text-white" : "text-slate-400"}`}>
            Monthly Billing
          </span>
          <button
            onClick={() => setIsYearly(!isYearly)}
            className="relative w-14 h-8 rounded-full bg-slate-800 p-1 transition-colors duration-200 border border-slate-700 focus:outline-none"
          >
            <div
              className={`w-6 h-6 rounded-full bg-cyan-400 shadow-md transform transition-transform duration-200 ${
                isYearly ? "translate-x-6" : "translate-x-0"
              }`}
            />
          </button>
          <span className={`text-sm font-medium flex items-center gap-2 ${isYearly ? "text-white" : "text-slate-400"}`}>
            Yearly Billing
            <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">
              Save 20%
            </span>
          </span>
        </div>
      </div>

      {/* Pricing Cards Grid */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
        {plans.map((plan, index) => {
          const price = isYearly ? plan.yearlyPrice : plan.monthlyPrice;

          return (
            <div
              key={index}
              className={`relative flex flex-col justify-between rounded-2xl p-8 transition-all duration-300 ${
                plan.highlight
                  ? "bg-slate-900/90 border-2 border-cyan-500/60 shadow-[0_0_35px_rgba(6,182,212,0.2)] scale-105 z-10"
                  : "bg-slate-900/40 border border-slate-800 hover:border-slate-700 hover:bg-slate-900/60"
              }`}
            >
              {/* Badge */}
              {plan.badge && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase shadow-md ${
                      plan.highlight
                        ? "bg-cyan-500 text-slate-950"
                        : "bg-slate-800 border border-slate-700 text-slate-300"
                    }`}
                  >
                    {plan.badge}
                  </span>
                </div>
              )}

              <div>
                {/* Plan Header */}
                <h3 className="text-2xl font-bold text-white mb-2">{plan.name}</h3>
                <p className="text-slate-400 text-sm min-h-[40px]">{plan.tagline}</p>

                {/* Price Display */}
                <div className="my-6 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold text-white">
                    ₹{price.toLocaleString("en-IN")}
                  </span>
                  <span className="text-slate-400 text-sm font-medium">
                    {price === 0 ? "" : "/ month"}
                  </span>
                </div>

                <hr className="border-slate-800 my-6" />

                {/* Features List */}
                <ul className="space-y-3.5 mb-8">
                  {plan.features.map((feature, idx) => (
                    <li key={idx} className="flex items-start gap-3 text-sm text-slate-300">
                      <svg
                        className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                      </svg>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Call to Action Button */}
              <button
                className={`w-full py-3.5 px-6 rounded-xl font-bold text-sm tracking-wide transition-all duration-200 ${
                  plan.highlight
                    ? "bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-[0_0_20px_rgba(6,182,212,0.4)]"
                    : "bg-slate-800 hover:bg-slate-700 text-white border border-slate-700"
                }`}
              >
                {plan.cta}
              </button>
            </div>
          );
        })}
      </div>

      {/* Trust & Guarantee Banner */}
      <div className="max-w-4xl mx-auto mt-16 text-center border border-slate-800/80 rounded-2xl p-6 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex flex-wrap justify-around items-center gap-6 text-slate-400 text-xs font-semibold uppercase tracking-wider">
          <div className="flex items-center gap-2">
            <span className="text-cyan-400 text-lg">⚡</span> Instant Setup in 2 Minutes
          </div>
          <div className="flex items-center gap-2">
            <span className="text-cyan-400 text-lg">🛡️</span> Circuit Breaker Failover Included
          </div>
          <div className="flex items-center gap-2">
            <span className="text-cyan-400 text-lg">💳</span> Cancel or Upgrade Anytime
          </div>
        </div>
      </div>
    </div>
  );
}