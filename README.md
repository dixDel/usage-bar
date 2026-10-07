# usage-bar

A Claude Code mod that draws a band above the prompt:

```
~/Code/app  ⎇ develop  Opus 5.5 (1M context)
Context ███░░░░░░░▒ 26% 260k/1.0M
        ■ System prompt 20k  ■ Messages 240k
        Context above 250k: run /compact to free space
     5h ████░░░░░░░ 43% resets 18:00          7d █░░░░░░░░░░ 7% resets Fri 00:05
```

- **First row**: the session's folder (home written `~`), its git branch (`detached <sha>` on a detached
  HEAD, absent outside a repository) and the model as `/model` shows it. A narrow terminal cuts the model
  first. A `/cd`, `/model` or checkout outside a turn shows at the next prompt.
- **Context**: the context window by category, with free space and the autocompact buffer. From 250k
  tokens the figures turn orange and the band suggests `/compact`.
- **5h / 7d**: rate-limit usage, coloured green to red by level, 7d faded, side by side on one row. The
  figure turns yellow at 50%, orange at 75%, red at 90%. Resets are in local time. A terminal too narrow
  for two bars draws each on its own row.

Every bar has the same width, set by the terminal width alone, never by the figures. `/usage-bar` hides or shows the band; the
choice is kept across sessions.

## Install

The repository is its own marketplace. In a terminal:

```bash
claude plugin marketplace add git@gitlab.com:dixdel-ai/usage-bar.git
claude plugin install usage-bar@dixdel-ai
```

## Develop

Run it from a checkout instead, which reloads on every save in an interactive session:

```bash
claude --plugin-dir /path/to/usage-bar
```

or name the folder in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

```bash
claude plugin validate .   # manifest, marketplace and hooks module
claude plugin test .       # hooks/register.test.tsx
```
