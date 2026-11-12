// AgentPennyGuard policy engine: decides whether an AI agent's payment is allowed.
const config = require("./config");

const rules = {
  perPaymentCap: 0.5, // max NEAR in a single payment
  dailyCap: 1,        // max NEAR per day
  allowlist: [config.VENDOR],
};

let spentToday = 0;
const log = [];

const injection = /ignore (all |your )?(previous |prior )?(rules|instructions)|send everything|drain/i;
const round = (n) => Math.round(n * 1e6) / 1e6;

function checkPayment({ to, amount, reason }) {
  let decision = { allowed: true, why: "Within all limits" };

  if (injection.test(reason || "")) {
    decision = { allowed: false, why: "Request looks like a prompt-injection attempt" };
  } else if (!rules.allowlist.includes(to)) {
    decision = { allowed: false, why: to + " is not on the allowlist" };
  } else if (amount > rules.perPaymentCap) {
    decision = { allowed: false, why: "Over the per-payment cap of " + rules.perPaymentCap + " NEAR" };
  } else if (round(spentToday + amount) > rules.dailyCap) {
    decision = { allowed: false, why: "Would exceed the daily cap of " + rules.dailyCap + " NEAR" };
  }

  if (decision.allowed) spentToday = round(spentToday + amount);
  const entry = { time: new Date().toISOString(), to, amount, reason, ...decision };
  log.push(entry);
  return { ...decision, entry };
}

function refund(amount) {
  spentToday = round(spentToday - amount);
}

module.exports = { rules, checkPayment, refund, log, getSpent: () => spentToday };