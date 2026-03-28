from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from wot_registry.config import Settings
from wot_registry.search_indexer.chunking import generate_all_chunks
from wot_registry.search_indexer.embeddings import (
    create_openai_embeddings,
    create_openai_client,
)
from wot_registry.search_indexer.metadata import build_index_metadata
from wot_registry.search_indexer.prompting import (
    SUMMARY_PROMPT_VERSION,
    generate_summary,
)
from wot_registry.search_indexer.store import SearchIndexDocument, SearchVectorStore
from wot_registry.search_indexer.summary_utils import (
    ThingTDMetadata,
    clean_text,
    compute_td_hash,
    extract_td_metadata,
    normalize_thing_td_payload,
)


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PreparedIndexChunks:
    thing_id: str
    chunks: list[tuple[str, SearchIndexDocument]] = field(default_factory=list)


class SearchIndexerService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._embeddings = create_openai_embeddings(
            base_url=settings.OPENAI_EMBEDDING_API_BASE_URL,
            api_key=settings.OPENAI_EMBEDDING_API_KEY,
            model=settings.OPENAI_EMBEDDING_MODEL,
        )
        self._client = create_openai_client(
            base_url=settings.OPENAI_API_BASE_URL,
            api_key=settings.OPENAI_API_KEY,
        )
        self._vector_store = SearchVectorStore(
            embeddings=self._embeddings,
            collection_name=settings.SEARCH_VECTOR_COLLECTION_NAME,
            persist_directory=settings.SEARCH_VECTOR_STORE_DIR,
        )

    async def start(self) -> None:
        await self._validate_dependencies()

    async def close(self) -> None:
        await self._client.close()
        await self._embeddings.close()

    async def _validate_dependencies(self) -> None:
        if not self._settings.OPENAI_API_KEY:
            raise RuntimeError(
                "OPENAI_API_KEY must be set for search indexer embedding generation."
            )
        if not self._settings.OPENAI_MODEL:
            raise RuntimeError(
                "OPENAI_MODEL must be set for search indexer LLM summarization."
            )
        await self._vector_store.ensure_schema()

    async def process_event(self, event: dict[str, Any]) -> None:
        thing_id = clean_text(event.get("id"))
        event_type = event.get("eventType")

        if not thing_id:
            logger.warning("Event missing 'id', cannot process.")
            return

        try:
            if event_type == "remove":
                await self._remove_index_chunks(thing_id)
                return

            if event_type not in {"create", "update"}:
                logger.info(
                    "Ignoring event type '%s' for thing '%s'", event_type, thing_id
                )
                return

            prepared = await self._prepare_index_chunks(
                event,
                thing_id=thing_id,
                event_type=event_type,
            )
            await self._upsert_index_chunks(prepared)
            logger.info("Successfully indexed thing: %s", thing_id)
        except Exception as exc:
            logger.error("Error managing vector for '%s': %s", thing_id, exc)
            raise

    async def _prepare_index_chunks(
        self,
        event: dict[str, Any],
        *,
        thing_id: str,
        event_type: str,
    ) -> PreparedIndexChunks:
        thing_td = normalize_thing_td_payload(event)
        td_metadata: ThingTDMetadata = extract_td_metadata(thing_td)
        summary = await generate_summary(
            self._client,
            model=self._settings.OPENAI_MODEL,
            thing_td=thing_td,
        )
        base_metadata = build_index_metadata(
            td_metadata,
            event_type=event_type,
            td_hash=compute_td_hash(thing_td),
            prompt_version=SUMMARY_PROMPT_VERSION,
            summary_source="llm",
            summary_model=self._settings.OPENAI_MODEL,
        )
        chunks = generate_all_chunks(
            thing_td, td_metadata, summary.strip(), base_metadata
        )
        return PreparedIndexChunks(thing_id=thing_id, chunks=chunks)

    async def _upsert_index_chunks(self, prepared: PreparedIndexChunks) -> None:
        await self._vector_store.replace_thing_chunks(
            prepared.thing_id,
            prepared.chunks,
        )

    async def _remove_index_chunks(self, thing_id: str) -> None:
        await self._vector_store.delete_thing_chunks(thing_id)
        logger.info("Removed vectors for deleted thing: %s", thing_id)
