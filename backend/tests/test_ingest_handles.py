"""
Tests for looking up account handles from DIDs (ingest/handles.py),
including caching and failures. The network is faked.
"""

from __future__ import annotations

import httpx

from ingest.handles import (
    HandleResolver,
    did_document_url,
    handle_from_did_document,
)


def resolver(
    handler: httpx.MockTransport,
    clock: list[float] | None = None,
    **resolver_options: object,
) -> HandleResolver:
    """
    Build a HandleResolver with a fake network and a controllable clock.

    :param handler: answers every HTTP request.
    :param clock: a one-item list holding the current time; tests change
        it to move time forward (default: always 0).
    :param resolver_options: other HandleResolver options, e.g. max_size.
    :returns: the resolver.
    """
    current_time = clock if clock is not None else [0.0]
    return HandleResolver(
        httpx.AsyncClient(transport=handler),
        clock=lambda: current_time[0],
        **resolver_options,  # type: ignore[arg-type]
    )


def did_document(handle: str) -> dict[str, object]:
    """
    Build a minimal DID document naming one handle.

    :param handle: the handle to put in alsoKnownAs.
    :returns: the document.
    """
    return {"id": "x", "alsoKnownAs": [f"at://{handle}"]}


def test_did_document_url() -> None:
    assert (
        did_document_url("did:plc:abc") == "https://plc.directory/did:plc:abc"
    )
    assert (
        did_document_url("did:web:example.com")
        == "https://example.com/.well-known/did.json"
    )
    assert (
        did_document_url("did:web:localhost%3A8080")
        == "https://localhost:8080/.well-known/did.json"
    )
    assert (
        did_document_url("did:web:ex.com:u:alice")
        == "https://ex.com/u/alice/did.json"
    )
    assert did_document_url("did:key:z6Mk") is None


def test_handle_from_did_document() -> None:
    assert (
        handle_from_did_document(
            {"alsoKnownAs": ["https://x", "at://alice.test"]}
        )
        == "alice.test"
    )
    assert handle_from_did_document({"alsoKnownAs": "at://nope"}) is None
    assert handle_from_did_document([]) is None


async def test_resolve_plc_and_web() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        """
        Serve a DID document from the PLC directory or from a did:web host.

        :param request: the request the client under test sent.
        :returns: alice.test's document from plc.directory, else
            bob.example.com's.
        """
        if request.url.host == "plc.directory":
            return httpx.Response(200, json=did_document("alice.test"))
        return httpx.Response(200, json=did_document("bob.example.com"))

    handle_resolver = resolver(httpx.MockTransport(handle))
    assert await handle_resolver.resolve("did:plc:alice") == "alice.test"
    assert (
        await handle_resolver.resolve("did:web:example.com")
        == "bob.example.com"
    )


async def test_failures_return_none() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        """
        Fail in a different way depending on the URL.

        :param request: the request the client under test sent.
        :returns: a 500 error, or an HTML page that is not JSON.
        :raises httpx.ConnectTimeout: for any other URL.
        """
        if "500" in str(request.url):
            return httpx.Response(500)
        if "junk" in str(request.url):
            return httpx.Response(200, text="<html>")
        raise httpx.ConnectTimeout("slow")

    handle_resolver = resolver(httpx.MockTransport(handle))
    assert await handle_resolver.resolve("did:plc:500") is None
    assert await handle_resolver.resolve("did:plc:junk") is None
    assert await handle_resolver.resolve("did:plc:timeout") is None
    assert await handle_resolver.resolve("did:key:abc") is None


async def test_cache_ttl_and_lru() -> None:
    calls: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        """
        Record the lookup and serve a document whose handle names the DID.

        :param request: the request the client under test sent.
        :returns: a DID document for handle "h" + the path's last character.
        """
        calls.append(request.url.path)
        return httpx.Response(
            200, json=did_document("h" + request.url.path[-1])
        )

    clock = [0.0]
    handle_resolver = resolver(
        httpx.MockTransport(handle), clock, ttl_seconds=10, max_size=2
    )
    await handle_resolver.resolve("did:plc:a")
    await handle_resolver.resolve("did:plc:a")
    assert len(calls) == 1
    clock[0] = 11
    await handle_resolver.resolve("did:plc:a")
    assert len(calls) == 2
    await handle_resolver.resolve("did:plc:b")
    await handle_resolver.resolve(
        "did:plc:c"
    )  # evicts a (least recently used)
    await handle_resolver.resolve("did:plc:b")
    assert len(calls) == 4
    await handle_resolver.resolve("did:plc:a")
    assert len(calls) == 5
