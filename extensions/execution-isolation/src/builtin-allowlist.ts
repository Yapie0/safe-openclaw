/**
 * Built-in allowlists for commonly used, trusted services and commands.
 *
 * These are automatically merged into the user's policy so that popular
 * Skill Hub skills work out of the box in deny-default mode.
 * Users can still explicitly deny any of these via their deny lists.
 */

/** Trusted API domains — major cloud/AI/dev platforms. */
export const BUILTIN_NETWORK_ALLOW: string[] = [
  // AI providers
  "api.openai.com",
  "api.anthropic.com",
  "*.googleapis.com",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "api.mistral.ai",
  "api.cohere.com",
  "api.groq.com",
  "api.together.xyz",
  "api.replicate.com",
  "api-inference.huggingface.co",

  // GitHub
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",

  // Package registries
  "registry.npmjs.org",
  "registry.npmmirror.com",
  "pypi.org",

  // Google services
  "*.google.com",
  "*.googleapis.com",
  "accounts.google.com",
  "oauth2.googleapis.com",

  // Microsoft
  "graph.microsoft.com",
  "login.microsoftonline.com",

  // Common dev tools
  "api.notion.com",
  "api.slack.com",

  // Weather (no API key needed)
  "wttr.in",
  "api.open-meteo.com",

  // Search engines
  "api.search.brave.com",
  "www.googleapis.com",
];

/** Safe commands that are commonly used by skills. */
export const BUILTIN_COMMANDS_ALLOW: string[] = [
  // Shell basics
  "echo",
  "cat",
  "head",
  "tail",
  "less",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "tee",
  "xargs",
  "true",
  "false",
  "test",
  "expr",
  "seq",
  "date",
  "sleep",

  // File inspection (read-only)
  "ls",
  "find",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whereis",
  "realpath",
  "basename",
  "dirname",

  // Text processing
  "grep",
  "rg",
  "sed",
  "awk",
  "diff",
  "jq",
  "yq",

  // Dev tools
  "node",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "python3",
  "pip",
  "pip3",
  "git",
  "gh",
  "curl",
  "wget",

  // Build tools
  "make",
  "cmake",
  "cargo",
  "go",
  "rustc",
  "gcc",
  "g++",
  "javac",
  "java",
  "mvn",
  "gradle",

  // Formatters & linters
  "prettier",
  "eslint",
  "oxlint",
  "tsc",
  "tsgo",
  "biome",

  // System info (read-only)
  "uname",
  "hostname",
  "whoami",
  "id",
  "env",
  "printenv",
  "pwd",
  "ps",
  "top",

  // Archive
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",

  // Misc safe tools
  "md5sum",
  "sha256sum",
  "base64",
  "openssl",
  "ssh-keygen",
];

/** Commands that should NEVER be allowed (hardcoded deny). */
export const BUILTIN_COMMANDS_DENY: string[] = [
  "sudo",
  "su",
  "doas",
  "pkexec",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "systemctl",
  "launchctl",
  "mkfs",
  "fdisk",
  "dd",
  "mount",
  "umount",
  "iptables",
  "nft",
  "pfctl",
  "useradd",
  "userdel",
  "usermod",
  "passwd",
  "chpasswd",
  "visudo",
];
