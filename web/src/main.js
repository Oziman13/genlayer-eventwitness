
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const DEFAULT = "0xD1c4378e3D278e33B49B670ECe629b0e4945D977";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let account = null;
try {
  let k = localStorage.getItem("ew_key");
  if (!k) { k = generatePrivateKey(); localStorage.setItem("ew_key", k); }
  account = createAccount(k);
} catch { account = createAccount(); }
$("acct").textContent = "Throwaway account: " + account.address;

let client = createClient({ chain: studionet, account });
let ownerAccount = null;
const mk = acc => createClient({ chain: studionet, account: acc });
const qs = new URLSearchParams(location.search);
$("addr").value = qs.get("address") || DEFAULT;

const utc = t => t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";
const fmtParse = s => { try { return JSON.parse(s); } catch { return null; } };

async function view(fn, args = []) {
  return await client.readContract({ address: $("addr").value.trim(), functionName: fn, args });
}

async function load() {
  $("loadmsg").textContent = "Loading...";
  $("loadmsg").className = "small";
  try {
    const st = fmtParse(await view("get_state_json"));
    if (!st) throw new Error("Unexpected response from contract");
    $("app").hidden = false;
    $("event").textContent = st.event;
    $("date").textContent = "Original date: " + st.original_date;
    const o = $("outcome"); o.textContent = st.latest_outcome || "UNKNOWN"; o.className = "badge " + (st.latest_outcome || "UNKNOWN");
    $("round").textContent = st.round;
    const p = $("phase"); p.textContent = st.phase; p.className = "badge " + st.phase;
    $("cand").textContent = st.candidate || "-";
    const left = st.deadline ? st.deadline - Math.floor(Date.now() / 1000) : 0;
    $("deadline").textContent = st.deadline ? utc(st.deadline) + (st.phase === "PROVISIONAL" ? (left > 0 ? ` (in ${Math.ceil(left / 60)} min)` : " (passed, can be finalized)") : "") : "-";
    $("chused").textContent = st.challenge_used ? "yes" : "no";
    $("lastfin").textContent = st.last_finalized_status ? `${st.last_finalized_status} (round ${st.last_finalized_round})` : "-";
    $("sources").innerHTML = (st.sources || []).map(u => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></li>`).join("") || "<li>none</li>";
    $("hosts").textContent = "Configured hosts: " + (st.hosts || []).join(", ");
    const rows = [];
    for (let i = 0; i < st.history_count; i++) {
      const r = fmtParse(await view("get_history_json", [i]));
      if (r) rows.push(`<tr><td>${i}</td><td>${esc(utc(r.time ?? r.timestamp ?? r.at))}</td><td>${esc(r.action)}</td><td>${esc(r.outcome)}</td><td>${esc(r.note || "")}</td></tr>`);
      else rows.push(`<tr><td>${i}</td><td colspan="4">unreadable row</td></tr>`);
    }
    $("hist").innerHTML = rows.join("") || '<tr><td colspan="5">No history yet</td></tr>';
    $("loadmsg").textContent = "Loaded.";
  } catch (e) {
    $("loadmsg").textContent = "Could not read the contract: " + (e.message || e);
    $("loadmsg").className = "small err";
  }
}

const ACTION_BTNS = ["chal", "fin", "oround", "oassess", "oadd", "orem"];
function setBusy(b) { ACTION_BTNS.forEach(id => { $(id).disabled = b || (id[0] === "o" && !ownerAccount); }); }

async function send(fn, args, asOwner = false) {
  const m = $("txmsg"); m.className = "msg";
  m.textContent = `Sending ${fn}...`;
  setBusy(true);
  try {
    const c = asOwner ? mk(ownerAccount) : client;
    const hash = await c.writeContract({ address: $("addr").value.trim(), functionName: fn, args, value: 0n });
    m.textContent = `Sent ${fn}. Tx ${hash}\nWaiting for consensus (this can take a minute)...`;
    await c.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 120, interval: 5000 });
    m.textContent = `${fn} accepted. Tx ${hash}`;
    await load();
  } catch (e) {
    m.className = "msg err";
    m.textContent = `${fn} failed: ` + (e.message || e);
  } finally {
    setBusy(false);
  }
}

$("load").onclick = load;
$("refresh").onclick = load;
$("chal").onclick = () => {
  const u = $("curl").value.trim(), n = $("cnote").value.trim();
  if (!u.startsWith("https://")) { $("txmsg").className = "msg err"; $("txmsg").textContent = "Evidence URL must start with https://"; return; }
  send("challenge", [u, n]);
};
$("fin").onclick = () => send("finalize", []);

$("okeyset").onclick = () => {
  const k = $("okey").value.trim();
  try {
    ownerAccount = createAccount(k.startsWith("0x") ? k : "0x" + k);
    $("okey").value = "";
    $("okeymsg").className = "small";
    $("okeymsg").textContent = "Owner account: " + ownerAccount.address;
  } catch (e) {
    ownerAccount = null;
    $("okeymsg").className = "small err";
    $("okeymsg").textContent = "That is not a valid private key.";
  }
  setBusy(false);
};
const needUrl = () => {
  const u = $("osrc").value.trim();
  if (!u.startsWith("https://")) { $("txmsg").className = "msg err"; $("txmsg").textContent = "Source URL must start with https://"; return null; }
  return u;
};
$("oround").onclick = () => send("start_round", [], true);
$("oassess").onclick = () => send("assess", [], true);
$("oadd").onclick = () => { const u = needUrl(); if (u) send("add_source", [u], true); };
$("orem").onclick = () => { const u = needUrl(); if (u) send("remove_source", [u], true); };
setBusy(false);
load();
