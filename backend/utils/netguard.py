"""
SSRF guard: only allow fetching URLs whose host resolves to public IP
addresses.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = ("http", "https")
DEFAULT_PORT = 443
# getaddrinfo() returns (family, type, proto, canonname, sockaddr) tuples;
# sockaddr[0] is the IP address.
SOCKADDR_INDEX = 4
IPV6_ZONE_SEPARATOR = "%"


def is_public_url(url: str, resolve=socket.getaddrinfo) -> bool:
    """
    True when url is http(s) and every address of its host is public.

    Args:
        url: the URL about to be fetched.
        resolve: DNS lookup function (injected so tests need no network).

    Returns:
        False for other schemes, unresolvable hosts, or any private,
        loopback or link-local address.
    """
    parts = urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES or not parts.hostname:
        return False
    try:
        address_infos = resolve(
            parts.hostname,
            parts.port or DEFAULT_PORT,
            proto=socket.IPPROTO_TCP,
        )
    except (OSError, UnicodeError):
        return False
    addresses = {
        ipaddress.ip_address(
            address_info[SOCKADDR_INDEX][0].split(IPV6_ZONE_SEPARATOR)[0]
        )
        for address_info in address_infos
    }
    return bool(addresses) and all(address.is_global for address in addresses)
