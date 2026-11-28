"""
Look up an account's username (handle) from its permanent id (DID).

Background for newcomers (full glossary:
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md):
    Every account on the AT Protocol network has

        * a DID, a permanent id such as "did:plc:ab12cd34" that never
            changes, and
        * a handle, a readable username such as "tritonfood.bsky.social"
            that the user can change at any time.

Event records only name their author by DID, but people want to see "by
@tritonfood.bsky.social", so we look the handle up. Each DID points to a
small JSON "DID document" (the account's contact card) whose "alsoKnownAs"
list holds the handle. Where that document lives depends on the DID's kind:

  * did:plc:... ids are listed in the public directory at plc.directory;
  * did:web:<domain> ids publish their document on that domain's website,
    at https://<domain>/.well-known/did.json.
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
    Where to download an account's DID document (its contact card).

    :param did: the account id, either "did:plc:..." or "did:web:...".
    :param plc_url: the PLC directory (the public lookup service for
        did:plc ids).
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
    Read the account's handle out of its DID document.

    The handle is the first "alsoKnownAs" entry that starts with "at://",
    e.g. "at://tritonfood.bsky.social" gives "tritonfood.bsky.social".

    :param did_document: the decoded DID document (untrusted; may be
        malformed).
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
    Look up account handles, remembering recent answers.

    Results are cached in memory for ttl_seconds, and the least recently
    used entries are dropped once max_size accounts are cached. The handle
    is not verified (a full check would also ask the handle's domain to
    confirm the DID); it is only used for display.

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
        :param max_size: most accounts kept in the cache.
        :param plc_url: the PLC directory (the public lookup service for
            did:plc ids).
        :param clock: returns monotonic seconds (injected for tests).
        """

        self.client = client or httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS
        )
        self.ttl_seconds, self.max_size = ttl_seconds, max_size
        self.plc_url, self.clock = plc_url, clock
        self._cache: OrderedDict[str, tuple[float, str | None]] = OrderedDict()

    async def resolve(self, did: str) -> str | None:
        """
        Return an account's handle, from the cache when possible.

        :param did: the account's permanent id.
        :returns: the handle, or None if it cannot be found.
        """

        cached_entry = self._cache.get(did)
        if cached_entry is not None and cached_entry[0] > self.clock():
            self._cache.move_to_end(did)
            return cached_entry[1]
        handle = await self._fetch(did)
        self._remember(did, handle)
        return handle

    async def _fetch(self, did: str) -> str | None:
        """
        Download the account's DID document and read the handle from it.

        :param did: the account's permanent id.
        :returns: the handle, or None when the lookup fails.
        """

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
        """
        Cache a lookup result, dropping the least recently used entry.

        :param did: the account's permanent id.
        :param handle: its handle, or None (failures are cached too, so a
            missing account is not looked up again on every event).
        """

        self._cache[did] = (self.clock() + self.ttl_seconds, handle)
        self._cache.move_to_end(did)
        while len(self._cache) > self.max_size:
            self._cache.popitem(last=False)

    async def aclose(self) -> None:
        """
        Close the HTTP client.
        """
        await self.client.aclose()
