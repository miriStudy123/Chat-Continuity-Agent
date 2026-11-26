import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from backend import graph as graph_module
from backend import server as server_module
from backend.app import create_initial_state
from backend.graph import build_graph
from backend.storage import save_approved_state

os.environ["LANGSMITH_TRACING"] = "false"


def analysis_result(project_goal: str = "Synthetic goal") -> dict:
    return {
        "project_goal": project_goal,
        "important_context": ["Synthetic context"],
        "decisions": [{"decision": "Synthetic choice", "reason": "Synthetic reason"}],
        "technologies": ["Python"],
        "files_and_components": ["backend/graph.py"],
        "completed_tasks": ["Synthetic completed task"],
        "open_tasks": ["Synthetic open task"],
        "stopping_point": "Synthetic stopping point",
        "next_action": "Synthetic next action",
    }


class FakeModels:
    def __init__(self, results: list[dict]):
        self.results = iter(results)
        self.calls = 0

    def generate_content(self, **kwargs):
        self.calls += 1
        return SimpleNamespace(text=json.dumps(next(self.results)))


class FakeClient:
    def __init__(self, results: list[dict]):
        self.models = FakeModels(results)


class GraphWorkflowTests(unittest.TestCase):
    def test_quality_retries_once_then_pauses_with_warning(self):
        invalid_result = analysis_result(project_goal="")
        client = FakeClient([invalid_result, invalid_result])

        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint_path = Path(temporary_directory) / "checkpoints.sqlite"
            with SqliteSaver.from_conn_string(str(checkpoint_path)) as checkpointer:
                graph = build_graph(checkpointer)
                self.assertTrue(
                    {
                        "validate_conversation",
                        "analyze_conversation",
                        "check_analysis_quality",
                        "prepare_review",
                        "request_human_approval",
                        "save_approved_state",
                    }.issubset(graph.get_graph().nodes)
                )
                with patch.object(
                    graph_module,
                    "create_gemini_client",
                    return_value=client,
                ):
                    result = graph.invoke(
                        create_initial_state("Synthetic conversation"),
                        config={"configurable": {"thread_id": "retry-thread"}},
                    )

                self.assertEqual(client.models.calls, 2)
                self.assertEqual(result["analysis_attempts"], 2)
                self.assertFalse(result["quality_passed"])
                self.assertEqual(len(result["__interrupt__"]), 1)
                self.assertIn("Quality warning:", result["summary"])
                checkpointer.delete_thread("retry-thread")

    def test_rejection_does_not_save_state(self):
        client = FakeClient([analysis_result()])

        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint_path = Path(temporary_directory) / "checkpoints.sqlite"
            with SqliteSaver.from_conn_string(str(checkpoint_path)) as checkpointer:
                graph = build_graph(checkpointer)
                config = {"configurable": {"thread_id": "rejected-thread"}}
                with (
                    patch.object(
                        graph_module,
                        "create_gemini_client",
                        return_value=client,
                    ),
                    patch.object(graph_module, "save_approved_state") as save,
                ):
                    graph.invoke(
                        create_initial_state("Synthetic conversation"),
                        config=config,
                    )
                    result = graph.invoke(
                        Command(resume={"approved": False}),
                        config=config,
                    )

                save.assert_not_called()
                self.assertIs(result["approved"], False)
                checkpointer.delete_thread("rejected-thread")

    def test_server_resumes_after_restart_and_saves_approved_state(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "projects.sqlite"
            client = FakeClient([analysis_result()])
            extension_origin = "chrome-extension://" + "a" * 32
            save_to_test_database = lambda state: save_approved_state(
                state,
                database_path,
            )

            with (
                patch.object(server_module, "DATABASE_PATH", database_path),
                patch.object(server_module, "EXTENSION_ORIGIN", extension_origin),
                patch.object(
                    graph_module,
                    "create_gemini_client",
                    return_value=client,
                ),
                patch.object(
                    graph_module,
                    "save_approved_state",
                    side_effect=save_to_test_database,
                ),
            ):
                with TestClient(server_module.app) as first_server:
                    start_response = first_server.post(
                        "/conversations",
                        json={"conversation_text": "Synthetic conversation"},
                        headers={"Origin": extension_origin},
                    )

                self.assertEqual(start_response.status_code, 202)
                start_result = start_response.json()
                self.assertEqual(start_result["status"], "awaiting_approval")
                thread_id = start_result["thread_id"]

                with closing(sqlite3.connect(database_path)) as connection:
                    saved_table = connection.execute(
                        """
                        SELECT name FROM sqlite_master
                        WHERE type = 'table' AND name = 'project_states'
                        """
                    ).fetchone()
                self.assertIsNone(saved_table)

                with TestClient(server_module.app) as restarted_server:
                    pending_response = restarted_server.get(
                        f"/conversations/{thread_id}",
                        headers={"Origin": extension_origin},
                    )
                    approval_response = restarted_server.post(
                        f"/conversations/{thread_id}/approval",
                        json={"approved": True},
                        headers={"Origin": extension_origin},
                    )

            self.assertEqual(approval_response.status_code, 200)
            self.assertEqual(approval_response.json()["status"], "saved")
            self.assertEqual(pending_response.status_code, 200)
            self.assertEqual(
                pending_response.json()["status"],
                "awaiting_approval",
            )
            with closing(sqlite3.connect(database_path)) as connection:
                rows = connection.execute(
                    "SELECT state_json FROM project_states"
                ).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertNotIn("conversation_text", rows[0][0])
            self.assertIn("continuation_prompt", rows[0][0])

    def test_server_rejects_non_extension_origin(self):
        extension_origin = "chrome-extension://" + "a" * 32
        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint_path = Path(temporary_directory) / "checkpoints.sqlite"
            with (
                patch.object(server_module, "DATABASE_PATH", checkpoint_path),
                patch.object(server_module, "EXTENSION_ORIGIN", extension_origin),
                TestClient(server_module.app) as client,
            ):
                response = client.get(
                    "/conversations/00000000-0000-0000-0000-000000000000",
                    headers={"Origin": "https://example.com"},
                )
        self.assertEqual(response.status_code, 403)

    def test_singleton_storage_replaces_previous_state(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "projects.sqlite"
            first_state = create_initial_state("First synthetic conversation")
            first_state.update(
                approved=True,
                continuation_prompt="First synthetic prompt",
            )
            second_state = create_initial_state("Second synthetic conversation")
            second_state.update(
                approved=True,
                continuation_prompt="Second synthetic prompt",
            )

            with self.assertRaises(PermissionError):
                save_approved_state(create_initial_state("Unapproved"), database_path)
            save_approved_state(first_state, database_path)
            save_approved_state(second_state, database_path)

            with closing(sqlite3.connect(database_path)) as connection:
                rows = connection.execute(
                    "SELECT id, state_json FROM project_states"
                ).fetchall()

            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0][0], 1)
            self.assertIn("Second synthetic prompt", rows[0][1])
            self.assertNotIn("First synthetic prompt", rows[0][1])
            self.assertNotIn("conversation_text", rows[0][1])


class FailingModels:
    def __init__(self, error: Exception):
        self.error = error
        self.calls = 0

    def generate_content(self, **kwargs):
        self.calls += 1
        raise self.error


class RecordingModels(FakeModels):
    def generate_content(self, **kwargs):
        self.last_kwargs = kwargs
        return super().generate_content(**kwargs)


EXTENSION_ID = "a" * 32
EXTENSION_ORIGIN = "chrome-extension://" + EXTENSION_ID


class ReliabilityAndOriginTests(unittest.TestCase):
    def server(self, gemini_client) -> TestClient:
        # Registered first so it is cleaned up last, after the server closes
        # its SQLite connection (Windows cannot delete an open file).
        temporary_directory = self.enterContext(tempfile.TemporaryDirectory())
        database_path = Path(temporary_directory) / "projects.sqlite"
        self.enterContext(patch.object(server_module, "DATABASE_PATH", database_path))
        self.enterContext(
            patch.object(server_module, "EXTENSION_ORIGIN", EXTENSION_ORIGIN)
        )
        self.enterContext(
            patch.object(
                graph_module, "create_gemini_client", return_value=gemini_client
            )
        )
        return self.enterContext(TestClient(server_module.app))

    def test_gemini_503_returns_hebrew_json_error_and_cleans_thread(self):
        from google.genai.errors import ServerError

        error = ServerError(503, {"error": {"code": 503, "status": "UNAVAILABLE"}})
        gemini_client = SimpleNamespace(models=FailingModels(error))
        thread_id = "11111111-2222-4333-8444-555555555555"
        client = self.server(gemini_client)
        response = client.post(
            "/conversations",
            json={"conversation_text": "Synthetic", "thread_id": thread_id},
            headers={"Origin": EXTENSION_ORIGIN},
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("Gemini עמוס", response.json()["detail"])
        pending = client.get(
            f"/conversations/{thread_id}",
            headers={"Origin": EXTENSION_ORIGIN},
        )
        self.assertEqual(pending.status_code, 404)

    def test_invalid_gemini_output_returns_json_error(self):
        broken = analysis_result()
        del broken["next_action"]
        client = self.server(FakeClient([broken]))
        response = client.post(
            "/conversations",
            json={"conversation_text": "Synthetic"},
            headers={"Origin": EXTENSION_ORIGIN},
        )
        self.assertEqual(response.status_code, 502)
        self.assertIn("במבנה לא צפוי", response.json()["detail"])

    def test_client_thread_id_is_used_and_duplicates_are_rejected(self):
        thread_id = "22222222-3333-4444-8555-666666666666"
        client = self.server(FakeClient([analysis_result()] * 2))
        body = {"conversation_text": "Synthetic", "thread_id": thread_id}
        first = client.post(
            "/conversations", json=body, headers={"Origin": EXTENSION_ORIGIN}
        )
        second = client.post(
            "/conversations", json=body, headers={"Origin": EXTENSION_ORIGIN}
        )
        server_module.app.state.checkpointer.delete_thread(thread_id)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json()["thread_id"], thread_id)
        self.assertEqual(second.status_code, 409)

    def test_pending_endpoint_reports_processing_while_analysis_runs(self):
        thread_id = "33333333-4444-4555-8666-777777777777"
        client = self.server(FakeClient([]))
        server_module.app.state.running_threads.add(thread_id)
        try:
            response = client.get(
                f"/conversations/{thread_id}",
                headers={"Origin": EXTENSION_ORIGIN},
            )
        finally:
            server_module.app.state.running_threads.discard(thread_id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "processing")

    def test_origin_and_extension_header_rules(self):
        path = "/conversations/00000000-0000-0000-0000-000000000000"
        cases = [
            ({"Origin": EXTENSION_ORIGIN}, 404),
            # Chrome may omit Origin on extension GETs; the ID header is used.
            ({"X-Chat-Continuity-Extension": EXTENSION_ID}, 404),
            ({}, 403),
            ({"X-Chat-Continuity-Extension": "b" * 32}, 403),
            # A present but foreign Origin is always refused, even with the header.
            (
                {
                    "Origin": "https://example.com",
                    "X-Chat-Continuity-Extension": EXTENSION_ID,
                },
                403,
            ),
        ]
        client = self.server(FakeClient([]))
        for headers, expected_status in cases:
            with self.subTest(headers=headers):
                response = client.get(path, headers=headers)
                self.assertEqual(response.status_code, expected_status)
                self.assertIn("detail", response.json())

    def test_analysis_requests_structured_output(self):
        client = FakeClient([analysis_result()])
        client.models = RecordingModels([analysis_result()])
        with patch.object(graph_module, "create_gemini_client", return_value=client):
            graph_module.analyze_conversation_node(
                create_initial_state("Synthetic conversation")
            )
        config = client.models.last_kwargs["config"]
        self.assertEqual(config["response_mime_type"], "application/json")
        self.assertEqual(
            set(config["response_json_schema"]["required"]),
            set(analysis_result()),
        )

    def test_gemini_client_has_timeout_and_limited_retries(self):
        from backend import gemini_client

        with (
            patch.object(gemini_client, "load_dotenv"),
            patch.dict(os.environ, {"GEMINI_API_KEY": "synthetic-test-value"}),
        ):
            client = gemini_client.create_gemini_client()
        options = client._api_client._http_options
        self.assertEqual(options.timeout, gemini_client.GEMINI_TIMEOUT_MS)
        self.assertEqual(
            options.retry_options.attempts, gemini_client.GEMINI_RETRY_ATTEMPTS
        )
        self.assertIn(503, options.retry_options.http_status_codes)


class ScriptedModels:
    """Fake Gemini models: per model name, an exception to raise or a result."""

    def __init__(self, outcomes: dict):
        self.outcomes = outcomes
        self.called = []

    def generate_content(self, **kwargs):
        self.called.append(kwargs["model"])
        outcome = self.outcomes[kwargs["model"]]
        if isinstance(outcome, Exception):
            raise outcome
        return SimpleNamespace(text=json.dumps(outcome))


class GeminiFallbackTests(unittest.TestCase):
    MAIN = "main-model"
    BACKUP = "backup-model"

    def analyze(self, outcomes: dict):
        models = ScriptedModels(outcomes)
        with (
            patch.object(graph_module, "GEMINI_MODEL", self.MAIN),
            patch.object(graph_module, "GEMINI_FALLBACK_MODELS", [self.BACKUP]),
            patch.object(
                graph_module,
                "create_gemini_client",
                return_value=SimpleNamespace(models=models),
            ),
        ):
            try:
                return graph_module.analyze_conversation_node(
                    create_initial_state("Synthetic conversation")
                ), models.called
            except Exception as exc:
                return exc, models.called

    @staticmethod
    def api_error(code: int):
        from google.genai.errors import ClientError, ServerError

        error_class = ServerError if code >= 500 else ClientError
        return error_class(code, {"error": {"code": code, "status": "SYNTHETIC"}})

    def test_overloaded_main_model_falls_back_to_backup(self):
        result, called = self.analyze(
            {self.MAIN: self.api_error(503), self.BACKUP: analysis_result()}
        )
        self.assertEqual(called, [self.MAIN, self.BACKUP])
        self.assertEqual(result["project_goal"], "Synthetic goal")

    def test_main_model_success_never_calls_backup(self):
        result, called = self.analyze(
            {self.MAIN: analysis_result(), self.BACKUP: self.api_error(503)}
        )
        self.assertEqual(called, [self.MAIN])
        self.assertEqual(result["project_goal"], "Synthetic goal")

    def test_non_overload_errors_do_not_fall_back(self):
        for code, expected_text in ((429, "מכסת"), (403, "הרשאה")):
            with self.subTest(code=code):
                error, called = self.analyze(
                    {self.MAIN: self.api_error(code), self.BACKUP: analysis_result()}
                )
                self.assertEqual(called, [self.MAIN])
                self.assertIsInstance(error, graph_module.GeminiAnalysisError)
                self.assertIn(expected_text, error.user_message)

    def test_all_models_overloaded_reports_hebrew_503(self):
        error, called = self.analyze(
            {self.MAIN: self.api_error(503), self.BACKUP: self.api_error(503)}
        )
        self.assertEqual(called, [self.MAIN, self.BACKUP])
        self.assertIsInstance(error, graph_module.GeminiAnalysisError)
        self.assertEqual(error.status_code, 503)
        self.assertIn("מודל הגיבוי", error.user_message)

    def test_configured_fallback_is_a_different_gemini_model(self):
        from backend import gemini_client

        self.assertTrue(gemini_client.GEMINI_FALLBACK_MODELS)
        self.assertNotIn(gemini_client.GEMINI_MODEL, gemini_client.GEMINI_FALLBACK_MODELS)
        for model in gemini_client.GEMINI_FALLBACK_MODELS:
            self.assertTrue(model.startswith("gemini-"))


class ExtensionIdConfigurationTests(unittest.TestCase):
    def test_missing_id_uses_installed_extension_default(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                origin, source = server_module.resolve_extension_origin(value)
                self.assertEqual(
                    origin,
                    "chrome-extension://" + server_module.DEFAULT_EXTENSION_ID,
                )
                self.assertEqual(source, "built-in default")

    def test_configured_id_overrides_default_and_is_cleaned(self):
        for value in ("b" * 32, f"  {'b' * 32}  ", f'"{"b" * 32}"'):
            with self.subTest(value=value):
                origin, source = server_module.resolve_extension_origin(value)
                self.assertEqual(origin, "chrome-extension://" + "b" * 32)
                self.assertEqual(source, "CHAT_CONTINUITY_EXTENSION_ID")

    def test_invalid_configured_id_is_refused_not_replaced(self):
        for value in ("not-an-id", "z" * 32, "a" * 31):
            with self.subTest(value=value):
                origin, _ = server_module.resolve_extension_origin(value)
                self.assertIsNone(origin)

    def test_default_id_matches_the_installed_extension(self):
        self.assertEqual(
            server_module.DEFAULT_EXTENSION_ID, "hbkpkoiedabdkllahbnpfhkfbncijnei"
        )


if __name__ == "__main__":
    unittest.main()
