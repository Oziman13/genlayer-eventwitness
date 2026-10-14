// Pure reconciliation rules for a transaction that may have been broadcast without a known hash.
const lc = x => String(x ?? "").toLowerCase();
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const ZERO = "0x" + "0".repeat(40);

// Accepts the shapes a Studio node may return and keeps only what matching needs.
export function normalizeTx(t) {
  if (!t || typeof t !== "object") return null;
  const hash = t.hash ?? t.transaction_hash ?? t.id ?? null;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(hash)) return null;
  const at = num(t.created_at ?? t.timestamp ?? t.createdAt ?? t.time);
  return {
    hash,
    from: lc(t.from_address ?? t.from ?? t.sender ?? ""),
    to: lc(t.to_address ?? t.to ?? t.recipient ?? ""),
    nonce: num(t.nonce),
    at: at === null ? null : (at > 1e12 ? at / 1000 : at), // seconds
  };
}

// Which listed transactions could be the one the page tried to send?
export function matchCandidates(list, rec) {
  const SLACK = 600; // seconds of clock difference we tolerate
  const startSec = rec.at ? rec.at / 1000 - SLACK : null;
  return (list || []).map(normalizeTx).filter(Boolean).filter(t => {
    if (t.from && t.from !== lc(rec.account)) return false;
    if (rec.fn !== "deploy" && t.to && t.to !== ZERO && t.to !== lc(rec.address)) return false;
    if (rec.nonceBefore !== null && rec.nonceBefore !== undefined && t.nonce !== null && t.nonce < rec.nonceBefore) return false;
    if (startSec !== null && t.at !== null && t.at < startSec) return false;
    return true;
  });
}

// listing: array of raw txs, or null when the node could not list. nonceNow: number or null.
export function nextStep(rec, { listing, nonceNow }) {
  if (rec.hash) return { kind: "WATCH", hash: rec.hash };
  const cands = listing ? matchCandidates(listing, rec) : [];
  if (cands.length === 1) return { kind: "WATCH", hash: cands[0].hash, located: true };
  if (cands.length > 1) return { kind: "UNRESOLVED", reason: "SEVERAL", hashes: cands.map(c => c.hash) };
  if (nonceNow === null || nonceNow === undefined) return { kind: "UNRESOLVED", reason: "NO_NONCE", hashes: [] };
  const before = rec.nonceBefore;
  if (before !== null && before !== undefined && nonceNow <= before) return { kind: "NOT_SENT" };
  return { kind: "UNRESOLVED", reason: listing ? "NONCE_MOVED_NO_MATCH" : "NONCE_MOVED_NO_LIST", hashes: [] };
}
