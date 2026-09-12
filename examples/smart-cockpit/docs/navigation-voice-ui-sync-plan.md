# Navigation Voice/UI Sync Goals and Test Plan

## Goals

The navigation experience should make voice narration the primary timeline and
map/UI animation the visual reflection of that timeline.

Concrete goals:

- Show waypoints in the navigation status panel when a route contains
  waypoints.
- Emit structured navigation activity anchors for destination and waypoint
  resolution, so the UI can react to the same semantic points that narration
  mentions.
- Animate waypoint markers before the destination marker on waypoint routes,
  matching natural narration such as "pass Huanglong Sports Center, then go to
  West Lake".
- Keep chitchat and other low-risk foreground interactions independent from the
  navigation semantic timeline.
- Leave a future extension point for phrase-level TTS timestamps: the current
  `item`/`route` anchors can later be aligned to real narration timings without
  changing the UI contract.

## Implementation Scope

This pass implements semantic soft-sync rather than audio timestamp sync:

- The cockpit service attaches `item` anchors to `destination_locked` and
  `waypoint_locked` activity events.
- Final route activity includes a `route` summary with destination and waypoint
  locations.
- The client activity projection preserves these anchors.
- The navigation route projection exposes waypoint names, waypoint locations,
  and destination location.
- The map panel uses active navigation progress to create preview markers for
  the currently resolved destination or waypoint.
- The committed route animation displays waypoint pins first, then the
  destination pin, then route drawing.

## Test Plan

Unit and integration-style checks:

- Service: starting navigation with two waypoints should emit ordered activity
  events with destination and waypoint `item` anchors, followed by a route
  summary.
- Client activity projection: cockpit activity should preserve `item` and
  `route` objects for downstream UI sync.
- Navigation route projection: authoritative navigation state should project
  waypoint names, waypoint locations, destination location, route polyline, and
  traffic segments.
- Navigation progress projection: `destination_locked` and `waypoint_locked`
  should become map preview marker contracts; searching states should not.
- Smart cockpit suite: service, agent, benchmark, bootstrap, client, gateway,
  and scenario tests should all pass.
- Client lint/build: JSX, CSS, and production bundling should pass.

## Review Passes

Review 1: Event Contract

- `reportActivity` now supports structured metadata without changing existing
  status/message fields.
- Destination and waypoint resolution events carry role, index, name, and
  location when available.
- Final route events carry the resolved route anchor list.

Review 2: UI Timeline

- During active progress, resolved waypoints and destinations can appear before
  the final route is committed.
- During committed route animation, waypoint pins are created first and
  destination pins use a delayed marker animation.
- The status card distinguishes `waypoint_locked` from `destination_locked`.

Review 3: Verification Coverage

- Projection tests cover the exact marker contract used by the UI.
- Service tests cover ordered activity and structured metadata.
- Full smart-cockpit tests, lint, and build pass after the change.

## Test Report

Latest local verification:

- `node --test examples/smart-cockpit/client/test/navigation-route.test.mjs examples/smart-cockpit/client/test/cockpit-activity.test.mjs examples/smart-cockpit/service/test/cockpit-service.test.mjs`
  - 25 passed, 0 failed.
- `npm run test:smart-cockpit`
  - service: 29 passed, 0 failed.
  - agent: 5 passed, 0 failed.
  - combined example suites: 65 passed, 0 failed.
- `npm run example:smart-cockpit:lint`
  - passed.
- `npm run example:smart-cockpit:build`
  - passed; Vite reported a chunk-size warning only.

## Reasonableness Analysis

The result is a reasonable first step because it synchronizes UI animation to
navigation semantics, which is the same level at which the assistant response is
planned. It does not yet guarantee exact word-level audio synchronization,
because no TTS timestamp stream is consumed here. That is acceptable for this
stage: the UI contract now has stable anchors, and a future realtime/TTS layer
can map phrase timings onto the same anchors.

For benchmark interpretation, this supports the hybrid-harness thesis: the
foreground can react quickly to low-risk semantic events, while the backend
harness remains responsible for route planning and longer-horizon navigation
state.
