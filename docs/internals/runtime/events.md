# Event Bus

[`src/events/bus.ts`](https://github.com/salva/saivage/blob/main/src/events/bus.ts)

A small in-process pub/sub used for the daemon's runtime events. It is
**not** a durable queue — events are fanned out synchronously and lost if
no one is subscribed.

## SystemEvent shape

```ts
interface SystemEvent {
  type:
    | "stage_completed"
    | "stage_failed"
    | "escalation"
    | "task_failed"
    | "inspector_complete"
    | "plan_updated";
  stage_id?: string;
  task_id?: string;
  report_id?: string;
  summary: string;
  timestamp?: string;
}
```

The full enum lives in `src/types.ts`. New event types should be added
there and to the `notifications.filters.categories` enum simultaneously.

## Subscribing

```ts
import { EventBus } from "saivage";

const bus = new EventBus();
const off = bus.subscribe(
  "example-subscription",
  (evt) => console.log(evt.type, evt.summary),
  { minSeverity: "warning", allowedTypes: ["escalation"] },
);
off(); // unsubscribe
```

The runtime owns a single `EventBus` (built in `bootstrap()`) and passes
it to every channel and to the supervisor.

## Filter

```ts
interface EventFilter {
  minSeverity?: "info" | "warning" | "error";
  allowedTypes?: SystemEvent["type"][];
}
```

`minSeverity` defaults to `info` (everything passes). The event object has
no severity field; `EventBus` maps each event type through its internal
`EVENT_SEVERITY` table. `allowedTypes` defaults to undefined (everything
passes).

WebSocket and Telegram Chat agents subscribe with
`SaivageConfig.notifications.filters` so user-facing notifications respect
the configured severity/type filters.

## Producers

Current publishers are:

- `publishAgentResult()` in `src/server/bootstrap.ts` emits
  `stage_completed`, `stage_failed`, `escalation`, and
  `inspector_complete` for Manager / Inspector results.
- The recovery loop and chat local commands emit `plan_updated` for
  Planner restarts, recovery restarts, continuous-improvement restarts,
  and explicit restart requests.
- `task_failed` remains in the schema/filter set and is formatted by Chat,
  but no runtime publisher currently emits it.

Producers wait for subscriber delivery promises to settle, but each
handler is bounded by a 5s timeout and errors are caught and logged so a
single misbehaving listener cannot stall the runtime indefinitely.
