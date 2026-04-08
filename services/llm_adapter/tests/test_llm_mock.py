from services.llm_adapter.providers.mock import MockProvider


def test_mock_classify_stable_json() -> None:
    provider = MockProvider()
    out = provider.classify({"text": "Créer un projet outil"})
    assert out["mode"] == "project-dev"
    assert "confidence" in out
