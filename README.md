# Wreckterra

An original OleyArcade vehicular-combat game with real-world arenas derived from OpenStreetMap. Mobile first, React and Vite on the existing Vercel setup.

This initial garage is repository preparation. Driving and the Central Park combat prototype are next; the starter does not claim gameplay or geographic fidelity.

Use Node from `.nvmrc`, then `npm ci`, `npm run dev`. Check with `npm run typecheck`, `npm test`, `npm run build`, and `npm run security`. Tests refuse empty selection. `npm run test:coverage` measures coverage; do not invent baselines or treat a measurement as a new gate without review.

The product roadmap is Central Park solo combat, progression, curated and searched arenas, bounded World Drive streaming, then online authority. File implementation tasks against actual runtime callers as the frontier becomes ready. See the Remudero Console product case for durable build and deployment evidence.

## How plans land

A plan requested for this product in Remudero Console opens its pull request in this repository, under `plan/`. It counts only after that pull request's own Remudero review passes and it merges. Core records a refused request against the commit it read and does not retry it at that commit.

The plan records are in `plan/tasks.d/`, one file per task, and `plan/roadmap.md` keeps the reserved later work. A task is ready to build only when its own record says so.
