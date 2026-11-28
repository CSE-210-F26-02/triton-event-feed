"""
Validators for this app's record types.

A "lexicon" is the AT Protocol word for a schema: it lists the fields a kind
of record may have, their types and their size limits (ours are in
lexicons/). The servers that store users' accounts do not check our
lexicons, so anything can arrive in a record; these validators reject what
does not fit. See docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md.
"""

from .event import EVENT_NSID, validate_event
from .subscription import SUBSCRIPTION_NSID, validate_subscription

__all__ = [
    "EVENT_NSID",
    "SUBSCRIPTION_NSID",
    "validate_event",
    "validate_subscription",
]
