const http = require("http");
const fs = require("fs");
const path = require("path");
const { rules, checkPayment, log, getSpent } = require("./policy");

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    return send(res, 200, "text/html", fs.readFileSync(path.join(__dirname, "index.html")));
  }
  if (req.method === "GET" && req.url === "/api/state") {
    return send(res, 200, "application/json", JSON.stringify({ rules, spentToday: getSpent(), log }));
  }
  if (req.method === "POST" && req.url === "/api/pay") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return send(res, 400, "application/json", JSON.stringify({ allowed: false, why: "Amount must be a positive number" }));
        }
        const decision = checkPayment({ to: String(p.to), amount, reason: String(p.reason || "") });
        send(res, 200, "application/json", JSON.stringify(decision));
      } catch (e) {
        send(res, 400, "application/json", JSON.stringify({ allowed: false, why: "Bad request" }));
      }
    });
    return;
  }
  send(res, 404, "text/plain", "Not found");
});

server.listen(3000, () => console.log("LeashPay running at http://localhost:3000"));