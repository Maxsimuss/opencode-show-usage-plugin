# OpenCode Show Usage

A small OpenCode v2 TUI plugin that shows your remaining 5-hour and weekly usage in the status bar, with reset countdowns in the sidebar. When a limit runs out, the status bar shows its countdown instead of `0%`. The display follows the provider selected in the focused chat.

- **Codex:** Usage only shows with OpenCode’s **Codex browser (legacy)** ChatGPT sign-in. The standard **Sign in with ChatGPT** option does not grant access to Codex limits.
- **OpenCode Go:** Uses the usage data from your connected OpenCode Console account.

API-equivalent cost estimates use recorded tokens and published rates from [models.dev](https://models.dev), not subscription charges. The status bar shows the selected model’s estimate for the current session. The sidebar breaks down the session and its subagents by `provider/model`. On OpenCode 2.3.2, the ↓ subagent picker also shows `provider/model#variant` and an estimate for each subagent.

## Install

```sh
opencode plugin add github:Maxsimuss/opencode-show-usage-plugin
```
