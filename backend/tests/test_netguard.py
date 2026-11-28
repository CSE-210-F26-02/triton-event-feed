"""
Tests for the SSRF guard (utils/netguard.py), which refuses URLs that
point at private or local hosts.
"""

import socket

from utils.netguard import is_public_url


def fake_resolver(ip_address: str):
    """
    Build a fake socket.getaddrinfo that resolves every host to one address.

    :param ip_address: the address every host resolves to.
    :returns: the fake resolver.
    """

    def resolve(host, port, proto=0):
        """
        Resolve any host to the fixed address.

        :param host: ignored.
        :param port: the port, passed through.
        :param proto: the protocol, passed through.
        :returns: one getaddrinfo-style result.
        """
        return [
            (socket.AF_INET, socket.SOCK_STREAM, proto, "", (ip_address, port))
        ]

    return resolve


def test_public_host_allowed():
    assert is_public_url(
        "https://calendar.ucsd.edu/x.ics", fake_resolver("132.239.180.101")
    )


def test_private_and_loopback_hosts_rejected():
    for ip_address in (
        "127.0.0.1",
        "10.0.0.5",
        "169.254.169.254",
        "192.168.1.1",
    ):
        assert not is_public_url(
            "http://internal/x.ics", fake_resolver(ip_address)
        )


def test_non_http_scheme_rejected():
    assert not is_public_url("file:///etc/passwd", fake_resolver("8.8.8.8"))


def test_unresolvable_host_rejected():
    def failing_resolve(*args, **kwargs):
        """
        Fail like a DNS lookup for a host that does not exist.

        :param args: ignored.
        :param kwargs: ignored.
        :raises OSError: always.
        """
        raise OSError("nope")

    assert not is_public_url("https://nope.invalid/", failing_resolve)
