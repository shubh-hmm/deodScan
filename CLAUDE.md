# CLAUDE.md

## Handoff file — mandatory, automatic

This repo has a running handoff at [HANDOFF.md](HANDOFF.md). It applies to **every** Claude session, on any account or Claude ID. The user switches accounts and will not remind you.

1. **At session start:** read `HANDOFF.md` before doing anything else. The owner's full spec is in [docs/ORIGINAL_BRIEF.md](docs/ORIGINAL_BRIEF.md). It holds the project state, verified facts, user preferences and next steps.
2. **While working:** after each meaningful change (code, config, SQL, migrations, data loads, Dune runs and their credit cost, decisions made by the user), add a line to the Work log. Update "Current state" and "Next steps" as well. Do this as you go, not only at the end.
3. Keep the "Last updated" date current. Use absolute dates.
4. Do not delete earlier log entries. Correct any facts that turn out to be wrong.

## Layout (details in HANDOFF.md §2)

- `frontend/` is the Next.js dashboard and `backend/` holds the API, the sync worker, the shared libraries, the config and the SQL. They are separate npm projects that talk only over HTTP. Never import backend code into the frontend.
- Run commands from the project root (`npm run api`, `worker`, `web`, `audit`, `typecheck`, `test`; `run.cmd` / `stop.cmd` start and stop everything).

## Project rules (summary; details in HANDOFF.md §3–4)

- BNB Chain only. Never invent addresses, tables or columns. Verify with real Dune data first.
- Dune queries cost the user's credits. State the cost and ask before expensive or exploratory queries. Never join `tokens.transfers` to label tables.
