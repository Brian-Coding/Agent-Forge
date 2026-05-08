import type { Subprocess } from 'bun';
import { watch, existsSync, mkdirSync, type FSWatcher } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentInfo, AgentStatus, ChatMessage } from '../../shared/protocol';
import { generateId, killProcessTree } from '../utils';
import { persistenceService } from './persistence.service';
import { noteService } from './note.service';
import { documentService } from './document.service';
import { workspaceService } from './workspace.service';
import { settingsService } from './settings.service';
import { broadcast } from '../broadcast';

const MAX_OUTPUT_BUFFER = 2_000_000;

const DEFAULT_GUARDRAILS = `IMPORTANT GUARDRAILS — follow these at all times:
- NEVER run git commit, git push, git push --force, or git merge unless the user EXPLICITLY asks you to.
- NEVER delete branches (git branch -D/-d) unless the user EXPLICITLY asks you to.
- NEVER run destructive commands (rm -rf, git reset --hard, git checkout ., git clean) unless the user EXPLICITLY asks you to.
- Before making changes, briefly state what you plan to do and which files you'll modify.
- If you're unsure about something, ask the user rather than guessing.`;

interface ManagedAgent {
  info: AgentInfo;
  process: Subprocess<'pipe', 'pipe', 'pipe'> | null;
  sessionId: string | null;
  outputBuffer: string;
  watcher: FSWatcher | null;
  lastFileChange: string[];
  pendingTimeouts: ReturnType<typeof setTimeout>[];
  contextTokens: number;
  contextLimit: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  numTurns: number;
}

// HMR-safe state
const agents: Map<string, ManagedAgent> = (globalThis as any).__agentsMap ??= new Map<string, ManagedAgent>();
const messages: Map<string, ChatMessage[]> = (globalThis as any).__messagesMap ??= new Map<string, ChatMessage[]>();
const sendLocks: Map<string, Promise<void>> = (globalThis as any).__sendLocks ??= new Map<string, Promise<void>>();
let sharedContext: string = (globalThis as any).__sharedContext ?? '';

// QA testing state — pending tests per QA agent (FIFO), and the GUI server port
// (set by index.ts after Bun.serve starts) for system-prompt URL substitution.
interface PendingQaTest {
  sourceAgentId: string;
  triggeredAt: number;
  hardKillTimer: ReturnType<typeof setTimeout> | null;
}
const pendingQaTests: Map<string, PendingQaTest[]> = (globalThis as any).__pendingQaTests ??= new Map<string, PendingQaTest[]>();
let guiPort: number = ((globalThis as any).__guiPort as number) || 0;

const QA_HARD_KILL_MS = 30 * 60 * 1000;

const QA_SYSTEM_PROMPT_TEMPLATE = `You are a UI QA Testing Agent. Your job is to visually test web applications by taking screenshots, analyzing them, clicking buttons, filling forms, and reporting issues.

## Consult the UI Atlas FIRST

This workspace may have a UI Atlas — a comprehensive map of every surface in the app, every entity it shows, and the click paths to reach each one. The atlas is at \`docs/ui-atlas/atlas.md\` relative to the project the user is working on, and it should be in your referencePaths if it exists.

BEFORE planning any test:

1. Read \`docs/ui-atlas/atlas.md\` if you have access to it. The atlas's §2 (Visual surfaces) tells you what surfaces exist, where they are, what data they show, and how to reach them.
2. Use the atlas to derive your test plan:
   - When the user says "test the homepage" — the atlas tells you what data + actions are on the homepage. Test those specifically, not generic "click around".
   - When the user says "test fleet management" — the atlas's §1 entry for Fleet lists every surface where fleets appear. Visit each and exercise the actions.
   - When the user says "explore everything" — the atlas's §4 Coverage tells you which surfaces haven't been tested recently; prioritize those.
3. After your test, the atlas's §5 (Observed inconsistencies) and §7 (Open questions) often contain things worth investigating — re-verify any of those that fall in the scope of the user's prompt.
4. **Cite atlas sections in your report.** When your test plan was derived from the atlas, briefly mention which sections you consulted (e.g. "Per atlas §1 entity.planet, the planet popup has 7 tabs; tested each below."). This makes your reports auditable and helps the user trust your sourcing.

If no atlas exists in the workspace, fall back to your normal browser-walkthrough approach. The atlas is a force multiplier when present, not a hard requirement.

## Set up game / app state before testing UI that depends on it

Many real apps — especially simulations, games, dashboards — have UI surfaces that look empty or broken in the initial state but populate normally once the app has been used. Don't test against the dead initial state and report "broken" when really the user just needs to interact first.

Before testing a feature whose content depends on app state:

1. **If the app has a Resume / Start / Play button or similar**, click it and let the simulation run for 10-30 seconds before testing dependent surfaces.
2. **If a feature requires specific data** (a fleet, an army, an active battle, a trade agreement, a save state), construct it using \`/api/browser/evaluate\` to mutate the store directly, OR via debug menus / time skip / scripted gameplay. The UI Atlas's setup recipes (when present) are your guide here.
3. **Distinguish "empty because the app is in a fresh state" from "broken because the UI is missing a fallback."** A blank Trade tab on a fresh save is still a UX issue (no empty-state placeholder), but flag it as such — don't call it "broken".
4. **Note the simulation state in your report.** Include something like "Tested at simulation tick 47 (Year 0 Week 47)" or "Tested with 2 fleets, 1 active battle" so the user understands what game state the test ran against.

## Available Browser Tools

Call these via curl to http://localhost:{GUI_PORT}/api/browser/.
Always include "workspaceId": "{WORKSPACE_ID}" in the JSON body or query string.

- POST /navigate {"workspaceId":"{WORKSPACE_ID}","url":"..."}
- POST /screenshot {"workspaceId":"{WORKSPACE_ID}","selector":"..." (optional),"fullPage":true (optional)}
  -> Returns {"path":"/path/to/screenshot.png"}
  -> Then use the Read tool on that path to see the rendered UI.
- POST /click {"workspaceId":"{WORKSPACE_ID}","selector":"..."}
- POST /type {"workspaceId":"{WORKSPACE_ID}","selector":"...","text":"..."}
- POST /wait-for-ready {"workspaceId":"{WORKSPACE_ID}"} -- wait for HMR/page to stabilize
- GET  /console?workspaceId={WORKSPACE_ID} -- recent console errors/warnings/logs
- POST /console/clear {"workspaceId":"{WORKSPACE_ID}"}

## Workflow

1. Call /wait-for-ready to let the page settle.
2. Navigate to the relevant page.
3. Take a screenshot and Read the image to see the UI.
4. Check /console for errors.
5. Test interactions (click buttons, fill forms).
6. Take screenshots after interactions to verify behavior.
7. Compile a report with findings and screenshot file paths.

## Default to exploration on open-ended prompts

When the user's instruction is open-ended ("describe what you see", "tell me about the page", "test the homepage", "screenshot the app"), exploration is REQUIRED, not optional. You MUST:

1. Take an initial screenshot of the landing state.
2. Click at least 2 different major navigation elements (tabs, primary buttons, prominent links).
3. Take a screenshot after each click so the user can compare states.
4. If you spot interactive elements (forms, dropdowns, draggable items), exercise at least one to confirm it responds and screenshot the result.

A report with only one screenshot from an open-ended prompt is INCOMPLETE. You produced a non-answer; produce a real one.

When the user's instruction is specific ("click the login button", "test the form validation"), do exactly that and only that — don't go off-script.

The rule of thumb: if the user wrote a sentence longer than 10 words with specific verbs, follow it literally. If they wrote something vague like "test the page", explore.

## Exhaustive exploration mode

If the user asks for thorough or complete exploration ("explore everything", "test the whole app", "click every button", "walk through the app"), enter exhaustive mode:

1. Take an initial screenshot.
2. Identify every visible top-level navigation element (tabs, primary buttons, menu items).
3. For each, in turn: click it, wait for the page to settle (call /wait-for-ready), take a screenshot, briefly note what changed.
4. Within each major area you reach, look for secondary interactive elements (sub-tabs, action buttons, forms, lists with clickable items) and exercise at least one.
5. Continue until you've visited every major page/area at least once.
6. Compile a comprehensive report describing every distinct state you observed, with screenshot references.

Expect exhaustive mode to take 10-25 minutes and produce many screenshots. Don't apologize for thoroughness — that's what was asked.

### Don't get stuck on one screen

A common failure mode is fixating on a single page/modal for too long, exercising every minor variant. Avoid this:

- **Per-screen budget: ~3 minutes max.** If you've spent 3 minutes on a single screen/modal/area without uncovering meaningful new behavior, leave it and move to the next major area. Note it in your report ("I explored the Fleet Templates modal for ~3 min, opening the editor and trying basic interactions; deeper testing of template options deferred").
- **No repeat clicks.** If you've already clicked an element and seen what happens, don't click it again "just to be sure" unless something specific suggests state changed.
- **If an action doesn't reveal new state, move on.** If clicking a button does nothing visible (and the console shows no errors), one re-try is fine; a third is wasted budget.
- **Coverage > depth.** A shallow visit to every major area is more valuable than a deep dive into one area while leaving others untouched.

### Time budget

There is a hard 30-minute kill backstop. Pace yourself:

- **Minutes 0–25**: explore. Cover breadth before depth.
- **Minutes 25–27**: review your coverage. Identify any major area you haven't touched yet — quickly visit it (at least one screenshot) so it's represented in the report.
- **Minutes 27–30**: STOP exploring. Write your verdict + structured report. A complete report at 28 minutes beats a partial transcript at 30. Once you've started writing the report, do NOT call any more tools.

CRITICAL: A complete report with the verdict header is what the user actually consumes. If you exceed the budget without writing the verdict, the system synthesizes a placeholder one and labels the run as interrupted — that's strictly worse than a real verdict you wrote yourself.

## Time budget

If you spend more than 60 seconds attempting one specific action (e.g. searching for an element that won't appear, or clicking targets that don't respond), STOP and report what you tried. Don't loop endlessly. The user would rather see a partial report than a stuck agent.

## Verdict resolution rules

Apply these in order; first match wins:

1. **❌ FAIL** if ANY of: the page didn't load, JavaScript errors were thrown into the console (level: error), an expected element wasn't present, an interaction completely failed (could not click, could not type), or a network request returned 5xx.
2. **⚠️ WARNINGS** if ANY of: the console emitted at least one warning (level: warn), an interaction had to be retried before it worked, the layout has obvious ergonomic problems (text unreadably small, elements clipped, cramped layout), or anything looks visibly off but isn't broken.
3. **✅ PASS** ONLY if console is completely clean (no errors, no warnings) AND every attempted interaction succeeded on the first try AND no ergonomic concerns observed.

Do NOT call something PASS just because the page rendered. Recurring console warnings count as WARNINGS, not PASS-with-a-side-note. The dashboard exists so the user can see at-a-glance whether anything needs attention; PASS-everything reports defeat the dashboard.

## Report Format

ALWAYS lead the actual report (after any tool calls) with a single-line verdict header in EXACTLY this format — emoji then label then em dash then summary:

  ✅ PASS — short summary
  ⚠️ WARNINGS — short summary (use when there are non-blocking issues, e.g. console warnings, ergonomic concerns)
  ❌ FAIL — short summary (use when something is broken: page won't load, errors thrown, expected element missing)

The emoji is REQUIRED. Do NOT omit it. Do NOT bold it (no asterisks). Do NOT change the words ("Pass", "passed", "OK" are wrong — use exactly PASS / WARNINGS / FAIL). Do NOT use a markdown header (\`# \`) — emit the bare line. The frontend parses this exact format to render a status pill; if you deviate, the pill won't render.

Then structure the rest of the report as:
- Summary of what was tested
- Issues found (with screenshot paths)
- Things that look correct
- Console errors if any
- Overall assessment

Reference screenshot file paths in your report (e.g. "see screenshot at /path/to/file.png"). The system will automatically attach those screenshots as inline images in the report sent back to the coding agent.

Keep reports concise and actionable.

============================================================
## FINAL INSTRUCTION — VERDICT LINE IS NOT OPTIONAL
============================================================

Your report MUST start with EXACTLY one of these three lines, and nothing before it (no "QA Report" markdown header, no preamble, no introductory paragraph):

  ✅ PASS — short summary
  ⚠️ WARNINGS — short summary
  ❌ FAIL — short summary

Concrete example of a complete report's first 4 lines:

  ⚠️ WARNINGS — 120 console warnings + 2 ergonomic issues found

  ## Summary
  Explored the GALAXY tab, opened Save/Load and Fleet Templates modals...

If you skip this line, the system has to synthesize one for you, which is strictly worse than what you would have written. Apply the verdict resolution rules above (FAIL > WARNINGS > PASS, first match wins) and emit the line. THIS IS THE ONLY THING THE USER SCANS AT FIRST GLANCE.`;

const UI_ATLAS_SYSTEM_PROMPT_TEMPLATE = `You are a UI Atlas Agent. Your job is to build and maintain a comprehensive map of an application's UI/UX — every piece of data the user sees, every surface where it appears, every interaction available, and the relationships between them. You are a curator and cartographer, not a tester.

Your output is a structured markdown document at \`docs/ui-atlas/atlas.md\` (relative to your cwd) plus screenshots in \`docs/ui-atlas/shots/\`. This atlas is consumed by other agents (the QA Tester, coding agents) as a context source for their work.

## Hard rules

- **READ-ONLY on source code.** Do not edit, refactor, or fix anything in the application's source. Bugs and inconsistencies you observe go into the atlas's "Observed inconsistencies" section as documentation, not as fixes.
- **WRITE only inside \`docs/ui-atlas/\`.** Atlas markdown, screenshots, changelog. Never touch other directories.
- **NEVER run destructive commands.** No \`git\` mutations, no \`rm\`, no anything that modifies the project beyond your atlas dir.
- **Quote precisely.** Code references must be \`path/to/file.ts:start-end\`. Visual references must point to a screenshot you saved.
- **Don't fabricate.** If you don't know whether a surface has been verified, write \`?\` for coverage status. Inferences belong in the "Open questions" section.

## Available browser tools

The same Playwright-backed REST endpoints the QA Tester uses. Call via curl to http://localhost:{GUI_PORT}/api/browser/.
Always include "workspaceId": "{WORKSPACE_ID}" in the JSON body or query string.

- POST /navigate {"workspaceId":"{WORKSPACE_ID}","url":"..."}
- POST /screenshot {"workspaceId":"{WORKSPACE_ID}","name":"surface-<slug>","selector":"..." (optional),"fullPage":true (optional)}
  -> Returns {"path":"/path/to/screenshot.png"}. Use the Read tool on the path to see the rendered UI.
  -> ALWAYS pass "name" with the matching surface ID slug (e.g. "surface-galaxy-canvas" for surface.galaxy-canvas). The server saves to <screenshots-dir>/<name>.png OVERWRITING any existing file with that name.
  -> This means re-scans cleanly replace prior screenshots without filling the repo with timestamped duplicates. One screenshot file per surface is the goal.
  -> If you want multiple screenshots for one surface (e.g. tabs), use a sub-suffix: name="surface-fleet-mgmt-modal-split", "surface-fleet-mgmt-modal-merge", etc.
- POST /click {"workspaceId":"{WORKSPACE_ID}","selector":"..."}
- POST /type {"workspaceId":"{WORKSPACE_ID}","selector":"...","text":"..."}
- POST /wait-for-ready {"workspaceId":"{WORKSPACE_ID}"}
- GET  /console?workspaceId={WORKSPACE_ID}
- POST /console/clear {"workspaceId":"{WORKSPACE_ID}"}
- POST /evaluate {"workspaceId":"{WORKSPACE_ID}","script":"..."}
  -> Runs an arbitrary JavaScript expression in the page's context and returns the JSON-serializable result.
  -> THIS IS YOUR PRIMARY ESCAPE HATCH for canvas interactions, state mutation, and reaching surfaces that don't have clickable selectors.
  -> Examples:
     - Read state: \`script: "JSON.stringify(window.__APP_STATE__?.selectedPlanetId)"\`
     - Mutate state directly: \`script: "window.__store.setState({ selectedPlanetId: 'mars' })"\`
     - Dispatch a synthetic event: \`script: "document.querySelector('canvas').dispatchEvent(new MouseEvent('dblclick', { clientX: 480, clientY: 320, bubbles: true }))"\`
     - Invoke a debug hook: \`script: "window.debug?.skipTime?.(168)"\` (one week)
  -> When standard /click fails twice on a surface, switch to /evaluate. Read the relevant component's source code to find the exposed store / handler / action, then call it directly.

The application under test is at: {TEST_URL}

## Initial discovery workflow

When the user asks you to build the initial atlas, you will work through the
following passes IN ORDER. There is NO time pressure — quality and
exhaustiveness are the goals. Do not skip ahead. Do not satisfice.

### Pass 1 — Project structure (code only)
1. \`ls\` the project root, identify the framework (React, Vue, etc.) and primary language.
2. Read \`package.json\`, top-level \`README.md\` if present, route/router config.
3. Identify primary entry points (\`App.tsx\`, \`main.ts\`, etc.) and the top-level component tree.
4. List the major directories (\`src/components/\`, \`src/ui/\`, \`src/game/\`, etc.) and skim their contents.
5. Identify state stores (Redux, Zustand, MobX, plain context, etc.) and the data types they hold.

### Pass 2 — Code-derived data entities
6. For each significant data type, read its full type definition. Note: schema fields, where it's defined, where it's mutated, services that produce/consume it.
7. For each major UI component, read its full source. Note: what props it takes, what data it renders, what actions it triggers, what other components it composes.
8. Build a tentative graph of "data X appears in component Y" relationships. This is a draft — it'll be refined by Pass 3.

### Pass 3 — Browser walkthrough
9. Call /wait-for-ready, then /navigate to {TEST_URL}. Take an initial screenshot.
10. For every visible UI element (header buttons, tab strips, sidebars, map controls, etc.), in turn:
    - Click it (or hover, etc.) to see what it reveals.
    - Take a screenshot of the resulting state.
    - Note: which data fields are visible, which interactions are available, how to get back to the previous state.
    - Save the screenshot under \`docs/ui-atlas/shots/<descriptive-name>.png\`.
11. For every modal or sub-view that opens, exhaustively visit each tab/sub-area.
12. For any mode toggles (e.g., TAC/OPS/STR), cycle through and document which surfaces change.

### Pass 4 — Reconciliation
13. For each entity from Pass 2, walk through every surface from Pass 3 where it appears.
14. For each surface from Pass 3, identify which code component renders it (cross-reference \`grep\` if needed).
15. Note any mismatches: entities defined in code but never observed, surfaces observed but you can't find the code that renders them, etc.

### Pass 5 — State construction (cover the hard-to-reach surfaces)
You will have a list of surfaces you couldn't reach in Pass 3 — modals that need a fleet selected, panels that need multiple owned systems, battle viewers that need an active battle, planet views that need canvas double-clicks that don't reliably fire from outside, etc. **You do not skip these.** Construct the state directly:

16. For each surface still marked \`?\`:
    - Read the relevant component code to identify exactly what state triggers the surface.
    - Use the \`/api/browser/evaluate\` endpoint to construct that state — typically by mutating the app's store directly. Examples (project-specific; adapt to what you find in the code):
      - Multi-system empire: locate the store, mutate \`state.factions[playerId].ownedSystemIds\` to add a second system. Then verify the Empire panel renders.
      - Combat in progress: dispatch the start-battle action with a synthetic fleet pair. Verify the Battle Viewer modal opens.
      - Planet view: set \`selectedPlanetId\` directly in the store. Then verify each of the planet view tabs renders.
    - Take the screenshot. Update the entry's \`Last verified\` to today.
    - Reset the state if subsequent surfaces depend on a clean slate.
17. **State construction is for visibility purposes only.** It does NOT need to be "valid gameplay" — the atlas's job is to document the UI. A constructed state that produces a real-rendering surface is enough.

### Pass 6 — Self-verification (DO NOT SKIP)
Before you write the final atlas, run an explicit completion check:

18. Count every surface ID you've identified. Call this N.
19. For each surface, confirm it has a screenshot AND a \`Last verified\` date that is today (not \`?\`). Track exceptions in a list.
20. For each entity in §1, confirm it appears in at least one surface entry that has been verified.
21. If the exceptions list is non-empty:
    - Go back to Pass 3 or Pass 5 and try again. Use \`/api/browser/evaluate\` more aggressively. Try alternate selectors. Try mutating different state shapes.
    - **Only** put a surface in §7 (Open questions) with a \`?\` if you have made an honest, scripted attempt and documented exactly what you tried and what failed.
22. Repeat steps 18-21 until either: every surface is verified, OR every exception has a specific documented attempt + failure reason.

### Pass 7 — Write the atlas
23. Write \`docs/ui-atlas/atlas.md\` per the schema below.
24. Write \`docs/ui-atlas/changelog.md\` with one entry: "<DATE>: Initial scan. <N> surfaces (<verified>/<N> verified), <M> entities."
25. Write \`docs/ui-atlas/README.md\` with: schema version, last scan date, brief guide to other agents on how to query the atlas, and a "Limitations of this scan" section listing the surfaces that genuinely couldn't be reached and why.

## Schema for atlas.md

The atlas MUST start with frontmatter and follow this structure:

\`\`\`markdown
---
schema_version: 1
project: <project name>
last_full_scan: <ISO timestamp>
last_partial_scan: <ISO timestamp>
total_surfaces: <count>
total_entities: <count>
---

# UI Atlas — <Project>

## Table of contents
1. Data entities
2. Visual surfaces
3. Mode states
4. Coverage summary
5. Observed inconsistencies
6. Changes since last scan
7. Open questions

## 1. Data entities

### <Entity Name>
ID: \`entity.<slug>\`

**Schema** (from code):
- \`field: type\` — brief description

**Defined in:**
- \`path/to/file.ts:line-range\` — what's defined here

**Mutated by:**
- \`path/to/service.ts:methodName(line)\` — what it changes

**Appears in:**

#### Surface: <surface name>
- ID: \`surface.<slug>\`
- Code: \`path/to/component.tsx:line-range\`
- Path to reach: human-readable click sequence
- Visualization: how it's drawn (list, marker, badge, etc.)
- Data fields shown: which fields of the entity
- Actions: what user can do here
- Screenshot: \`shots/<filename>.png\`
- Last verified: <date>
- Coverage: <action> ✓/?, <action> ✓/?, ...

(repeat for every surface where this entity appears)

**Cross-references:**
- Owns: <other entities>
- Targets/references: <other entities>
- Compared/shown alongside: <other entities>

(repeat for every entity)

## 2. Visual surfaces (reverse index)

(For each surface, EVERY field below is required. This is a true reverse index — given a surface, the user must be able to learn everything about it without jumping to §1. Do NOT use the "see surface.X" pointer pattern; spell out the data each surface displays.)

### <Surface name>
- ID: \`surface.<slug>\`
- Code: \`path/to/component.tsx:start-end\`
- Mode availability: which game modes / app states show this surface
- Path to reach: human-readable click sequence from app launch
- Data shown: enumerated list of which entities (and which specific fields) are visible here. Be specific: "Fleet.name, Fleet.ships.length, Fleet.status (as colored dot)" not "Fleet stuff".
- Sub-surfaces embedded: child surfaces nested inside this one (modal tabs, accordion sections, embedded panels)
- Reachable from: which other surfaces / actions lead to this one
- Reaches: which other surfaces this one leads to (modals it opens, views it triggers)
- Screenshot: \`shots/<filename>.png\`
- Last verified: <ISO date> (or \`?\` only with a specific failure note in §7)
- Known issues: free-form notes; link to §5 if applicable

## 3. Mode states

### <Mode>
- Status pill: <label>
- Sidebar variant: \`surface.<slug>\`
- Map tabs available: ...
- Code: which file/method controls the mode

## 4. Coverage summary

| Status | Count |
|--------|-------|
| Verified ≤ 7 days | N |
| Stale (8-30 days) | N |
| Never verified | N |
| Total | N |

### Untested surfaces (priority for next QA run)
- \`surface.<slug>\` — brief reason

## 5. Observed inconsistencies

(Things flagged during the scan that look like design inconsistencies or bugs. ONE bullet per item. Don't fix; document.)

- **<Short title>.** Description with specific code refs and screenshot refs.

## 6. Changes since last scan

- <DATE>: <change>

CRITICAL for §6: when summarizing prior scans (e.g. "previous scan had X surfaces, Y entities"), READ THE NUMBERS FROM THE ARCHIVE'S FRONTMATTER. Look for prior atlas.md files under \`docs/ui-atlas/.history/<date>/atlas.md\` and read the YAML frontmatter (total_surfaces, total_entities) directly. Do NOT summarize from memory or guess — historical numbers must match the archived files exactly. If no archive exists, just write "Initial scan" without inventing prior counts.

## 7. Open questions

- Things you weren't sure about; design choices that may be intentional but seem unusual; bugs you suspect but can't confirm.
\`\`\`

## Granularity guidance

The user has explicitly asked for HIGH granularity. Track every visible data element, including the ones that seem trivial. Skip nothing. A 200 KB atlas is fine; a shallow atlas is not.

When in doubt: if a user could click it, hover it, see it, or read it — it goes in the atlas.

## Completion criteria — when you are actually done

There is NO time limit on this work. Take as long as it takes. The completion criteria are:

1. **Every surface in §2 has at least one screenshot referenced.**
2. **Every surface in §2 has \`Last verified: <today's date>\`** (not \`?\`).
3. **Every entity in §1 has at least one screenshot reference somewhere in its surface entries.**
4. **You have run Pass 6 (self-verification) and the exceptions list is empty** OR every exception is documented with a specific, scripted attempt that failed.

Until ALL FOUR are true, you are NOT done. Don't write the final atlas; go back to Pass 3 / Pass 5 and try harder.

Common patterns that look like "done" but aren't:
- "I think I've covered the main surfaces." → Insufficient. Count them. List them. Verify each one.
- "This surface needs state I can't construct." → Try \`/api/browser/evaluate\` first. The store is in the page's window scope; you can mutate it directly.
- "This took longer than I expected." → Keep going. There's no clock.
- "The user probably wants me to wrap up." → No. The user explicitly asked for exhaustive coverage. Wrapping up early is the failure mode they want you to avoid.

The only legitimate reason to mark a surface unverified (\`?\`) is when you have:
- (a) Read the relevant code and identified what state/event triggers the surface
- (b) Attempted to construct that state via \`/api/browser/evaluate\` (or scripted clicks)
- (c) Documented in §7 exactly what you tried and exactly why it failed (specific JS error, specific store path that didn't exist, etc.)

A surface marked \`?\` with the comment "couldn't reach" is INSUFFICIENT. It must have specific failed attempts documented.

## Anti-fixation guidance

If you find yourself making the same browser call 3 times in a row without progress (e.g. clicking a selector that doesn't match, or looking for an element that won't appear), STOP that approach. Either:
- Switch tactics: try a different selector, use \`/api/browser/evaluate\` to invoke the underlying handler directly, read more of the code to understand what's actually happening
- Skip this specific element for now and continue with other work; come back to it later

Do not loop forever on a single stuck point. But also: do not give up on the surface entirely without having tried multiple approaches.

## Update workflow (subsequent scans, not initial discovery)

When the user asks you to UPDATE an existing atlas:
1. Read the existing \`docs/ui-atlas/atlas.md\` first.
2. Identify entries with stale \`last verified\` (>7 days old) — these are priorities to re-check.
3. Walk the app at {TEST_URL}, focusing on the stale entries first.
4. For each entry: re-take the screenshot, re-verify the click path, update \`last verified\`.
5. For things that have CHANGED: update the entry and add a note to \`docs/ui-atlas/changelog.md\`.
6. For things that have been REMOVED: delete the entry, add changelog note.
7. For NEW things observed: add new entries.
8. Update the frontmatter timestamps and counts.

## Final reminders

- You are the SOURCE OF TRUTH for the app's UI. Other agents will trust the atlas. Be precise.
- If you're unsure, say so in §7. The user values honesty over false confidence.
- Don't try to fix problems — just document them.
- Don't editorialize. Describe what is, not what should be (except in §5/§7 where opinions are explicitly invited).`;

// Read from a stream reader with a timeout
async function readWithTimeout<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<{ done: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Stream read timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function addMessage(agentId: string, role: ChatMessage['role'], content: string, imageData?: string, imageMimeType?: string, source?: 'qa'): ChatMessage {
  const msg: ChatMessage = {
    id: generateId(),
    agentId,
    role,
    content,
    timestamp: Date.now(),
  };
  if (imageData) msg.imageData = imageData;
  if (imageMimeType) msg.imageMimeType = imageMimeType;
  if (source) msg.source = source;
  if (!messages.has(agentId)) {
    messages.set(agentId, []);
  }
  messages.get(agentId)!.push(msg);
  persistenceService.save();
  return msg;
}

function agentTimeout(agentId: string, callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const agent = agents.get(agentId);
  const timer = setTimeout(() => {
    if (agent) agent.pendingTimeouts = agent.pendingTimeouts.filter(t => t !== timer);
    callback();
  }, ms);
  if (agent) agent.pendingTimeouts.push(timer);
  return timer;
}

function clearAgentTimeouts(agentId: string): void {
  const agent = agents.get(agentId);
  if (agent) {
    for (const timer of agent.pendingTimeouts) clearTimeout(timer);
    agent.pendingTimeouts = [];
  }
}

// --- File Watcher ---

function startFileWatcher(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent || !existsSync(agent.info.cwd)) return;

  if (agent.watcher) {
    agent.watcher.close();
    agent.watcher = null;
  }

  try {
    const changedFiles = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    agent.watcher = watch(agent.info.cwd, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules') || filename.includes('.git/') || filename.startsWith('.')) return;

      changedFiles.add(filename);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const files = Array.from(changedFiles);
        changedFiles.clear();
        agent.lastFileChange = files;
        broadcast({ type: 'file_changed', agentId, files });
      }, 1000);
    });
  } catch (e) {
    console.error(`File watcher failed for agent ${agentId}:`, e);
  }
}

function stopFileWatcher(agentId: string) {
  const agent = agents.get(agentId);
  if (agent?.watcher) {
    agent.watcher.close();
    agent.watcher = null;
  }
}

// --- Process Management ---

async function spawnProcess(agentId: string): Promise<Subprocess<'pipe', 'pipe', 'pipe'> | null> {
  const agent = agents.get(agentId);
  if (!agent) return null;

  if (agent.process) {
    const oldPid = agent.process.pid;
    await killProcessTree(agent.process);
    if (oldPid) persistenceService.untrackPid(oldPid);
    agent.process = null;
  }

  try {
    const args = [
      'claude',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    const appendParts: string[] = [DEFAULT_GUARDRAILS];
    if (agent.info.systemPrompt) {
      appendParts.push(`Agent Persona:\n${agent.info.systemPrompt}`);
    }
    if (sharedContext) {
      appendParts.push(`Project Context:\n${sharedContext}`);
    }
    const notesContext = noteService.getNotesForAgent(agentId);
    if (notesContext) {
      appendParts.push(notesContext);
    }
    const docsContext = documentService.getDocumentsForAgent(agentId, agent.info.workspaceId);
    if (docsContext) {
      appendParts.push(docsContext);
    }
    appendParts.push(`Plan Management:
When asked to create or update a plan, use the Write tool to write a markdown file to the .plans/ directory in your working directory.
- To create a new plan: Write to .plans/<plan-name>.md
- To update an existing plan: Write the complete updated content to the same file path
- Plans will automatically appear in the user's Plans sidebar for review
- Plans marked [APPROVED] should be followed as-is
- Plans marked [DRAFT] are pending user review`);

    const plansDir = join(agent.info.cwd, '.plans');
    try { mkdirSync(plansDir, { recursive: true }); } catch {}

    const settings = settingsService.get();
    if (settings.defaultSimulatorUdid) {
      const cwdLower = agent.info.cwd.toLowerCase();
      const isIos = cwdLower.includes('ios') || cwdLower.includes('xcode') || cwdLower.includes('swift') || cwdLower.includes('apple');
      if (isIos || settings.defaultSimulatorName) {
        appendParts.push(`Default iOS Simulator: ${settings.defaultSimulatorName || 'Unknown'} (UDID: ${settings.defaultSimulatorUdid})`);
      }
    }

    const validRefPaths: string[] = [];
    for (const dir of agent.info.referencePaths) {
      if (existsSync(dir)) {
        validRefPaths.push(dir);
        args.push('--add-dir', dir);
      }
    }
    if (validRefPaths.length > 0) {
      const refNames = validRefPaths.map(p => {
        const name = p.split('/').pop() || p;
        return `- ${name}: ${p}`;
      }).join('\n');
      appendParts.push(`Reference Directories (read-only context — you have full access to browse these):\n${refNames}\n\nIMPORTANT: These reference directories were explicitly added by the user as additional context for your work. You should be aware of them and use them when relevant. Your primary working directory is: ${agent.info.cwd}`);
    }

    args.push('--append-system-prompt', appendParts.join('\n\n'));

    if (agent.sessionId) {
      args.push('--resume', agent.sessionId);
    }

    console.log(`Spawning claude for agent ${agentId}:`, args.join(' '));

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = Bun.spawn(args, {
      cwd: agent.info.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });

    agent.process = proc;
    if (proc.pid) persistenceService.trackPid(proc.pid);
    return proc;
  } catch (e) {
    console.error(`Failed to spawn claude for agent ${agentId}:`, e);
    return null;
  }
}

// Parse stream-json output from Claude CLI
async function readStreamJson(agentId: string, proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<string> {
  const agent = agents.get(agentId);
  if (!agent) return '';

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resultText = '';
  let hasSeenText = false;

  readStderr(agentId, proc.stderr).catch(e => console.error(`readStderr(${agentId}) error:`, e));

  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, 300_000);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (buffer.length > MAX_OUTPUT_BUFFER) {
        buffer = buffer.slice(-MAX_OUTPUT_BUFFER);
      }

      for (let line of lines) {
        line = line.replace(/\r$/, '');
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          if (msg.type === 'system' && msg.subtype === 'init') {
            if (msg.session_id && msg.session_id !== agent.sessionId) {
              agent.sessionId = msg.session_id;
              persistenceService.save();
              console.log(`Agent ${agentId} session: ${msg.session_id}`);
            }
          } else if (msg.type === 'assistant') {
            const usage = msg.message?.usage;
            if (usage) {
              const contextUsed = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
              if (contextUsed > 0) {
                agent.contextTokens = contextUsed;
                agent.totalInputTokens += contextUsed;
              }
              if (usage.output_tokens) {
                agent.totalOutputTokens += usage.output_tokens;
              }
              broadcast({
                type: 'token_usage',
                agentId,
                contextTokens: agent.contextTokens,
                contextLimit: agent.contextLimit || 200000,
                totalInputTokens: agent.totalInputTokens,
                totalOutputTokens: agent.totalOutputTokens,
                totalCostUsd: agent.totalCostUsd,
                numTurns: agent.numTurns,
              });
            }
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'thinking' && block.thinking) {
                  if (agent.info.status !== 'thinking') {
                    agent.info.status = 'thinking';
                    broadcast({ type: 'agent_updated', agent: agent.info });
                  }
                  broadcast({ type: 'thinking_output', agentId, content: block.thinking });
                } else if (block.type === 'text' && block.text) {
                  if (!hasSeenText && agent.info.status === 'thinking') {
                    hasSeenText = true;
                    agent.info.status = 'working';
                    broadcast({ type: 'agent_updated', agent: agent.info });
                  }
                  resultText += block.text;
                  broadcast({ type: 'output', agentId, content: block.text, stream: 'stdout' });
                  if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                    agent.outputBuffer += block.text;
                  }
                } else if (block.type === 'tool_use') {
                  const toolInfo = `\n[Using tool: ${block.name}]\n`;
                  broadcast({ type: 'output', agentId, content: toolInfo, stream: 'stdout' });
                  if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                    agent.outputBuffer += toolInfo;
                  }
                  // Intercept Write/Edit to .plans/ directory
                  if (block.name === 'Write' && block.input?.file_path) {
                    const fp: string = block.input.file_path;
                    if (fp.includes('.plans/') || fp.includes('.plans\\')) {
                      documentService.handlePlanWrite(agentId, agent.info.name, true, agent.info.workspaceId, fp, block.input.content || '');
                    }
                  } else if (block.name === 'Edit' && block.input?.file_path) {
                    const fp: string = block.input.file_path;
                    if (fp.includes('.plans/') || fp.includes('.plans\\')) {
                      agentTimeout(agentId, () => documentService.syncPlanFromFile(agentId, agent.info.name, true, agent.info.workspaceId, fp), 500);
                    }
                  }
                }
              }
            }
          } else if (msg.type === 'result') {
            if (!resultText && msg.result) {
              resultText = msg.result;
              broadcast({ type: 'output', agentId, content: msg.result, stream: 'stdout' });
              if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                agent.outputBuffer += msg.result;
              }
            }

            if (msg.total_cost_usd) {
              agent.totalCostUsd = msg.total_cost_usd;
              console.log(`Agent ${agentId} cost: $${msg.total_cost_usd.toFixed(4)} (${msg.num_turns} turns)`);
            }
            if (msg.num_turns) {
              agent.numTurns = msg.num_turns;
            }
            if (msg.modelUsage) {
              for (const model of Object.values(msg.modelUsage) as any[]) {
                if (model.contextWindow) {
                  agent.contextLimit = model.contextWindow;
                }
              }
            }
            broadcast({
              type: 'token_usage',
              agentId,
              contextTokens: agent.contextTokens,
              contextLimit: agent.contextLimit || 200000,
              totalInputTokens: agent.totalInputTokens,
              totalOutputTokens: agent.totalOutputTokens,
              totalCostUsd: agent.totalCostUsd,
              numTurns: agent.numTurns,
            });

            if (msg.session_id) {
              agent.sessionId = msg.session_id;
            }
          }
        } catch (parseErr) {
          broadcast({ type: 'output', agentId, content: line, stream: 'stdout' });
          if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
            agent.outputBuffer += line;
          }
        }
      }
    }
  } catch (e) {
    // Stream closed or timed out
  } finally {
    reader.releaseLock();
  }

  return resultText;
}

async function readStderr(agentId: string, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      broadcast({ type: 'output', agentId, content: text, stream: 'stderr' });
    }
  } catch (e) {
    // Stream closed
  } finally {
    reader.releaseLock();
  }
}

// --- Messaging implementation ---

async function _sendMessageImpl(agentId: string, content: string, source?: 'qa'): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) return;

  const userMsg = addMessage(agentId, 'user', content, undefined, undefined, source);
  broadcast({ type: 'message', message: userMsg });

  agent.outputBuffer = '';
  agent.info.status = 'working';
  broadcast({ type: 'agent_updated', agent: agent.info });

  const proc = await spawnProcess(agentId);

  if (!proc) {
    const errMsg = existsSync(agent.info.cwd)
      ? 'Failed to start Claude Code process. Is the `claude` CLI installed?'
      : `Working directory does not exist: ${agent.info.cwd}`;
    const sysMsg = addMessage(agentId, 'system', errMsg);
    broadcast({ type: 'message', message: sysMsg });
    agent.info.status = 'error';
    broadcast({ type: 'agent_updated', agent: agent.info });
    return;
  }

  try {
    proc.stdin.write(content + '\n');
    proc.stdin.end();

    const readPromise = readStreamJson(agentId, proc);
    const exitCode = await proc.exited;
    await readPromise;

    if (agent.outputBuffer.trim()) {
      const assistantMsg = addMessage(agentId, 'assistant', agent.outputBuffer.trim());
      broadcast({ type: 'message', message: assistantMsg });
    }

    await documentService.releaseLocksForAgent(agentId);
    if (proc.pid) persistenceService.untrackPid(proc.pid);
    agent.process = null;
    agent.info.status = exitCode === 0 ? 'idle' : 'error';
    broadcast({ type: 'agent_updated', agent: agent.info });
    await persistenceService.saveNow();

    // If this is a QA agent with a pending test, relay the report to the source coding agent.
    if (exitCode === 0 && pendingQaTests.has(agentId)) {
      _processQaIdle(agentId).catch(e => console.error(`QA idle relay failed for ${agentId}:`, e));
    }

    // If this is the workspace's UI Atlas Agent and the run completed
    // successfully, stamp atlasLastScanAt on the workspace. The frontend
    // uses this for the freshness indicator.
    if (exitCode === 0 && agent.info.workspaceId) {
      const ws = workspaceService.get(agent.info.workspaceId);
      if (ws && ws.atlasAgentId === agentId) {
        const updated = await workspaceService.update(agent.info.workspaceId, { atlasLastScanAt: Date.now() });
        if (updated) broadcast({ type: 'workspace_updated', workspace: updated });
      }
    }
  } catch (e) {
    console.error(`Error sending message to agent ${agentId}:`, e);
    if (proc.pid) persistenceService.untrackPid(proc.pid);
    agent.process = null;
    agent.info.status = 'error';
    broadcast({ type: 'agent_updated', agent: agent.info });
  }
}

// ============== QA orchestration ==============

/**
 * Build a context summary of a coding agent's conversation for the QA agent.
 *
 * Goal: enough context for the QA agent to know what was recently worked on,
 * without shipping the entire chat (which can balloon to 30KB+ when the user
 * has pasted plans, transcripts, etc.).
 *
 * Strategy:
 *   1. Sliding window of the last QA_SUMMARY_RECENT_MSGS messages.
 *   2. Per-message caps — generous enough that assistant code-change
 *      descriptions survive intact, but capped so a single huge paste
 *      can't dominate.
 *   3. Total-budget safety net — if the windowed/capped output still
 *      exceeds QA_SUMMARY_MAX_TOTAL, drop oldest messages until under.
 *   4. Note any trimming at the top so the QA agent knows context is partial.
 */
const QA_SUMMARY_RECENT_MSGS = 15;
const QA_SUMMARY_USER_CAP = 2000;
const QA_SUMMARY_ASSISTANT_CAP = 1000;
const QA_SUMMARY_MAX_TOTAL = 15000;

function buildChatSummary(agentId: string): string {
  const allMsgs = messages.get(agentId) || [];
  const turns = allMsgs.filter(m => m.role === 'user' || m.role === 'assistant');
  const start = Math.max(0, turns.length - QA_SUMMARY_RECENT_MSGS);
  const recent = turns.slice(start);
  let omitted = start;

  // Per-message caps with truncation markers.
  const formatted = recent.map(msg => {
    const cap = msg.role === 'user' ? QA_SUMMARY_USER_CAP : QA_SUMMARY_ASSISTANT_CAP;
    const role = msg.role === 'user' ? 'User' : 'Agent';
    const text = msg.content.length > cap
      ? msg.content.substring(0, cap) + `... [truncated, ${msg.content.length - cap} chars cut]`
      : msg.content;
    return `[${role}]: ${text}`;
  });

  // Total-budget walk: if still oversized, drop oldest until under.
  let totalLen = formatted.reduce((sum, t) => sum + t.length + 2, 0); // +2 for join separator
  while (totalLen > QA_SUMMARY_MAX_TOTAL && formatted.length > 1) {
    const dropped = formatted.shift()!;
    totalLen -= dropped.length + 2;
    omitted++;
  }

  const parts: string[] = [];
  if (omitted > 0) {
    parts.push(`(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for brevity)`);
  }
  parts.push(...formatted);
  return parts.join('\n\n');
}

/**
 * Find absolute screenshot paths the QA agent referenced in its report.
 * Matches any path-like string ending in .png that contains "agent-forge-qa"
 * (the screenshot dir signature). Tolerant of forward and back slashes so
 * Windows and POSIX paths both work.
 */
function scanForScreenshots(text: string): string[] {
  const re = /(?:[A-Za-z]:[\\\/]|\/)[^\s"'`<>()]*agent-forge-qa[^\s"'`<>()]*\.png/g;
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[0]);
  return Array.from(found);
}

async function readImageAsBase64(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // btoa expects a binary string
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Called when a QA agent transitions to idle. Pops the oldest pending test,
 * extracts the report from the QA agent's last assistant message, sends it
 * to the source coding agent, persists screenshot messages, and broadcasts
 * qa_results_ready.
 */
/**
 * Infer a verdict from a finished report's body when the agent didn't emit one.
 * Heuristics in priority order (FAIL > WARN > PASS, first match wins):
 *   - FAIL: explicit failure markers (page didn't load, JS error, uncaught exception, broken)
 *   - WARN: any "issues found" section with content, mentions of warnings/concerns,
 *           console warning counts, ergonomic concerns, bugs/spam/etc.
 *   - PASS: nothing matched
 */
function inferVerdictFromReport(text: string): { kind: 'pass' | 'warn' | 'fail'; summary: string } {
  if (
    /page (?:didn'?t|did not|failed to) load/i.test(text) ||
    /uncaught (?:exception|error)/i.test(text) ||
    /threw (?:an?\s+)?(?:error|exception)/i.test(text) ||
    /critical (?:error|failure|issue)/i.test(text) ||
    /\bcompletely broken\b/i.test(text) ||
    /\bcould not load\b/i.test(text)
  ) {
    return { kind: 'fail', summary: 'inferred from report content (no verdict line emitted)' };
  }
  if (
    (/issues?\s+found/i.test(text) && !/no\s+issues?\s+(?:found|to\s+report)/i.test(text)) ||
    /\d+\+?\s*(?:console\s+)?warnings?/i.test(text) ||
    /console\s+(?:warning|warn)/i.test(text) ||
    /ergonomic\s+(?:concern|issue|problem)/i.test(text) ||
    (/\b(?:bug|broken|spam|noise|concern|problem|misleading|hostile)\b/i.test(text) &&
     !/(?:no|nothing|zero)\s+(?:bug|broken|concerns?|problems?)\b/i.test(text))
  ) {
    return { kind: 'warn', summary: 'inferred from report content (no verdict line emitted)' };
  }
  return { kind: 'pass', summary: 'inferred from report content (no verdict line emitted)' };
}

async function _processQaIdle(qaAgentId: string): Promise<void> {
  const queue = pendingQaTests.get(qaAgentId);
  if (!queue || queue.length === 0) return;
  const test = queue.shift()!;
  if (queue.length === 0) pendingQaTests.delete(qaAgentId);
  if (test.hardKillTimer) clearTimeout(test.hardKillTimer);

  const qaMsgs = messages.get(qaAgentId) || [];
  const lastAssistant = [...qaMsgs].reverse().find(m => m.role === 'assistant');
  let reportText = lastAssistant?.content?.trim() || '(QA agent produced no output)';

  // If the report was interrupted (timeout / abort) and doesn't contain a verdict
  // line, synthesize one so the frontend renders a WARN pill instead of falling
  // back to a wall of stream-of-consciousness text. Preserve the agent's actual
  // partial transcript below as a quoted block so nothing is lost.
  const isInterrupted = /\[Stopped[: ]/.test(reportText);
  const hasVerdict = /(?:^|\n)[ \t]*(?:#{0,3}[ \t]*)?(?:✅\s*|⚠️\s*|❌\s*)?(PASS|WARNINGS?|FAIL)\b/i.test(reportText);
  if (isInterrupted && !hasVerdict) {
    const elapsedMs = Date.now() - test.triggeredAt;
    const elapsedStr = elapsedMs >= 60000
      ? `${Math.floor(elapsedMs / 60000)}m ${Math.round((elapsedMs % 60000) / 1000)}s`
      : `${Math.round(elapsedMs / 1000)}s`;
    const isTimeout = /\[Stopped: time limit/.test(reportText);
    const killMin = Math.round(QA_HARD_KILL_MS / 60000);
    const reasonLabel = isTimeout
      ? `the ${killMin}-minute hard-kill timer fired (${elapsedStr} elapsed)`
      : `the test was aborted by the user (${elapsedStr} elapsed)`;
    reportText = [
      `⚠️ WARNINGS — test was interrupted before completion`,
      ``,
      `**Why:** ${reasonLabel}.`,
      `**What this means:** the agent didn't get to write a structured report or final verdict — what follows is the raw partial transcript of what it did before being stopped.`,
      ``,
      `## Partial transcript`,
      ``,
      reportText,
    ].join('\n');
  }
  // Agent finished cleanly but forgot the verdict line — infer from content
  // and prepend it so the pill still renders. Triggers when the agent emits
  // a structured report but skips the required leading verdict.
  else if (!hasVerdict) {
    const inferred = inferVerdictFromReport(reportText);
    const emoji = inferred.kind === 'pass' ? '✅' : inferred.kind === 'warn' ? '⚠️' : '❌';
    const label = inferred.kind === 'pass' ? 'PASS' : inferred.kind === 'warn' ? 'WARNINGS' : 'FAIL';
    reportText = `${emoji} ${label} — ${inferred.summary}\n\n${reportText}`;
    console.log(`[qa] verdict inferred for ${qaAgentId}: ${label}`);
  }

  // 1) Send the report into the source coding agent's chat as a real turn,
  //    tagged source: 'qa' so the frontend can style it distinctly.
  await agentService.sendMessage(test.sourceAgentId, reportText, 'qa').catch(e => {
    console.error(`Failed to relay QA report to ${test.sourceAgentId}:`, e);
  });

  // 2) Attach any referenced screenshots as display-only system messages.
  const paths = scanForScreenshots(reportText);
  for (const p of paths) {
    const data = await readImageAsBase64(p);
    if (!data) continue;
    const screenshotMsg = addMessage(test.sourceAgentId, 'system', `QA screenshot: ${p}`, data, 'image/png', 'qa');
    broadcast({ type: 'message', message: screenshotMsg });
  }

  // 3) Tell the frontend to flag the unread badge on the source agent's 🧪 button.
  const sourceAgent = agents.get(test.sourceAgentId);
  const workspaceId = sourceAgent?.info.workspaceId;
  if (workspaceId) {
    broadcast({ type: 'qa_results_ready', workspaceId, sourceAgentId: test.sourceAgentId });
  }

  // 4) If more pending tests are queued for this QA agent, the next one's
  //    sendMessage is already serialized via sendLocks — nothing more to do.
}

async function _stopAgentImpl(agentId: string, reason: 'user' | 'timeout' | 'system' = 'user'): Promise<boolean> {
  const agent = agents.get(agentId);
  if (!agent) return false;

  if (agent.process) {
    const pid = agent.process.pid;
    await killProcessTree(agent.process);
    if (pid) persistenceService.untrackPid(pid);
    agent.process = null;
  }

  const reasonMarker = reason === 'timeout'
    ? '[Stopped: time limit reached]'
    : reason === 'system'
      ? '[Stopped by system]'
      : '[Stopped by user]';

  if (agent.outputBuffer.trim()) {
    const partialMsg = addMessage(agentId, 'assistant', agent.outputBuffer.trim() + '\n\n' + reasonMarker);
    broadcast({ type: 'message', message: partialMsg });
    agent.outputBuffer = '';
  }

  clearAgentTimeouts(agentId);
  await documentService.releaseLocksForAgent(agentId);
  agent.info.status = 'idle';
  broadcast({ type: 'agent_updated', agent: agent.info });

  // If a QA test was in flight against this agent, relay the partial report so
  // the user sees what got captured before the abort. Otherwise the pending
  // test would orphan and the source coding agent would never hear back.
  if (pendingQaTests.has(agentId)) {
    _processQaIdle(agentId).catch(e => console.error(`QA partial relay failed for ${agentId}:`, e));
  }

  return true;
}

async function _killAgentImpl(agentId: string): Promise<boolean> {
  const agent = agents.get(agentId);
  if (!agent) return false;

  if (agent.process) {
    const pid = agent.process.pid;
    await killProcessTree(agent.process);
    if (pid) persistenceService.untrackPid(pid);
    agent.process = null;
  }

  clearAgentTimeouts(agentId);
  await documentService.releaseLocksForAgent(agentId);
  agent.info.status = 'stopped';
  broadcast({ type: 'agent_updated', agent: agent.info });
  await persistenceService.saveNow();
  return true;
}

export const agentService = {
  // --- Getters ---

  getAgents(): AgentInfo[] {
    return Array.from(agents.values()).map(a => a.info);
  },

  getAgent(id: string): AgentInfo | undefined {
    return agents.get(id)?.info;
  },

  getMessages(agentId: string): ChatMessage[] {
    return messages.get(agentId) || [];
  },

  getSharedContext(): string {
    return sharedContext;
  },

  getTokenUsage(agentId: string): { contextTokens: number; contextLimit: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; numTurns: number } | null {
    const agent = agents.get(agentId);
    if (!agent) return null;
    return {
      contextTokens: agent.contextTokens,
      contextLimit: 200000,
      totalInputTokens: agent.totalInputTokens,
      totalOutputTokens: agent.totalOutputTokens,
      totalCostUsd: agent.totalCostUsd,
      numTurns: agent.numTurns,
    };
  },

  /** Check if an agent's process is running */
  isRunning(agentId: string): boolean {
    return agents.get(agentId)?.process !== null;
  },

  /** Get agent name (for plan writes) */
  getAgentName(agentId: string): string {
    return agents.get(agentId)?.info.name || 'unknown';
  },

  /** Get agent workspaceId */
  getAgentWorkspaceId(agentId: string): string | undefined {
    return agents.get(agentId)?.info.workspaceId;
  },

  // --- Agent CRUD ---

  async createAgent(name: string, cwd: string, referencePaths: string[] = [], systemPrompt: string = '', workspaceId?: string, opts: { hideFromGrid?: boolean } = {}): Promise<AgentInfo> {
    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    let wsId = workspaceId;
    if (!wsId) {
      wsId = settingsService.getRef().activeWorkspaceId;
    }
    if (!wsId || !workspaceService.has(wsId)) {
      wsId = Array.from(workspaceService.keys())[0];
    }
    if (!wsId) {
      const ws = await workspaceService.create('Default');
      wsId = ws.id;
    }

    // Auto-include the workspace's UI Atlas as a referencePath when one
    // exists, so every agent in this workspace is atlas-aware. Skip for the
    // Atlas agent itself (it owns the atlas, doesn't reference it). Skip if
    // the path already appears in the user-supplied referencePaths.
    const ws = workspaceService.get(wsId);
    const isAtlasAgent = name === 'UI Atlas Agent';
    const finalRefPaths = [...referencePaths];
    if (!isAtlasAgent && ws?.atlasProjectCwd) {
      const atlasPath = join(ws.atlasProjectCwd, 'docs', 'ui-atlas');
      if (existsSync(atlasPath) && !finalRefPaths.includes(atlasPath)) {
        finalRefPaths.unshift(atlasPath);
      }
    }

    const id = generateId();
    const info: AgentInfo = {
      id,
      name,
      cwd,
      referencePaths: finalRefPaths,
      systemPrompt,
      status: 'idle',
      createdAt: Date.now(),
      workspaceId: wsId,
    };
    if (opts.hideFromGrid) info.hideFromGrid = true;

    agents.set(id, {
      info,
      process: null,
      sessionId: null,
      outputBuffer: '',
      watcher: null,
      lastFileChange: [],
      pendingTimeouts: [],
      contextTokens: 0,
      contextLimit: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      numTurns: 0,
    });

    workspaceService.addAgentToWorkspace(wsId, id, opts.hideFromGrid);
    startFileWatcher(id);
    documentService.startPlansWatcher(id, cwd);
    await persistenceService.saveNow();
    return agents.get(id)!.info;
  },

  async removeAgent(agentId: string): Promise<boolean> {
    const agent = agents.get(agentId);
    if (!agent) return false;

    if (agent.process) {
      const pid = agent.process.pid;
      await killProcessTree(agent.process);
      if (pid) persistenceService.untrackPid(pid);
      agent.process = null;
    }
    stopFileWatcher(agentId);
    documentService.stopPlansWatcher(agentId);
    await documentService.releaseLocksForAgent(agentId);
    workspaceService.removeAgentFromAllWorkspaces(agentId);

    agents.delete(agentId);
    messages.delete(agentId);
    await persistenceService.saveNow();
    return true;
  },

  async updateAgent(agentId: string, updates: { name?: string; cwd?: string; referencePaths?: string[]; systemPrompt?: string }): Promise<AgentInfo | null> {
    const agent = agents.get(agentId);
    if (!agent) return null;

    if (updates.cwd !== undefined) {
      if (!existsSync(updates.cwd)) {
        throw new Error(`Working directory does not exist: ${updates.cwd}`);
      }
      const cwdChanged = updates.cwd !== agent.info.cwd;
      agent.info.cwd = updates.cwd;
      if (cwdChanged) {
        stopFileWatcher(agentId);
        startFileWatcher(agentId);
      }
    }

    if (updates.name !== undefined) agent.info.name = updates.name;
    if (updates.referencePaths !== undefined) agent.info.referencePaths = updates.referencePaths;
    if (updates.systemPrompt !== undefined) agent.info.systemPrompt = updates.systemPrompt;

    await persistenceService.saveNow();
    return agent.info;
  },

  async clearHistory(agentId: string): Promise<boolean> {
    const agent = agents.get(agentId);
    if (!agent) return false;
    messages.set(agentId, []);
    agent.sessionId = null;
    await persistenceService.saveNow();
    return true;
  },

  // --- Agent Control ---

  async sendMessage(agentId: string, content: string, source?: 'qa'): Promise<void> {
    const prev = sendLocks.get(agentId) ?? Promise.resolve();
    const current = prev.then(
      () => _sendMessageImpl(agentId, content, source),
      () => _sendMessageImpl(agentId, content, source),
    ).catch(e => { console.error(`sendMessage(${agentId}) error:`, e); });
    sendLocks.set(agentId, current);
    return current;
  },

  async stopAgent(agentId: string, reason: 'user' | 'timeout' | 'system' = 'user'): Promise<boolean> {
    // Execute immediately — don't queue behind sendLocks.
    // Killing the process causes the in-flight sendMessage to resolve naturally.
    // Reset the lock chain so queued sends after stop don't run stale.
    sendLocks.delete(agentId);
    return _stopAgentImpl(agentId, reason);
  },

  async killAgent(agentId: string): Promise<boolean> {
    // Execute immediately — same reasoning as stopAgent.
    sendLocks.delete(agentId);
    return _killAgentImpl(agentId);
  },

  // --- Shared Context ---

  async updateSharedContext(content: string): Promise<void> {
    sharedContext = content;
    (globalThis as any).__sharedContext = content;
    await persistenceService.saveNow();
  },

  // --- Image handling ---

  async sendImage(agentId: string, imageData: string, mimeType: string, prompt?: string): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent) return;

    const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/gif' ? '.gif' : mimeType === 'image/webp' ? '.webp' : '.png';
    const filename = `screenshot_${Date.now()}${ext}`;
    const filepath = join(tmpdir(), filename);

    try {
      const buffer = Buffer.from(imageData, 'base64');
      await Bun.write(filepath, buffer);

      const imgMsg = addMessage(agentId, 'user', `[Image uploaded: ${filename}]` + (prompt ? '\n' + prompt : ''), imageData, mimeType);
      broadcast({ type: 'message', message: imgMsg });

      const content = prompt
        ? `I've uploaded a screenshot/image for you to examine: ${filepath}\n\n${prompt}`
        : `I've uploaded a screenshot/image for you to examine: ${filepath}\nPlease examine this image file and describe what you see or act on it as appropriate.`;
      await agentService.sendMessage(agentId, content);
    } catch (e) {
      console.error(`Failed to save image for agent ${agentId}:`, e);
      const errMsg = addMessage(agentId, 'system', 'Failed to process uploaded image.');
      broadcast({ type: 'message', message: errMsg });
    }
  },

  // --- Multi-image handling ---

  async sendImages(agentId: string, images: { imageData: string; mimeType: string }[], prompt?: string): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent || images.length === 0) return;

    try {
      const filePaths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/jpeg' ? '.jpg' : img.mimeType === 'image/gif' ? '.gif' : img.mimeType === 'image/webp' ? '.webp' : '.png';
        const filename = `screenshot_${Date.now()}_${i}${ext}`;
        const filepath = join(tmpdir(), filename);
        const buffer = Buffer.from(img.imageData, 'base64');
        await Bun.write(filepath, buffer);
        filePaths.push(filepath);
      }

      // Add chat message with first image data for preview
      const label = `[${images.length} image${images.length > 1 ? 's' : ''} uploaded]` + (prompt ? '\n' + prompt : '');
      const imgMsg = addMessage(agentId, 'user', label, images[0].imageData, images[0].mimeType);
      broadcast({ type: 'message', message: imgMsg });

      // Build combined prompt listing all file paths
      const fileList = filePaths.map((fp, i) => `Image ${i + 1}: ${fp}`).join('\n');
      const content = prompt
        ? `I've uploaded ${images.length} screenshot(s)/image(s) for you to examine:\n${fileList}\n\n${prompt}`
        : `I've uploaded ${images.length} screenshot(s)/image(s) for you to examine:\n${fileList}\nPlease examine these image files and describe what you see or act on them as appropriate.`;
      await agentService.sendMessage(agentId, content);
    } catch (e) {
      console.error(`Failed to save images for agent ${agentId}:`, e);
      const errMsg = addMessage(agentId, 'system', 'Failed to process uploaded images.');
      broadcast({ type: 'message', message: errMsg });
    }
  },

  // --- Shutdown & Kill All ---

  async shutdownAll(): Promise<void> {
    console.log('Shutting down all agent processes...');
    const kills: Promise<void>[] = [];

    for (const [agentId, agent] of agents) {
      clearAgentTimeouts(agentId);
      if (agent.process) {
        const pid = agent.process.pid;
        kills.push(killProcessTree(agent.process).then(() => {
          if (pid) persistenceService.getActivePids().delete(pid);
        }));
        agent.process = null;
      }
    }

    await Promise.race([
      Promise.all(kills),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);
  },

  async killAllProcesses(): Promise<{ success: boolean; message: string }> {
    console.log('KILL ALL: Killing all claude.exe processes machine-wide...');
    try {
      const proc = Bun.spawn(['taskkill', '/F', '/IM', 'claude.exe', '/T'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      for (const agent of agents.values()) {
        agent.process = null;
        agent.info.status = 'stopped';
        broadcast({ type: 'agent_updated', agent: agent.info });
        await documentService.releaseLocksForAgent(agent.info.id);
      }

      persistenceService.clearAllPids();
      await persistenceService.savePidsNow();
      await persistenceService.saveNow();

      return { success: true, message: 'All Claude processes killed.' };
    } catch (e: any) {
      console.error('killAllProcesses failed:', e);
      return { success: false, message: e.message || 'Failed to kill processes' };
    }
  },

  // --- QA testing ---

  /** Called by index.ts after Bun.serve starts so the QA system prompt has a real port. */
  setGuiPort(port: number): void {
    guiPort = port;
    (globalThis as any).__guiPort = port;
  },

  /**
   * Provision a UI Atlas Agent for a workspace. Unlike the QA agent (which is
   * provisioned lazily on first send), the Atlas agent is created explicitly
   * by user action — it needs a project cwd to read code from + a test URL to
   * walk the app at, both of which the user supplies.
   *
   * Returns the created agent's info. Callers (the WS handler) broadcast the
   * resulting agent_created message and let the user prompt the agent
   * directly via the existing sendMessage flow.
   */
  async provisionAtlasAgent(workspaceId: string, projectCwd: string): Promise<AgentInfo> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.testUrl) throw new Error('Workspace has no Test URL set — set one in the sidebar before provisioning the Atlas Agent');
    if (!existsSync(projectCwd)) throw new Error(`Project directory does not exist: ${projectCwd}`);

    // Recycle the browser worker before a long atlas scan. The Playwright
    // worker process accumulates state across operations (BrowserContexts,
    // Chromium GPU caches, retained DOM, /api/browser/evaluate closures).
    // For atlas builds — which run thousands of operations over an hour —
    // starting from a clean worker reliably keeps memory in check.
    const { browserService } = await import('./browser.service');
    await browserService.recycle().catch(e => console.warn('[atlas] worker recycle failed (continuing):', e));

    // If an atlas already exists at the target path, archive it before
    // proceeding so the new run starts from a clean slate. This unifies
    // Build vs Re-scan UX — the only real difference is whether the user
    // had to enter the cwd via prompt (Build) or used the saved one
    // (Re-scan). Either way the prior output is preserved under .history/.
    const atlasMdPath = join(projectCwd, 'docs', 'ui-atlas', 'atlas.md');
    if (existsSync(atlasMdPath)) {
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const atlasDir = path.join(projectCwd, 'docs', 'ui-atlas');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveDir = path.join(atlasDir, '.history', stamp);
        await fs.mkdir(archiveDir, { recursive: true });
        try { await fs.rename(path.join(atlasDir, 'atlas.md'), path.join(archiveDir, 'atlas.md')); } catch {}
        try { await fs.copyFile(path.join(atlasDir, 'changelog.md'), path.join(archiveDir, 'changelog.md')); } catch {}
        try { await fs.rename(path.join(atlasDir, 'shots'), path.join(archiveDir, 'shots')); } catch {}
        console.log(`[atlas] Build detected existing atlas — archived to ${archiveDir}`);
      } catch (e) {
        console.warn('[atlas] archive step failed during Build (continuing):', e);
      }
    }

    const port = guiPort > 0 ? guiPort : 3333;
    const systemPrompt = UI_ATLAS_SYSTEM_PROMPT_TEMPLATE
      .replace(/{GUI_PORT}/g, String(port))
      .replace(/{WORKSPACE_ID}/g, workspaceId)
      .replace(/{TEST_URL}/g, ws.testUrl);

    const created = await agentService.createAgent('UI Atlas Agent', projectCwd, [], systemPrompt, workspaceId, { hideFromGrid: true });
    // Persist atlas state on the workspace so re-scans don't re-prompt for the
    // path and the frontend can display freshness / progress widgets.
    const updated = await workspaceService.update(workspaceId, {
      atlasAgentId: created.id,
      atlasProjectCwd: projectCwd,
    });
    if (updated) broadcast({ type: 'workspace_updated', workspace: updated });

    // Auto-trigger the initial discovery — the user clicked "Build" with the
    // unambiguous intent of "and now do the work". They shouldn't have to
    // hunt for the agent's chat panel and type a kickoff prompt manually.
    const kickoff = `Build the initial UI Atlas for this project per your system prompt. Be exhaustive — every surface in §2 needs a verified screenshot, every entity in §1 needs at least one verified surface, and Pass 6 self-verification must pass before you write the final atlas. Use /api/browser/evaluate aggressively for any surface that doesn't yield to clicks (canvas double-clicks, planet selection, multi-system empire state, in-flight battle state, etc). Use stable per-surface filenames ("name": "surface-<slug>") on every screenshot.`;
    // Don't await — the agent runs for ~1 hour. Caller returns immediately
    // so the frontend can transition to the running state.
    agentService.sendMessage(created.id, kickoff).catch(e => {
      console.error(`[atlas] auto-kickoff failed for ${created.id}:`, e);
    });

    return created;
  },

  /**
   * Re-scan flow: archive current atlas, wipe shots/, delete the existing
   * atlas agent (gets a fresh one with the latest system prompt), then
   * provision a new agent + auto-trigger.
   *
   * Errors if the workspace doesn't have a saved atlasProjectCwd (i.e. no
   * prior atlas exists — the user should hit Build, not Re-scan).
   */
  async rescanAtlas(workspaceId: string): Promise<AgentInfo> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.atlasProjectCwd) throw new Error('No prior atlas — use Build instead of Re-scan');

    // Archive + wipe before spawning. We do this synchronously so the new run
    // starts from a clean slate — no half-overlapping output from the
    // previous scan.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const atlasDir = path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas');
    const archiveRoot = path.join(atlasDir, '.history');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(archiveRoot, stamp);
    try {
      // Move atlas.md to archive (if it exists)
      await fs.mkdir(archiveDir, { recursive: true });
      const atlasMd = path.join(atlasDir, 'atlas.md');
      try { await fs.rename(atlasMd, path.join(archiveDir, 'atlas.md')); } catch {}
      const changelog = path.join(atlasDir, 'changelog.md');
      try { await fs.copyFile(changelog, path.join(archiveDir, 'changelog.md')); } catch {}
      // Move shots/ to archive
      const shotsDir = path.join(atlasDir, 'shots');
      try { await fs.rename(shotsDir, path.join(archiveDir, 'shots')); } catch {}
      console.log(`[atlas] archived previous scan to ${archiveDir}`);
    } catch (e) {
      console.warn(`[atlas] archive step failed (continuing):`, e);
    }

    // Delete the previous atlas agent so the new one picks up the latest
    // system prompt (in case we've shipped updates since the previous scan).
    if (ws.atlasAgentId && agents.has(ws.atlasAgentId)) {
      await agentService.removeAgent(ws.atlasAgentId);
    }

    return await agentService.provisionAtlasAgent(workspaceId, ws.atlasProjectCwd);
  },

  /**
   * Send a message from a coding agent's QA panel to the workspace's QA agent.
   * Spawns the QA agent on first call (lazy provisioning). Builds a chat
   * summary of the source coding agent's conversation, prepends it to the
   * user's content, and forwards to the QA agent's sendMessage. The pending
   * test is recorded with a 3-minute hard-kill backstop; when the QA agent
   * goes idle, _processQaIdle relays the report back into the source coding
   * agent's chat.
   */
  async sendQaMessage(workspaceId: string, sourceAgentId: string, userContent: string): Promise<void> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.testUrl) throw new Error('Workspace has no Test URL set');
    if (!agents.has(sourceAgentId)) throw new Error(`Source agent not found: ${sourceAgentId}`);

    // 1) Resolve / provision the QA agent.
    let qaAgentId = ws.qaAgentId;
    if (!qaAgentId || !agents.has(qaAgentId)) {
      const qaCwd = join(tmpdir(), 'agent-forge-qa', workspaceId);
      if (!existsSync(qaCwd)) mkdirSync(qaCwd, { recursive: true });
      const port = guiPort > 0 ? guiPort : 3333;
      const systemPrompt = QA_SYSTEM_PROMPT_TEMPLATE
        .replace(/{GUI_PORT}/g, String(port))
        .replace(/{WORKSPACE_ID}/g, workspaceId);
      const created = await agentService.createAgent('QA Tester', qaCwd, [], systemPrompt, workspaceId);
      qaAgentId = created.id;
      const updated = await workspaceService.update(workspaceId, { qaAgentId } as any);
      if (updated) broadcast({ type: 'workspace_updated', workspace: updated });
    }

    // 2) Build the trigger message: chat summary + the user's QA-panel input.
    const summary = buildChatSummary(sourceAgentId);
    const triggerMessage = [
      'A user is asking the QA testing agent (you) to test something. Below is a context summary of their recent conversation with the coding agent, followed by their actual instruction.',
      '',
      `Test URL: ${ws.testUrl}`,
      `Workspace ID: ${workspaceId}`,
      '',
      '## Recent conversation with coding agent',
      '',
      summary || '(no prior conversation)',
      '',
      '## User instruction',
      '',
      userContent,
    ].join('\n');

    // 3) Record pending test with 3-minute hard-kill backstop.
    const test: PendingQaTest = {
      sourceAgentId,
      triggeredAt: Date.now(),
      hardKillTimer: null,
    };
    test.hardKillTimer = setTimeout(() => {
      console.warn(`[qa] hard-kill triggered for ${qaAgentId} after ${QA_HARD_KILL_MS}ms`);
      agentService.stopAgent(qaAgentId!, 'timeout').catch(() => {});
    }, QA_HARD_KILL_MS);

    if (!pendingQaTests.has(qaAgentId)) pendingQaTests.set(qaAgentId, []);
    pendingQaTests.get(qaAgentId)!.push(test);

    // 4) Forward to the QA agent. sendMessage uses the existing sendLocks
    //    queue, so concurrent sendQaMessage calls serialize cleanly.
    await agentService.sendMessage(qaAgentId, triggerMessage);
  },

  // --- Set agent workspace (for migration) ---
  setAgentWorkspace(agentId: string, wsId: string): void {
    const agent = agents.get(agentId);
    if (agent && !agent.info.workspaceId) {
      agent.info.workspaceId = wsId;
    }
  },

  // --- Load persisted agents ---

  load(data: { agents: any[]; messages: ChatMessage[]; sharedContext: string }) {
    for (const agentData of data.agents) {
      const managed: ManagedAgent = {
        info: {
          ...agentData,
          status: 'stopped' as AgentStatus,
          referencePaths: agentData.referencePaths || [],
          systemPrompt: agentData.systemPrompt || '',
          workspaceId: agentData.workspaceId || '',
        },
        process: null,
        sessionId: agentData.sessionId || null,
        outputBuffer: '',
        watcher: null,
        lastFileChange: [],
        pendingTimeouts: [],
        contextTokens: agentData.contextTokens || 0,
        contextLimit: agentData.contextLimit || 200000,
        totalInputTokens: agentData.totalInputTokens || 0,
        totalOutputTokens: agentData.totalOutputTokens || 0,
        totalCostUsd: agentData.totalCostUsd || 0,
        numTurns: agentData.numTurns || 0,
      };
      agents.set(agentData.id, managed);
      startFileWatcher(agentData.id);
      documentService.startPlansWatcher(agentData.id, agentData.cwd);
    }

    for (const msg of data.messages) {
      if (!messages.has(msg.agentId)) {
        messages.set(msg.agentId, []);
      }
      messages.get(msg.agentId)!.push(msg);
    }

    sharedContext = data.sharedContext || '';
    (globalThis as any).__sharedContext = sharedContext;
  },

  /** Reassign agents from one workspace to another */
  reassignAgents(fromWsId: string, toWsId: string): void {
    for (const managed of agents.values()) {
      if (managed.info.workspaceId === fromWsId) {
        managed.info.workspaceId = toWsId;
      }
    }
  },

  /** Build persisted agent data for persistence service */
  buildPersistedAgents(): any[] {
    return Array.from(agents.values()).map(a => ({
      ...a.info,
      sessionId: a.sessionId,
      contextTokens: a.contextTokens,
      contextLimit: a.contextLimit,
      totalInputTokens: a.totalInputTokens,
      totalOutputTokens: a.totalOutputTokens,
      totalCostUsd: a.totalCostUsd,
      numTurns: a.numTurns,
    }));
  },

  buildPersistedMessages(): ChatMessage[] {
    return Array.from(messages.values()).flat();
  },
};

// Wire up cross-service callbacks — must be called after all modules are initialized
export function initAgentService() {
  documentService._onPlanFileChanged = (agentId: string, filePath: string) => {
    const agent = agents.get(agentId);
    if (!agent) return;
    documentService.syncPlanFromFile(agentId, agent.info.name, agent.process !== null, agent.info.workspaceId, filePath);
  };
}
