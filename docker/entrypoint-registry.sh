#!/bin/sh
set -e

# Start the registry server. The app lifecycle owns the search indexer.
exec uvicorn wot_registry.app:app --app-dir /app/backend/src --host 0.0.0.0 --port 8000 "$@"
