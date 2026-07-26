# Hevy Agents for ChatGPT and Codex

Install once. Give it your HEVY API key. Ask about your training.

Built on the original `hevy-mcp` foundation, then extended for modern agents:
your full workout history becomes a private local database an agent can query.

## Install in ChatGPT / Codex

```bash
codex plugin marketplace add PV-Bhat/hevy-agents-mcp
```

Then open **Plugins**, install **Hevy Agents**, and start a new chat.

## The only secret you need

1. In HEVY: **Settings > Developer** (HEVY PRO)
2. Put the key in Codex:

```dotenv
# ~/.codex/.env  (or Windows: %USERPROFILE%\.codex\.env)
HEVY_API_KEY=your-hevy-api-key
```

3. Restart Codex / ChatGPT Desktop

Do **not** paste the key into chat. The plugin only asks for that named secret
and never stores it in the repo.

## What you get after install

- Full history analytics via a private SQLite warehouse at
  `~/.hevy-agents-mcp/hevy-warehouse.db` (created automatically)
- Workouts, exercise history, routines, templates, folders, measurements
- Read-only workout history by design
- No Cloudflare setup. No warehouse path. No extra config.

First training question may trigger a one-time history import.

## Manual MCP config (any client)

```json
{
  "mcpServers": {
    "hevy": {
      "command": "npx",
      "args": ["-y", "hevy-agents-mcp@3.4.1"],
      "env": {
        "HEVY_API_KEY": "your-hevy-api-key",
        "HEVY_WAREHOUSE_DB": "auto"
      }
    }
  }
}
```

Docs: https://github.com/PV-Bhat/hevy-agents-mcp
