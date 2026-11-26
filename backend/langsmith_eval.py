from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
import os
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

from dotenv import load_dotenv

PROJECT_NAME = "Chat-Continuity-Agent"
DATASET_NAME = "Chat-Continuity-Agent-Synthetic-Context-v1"
ANALYSIS_FIELDS = (
    "project_goal",
    "important_context",
    "decisions",
    "technologies",
    "files_and_components",
    "completed_tasks",
    "open_tasks",
    "stopping_point",
    "next_action",
)

CASES = (
    {
        "inputs": {
            "case_id": "temperature-cli",
            "conversation_text": (
                "User: Build a Python command-line temperature converter.\n"
                "Assistant: Use only the standard library.\n"
                "User: The scope is Celsius to Fahrenheit; implement and test "
                "the conversion function next."
            ),
        },
        "outputs": {
            "project_goal": "Build a Python command-line temperature converter.",
            "important_context": ["Convert Celsius to Fahrenheit."],
            "decisions": [
                {
                    "decision": "Use only the Python standard library.",
                    "reason": "Keep the command-line tool dependency-free.",
                }
            ],
            "technologies": ["Python"],
            "files_and_components": [],
            "completed_tasks": ["Defined the conversion scope."],
            "open_tasks": ["Implement and test the conversion function."],
            "stopping_point": "The scope and dependency decision are agreed.",
            "next_action": "Implement and test Celsius-to-Fahrenheit conversion.",
        },
    },
    {
        "inputs": {
            "case_id": "local-bookmarks",
            "conversation_text": (
                "User: Build a local bookmark manager with FastAPI and SQLite.\n"
                "Assistant: Store data locally in SQLite rather than in a cloud "
                "service for privacy.\n"
                "User: The schema and list endpoint are complete; implement "
                "deleting a bookmark next."
            ),
        },
        "outputs": {
            "project_goal": "Build a local bookmark manager.",
            "important_context": ["Bookmark data stays on the local machine."],
            "decisions": [
                {
                    "decision": "Use SQLite instead of cloud storage.",
                    "reason": "Keep bookmark data local for privacy.",
                }
            ],
            "technologies": ["FastAPI", "SQLite"],
            "files_and_components": ["Database schema", "List endpoint"],
            "completed_tasks": ["Created the schema", "Implemented the list endpoint"],
            "open_tasks": ["Implement bookmark deletion."],
            "stopping_point": "The schema and list endpoint are complete.",
            "next_action": "Implement and test the delete endpoint.",
        },
    },
)

CASES_BY_ID = {case["inputs"]["case_id"]: case for case in CASES}


def _validate_settings() -> None:
    load_dotenv(dotenv_path=Path(__file__).with_name(".env"))
    if os.environ.get("LANGSMITH_TRACING", "").strip().lower() not in {
        "true",
        "1",
        "yes",
        "on",
    }:
        raise RuntimeError("Enable LANGSMITH_TRACING in backend/.env")
    if os.environ.get("LANGSMITH_PROJECT") != PROJECT_NAME:
        raise RuntimeError("Set LANGSMITH_PROJECT to Chat-Continuity-Agent")


def _invoke_graph(
    conversation_text: str,
    reference: dict[str, Any],
    *,
    retry_enabled: bool,
    run_name: str,
    run_id: UUID | None = None,
    trace_client: Any = None,
) -> dict[str, Any]:
    from langgraph.checkpoint.memory import MemorySaver
    from langsmith import tracing_context

    from backend import graph as graph_module
    from backend.app import create_initial_state
    from backend.graph import build_graph

    analysis_calls = 0

    def local_analysis(_state: dict[str, Any]) -> dict[str, Any]:
        nonlocal analysis_calls
        analysis_calls += 1
        result = deepcopy(reference)
        if analysis_calls == 1:
            result["project_goal"] = ""
        return result

    with ExitStack() as stack:
        stack.enter_context(
            patch.object(
                graph_module,
                "analyze_conversation_node",
                side_effect=local_analysis,
            )
        )
        if not retry_enabled:
            stack.enter_context(
                patch.object(
                    graph_module,
                    "route_after_quality",
                    return_value="continue",
                )
            )

        graph = build_graph(MemorySaver())
        config: dict[str, Any] = {
            "configurable": {"thread_id": str(uuid4())},
            "run_name": run_name,
            "metadata": {
                "evaluation_mode": "synthetic_mock",
                "uses_gemini": False,
            },
        }
        if run_id is not None:
            config["run_id"] = run_id

        if trace_client is None:
            result = graph.invoke(
                create_initial_state(conversation_text),
                config=config,
            )
        else:
            with tracing_context(
                enabled=True,
                project_name=PROJECT_NAME,
                client=trace_client,
                metadata={
                    "evaluation_mode": "synthetic_mock",
                    "uses_gemini": False,
                },
            ):
                result = graph.invoke(
                    create_initial_state(conversation_text),
                    config=config,
                )

    if not result.get("__interrupt__"):
        raise RuntimeError("Synthetic LangGraph run did not reach the approval interrupt")

    return {
        **{field: result[field] for field in ANALYSIS_FIELDS},
        "quality_passed": result["quality_passed"],
        "analysis_attempts": result["analysis_attempts"],
    }


def _ensure_dataset(
    client: Any,
    dataset_name: str = DATASET_NAME,
    cases: tuple[dict[str, Any], ...] = CASES,
    description: str = (
        "Synthetic-only context extraction examples for testing the "
        "existing LangGraph quality retry. Contains no real conversations."
    ),
) -> tuple[Any, int]:
    dataset = next(
        iter(client.list_datasets(dataset_name=dataset_name, limit=1)),
        None,
    )
    if dataset is None:
        dataset = client.create_dataset(dataset_name, description=description)

    existing_ids = {
        example.inputs.get("case_id")
        for example in client.list_examples(dataset_id=dataset.id, limit=100)
        if isinstance(example.inputs, dict)
    }
    missing_cases = [
        {"inputs": case["inputs"], "outputs": case["outputs"]}
        for case in cases
        if case["inputs"]["case_id"] not in existing_ids
    ]
    if missing_cases:
        client.create_examples(dataset_id=dataset.id, examples=missing_cases)

    examples = list(client.list_examples(dataset_id=dataset.id, limit=100))
    expected_ids = {case["inputs"]["case_id"] for case in cases}
    actual_ids = {
        example.inputs.get("case_id")
        for example in examples
        if isinstance(example.inputs, dict)
    }
    if not expected_ids.issubset(actual_ids):
        raise RuntimeError("LangSmith synthetic dataset is missing expected examples")
    return dataset, len(expected_ids)


def _exact_field_evaluator(run: Any, example: Any) -> dict[str, Any]:
    prediction = run.outputs or {}
    reference = example.outputs or {}
    matches = sum(
        prediction.get(field) == reference.get(field)
        for field in ANALYSIS_FIELDS
    )
    return {
        "key": "exact_extraction_fields",
        "score": matches / len(ANALYSIS_FIELDS),
        "comment": f"Matched {matches} of {len(ANALYSIS_FIELDS)} synthetic fields.",
    }


def _run_evaluation(client: Any, *, retry_enabled: bool, experiment_prefix: str):
    def target(inputs: dict[str, Any]) -> dict[str, Any]:
        case = CASES_BY_ID[inputs["case_id"]]
        return _invoke_graph(
            inputs["conversation_text"],
            case["outputs"],
            retry_enabled=retry_enabled,
            run_name=experiment_prefix,
        )

    from langsmith import evaluate

    return evaluate(
        target,
        data=DATASET_NAME,
        evaluators=[_exact_field_evaluator],
        client=client,
        experiment_prefix=experiment_prefix,
        description=(
            "Synthetic-only comparison of the existing graph quality retry. "
            "The analyzer is locally stubbed; Gemini is not called."
        ),
        metadata={
            "evaluation_mode": "synthetic_mock",
            "uses_gemini": False,
            "quality_retry_enabled": retry_enabled,
        },
        max_concurrency=1,
        disable_evaluator_tracing=True,
    )


def _mean_score(results: Any) -> float:
    scores = [
        metric.score
        for row in results
        for metric in row["evaluation_results"].get("results", [])
        if metric.key == "exact_extraction_fields"
        and isinstance(metric.score, (int, float))
    ]
    if not scores:
        raise RuntimeError("LangSmith evaluation returned no exact-field scores")
    return sum(scores) / len(scores)


def _verify_trace(client: Any, trace_id: UUID, timeout_seconds: float = 60) -> Any:
    import time

    from langsmith.utils import LangSmithNotFoundError

    client.flush()
    # LangSmith ingests runs asynchronously; a just-flushed run can briefly 404.
    deadline = time.monotonic() + timeout_seconds
    delay = 1.0
    while True:
        try:
            return client.read_run(trace_id)
        except LangSmithNotFoundError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 8.0)


# ---------------------------------------------------------------------------
# Real Gemini evaluation (synthetic conversations only).
#
# The mock mode above checks the graph mechanics with a stubbed analyzer. This
# mode runs the real analyze_conversation_node against Gemini, so it measures
# actual extraction quality. Because the conversations are invented, sending
# them to Gemini and tracing them in LangSmith exposes no user data.
# Reference outputs hold checkable facts (keywords), not exact strings, since
# a real model never reproduces a reference sentence word for word.
# ---------------------------------------------------------------------------

GEMINI_DATASET_NAME = "Chat-Continuity-Agent-Synthetic-Gemini-v1"

GEMINI_CASES = (
    {
        "inputs": {
            "case_id": "temperature-cli",
            "conversation_text": CASES_BY_ID["temperature-cli"]["inputs"][
                "conversation_text"
            ],
        },
        "outputs": {
            "language": "en",
            "technologies": ["Python"],
            "files": [],
            "next_action_keywords": ["conversion", "convert", "test"],
            "forbidden_technologies": ["JavaScript", "React", "Django"],
        },
    },
    {
        "inputs": {
            "case_id": "local-bookmarks",
            "conversation_text": CASES_BY_ID["local-bookmarks"]["inputs"][
                "conversation_text"
            ],
        },
        "outputs": {
            "language": "en",
            "technologies": ["FastAPI", "SQLite"],
            "files": [],
            "next_action_keywords": ["delet"],
            "forbidden_technologies": ["PostgreSQL", "MongoDB", "Firebase"],
        },
    },
    {
        "inputs": {
            "case_id": "he-shopping-list",
            "conversation_text": (
                "משתמשת: אני בונה אפליקציית רשימת קניות ב-React עם Firebase.\n"
                "עוזר: מומלץ להשתמש ב-Firestore כי צריך סנכרון בזמן אמת בין "
                "בני המשפחה.\n"
                "משתמשת: מסכימה. סיימתי את מסך ההתחברות ואת הקובץ "
                "ShoppingList.jsx. השלב הבא הוא מחיקת פריט מהרשימה."
            ),
        },
        "outputs": {
            "language": "he",
            "technologies": ["React", "Firebase", "Firestore"],
            "files": ["ShoppingList.jsx"],
            "next_action_keywords": ["מחיק", "מחק"],
            "forbidden_technologies": ["Angular", "MongoDB", "Vue"],
        },
    },
    {
        "inputs": {
            "case_id": "he-telegram-bot",
            "conversation_text": (
                "משתמשת: אני כותבת בוט טלגרם ב-Python שמזכיר לי לשתות מים.\n"
                "עוזר: נשתמש בספרייה python-telegram-bot ונשמור את התזכורות "
                "ב-SQLite כדי שלא יימחקו כשהבוט מופעל מחדש.\n"
                "משתמשת: הקובץ bot.py כבר עובד ומגיב לפקודה /start. עוד לא "
                "התחלתי את התזמון. עצרנו כאן; הצעד הבא הוא להוסיף תזמון "
                "תזכורת כל שעה."
            ),
        },
        "outputs": {
            "language": "he",
            "technologies": ["Python", "python-telegram-bot", "SQLite"],
            "files": ["bot.py"],
            "next_action_keywords": ["תזמון", "תזכורת", "שעה"],
            "forbidden_technologies": ["Node", "Redis", "Docker"],
        },
    },
)

GEMINI_CASES_BY_ID = {case["inputs"]["case_id"]: case for case in GEMINI_CASES}


def _contains_hebrew(text: str) -> bool:
    return any("֐" <= character <= "׿" for character in text)


def _gemini_metric(key: str, score: float | None, comment: str) -> dict[str, Any]:
    return {"key": key, "score": score, "comment": comment}


def _required_fields_evaluator(run: Any, example: Any) -> dict[str, Any]:
    prediction = run.outputs or {}
    required = ("project_goal", "stopping_point", "next_action")
    filled = [
        field
        for field in required
        if isinstance(prediction.get(field), str) and prediction[field].strip()
    ]
    return _gemini_metric(
        "required_fields_filled",
        len(filled) / len(required),
        f"Filled {len(filled)} of {len(required)} required fields.",
    )


def _technology_recall_evaluator(run: Any, example: Any) -> dict[str, Any]:
    predicted = " | ".join((run.outputs or {}).get("technologies", [])).lower()
    expected = (example.outputs or {}).get("technologies", [])
    found = [item for item in expected if item.lower() in predicted]
    return _gemini_metric(
        "technology_recall",
        len(found) / len(expected) if expected else None,
        f"Found {len(found)} of {len(expected)} expected technologies.",
    )


def _no_invented_technology_evaluator(run: Any, example: Any) -> dict[str, Any]:
    if not run.outputs:
        return _gemini_metric("no_invented_technologies", 0.0, "Run failed.")
    predicted = " | ".join((run.outputs or {}).get("technologies", [])).lower()
    forbidden = (example.outputs or {}).get("forbidden_technologies", [])
    invented = [item for item in forbidden if item.lower() in predicted]
    return _gemini_metric(
        "no_invented_technologies",
        0.0 if invented else 1.0,
        "Invented: " + ", ".join(invented) if invented else "None invented.",
    )


def _files_recall_evaluator(run: Any, example: Any) -> dict[str, Any]:
    predicted = " | ".join((run.outputs or {}).get("files_and_components", []))
    expected = (example.outputs or {}).get("files", [])
    if not expected:
        return _gemini_metric("files_recall", None, "No files in this case.")
    found = [item for item in expected if item in predicted]
    return _gemini_metric(
        "files_recall",
        len(found) / len(expected),
        f"Found {len(found)} of {len(expected)} expected files.",
    )


def _next_action_evaluator(run: Any, example: Any) -> dict[str, Any]:
    next_action = str((run.outputs or {}).get("next_action", "")).lower()
    keywords = (example.outputs or {}).get("next_action_keywords", [])
    matched = [word for word in keywords if word.lower() in next_action]
    return _gemini_metric(
        "next_action_correct",
        1.0 if matched else 0.0,
        "Matched: " + ", ".join(matched) if matched else "No expected keyword.",
    )


def _language_evaluator(run: Any, example: Any) -> dict[str, Any]:
    if (example.outputs or {}).get("language") != "he":
        return _gemini_metric("language_preserved", None, "Not a Hebrew case.")
    prediction = run.outputs or {}
    fields = ("project_goal", "stopping_point", "next_action")
    hebrew = [field for field in fields if _contains_hebrew(str(prediction.get(field, "")))]
    return _gemini_metric(
        "language_preserved",
        len(hebrew) / len(fields),
        f"{len(hebrew)} of {len(fields)} key fields are in Hebrew.",
    )


GEMINI_EVALUATORS = [
    _required_fields_evaluator,
    _technology_recall_evaluator,
    _no_invented_technology_evaluator,
    _files_recall_evaluator,
    _next_action_evaluator,
    _language_evaluator,
]


def _invoke_graph_with_gemini(
    conversation_text: str,
    *,
    improved: bool,
    run_name: str,
) -> dict[str, Any]:
    """Run the real graph (real Gemini analyzer) up to the approval interrupt.

    improved=False reproduces the original configuration: plain JSON mode
    without a response schema and without the quality retry loop.
    """
    from langgraph.checkpoint.memory import MemorySaver

    from backend import graph as graph_module
    from backend.app import create_initial_state
    from backend.graph import build_graph

    with ExitStack() as stack:
        if not improved:
            stack.enter_context(
                patch.object(graph_module, "ANALYSIS_RESPONSE_SCHEMA", None)
            )
            stack.enter_context(
                patch.object(
                    graph_module,
                    "route_after_quality",
                    return_value="continue",
                )
            )
        graph = build_graph(MemorySaver())
        result = graph.invoke(
            create_initial_state(conversation_text),
            config={
                "configurable": {"thread_id": str(uuid4())},
                "run_name": run_name,
                "metadata": {
                    "evaluation_mode": "synthetic_gemini",
                    "uses_gemini": True,
                    "improved_configuration": improved,
                },
            },
        )

    if not result.get("__interrupt__"):
        raise RuntimeError("Gemini LangGraph run did not reach the approval interrupt")
    return {
        **{field: result[field] for field in ANALYSIS_FIELDS},
        "quality_passed": result["quality_passed"],
        "analysis_attempts": result["analysis_attempts"],
    }


def _run_gemini_evaluation(client: Any, *, improved: bool, experiment_prefix: str):
    from langsmith import evaluate

    from backend import graph as graph_module

    def target(inputs: dict[str, Any]) -> dict[str, Any]:
        return _invoke_graph_with_gemini(
            inputs["conversation_text"],
            improved=improved,
            run_name=experiment_prefix,
        )

    return evaluate(
        target,
        data=GEMINI_DATASET_NAME,
        evaluators=GEMINI_EVALUATORS,
        client=client,
        experiment_prefix=experiment_prefix,
        description=(
            "Real Gemini analysis of synthetic conversations. "
            + (
                "Improved: structured response schema and quality retry."
                if improved
                else "Baseline: original plain JSON mode, no quality retry."
            )
        ),
        metadata={
            "evaluation_mode": "synthetic_gemini",
            "uses_gemini": True,
            "gemini_model": graph_module.GEMINI_MODEL,
            "improved_configuration": improved,
        },
        max_concurrency=1,
    )


def _metric_means(results: Any) -> tuple[dict[str, float], int]:
    totals: dict[str, list[float]] = {}
    errors = 0
    for row in results:
        run = row["run"]
        if getattr(run, "error", None):
            errors += 1
        for metric in row["evaluation_results"].get("results", []):
            if isinstance(metric.score, (int, float)):
                totals.setdefault(metric.key, []).append(float(metric.score))
    return {key: sum(values) / len(values) for key, values in totals.items()}, errors


def main_gemini(model: str | None = None) -> None:
    _validate_settings()
    from langsmith import Client

    from backend import graph as graph_module

    if model:
        graph_module.GEMINI_MODEL = model
    # Experiments must measure exactly the model recorded in their metadata,
    # so the production fallback to another model is disabled here.
    graph_module.GEMINI_FALLBACK_MODELS = []
    client = Client()
    dataset, example_count = _ensure_dataset(
        client,
        GEMINI_DATASET_NAME,
        GEMINI_CASES,
        "Synthetic conversations (English and Hebrew) for evaluating the real "
        "Gemini analysis. Contains no real user conversations.",
    )
    print(f"Synthetic Gemini dataset verified: {dataset.name} ({example_count} examples)")
    print(f"Gemini model: {graph_module.GEMINI_MODEL}")

    experiments = {}
    for improved, prefix in (
        (False, "CCA-gemini-before-structured-output"),
        (True, "CCA-gemini-after-structured-output"),
    ):
        results = _run_gemini_evaluation(
            client, improved=improved, experiment_prefix=prefix
        )
        experiments[prefix] = (results.experiment_name, *_metric_means(results))
    client.flush()

    (before_name, before, before_errors), (after_name, after, after_errors) = (
        experiments.values()
    )
    print(f"Before experiment: {before_name} (failed runs: {before_errors})")
    print(f"After experiment:  {after_name} (failed runs: {after_errors})")
    for key in sorted(set(before) | set(after)):
        b, a = before.get(key), after.get(key)
        delta = f"{a - b:+.3f}" if a is not None and b is not None else "n/a"
        b_text = f"{b:.3f}" if b is not None else "n/a"
        a_text = f"{a:.3f}" if a is not None else "n/a"
        print(f"  {key:26s} before={b_text}  after={a_text}  delta={delta}")
    print("Real conversation data sent: 0 (synthetic conversations only)")


def main() -> None:
    _validate_settings()
    from langsmith import Client

    client = Client()
    smoke_case = CASES[0]
    trace_id = uuid4()
    smoke_result = _invoke_graph(
        smoke_case["inputs"]["conversation_text"],
        smoke_case["outputs"],
        retry_enabled=True,
        run_name="synthetic-local-node-trace-check",
        run_id=trace_id,
        trace_client=client,
    )
    if smoke_result["quality_passed"] is not True:
        raise RuntimeError("Synthetic trace did not pass the existing quality retry")
    trace = _verify_trace(client, trace_id)
    print(f"Tracing project: {PROJECT_NAME}")
    print(f"Synthetic LangGraph trace verified: {trace.name}")

    dataset, example_count = _ensure_dataset(client)
    print(f"Synthetic dataset verified: {dataset.name} ({example_count} examples)")

    before = _run_evaluation(
        client,
        retry_enabled=False,
        experiment_prefix="CCA-synthetic-before-quality-retry",
    )
    after = _run_evaluation(
        client,
        retry_enabled=True,
        experiment_prefix="CCA-synthetic-after-quality-retry",
    )
    client.flush()
    before_score = _mean_score(before)
    after_score = _mean_score(after)
    print(f"Before experiment: {before.experiment_name}; exact fields={before_score:.3f}")
    print(f"After experiment: {after.experiment_name}; exact fields={after_score:.3f}")
    print(f"Measured delta: {after_score - before_score:+.3f}")
    print("Gemini API calls: 0; real conversation data: 0")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("mock", "gemini"),
        default="mock",
        help=(
            "mock: original synthetic run with a stubbed analyzer (no Gemini). "
            "gemini: real Gemini analysis of synthetic conversations."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Gemini model for --mode gemini (default: backend.gemini_client).",
    )
    arguments = parser.parse_args()
    if arguments.mode == "gemini":
        main_gemini(arguments.model)
    else:
        main()
