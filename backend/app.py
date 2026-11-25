from .state import ProjectState


def validate_conversation_text(conversation_text: str) -> str:
    if not isinstance(conversation_text, str):
        raise TypeError("conversation_text must be a string")

    cleaned_text = conversation_text.strip()
    if not cleaned_text:
        raise ValueError("conversation_text must not be empty")

    return cleaned_text


def create_initial_state(conversation_text: str) -> ProjectState:
    cleaned_text = validate_conversation_text(conversation_text)
    return {
        "conversation_text": cleaned_text,
        "project_goal": "",
        "important_context": [],
        "decisions": [],
        "technologies": [],
        "files_and_components": [],
        "completed_tasks": [],
        "open_tasks": [],
        "stopping_point": "",
        "next_action": "",
    }
