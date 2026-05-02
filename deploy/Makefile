CONTAINER_NAME ?= saivage
DIST           ?= ubuntu
RELEASE        ?= questing
ARCH           ?= amd64
SAIVAGE_PORT   ?= 8080
TARGET_PROJECT_ROOT ?= $(shell if [ -d "$(CURDIR)/../../target" ]; then cd "$(CURDIR)/../../target" && pwd; fi)
TARGET_PROJECT_MOUNT ?= /work/target
SHUTDOWN_REASON ?= Application code changed; rebuilding and restarting Saivage
SCRIPTS        := scripts
PROJECT_ROOT   := $(shell cd .. && pwd)
# SSH alias configured by provision.sh in ~/.ssh/config
SSH            := ssh saivage

export CONTAINER_NAME DIST RELEASE ARCH PROJECT_ROOT TARGET_PROJECT_ROOT TARGET_PROJECT_MOUNT

.PHONY: create provision configure start stop restart record-shutdown status logs shell ip \
        info dashboard chat test deploy destroy \
        start-container stop-container restart-container help

## Container lifecycle

create:
	@bash $(SCRIPTS)/create-container.sh

provision:
	@bash $(SCRIPTS)/provision.sh

configure:
	@$(SSH) "mkdir -p /opt/saivage/.saivage && nano /opt/saivage/.saivage/saivage.json"

start-container:
	@sudo lxc-start -n $(CONTAINER_NAME)

stop-container:
	@sudo lxc-stop -n $(CONTAINER_NAME)

restart-container:
	@sudo lxc-stop -n $(CONTAINER_NAME) 2>/dev/null || true
	@sudo lxc-start -n $(CONTAINER_NAME)

## Daemon management

start:
	@$(SSH) "sudo systemctl start saivage"

stop:
	@$(SSH) "sudo systemctl stop saivage"

restart:
	@$(MAKE) --no-print-directory record-shutdown SHUTDOWN_REASON="$(SHUTDOWN_REASON)"
	@$(SSH) "sudo systemctl restart saivage"

record-shutdown:
	@printf '%s' "$(SHUTDOWN_REASON)" | $(SSH) "cd /opt/saivage && node dist/cli.js request-shutdown $(TARGET_PROJECT_MOUNT) --requested-by deploy --reason-stdin" || \
		echo "WARN: could not record shutdown reason; restarting anyway"

status:
	@$(SSH) "sudo systemctl status saivage"

logs:
	@$(SSH) "sudo journalctl -u saivage -f --no-pager"

## Utilities

shell:
	@$(SSH) -t

ip:
	@sudo lxc-info -n $(CONTAINER_NAME) -iH 2>/dev/null | head -1

info:
	@sudo lxc-info -n $(CONTAINER_NAME)

dashboard:
	@IP=$$(sudo lxc-info -n $(CONTAINER_NAME) -iH 2>/dev/null | head -1); \
	echo "Dashboard at http://$$IP:$(SAIVAGE_PORT)"; \
	xdg-open "http://$$IP:$(SAIVAGE_PORT)" 2>/dev/null || true

chat:
	@IP=$$(sudo lxc-info -n $(CONTAINER_NAME) -iH 2>/dev/null | head -1); \
	echo "Chat available at http://$$IP:$(SAIVAGE_PORT) (WebSocket)"; \
	xdg-open "http://$$IP:$(SAIVAGE_PORT)" 2>/dev/null || true

test:
	@$(SSH) "cd /opt/saivage && npm test"

## Deploy / update (source is bind-mounted, just rebuild)

deploy:
	@echo "==> Source is bind-mounted — rebuilding in container..."
	@$(SSH) "cd /opt/saivage && npm ci && cd web && npm ci && cd .. && npm run build"
	@echo "==> Ensuring headless Playwright browser is available..."
	@$(SSH) "cd /opt/saivage && npx -y playwright@latest install chromium" || true
	@echo "==> Refreshing systemd unit..."
	@$(SSH) "sudo cp /opt/saivage/deploy/saivage.service /etc/systemd/system/saivage.service && sudo systemctl daemon-reload"
	@echo "==> Restarting daemon..."
	@$(MAKE) --no-print-directory record-shutdown SHUTDOWN_REASON="$(SHUTDOWN_REASON)"
	@$(SSH) "sudo systemctl restart saivage"
	@echo "==> Deploy complete."

## Teardown

destroy:
	@bash $(SCRIPTS)/destroy-container.sh

## Help

help:
	@echo "Saivage LXC Deployment (bare lxc)"
	@echo ""
	@echo "Target project:"
	@echo "  host  - $(TARGET_PROJECT_ROOT)"
	@echo "  mount - $(TARGET_PROJECT_MOUNT)"
	@echo ""
	@echo "Container lifecycle:"
	@echo "  make create            - Create the LXC container"
	@echo "  make provision         - Install Node.js and build Saivage"
	@echo "  make configure         - Edit saivage.json config"
	@echo "  make start-container   - Start the container"
	@echo "  make stop-container    - Stop the container"
	@echo "  make restart-container - Restart the container"
	@echo "  make destroy           - Delete the container"
	@echo ""
	@echo "Daemon:"
	@echo "  make start       - Start the Saivage daemon"
	@echo "  make stop        - Stop the daemon"
	@echo "  make restart     - Restart the daemon"
	@echo "  make status      - Show daemon status"
	@echo "  make logs        - Tail daemon logs"
	@echo ""
	@echo "Development:"
	@echo "  make deploy      - Sync source, rebuild, restart"
	@echo "  make test        - Run tests inside container"
	@echo "  make chat        - Interactive CLI chat"
	@echo ""
	@echo "Utilities:"
	@echo "  make shell       - Open shell in container"
	@echo "  make ip          - Show container IP"
	@echo "  make info        - Show container info"
	@echo "  make dashboard   - Open web UI in browser"
