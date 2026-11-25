import json
import sqlite3
from contextlib import closing
from pathlib import Path

from .state import ProjectState


def save_approved_state(
    state: ProjectState,
    database_path: str | Path | None = None,
) -> int:
    if state.get("approved") is not True:
        raise PermissionError("Project state can only be saved after approval")

    saved_state = {
        key: value for key, value in state.items() if key != "conversation_text"
    }
    state_json = json.dumps(saved_state, ensure_ascii=False)
    db_path = database_path or Path(__file__).with_name("projects.db")

    with closing(sqlite3.connect(db_path)) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS project_states (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                state_json TEXT NOT NULL
            )
            """
        )
        connection.execute("DELETE FROM project_states WHERE id <> 1")
        connection.execute(
            """
            INSERT INTO project_states (id, state_json)
            VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json
            """,
            (state_json,),
        )
        connection.commit()
        return 1
