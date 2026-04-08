from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class LLMProvider(ABC):
    @abstractmethod
    def classify(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    @abstractmethod
    def project_step(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    @abstractmethod
    def summarize_logs(self, payload: dict[str, Any]) -> dict[str, Any]: ...
