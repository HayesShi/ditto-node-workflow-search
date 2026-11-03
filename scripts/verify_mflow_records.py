"""Verify immutable stdin bytes using MFlow's published Python canonical JSON digest."""
import hashlib
import json
import sys


def verify(data, expected_count, expected_sha256):
    rows = [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]
    canonical = json.dumps(rows, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    if len(rows) != expected_count or digest != expected_sha256:
        raise ValueError("BFCL records differ from the pinned MFlow publication (content, membership or order)")
    ids = [row["id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate BFCL task ID")
    return {"count": len(rows), "recordsSha256": digest}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(sys.stdin.buffer.read(), int(sys.argv[1]), sys.argv[2])))
    except (ValueError, KeyError, UnicodeError) as error:
        sys.exit(str(error))
