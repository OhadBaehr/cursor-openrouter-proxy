import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Shared cost state for the active tunnel URL. Cursor's "Override OpenAI Base
// URL" is a global setting, so there's exactly one URL in flight at a time and
// every Cursor window that has the extension running should display the same
// combined total. We persist to a tmpdir JSON file so adopted (viewer) windows
// can poll it without an RPC channel to the owner.
//
// File schema:
//   { url: string, total: number, requests: number, updatedAt: number,
//     lastModel?: string, lastCachedPct?: number, lastCost?: number }
//
// Writes are best-effort and rename-atomic so a concurrent reader never sees a
// half-written file. The owner is the only writer; everyone reads.

const STATE_DIR = path.join(os.tmpdir(), "cursor-proxy");
const COST_FILE = path.join(STATE_DIR, "cost.json");

export interface CostState {
  url: string;
  total: number;
  requests: number;
  updatedAt: number;
  lastModel?: string;
  lastCachedPct?: number;
  lastCost?: number;
}

export function readCostState(): CostState | null {
  try {
    const raw = fs.readFileSync(COST_FILE, "utf8");
    const s = JSON.parse(raw);
    if (
      typeof s?.url === "string" &&
      typeof s?.total === "number" &&
      typeof s?.requests === "number"
    ) {
      return s as CostState;
    }
  } catch {
    /* missing or malformed */
  }
  return null;
}

export function writeCostState(s: CostState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Rename-atomic write: readers either see the old file or the new one,
    // never a truncated mid-write state.
    const tmp = `${COST_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, COST_FILE);
  } catch {
    /* best-effort */
  }
}

export function clearCostState(): void {
  try {
    fs.unlinkSync(COST_FILE);
  } catch {
    /* ignore */
  }
}
