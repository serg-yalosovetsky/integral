# integral

One [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview.md) that draws, above the prompt:

1. **Context**: the window's fill split by consumer (messages, tools, skills...), the percentage, and three buttons: `>` full breakdown, `↓` compact, `!` checkpoint. Press the percentage to name the consumers one by one.
2. **Plan limits**: the 5-hour and 7-day windows as two thin bars, colored by pace: green on pace, yellow ahead of it, red at twice the pace or with under 20% left. MCP servers that failed or need a login share this row, with reconnect / auth buttons.
3. **Plan progress**: the current task and `done/total`, only while the session works through a task list.

Needs Claude Code 2.1.287 or later.

## Install

```
/plugin marketplace add serg-yalosovetsky/integral
/plugin install integral@integral
```

Then `/reload-plugins`. `/integral` hides or shows it; `/integral more`, `/integral mcp`, `/integral plan off|on`.
