"""Defer a workspace's data allocation until its first data request."""
import threading


class LazyResource:
    def __init__(self, factory):
        self._factory = factory
        self._value = None
        self._lock = threading.Lock()

    def __getattr__(self, name):
        if self._value is None:
            with self._lock:
                if self._value is None:
                    self._value = self._factory()
        return getattr(self._value, name)
