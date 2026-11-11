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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    return send(res, 200, "text/html", fs.readFileSync(path.join(__dirname, "index.html")));
  }
  if (req.method === "GET" && req.url === "/api/state") {
    return send(res, 200, "application/json", JSON.stringify({ rules, spentToday: getSpent(), log, live: config.LIVE }));
  }
  if (req.method === "POST" && req.url === "/api/pay") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const p = JSON.parse(body);
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount < 0.0001) {
          return send(res, 400, "application/json", JSON.stringify({ allowed: false, why: "Amount must be at least 0.0001" }));
        }
        const to = p.to === "VENDOR" ? config.VENDOR : String(p.to);
        const decision = checkPayment({ to, amount, reason: String(p.reason || "") });

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
        send(res, 200, "application/json", JSON.stringify({ allowed: decision.allowed, why: decision.why }));
      } catch (e) {
        send(res, 400, "application/json", JSON.stringify({ allowed: false, why: "Bad request" }));
      }
    });
    return;
  }
  send(res, 404, "text/plain", "Not found");
});

server.listen(3000, () =>
  console.log("LeashPay running at http://localhost:3000 | mode: " + (config.LIVE ? "LIVE testnet" : "simulated"))
);