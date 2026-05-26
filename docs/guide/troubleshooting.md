# Troubleshooting

## Daemon

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Error: No .saivage/ project found.` | Pass an explicit project path or run from inside a tree with `.saivage/config.json`. |
| `EADDRINUSE: 8080` | Another process owns the port. Change `server.port` in `saivage.json`. |
| Web UI loads but `/api/state` returns 404 | The web build is missing. Run `npm run build` (or `npm run build:web`). |
| Planner does nothing on first start | No usable LLM credentials. Run `saivage login`. |
| `Model not supported (HTTP 400)` | Provider deprecated/renamed the model. Use `saivage models …` to see resolved IDs and update the routing profile. |
| Constant `429` warnings | Rate-limited. The router backs off automatically; consider configuring `failover` to a secondary provider. |
| `git not found` errors | Install `git` inside the LXC container. The git MCP tool shells out. |

## Agent behavior

| Symptom | Diagnosis |
|---------|-----------|
| Plan is "lost" after restart | The Planner re-reads `plan.json`. If it's empty, check `plan-history.json` and consider resetting (see [Backup & Recovery](./backup)). |
| Worker keeps failing same task | Check the agent conversation in the web UI — usually a missing tool, wrong CWD, or unreachable resource. Add a permanent note steering the strategy. |
| Stage stuck on a single task | A failing dependency cascade. Open the stage detail; failed tasks block dependents. The Manager will eventually escalate (default 3 attempts). |
| Inspector report empty | Inspector ran out of context. Try a narrower scope. |
| Compaction loop | The agent may be saturating context with tool errors. Check for repeated identical errors in the conversation; consider raising `compaction_threshold_pct` or the model's context window. |

## LXC

| Symptom | Fix |
|---------|-----|
| `lxc-start` fails | `sudo lxc-checkconfig`; ensure cgroups v2 is enabled. |
| Container has no network | `ip link show lxcbr0`; `sudo systemctl restart lxc-net`. |
| `ssh saivage` connection refused | Container is still booting; wait or `sudo lxc-attach -n saivage -- systemctl status ssh`. |
| Permission denied on project dir | Add a bind mount in `/var/lib/lxc/saivage/config` then restart the container. |
| GPU not visible inside container | Driver mismatch — host and container userspace libs must match. `nvidia-smi` inside the container should show the same driver version as the host. |

## Diagnostics

```bash
# Daemon logs
make -C deploy logs                              # LXC
journalctl -u saivage -f                         # plain systemd
tail -F <project>/.saivage/tmp/logs/saivage.log  # JSONL

# State snapshots
curl -fsS http://127.0.0.1:8080/api/state | jq .
curl -fsS http://127.0.0.1:8080/api/debug/timeline | jq .

# Provider health
curl -fsS http://127.0.0.1:8080/api/providers | jq .
```

## Reporting bugs

When opening an issue please include:

1. Saivage version (`saivage --version`).
2. Output of `saivage models <project>`.
3. Relevant tail of `.saivage/tmp/logs/saivage.log`.
4. The provider chain involved (`/api/providers` snapshot).
5. Conversation excerpts can usually be redacted; the dashboard's
   "copy as JSON" action gives a clean blob.
