"""Agent-facing entrypoint for the workbench's real-footage pipeline."""
from pathlib import Path

from tools.base_tool import BaseTool, Determinism, ExecutionMode, ToolResult, ToolRuntime, ToolStability, ToolTier


class _Inline:
    def submit(self, fn, *args):
        fn(*args)


class FootageAutoEdit(BaseTool):
    name = 'footage_auto_edit'
    version = '1.0.0'
    tier = ToolTier.CORE
    capability = 'video_post'
    provider = 'openmontage'
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.HYBRID
    dependencies = ['cmd:ffmpeg', 'cmd:ffprobe']
    install_instructions = 'Use the project runtime; FFmpeg and ffprobe are required.'
    capabilities = ['automatic_stock_montage', 'project_storyboard_edit', 'batch_export']
    input_schema = {'type': 'object', 'required': ['project_id'], 'properties': {
        'project_id': {'type': 'string'}, 'script': {'type': 'string'},
        'shots': {'type': 'array'}, 'options': {'type': 'object'},
        'action': {'enum': ['collect', 'create', 'render']},
        'stop_at': {'enum': ['materials', 'audio', 'subtitle', 'video'], 'default': 'video'},
        'execute': {'type': 'boolean', 'default': False},
        'confirm_network': {'type': 'boolean', 'default': False},
    }}

    def execute(self, inputs):
        from web_api.footage_pipeline import FootageJobs, FootageRequest, plan_footage
        data = dict(inputs)
        execute = data.pop('execute', False)
        root = Path(__file__).resolve().parents[2] / 'projects'
        try:
            request = FootageRequest.model_validate(data)
            if not execute:
                return ToolResult(success=True, data=plan_footage(root, request))
            manager = FootageJobs(root, executor=_Inline())
            job = manager.submit(request)
            job = manager.get(request.project_id, job['job_id'])
            ok = job['status'] in ('completed', 'stage_completed', 'awaiting_review')
            return ToolResult(success=ok, data=job, error=None if ok else job['message'])
        except ValueError as exc:
            return ToolResult(success=False, error=str(exc))
