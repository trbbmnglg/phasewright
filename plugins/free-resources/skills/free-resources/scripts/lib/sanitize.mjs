// Names that come from the machine (a process name, a tool name) are text that someone else chose: another user, a
// downloaded program or a repository decides what a process is called. A name can carry a line break, a bidirectional
// control that makes text look like something else, or characters that mean something to a shell or to Markdown.
// Every name passes through safeName before it is printed or put in JSON. Matching against the protected lists uses
// the original name, never this one.
const MAX_NAME = 40;
// Letters and digits of any language, space, and the few punctuation marks a program name really uses.
const UNSAFE = /[^\p{L}\p{N} ._()+\-#@~]/gu;
// Control characters, format characters (bidi controls, zero-width characters), line and paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function safeName(value, max = MAX_NAME) {
  const cleaned = String(value ?? "").normalize("NFC").replace(INVISIBLE, "").replace(UNSAFE, "?").trim();
  if (!cleaned) return "(unnamed)";
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : cleaned;
}
