// Pure rules: which action is allowed for which wallet, in which phase, at which time.
export const MAX_ROUNDS = 20;
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
export const roleOf = (state, address) =>
  !state || !address ? "none" : same(address, state.owner) ? "owner" : "viewer";

const ok = () => ({ ok: true, reason: "" });
const no = reason => ({ ok: false, reason });
const between = ["IDLE", "FINALIZED", "NEEDS_EVIDENCE"];

export function computeActions(state, address, nowSec, evidenceUrl) {
  const out = { role: roleOf(state, address) };
  const keys = ["start", "assess", "add", "remove", "challenge", "finalize"];
  if (!state) { for (const k of keys) out[k] = no("Load an event first."); return out; }
  const w = !address ? "Connect a wallet." : "";
  const owner = out.role === "owner";
  const windowOpen = state.deadline > nowSec;

  out.start = w ? no(w) : !owner ? no("Only the owner can start a round.")
    : !between.includes(state.phase) ? no("A round is already active.")
    : state.round >= MAX_ROUNDS ? no("Round limit reached.") : ok();
  out.assess = w ? no(w) : !owner ? no("Only the owner can assess.")
    : !["OPEN", "NEEDS_EVIDENCE"].includes(state.phase) ? no("Phase must be OPEN or NEEDS_EVIDENCE. Start a round first.") : ok();
  const sourceEdit = w ? no(w) : !owner ? no("Only the owner can change sources.")
    : !between.includes(state.phase) ? no("Sources can only change between assessments.") : ok();
  out.add = sourceEdit;
  out.remove = !sourceEdit.ok ? sourceEdit
    : (state.extra_sources || []).length === 0 ? no("There are no extra sources to remove.")
    : evidenceUrl && !(state.extra_sources || []).includes(evidenceUrl) ? no("That URL is not one of the extra sources (base sources are fixed).") : ok();
  out.challenge = w ? no(w)
    : state.phase !== "PROVISIONAL" ? no("There is no provisional decision to challenge.")
    : !windowOpen ? no("The challenge window has closed.")
    : state.challenge_used ? no("One challenge per round is already used.") : ok();
  out.finalize = w ? no(w)
    : state.phase !== "PROVISIONAL" ? no("There is no provisional decision to finalize.")
    : windowOpen ? no("The challenge window is still open.") : ok();
  return out;
}

const SECOND = ["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "bel", "k12", "gen", "web"];
// mirrors the contract's _site() heuristic (not the public-suffix list)
const SITE = u => { try { const l = new URL(u).hostname.toLowerCase().split("."); return l.length >= 3 && l[l.length - 1].length === 2 && SECOND.includes(l[l.length - 2]) ? l.slice(-3).join(".") : l.slice(-2).join("."); } catch { return null; } };
export function validateSetup(form) {
  const errs = [];
  if (!form.event || form.event.trim().length < 5 || form.event.length > 300) errs.push("Event identity needs 5 to 300 characters.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date || "")) errs.push("Original date must be YYYY-MM-DD.");
  if (!(form.window >= 300 && form.window <= 86400)) errs.push("Challenge window must be 300 to 86400 seconds.");
  if (form.sources.length !== 3 || form.sources.some(u => !/^https:\/\/[^\s/]+/.test(u))) errs.push("Give exactly three https source URLs.");
  else if (new Set(form.sources.map(SITE)).size !== 3) errs.push("The three sources must be on three distinct sites.");
  return errs;
}
