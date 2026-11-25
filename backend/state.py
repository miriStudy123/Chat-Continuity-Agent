from typing import Dict, List, NotRequired, TypedDict


class ProjectState(TypedDict):
    conversation_text: str
    project_goal: str
    important_context: List[str]
    decisions: List[Dict[str, str]]
    technologies: List[str]
    files_and_components: List[str]
    completed_tasks: List[str]
    open_tasks: List[str]
    stopping_point: str
    next_action: str
    quality_passed: NotRequired[bool]
    analysis_attempts: NotRequired[int]
    quality_feedback: NotRequired[str]
    summary: NotRequired[str]
    continuation_prompt: NotRequired[str]
    approved: NotRequired[bool]
