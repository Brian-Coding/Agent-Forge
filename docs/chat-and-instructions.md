# Chat, plans, and shared instructions

## Messages

- Replies render as Markdown with syntax-highlighted code and copy buttons.
- Tool activity is collapsed by default; toggle it on to see every tool call.
- **Images:** paste, drop, or attach up to 100 images per message. They are uploaded to Agent Forge's local artifact folder and passed to the provider by path rather than squeezed into the WebSocket.
- **Queued follow-ups:** you can keep typing while an agent works. Messages queue on the server and run in order; the pane shows what is waiting.
- **Retry:** every user message has a retry action, and failed turns offer **Retry last request**.
- **Search** within a conversation from the pane header.
- **Clear history** resets the chat and the provider session for that agent.

If a provider reports that you are signed out or your token expired, the prompt is preserved and the pane offers **Check again** and a retry once you have signed back in.

## Slash commands

Type `/` in the composer to pick from built-in prompt templates (code review, tests, debugging, planning, and more). The **Slash Commands** sidebar lists them all; click one to copy it.

## Plans

Agents are told to keep plans as Markdown files in the project's `.plans/` folder. Agent Forge watches that folder and includes the relevant plans in each agent's context. Put a `Lifecycle:` line near the top of a plan (Draft, Approved, In Progress, Paused, Completed, ...) so agents know whether they may act on it. A `.plans/README.md` catalog, if present, is read first.

## How agent context is assembled

Open **Settings** (gear icon) to see exactly what every agent receives. For each turn Agent Forge builds:

1. **Built-in guardrails** (read-only): safety and change-control rules, e.g. never commit, push, merge, or run destructive commands unless you explicitly ask; protect existing work; never print secrets.
2. The agent's **persona**, if set.
3. Your **shared project instructions** from the Settings screen (editable; applies to all agents in this Agent Forge instance).
4. Relevant **plans** from `.plans/`.
5. Report-delivery, plan-management, and conversation-scope instructions.
6. The default **iOS simulator** (when set and relevant) and the agent's **reference folders**.

Claude receives this as an appended system prompt. Codex receives it as a clearly delimited block ahead of your message.

Use shared instructions for your own working preferences, for example how you like commit messages written or which model should sign off on its answers. Do not put tokens or other secrets there.
