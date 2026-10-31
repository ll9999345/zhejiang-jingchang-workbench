"""Real Backlot + filesystem watcher, restricted to a new local test project."""
import json
import os
from pathlib import Path
import sys
import uvicorn
from fastapi import Request, FastAPI
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backlot import server, state

output = Path(sys.argv[1]).resolve()
projects = output/'projects'
project = projects/'demo'
(project/'artifacts').mkdir(parents=True, exist_ok=True)
file = project/'project.json'
if not file.exists():
    file.write_text(json.dumps({'project_id':'demo','title':'实时刷新测试','pipeline_type':'cinematic'}))
    (project/'checkpoint_script.json').write_text(json.dumps({'version':'1.0','project_id':'demo','pipeline_type':'cinematic','stage':'script','status':'awaiting_human','timestamp':'2026-10-18T00:00:00Z','artifacts':{}}))
server.PROJECTS_DIR = state.PROJECTS_DIR = projects
server._PROJECTS_ROOT_STR = os.path.normcase(str(projects.resolve()))
server.THUMB_CACHE_DIR = output/'thumbs'
server._summary_cache = {}
server.hub = server.ChangeHub()
server.SSE_HEARTBEAT_SECONDS = .2  # fixture only: disconnect cleanup is observable promptly
board_app = server.create_app()
app = board_app
if '--adapter' in sys.argv:
    from backlot import model_adapter
    from web_api.app import create_app as create_task_app
    class ForbiddenTaskTool:
        name = 'unused_local_test_surface'
        def get_status(self): return 'available'
        def dry_run(self, _): raise AssertionError('task tools are outside this browser test')
        def execute(self, _): raise AssertionError('no model task may run in this browser test')
    model_adapter._load_macos_keychain_secret = lambda **kwargs: False
    tasks = create_task_app(ForbiddenTaskTool(), output/'tasks.sqlite3')
    app = model_adapter.create_app(board_application=app, task_application=tasks, project_root=projects)

@board_app.post('/__qa/change')
async def change(request: Request):
    body = await request.json()
    title = str(body['title'])[:100]
    data = json.loads(file.read_text())
    data['title'] = title
    pending = project/'pending-test-project.json'
    pending.write_text(json.dumps(data, ensure_ascii=False))
    os.replace(pending, file)
    if body.get('notify', True):
        for _ in range(min(120, max(1, int(body.get('burst', 1))))):
            server.notify_project_changed('demo')
    return {'title':title,'revision':server.hub._revisions.get('demo', 0)}

uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[2]), log_level='warning', timeout_graceful_shutdown=2)
