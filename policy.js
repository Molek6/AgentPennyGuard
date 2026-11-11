// LeashPay policy engine: decides whether an AI agent's payment is allowed.
const rules = {
  perPaymentCap: 5,
  dailyCap: 10,
  allowlist: ["weather-api.testnet", "data-feed.testnet"],
};

let spentToday = 0;
const log = [];

const injection = /ignore (all |your )?(previous |prior )?(rules|instructions)|send everything|drain/i;

function checkPayment({ to, amount, reason }) {
  let decision = { allowed: true, why: "Within all limits" };

  if (injection.test(reason || "")) {
    decision = { allowed: false, why: "Request looks like a prompt-injection attempt" };
  } else if (!rules.allowlist.includes(to)) {
    decision = { allowed: false, why: to + " is not on the allowlist" };
  } else if (amount > rules.perPaymentCap) {
    decision = { allowed: false, why: "Over the per-payment cap of " + rules.perPaymentCap };
  } else if (spentToday + amount > rules.dailyCap) {
    decision = { allowed: false, why: "Would exceed the daily cap of " + rules.dailyCap };
  }

  if (decision.allowed) spentToday += amount;
  log.push({ time: new Date().toISOString(), to, amount, reason, ...decision });
  return decision;
}

module.exports = { rules, checkPayment, log, getSpent: () => spentToday };