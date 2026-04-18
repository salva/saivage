# Saivage LXC Deployment

Deploy [Saivage](../README.md) (self-extending autonomous AI agent) into an LXC container.

Mirrors the [myoc/OpenClaw LXC deployment](../../myoc/) pattern — bare LXC with GPU passthrough and systemd service management. The host source directory is bind-mounted into the container, so edits on the host are immediately visible inside.

The container uses the same Ubuntu release as the host (25.10 questing) to ensure NVIDIA driver and CUDA userspace library compatibility for local model inference.

## Prerequisites

- Bare LXC installed on the host (`sudo apt install lxc`)
- An API key from a model provider (Anthropic, OpenAI, etc.)
- The Saivage source repo (this directory's parent)

## Quick Start

```bash
# 1. Create the container (downloads Ubuntu 24.04 template)
make create

# 2. Install Node.js, build tools, and Saivage
make provision

# 3. Configure model providers and API keys
make configure

# 4. Start the Saivage server daemon
make start
```

## Project Structure

```
deploy/
├── README.md                   # This file
├── Makefile                    # Orchestration commands
├── scripts/
│   ├── create-container.sh     # Create and configure the LXC container
│   ├── provision.sh            # Install Node.js + build Saivage inside container
│   └── destroy-container.sh    # Tear down the container
└── config/
    └── saivage.json            # Default Saivage configuration (copied into container)
```

## Configuration

Edit `Makefile` to change:

| Variable         | Default    | Description                      |
|------------------|------------|----------------------------------|
| `CONTAINER_NAME` | `saivage`    | LXC container name                     |
| `DIST`           | `ubuntu`     | Distribution for lxc-create            |
| `RELEASE`        | `questing`   | Release codename (25.10 = questing)    |
| `ARCH`           | `amd64`      | Architecture                           |
| `SAIVAGE_PORT`   | `8080`       | HTTP/WS server port                    |

### Saivage Configuration

Place your configuration in `config/saivage.json`. After `make provision`, edit the config inside the container:

```bash
make shell
nano /opt/saivage/.saivage/saivage.json
```

At minimum, set your model provider API key:

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." }
  }
}
```

Or set via environment variables in the systemd service (see `make configure`).

## Container Management

```bash
make start-container  # start the LXC container
make stop-container   # stop the LXC container
make restart-container # restart the LXC container

make start      # start the saivage daemon
make stop       # stop the daemon
make restart    # restart the daemon
make status     # show daemon status
make logs       # tail daemon logs

make shell      # open a shell inside the container
make ip         # show container IP
make info       # show container info
make dashboard  # open web UI in browser

make chat       # run interactive chat via CLI
make test       # run tests inside the container

make deploy     # rebuild from latest source + restart daemon
make destroy    # stop and delete the container (asks confirmation)
```

## Networking

The v2 server binds to `0.0.0.0:8080` inside the container. Bare LXC uses `lxcbr0` bridge by default, so the server is reachable from the host at `http://<container-ip>:8080`.

To find the container IP:
```bash
make ip
```

Endpoints:
- `http://<ip>:8080/health` — health check
- `http://<ip>:8080/api/state` — runtime state + current plan
- `http://<ip>:8080/api/plan` — plan stages + execution history
- `http://<ip>:8080/api/plan/stages/:id` — stage detail (tasks, reports)
- `http://<ip>:8080/api/inspections` — recent inspection reports
- `ws://<ip>:8080/ws` — WebSocket chat
- `http://<ip>:8080/` — web dashboard (Vue 3 SPA)

## Updating

The host source directory is bind-mounted into the container at `/opt/saivage`. Any edits you make on the host are immediately visible inside. To rebuild and restart the daemon:

```bash
make deploy
```

This runs `npm ci && npm run build` inside the container and restarts the systemd service.

## Troubleshooting

- **Daemon won't start**: Run `make shell` then `cd /opt/saivage && npm run dev` to see errors
- **Container can't reach internet**: Check that `lxcbr0` exists (`brctl show`) and that `/etc/default/lxc-net` has `USE_LXC_BRIDGE="true"`
- **Node.js version**: Saivage requires Node >= 20; the container installs Node 24
- **NVIDIA/CUDA**: The container matches the host Ubuntu version (25.10) so NVIDIA userspace libs are compatible with the host kernel module. GPU devices are bind-mounted into the container.
- **Permission denied**: Most `lxc-*` commands require `sudo`; the Makefile handles this
