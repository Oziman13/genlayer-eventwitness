// Browser tests with a mock EIP-1193 wallet and a mock Studio RPC. They check the page's behaviour
// (wallet connect, roles, transaction lifecycle). They do NOT prove real MetaMask or real Studionet behaviour.
// Run from the repository root:  npm install && npx playwright-core install chromium && npm test
// (set CHROMIUM_PATH to use an already installed Chromium instead of the downloaded one)
import { chromium } from "playwright-core";
import { abi } from "genlayer-js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const PORT = 8772;
const FUNDER = "0x" + "a1".repeat(20), BUILDER = "0x" + "b2".repeat(20), OTHER = "0x" + "c3".repeat(20);
const CONTRACT = "0x" + "d4".repeat(20), NEWC = "0x" + "e5".repeat(20);
const NOW = Math.floor(Date.now() / 1000);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(PORT, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); };

const baseState = over => ({
  owner: FUNDER, event: "Tour X, Istanbul, 2026-11-20", original_date: "2026-11-20",
  hosts: ["a.example.com", "b.example.org", "c.example.net"], base_sources: [], extra_sources: [], challenge_url: "",
  sources: ["https://a.example.com/x", "https://b.example.org/x", "https://c.example.net/x"],
  round: 1, phase: "PROVISIONAL", candidate: "CANCELLED", latest_outcome: "CANCELLED", deadline: NOW - 100,
  challenge_used: 0, window_seconds: 300, last_finalized_status: "UNKNOWN", last_finalized_round: 0, current_finalized: 0, history_count: 0,
  ...over,
});

async function newCase({ state, txScripts = {}, wallet = {}, hasWallet = true, nonceBump = false }) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(String(e)));
  // states: per-contract state (lower-case address) for tests with more than one contract
  // listed: what the node returns for the per-account transaction listing; null = the call fails
  const rpc = { methods: [], state, states: {}, txScripts, nonce: 0, txIdx: {}, sends: [], listed: [], nonceFail: false, onFinal: null, finalSeen: {} };
  await p.exposeFunction("__bumpNonce", () => { rpc.nonce++; });
  await p.route("**/contracts/event_witness.py", r => r.fulfill({ status: 200, contentType: "text/plain", body: "class EventWitness:\n  pass\n" }));
  await p.route("https://studio.genlayer.com/**", async r => {
    const req = r.request(); let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch {}
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const arr = Array.isArray(body) ? body : [body];
    const out = arr.map(x => {
      rpc.methods.push(x.method);
      if (x.method === "gen_call") {
        const txt = Buffer.from((x.params[0].data || "").replace(/^0x/, ""), "hex").toString("latin1");
        let s = "NONE";
        const to = String(x.params[0].to || "").toLowerCase();
        if (txt.includes("get_state_json")) s = JSON.stringify(rpc.states[to] || rpc.state);
        else if (txt.includes("__none__")) s = rpc.state.phase === "FINALIZED" ? rpc.state.final_verdict : "NONE";
        else if (txt.includes("get_history_json")) s = JSON.stringify({ action: "ASSESS", outcome: "CANCELLED", time: NOW, note: "", caller: FUNDER });
        return { jsonrpc: "2.0", id: x.id, result: Buffer.from(abi.calldata.encode(s)).toString("hex") };
      }
      if (x.method === "eth_getTransactionCount") return rpc.nonceFail ? { jsonrpc: "2.0", id: x.id, error: { code: -32000, message: "mock: nonce unavailable" } } : { jsonrpc: "2.0", id: x.id, result: "0x" + rpc.nonce.toString(16) };
      if (x.method === "sim_getTransactionsForAddress") return rpc.listed === null ? { jsonrpc: "2.0", id: x.id, error: { code: -32601, message: "mock: listing unsupported" } } : { jsonrpc: "2.0", id: x.id, result: rpc.listed };
      if (x.method === "eth_gasPrice") return { jsonrpc: "2.0", id: x.id, result: "0x1" };
      if (x.method === "eth_estimateGas") return { jsonrpc: "2.0", id: x.id, result: "0x30d40" };
      if (x.method === "eth_chainId") return { jsonrpc: "2.0", id: x.id, result: "0xf22f" };
      if (x.method === "eth_getTransactionByHash") {
        const h = x.params[0]; const seq = rpc.txScripts[h] || [];
        const i = Math.min(rpc.txIdx[h] || 0, seq.length - 1); rpc.txIdx[h] = (rpc.txIdx[h] || 0) + 1;
        if (!seq.length) return { jsonrpc: "2.0", id: x.id, result: null };
        if (seq[i].status === "FINALIZED" && !rpc.finalSeen[h]) { rpc.finalSeen[h] = true; rpc.onFinal && rpc.onFinal(h); }
        return { jsonrpc: "2.0", id: x.id, result: seq[i] };
      }
      return { jsonrpc: "2.0", id: x.id, error: { code: -32000, message: "mock: unsupported " + x.method } };
    });
    r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(Array.isArray(body) ? out : out[0]) });
  });
  if (hasWallet) {
    await p.addInitScript(cfg => {
      const listeners = {};
      window.__reqs = [];
      window.__w = { chainId: cfg.chainId, accounts: cfg.accounts, knownChain: cfg.knownChain, rejectConnect: cfg.rejectConnect, rejectSwitch: false, sendMode: cfg.sendMode || "ok", hash: cfg.hash || "0x" + "ab".repeat(32) };
      window.ethereum = {
        isMock: true,
        on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
        emit: (e, v) => (listeners[e] || []).forEach(f => f(v)),
        request: async ({ method, params }) => {
          window.__reqs.push({ method, params });
          const w = window.__w;
          if (method === "eth_chainId") return w.chainId;
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            if (w.rejectConnect) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            return w.accounts;
          }
          if (method === "wallet_switchEthereumChain") {
            if (w.rejectSwitch) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            if (!w.knownChain && params[0].chainId !== w.chainId) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
            w.chainId = params[0].chainId; return null;
          }
          if (method === "wallet_addEthereumChain") { w.knownChain = true; return null; }
          if (method === "eth_sendTransaction") {
            if (w.sendMode === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            if (w.sendMode === "errorButSent") { await window.__bumpNonce(); throw new Error("RPC timeout after broadcast"); }
            if (w.sendMode === "errorNotSent") throw new Error("insufficient funds");
            await window.__bumpNonce(); return w.hash;
          }
          throw new Error("mock wallet: unsupported " + method);
        },
      };
    }, { chainId: "0xf22f", accounts: [FUNDER], knownChain: true, ...wallet });
  }
  const open = async (qs = "") => { await p.goto(`http://localhost:${PORT}/index.html?poll=50${qs}`); };
  return { p, ctx, rpc, errs, open };
}


const tx = (status, exec, extra = {}) => ({ hash: "0x" + "ab".repeat(32), status, data: {}, consensus_data: exec ? { leader_receipt: [{ execution_result: exec }] } : undefined, recipient: CONTRACT, ...extra });
const text = (p, sel) => p.textContent(sel);
const waitText = (p, sel, re, t = 8000) => p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s).textContent), [sel, re.source], { timeout: t }).then(() => true).catch(() => false);
const H = "0x" + "ab".repeat(32);
const connect = async c => { await c.p.click("#connect"); await waitText(c.p, "#wstatus", /Connected/); };
const loaded = async c => { await c.open(`&address=${CONTRACT}`); await c.p.waitForSelector("#event", { state: "visible" }); };

{ // no wallet
  const c = await newCase({ state: baseState(), hasWallet: false });
  await loaded(c);
  ok("no wallet: feed readable", (await text(c.p, "#event")).startsWith("Tour X"));
  ok("no wallet: actions locked with reason", (await c.p.locator("#fin").isDisabled()) && /Connect a wallet/.test(await text(c.p, "#r_finalize")));
  ok("no private key input / storage", (await c.p.locator("input[type=password]").count()) === 0 && !(await c.p.content()).includes("okey") && (await c.p.evaluate(() => Object.keys(localStorage))).every(k => !/key/i.test(k)));
  await c.ctx.close();
}
{ // connect: wrong chain, unknown chain
  const c = await newCase({ state: baseState(), wallet: { chainId: "0x1", knownChain: false } });
  await loaded(c); await connect(c);
  const reqs = await c.p.evaluate(() => window.__reqs.map(r => r.method));
  ok("connect: adds then switches to Studio chain", reqs.includes("wallet_addEthereumChain") && (await c.p.evaluate(() => window.__w.chainId)) === "0xf22f");
  ok("connect: role owner shown", /owner/.test(await text(c.p, "#rolepill")));
  await c.ctx.close();
}
{
  const c = await newCase({ state: baseState(), wallet: { rejectConnect: true } });
  await loaded(c); await c.p.click("#connect");
  ok("connect rejected: explained", await waitText(c.p, "#wmsg", /declined/));
  await c.ctx.close();
}
{ // roles / phases
  const c = await newCase({ state: baseState({ deadline: NOW + 600 }), wallet: { accounts: [OTHER] } });
  await loaded(c); await connect(c);
  ok("viewer in open window: challenge enabled, finalize locked, owner actions locked",
    !(await c.p.locator("#chal").isDisabled()) && (await c.p.locator("#fin").isDisabled()) && (await c.p.locator("#o_round").isDisabled()) && (await c.p.locator("#o_assess").isDisabled()) && (await c.p.locator("#o_add").isDisabled()));
  ok("viewer: reasons shown", /still open/.test(await text(c.p, "#r_finalize")) && /Only the owner/.test(await text(c.p, "#r_start")));
  await c.ctx.close();
}
{
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER] } });
  await loaded(c); await connect(c);
  ok("viewer after window: finalize enabled, challenge locked ('closed')", !(await c.p.locator("#fin").isDisabled()) && (await c.p.locator("#chal").isDisabled()) && /closed/.test(await text(c.p, "#r_challenge")));
  await c.ctx.close();
}
{
  const c = await newCase({ state: baseState({ deadline: NOW + 600, challenge_used: 1 }), wallet: { accounts: [OTHER] } });
  await loaded(c); await connect(c);
  ok("challenge already used: locked with reason", (await c.p.locator("#chal").isDisabled()) && /One challenge per round/.test(await text(c.p, "#r_challenge")));
  await c.ctx.close();
}
{
  const c = await newCase({ state: baseState({ phase: "IDLE", candidate: "UNKNOWN", latest_outcome: "UNKNOWN", deadline: 0, round: 0 }), wallet: { accounts: [FUNDER] } });
  await loaded(c); await connect(c);
  ok("owner in IDLE: start + add enabled, assess/remove/challenge/finalize locked",
    !(await c.p.locator("#o_round").isDisabled()) && !(await c.p.locator("#o_add").isDisabled()) && (await c.p.locator("#o_assess").isDisabled()) && (await c.p.locator("#o_rem").isDisabled()) && (await c.p.locator("#chal").isDisabled()) && (await c.p.locator("#fin").isDisabled()));
  ok("owner IDLE: remove explains there is nothing to remove", /no extra sources/.test(await text(c.p, "#r_remove")));
  await c.ctx.close();
}
{
  const c = await newCase({ state: baseState({ phase: "OPEN", candidate: "UNKNOWN", deadline: 0, extra_sources: ["https://a.example.com/y"] }), wallet: { accounts: [FUNDER] } });
  await loaded(c); await connect(c);
  ok("owner OPEN: assess enabled; start and source edits locked", !(await c.p.locator("#o_assess").isDisabled()) && (await c.p.locator("#o_round").isDisabled()) && (await c.p.locator("#o_add").isDisabled()) && /between assessments/.test(await text(c.p, "#r_add")));
  await c.ctx.close();
}
{
  const c = await newCase({ state: baseState({ phase: "FINALIZED", deadline: 0, extra_sources: ["https://a.example.com/y"] }), wallet: { accounts: [FUNDER] } });
  await loaded(c); await connect(c);
  await c.p.fill("#osrc", "https://a.example.com/zzz"); await c.p.dispatchEvent("#osrc", "input");
  ok("owner FINALIZED: remove of a non-extra URL is locked with reason", (await c.p.locator("#o_rem").isDisabled()) && /not one of the extra/.test(await text(c.p, "#r_remove")));
  await c.p.fill("#osrc", "https://a.example.com/y"); await c.p.dispatchEvent("#osrc", "input");
  ok("owner FINALIZED: remove of an extra URL is enabled", !(await c.p.locator("#o_rem").isDisabled()));
  ok("owner FINALIZED: challenge/finalize locked", (await c.p.locator("#chal").isDisabled()) && (await c.p.locator("#fin").isDisabled()));
  await c.ctx.close();
}
{ // lifecycle: challenge
  const c = await newCase({ state: baseState({ deadline: NOW + 600 }), wallet: { accounts: [OTHER], hash: H }, txScripts: { [H]: [tx("PENDING"), tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS")] } });
  await loaded(c); await connect(c);
  await c.p.click("#chal");
  ok("challenge: empty fields not sent", /https:\/\//.test(await text(c.p, "#txmsg")) && !(await c.p.evaluate(() => window.__reqs.some(r => r.method === "eth_sendTransaction"))));
  await c.p.fill("#curl", "https://a.example.com/proof"); await c.p.fill("#cnote", "Organiser page shows the show is on");
  await c.p.click("#chal");
  ok("challenge: ACCEPTED shown as in progress", await waitText(c.p, "#txmsg", /network status ACCEPTED/));
  ok("challenge: FINALIZED+SUCCESS reported as applied", await waitText(c.p, "#txmsg", /was applied/));
  const sent = await c.p.evaluate(() => window.__reqs.find(r => r.method === "eth_sendTransaction"));
  ok("challenge: signed by the connected wallet account", sent && sent.params[0].from.toLowerCase() === OTHER);
  await c.ctx.close();
}
{ // contract refuses
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER], hash: H }, txScripts: { [H]: [tx("ACCEPTED", "ERROR"), tx("FINALIZED", "ERROR")] } });
  await loaded(c); await connect(c); await c.p.click("#fin");
  ok("finalize refused by contract: not reported as applied", await waitText(c.p, "#txmsg", /contract refused it/) && !/was applied/.test(await text(c.p, "#txmsg")));
  await c.ctx.close();
}
{ // owner assess success, state reloads
  const c = await newCase({ state: baseState({ phase: "OPEN", candidate: "UNKNOWN", deadline: 0, history_count: 1 }), wallet: { accounts: [FUNDER], hash: H }, txScripts: { [H]: [tx("FINALIZED", "SUCCESS")] } });
  await loaded(c); await connect(c); await c.p.click("#o_assess");
  const applied = await waitText(c.p, "#txmsg", /was applied/);
  for (let i = 0; i < 40 && c.rpc.methods.filter(m => m === "gen_call").length < 3; i++) await new Promise(r => setTimeout(r, 100)); // the reload runs right after the message
  ok("owner assess: applied and state reloaded", applied && c.rpc.methods.filter(m => m === "gen_call").length >= 3);
  await c.ctx.close();
}
{ // rejection, not-sent, ambiguous
  for (const [mode, re, name] of [["reject", /Nothing was sent/, "user rejection"], ["errorNotSent", /was not sent/, "send error, nonce unchanged"], ["errorButSent", /may have been sent/, "send error, nonce moved (ambiguous)"]]) {
    const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER], sendMode: mode } });
    await loaded(c); await connect(c); await c.p.click("#fin");
    ok(name, await waitText(c.p, "#txmsg", re));
    await c.ctx.close();
  }
}
{ // undetermined
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER], hash: H }, txScripts: { [H]: [tx("PENDING"), tx("UNDETERMINED")] } });
  await loaded(c); await connect(c); await c.p.click("#fin");
  ok("undetermined: reported as not applied", await waitText(c.p, "#txmsg", /not applied \(network status UNDETERMINED/));
  await c.ctx.close();
}
{ // wrong network at send time
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER], hash: H }, txScripts: { [H]: [tx("FINALIZED", "SUCCESS")] } });
  await loaded(c); await connect(c);
  await c.p.evaluate(() => { window.__w.chainId = "0x1"; window.ethereum.emit("chainChanged", "0x1"); });
  ok("network switched away: warning", await waitText(c.p, "#wmsg", /Wrong network/));
  await c.p.click("#fin");
  ok("wrong network at send: wallet switched back, then applied", await waitText(c.p, "#txmsg", /was applied/));
  await c.ctx.close();
}
{ // resume
  const c = await newCase({ state: baseState(), wallet: { accounts: [OTHER] }, txScripts: { [H]: [tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS")] } });
  await c.p.addInitScript(([h, a]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("ew_pending_tx", JSON.stringify({ hash: h, label: "finalize", fn: "finalize", address: a, at: Date.now() })); sessionStorage.setItem("seeded", "1"); } }, [H, CONTRACT]);
  await c.open(`&address=${CONTRACT}`);
  ok("resume: open transaction found and finished", await waitText(c.p, "#txmsg", /was applied/));
  ok("resume: record cleared", (await c.p.evaluate(() => localStorage.getItem("ew_pending_tx"))) === null);
  await c.ctx.close();
}
{ // setup
  const c = await newCase({ state: baseState({ owner: FUNDER, event: "New event feed" }), wallet: { accounts: [FUNDER], hash: H }, txScripts: { [H]: [tx("PENDING"), tx("FINALIZED", "SUCCESS", { recipient: NEWC })] } });
  await c.open(`&address=${CONTRACT}`);
  await c.p.click("#newev");
  await c.p.click("#s_deploy");
  ok("setup: asks to connect and lists field errors", /Connect a wallet/.test(await text(c.p, "#s_errs")) && /Event identity/.test(await text(c.p, "#s_errs")));
  await connect(c);
  await c.p.fill("#s_event", "Tour X, Istanbul, 2026-11-20"); await c.p.fill("#s_date", "2026-11-20");
  await c.p.fill("#s_u1", "https://a.example.com/e"); await c.p.fill("#s_u2", "https://sub.a.example.com/e"); await c.p.fill("#s_u3", "https://c.example.net/e");
  await c.p.click("#s_deploy");
  ok("setup: two sources on the same site rejected before any transaction", /three distinct sites/.test(await text(c.p, "#s_errs")) && !(await c.p.evaluate(() => window.__reqs.some(r => r.method === "eth_sendTransaction"))));
  await c.p.fill("#s_u2", "https://b.example.org/e"); await c.p.fill("#s_window", "100");
  await c.p.click("#s_deploy");
  ok("setup: window out of range rejected", /300 to 86400/.test(await text(c.p, "#s_errs")));
  await c.p.fill("#s_window", "300");
  await c.p.click("#s_deploy");
  ok("setup: deploy signed by wallet", await c.p.waitForFunction(() => window.__reqs.some(r => r.method === "eth_sendTransaction"), null, { timeout: 8000 }).then(() => true).catch(() => false));
  ok("setup: new address adopted only after FINALIZED+SUCCESS and share link shown", await c.p.waitForFunction(a => document.getElementById("addr").value === a, NEWC, { timeout: 8000 }).then(() => true).catch(() => false) && await waitText(c.p, "#txmsg", new RegExp("\\?address=" + NEWC)));
  await c.ctx.close();
}
{ // deploy refused
  const c = await newCase({ state: baseState(), wallet: { accounts: [FUNDER], hash: H }, txScripts: { [H]: [tx("FINALIZED", "ERROR", { recipient: NEWC })] } });
  await c.open(`&address=${CONTRACT}`);
  await c.p.click("#newev"); await connect(c);
  await c.p.fill("#s_event", "Tour X, Istanbul, 2026-11-20"); await c.p.fill("#s_date", "2026-11-20");
  await c.p.fill("#s_u1", "https://a.example.com/e"); await c.p.fill("#s_u2", "https://b.example.org/e"); await c.p.fill("#s_u3", "https://c.example.net/e");
  await c.p.click("#s_deploy");
  ok("deploy refused: reported and address NOT adopted", await waitText(c.p, "#txmsg", /contract refused it/) && (await c.p.inputValue("#addr")) === CONTRACT);
  await c.ctx.close();
}
{ // remembers the last loaded address across a plain reload
  const c = await newCase({ state: baseState({ event: "Remembered feed" }) });
  await loaded(c);
  await c.p.goto(`http://localhost:${PORT}/index.html?poll=50`);
  await c.p.waitForSelector("#event", { state: "visible" });
  ok("reload without ?address= reopens the last loaded contract", (await c.p.inputValue("#addr")) === CONTRACT && (await text(c.p, "#event")) === "Remembered feed");
  await c.ctx.close();
}
{ // hostile content
  const c = await newCase({ state: baseState({ event: "<img src=x onerror=alert(1)>" }) });
  const dialogs = []; c.p.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
  await loaded(c);
  ok("hostile event text rendered as text", (await text(c.p, "#event")).includes("<img") && dialogs.length === 0);
  ok("no page errors in the whole run", c.errs.length === 0, c.errs.join("|"));
  await c.ctx.close();
}

// ============================ NEW: wallet paths, ambiguous-send recovery, reload recovery ============================
const CONTRACT2 = "0x" + "f6".repeat(20);
const hexData = c => c.p.evaluate(() => (window.__reqs.filter(r => r.method === "eth_sendTransaction").pop() || { params: [{}] }).params[0].data || "");
const dataText = async c => Buffer.from((await hexData(c)).replace(/^0x/, ""), "hex").toString("latin1");
const sendCount = c => c.p.evaluate(() => window.__reqs.filter(r => r.method === "eth_sendTransaction").length);
const pend = c => c.p.evaluate(() => JSON.parse(localStorage.getItem("ew_pending_tx") || "null"));
const seed = (c, rec) => c.p.addInitScript(r => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("ew_pending_tx", JSON.stringify(r)); sessionStorage.setItem("seeded", "1"); } }, rec);
const allLocked = async c => (await Promise.all(["#o_round", "#o_assess", "#o_add", "#o_rem", "#chal", "#fin", "#s_deploy"].map(i => c.p.locator(i).isDisabled()))).every(Boolean);
const listedTx = (over = {}) => ({ hash: H, from_address: OTHER, to_address: CONTRACT, nonce: 0, created_at: Math.floor(Date.now() / 1000), ...over });

// --- the three owner wallet paths: start_round, add_source, remove_source -------------------------------
{ // start_round
  const c = await newCase({ state: baseState({ phase: "IDLE", candidate: "UNKNOWN", latest_outcome: "UNKNOWN", deadline: 0, round: 0 }), wallet: { accounts: [FUNDER], hash: H },
    txScripts: { [H]: [tx("PENDING"), tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS")] } });
  c.rpc.onFinal = () => { c.rpc.state = baseState({ phase: "OPEN", candidate: "UNKNOWN", latest_outcome: "UNKNOWN", deadline: 0, round: 1 }); };
  await loaded(c); await connect(c); await c.p.click("#o_round");
  ok("start_round: ACCEPTED shown as in progress, not applied", await waitText(c.p, "#txmsg", /network status ACCEPTED/) && !/was applied/.test(await text(c.p, "#txmsg")));
  ok("start_round: FINALIZED+SUCCESS reported as applied", await waitText(c.p, "#txmsg", /start_round was applied/));
  const sent = await c.p.evaluate(() => window.__reqs.find(r => r.method === "eth_sendTransaction"));
  const sdt = await dataText(c);
  ok("start_round: signed by the owner account", sent && sent.params[0].from.toLowerCase() === FUNDER);
  ok("start_round: the call data names start_round and carries the loaded contract's address", sdt.includes("start_round") && (await hexData(c)).toLowerCase().includes(CONTRACT.slice(2)));
  ok("start_round: state reloaded (round 1, OPEN) and pending record cleared", (await c.p.waitForFunction(() => document.getElementById("round").textContent === "1" && document.getElementById("phase").textContent === "OPEN", null, { timeout: 5000 }).then(() => true).catch(() => false)) && (await pend(c)) === null);
  await c.ctx.close();
}
{ // add_source
  const NEW = "https://a.example.com/extra";
  const c = await newCase({ state: baseState({ phase: "IDLE", candidate: "UNKNOWN", latest_outcome: "UNKNOWN", deadline: 0, round: 0 }), wallet: { accounts: [FUNDER], hash: H },
    txScripts: { [H]: [tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS")] } });
  c.rpc.onFinal = () => { c.rpc.state = baseState({ phase: "IDLE", candidate: "UNKNOWN", latest_outcome: "UNKNOWN", deadline: 0, round: 0, extra_sources: [NEW], sources: [...c.rpc.state.sources, NEW] }); };
  await loaded(c); await connect(c);
  await c.p.fill("#osrc", "http://a.example.com/insecure"); await c.p.click("#o_add");
  ok("add_source: a non-https URL is refused before any transaction", /https:\/\//.test(await text(c.p, "#txmsg")) && (await sendCount(c)) === 0);
  await c.p.fill("#osrc", NEW); await c.p.click("#o_add");
  ok("add_source: reported as applied only after FINALIZED+SUCCESS", await waitText(c.p, "#txmsg", /add_source was applied/));
  const dt = await dataText(c);
  ok("add_source: the call data carries the function and the URL", dt.includes("add_source") && dt.includes(NEW));
  ok("add_source: signed by the owner", (await c.p.evaluate(() => window.__reqs.find(r => r.method === "eth_sendTransaction").params[0].from.toLowerCase())) === FUNDER);
  ok("add_source: new source shown after reload of state", await c.p.waitForFunction(u => document.getElementById("sources").textContent.includes(u), NEW, { timeout: 5000 }).then(() => true).catch(() => false));
  await c.ctx.close();
}
{ // add_source refused by the contract
  const c = await newCase({ state: baseState({ phase: "IDLE", deadline: 0, round: 0 }), wallet: { accounts: [FUNDER], hash: H }, txScripts: { [H]: [tx("ACCEPTED", "ERROR"), tx("FINALIZED", "ERROR")] } });
  await loaded(c); await connect(c); await c.p.fill("#osrc", "https://a.example.com/extra"); await c.p.click("#o_add");
  ok("add_source refused by contract: not reported as applied, record cleared", await waitText(c.p, "#txmsg", /contract refused it/) && !/was applied/.test(await text(c.p, "#txmsg")) && (await pend(c)) === null);
  await c.ctx.close();
}
{ // remove_source
  const EXTRA = "https://a.example.com/y";
  const c = await newCase({ state: baseState({ phase: "FINALIZED", deadline: 0, extra_sources: [EXTRA], sources: ["https://a.example.com/x", "https://b.example.org/x", "https://c.example.net/x", EXTRA] }), wallet: { accounts: [FUNDER], hash: H },
    txScripts: { [H]: [tx("PENDING"), tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS")] } });
  c.rpc.onFinal = () => { c.rpc.state = baseState({ phase: "FINALIZED", deadline: 0, extra_sources: [] }); };
  await loaded(c); await connect(c);
  await c.p.fill("#osrc", EXTRA); await c.p.dispatchEvent("#osrc", "input"); await c.p.click("#o_rem");
  ok("remove_source: ACCEPTED shown as in progress", await waitText(c.p, "#txmsg", /network status ACCEPTED/));
  ok("remove_source: reported as applied after FINALIZED+SUCCESS", await waitText(c.p, "#txmsg", /remove_source was applied/));
  const dt = await dataText(c);
  ok("remove_source: call data carries the function and the URL", dt.includes("remove_source") && dt.includes(EXTRA));
  ok("remove_source: signed by the owner", (await c.p.evaluate(() => window.__reqs.find(r => r.method === "eth_sendTransaction").params[0].from.toLowerCase())) === FUNDER);
  ok("remove_source: source gone after state reload", await c.p.waitForFunction(u => !document.getElementById("sources").textContent.includes(u), EXTRA, { timeout: 5000 }).then(() => true).catch(() => false));
  await c.ctx.close();
}
{ // a non-owner cannot reach any owner path
  const c = await newCase({ state: baseState({ phase: "IDLE", deadline: 0, round: 0 }), wallet: { accounts: [OTHER] } });
  await loaded(c); await connect(c);
  ok("non-owner: start/add/remove are locked and nothing can be sent", (await c.p.locator("#o_round").isDisabled()) && (await c.p.locator("#o_add").isDisabled()) && (await c.p.locator("#o_rem").isDisabled()) && (await sendCount(c)) === 0);
  await c.ctx.close();
}

// --- ambiguous send: context is kept, retry is blocked, the transaction is located after a reload -------
async function ambiguousCase(extra = {}) {
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER], sendMode: "errorButSent", hash: H }, txScripts: { [H]: [tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS")] }, ...extra });
  await loaded(c); await connect(c); await c.p.click("#fin");
  await waitText(c.p, "#txmsg", /may have been sent/);
  return c;
}
{
  const c = await ambiguousCase();
  const p = await pend(c);
  ok("ambiguous: the record keeps account, network, contract, action and nonce context",
    p && p.stage === "ambiguous" && p.account.toLowerCase() === OTHER && p.chainId === "0xf22f" && p.address === CONTRACT && p.fn === "finalize" && p.label === "finalize" && p.nonceBefore === 0 && p.nonceAfter === 1);
  ok("ambiguous: the unfinished-transaction panel shows that context", await c.p.locator("#recovery").isVisible() && /finalize/.test(await text(c.p, "#recmsg")) && (await text(c.p, "#recmsg")).includes(OTHER) && (await text(c.p, "#recmsg")).includes(CONTRACT) && /before sending: 0/.test(await text(c.p, "#recmsg")));
  ok("ambiguous: every send, including deploy, is locked with the reason", await allLocked(c) && /may have been sent/.test(await text(c.p, "#r_finalize")));
  await c.p.click("#fin", { force: true }).catch(() => {});
  ok("ambiguous: a blind resend is impossible (only the first transaction was ever sent)", (await sendCount(c)) === 1);
  await c.ctx.close();
}
{ // reload, the node lists exactly one matching transaction -> it is found and followed to the end
  const c = await ambiguousCase();
  c.rpc.listed = [listedTx(), listedTx({ hash: "0x" + "11".repeat(32), to_address: CONTRACT2, nonce: 0 }), listedTx({ hash: "0x" + "22".repeat(32), nonce: 0, created_at: 1000 })];
  await c.p.reload();
  ok("reload: the matching transaction is located and reported as applied (other contract / ancient tx ignored)", await waitText(c.p, "#txmsg", /finalize was applied/));
  await connect(c);
  ok("reload: record cleared and sends unlocked again", (await pend(c)) === null && await c.p.waitForFunction(() => !document.getElementById("fin").disabled, null, { timeout: 5000 }).then(() => true).catch(() => false) && await c.p.locator("#recovery").isHidden());
  await c.ctx.close();
}
{ // reload, the node lists nothing but the account's nonce moved -> unresolved, still blocked
  const c = await ambiguousCase();
  c.rpc.listed = [];
  await c.p.reload();
  ok("unresolved (nonce moved, nothing listed): says why and keeps sends blocked", await waitText(c.p, "#recmsg", /transaction count moved \(0 to 1\) but no matching transaction is listed/) && await allLocked(c));
  ok("unresolved: points to the account history in the explorer", /Account history: .*\/address\//.test(await text(c.p, "#recmsg")));
  c.rpc.listed = [listedTx()];
  await c.p.click("#recheck");
  ok("unresolved -> Check again finds the transaction once it is listed", await waitText(c.p, "#txmsg", /finalize was applied/) && (await pend(c)) === null);
  await c.ctx.close();
}
{ // listing not supported by the node: nonce still decides
  const c = await ambiguousCase();
  c.rpc.listed = null;
  await c.p.reload();
  ok("listing unavailable and nonce moved: unresolved, blocked, honest wording", await waitText(c.p, "#recmsg", /node could not list/) && await allLocked(c));
  await c.ctx.close();
}
{ // two plausible transactions
  const c = await ambiguousCase();
  const H2 = "0x" + "33".repeat(32);
  c.rpc.listed = [listedTx(), listedTx({ hash: H2, nonce: 1 })];
  await c.p.reload();
  ok("two candidates: both hashes are shown, nothing is guessed, sends stay blocked", await waitText(c.p, "#recmsg", /Several transactions/) && (await text(c.p, "#recmsg")).includes(H) && (await text(c.p, "#recmsg")).includes(H2) && await allLocked(c));
  await connect(c);
  ok("manual release: 'I checked: it was not sent' clears the record and unlocks", await (async () => { await c.p.click("#recdismiss"); return (await pend(c)) === null && !(await c.p.locator("#fin").isDisabled()); })());
  await c.ctx.close();
}
{ // hash never obtained, nonce did not move -> safe to retry
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER] } });
  await seed(c, { stage: "signing", label: "finalize", fn: "finalize", args: [], address: CONTRACT, account: OTHER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await loaded(c);
  ok("reload during signing, nonce unchanged: reported as not sent, safe to retry", await waitText(c.p, "#txmsg", /was not sent: the account's transaction count did not move/) && (await pend(c)) === null);
  await connect(c);
  ok("reload during signing, nonce unchanged: sends unlocked", !(await c.p.locator("#fin").isDisabled()));
  await c.ctx.close();
}
{ // hash never obtained, tx was in fact broadcast
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER] }, txScripts: { [H]: [tx("FINALIZED", "SUCCESS")] } });
  c.rpc.nonce = 1; c.rpc.listed = [listedTx()];
  await seed(c, { stage: "signing", label: "finalize", fn: "finalize", args: [], address: CONTRACT, account: OTHER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await loaded(c);
  ok("reload during signing, tx was broadcast: located by the listing and followed to FINALIZED", await waitText(c.p, "#txmsg", /finalize was applied/) && (await pend(c)) === null);
  await c.ctx.close();
}
{ // nonce unreadable when the wallet fails -> must be treated as ambiguous, not as 'not sent'
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER], sendMode: "errorNotSent" } });
  await loaded(c); await connect(c); c.rpc.nonceFail = true; await c.p.click("#fin");
  ok("nonce unreadable + wallet error: flagged ambiguous and blocked (never 'not sent')", await waitText(c.p, "#txmsg", /may have been sent/) && !/was not sent/.test(await text(c.p, "#txmsg")) && await allLocked(c));
  ok("nonce unreadable: the record says the nonce was unknown", (await pend(c)).stage === "ambiguous");
  await c.ctx.close();
}
{ // effect hint while unresolved
  const c = await newCase({ state: baseState({ phase: "FINALIZED", deadline: 0 }), wallet: { accounts: [OTHER] } });
  c.rpc.nonce = 1; c.rpc.listed = [];
  await seed(c, { stage: "ambiguous", label: "finalize", fn: "finalize", args: [], address: CONTRACT, account: OTHER, chainId: "0xf22f", nonceBefore: 0, nonceAfter: 1, at: Date.now(),
    snapshot: { round: 1, phase: "PROVISIONAL", history_count: 0, sources: [], challenge_used: 0 } });
  await loaded(c);
  ok("unresolved: the contract state is compared with the snapshot and the hint is shown (record is NOT cleared by it)", await waitText(c.p, "#recmsg", /already shows the effect of finalize/) && (await pend(c)) !== null);
  await c.ctx.close();
}

// --- reload recovery uses the recorded contract and adopts a finalized deployment -----------------------
{ // the page was opened for another contract; the recorded transaction decides what is loaded
  const c = await newCase({ state: baseState({ event: "Wrong feed" }), wallet: { accounts: [OTHER] }, txScripts: { [H]: [tx("ACCEPTED", "SUCCESS"), tx("FINALIZED", "SUCCESS", { recipient: CONTRACT2 })] } });
  c.rpc.states[CONTRACT2] = baseState({ event: "Recorded feed" });
  await seed(c, { stage: "sent", hash: H, label: "assess", fn: "assess", args: [], address: CONTRACT2, account: OTHER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await c.open(`&address=${CONTRACT}`);
  ok("reload recovery: finishes the recorded transaction", await waitText(c.p, "#txmsg", /assess was applied/));
  ok("reload recovery: the Contract box switches to the recorded contract and loads it", (await c.p.inputValue("#addr")).toLowerCase() === CONTRACT2 && (await text(c.p, "#event")) === "Recorded feed");
  await c.ctx.close();
}
{ // finalized deployment is adopted after a reload
  const c = await newCase({ state: baseState({ event: "Old feed" }), wallet: { accounts: [FUNDER] }, txScripts: { [H]: [tx("PENDING"), tx("FINALIZED", "SUCCESS", { recipient: NEWC })] } });
  c.rpc.states[NEWC] = baseState({ event: "Fresh feed", owner: FUNDER });
  await seed(c, { stage: "sent", hash: H, label: "deploy", fn: "deploy", args: ["x"], account: FUNDER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await c.open(`&address=${CONTRACT}`);
  ok("deploy recovery: the new address is adopted from the FINALIZED+SUCCESS receipt and loaded", await c.p.waitForFunction(a => document.getElementById("addr").value.toLowerCase() === a, NEWC, { timeout: 8000 }).then(() => true).catch(() => false) && (await text(c.p, "#event")) === "Fresh feed");
  ok("deploy recovery: share link shown and record cleared", await waitText(c.p, "#txmsg", new RegExp("\\?address=" + NEWC)) && (await pend(c)) === null);
  await c.ctx.close();
}
{ // deploy FINALIZED but refused -> never adopted
  const c = await newCase({ state: baseState({ event: "Old feed" }), wallet: { accounts: [FUNDER] }, txScripts: { [H]: [tx("FINALIZED", "ERROR", { recipient: NEWC })] } });
  await seed(c, { stage: "sent", hash: H, label: "deploy", fn: "deploy", args: ["x"], account: FUNDER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await c.open(`&address=${CONTRACT}`);
  ok("deploy recovery: a refused deployment is reported and its address is NOT adopted", await waitText(c.p, "#txmsg", /contract refused it/) && (await c.p.inputValue("#addr")) === CONTRACT);
  await c.ctx.close();
}
{ // deploy finalized but no address in the receipt
  const c = await newCase({ state: baseState({ event: "Old feed" }), wallet: { accounts: [FUNDER] }, txScripts: { [H]: [tx("FINALIZED", "SUCCESS", { recipient: undefined })] } });
  await seed(c, { stage: "sent", hash: H, label: "deploy", fn: "deploy", args: ["x"], account: FUNDER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await c.open(`&address=${CONTRACT}`);
  ok("deploy recovery: no address in the receipt -> clear message, nothing adopted", await waitText(c.p, "#txmsg", /could not read the new contract address/) && (await c.p.inputValue("#addr")) === CONTRACT);
  await c.ctx.close();
}
{ // a transaction that is still not final stays recorded and blocked, and can be re-checked
  const c = await newCase({ state: baseState({ deadline: NOW - 5 }), wallet: { accounts: [OTHER] }, txScripts: { [H]: [tx("PENDING")] } });
  await seed(c, { stage: "sent", hash: H, label: "finalize", fn: "finalize", args: [], address: CONTRACT, account: OTHER, chainId: "0xf22f", nonceBefore: 0, at: Date.now() });
  await loaded(c); await connect(c);
  ok("open transaction: sends are locked while it is unresolved", await waitText(c.p, "#r_finalize", /Waiting for the earlier finalize transaction/) && (await c.p.locator("#fin").isDisabled()));
  c.rpc.txScripts[H] = [tx("FINALIZED", "SUCCESS")];
  ok("open transaction: once it is FINALIZED+SUCCESS it is reported, the record is cleared and sends unlock", await waitText(c.p, "#txmsg", /finalize was applied/) && (await pend(c)) === null && await c.p.waitForFunction(() => !document.getElementById("fin").disabled, null, { timeout: 5000 }).then(() => true).catch(() => false));
  await c.ctx.close();
}

await browser.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
