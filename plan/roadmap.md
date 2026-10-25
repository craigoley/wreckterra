# Wreckterra expansion roadmap

The first release is a mobile-first solo Central Park combat prototype. Its initial six implementation tasks remain held until their recorded runner, App, CI and onboarding prerequisites are verified. Repository starter work is preparation, not gameplay credit.

File later implementation records when their actual runtime callers exist. The following reserved task records preserve the agreed design and dependencies; they are proposed expansion work, outside the dispatch plan. Do not infer dispatch authority or reuse their reserved IDs.

## WRECK-T7-search-and-custom-arenas.yaml

```yaml
- id: WRECK-T7
  title: Prepare bounded custom arenas from searched or pinned real locations
  repo: wreckterra
  depends_on:
    - WRECK-T3
    - WRECK-T4
  priority: 1.1
  type: implement
  verify: auto
  principles:
    tdd: strict
  budget_usd: 30
  risk: high
  band_meaning: span
  origin: operator-request#wreckterra-console-product-2026-10-25
  files:
    - src/maps/discovery.ts
    - src/maps/jobs.ts
    - src/maps/compiler.ts
    - src/game/MapPicker.tsx
    - src/App.tsx
    - tests/unit/location-jobs.test.ts
    - tests/e2e/location-picker.spec.ts
  status: queued
  dispatch_hold: true
  attempts: 0
  rationale: The operator authorized a mobile-first original-IP real-location combat game built by Remudero through Console. Existing repo ID 1432832754 must be adopted. This initial plan is held until the actual runner/App/bootstrap gates are verified; release only the accepted frontier, preserving existing jobs and budgets.
  design: After curated compiler proof, offer explicit-submit policy-compliant search/drop-pin, private favorites and preview likeness/size/adaptations. Use a replaceable geocoder and source adapter, existing resources, bounded jobs/canonical-key dedupe/cache. No default public Nominatim autocomplete or bulk public tile dependency. Distinguish cached/queued/ready/simplified/unsupported/retryable-error with full immutable manifests and observed/inferred/authored provenance. No mandatory GPS, home-pin publication, raw search analytics or fabricated empty-success level. Activation requires actual source policy/quotas/capacity receipts within existing caps. The production call-site proof pins requestArena in src/game/MapPicker.tsx; implement that actual runtime integration, never a comment or unused wrapper.
  acceptance:
    - claim: concurrent requests for one location share one bounded generation job
      proof: "unit test: WRECK-T7: concurrent requests for one location share one bounded generation job"
    - claim: unsupported data provider errors and measured emptiness remain distinct
      proof: "unit test: WRECK-T7: unsupported data provider errors and measured emptiness remain distinct"
    - claim: favorite places remain private and accessible without progression
      proof: "unit test: WRECK-T7: favorite places remain private and accessible without progression"
    - claim: the playable runtime consumes the implemented mechanism
      proof: "grep: requestArena( in src/game/MapPicker.tsx"
  falsifier: Remove the corresponding input, identity, invariant, source validation or evidence guard independently. Its discriminating unit/browser proof must fail and pass on restoration. Confirm actual nonzero test counts; pin artifacts and compare the same units. Physical-device and live deployment receipts remain separate from fixtures.
```

## WRECK-T8-world-drive-streaming.yaml

```yaml
- id: WRECK-T8
  title: Explore streamed real geography with safe cell frontiers and checkpoints
  repo: wreckterra
  depends_on:
    - WRECK-T7
    - WRECK-T5
  priority: 1.1
  type: implement
  verify: auto
  principles:
    tdd: strict
  budget_usd: 30
  risk: high
  band_meaning: span
  origin: operator-request#wreckterra-console-product-2026-10-25
  files:
    - src/maps/streaming.ts
    - src/maps/chunks.worker.ts
    - src/maps/coordinates.ts
    - src/game/WorldDrive.tsx
    - src/progress/profile.ts
    - tests/unit/world-streaming.test.ts
    - tests/e2e/world-drive.spec.ts
  status: queued
  dispatch_hold: true
  attempts: 0
  rationale: The operator authorized a mobile-first original-IP real-location combat game built by Remudero through Console. Existing repo ID 1432832754 must be adopted. This initial plan is held until the actual runner/App/bootstrap gates are verified; release only the accepted frontier, preserving existing jobs and budgets.
  design: Stream active/warm/eviction rings and connected road/path expeditions, not the planet at once. Predict prefetch from speed and measured load latency; use local metric frames, atomic origin shifts, buffered seams/shared portal identities and stable source snapshots. Verify collision/navigation before entry, GPU uploads bounded; unloaded frontier safely stops/checkpoints and offers retry/route/fast travel. Water/ocean/polar/data gaps use explicit transitions or unsupported outcomes, never invented real roads. Cache eviction preserves unique progress/manifests and does not duplicate encounter rewards. Optional local encounter bubbles. Test thousands of cells/reversals/antimeridian/pause/source-revision/save; no unbounded memory/data or new provisioned runtime. The production call-site proof pins enterVerifiedCell in src/game/WorldDrive.tsx; implement that actual runtime integration, never a comment or unused wrapper.
  acceptance:
    - claim: a missing streamed cell stops the car before unverified terrain
      proof: "unit test: WRECK-T8: a missing streamed cell stops the car before unverified terrain"
    - claim: origin shifts seams and cache eviction preserve bounded simulation
      proof: "unit test: WRECK-T8: origin shifts seams and cache eviction preserve bounded simulation"
    - claim: checkpoint resume and repeated encounters cannot duplicate progress
      proof: "unit test: WRECK-T8: checkpoint resume and repeated encounters cannot duplicate progress"
    - claim: the playable runtime consumes the implemented mechanism
      proof: "grep: enterVerifiedCell( in src/game/WorldDrive.tsx"
  falsifier: Remove the corresponding input, identity, invariant, source validation or evidence guard independently. Its discriminating unit/browser proof must fail and pass on restoration. Confirm actual nonzero test counts; pin artifacts and compare the same units. Physical-device and live deployment receipts remain separate from fixtures.
```

## WRECK-T9-online-authority-foundation.yaml

```yaml
- id: WRECK-T9
  title: Validate the later online authority against loss reconnect and deployment boundaries
  repo: wreckterra
  depends_on:
    - WRECK-T4
    - WRECK-T7
  priority: 1.1
  type: implement
  verify: auto
  principles:
    tdd: strict
  budget_usd: 30
  risk: high
  band_meaning: span
  origin: operator-request#wreckterra-console-product-2026-10-25
  files:
    - src/network/protocol.ts
    - src/network/authority.ts
    - src/sim/contracts.ts
    - tests/unit/network-authority.test.ts
    - docs/online-spike.md
  status: queued
  dispatch_hold: true
  attempts: 0
  rationale: The operator authorized a mobile-first original-IP real-location combat game built by Remudero through Console. Existing repo ID 1432832754 must be adopted. This initial plan is held until the actual runner/App/bootstrap gates are verified; release only the accepted frontier, preserving existing jobs and budgets.
  design: Keep solo local authority and implement a bounded later-online comparison with existing-host capacity evidence, not an unconditional new room service. Clients send inputs; server owns movement validation/damage/pickups/encounters/rewards and exact map/rules versions. Do not assume all browser calculations replay identically. Evaluate current Vercel WebSocket duration/instance coordination and a reversible dedicated-room option only within authorized resource caps; no obsolete blanket WebSocket claim and no spare Redis inference from signaling. Inject loss/latency/reconnect/owner failure/deploy and duration crossing, one fenced room owner, idempotent rewards and reliable snapshots. Do not claim multiplayer shipped from an adapter.
  acceptance:
    - claim: reconnect and owner changes preserve one authoritative room
      proof: "unit test: WRECK-T9: reconnect and owner changes preserve one authoritative room"
    - claim: clients cannot self award damage pickups or progression
      proof: "unit test: WRECK-T9: clients cannot self award damage pickups or progression"
    - claim: network peers reject mismatched map rules and protocol versions
      proof: "unit test: WRECK-T9: network peers reject mismatched map rules and protocol versions"
  falsifier: Remove the corresponding input, identity, invariant, source validation or evidence guard independently. Its discriminating unit/browser proof must fail and pass on restoration. Confirm actual nonzero test counts; pin artifacts and compare the same units. Physical-device and live deployment receipts remain separate from fixtures.
```

