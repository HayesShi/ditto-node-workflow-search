"""Exact port of MFlow 437040f src/provider-progress.ts stream cycle policy.

Use UTF-16 code units, matching JavaScript even for non-BMP content.
"""

class DegenerateOutputError(Exception):
    pass


def repeated_output(tail):
    if len(tail) < 8192:
        return False
    anchor = tail[-128:]
    previous = tail.rfind(anchor, 0, len(tail) - 1)
    while previous >= 0:
        period = len(tail) - 128 - previous
        if period > 32768:
            break
        span = max(8192, period * 8)
        if len(tail) >= span + period:
            if tail[-span:] == tail[len(tail) - span - period:len(tail) - period]:
                return True
        previous = tail.rfind(anchor, 0, previous + 127)
    return False


class RepetitionGuard:
    def __init__(self):
        self.channels = {}

    def feed(self, key, delta):
        if not delta:
            return
        encoded = delta.encode('utf-16-le', errors='surrogatepass')
        units = ''.join(chr(encoded[i] | encoded[i + 1] << 8) for i in range(0, len(encoded), 2))
        channel = self.channels.setdefault(key, {'tail': '', 'chars': 0, 'checked': 0})
        channel['tail'] = (channel['tail'] + units)[-524288:]
        channel['chars'] += len(units)
        if channel['chars'] - channel['checked'] >= 4096:
            channel['checked'] = channel['chars']
            if repeated_output(channel['tail']):
                raise DegenerateOutputError(f'Exact repeated output cycle in {key}')
