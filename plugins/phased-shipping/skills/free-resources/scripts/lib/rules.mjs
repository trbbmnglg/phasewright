// Generic categories and thresholds. Every constant says why it has that value.
// All numbers are starting values, not tuned: the report prints them so you can judge them.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Pressure thresholds ----
// Below 15% available, Windows and macOS start trimming caches and compressing memory.
export const MEM_AVAILABLE_PCT_LOW = 15;
// Sustained paging above 200 pages/s means the machine is reading memory back from disk, which is felt as lag.
export const PAGING_PER_S_HIGH = 200;
// At 85% average CPU there is little room left for a build or test run on top.
export const CPU_AVG_PCT_HIGH = 85;

// ---- Sampling ----
// 3 s is long enough for a stable CPU delta and short enough to keep the whole scan under 15 s.
export const DEFAULT_SAMPLE_MS = 3000;
export const MIN_SAMPLE_MS = 500;
export const MAX_SAMPLE_MS = 30000;

// ---- Classifier thresholds ----
// Under 0.5% of one core over the sample is idle: a sleeping watcher shows 0.0, a working one does not.
export const IDLE_CORE_PCT = 0.5;
// Above the same 0.5% of one core a process is active, so it counts as in use.
export const ACTIVE_CORE_PCT = 0.5;
// A dev tool must have run for over an hour to count as left over; a fresh one is probably wanted.
export const IDLE_MIN_AGE_H = 1;
// Over 500 MB an unrecognised process is worth a look even though it is not on any list.
export const BIG_RSS_MB = 500;
// Over 5% of the whole machine's CPU an unrecognised process is worth a look.
export const BIG_CPU_MACHINE_PCT = 5;
// Below this a process is counted, never listed on its own.
export const SMALL_MB = 50;
// The report lists this many top consumers unless --top says otherwise.
export const DEFAULT_TOP = 8;

// ---- Dev leftovers: the only processes that can ever be "Suggest closing" ----
// Their own process name (Windows .exe suffix is ignored).
export const DEV_LEFTOVER_NAMES = ["workerd", "esbuild", "vite", "wrangler", "nodemon", "ts-node", "webpack", "next", "tsx"];
// Runtimes that run those tools as a script; the tool is then found in the first arguments.
export const DEV_RUNTIMES = ["node", "bun", "deno"];
// Browsers that test frameworks download live under this folder name.
export const PLAYWRIGHT_PATH = /ms-playwright/i;

// ---- Browsers: always "Your call", never suggested ----
export const BROWSER_NAMES = ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "safari", "arc", "chromium"];
export const BROWSER_PREFIXES = ["google chrome", "microsoft edge", "firefox", "brave browser"];
// Embedded web views belong to other apps (chat, mail), so they are not browsers.
export const NOT_BROWSER = ["msedgewebview2"];

// ---- Generic protected categories: always Keep ----
export const PROTECTED = {
  "operating system core": [
    "system", "system idle process", "idle", "registry", "memory compression", "secure system", "smss", "csrss", "wininit", "winlogon",
    "services", "lsass", "lsaiso", "svchost", "fontdrvhost", "dwm", "explorer", "sihost", "taskhostw", "ctfmon", "conhost", "dllhost",
    "runtimebroker", "searchhost", "searchindexer", "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "wmiprvse", "spoolsv",
    "audiodg", "wudfhost", "backgroundtaskhost", "applicationframehost", "lockapp", "taskmgr", "msiexec", "wlanext", "werfault", "smartscreen",
    "launchd", "kernel_task", "windowserver", "loginwindow", "finder", "dock", "systemuiserver", "coreservicesd", "mds", "mds_stores",
    "mdworker", "mdworker_shared", "cfprefsd", "distnoted", "notifyd", "syslogd", "opendirectoryd", "configd", "powerd", "coreaudiod",
    "bluetoothd", "airportd", "trustd", "secd", "logd", "diskarbitrationd", "fseventsd", "uninstalld", "usernoted", "sharingd",
  ],
  "security and endpoint protection": [
    "msmpeng", "nissrv", "mssense", "senseir", "securityhealthservice", "securityhealthsystray", "csfalconservice", "csfalconcontainer",
    "sentinelagent", "sentinelservicehost", "cbdefense", "cylancesvc", "mcshield", "mfemms", "sophosfs", "xagt", "ccsvchst",
    "endpointsecurityd", "xprotect", "xprotectservice", "syspolicyd", "amfid", "taniumclient",
  ],
  "terminals and shells": [
    "cmd", "powershell", "pwsh", "windowsterminal", "wt", "openconsole", "bash", "zsh", "sh", "fish", "mintty", "terminal", "iterm2",
    "alacritty", "wezterm", "kitty", "wsl", "wslhost",
  ],
  "editors and IDEs": [
    "code", "code - insiders", "cursor", "devenv", "idea", "idea64", "webstorm64", "pycharm64", "rider64", "clion64", "goland64",
    "sublime_text", "notepad++", "notepad", "nvim", "vim", "emacs", "windsurf", "zed", "atom", "xcode",
  ],
  "git": ["git", "git-remote-https", "git-credential-manager", "gitkraken", "githubdesktop"],
  "ssh, VPN and remote desktop": [
    "ssh", "sshd", "ssh-agent", "tailscale", "tailscaled", "tailscale-ipn", "openvpn", "wireguard", "wg", "anyconnect", "vpnui", "vpnagent",
    "globalprotect", "pangps", "pangpa", "forticlient", "mstsc", "rdpclip", "rdpinput", "teamviewer", "anydesk", "msrdc",
  ],
  "coding assistants and this tool": [
    "claude", "claude-code", "copilot", "copilot-language-server", "copilot-runtime", "codex", "aider", "gemini", "cursor-agent",
  ],
};
// Name patterns for families with many members.
export const PROTECTED_PATTERNS = [
  [/^code helper/, "editors and IDEs"],
  [/^(sense|taniumc|tanium|crowdstrike|sentinel|defender|mpdefender|windowsdefender)/, "security and endpoint protection"],
];

// ---- System locations: nothing under these is ever Suggest closing ----
export const SYSTEM_PATHS_WIN = [/^[a-z]:[\\/]windows[\\/]/i, /^[a-z]:[\\/]program files( \(x86\))?[\\/]/i, /^[a-z]:[\\/]programdata[\\/]/i];
export const SYSTEM_PATHS_MAC = [/^\/system\//i, /^\/library\//i, /^\/usr\//i, /^\/bin\//i, /^\/sbin\//i, /^\/private\/var\/db\//i];
// Accounts that mean "not a person": never ours to close.
export const SERVICE_OWNERS = /^(nt authority|nt service|font driver host|window manager|umfd-|dwm-)|^(system|local service|network service|root|daemon)$|^_/i;

// ---- Local protected list ----
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCAL_PROTECTED = join(HERE, "..", "protected.local.json");

// Loads {"names":[...],"paths":[...]} from FREE_RESOURCES_PROTECTED (a file path) or scripts/protected.local.json.
// Names may end in * as a wildcard. A missing or unreadable file means an empty list, never an error.
export function loadLocalProtected(env = process.env) {
  const file = env.FREE_RESOURCES_PROTECTED || DEFAULT_LOCAL_PROTECTED;
  const empty = { names: [], paths: [], source: null, warning: null };
  if (!existsSync(file)) return env.FREE_RESOURCES_PROTECTED ? { ...empty, warning: "FREE_RESOURCES_PROTECTED points to a file that does not exist" } : empty;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
    return { names: list(raw.names), paths: list(raw.paths), source: env.FREE_RESOURCES_PROTECTED ? "FREE_RESOURCES_PROTECTED" : "scripts/protected.local.json", warning: null };
  } catch {
    return { ...empty, warning: "the local protected list could not be read as JSON and was ignored" };
  }
}
