// Browser tests with a mock EIP-1193 wallet and a mock Studio RPC. They check the page's behaviour
// (wallet connect, roles, transaction lifecycle). They do NOT prove real MetaMask or real Studionet behaviour.
// Run from a folder where playwright-core and genlayer-js are installed:  node wallet_flow.test.mjs
import { chromium } from "playwright-core";
import { abi } from "genlayer-js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const PORT = 8772;
const FUNDER = "0x" + "a1".repeat(20), BUILDER = "0x" + "b2".repeat(20), OTHER = "0x" + "c3".repeat(20);
const CONTRACT = "0x" + "d4".repeat(20), NEWC = "0x" + "e5".repeat(20);
const NOW = Math.floor(Date.now() / 1000);

const srv = spawn("python3", ["-m", "http.server", String(PORT), "-d", WEB], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

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
  const rpc = { methods: [], state, txScripts, nonce: 0, txIdx: {}, sends: [] };
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
        if (txt.includes("get_state_json")) s = JSON.stringify(rpc.state);
        else if (txt.includes("__none__")) s = rpc.state.phase === "FINALIZED" ? rpc.state.final_verdict : "NONE";
        else if (txt.includes("get_history_json")) s = JSON.stringify({ action: "ASSESS", outcome: "CANCELLED", time: NOW, note: "", caller: FUNDER });
        return { jsonrpc: "2.0", id: x.id, result: Buffer.from(abi.calldata.encode(s)).toString("hex") };
      }
      if (x.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: x.id, result: "0x" + rpc.nonce.toString(16) };
      if (x.method === "eth_gasPrice") return { jsonrpc: "2.0", id: x.id, result: "0x1" };
      if (x.method === "eth_estimateGas") return { jsonrpc: "2.0", id: x.id, result: "0x30d40" };
      if (x.method === "eth_chainId") return { jsonrpc: "2.0", id: x.id, result: "0xf22f" };
      if (x.method === "eth_getTransactionByHash") {
        const h = x.params[0]; const seq = rpc.txScripts[h] || [];
        const i = Math.min(rpc.txIdx[h] || 0, seq.length - 1); rpc.txIdx[h] = (rpc.txIdx[h] || 0) + 1;
        if (!seq.length) return { jsonrpc: "2.0", id: x.id, result: null };
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
  ok("owner assess: applied and state reloaded", await waitText(c.p, "#txmsg", /was applied/) && c.rpc.methods.filter(m => m === "gen_call").length >= 3);
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
{ // hostile content
  const c = await newCase({ state: baseState({ event: "<img src=x onerror=alert(1)>" }) });
  const dialogs = []; c.p.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
  await loaded(c);
  ok("hostile event text rendered as text", (await text(c.p, "#event")).includes("<img") && dialogs.length === 0);
  ok("no page errors in the whole run", c.errs.length === 0, c.errs.join("|"));
  await c.ctx.close();
}

await browser.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
