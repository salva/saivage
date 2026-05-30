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
    | "plan_updated"
    | "supervisor_verdict"
    | "agent_started"
    | "agent_completed"
    | "abort_triggered";
  severity: "info" | "warning" | "error";
  payload: Record<string, unknown>;
  timestamp: string;
}
```

The full enum lives in `src/types.ts`. New event types should be added
there and to the `notifications.filters.categories` enum simultaneously.

## Subscribing

```ts
import { EventBus } from "saivage";

const bus = new EventBus();
const off = bus.subscribe(
  (evt) => console.log(evt.type, evt.payload),
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

`minSeverity` defaults to `info` (everything passes). `allowedTypes`
defaults to undefined (everything passes).

The web UI subscribes with the project config's
`notifications.filters` so the dashboard's event panel reflects what the
user asked to see.

## Producers

The Dispatcher emits `agent_started` / `agent_completed`. The Manager
emits `task_failed`. The Planner emits `stage_completed` /
`stage_failed` / `escalation` / `plan_updated`. The Inspector emits
`inspector_complete`. The Abort handler emits `abort_triggered`.

Producers do not block on subscribers — handlers are awaited but errors
inside handlers are caught and logged so a single misbehaving listener
cannot stall the runtime.
