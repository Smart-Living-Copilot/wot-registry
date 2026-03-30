#!/bin/sh
set -e

# Start the search indexer consumer in the background
python3 /app/backend/src/wot_registry/search_indexer/main.py &

# Start the registry server
exec uvicorn wot_registry.app:app --app-dir /app/backend/src --host 0.0.0.0 --port 8000 "$@"
