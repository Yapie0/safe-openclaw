---
name: Execution Isolation
description: Permission-based access control for AI tool calls
---

# Execution Isolation

Enforces filesystem, network, and command policies on all AI tool calls.

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "execution-isolation": {
      "enforcement": "block",
      "defaultAction": "allow",
      "filesystem": {
        "readAllow": ["~/workspace", "/tmp", "~/.openclaw"],
        "writeAllow": ["~/workspace", "/tmp"],
        "deny": ["~/.ssh", "~/.aws", "~/.gnupg"]
      },
      "network": {
        "allow": ["api.openai.com", "api.anthropic.com", "*.github.com"],
        "deny": ["10.*", "192.168.*", "169.254.*"]
      },
      "commands": {
        "allow": ["node", "python", "git", "pnpm", "npm", "curl"],
        "deny": ["sudo", "chmod", "chown"]
      }
    }
  }
}
```

## Policy Precedence

1. Deny rules always take precedence over allow rules
2. Tool-specific overrides take precedence over global policy
3. If no rules match, `defaultAction` determines the outcome
