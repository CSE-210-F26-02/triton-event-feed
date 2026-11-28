"""
DID -> handle resolution (did:plc via plc.directory, did:web via
.well-known/did.json).
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any
from urllib.parse import unquote

import httpx

logger = logging.getLogger(__name__)

DEFAULT_PLC_URL = "https://plc.directory"
DID_PLC_PREFIX = "did:plc:"
DID_WEB_PREFIX = "did:web:"
AT_URI_PREFIX = "at://"
REQUEST_TIMEOUT_SECONDS = 3.0
CACHE_TTL_SECONDS = 3600
CACHE_MAX_SIZE = 10_000


def did_document_url(did: str, plc_url: str = DEFAULT_PLC_URL) -> str | None:
    """
    Where to fetch a DID's document, or None for unsupported DIDs.

    :param did: a did:plc or did:web identifier.
    :param plc_url: the PLC directory to use for did:plc.
    :returns: The document URL, or None.
    """
    if did.startswith(DID_PLC_PREFIX):
        return f"{plc_url}/{did}"
    if did.startswith(DID_WEB_PREFIX):
        host, *path = did.removeprefix(DID_WEB_PREFIX).split(":")
        host = unquote(host)
        if not host:
            return None
        if path:
            return f"https://{host}/{'/'.join(path)}/did.json"
        return f"https://{host}/.well-known/did.json"
    return None


def handle_from_did_document(did_document: Any) -> str | None:
    """
    Return the first at:// alias in a DID document, without "at://".

    :param doc: the decoded DID document (untrusted; may be malformed).
    :returns: The handle, or None if the document has none.
    """
    aliases = (
        did_document.get("alsoKnownAs")
        if isinstance(did_document, dict)
        else None
    )
    for entry in aliases if isinstance(aliases, list) else []:
        if (
            isinstance(entry, str)
            and entry.startswith(AT_URI_PREFIX)
            and len(entry) > len(AT_URI_PREFIX)
        ):
            return entry.removeprefix(AT_URI_PREFIX)
    return None


class HandleResolver:
    """
    Unverified handle lookup with an in-memory LRU + TTL cache.

    Never raises: any lookup failure resolves to None.
    """

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        ttl_seconds: float = CACHE_TTL_SECONDS,
        max_size: int = CACHE_MAX_SIZE,
        plc_url: str = DEFAULT_PLC_URL,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        Create a resolver.

        :param client: HTTP client to use; None creates one.
        :param ttl_seconds: how long a lookup result is cached.
        :param max_size: most DIDs kept in the cache.
        :param plc_url: the PLC directory to use for did:plc.
        :param clock: returns monotonic seconds (injected for tests).
        """
        self.client = client or httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS
        )
        self.ttl_seconds, self.max_size = ttl_seconds, max_size
        self.plc_url, self.clock = plc_url, clock
        self._cache: OrderedDict[str, tuple[float, str | None]] = OrderedDict()

    async def resolve(self, did: str) -> str | None:
        """Return the DID's handle (cached), or None if unknown."""
        cached_entry = self._cache.get(did)
        if cached_entry is not None and cached_entry[0] > self.clock():
            self._cache.move_to_end(did)
            return cached_entry[1]
        handle = await self._fetch(did)
        self._remember(did, handle)
        return handle

    async def _fetch(self, did: str) -> str | None:
        """Download the DID document and read the handle from it."""
        url = did_document_url(did, self.plc_url)
        if url is None:
            return None
        try:
            response = await self.client.get(
                url, timeout=REQUEST_TIMEOUT_SECONDS
            )
            response.raise_for_status()
            return handle_from_did_document(response.json())
        except (httpx.HTTPError, ValueError) as error:
            logger.info("handle resolution failed for %s: %r", did, error)
            return None

    def _remember(self, did: str, handle: str | None) -> None:
        """Cache a lookup result, evicting the least recently used."""
        self._cache[did] = (self.clock() + self.ttl_seconds, handle)
        self._cache.move_to_end(did)
        while len(self._cache) > self.max_size:
            self._cache.popitem(last=False)

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self.client.aclose()
