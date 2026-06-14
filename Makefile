# hush-backend — Makefile
#
# Two projects ship together:
#   api/        Fastify + TypeScript  (pnpm)
#   dashboard/  Next.js 15            (npm)
#
# Package managers are NOT mixed: pnpm only in api/, npm only in dashboard/.
# The data plane (Postgres + MinIO) comes from docker-compose.yml at the root.

API_DIR  := api
DASH_DIR := dashboard

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Data plane (Postgres + MinIO)
# ---------------------------------------------------------------------------
.PHONY: services services-down services-logs
services: ## Start Postgres + MinIO (docker compose, detached)
	docker compose up -d

services-down: ## Stop and remove the data-plane containers
	docker compose down

services-logs: ## Tail the data-plane container logs
	docker compose logs -f

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
.PHONY: install api-install dashboard-install
install: api-install dashboard-install ## Install deps for both projects

api-install: ## Install api deps (pnpm)
	cd $(API_DIR) && pnpm install

dashboard-install: ## Install dashboard deps (npm)
	cd $(DASH_DIR) && npm install

# ---------------------------------------------------------------------------
# Dev servers
# ---------------------------------------------------------------------------
.PHONY: api-dev dashboard-dev
api-dev: ## Run the api in watch mode (http://localhost:8080)
	cd $(API_DIR) && pnpm run dev

dashboard-dev: ## Run the dashboard dev server (http://localhost:3000)
	cd $(DASH_DIR) && npm run dev

# ---------------------------------------------------------------------------
# Build / start
# ---------------------------------------------------------------------------
.PHONY: build api-build dashboard-build api-start dashboard-start
build: api-build dashboard-build ## Production build for both projects

api-build: ## Build the api (tsc)
	cd $(API_DIR) && pnpm run build

dashboard-build: ## Build the dashboard (next build)
	cd $(DASH_DIR) && npm run build

api-start: ## Start the built api (node dist)
	cd $(API_DIR) && pnpm start

dashboard-start: ## Start the built dashboard (next start)
	cd $(DASH_DIR) && npm start

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------
.PHONY: typecheck lint test check api-typecheck dashboard-typecheck api-lint dashboard-lint
typecheck: api-typecheck dashboard-typecheck ## Typecheck both projects

api-typecheck: ## Typecheck the api
	cd $(API_DIR) && pnpm run typecheck

dashboard-typecheck: ## Typecheck the dashboard
	cd $(DASH_DIR) && npm run typecheck

lint: api-lint dashboard-lint ## Lint both projects

api-lint: ## Lint the api (eslint)
	cd $(API_DIR) && pnpm run lint

dashboard-lint: ## Lint the dashboard (next lint)
	cd $(DASH_DIR) && npm run lint

test: ## Run the api test suite (vitest)
	cd $(API_DIR) && pnpm run test

check: typecheck lint test ## Run all quality gates (typecheck + lint + test)

# ---------------------------------------------------------------------------
# Database migrations (node-pg-migrate, migrations/ at the root)
# ---------------------------------------------------------------------------
.PHONY: migrate-up migrate-down migrate-create
migrate-up: ## Apply pending migrations
	cd $(API_DIR) && pnpm run migrate:up

migrate-down: ## Roll back the last migration
	cd $(API_DIR) && pnpm run migrate:down

migrate-create: ## Create a migration (usage: make migrate-create name=add_foo)
	cd $(API_DIR) && pnpm run migrate:create $(name)

# ---------------------------------------------------------------------------
# API client / OpenAPI
# ---------------------------------------------------------------------------
.PHONY: gen-api
gen-api: ## Regenerate the dashboard API client from hush-api.yaml
	cd $(DASH_DIR) && npm run gen:api

# ---------------------------------------------------------------------------
# Operational scripts
# ---------------------------------------------------------------------------
.PHONY: provision-device upload-firmware
provision-device: ## Provision a device (HMAC secret)
	cd $(API_DIR) && pnpm run provision-device

upload-firmware: ## Upload a firmware build
	cd $(API_DIR) && pnpm run upload-firmware
