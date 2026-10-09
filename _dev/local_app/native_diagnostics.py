"""Bounded local capture events; never record pixels or arbitrary keyboard text."""
from collections import deque
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import threading
import traceback
import uuid


class CaptureDiagnostics:
    def __init__(self, path):
        self.path = path
        self.events = deque(maxlen=30)
        self.error = None
        self.logger = logging.getLogger("bdo.capture." + uuid.uuid4().hex)
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(message)s"))
            self.logger.addHandler(handler)
        except OSError as exc:
            self.error = type(exc).__name__
        self.write("diagnostics_started", implementation="persistent-roi-f10-v2")

    def write(self, event, **fields):
        record = {"time": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(),
                  "thread": threading.current_thread().name, "event": event, **fields}
        self.events.append(record)
        self.logger.info(json.dumps(record, ensure_ascii=False))

    def exception(self, event, **fields):
        self.write(event, traceback=traceback.format_exc(), **fields)

    def snapshot(self):
        return {"path": str(self.path), "loggingError": self.error, "recent": list(self.events)}

    def close(self):
        for handler in list(self.logger.handlers):
            handler.close()
            self.logger.removeHandler(handler)
