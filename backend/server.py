from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import re
import threading
from uuid import UUID, uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from langsmith import tracing_context
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from .app import create_initial_state
from .graph import GeminiAnalysisError, build_graph

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

logger = logging.getLogger("uvicorn.error")
# Chrome omits the Origin header on some extension GET requests. The popup
# therefore also sends its extension ID in this custom header. A web page
# cannot add a custom header cross-origin without a CORS preflight, and the
# preflight is rejected because its Origin is not the extension.
EXTENSION_ID_HEADER = "x-chat-continuity-extension"

DATABASE_PATH = Path(__file__).with_name("projects.db")
# ID of the unpacked extension installed for this project, as shown in
# chrome://extensions. It is public, not a secret. Chrome derives it from the
# folder the extension was loaded from, so another installation can override
# it with the CHAT_CONTINUITY_EXTENSION_ID environment variable (or .env).
DEFAULT_EXTENSION_ID = "hbkpkoiedabdkllahbnpfhkfbncijnei"


def resolve_extension_origin(
    configured_id: str | None,
) -> tuple[str | None, str]:
    """Return (allowed origin or None, description of where the ID came from)."""
    if configured_id is None or not configured_id.strip():
        extension_id, source = DEFAULT_EXTENSION_ID, "built-in default"
    else:
        extension_id = configured_id.strip().strip("\"'")
        source = "CHAT_CONTINUITY_EXTENSION_ID"
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        # An explicitly configured but invalid ID is refused, never replaced.
        return None, source
    return f"chrome-extension://{extension_id}", source


EXTENSION_ORIGIN, EXTENSION_ID_SOURCE = resolve_extension_origin(
    os.getenv("CHAT_CONTINUITY_EXTENSION_ID")
)
EXTENSION_ID = (
    EXTENSION_ORIGIN.removeprefix("chrome-extension://") if EXTENSION_ORIGIN else ""
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if EXTENSION_ORIGIN is None:
        logger.warning(
            "CHAT_CONTINUITY_EXTENSION_ID is invalid (expected 32 letters a-p); "
            "all requests will be refused with 503."
        )
    else:
        logger.info(
            "Allowed extension origin: %s (from %s)",
            EXTENSION_ORIGIN,
            EXTENSION_ID_SOURCE,
        )
    with SqliteSaver.from_conn_string(str(DATABASE_PATH)) as checkpointer:
        app.state.checkpointer = checkpointer
        app.state.graph = build_graph(checkpointer)
        app.state.running_threads = set()
        app.state.running_lock = threading.Lock()
        yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[EXTENSION_ORIGIN] if EXTENSION_ORIGIN else [],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", EXTENSION_ID_HEADER],
)


def is_authorized_extension_request(request: Request) -> bool:
    origin = request.headers.get("origin")
    if origin is not None:
        return origin == EXTENSION_ORIGIN
    return (
        EXTENSION_ORIGIN is not None
        and request.headers.get(EXTENSION_ID_HEADER)
        == EXTENSION_ORIGIN.removeprefix("chrome-extension://")
    )


@app.middleware("http")
async def require_authorized_extension(request: Request, call_next):
    if EXTENSION_ORIGIN is None:
        return JSONResponse(
            status_code=503,
            content={
                "detail": (
                    "Configure CHAT_CONTINUITY_EXTENSION_ID with the installed "
                    "Chrome extension ID"
                )
            },
        )
    if not is_authorized_extension_request(request):
        received = request.headers.get("origin") or "(no Origin header)"
        logger.warning(
            "Refused %s %s from origin %s; expected %s",
            request.method,
            request.url.path,
            received,
            EXTENSION_ORIGIN,
        )
        return JSONResponse(
            status_code=403,
            content={
                "detail": (
                    "Request origin is not allowed. "
                    f"התקבל: {received}; השרת מצפה ל: {EXTENSION_ORIGIN}. "
                    "ודאי שמזהה התוסף ב-chrome://extensions זהה למזהה "
                    "שהוגדר לשרת."
                )
            },
        )
    return await call_next(request)


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception):
    logger.exception("Unexpected server error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "אירעה שגיאה לא צפויה בשרת. פרטים ביומן השרת."},
    )


class ConversationRequest(BaseModel):
    conversation_text: str = Field(min_length=1, max_length=500_000)
    # Generated by the popup and stored before sending, so the review can be
    # restored if the popup closes while Gemini is still analyzing.
    thread_id: UUID | None = None


class ApprovalRequest(BaseModel):
    approved: bool


@app.post("/conversations", status_code=202)
def start_conversation(
    payload: ConversationRequest,
    request: Request,
) -> dict[str, str]:
    try:
        initial_state = create_initial_state(payload.conversation_text)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    thread_id = str(payload.thread_id or uuid4())
    config = {"configurable": {"thread_id": thread_id}}
    state = request.app.state
    with state.running_lock:
        if (
            thread_id in state.running_threads
            or state.graph.get_state(config).values
        ):
            raise HTTPException(
                status_code=409,
                detail="Conversation thread already exists",
            )
        state.running_threads.add(thread_id)

    result: dict | None = None
    try:
        # Real conversation payloads are not sent to LangSmith by default.
        with tracing_context(enabled=False):
            result = state.graph.invoke(initial_state, config=config)
    except GeminiAnalysisError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.user_message,
        ) from exc
    except ValueError as exc:
        logger.warning("Analysis output rejected: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="Gemini החזיר תשובה במבנה לא צפוי. נסי לשלוח שוב.",
        ) from exc
    finally:
        if result is None:
            state.checkpointer.delete_thread(thread_id)
        with state.running_lock:
            state.running_threads.discard(thread_id)
    if result is None:
        raise RuntimeError("Graph returned no state")

    interrupts = result.get("__interrupt__", ())
    if not interrupts:
        request.app.state.checkpointer.delete_thread(thread_id)
        raise HTTPException(
            status_code=500,
            detail="Graph completed without requesting human approval",
        )

    return {
        "thread_id": thread_id,
        "status": "awaiting_approval",
        **interrupts[0].value,
    }


@app.post("/conversations/{thread_id}/approval")
def resume_conversation(
    thread_id: UUID,
    payload: ApprovalRequest,
    request: Request,
) -> dict[str, str]:
    thread_id_value = str(thread_id)
    config = {"configurable": {"thread_id": thread_id_value}}
    snapshot = request.app.state.graph.get_state(config)
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Conversation thread not found")
    if "request_human_approval" not in snapshot.next:
        raise HTTPException(
            status_code=409,
            detail="Conversation thread is not waiting for approval",
        )

    with tracing_context(enabled=False):
        result = request.app.state.graph.invoke(
            Command(resume={"approved": payload.approved}),
            config=config,
        )
    if result.get("__interrupt__"):
        raise HTTPException(
            status_code=409,
            detail="Graph requested another approval before completing",
        )

    request.app.state.checkpointer.delete_thread(thread_id_value)
    return {
        "thread_id": thread_id_value,
        "status": "saved" if payload.approved else "rejected",
    }


@app.get("/conversations/{thread_id}")
def get_pending_conversation(thread_id: UUID, request: Request) -> dict[str, str]:
    config = {"configurable": {"thread_id": str(thread_id)}}
    with request.app.state.running_lock:
        is_running = str(thread_id) in request.app.state.running_threads
    if is_running:
        return {"thread_id": str(thread_id), "status": "processing"}
    snapshot = request.app.state.graph.get_state(config)
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Conversation thread not found")
    if "request_human_approval" not in snapshot.next:
        raise HTTPException(
            status_code=409,
            detail="Conversation thread is not waiting for approval",
        )

    return {
        "thread_id": str(thread_id),
        "status": "awaiting_approval",
        "summary": snapshot.values["summary"],
        "continuation_prompt": snapshot.values["continuation_prompt"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
