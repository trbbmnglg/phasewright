// Which commits board-sync reads for a pushed range. Kept apart from board-sync.mjs because that script
// calls the GitHub API as soon as it loads, so it cannot be tested; this one only runs git.
//
// `git` is a function that runs git with the given arguments and returns its output as text. It throws
// when git exits with a non-zero status, and the thrown error carries that status as `status`.
//
//   commitShas("<before>..<after>", git)  ->  the commit ids to read, oldest first
//
// Rules:
//   - a range whose "before" is all zeros (a new branch) reads the latest commit of "after";
//   - a normal range reads before..after;
//   - when "before" is not a commit in this clone, or is not an ancestor of "after" (a force-push or an
//     amended commit), it reads only the pushed head and logs "force-push detected: reading the pushed head only".

const lines = (text) => String(text).split("\n").map((s) => s.trim()).filter(Boolean);

export function commitShas(range, git, log = console.log) {
  const at = range.indexOf("..");
  if (at < 0) return lines(git("log", "--format=%H", range)).reverse();
  const before = range.slice(0, at);
  const after = range.slice(at + 2);
  const headOnly = () => lines(git("log", "-1", "--format=%H", after));

  if (/^0+$/.test(before)) return headOnly(); // a brand-new branch has no "before"

  let known = true;
  try { git("cat-file", "-e", `${before}^{commit}`); } catch { known = false; }
  let ancestor = known;
  if (known) {
    try { git("merge-base", "--is-ancestor", before, after); } catch (e) {
      if (e?.status !== 1) throw e; // exit 1 means "not an ancestor"; anything else is a real failure
      ancestor = false;
    }
  }
  if (!ancestor) {
    log("force-push detected: reading the pushed head only");
    return headOnly();
  }
  return lines(git("log", "--format=%H", range)).reverse();
}
