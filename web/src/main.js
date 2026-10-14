import {
  hasWallet, readClient, writeClient, connectWallet, ensureNetwork, currentNetworkOk, watchWallet,
  sendAndConfirm, watchTx, loadPending, clearPending, savePending, readNonce, listAccountTxs, EXPLORER,
} from "./wallet.js";
import { computeActions, validateSetup, roleOf, snapshotOf, effectSeen } from "./logic.js";
import { nextStep } from "./recovery.js";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const utc = t => t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";
const short = a => a ? String(a).slice(0, 8) + "..." + String(a).slice(-4) : "";
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const badge = (el, v) => { el.textContent = v; el.className = "badge " + v; };
const nowSec = () => Math.floor(Date.now() / 1000);

const POLL = Number(new URLSearchParams(location.search).get("poll")) || undefined; // test hook: faster polling
const reader = readClient();
let address = null;      // connected wallet
let wallet = null;       // write client for that wallet
let state = null;
let busy = false;

const DEFAULT = "0xD1c4378e3D278e33B49B670ECe629b0e4945D977";
const LAST = "ew_last_address";
const lastAddr = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
$("addr").value = new URLSearchParams(location.search).get("address") || lastAddr() || DEFAULT;

function say(text, err = false) { const m = $("txmsg"); m.className = "msg" + (err ? " err" : ""); m.textContent = text; }
const txLink = h => EXPLORER ? `\nExplorer: ${EXPLORER}/tx/${h}` : "";

// ---------- wallet ----------
function renderWallet() {
  const pill = $("rolepill");
  if (!address) {
    $("wstatus").textContent = hasWallet() ? "Not connected." : "No browser wallet found.";
    $("connect").textContent = "Connect wallet"; pill.hidden = true;
  } else {
    $("wstatus").textContent = "Connected: " + address;
    $("connect").textContent = "Reconnect";
    const role = roleOf(state, address);
    pill.hidden = false;
    pill.textContent = state ? "role: " + role : "no event loaded";
    pill.className = "badge " + (role === "owner" ? "PASS" : "NONE");
  }
  renderActions();
}

async function doConnect() {
  const w = $("wmsg"); w.className = "msg"; w.textContent = "";
  try {
    address = await connectWallet();
    wallet = writeClient(address);
    renderWallet();
  } catch (e) {
    w.className = "msg err"; w.textContent = e.message || String(e);
  }
}
$("connect").onclick = doConnect;
watchWallet({
  onAccounts: a => { address = a && a[0] ? a[0] : null; wallet = address ? writeClient(address) : null; renderWallet(); },
  onChain: async () => { const ok = await currentNetworkOk(); $("wmsg").className = ok ? "msg" : "msg err"; $("wmsg").textContent = ok ? "" : "Wrong network: switch the wallet to GenLayer Studio before sending."; },
});

// ---------- rendering ----------
const MAP = { start: "o_round", assess: "o_assess", add: "o_add", remove: "o_rem", challenge: "chal", finalize: "fin" };
// An unfinished transaction (no final outcome yet) blocks every send until it is reconciled, so a
// second copy of a possibly-broadcast transaction cannot be sent by mistake.
function blockedReason() {
  const p = loadPending();
  if (!p) return "";
  if (p.stage === "sent") return `Waiting for the earlier ${p.label} transaction to finish.`;
  return `An earlier ${p.label} may have been sent. Reconcile it in "Unfinished transaction" first.`;
}
function renderActions() {
  const a = computeActions(state, address, nowSec(), $("osrc").value.trim());
  const block = blockedReason();
  for (const k of Object.keys(MAP)) {
    const okNow = a[k].ok && !block;
    $(MAP[k]).disabled = busy || !okNow;
    $("r_" + k).textContent = okNow ? "" : (a[k].ok ? block : a[k].reason);
  }
  $("s_deploy").disabled = busy || !!block;
  renderRecovery();
}
function renderRecovery() {
  const p = loadPending();
  const show = !!p && !busy;
  $("recovery").hidden = !show;
  if (!show) return;
  $("recdismiss").hidden = !!p.hash;
  if (!$("recmsg").dataset.keep) $("recmsg").textContent = describePending(p);
}
function describePending(p) {
  return `Action: ${p.label}${p.args && p.args.length ? " (" + p.args.join(", ") + ")" : ""}\nAccount: ${p.account}\nNetwork: chain ${p.chainId}\nContract: ${p.address || "(new deployment)"}\nAccount transaction count before sending: ${p.nonceBefore ?? "unknown"}\n` +
    (p.stage === "signing" ? "The page closed or reloaded while the wallet was being asked to sign. The transaction may or may not have been broadcast."
      : p.stage === "sent" ? `The transaction was sent (Tx ${p.hash}) but its final outcome is not known yet.`
      : "The wallet reported an error after the account's transaction count moved, so it may have been broadcast.");
}
$("osrc").oninput = renderActions;

async function view(fn, args = []) {
  return await reader.readContract({ address: $("addr").value.trim(), functionName: fn, args });
}

async function load() {
  const msg = $("loadmsg");
  if (!$("addr").value.trim()) { msg.className = "small"; msg.textContent = "Enter a contract address."; return; }
  msg.className = "small"; msg.textContent = "Loading...";
  try {
    const st = parse(await view("get_state_json"));
    if (!st || !Array.isArray(st.sources)) throw new Error("Unexpected response from contract");
    state = st;
    $("setup").hidden = true;
    $("app").hidden = false;
    $("event").textContent = st.event;
    $("date").textContent = "Original date: " + st.original_date;
    badge($("outcome"), st.latest_outcome || "UNKNOWN");
    $("round").textContent = st.round;
    badge($("phase"), st.phase);
    $("cand").textContent = st.candidate || "-";
    const left = st.deadline ? st.deadline - nowSec() : 0;
    $("deadline").textContent = st.deadline ? utc(st.deadline) + (st.phase === "PROVISIONAL" ? (left > 0 ? ` (in ${Math.ceil(left / 60)} min)` : " (passed, can be finalized)") : "") : "-";
    $("chused").textContent = st.challenge_used ? "yes" : "no";
    $("lastfin").textContent = st.last_finalized_status && st.last_finalized_status !== "UNKNOWN" ? `${st.last_finalized_status} (round ${st.last_finalized_round})` : "-";
    $("owner").textContent = st.owner;
    $("sources").innerHTML = (st.sources || []).map(u => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></li>`).join("") || "<li>none</li>";
    $("hosts").textContent = "Configured hosts: " + (st.hosts || []).join(", ");
    const rows = [];
    for (let i = 0; i < st.history_count; i++) {
      const r = parse(await view("get_history_json", [i]));
      rows.push(r
        ? `<tr><td>${i}</td><td>${esc(utc(r.time ?? r.timestamp ?? r.at))}</td><td>${esc(r.action)}</td><td>${esc(r.outcome)}</td><td>${esc(r.note || "")}</td><td>${esc(short(r.caller))}</td></tr>`
        : `<tr><td>${i}</td><td colspan="5">unreadable row</td></tr>`);
    }
    $("hist").innerHTML = rows.join("") || '<tr><td colspan="6">No history yet</td></tr>';
    msg.textContent = "Loaded.";
    try { localStorage.setItem(LAST, $("addr").value.trim()); } catch { /* storage may be blocked */ }
    renderWallet();
  } catch (e) {
    msg.textContent = "Could not read the contract: " + (e.message || e);
    msg.className = "small err";
  }
}
$("load").onclick = load;
$("refresh").onclick = load;

// ---------- sending ----------
function describe(o, fn, hash) {
  const t = hash ? txLink(hash) : "";
  switch (o.kind) {
    case "APPLIED": return { text: `${fn} was applied: the transaction is FINALIZED and the contract call succeeded.${t}`, err: false };
    case "REJECTED_BY_CONTRACT": return { text: `${fn} was FINALIZED but the contract refused it (wrong caller, wrong phase, or window still open). State was not changed.${t}`, err: true };
    case "NOT_APPLIED": return { text: `${fn} was not applied (network status ${o.status}${o.vote ? ", vote " + o.vote : ""}). State was not changed.${t}`, err: true };
    case "UNCLEAR": return { text: `${fn} is FINALIZED but its execution result is unreadable (${o.exec || "empty"}). Check the explorer before repeating it.${t}`, err: true };
    case "STILL_PENDING": return { text: `${fn} is still not final after waiting. It may yet apply. Reload this page to keep watching, and do not resend yet.${t}`, err: true };
    case "REJECTED_BY_USER": return { text: o.message, err: false };
    case "AMBIGUOUS": return { text: o.message, err: true };
    case "NOT_SENT": return { text: o.message, err: true };
    default: return { text: `${fn}: ${o.kind}`, err: true };
  }
}

function progress(fn) {
  return u => {
    if (u.stage === "submitted") say(`${fn} sent. Tx ${u.hash}\nWaiting for the network to finalize it (can take several minutes)...${txLink(u.hash)}`);
    else if (u.stage === "status") say(`${fn}: network status ${u.status || "pending"}${u.exec ? ", execution " + u.exec : ""}.\nTx ${u.hash}`);
    else if (u.stage === "network-hiccup") say(`${fn}: lost contact with the network (${u.failures}x), still trying.\nTx ${u.hash}`);
  };
}

async function guard(fn, build, remember) {
  if (!wallet || !address) { say("Connect a wallet first.", true); return null; }
  busy = true; renderActions();
  try {
    await ensureNetwork();
    say(`Confirm ${fn} in your wallet...`);
    const o = await sendAndConfirm({ client: wallet, address, build, onUpdate: progress(fn), label: fn, remember, pollMs: POLL });
    const d = describe(o, fn, o.hash);
    say(d.text, d.err);
    return o;
  } catch (e) {
    say(`${fn} did not start: ` + (e.message || e), true);
    return null;
  } finally {
    busy = false;
    renderActions();
  }
}

async function sendCall(fn, args) {
  const addr = $("addr").value.trim();
  const o = await guard(fn, () => wallet.writeContract({ address: addr, functionName: fn, args, value: 0n }), { fn, args, address: addr, snapshot: snapshotOf(state) });
  if (o && ["APPLIED", "REJECTED_BY_CONTRACT", "NOT_APPLIED", "UNCLEAR"].includes(o.kind)) await load();
  renderActions();
}

$("o_round").onclick = () => sendCall("start_round", []);
$("o_assess").onclick = () => sendCall("assess", []);
$("fin").onclick = () => sendCall("finalize", []);
const needUrl = () => {
  const u = $("osrc").value.trim();
  if (!u.startsWith("https://")) { say("Source URL must start with https://", true); return null; }
  return u;
};
$("o_add").onclick = () => { const u = needUrl(); if (u) sendCall("add_source", [u]); };
$("o_rem").onclick = () => { const u = needUrl(); if (u) sendCall("remove_source", [u]); };
$("chal").onclick = () => {
  const u = $("curl").value.trim(), n = $("cnote").value.trim();
  if (!u.startsWith("https://")) { say("Evidence URL must start with https://", true); return; }
  if (n.length < 3) { say("Add a short note: what does this page show?", true); return; }
  sendCall("challenge", [u, n]);
};

// ---------- setup / deploy ----------
function findAddress(tx) {
  const c = [tx?.txDataDecoded?.contractAddress, tx?.data?.contract_address, tx?.recipient, tx?.to_address];
  return c.find(x => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x)) || null;
}
$("newev").onclick = () => { $("setup").hidden = false; renderWallet(); };
$("s_deploy").onclick = async () => {
  const form = { event: $("s_event").value, date: $("s_date").value.trim(), window: Number($("s_window").value),
    sources: [$("s_u1").value.trim(), $("s_u2").value.trim(), $("s_u3").value.trim()] };
  const errs = validateSetup(form);
  if (!address) errs.unshift("Connect a wallet first (the connected account becomes the owner).");
  $("s_errs").textContent = errs.join("\n");
  if (errs.length) return;
  let code;
  try {
    const r = await fetch("../contracts/event_witness.py", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    code = await r.text();
    if (!code.includes("class EventWitness")) throw new Error("unexpected file content");
  } catch (e) { $("s_errs").textContent = "Could not fetch the contract source: " + (e.message || e); return; }
  const args = [form.event.trim(), form.date, JSON.stringify(form.sources), form.window];
  const o = await guard("deploy", () => wallet.deployContract({ code, args, leaderOnly: false }), { fn: "deploy", args: [form.event.trim()] });
  if (o && o.kind === "APPLIED") await adoptDeployed(o);
  renderActions();
};

// A deployment's address is adopted only from a FINALIZED, successful transaction.
async function adoptDeployed(o) {
  const a = findAddress(o.tx);
  if (a) { $("addr").value = a; await load(); say(`Event feed deployed at ${a}.\nShare this link: ${location.origin}${location.pathname}?address=${a}`); }
  else say("Deployment finalized, but the page could not read the new contract address from the receipt. Find it in the Studio explorer under this transaction and paste it into the Contract box.", true);
}

// ---------- resume / reconcile an interrupted transaction ----------
const explorerAccount = acc => EXPLORER ? `\nAccount history: ${EXPLORER}/address/${acc}` : "";

async function finishWatch(p, hash) {
  const o = await watchTx(reader, hash, { onUpdate: progress(p.label), pollMs: POLL });
  if (o.kind !== "STILL_PENDING") clearPending();
  const d = describe(o, p.label, hash);
  say(d.text, d.err);
  if (p.fn === "deploy" && o.kind === "APPLIED") await adoptDeployed(o);
  else if ($("addr").value) await load();
  return o;
}

async function reconcile(p) {
  const rm = $("recmsg"); rm.dataset.keep = "1";
  rm.textContent = describePending(p) + "\n\nLooking for the transaction...";
  let listing = null;
  try { listing = await listAccountTxs(p.account, "from"); } catch { listing = null; }
  const nonceNow = await readNonce(reader, p.account);
  const step = nextStep(p, { listing, nonceNow });
  if (step.kind === "WATCH") {
    rm.textContent = describePending(p) + `\n\nFound it: ${step.hash}. Watching it now...`;
    savePending({ ...p, stage: "sent", hash: step.hash });
    delete rm.dataset.keep; renderActions();
    return await finishWatch(p, step.hash);
  }
  if (step.kind === "NOT_SENT") {
    clearPending(); delete rm.dataset.keep;
    say(`The earlier ${p.label} was not sent: the account's transaction count did not move (${nonceNow}). It is safe to try again.`);
    renderActions();
    return { kind: "NOT_SENT" };
  }
  // unresolved: say exactly why, show what to check, keep sends blocked
  let hint = "";
  if (state && p.snapshot && p.address && p.address.toLowerCase() === $("addr").value.trim().toLowerCase()) {
    const seen = effectSeen(p.fn, p.args || [], p.snapshot, snapshotOf(state));
    if (seen === true) hint = `\nThe contract's current state already shows the effect of ${p.label}, so it probably went through.`;
    if (seen === false) hint = `\nThe contract's current state does not show the effect of ${p.label} yet.`;
  }
  const why = { SEVERAL: "Several transactions from this account could match:\n" + (step.hashes || []).map(h => `${h}${EXPLORER ? "  " + EXPLORER + "/tx/" + h : ""}`).join("\n"),
    NO_NONCE: "The account's transaction count could not be read.",
    NONCE_MOVED_NO_MATCH: `The account's transaction count moved (${p.nonceBefore} to ${nonceNow}) but no matching transaction is listed (yet).`,
    NONCE_MOVED_NO_LIST: `The account's transaction count moved (${p.nonceBefore} to ${nonceNow}) and the node could not list the account's transactions.` }[step.reason];
  rm.textContent = describePending(p) + `\n\nNot resolved: ${why}${hint}${explorerAccount(p.account)}\nIt stays blocked from being repeated. Press "Check again" later, or if you checked the explorer and it is not there, press "I checked: it was not sent".`;
  say(`The earlier ${p.label} is not resolved yet; sending is blocked until it is.`, true);
  renderActions();
  return { kind: "UNRESOLVED" };
}

async function resume() {
  const p = loadPending();
  if (!p) return;
  // reload recovery works on the contract the transaction was sent to, not whatever the box held
  if (p.address && $("addr").value.trim().toLowerCase() !== p.address.toLowerCase()) { $("addr").value = p.address; await load(); }
  if (p.account && address && address.toLowerCase() !== p.account.toLowerCase()) say(`Note: this transaction was sent from ${p.account}, but the connected account is ${address}.`);
  busy = true; renderActions();
  try {
    if (p.hash) {
      say(`Found an earlier transaction (${p.label}) that was still open when this page closed.\nTx ${p.hash}\nWatching it now...`);
      await finishWatch(p, p.hash);
    } else {
      await reconcile(p);
    }
  } finally { busy = false; renderActions(); }
}
$("recheck").onclick = async () => { const p = loadPending(); if (!p || busy) return; busy = true; renderActions(); try { if (p.hash) await finishWatch(p, p.hash); else await reconcile(p); } finally { busy = false; renderActions(); } };
$("recdismiss").onclick = () => {
  const p = loadPending(); if (!p) return;
  clearPending(); delete $("recmsg").dataset.keep;
  say(`Marked the earlier ${p.label} as not sent. Sending is possible again; make sure it really is not in the explorer.`);
  renderActions();
};

setInterval(() => { if (state && !busy) renderActions(); }, 5000); // deadlines pass without any click
renderWallet();
if (!hasWallet()) { $("wmsg").className = "msg err"; $("wmsg").textContent = "No browser wallet detected. You can still read any event feed; to act you need MetaMask or another EIP-1193 wallet."; }
(async () => { if ($("addr").value) await load(); await resume(); })();
