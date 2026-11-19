# OpenCode Show Usage

A small OpenCode v2 TUI plugin that shows your remaining 5-hour and weekly usage in the status bar, with reset countdowns in the sidebar. When a limit runs out, the status bar shows its countdown instead of `0%`. The display follows the provider selected in the focused chat.

- **Codex:** Usage only shows with OpenCode’s **Codex browser (legacy)** ChatGPT sign-in. The standard **Sign in with ChatGPT** option does not grant access to Codex limits.
- **OpenCode Go:** Uses the usage data from your connected OpenCode Console account.

## Install

Clone this repository, then add its absolute path to the `plugins` array in your OpenCode `cli.json`:

```json
{
  "plugins": ["/path/to/opencode-show-usage-plugin"]
}
```
