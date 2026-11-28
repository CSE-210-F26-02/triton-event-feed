"""
Data ingestion: where the events in our index come from.

  * jetstream.py: listens to the live AT Protocol network feed for event
    records that users create, edit or delete in their own accounts;
  * processor.py: decides what each of those changes means for our index;
  * ical.py: imports events from external calendar (.ics) feeds;
  * handles.py: looks up the username (handle) of an event's author.

New to the AT Protocol? Read the glossary first:
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md
"""
