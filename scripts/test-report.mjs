// A small test reporter for `node --test`, used by scripts/verify.mjs and scripts/test-inventory.mjs.
//   node --test --test-reporter=<this file> --test-reporter-destination=<results file> tests/*.test.mjs
// It writes one JSON object per line: { file, name, status, ms }. `name` is the full path of suite and
// test names joined by " > ", `status` is "run" or "skip", and `ms` is the test's wall time. Suites
// (describe blocks) are not records; they only add to the path. Failed tests are records with status "run"
// and fail: true (the test run itself reports the failure through its exit code).
// The helpers below are exported so tests can feed them events or lines without running node --test.
import { readFileSync } from "node:fs";

export const SEP = " > ";

// Names go into a line-based inventory, so a line break in a name becomes a space (the same on both sides).
export const cleanName = (s) => String(s).replace(/[\r\n]+/g, " ");

// Turns the events of one node --test run into records. Events of one test file arrive in depth-first order
// (a parent starts before its children and ends after them), so a stack per file gives each test its path.
export function recorder(onRecord) {
  const stacks = new Map();
  return (event) => {
    const { type, data } = event ?? {};
    if (!data || typeof data.name !== "string") return;
    const file = data.file ?? "";
    let stack = stacks.get(file);
    if (!stack) stacks.set(file, (stack = []));
    const depth = Number.isInteger(data.nesting) ? data.nesting : 0;
    if (type === "test:start") {
      stack.length = depth;
      stack[depth] = data.name;
      return;
    }
    if (type !== "test:pass" && type !== "test:fail") return;
    stack.length = depth;
    const path = [...stack.slice(0, depth), data.name];
    if (data.details?.type === "suite") return;
    onRecord({
      file: file && file.replace(/\\/g, "/").split("/tests/").pop(),
      name: cleanName(path.join(SEP)),
      status: data.skip || data.todo ? "skip" : "run",
      ms: Math.round((data.details?.duration_ms ?? 0) * 10) / 10,
      ...(type === "test:fail" ? { fail: true } : {}),
    });
  };
}

// The reporter node --test loads: an async generator that yields the JSON lines.
export default async function* testReport(source) {
  const lines = [];
  const rec = recorder((r) => lines.push(JSON.stringify(r) + "\n"));
  for await (const event of source) {
    rec(event);
    while (lines.length) yield lines.shift();
  }
}

// Reads a results file back into records. A line that is not JSON is an error, not skipped.
export function readResults(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

export const slowest = (records, n = 10) => [...records].sort((a, b) => b.ms - a.ms).slice(0, n);
