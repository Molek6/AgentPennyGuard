const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const config = require("./config");
const { rules, checkPayment, refund, log, getSpent } = require("./policy");

const SAFE = /^[a-z0-9_.-]+$/;

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

// Sends a real testnet payment using the NEAR CLI. Keys stay in the Windows keychain.
function sendNear(to, amount) {
  return new Promise((resolve, reject) => {
    if (!SAFE.test(config.SENDER) || !SAFE.test(to)) return reject(new Error("Unsafe account name"));
    const cmd = `npx.cmd near-cli-rs tokens ${config.SENDER} send-near ${to} "${amount.toFixed(4)} NEAR" network-config testnet sign-with-keychain send`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      console.log(stdout);
      if (stderr) console.log(stderr);
      if (err) return reject(new Error("see the PowerShell window for details"));
      const m = /Transaction ID:\s*([A-Za-z0-9]+)/i.exec(stdout);
      resolve(m ? m[1] : null);
    });
  });
}

// The one path every payment goes through: policy check first, then (if live) a real send.
async function handlePayment(toIn, amount, reason) {
  if (!Number.isFinite(amount) || amount < 0.0001) {
    return { allowed: false, why: "Amount must be at least 0.0001" };
  }
  const to = toIn === "VENDOR" ? config.VENDOR : String(toIn);
  const decision = checkPayment({ to, amount, reason });
  if (decision.allowed) {
    if (config.LIVE) {
      try {
        const tx = await sendNear(to, amount);
        decision.why += " | Sent on testnet" + (tx ? ". Tx: " + tx : "");
      } catch (e) {
        refund(amount);
        decision.allowed = false;
        decision.why = "Approved by policy, but the send failed: " + e.message;
      }
    } else {
      decision.why += " | Simulated (no transaction sent)";
    }
    decision.entry.allowed = decision.allowed;
    decision.entry.why = decision.why;
  }
  return { allowed: decision.allowed, why: decision.why };
}

// Very simple fallback "agent" used when no AI key is set.
function simpleParse(text) {
  const amt = text.match(/(\d+(\.\d+)?)/);
  const acct = text.match(/[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet/i);
  const to = acct ? acct[0].toLowerCase() : /vendor|supplier/i.test(text) ? "VENDOR" : "";
  return { to, amount: amt ? Number(amt[1]) : 0, reason: text.slice(0, 200) };
}

const SYSTEM_PROMPT =
  'You are a payment agent. Convert the user\'s request into JSON only, in this exact shape: ' +
  '{"to": "<account id, or VENDOR if the user says vendor or supplier>", "amount": <number in NEAR>, "reason": "<short reason>"}. ' +
  'If you cannot extract a payment, return {"error": "<why>"}. Output JSON only, no other text.';

async function askAgent(text) {
  const key = process.env.NEARAI_API_KEY;
  if (!key) return { ...simpleParse(text), source: "built-in parser (no AI key set)" };
  try {
    const r = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: config.MODEL,
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    if (!r.ok) throw new Error("AI service returned status " + r.status);
    const data = await r.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI did not return JSON");
    return { ...JSON.parse(m[0]), source: "NEAR AI Cloud (" + config.MODEL + ")" };
  } catch (e) {
    console.log("AI call failed:", e.message);
    return { ...simpleParse(text), source: "built-in parser (AI call failed: " + e.message + ")" };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      return send(res, 200, "text/html", fs.readFileSync(path.join(__dirname, "index.html")));
    }
    if (req.method === "GET" && req.url === "/api/state") {
      return send(res, 200, "application/json", JSON.stringify({ rules, spentToday: getSpent(), log, live: config.LIVE, ai: !!process.env.NEARAI_API_KEY }));
    }
    if (req.method === "POST" && req.url === "/api/pay") {
      const p = JSON.parse(await readBody(req));
      const result = await handlePayment(p.to, Number(p.amount), String(p.reason || ""));
      return send(res, 200, "application/json", JSON.stringify(result));
    }
    if (req.method === "POST" && req.url === "/api/agent") {
      const text = String(JSON.parse(await readBody(req)).text || "").slice(0, 1000);
      const proposal = await askAgent(text);
      if (proposal.error || !proposal.to) {
        return send(res, 200, "application/json", JSON.stringify({ proposal, allowed: false, why: "The agent could not turn that into a payment" }));
      }
      const reason = String(proposal.reason || "") + " | " + text;
      const result = await handlePayment(String(proposal.to), Number(proposal.amount), reason);
      return send(res, 200, "application/json", JSON.stringify({ proposal, ...result }));
    }
    send(res, 404, "text/plain", "Not found");
  } catch (e) {
    console.log("Request error:", e.message);
    send(res, 400, "application/json", JSON.stringify({ allowed: false, why: "Bad request" }));
  }
});

server.listen(3000, () =>
  console.log(
    "AgentPennyGuard running at http://localhost:3000 | payments: " + (config.LIVE ? "LIVE testnet" : "simulated") +
    " | agent: " + (process.env.NEARAI_API_KEY ? "NEAR AI Cloud" : "built-in parser")
  )
);